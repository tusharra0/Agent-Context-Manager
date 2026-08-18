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
  EventIdSchema,
  PersistedContextEventV1Schema,
  ReducedTestResultV1Schema,
  ReductionDiagnosticSchema,
  SessionIdSchema,
  TestResultObservationV1Schema,
  canonicalJson,
} from '@acm/core';
import { z } from 'zod';

import type {
  CreateSessionInput,
  MetadataStore,
  PersistedReduction,
  RecordedEvent,
  RecordReductionInput,
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

    const event = PersistedContextEventV1Schema.parse({
      schemaVersion: row.schema_version,
      id: row.id,
      sessionId: row.session_id,
      sequence: row.sequence,
      kind: row.kind,
      createdAt: row.created_at,
      payload: parseStoredJson(row.payload_json),
      rawArtifactUri: row.raw_artifact_uri,
      contentHash: row.content_hash,
      byteLength: row.byte_length,
    });
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
      if (row.version > 1) {
        throw new Error(
          `Database schema version ${row.version} is newer than this application supports.`,
        );
      }
      if (row.version === 0) {
        this.database.exec(MIGRATION_1);
        this.database
          .prepare(
            'INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)',
          )
          .run(1, this.now().toISOString());
      }
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }
}
