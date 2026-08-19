import { EventIdSchema, SessionIdSchema, canonicalJson } from '@acm/core';
import { SqliteMetadataStore } from '@acm/event-store';

import {
  UsageError,
  rejectUnknownOptions,
  stringOption,
} from '../arguments.js';
import type { CliIo, CliRuntime } from '../cli-context.js';
import { requirePositionals } from '../command-options.js';
import { resolveStorageConfiguration } from '../configuration.js';

export function inspectCommand(
  positionals: readonly string[],
  options: ReadonlyMap<string, string | true>,
  runtime: CliRuntime,
  io: CliIo,
): number {
  const target = positionals[0];
  if (target !== 'event' && target !== 'state') {
    throw new UsageError(
      'inspect supports event <event-id> or state --session <session-id>.',
    );
  }
  rejectUnknownOptions(options, ['data-dir', 'json', 'session']);

  let eventId: ReturnType<typeof EventIdSchema.parse> | undefined;
  let sessionId: ReturnType<typeof SessionIdSchema.parse> | undefined;
  if (target === 'state') {
    requirePositionals(
      positionals,
      1,
      'inspect state accepts no additional positionals.',
    );
    sessionId = SessionIdSchema.parse(stringOption(options, 'session', true));
  } else {
    requirePositionals(
      positionals,
      2,
      'inspect usage: acm inspect event <event-id>',
    );
    if (options.has('session')) {
      throw new UsageError('--session is valid only for inspect state.');
    }
    eventId = EventIdSchema.parse(positionals[1]);
  }

  const configuration = resolveStorageConfiguration(
    stringOption(options, 'data-dir'),
    runtime.environment,
  );
  const store = new SqliteMetadataStore(configuration.databasePath);
  try {
    if (target === 'state') {
      if (!sessionId) throw new Error('State session was not validated.');
      const state = store.getWorkingState(sessionId);
      io.stdout(
        options.get('json') === true
          ? canonicalJson(state)
          : [
              `Session: ${state.sessionId}`,
              `Revision: ${state.revision}`,
              `Through sequence: ${state.throughSequence}`,
              `State: ${canonicalJson(state)}`,
            ].join('\n'),
      );
      return 0;
    }

    if (!eventId) throw new Error('Event ID was not validated.');
    const recorded = store.getAnyEvent(eventId);
    if (!recorded) throw new UsageError(`Event does not exist: ${eventId}`);
    if (options.get('json') === true) {
      io.stdout(canonicalJson(recorded));
    } else {
      const safety = recorded.reduction
        ? String(recorded.reduction.safeForContext)
        : 'not applicable';
      io.stdout(
        [
          `Event: ${recorded.event.id}`,
          `Session: ${recorded.event.sessionId}`,
          `Sequence: ${recorded.event.sequence}`,
          `Artifact: ${recorded.event.rawArtifactUri}`,
          `Safe for context: ${safety}`,
          `Reduction: ${recorded.reduction?.reducedText ?? 'none'}`,
        ].join('\n'),
      );
    }
    return 0;
  } finally {
    store.close();
  }
}
