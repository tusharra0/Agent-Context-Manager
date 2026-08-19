import { createReadStream } from 'node:fs';
import { TextDecoder } from 'node:util';

import {
  ContextEventSchema,
  FileReadObservationV1Schema,
  SessionIdSchema,
  canonicalJson,
  createEventId,
  createSessionId,
} from '@acm/core';
import type { FileReadObservationV1, SessionId } from '@acm/core';
import { LocalArtifactStore, SqliteMetadataStore } from '@acm/event-store';
import type { RecordedAnyEvent, StoredArtifact } from '@acm/event-store';
import {
  FileReadReducer,
  PHASE_2_TEXT_PARSER_MAX_BYTES,
  RipgrepJsonReducer,
  TOKEN_ESTIMATOR_ID,
  TypescriptBuildReducer,
  VITEST_JSON_PARSER_MAX_BYTES,
  VitestJsonReducer,
  estimateTokens,
  estimateTokensFromByteLength,
  parseRipgrepJson,
  parseTypescriptBuildOutput,
  parseVitestJson,
} from '@acm/reducers';
import type {
  BuildParseMetadata,
  ReductionResult,
  SearchParseMetadata,
} from '@acm/reducers';

import {
  UsageError,
  rejectUnknownOptions,
  stringOption,
} from '../arguments.js';
import type { CliIo, CliRuntime } from '../cli-context.js';
import {
  exactOption,
  integerOption,
  requirePositionals,
} from '../command-options.js';
import { resolveStorageConfiguration } from '../configuration.js';

type Phase2ReductionType = 'file-read' | 'search-result' | 'build-result';

type SessionSelection = {
  sessionId: SessionId;
  createBeforeRecording: boolean;
};

type PreparedPhase2Reduction =
  | { type: 'file-read'; payload: FileReadObservationV1 }
  | { type: 'search-result'; metadata: SearchParseMetadata }
  | { type: 'build-result'; metadata: BuildParseMetadata };

async function collect(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const value of stream as NodeJS.ReadableStream &
    AsyncIterable<Uint8Array | string>) {
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

function selectSession(
  store: SqliteMetadataStore,
  requestedSession: SessionId | undefined,
): SessionSelection {
  if (!requestedSession) {
    return { sessionId: createSessionId(), createBeforeRecording: true };
  }
  if (!store.sessionExists(requestedSession)) {
    throw new UsageError(`Session does not exist: ${requestedSession}`);
  }
  return { sessionId: requestedSession, createBeforeRecording: false };
}

function requestedSession(
  options: ReadonlyMap<string, string | true>,
): SessionId | undefined {
  const value = stringOption(options, 'session');
  return value === undefined ? undefined : SessionIdSchema.parse(value);
}

function createSessionIfNeeded(
  store: SqliteMetadataStore,
  selection: SessionSelection,
  createdAt: string,
): void {
  if (selection.createBeforeRecording) {
    store.createSession({ id: selection.sessionId, createdAt });
  }
}

async function validateUtf8(stream: NodeJS.ReadableStream): Promise<void> {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  try {
    for await (const value of stream as NodeJS.ReadableStream &
      AsyncIterable<Uint8Array | string>) {
      decoder.decode(Buffer.from(value), { stream: true });
    }
    decoder.decode();
  } catch (error) {
    throw new UsageError('File-read input is not valid UTF-8.', {
      cause: error,
    });
  }
}

function reductionMetadata(
  reduction: ReductionResult,
  originalByteLength: number,
) {
  return {
    reducerId: reduction.reducerId,
    reducerVersion: reduction.reducerVersion,
    reducedText: reduction.reducedText,
    safeForContext: reduction.safeForContext,
    originalTokenEstimate: estimateTokensFromByteLength(originalByteLength),
    reducedTokenEstimate: estimateTokens(reduction.reducedText),
    tokenEstimatorId: TOKEN_ESTIMATOR_ID,
    preservedFields: reduction.preservedFields,
    diagnostics: reduction.diagnostics,
  };
}

function phase2Envelope(
  recorded: RecordedAnyEvent,
  artifact: StoredArtifact,
): string {
  if (!recorded.reduction) {
    throw new Error('Reduced event is missing its reduction.');
  }
  return canonicalJson({
    sessionId: recorded.event.sessionId,
    eventId: recorded.event.id,
    sequence: recorded.event.sequence,
    artifactUri: artifact.uri,
    contentHash: artifact.digest,
    byteLength: artifact.byteLength,
    artifactReused: artifact.reused,
    reducerId: recorded.reduction.reducerId,
    reducerVersion: recorded.reduction.reducerVersion,
    safeForContext: recorded.reduction.safeForContext,
    tokenEstimatorId: recorded.reduction.tokenEstimatorId,
    originalTokenEstimate: recorded.reduction.originalTokenEstimate,
    reducedTokenEstimate: recorded.reduction.reducedTokenEstimate,
    reduction: JSON.parse(recorded.reduction.reducedText),
  });
}

function prepareFileRead(
  options: ReadonlyMap<string, string | true>,
): PreparedPhase2Reduction {
  exactOption(options, 'encoding', 'utf-8');
  const scopeKind = stringOption(options, 'scope', true);
  if (scopeKind !== 'full' && scopeKind !== 'range') {
    throw new UsageError('--scope must be full or range.');
  }
  if (
    scopeKind === 'full' &&
    (options.has('start-line') || options.has('end-line'))
  ) {
    throw new UsageError('Line bounds are valid only with --scope range.');
  }
  const scope =
    scopeKind === 'full'
      ? { kind: 'full' as const }
      : {
          kind: 'range' as const,
          startLine: integerOption(options, 'start-line'),
          endLine: integerOption(options, 'end-line'),
        };
  const payload = FileReadObservationV1Schema.parse({
    schemaVersion: 1,
    path: stringOption(options, 'path', true),
    pathKind: stringOption(options, 'path-kind', true),
    scope,
    encoding: 'utf-8',
  });
  return { type: 'file-read', payload };
}

function prepareSearchResult(
  options: ReadonlyMap<string, string | true>,
): PreparedPhase2Reduction {
  exactOption(options, 'tool', 'ripgrep');
  exactOption(options, 'format', 'json');
  const command = stringOption(options, 'command');
  const exitCode = integerOption(options, 'exit-code');
  return {
    type: 'search-result',
    metadata: {
      query: stringOption(options, 'query', true)!,
      root: stringOption(options, 'root', true)!,
      ...(command ? { command } : {}),
      ...(exitCode !== undefined ? { exitCode } : {}),
    },
  };
}

function prepareBuildResult(
  options: ReadonlyMap<string, string | true>,
): PreparedPhase2Reduction {
  exactOption(options, 'tool', 'typescript');
  exactOption(options, 'format', 'tsc-pretty-false');
  const exitCode = integerOption(options, 'exit-code');
  if (exitCode === undefined) {
    throw new UsageError('Missing required option: --exit-code');
  }
  const toolVersion = stringOption(options, 'tool-version');
  return {
    type: 'build-result',
    metadata: {
      command: stringOption(options, 'command', true)!,
      workingDirectory: stringOption(options, 'working-directory', true)!,
      ...(toolVersion ? { toolVersion } : {}),
      exitCode,
    },
  };
}

function preparePhase2Reduction(
  type: Phase2ReductionType,
  options: ReadonlyMap<string, string | true>,
): PreparedPhase2Reduction {
  const common = ['type', 'session', 'data-dir'];
  const allowed =
    type === 'file-read'
      ? [
          ...common,
          'path',
          'path-kind',
          'scope',
          'start-line',
          'end-line',
          'encoding',
        ]
      : type === 'search-result'
        ? [...common, 'tool', 'format', 'query', 'root', 'command', 'exit-code']
        : [
            ...common,
            'tool',
            'format',
            'command',
            'working-directory',
            'tool-version',
            'exit-code',
          ];
  rejectUnknownOptions(options, allowed);
  if (type === 'file-read') return prepareFileRead(options);
  if (type === 'search-result') return prepareSearchResult(options);
  return prepareBuildResult(options);
}

async function reduceTestResult(
  inputPath: string,
  options: ReadonlyMap<string, string | true>,
  runtime: CliRuntime,
  io: CliIo,
): Promise<number> {
  rejectUnknownOptions(options, [
    'type',
    'framework',
    'format',
    'session',
    'command',
    'exit-code',
    'data-dir',
  ]);
  exactOption(options, 'framework', 'vitest');
  exactOption(options, 'format', 'json');
  const command = stringOption(options, 'command');
  const exitCode = integerOption(options, 'exit-code');
  const sessionId = requestedSession(options);
  const configuration = resolveStorageConfiguration(
    stringOption(options, 'data-dir'),
    runtime.environment,
  );
  const store = new SqliteMetadataStore(configuration.databasePath);
  try {
    const now = runtime.now().toISOString();
    const session = selectSession(store, sessionId);
    const artifactStore = new LocalArtifactStore(configuration.artifactRoot);
    const artifact = await artifactStore.put(createReadStream(inputPath));
    const parserBytes =
      artifact.byteLength <= VITEST_JSON_PARSER_MAX_BYTES
        ? await collect(await artifactStore.open(artifact.uri))
        : Buffer.alloc(0);
    const payload = parseVitestJson(
      parserBytes,
      {
        ...(command ? { command } : {}),
        ...(exitCode !== undefined ? { exitCode } : {}),
      },
      artifact.byteLength,
    );
    const eventId = createEventId();
    const event = ContextEventSchema.parse({
      id: eventId,
      sessionId: session.sessionId,
      kind: 'test_result',
      createdAt: now,
      payload,
      rawArtifactUri: artifact.uri,
      contentHash: artifact.digest,
      byteLength: artifact.byteLength,
    });
    const reduction = await new VitestJsonReducer().reduce(event);
    createSessionIfNeeded(store, session, now);
    const recorded = store.recordReduction({
      eventId,
      sessionId: session.sessionId,
      eventCreatedAt: now,
      payload,
      artifact,
      reduction: reductionMetadata(reduction, artifact.byteLength),
      reductionCreatedAt: runtime.now().toISOString(),
    });
    io.stdout(phase2Envelope(recorded, artifact));
    return reduction.safeForContext ? 0 : 2;
  } finally {
    store.close();
  }
}

async function reducePhase2(
  inputPath: string,
  prepared: PreparedPhase2Reduction,
  options: ReadonlyMap<string, string | true>,
  runtime: CliRuntime,
  io: CliIo,
): Promise<number> {
  const sessionId = requestedSession(options);
  const configuration = resolveStorageConfiguration(
    stringOption(options, 'data-dir'),
    runtime.environment,
  );
  const store = new SqliteMetadataStore(configuration.databasePath);
  try {
    const now = runtime.now().toISOString();
    const session = selectSession(store, sessionId);
    const artifactStore = new LocalArtifactStore(configuration.artifactRoot);
    const artifact = await artifactStore.put(createReadStream(inputPath));
    const eventId = createEventId();
    let kind: 'file_read' | 'search_result' | 'build_result';
    let payload;
    let reduction: ReductionResult;

    if (prepared.type === 'file-read') {
      await validateUtf8(await artifactStore.open(artifact.uri));
      const duplicate = session.createBeforeRecording
        ? undefined
        : store.findDuplicateFileRead(
            session.sessionId,
            prepared.payload.path,
            prepared.payload.pathKind,
            prepared.payload.scope,
            artifact.digest,
          );
      kind = 'file_read';
      payload = prepared.payload;
      reduction = await new FileReadReducer(duplicate).reduce(
        ContextEventSchema.parse({
          id: eventId,
          sessionId: session.sessionId,
          kind,
          createdAt: now,
          payload,
          rawArtifactUri: artifact.uri,
          contentHash: artifact.digest,
          byteLength: artifact.byteLength,
        }),
      );
    } else {
      const parserBytes =
        artifact.byteLength <= PHASE_2_TEXT_PARSER_MAX_BYTES
          ? await collect(await artifactStore.open(artifact.uri))
          : Buffer.alloc(PHASE_2_TEXT_PARSER_MAX_BYTES + 1);
      if (prepared.type === 'search-result') {
        kind = 'search_result';
        payload = parseRipgrepJson(parserBytes, prepared.metadata);
        reduction = await new RipgrepJsonReducer().reduce(
          ContextEventSchema.parse({
            id: eventId,
            sessionId: session.sessionId,
            kind,
            createdAt: now,
            payload,
            rawArtifactUri: artifact.uri,
            contentHash: artifact.digest,
            byteLength: artifact.byteLength,
          }),
        );
      } else {
        kind = 'build_result';
        payload = parseTypescriptBuildOutput(parserBytes, prepared.metadata);
        reduction = await new TypescriptBuildReducer().reduce(
          ContextEventSchema.parse({
            id: eventId,
            sessionId: session.sessionId,
            kind,
            createdAt: now,
            payload,
            rawArtifactUri: artifact.uri,
            contentHash: artifact.digest,
            byteLength: artifact.byteLength,
          }),
        );
      }
    }

    createSessionIfNeeded(store, session, now);
    const recorded = store.recordObservationReduction({
      eventId,
      sessionId: session.sessionId,
      kind,
      eventCreatedAt: now,
      payload,
      artifact,
      reduction: reductionMetadata(reduction, artifact.byteLength),
      reductionCreatedAt: runtime.now().toISOString(),
    });
    io.stdout(phase2Envelope(recorded, artifact));
    return reduction.safeForContext ? 0 : 2;
  } finally {
    store.close();
  }
}

export async function reduceCommand(
  positionals: readonly string[],
  options: ReadonlyMap<string, string | true>,
  runtime: CliRuntime,
  io: CliIo,
): Promise<number> {
  requirePositionals(positionals, 1, 'reduce requires exactly one input path.');
  const type = stringOption(options, 'type', true);
  if (type === 'test-result') {
    return reduceTestResult(positionals[0]!, options, runtime, io);
  }
  if (
    type === 'file-read' ||
    type === 'search-result' ||
    type === 'build-result'
  ) {
    const prepared = preparePhase2Reduction(type, options);
    return reducePhase2(positionals[0]!, prepared, options, runtime, io);
  }
  throw new UsageError(`Unsupported reduction type: ${type}`);
}
