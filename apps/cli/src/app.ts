import { createReadStream } from 'node:fs';

import {
  ContextEventSchema,
  EventIdSchema,
  SessionIdSchema,
  canonicalJson,
  createEventId,
  createSessionId,
} from '@acm/core';
import { LocalArtifactStore, SqliteMetadataStore } from '@acm/event-store';
import {
  TOKEN_ESTIMATOR_ID,
  VITEST_JSON_PARSER_MAX_BYTES,
  VitestJsonReducer,
  estimateTokens,
  estimateTokensFromByteLength,
  parseVitestJson,
} from '@acm/reducers';

import {
  UsageError,
  parseArguments,
  rejectUnknownOptions,
  stringOption,
} from './arguments.js';
import { resolveStorageConfiguration } from './configuration.js';

export type CliIo = {
  stdout(message: string): void;
  stderr(message: string): void;
};

export type CliRuntime = {
  environment: NodeJS.ProcessEnv;
  now(): Date;
};

const DEFAULT_IO: CliIo = {
  stdout: (message) => console.log(message),
  stderr: (message) => console.error(message),
};

const DEFAULT_RUNTIME: CliRuntime = {
  environment: process.env,
  now: () => new Date(),
};

export const HELP_TEXT = `Agent Context Manager

Usage:
  acm reduce <input> --type test-result --framework vitest --format json [options]
  acm restore <artifact-uri> --output <path> [--data-dir <path>]
  acm inspect event <event-id> [--data-dir <path>] [--json]
  acm doctor

Reduce options:
  --session <id>       Append to an existing session
  --command <command>  Record the command that produced the report
  --exit-code <code>   Record the captured test command's integer exit code
  --data-dir <path>    Override ACM_DATA_DIR and the default ~/.acm directory`;

function requirePositionals(
  positionals: readonly string[],
  count: number,
  usage: string,
): void {
  if (positionals.length !== count) throw new UsageError(usage);
}

function exactOption(
  options: ReadonlyMap<string, string | true>,
  name: string,
  expected: string,
): void {
  const value = stringOption(options, name, true);
  if (value !== expected)
    throw new UsageError(`--${name} must be ${expected} in Phase 1.`);
}

function integerOption(
  options: ReadonlyMap<string, string | true>,
  name: string,
): number | undefined {
  const value = stringOption(options, name);
  if (value === undefined) return undefined;
  if (!/^-?\d+$/u.test(value))
    throw new UsageError(`--${name} must be an integer.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed))
    throw new UsageError(`--${name} is outside the safe integer range.`);
  return parsed;
}

async function collect(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const value of stream as NodeJS.ReadableStream &
    AsyncIterable<Uint8Array | string>) {
    chunks.push(
      typeof value === 'string' ? Buffer.from(value) : Buffer.from(value),
    );
  }
  return Buffer.concat(chunks);
}

async function reduceCommand(
  positionals: readonly string[],
  options: ReadonlyMap<string, string | true>,
  runtime: CliRuntime,
  io: CliIo,
): Promise<number> {
  requirePositionals(positionals, 1, 'reduce requires exactly one input path.');
  rejectUnknownOptions(options, [
    'type',
    'framework',
    'format',
    'session',
    'command',
    'exit-code',
    'data-dir',
  ]);
  exactOption(options, 'type', 'test-result');
  exactOption(options, 'framework', 'vitest');
  exactOption(options, 'format', 'json');
  const command = stringOption(options, 'command');
  const exitCode = integerOption(options, 'exit-code');
  const requestedSession = stringOption(options, 'session');
  const configuration = resolveStorageConfiguration(
    stringOption(options, 'data-dir'),
    runtime.environment,
  );
  const metadataStore = new SqliteMetadataStore(configuration.databasePath);

  try {
    const now = runtime.now().toISOString();
    const sessionId = requestedSession
      ? SessionIdSchema.parse(requestedSession)
      : metadataStore.createSession({ id: createSessionId(), createdAt: now })
          .id;
    if (requestedSession && !metadataStore.sessionExists(sessionId)) {
      throw new UsageError(`Session does not exist: ${sessionId}`);
    }

    const artifactStore = new LocalArtifactStore(configuration.artifactRoot);
    const artifact = await artifactStore.put(createReadStream(positionals[0]!));
    const parserBytes =
      artifact.byteLength <= VITEST_JSON_PARSER_MAX_BYTES
        ? await collect(await artifactStore.open(artifact.uri))
        : Buffer.alloc(0);
    const parseMetadata = {
      ...(command ? { command } : {}),
      ...(exitCode !== undefined ? { exitCode } : {}),
    };
    const payload = parseVitestJson(
      parserBytes,
      parseMetadata,
      artifact.byteLength,
    );
    const eventId = createEventId();
    const event = ContextEventSchema.parse({
      id: eventId,
      sessionId,
      kind: 'test_result',
      createdAt: now,
      payload,
      rawArtifactUri: artifact.uri,
      contentHash: artifact.digest,
      byteLength: artifact.byteLength,
    });
    const reduction = await new VitestJsonReducer().reduce(event);
    const recorded = metadataStore.recordReduction({
      eventId,
      sessionId,
      eventCreatedAt: now,
      payload,
      artifact,
      reduction: {
        reducerId: reduction.reducerId,
        reducerVersion: reduction.reducerVersion,
        reducedText: reduction.reducedText,
        safeForContext: reduction.safeForContext,
        originalTokenEstimate: estimateTokensFromByteLength(
          artifact.byteLength,
        ),
        reducedTokenEstimate: estimateTokens(reduction.reducedText),
        tokenEstimatorId: TOKEN_ESTIMATOR_ID,
        preservedFields: reduction.preservedFields,
        diagnostics: reduction.diagnostics,
      },
      reductionCreatedAt: runtime.now().toISOString(),
    });

    io.stdout(
      canonicalJson({
        sessionId,
        eventId,
        sequence: recorded.event.sequence,
        artifactUri: artifact.uri,
        contentHash: artifact.digest,
        byteLength: artifact.byteLength,
        artifactReused: artifact.reused,
        reducerId: reduction.reducerId,
        reducerVersion: reduction.reducerVersion,
        safeForContext: reduction.safeForContext,
        tokenEstimatorId: TOKEN_ESTIMATOR_ID,
        originalTokenEstimate: recorded.reduction.originalTokenEstimate,
        reducedTokenEstimate: recorded.reduction.reducedTokenEstimate,
        reduction: JSON.parse(reduction.reducedText),
      }),
    );
    return reduction.safeForContext ? 0 : 2;
  } finally {
    metadataStore.close();
  }
}

async function restoreCommand(
  positionals: readonly string[],
  options: ReadonlyMap<string, string | true>,
  runtime: CliRuntime,
  io: CliIo,
): Promise<number> {
  requirePositionals(
    positionals,
    1,
    'restore requires exactly one artifact URI.',
  );
  rejectUnknownOptions(options, ['output', 'data-dir']);
  const output = stringOption(options, 'output', true)!;
  const configuration = resolveStorageConfiguration(
    stringOption(options, 'data-dir'),
    runtime.environment,
  );
  await new LocalArtifactStore(configuration.artifactRoot).restore(
    positionals[0]!,
    output,
  );
  io.stdout(`Restored ${positionals[0]} to ${output}`);
  return 0;
}

function inspectCommand(
  positionals: readonly string[],
  options: ReadonlyMap<string, string | true>,
  runtime: CliRuntime,
  io: CliIo,
): number {
  requirePositionals(
    positionals,
    2,
    'inspect usage: acm inspect event <event-id>',
  );
  if (positionals[0] !== 'event')
    throw new UsageError('Phase 1 inspection supports only events.');
  rejectUnknownOptions(options, ['data-dir', 'json']);
  const eventId = EventIdSchema.parse(positionals[1]);
  const configuration = resolveStorageConfiguration(
    stringOption(options, 'data-dir'),
    runtime.environment,
  );
  const metadataStore = new SqliteMetadataStore(configuration.databasePath);
  try {
    const recorded = metadataStore.getEvent(eventId);
    if (!recorded) throw new UsageError(`Event does not exist: ${eventId}`);
    if (options.get('json') === true) io.stdout(canonicalJson(recorded));
    else {
      io.stdout(
        [
          `Event: ${recorded.event.id}`,
          `Session: ${recorded.event.sessionId}`,
          `Sequence: ${recorded.event.sequence}`,
          `Artifact: ${recorded.event.rawArtifactUri}`,
          `Safe for context: ${String(recorded.reduction.safeForContext)}`,
          `Reduction: ${recorded.reduction.reducedText}`,
        ].join('\n'),
      );
    }
    return 0;
  } finally {
    metadataStore.close();
  }
}

function doctor(io: CliIo): number {
  const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
  const supported = major > 22 || (major === 22 && minor >= 13);
  io.stdout(
    `${supported ? 'PASS' : 'FAIL'}  Node.js 22.13+ (${process.version})`,
  );
  if (supported) io.stdout('PASS  Phase 1 runtime is ready.');
  return supported ? 0 : 1;
}

export async function runCli(
  arguments_: readonly string[],
  io: CliIo = DEFAULT_IO,
  runtime: CliRuntime = DEFAULT_RUNTIME,
): Promise<number> {
  try {
    const parsed = parseArguments(arguments_);
    switch (parsed.command) {
      case 'reduce':
        return await reduceCommand(
          parsed.positionals,
          parsed.options,
          runtime,
          io,
        );
      case 'restore':
        return await restoreCommand(
          parsed.positionals,
          parsed.options,
          runtime,
          io,
        );
      case 'inspect':
        return inspectCommand(parsed.positionals, parsed.options, runtime, io);
      case 'doctor':
        requirePositionals(
          parsed.positionals,
          0,
          'doctor accepts no positional arguments.',
        );
        rejectUnknownOptions(parsed.options, []);
        return doctor(io);
      case 'help':
      case '--help':
      case '-h':
        io.stdout(HELP_TEXT);
        return 0;
      default:
        throw new UsageError(`Unknown command: ${parsed.command}`);
    }
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
