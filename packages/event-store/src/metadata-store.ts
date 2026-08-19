import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  lstatSync,
  mkdirSync,
  openSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  BuildResultObservationV1Schema,
  DurableWorkingStateV1Schema,
  EventIdSchema,
  FileReadObservationV1Schema,
  PersistedAnyContextEventV1Schema,
  PersistedContextEventV1Schema,
  Phase2ReducedValueV1Schema,
  ReducedBuildResultV1Schema,
  ReducedFileReadV1Schema,
  ReducedSearchResultV1Schema,
  ReducedTestResultV1Schema,
  ReductionDiagnosticSchema,
  Sha256DigestSchema,
  SessionIdSchema,
  SearchResultObservationV1Schema,
  TestResultObservationV1Schema,
  canonicalJson,
  WorkingStateTransitionV1Schema,
} from '@acm/core';
import {
  applyWorkingStateTransition,
  createEmptyWorkingState,
  replayWorkingState,
} from '@acm/working-state';
import { z } from 'zod';

import type {
  CreateSessionInput,
  MetadataStore,
  RecordedAnyEvent,
  PersistedReduction,
  RecordedEvent,
  RecordReductionInput,
  RecordObservationReductionInput,
  RecordStateUpdateInput,
  RecordedStateUpdate,
  SessionRecord,
} from './contracts.js';
import { SessionNotFoundError } from './errors.js';

const MIGRATION_1 = `
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
) STRICT;
CREATE TABLE artifacts (
  uri TEXT PRIMARY KEY,
  algorithm TEXT NOT NULL CHECK (algorithm = 'sha256'),
  digest TEXT NOT NULL UNIQUE,
  byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
  created_at TEXT NOT NULL
) STRICT;
CREATE TABLE events (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  schema_version INTEGER NOT NULL,
  kind TEXT NOT NULL,
  created_at TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  raw_artifact_uri TEXT NOT NULL REFERENCES artifacts(uri),
  byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
  payload_json TEXT NOT NULL,
  UNIQUE (session_id, sequence)
) STRICT;
CREATE TABLE reductions (
  event_id TEXT PRIMARY KEY REFERENCES events(id),
  reducer_id TEXT NOT NULL,
  reducer_version TEXT NOT NULL,
  reduced_text TEXT NOT NULL,
  safe_for_context INTEGER NOT NULL CHECK (safe_for_context IN (0, 1)),
  original_token_estimate INTEGER NOT NULL CHECK (original_token_estimate >= 0),
  reduced_token_estimate INTEGER NOT NULL CHECK (reduced_token_estimate >= 0),
  token_estimator_id TEXT NOT NULL,
  preserved_fields_json TEXT NOT NULL,
  diagnostics_json TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;
`;

const MIGRATION_2 = `
CREATE TABLE working_state_snapshots (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id),
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  revision INTEGER NOT NULL CHECK (revision >= 0),
  through_sequence INTEGER NOT NULL CHECK (through_sequence >= 0),
  state_json TEXT NOT NULL,
  state_hash TEXT NOT NULL CHECK (length(state_hash) = 64),
  updated_at TEXT NOT NULL
) STRICT;
CREATE TABLE state_provenance (
  update_event_id TEXT NOT NULL REFERENCES events(id),
  operation_index INTEGER NOT NULL CHECK (operation_index >= 0),
  reference_index INTEGER NOT NULL CHECK (reference_index >= 0),
  source_event_id TEXT NOT NULL REFERENCES events(id),
  PRIMARY KEY (update_event_id, operation_index, reference_index)
) STRICT;
CREATE INDEX state_provenance_source_event_idx
  ON state_provenance(source_event_id);
`;

const DEFAULT_BUSY_TIMEOUT_MS = 5_000;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const OPEN_DATABASE_FLAGS =
  constants.O_CREAT | constants.O_RDWR | (constants.O_NOFOLLOW ?? 0);

export type SqliteMetadataStoreOptions = {
  busyTimeoutMs?: number;
  now?: () => Date;
};

const ReductionMetadataSchema = z.object({
  reducerId: z.string().min(1),
  reducerVersion: z.string().min(1),
  reducedText: z.string(),
  safeForContext: z.boolean(),
  originalTokenEstimate: z.number().int().nonnegative(),
  reducedTokenEstimate: z.number().int().nonnegative(),
  tokenEstimatorId: z.string().min(1),
  preservedFields: z.array(z.string().startsWith('/')),
  diagnostics: z.array(ReductionDiagnosticSchema),
});

type EventRow = {
  id: string;
  session_id: string;
  sequence: number;
  schema_version: number;
  kind: string;
  created_at: string;
  content_hash: string;
  raw_artifact_uri: string;
  byte_length: number;
  payload_json: string;
  reducer_id: string;
  reducer_version: string;
  reduced_text: string;
  safe_for_context: number;
  original_token_estimate: number;
  reduced_token_estimate: number;
  token_estimator_id: string;
  preserved_fields_json: string;
  diagnostics_json: string;
  reduction_created_at: string;
};

type SessionEventRow = Omit<
  EventRow,
  | 'reducer_id'
  | 'reducer_version'
  | 'reduced_text'
  | 'safe_for_context'
  | 'original_token_estimate'
  | 'reduced_token_estimate'
  | 'token_estimator_id'
  | 'preserved_fields_json'
  | 'diagnostics_json'
  | 'reduction_created_at'
> & {
  reducer_id: string | null;
  reducer_version: string | null;
  reduced_text: string | null;
  safe_for_context: number | null;
  original_token_estimate: number | null;
  reduced_token_estimate: number | null;
  token_estimator_id: string | null;
  preserved_fields_json: string | null;
  diagnostics_json: string | null;
  reduction_created_at: string | null;
};

function parseStoredJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error('Metadata database contains invalid JSON.', {
      cause: error,
    });
  }
}

function validateReductionMetadata(input: unknown): {
  metadata: z.infer<typeof ReductionMetadataSchema>;
  reducedValue: z.infer<typeof ReducedTestResultV1Schema>;
} {
  const reduction = ReductionMetadataSchema.parse(input);
  const reducedValue = ReducedTestResultV1Schema.parse(
    parseStoredJson(reduction.reducedText),
  );
  if (canonicalJson(reducedValue) !== reduction.reducedText) {
    throw new Error(
      'Reduced text must use acm-canonical-json@1 serialization.',
    );
  }
  return { metadata: reduction, reducedValue };
}

function preparePrivateDatabasePath(databasePath: string): void {
  const directory = dirname(databasePath);
  mkdirSync(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  const directoryStatus = lstatSync(directory);
  if (directoryStatus.isSymbolicLink() || !directoryStatus.isDirectory()) {
    throw new Error(`Metadata directory is not a real directory: ${directory}`);
  }
  const currentUserId = process.getuid?.();
  if (currentUserId !== undefined && directoryStatus.uid !== currentUserId) {
    throw new Error(
      `Metadata directory is not owned by the current user: ${directory}`,
    );
  }
  chmodSync(directory, PRIVATE_DIRECTORY_MODE);

  const descriptor = openSync(
    databasePath,
    OPEN_DATABASE_FLAGS,
    PRIVATE_FILE_MODE,
  );
  closeSync(descriptor);
  const databaseStatus = lstatSync(databasePath);
  if (databaseStatus.isSymbolicLink() || !databaseStatus.isFile()) {
    throw new Error(`Metadata database is not a regular file: ${databasePath}`);
  }
  chmodSync(databasePath, PRIVATE_FILE_MODE);
}

function assertReductionConsistency(
  payload: z.infer<typeof TestResultObservationV1Schema>,
  artifact: { uri: string; digest: string; byteLength: number },
  reduction: z.infer<typeof ReductionMetadataSchema>,
  reducedValue: z.infer<typeof ReducedTestResultV1Schema>,
): void {
  const expectedSafeForContext = payload.parseStatus === 'complete';
  const expectedReducedValue = ReducedTestResultV1Schema.parse({
    schemaVersion: 1,
    kind: 'test-result',
    framework: 'vitest',
    ...(payload.command ? { command: payload.command } : {}),
    ...(payload.exitCode !== undefined ? { exitCode: payload.exitCode } : {}),
    ...(payload.success !== undefined ? { success: payload.success } : {}),
    ...(payload.reportedCounts
      ? { reportedCounts: payload.reportedCounts }
      : {}),
    ...(payload.observedCounts
      ? { observedCounts: payload.observedCounts }
      : {}),
    failures: payload.failures,
    diagnostics: payload.diagnostics,
    evidence: {
      rawArtifactUri: artifact.uri,
      contentHash: artifact.digest,
      byteLength: artifact.byteLength,
    },
    safeForContext: expectedSafeForContext,
  });

  if (canonicalJson(reducedValue) !== canonicalJson(expectedReducedValue)) {
    throw new Error(
      'Reduced text does not match its source payload and artifact evidence.',
    );
  }
  if (reduction.safeForContext !== expectedSafeForContext) {
    throw new Error(
      'Reduction safety metadata does not match the parsed observation.',
    );
  }
  if (
    canonicalJson(reduction.diagnostics) !== canonicalJson(payload.diagnostics)
  ) {
    throw new Error(
      'Reduction diagnostics do not match the parsed observation.',
    );
  }
}

function stateHash(stateJson: string): string {
  return createHash('sha256').update(stateJson, 'utf8').digest('hex');
}

function validateArtifactMetadata(artifact: {
  uri: string;
  digest: string;
  byteLength: number;
  algorithm: string;
}): void {
  if (
    artifact.algorithm !== 'sha256' ||
    artifact.uri !== `artifact://sha256/${artifact.digest}`
  ) {
    throw new Error('Artifact URI, algorithm, and digest do not match.');
  }
}

function parsePhase2Payload(
  kind: RecordObservationReductionInput['kind'],
  payload: unknown,
) {
  switch (kind) {
    case 'file_read':
      return FileReadObservationV1Schema.parse(payload);
    case 'search_result':
      return SearchResultObservationV1Schema.parse(payload);
    case 'build_result':
      return BuildResultObservationV1Schema.parse(payload);
  }
}

function validatePhase2Reduction(
  kind: RecordObservationReductionInput['kind'],
  payload: ReturnType<typeof parsePhase2Payload>,
  artifact: RecordObservationReductionInput['artifact'],
  input: unknown,
) {
  const reduction = ReductionMetadataSchema.parse(input);
  const reducedValue = Phase2ReducedValueV1Schema.parse(
    parseStoredJson(reduction.reducedText),
  );
  if (canonicalJson(reducedValue) !== reduction.reducedText) {
    throw new Error(
      'Reduced text must use acm-canonical-json@1 serialization.',
    );
  }
  const expectedKind = {
    file_read: 'file-read',
    search_result: 'search-result',
    build_result: 'build-result',
  }[kind];
  if (reducedValue.kind !== expectedKind) {
    throw new Error(`Reduced value kind does not match ${kind}.`);
  }
  if (
    reducedValue.evidence.rawArtifactUri !== artifact.uri ||
    reducedValue.evidence.contentHash !== artifact.digest ||
    reducedValue.evidence.byteLength !== artifact.byteLength
  ) {
    throw new Error('Reduced value does not match its artifact evidence.');
  }
  const expectedSafe =
    kind === 'file_read'
      ? reducedValue.kind === 'file-read' &&
        reducedValue.contentStatus === 'duplicate-reference'
      : 'parseStatus' in payload && payload.parseStatus === 'complete';
  if (
    reduction.safeForContext !== expectedSafe ||
    reducedValue.safeForContext !== expectedSafe
  ) {
    throw new Error(
      'Reduction safety metadata contradicts its source payload.',
    );
  }
  let expectedValue: z.infer<typeof Phase2ReducedValueV1Schema>;
  if (kind === 'file_read') {
    const source = FileReadObservationV1Schema.parse(payload);
    const reduced = ReducedFileReadV1Schema.parse(reducedValue);
    expectedValue = ReducedFileReadV1Schema.parse({
      kind: 'file-read',
      ...source,
      ...(reduced.duplicateOfEventId
        ? { duplicateOfEventId: reduced.duplicateOfEventId }
        : {}),
      contentStatus: reduced.duplicateOfEventId
        ? 'duplicate-reference'
        : 'artifact-required',
      evidence: reduced.evidence,
      safeForContext: expectedSafe,
    });
  } else if (kind === 'search_result') {
    const source = SearchResultObservationV1Schema.parse(payload);
    expectedValue = ReducedSearchResultV1Schema.parse({
      schemaVersion: 1,
      kind: 'search-result',
      tool: 'ripgrep',
      query: source.query,
      root: source.root,
      ...(source.command ? { command: source.command } : {}),
      ...(source.exitCode !== undefined ? { exitCode: source.exitCode } : {}),
      matches: source.matches,
      matchCount: source.matches.length,
      diagnostics: source.diagnostics,
      evidence: reducedValue.evidence,
      safeForContext: expectedSafe,
    });
  } else {
    const source = BuildResultObservationV1Schema.parse(payload);
    expectedValue = ReducedBuildResultV1Schema.parse({
      schemaVersion: 1,
      kind: 'build-result',
      tool: 'typescript',
      command: source.command,
      workingDirectory: source.workingDirectory,
      ...(source.toolVersion ? { toolVersion: source.toolVersion } : {}),
      exitCode: source.exitCode,
      buildDiagnostics: source.buildDiagnostics,
      diagnostics: source.diagnostics,
      evidence: reducedValue.evidence,
      safeForContext: expectedSafe,
    });
  }
  if (canonicalJson(expectedValue) !== reduction.reducedText) {
    throw new Error('Reduced value does not match its source payload.');
  }
  const expectedDiagnostics =
    kind === 'file_read'
      ? []
      : 'diagnostics' in payload
        ? payload.diagnostics
        : [];
  if (
    canonicalJson(expectedDiagnostics) !== canonicalJson(reduction.diagnostics)
  ) {
    throw new Error('Reduction diagnostics do not match its source payload.');
  }
  return { reduction, reducedValue };
}

export class SqliteMetadataStore implements MetadataStore {
  private readonly database: DatabaseSync;
  private readonly now: () => Date;

  constructor(databasePath: string, options: SqliteMetadataStoreOptions = {}) {
    const resolvedPath = resolve(databasePath);
    const busyTimeoutMs = options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS;
    if (!Number.isSafeInteger(busyTimeoutMs) || busyTimeoutMs < 0) {
      throw new RangeError(
        'SQLite busy timeout must be a nonnegative safe integer.',
      );
    }
    this.now = options.now ?? (() => new Date());
    preparePrivateDatabasePath(resolvedPath);
    this.database = new DatabaseSync(resolvedPath);
    try {
      this.database.exec('PRAGMA foreign_keys = ON');
      this.database.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
      this.migrate();
    } catch (error) {
      this.database.close();
      throw error;
    }
  }

  createSession(input: CreateSessionInput): SessionRecord {
    const record = {
      id: SessionIdSchema.parse(input.id),
      createdAt: z.iso.datetime({ offset: true }).parse(input.createdAt),
    };
    this.database
      .prepare('INSERT INTO sessions (id, created_at) VALUES (?, ?)')
      .run(record.id, record.createdAt);
    return record;
  }

  sessionExists(sessionId: SessionRecord['id']): boolean {
    const id = SessionIdSchema.parse(sessionId);
    return (
      this.database.prepare('SELECT 1 FROM sessions WHERE id = ?').get(id) !==
      undefined
    );
  }

  recordReduction(input: RecordReductionInput): RecordedEvent {
    const eventId = EventIdSchema.parse(input.eventId);
    const sessionId = SessionIdSchema.parse(input.sessionId);
    const eventCreatedAt = z.iso
      .datetime({ offset: true })
      .parse(input.eventCreatedAt);
    const reductionCreatedAt = z.iso
      .datetime({ offset: true })
      .parse(input.reductionCreatedAt);
    const payload = TestResultObservationV1Schema.parse(input.payload);
    const validatedReduction = validateReductionMetadata(input.reduction);
    const reduction = validatedReduction.metadata;
    const artifact = input.artifact;
    if (artifact.uri !== `artifact://sha256/${artifact.digest}`) {
      throw new Error('Artifact URI and digest do not match.');
    }
    assertReductionConsistency(
      payload,
      artifact,
      reduction,
      validatedReduction.reducedValue,
    );

    this.database.exec('BEGIN IMMEDIATE');
    try {
      if (!this.sessionExists(sessionId))
        throw new SessionNotFoundError(sessionId);

      const existing = this.database
        .prepare(
          'SELECT algorithm, digest, byte_length FROM artifacts WHERE uri = ?',
        )
        .get(artifact.uri) as
        { algorithm: string; digest: string; byte_length: number } | undefined;
      if (existing) {
        if (
          existing.algorithm !== artifact.algorithm ||
          existing.digest !== artifact.digest ||
          existing.byte_length !== artifact.byteLength
        ) {
          throw new Error(`Artifact metadata conflict for ${artifact.uri}`);
        }
      } else {
        this.database
          .prepare(
            'INSERT INTO artifacts (uri, algorithm, digest, byte_length, created_at) VALUES (?, ?, ?, ?, ?)',
          )
          .run(
            artifact.uri,
            artifact.algorithm,
            artifact.digest,
            artifact.byteLength,
            eventCreatedAt,
          );
      }

      const sequenceRow = this.database
        .prepare(
          'SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM events WHERE session_id = ?',
        )
        .get(sessionId) as { sequence: number };
      const sequence = sequenceRow.sequence;
      const event = PersistedContextEventV1Schema.parse({
        schemaVersion: 1,
        id: eventId,
        sessionId,
        sequence,
        kind: 'test_result',
        createdAt: eventCreatedAt,
        payload,
        rawArtifactUri: artifact.uri,
        contentHash: artifact.digest,
        byteLength: artifact.byteLength,
      });

      this.database
        .prepare(
          `INSERT INTO events
           (id, session_id, sequence, schema_version, kind, created_at, content_hash,
            raw_artifact_uri, byte_length, payload_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          event.id,
          event.sessionId,
          event.sequence,
          event.schemaVersion,
          event.kind,
          event.createdAt,
          event.contentHash,
          event.rawArtifactUri,
          event.byteLength,
          canonicalJson(event.payload),
        );
      this.database
        .prepare(
          `INSERT INTO reductions
           (event_id, reducer_id, reducer_version, reduced_text, safe_for_context,
            original_token_estimate, reduced_token_estimate, token_estimator_id,
            preserved_fields_json, diagnostics_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          event.id,
          reduction.reducerId,
          reduction.reducerVersion,
          reduction.reducedText,
          reduction.safeForContext ? 1 : 0,
          reduction.originalTokenEstimate,
          reduction.reducedTokenEstimate,
          reduction.tokenEstimatorId,
          canonicalJson(reduction.preservedFields),
          canonicalJson(reduction.diagnostics),
          reductionCreatedAt,
        );
      this.database.exec('COMMIT');

      return {
        event,
        reduction: {
          ...reduction,
          sourceEventId: event.id,
          rawArtifactUri: event.rawArtifactUri,
          createdAt: reductionCreatedAt,
        },
      };
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  recordObservationReduction(
    input: RecordObservationReductionInput,
  ): RecordedAnyEvent {
    const eventId = EventIdSchema.parse(input.eventId);
    const sessionId = SessionIdSchema.parse(input.sessionId);
    const eventCreatedAt = z.iso
      .datetime({ offset: true })
      .parse(input.eventCreatedAt);
    const reductionCreatedAt = z.iso
      .datetime({ offset: true })
      .parse(input.reductionCreatedAt);
    const payload = parsePhase2Payload(input.kind, input.payload);
    validateArtifactMetadata(input.artifact);
    const validated = validatePhase2Reduction(
      input.kind,
      payload,
      input.artifact,
      input.reduction,
    );
    const reduction = validated.reduction;

    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.requireSession(sessionId);
      this.upsertArtifact(input.artifact, eventCreatedAt);
      const sequence = this.nextSequence(sessionId);
      const event = PersistedAnyContextEventV1Schema.parse({
        schemaVersion: 1,
        id: eventId,
        sessionId,
        sequence,
        kind: input.kind,
        createdAt: eventCreatedAt,
        payload,
        rawArtifactUri: input.artifact.uri,
        contentHash: input.artifact.digest,
        byteLength: input.artifact.byteLength,
      });
      this.assertFileDuplicateReference(event, validated.reducedValue);
      this.insertEvent(event);
      this.insertReduction(event.id, reduction, reductionCreatedAt);
      this.database.exec('COMMIT');
      return {
        event,
        reduction: {
          ...reduction,
          sourceEventId: event.id,
          rawArtifactUri: event.rawArtifactUri,
          createdAt: reductionCreatedAt,
        },
      };
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  recordStateUpdate(input: RecordStateUpdateInput): RecordedStateUpdate {
    const eventId = EventIdSchema.parse(input.eventId);
    const sessionId = SessionIdSchema.parse(input.sessionId);
    const eventCreatedAt = z.iso
      .datetime({ offset: true })
      .parse(input.eventCreatedAt);
    const transition = WorkingStateTransitionV1Schema.parse(input.transition);
    validateArtifactMetadata(input.artifact);

    this.database.exec('BEGIN IMMEDIATE');
    try {
      const session = this.requireSession(sessionId);
      this.upsertArtifact(input.artifact, eventCreatedAt);
      const sequence = this.nextSequence(sessionId);
      const current = this.readWorkingState(session);
      const event = PersistedAnyContextEventV1Schema.parse({
        schemaVersion: 1,
        id: eventId,
        sessionId,
        sequence,
        kind: 'state_update',
        createdAt: eventCreatedAt,
        payload: transition,
        rawArtifactUri: input.artifact.uri,
        contentHash: input.artifact.digest,
        byteLength: input.artifact.byteLength,
      });

      for (const operation of transition.operations) {
        for (const reference of operation.provenance) {
          if (reference.sourceEventId === event.id) {
            if (
              reference.artifactUri !== undefined &&
              reference.artifactUri !== event.rawArtifactUri
            ) {
              throw new Error(
                `Provenance artifact does not match its source event: ${reference.sourceEventId}`,
              );
            }
            continue;
          }
          const row = this.database
            .prepare(
              'SELECT session_id, raw_artifact_uri FROM events WHERE id = ?',
            )
            .get(reference.sourceEventId) as
            { session_id: string; raw_artifact_uri: string } | undefined;
          if (!row) {
            throw new Error(
              `Provenance event does not exist: ${reference.sourceEventId}`,
            );
          }
          if (row.session_id !== sessionId) {
            throw new Error(
              `Provenance event belongs to another session: ${reference.sourceEventId}`,
            );
          }
          if (
            reference.artifactUri !== undefined &&
            reference.artifactUri !== row.raw_artifact_uri
          ) {
            throw new Error(
              `Provenance artifact does not match its source event: ${reference.sourceEventId}`,
            );
          }
        }
      }

      const next = applyWorkingStateTransition(current, transition, {
        sequence,
        createdAt: eventCreatedAt,
      });
      this.insertEvent(event);
      const provenanceStatement = this.database.prepare(
        `INSERT INTO state_provenance
         (update_event_id, operation_index, reference_index, source_event_id)
         VALUES (?, ?, ?, ?)`,
      );
      transition.operations.forEach((operation, operationIndex) => {
        operation.provenance.forEach((reference, referenceIndex) => {
          provenanceStatement.run(
            event.id,
            operationIndex,
            referenceIndex,
            reference.sourceEventId,
          );
        });
      });
      const stateJson = canonicalJson(next);
      this.database
        .prepare(
          `INSERT INTO working_state_snapshots
           (session_id, schema_version, revision, through_sequence, state_json,
            state_hash, updated_at)
           VALUES (?, 1, ?, ?, ?, ?, ?)
           ON CONFLICT(session_id) DO UPDATE SET
             schema_version = excluded.schema_version,
             revision = excluded.revision,
             through_sequence = excluded.through_sequence,
             state_json = excluded.state_json,
             state_hash = excluded.state_hash,
             updated_at = excluded.updated_at`,
        )
        .run(
          sessionId,
          next.revision,
          next.throughSequence,
          stateJson,
          stateHash(stateJson),
          next.updatedAt,
        );
      this.database.exec('COMMIT');
      return { event, state: next };
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  getWorkingState(sessionIdInput: SessionRecord['id']) {
    const session = this.requireSession(SessionIdSchema.parse(sessionIdInput));
    return this.readWorkingState(session);
  }

  verifyWorkingState(sessionIdInput: SessionRecord['id']) {
    const session = this.requireSession(SessionIdSchema.parse(sessionIdInput));
    const rows = this.database
      .prepare(
        `SELECT sequence, created_at, payload_json
         FROM events
         WHERE session_id = ? AND kind = 'state_update'
         ORDER BY sequence`,
      )
      .all(session.id) as {
      sequence: number;
      created_at: string;
      payload_json: string;
    }[];
    const transitions = rows.map((row) => {
      const transition = WorkingStateTransitionV1Schema.parse(
        parseStoredJson(row.payload_json),
      );
      if (canonicalJson(transition) !== row.payload_json) {
        throw new Error('Stored state transition is not canonical JSON.');
      }
      return {
        sequence: row.sequence,
        createdAt: row.created_at,
        transition,
      };
    });
    const eventRows = this.database
      .prepare(
        `SELECT id, sequence FROM events
         WHERE session_id = ? AND kind = 'state_update'`,
      )
      .all(session.id) as { id: string; sequence: number }[];
    const eventIdBySequence = new Map(
      eventRows.map((row) => [row.sequence, row.id]),
    );
    for (const entry of transitions) {
      const updateEventId = eventIdBySequence.get(entry.sequence);
      if (!updateEventId)
        throw new Error('State-update event lookup is inconsistent.');
      const storedReferences = this.database
        .prepare(
          `SELECT sp.operation_index, sp.reference_index, sp.source_event_id,
                  source.session_id AS source_session_id,
                  source.raw_artifact_uri AS source_artifact_uri
           FROM state_provenance sp
           JOIN events source ON source.id = sp.source_event_id
           WHERE sp.update_event_id = ?
           ORDER BY operation_index, reference_index`,
        )
        .all(updateEventId) as {
        operation_index: number;
        reference_index: number;
        source_event_id: string;
        source_session_id: string;
        source_artifact_uri: string;
      }[];
      const expectedReferences = entry.transition.operations.flatMap(
        (operation, operationIndex) =>
          operation.provenance.map((reference, referenceIndex) => ({
            operation_index: operationIndex,
            reference_index: referenceIndex,
            source_event_id: reference.sourceEventId,
            artifact_uri: reference.artifactUri,
          })),
      );
      if (
        canonicalJson(
          storedReferences.map((reference) => ({
            operation_index: reference.operation_index,
            reference_index: reference.reference_index,
            source_event_id: reference.source_event_id,
          })),
        ) !==
        canonicalJson(
          expectedReferences.map((reference) => ({
            operation_index: reference.operation_index,
            reference_index: reference.reference_index,
            source_event_id: reference.source_event_id,
          })),
        )
      ) {
        throw new Error(
          'Stored state provenance does not match its transition payload.',
        );
      }
      storedReferences.forEach((stored, index) => {
        const expected = expectedReferences[index]!;
        if (stored.source_session_id !== session.id) {
          throw new Error(
            `Stored provenance crosses session boundaries: ${stored.source_event_id}`,
          );
        }
        if (
          expected.artifact_uri !== undefined &&
          expected.artifact_uri !== stored.source_artifact_uri
        ) {
          throw new Error(
            `Stored provenance artifact does not match its source event: ${stored.source_event_id}`,
          );
        }
      });
    }
    const rebuilt = replayWorkingState(
      session.id,
      session.createdAt,
      transitions,
    );
    const persisted = this.readWorkingState(session);
    if (canonicalJson(rebuilt) !== canonicalJson(persisted)) {
      throw new Error('Working-state projection does not match event replay.');
    }
    return persisted;
  }

  listSessionEvents(sessionIdInput: SessionRecord['id']): RecordedAnyEvent[] {
    const sessionId = SessionIdSchema.parse(sessionIdInput);
    this.requireSession(sessionId);
    const rows = this.database
      .prepare(
        `SELECT e.*, r.reducer_id, r.reducer_version, r.reduced_text,
                r.safe_for_context, r.original_token_estimate,
                r.reduced_token_estimate, r.token_estimator_id,
                r.preserved_fields_json, r.diagnostics_json,
                r.created_at AS reduction_created_at
         FROM events e LEFT JOIN reductions r ON r.event_id = e.id
         WHERE e.session_id = ? ORDER BY e.sequence`,
      )
      .all(sessionId) as SessionEventRow[];
    return rows.map((row) => this.parseAnyEventRow(row));
  }

  getAnyEvent(eventIdInput: string): RecordedAnyEvent | undefined {
    const eventId = EventIdSchema.parse(eventIdInput);
    const row = this.database
      .prepare(
        `SELECT e.*, r.reducer_id, r.reducer_version, r.reduced_text,
                r.safe_for_context, r.original_token_estimate,
                r.reduced_token_estimate, r.token_estimator_id,
                r.preserved_fields_json, r.diagnostics_json,
                r.created_at AS reduction_created_at
         FROM events e LEFT JOIN reductions r ON r.event_id = e.id
         WHERE e.id = ?`,
      )
      .get(eventId) as SessionEventRow | undefined;
    return row ? this.parseAnyEventRow(row) : undefined;
  }

  findDuplicateFileRead(
    sessionIdInput: SessionRecord['id'],
    path: string,
    pathKind: 'repository-relative' | 'absolute' | 'virtual',
    scope:
      { kind: 'full' } | { kind: 'range'; startLine: number; endLine: number },
    contentHash: string,
  ) {
    const sessionId = SessionIdSchema.parse(sessionIdInput);
    const digest = Sha256DigestSchema.parse(contentHash);
    const expected = FileReadObservationV1Schema.parse({
      schemaVersion: 1,
      path,
      pathKind,
      scope,
      encoding: 'utf-8',
    });
    const expectedJson = canonicalJson(expected);
    const row = this.database
      .prepare(
        `SELECT id FROM events
         WHERE session_id = ? AND kind = 'file_read' AND content_hash = ?
           AND payload_json = ?
         ORDER BY sequence LIMIT 1`,
      )
      .get(sessionId, digest, expectedJson) as { id: string } | undefined;
    return row ? EventIdSchema.parse(row.id) : undefined;
  }

  getEvent(eventId: string): RecordedEvent | undefined {
    const id = EventIdSchema.parse(eventId);
    const row = this.database
      .prepare(
        `SELECT e.*, r.reducer_id, r.reducer_version, r.reduced_text, r.safe_for_context,
                r.original_token_estimate, r.reduced_token_estimate, r.token_estimator_id,
                r.preserved_fields_json, r.diagnostics_json,
                r.created_at AS reduction_created_at
         FROM events e JOIN reductions r ON r.event_id = e.id WHERE e.id = ?`,
      )
      .get(id) as EventRow | undefined;
    if (!row) return undefined;

    const storedPayload = parseStoredJson(row.payload_json);
    const event = PersistedContextEventV1Schema.parse({
      schemaVersion: row.schema_version,
      id: row.id,
      sessionId: row.session_id,
      sequence: row.sequence,
      kind: row.kind,
      createdAt: row.created_at,
      payload: storedPayload,
      rawArtifactUri: row.raw_artifact_uri,
      contentHash: row.content_hash,
      byteLength: row.byte_length,
    });
    if (canonicalJson(event.payload) !== row.payload_json) {
      throw new Error('Stored event payload is not canonical JSON.');
    }
    const validatedReduction = validateReductionMetadata({
      reducerId: row.reducer_id,
      reducerVersion: row.reducer_version,
      reducedText: row.reduced_text,
      safeForContext: row.safe_for_context === 1,
      originalTokenEstimate: row.original_token_estimate,
      reducedTokenEstimate: row.reduced_token_estimate,
      tokenEstimatorId: row.token_estimator_id,
      preservedFields: parseStoredJson(row.preserved_fields_json),
      diagnostics: parseStoredJson(row.diagnostics_json),
    });
    const reduction = validatedReduction.metadata;
    assertReductionConsistency(
      event.payload,
      {
        uri: event.rawArtifactUri,
        digest: event.contentHash,
        byteLength: event.byteLength,
      },
      reduction,
      validatedReduction.reducedValue,
    );

    const persistedReduction: PersistedReduction = {
      ...reduction,
      sourceEventId: event.id,
      rawArtifactUri: event.rawArtifactUri,
      createdAt: z.iso
        .datetime({ offset: true })
        .parse(row.reduction_created_at),
    };
    return { event, reduction: persistedReduction };
  }

  private requireSession(sessionId: SessionRecord['id']): SessionRecord {
    const row = this.database
      .prepare('SELECT id, created_at FROM sessions WHERE id = ?')
      .get(sessionId) as { id: string; created_at: string } | undefined;
    if (!row) throw new SessionNotFoundError(sessionId);
    return {
      id: SessionIdSchema.parse(row.id),
      createdAt: z.iso.datetime({ offset: true }).parse(row.created_at),
    };
  }

  private upsertArtifact(
    artifact: RecordObservationReductionInput['artifact'],
    createdAt: string,
  ): void {
    const existing = this.database
      .prepare(
        'SELECT algorithm, digest, byte_length FROM artifacts WHERE uri = ?',
      )
      .get(artifact.uri) as
      { algorithm: string; digest: string; byte_length: number } | undefined;
    if (existing) {
      if (
        existing.algorithm !== artifact.algorithm ||
        existing.digest !== artifact.digest ||
        existing.byte_length !== artifact.byteLength
      ) {
        throw new Error(`Artifact metadata conflict for ${artifact.uri}`);
      }
      return;
    }
    this.database
      .prepare(
        'INSERT INTO artifacts (uri, algorithm, digest, byte_length, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(
        artifact.uri,
        artifact.algorithm,
        artifact.digest,
        artifact.byteLength,
        createdAt,
      );
  }

  private nextSequence(sessionId: SessionRecord['id']): number {
    const row = this.database
      .prepare(
        'SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM events WHERE session_id = ?',
      )
      .get(sessionId) as { sequence: number };
    return row.sequence;
  }

  private insertEvent(
    event: z.infer<typeof PersistedAnyContextEventV1Schema>,
  ): void {
    this.database
      .prepare(
        `INSERT INTO events
         (id, session_id, sequence, schema_version, kind, created_at, content_hash,
          raw_artifact_uri, byte_length, payload_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.id,
        event.sessionId,
        event.sequence,
        event.schemaVersion,
        event.kind,
        event.createdAt,
        event.contentHash,
        event.rawArtifactUri,
        event.byteLength,
        canonicalJson(event.payload),
      );
  }

  private insertReduction(
    eventId: string,
    reduction: z.infer<typeof ReductionMetadataSchema>,
    createdAt: string,
  ): void {
    this.database
      .prepare(
        `INSERT INTO reductions
         (event_id, reducer_id, reducer_version, reduced_text, safe_for_context,
          original_token_estimate, reduced_token_estimate, token_estimator_id,
          preserved_fields_json, diagnostics_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        eventId,
        reduction.reducerId,
        reduction.reducerVersion,
        reduction.reducedText,
        reduction.safeForContext ? 1 : 0,
        reduction.originalTokenEstimate,
        reduction.reducedTokenEstimate,
        reduction.tokenEstimatorId,
        canonicalJson(reduction.preservedFields),
        canonicalJson(reduction.diagnostics),
        createdAt,
      );
  }

  private assertFileDuplicateReference(
    event: z.infer<typeof PersistedAnyContextEventV1Schema>,
    reducedValue: z.infer<typeof Phase2ReducedValueV1Schema>,
  ): void {
    if (event.kind !== 'file_read' || reducedValue.kind !== 'file-read') return;
    if (!reducedValue.duplicateOfEventId) return;
    const row = this.database
      .prepare(
        `SELECT session_id, sequence, kind, content_hash, payload_json
         FROM events WHERE id = ?`,
      )
      .get(reducedValue.duplicateOfEventId) as
      | {
          session_id: string;
          sequence: number;
          kind: string;
          content_hash: string;
          payload_json: string;
        }
      | undefined;
    if (
      !row ||
      row.session_id !== event.sessionId ||
      row.sequence >= event.sequence ||
      row.kind !== 'file_read' ||
      row.content_hash !== event.contentHash ||
      row.payload_json !== canonicalJson(event.payload)
    ) {
      throw new Error(
        `File-read duplicate does not reference an earlier exact observation: ${reducedValue.duplicateOfEventId}`,
      );
    }
  }

  private readWorkingState(
    session: SessionRecord,
  ): z.infer<typeof DurableWorkingStateV1Schema> {
    const row = this.database
      .prepare(
        `SELECT schema_version, revision, through_sequence, state_json,
                state_hash, updated_at
         FROM working_state_snapshots WHERE session_id = ?`,
      )
      .get(session.id) as
      | {
          schema_version: number;
          revision: number;
          through_sequence: number;
          state_json: string;
          state_hash: string;
          updated_at: string;
        }
      | undefined;
    if (!row) return createEmptyWorkingState(session.id, session.createdAt);
    if (stateHash(row.state_json) !== row.state_hash) {
      throw new Error('Working-state projection hash mismatch.');
    }
    const state = DurableWorkingStateV1Schema.parse(
      parseStoredJson(row.state_json),
    );
    if (
      state.schemaVersion !== row.schema_version ||
      state.sessionId !== session.id ||
      state.revision !== row.revision ||
      state.throughSequence !== row.through_sequence ||
      state.updatedAt !== row.updated_at ||
      canonicalJson(state) !== row.state_json
    ) {
      throw new Error('Working-state projection metadata is inconsistent.');
    }
    return state;
  }

  private parseAnyEventRow(row: SessionEventRow): RecordedAnyEvent {
    const storedPayload = parseStoredJson(row.payload_json);
    const event = PersistedAnyContextEventV1Schema.parse({
      schemaVersion: row.schema_version,
      id: row.id,
      sessionId: row.session_id,
      sequence: row.sequence,
      kind: row.kind,
      createdAt: row.created_at,
      payload: storedPayload,
      rawArtifactUri: row.raw_artifact_uri,
      contentHash: row.content_hash,
      byteLength: row.byte_length,
    });
    if (canonicalJson(event.payload) !== row.payload_json) {
      throw new Error('Stored event payload is not canonical JSON.');
    }
    if (row.reducer_id === null) return { event };
    if (
      row.reducer_version === null ||
      row.reduced_text === null ||
      row.safe_for_context === null ||
      row.original_token_estimate === null ||
      row.reduced_token_estimate === null ||
      row.token_estimator_id === null ||
      row.preserved_fields_json === null ||
      row.diagnostics_json === null ||
      row.reduction_created_at === null
    ) {
      throw new Error('Stored reduction metadata is incomplete.');
    }
    const metadataInput = {
      reducerId: row.reducer_id,
      reducerVersion: row.reducer_version,
      reducedText: row.reduced_text,
      safeForContext: row.safe_for_context === 1,
      originalTokenEstimate: row.original_token_estimate,
      reducedTokenEstimate: row.reduced_token_estimate,
      tokenEstimatorId: row.token_estimator_id,
      preservedFields: parseStoredJson(row.preserved_fields_json),
      diagnostics: parseStoredJson(row.diagnostics_json),
    };
    let reduction: z.infer<typeof ReductionMetadataSchema>;
    if (event.kind === 'test_result') {
      const validated = validateReductionMetadata(metadataInput);
      reduction = validated.metadata;
      assertReductionConsistency(
        event.payload,
        {
          uri: event.rawArtifactUri,
          digest: event.contentHash,
          byteLength: event.byteLength,
        },
        reduction,
        validated.reducedValue,
      );
    } else if (
      event.kind === 'file_read' ||
      event.kind === 'search_result' ||
      event.kind === 'build_result'
    ) {
      const validated = validatePhase2Reduction(
        event.kind,
        event.payload,
        {
          uri: event.rawArtifactUri,
          algorithm: 'sha256',
          digest: event.contentHash,
          byteLength: event.byteLength,
          reused: true,
        },
        metadataInput,
      );
      reduction = validated.reduction;
      this.assertFileDuplicateReference(event, validated.reducedValue);
    } else {
      throw new Error('State-update events cannot have reductions.');
    }
    return {
      event,
      reduction: {
        ...reduction,
        sourceEventId: event.id,
        rawArtifactUri: event.rawArtifactUri,
        createdAt: z.iso
          .datetime({ offset: true })
          .parse(row.reduction_created_at),
      },
    };
  }

  close(): void {
    this.database.close();
  }

  private migrate(): void {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.database.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      ) STRICT`);
      const row = this.database
        .prepare(
          'SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations',
        )
        .get() as { version: number };
      if (row.version > 2) {
        throw new Error(
          `Database schema version ${row.version} is newer than this application supports.`,
        );
      }
      let version = row.version;
      if (version === 0) {
        this.database.exec(MIGRATION_1);
        this.database
          .prepare(
            'INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)',
          )
          .run(1, this.now().toISOString());
        version = 1;
      }
      if (version === 1) {
        this.database.exec(MIGRATION_2);
        this.database
          .prepare(
            'INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)',
          )
          .run(2, this.now().toISOString());
      }
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }
}
