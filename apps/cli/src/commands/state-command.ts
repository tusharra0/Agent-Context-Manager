import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { TextDecoder } from 'node:util';

import {
  SessionIdSchema,
  WorkingStateTransitionV1Schema,
  canonicalJson,
  createEventId,
  createStateItemId,
} from '@acm/core';
import { LocalArtifactStore, SqliteMetadataStore } from '@acm/event-store';
import { PHASE_2_TEXT_PARSER_MAX_BYTES } from '@acm/reducers';

import {
  UsageError,
  rejectUnknownOptions,
  stringOption,
} from '../arguments.js';
import type { CliIo, CliRuntime } from '../cli-context.js';
import { requirePositionals } from '../command-options.js';
import { resolveStorageConfiguration } from '../configuration.js';

function objectValue(value: unknown, message: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new UsageError(message);
  }
  return value as Record<string, unknown>;
}

function normalizeTransitionDocument(
  value: unknown,
  eventId: string,
  artifactUri: string,
) {
  const document = objectValue(value, 'State update must be a JSON object.');
  if (!Array.isArray(document.operations)) {
    throw new UsageError('State update operations must be an array.');
  }
  const operations = document.operations.map((input) => {
    const operation = {
      ...objectValue(input, 'Each state operation must be an object.'),
    };
    if (
      ['set-goal', 'add-fact', 'record-file'].includes(
        String(operation.operation),
      ) &&
      operation.itemId === undefined
    ) {
      operation.itemId = createStateItemId();
    }
    if (operation.provenance === undefined) {
      operation.provenance = [{ sourceEventId: eventId, artifactUri }];
    }
    return operation;
  });
  return WorkingStateTransitionV1Schema.parse({
    ...document,
    operations,
  });
}

async function readStateUpdate(path: string): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let byteLength = 0;
  for await (const value of createReadStream(path)) {
    const chunk = Buffer.from(value as Uint8Array);
    if (byteLength + chunk.byteLength > PHASE_2_TEXT_PARSER_MAX_BYTES) {
      throw new UsageError(
        `State update exceeds the ${PHASE_2_TEXT_PARSER_MAX_BYTES}-byte input bound.`,
      );
    }
    chunks.push(chunk);
    byteLength += chunk.byteLength;
  }
  return Buffer.concat(chunks, byteLength);
}

function parseStateUpdate(bytes: Uint8Array): unknown {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    throw new UsageError('State update is not valid UTF-8.', { cause: error });
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new UsageError('State update is not valid JSON.', { cause: error });
  }
}

async function prepareStateUpdate(path: string) {
  const bytes = await readStateUpdate(path);
  const document = parseStateUpdate(bytes);
  const eventId = createEventId();
  const digest = createHash('sha256').update(bytes).digest('hex');
  const artifactUri = `artifact://sha256/${digest}`;
  const transition = normalizeTransitionDocument(
    document,
    eventId,
    artifactUri,
  );
  return { bytes, eventId, artifactUri, transition };
}

export async function stateCommand(
  positionals: readonly string[],
  options: ReadonlyMap<string, string | true>,
  runtime: CliRuntime,
  io: CliIo,
): Promise<number> {
  rejectUnknownOptions(options, ['session', 'data-dir']);
  const action = positionals[0];
  const sessionId = SessionIdSchema.parse(
    stringOption(options, 'session', true),
  );
  if (action === 'verify') {
    requirePositionals(positionals, 1, 'state verify accepts no input path.');
  } else if (action === 'apply') {
    requirePositionals(
      positionals,
      2,
      'state apply requires one JSON input path.',
    );
  } else {
    throw new UsageError('state supports apply or verify.');
  }
  const prepared =
    action === 'apply' ? await prepareStateUpdate(positionals[1]!) : undefined;
  const configuration = resolveStorageConfiguration(
    stringOption(options, 'data-dir'),
    runtime.environment,
  );
  const store = new SqliteMetadataStore(configuration.databasePath);
  try {
    if (action === 'verify') {
      const state = store.verifyWorkingState(sessionId);
      io.stdout(
        canonicalJson({
          status: 'verified',
          sessionId,
          revision: state.revision,
          throughSequence: state.throughSequence,
        }),
      );
      return 0;
    }
    if (!prepared) {
      throw new Error('State apply input was not prepared.');
    }
    if (!store.sessionExists(sessionId)) {
      throw new UsageError(`Session does not exist: ${sessionId}`);
    }
    const artifactStore = new LocalArtifactStore(configuration.artifactRoot);
    const artifact = await artifactStore.put(Readable.from([prepared.bytes]));
    if (artifact.uri !== prepared.artifactUri) {
      throw new Error(
        'Stored state-update artifact digest changed unexpectedly.',
      );
    }
    const recorded = store.recordStateUpdate({
      eventId: prepared.eventId,
      sessionId,
      eventCreatedAt: runtime.now().toISOString(),
      transition: prepared.transition,
      artifact,
    });
    io.stdout(
      canonicalJson({
        sessionId,
        eventId: prepared.eventId,
        sequence: recorded.event.sequence,
        revision: recorded.state.revision,
        state: recorded.state,
      }),
    );
    return 0;
  } finally {
    store.close();
  }
}
