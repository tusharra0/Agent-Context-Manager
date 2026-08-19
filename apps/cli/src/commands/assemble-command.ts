import { writeFile } from 'node:fs/promises';
import { TextDecoder } from 'node:util';

import { SessionIdSchema, canonicalJson } from '@acm/core';
import type {
  ContextExcludedCandidateV1,
  PersistedAnyContextEventV1,
} from '@acm/core';
import { assembleContext } from '@acm/context-assembler';
import type { ObservationCandidate } from '@acm/context-assembler';
import { LocalArtifactStore, SqliteMetadataStore } from '@acm/event-store';
import type { RecordedAnyEvent } from '@acm/event-store';
import {
  PHASE_2_TEXT_PARSER_MAX_BYTES,
  TOKEN_ESTIMATOR_ID,
  estimateTokens,
} from '@acm/reducers';

import {
  UsageError,
  rejectUnknownOptions,
  stringOption,
} from '../arguments.js';
import type { CliIo, CliRuntime } from '../cli-context.js';
import { integerOption, requirePositionals } from '../command-options.js';
import { resolveStorageConfiguration } from '../configuration.js';

const APPROXIMATE_BYTES_PER_TOKEN = 4;

async function collect(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const value of stream as NodeJS.ReadableStream &
    AsyncIterable<Uint8Array | string>) {
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

function fileIdentity(event: PersistedAnyContextEventV1): string | undefined {
  if (event.kind !== 'file_read') return undefined;
  return canonicalJson({
    path: event.payload.path,
    pathKind: event.payload.pathKind,
    scope: event.payload.scope,
  });
}

function latestFileReads(events: readonly RecordedAnyEvent[]): {
  currentEventIds: ReadonlySet<string>;
  excluded: ContextExcludedCandidateV1[];
} {
  const latestByIdentity = new Map<string, string>();
  for (const recorded of events) {
    const identity = fileIdentity(recorded.event);
    if (identity) latestByIdentity.set(identity, recorded.event.id);
  }
  const currentEventIds = new Set(latestByIdentity.values());
  const excluded = events.flatMap((recorded) => {
    const identity = fileIdentity(recorded.event);
    if (!identity || currentEventIds.has(recorded.event.id)) return [];
    return [
      {
        id: `event:${recorded.event.id}`,
        reason: 'superseded' as const,
      },
    ];
  });
  return { currentEventIds, excluded };
}

function isFailure(event: PersistedAnyContextEventV1): boolean {
  if (event.kind === 'test_result') {
    return (
      event.payload.success === false ||
      event.payload.failures.length > 0 ||
      (event.payload.exitCode !== undefined && event.payload.exitCode !== 0)
    );
  }
  if (event.kind === 'build_result') {
    return (
      event.payload.exitCode !== 0 ||
      event.payload.buildDiagnostics.some(
        (diagnostic) => diagnostic.category === 'error',
      )
    );
  }
  if (event.kind === 'search_result') {
    return event.payload.exitCode !== undefined && event.payload.exitCode > 1;
  }
  return false;
}

function incompleteFailureText(recorded: RecordedAnyEvent): string {
  return canonicalJson({
    kind: 'incomplete-active-failure',
    eventKind: recorded.event.kind,
    observation: recorded.event.payload,
    completeness: 'incomplete',
    evidence: {
      rawArtifactUri: recorded.event.rawArtifactUri,
      contentHash: recorded.event.contentHash,
      byteLength: recorded.event.byteLength,
    },
  });
}

function restorationMarker(recorded: RecordedAnyEvent): string {
  if (recorded.event.kind !== 'file_read') {
    throw new TypeError('Only file reads can require content restoration.');
  }
  return canonicalJson({
    kind: 'file-read-restoration-required',
    path: recorded.event.payload.path,
    pathKind: recorded.event.payload.pathKind,
    scope: recorded.event.payload.scope,
    reason: 'content-exceeds-aggregate-restoration-limit',
    evidence: {
      rawArtifactUri: recorded.event.rawArtifactUri,
      contentHash: recorded.event.contentHash,
      byteLength: recorded.event.byteLength,
    },
  });
}

async function fileObservation(
  recorded: RecordedAnyEvent,
  artifactStore: LocalArtifactStore,
  remainingBytes: number,
): Promise<{ observation: ObservationCandidate; restoredBytes: number }> {
  if (recorded.event.kind !== 'file_read') {
    throw new TypeError('Expected a file-read event.');
  }
  let text = restorationMarker(recorded);
  let restoredBytes = 0;
  if (recorded.event.byteLength <= remainingBytes) {
    const bytes = await collect(
      await artifactStore.open(recorded.event.rawArtifactUri),
    );
    const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    text = canonicalJson({
      kind: 'file-read-content',
      path: recorded.event.payload.path,
      pathKind: recorded.event.payload.pathKind,
      scope: recorded.event.payload.scope,
      content,
      evidence: {
        rawArtifactUri: recorded.event.rawArtifactUri,
        contentHash: recorded.event.contentHash,
        byteLength: recorded.event.byteLength,
      },
    });
    restoredBytes = bytes.byteLength;
  }
  return {
    observation: {
      safeForContext: true,
      candidate: {
        id: `event:${recorded.event.id}`,
        class: 'file-observation',
        required: false,
        sequence: recorded.event.sequence,
        text,
        sourceEventIds: [recorded.event.id],
      },
    },
    restoredBytes,
  };
}

function nonFileObservation(recorded: RecordedAnyEvent): ObservationCandidate {
  if (!recorded.reduction) {
    throw new TypeError('Observation event is missing its reduction.');
  }
  const failure = isFailure(recorded.event);
  const safeForContext = failure || recorded.reduction.safeForContext;
  return {
    safeForContext,
    candidate: {
      id: `event:${recorded.event.id}`,
      class: failure ? 'active-failure' : 'recent-observation',
      required: failure,
      sequence: recorded.event.sequence,
      text:
        failure && !recorded.reduction.safeForContext
          ? incompleteFailureText(recorded)
          : recorded.reduction.reducedText,
      sourceEventIds: [recorded.event.id],
    },
  };
}

export async function assembleCommand(
  positionals: readonly string[],
  options: ReadonlyMap<string, string | true>,
  runtime: CliRuntime,
  io: CliIo,
): Promise<number> {
  requirePositionals(
    positionals,
    0,
    'assemble accepts no positional arguments.',
  );
  rejectUnknownOptions(options, [
    'session',
    'token-budget',
    'output',
    'data-dir',
  ]);
  const sessionId = SessionIdSchema.parse(
    stringOption(options, 'session', true),
  );
  const tokenBudget = integerOption(options, 'token-budget');
  if (tokenBudget === undefined || tokenBudget < 0) {
    throw new UsageError('--token-budget must be a non-negative integer.');
  }
  const configuration = resolveStorageConfiguration(
    stringOption(options, 'data-dir'),
    runtime.environment,
  );
  const store = new SqliteMetadataStore(configuration.databasePath);
  try {
    const state = store.verifyWorkingState(sessionId);
    const events = store.listSessionEvents(sessionId);
    const latestFiles = latestFileReads(events);
    const observations: ObservationCandidate[] = [];
    const artifactStore = new LocalArtifactStore(configuration.artifactRoot);
    const budgetBytes =
      tokenBudget >
      Math.floor(Number.MAX_SAFE_INTEGER / APPROXIMATE_BYTES_PER_TOKEN)
        ? Number.MAX_SAFE_INTEGER
        : tokenBudget * APPROXIMATE_BYTES_PER_TOKEN;
    const restorationLimit = Math.min(
      budgetBytes,
      PHASE_2_TEXT_PARSER_MAX_BYTES,
    );
    let remainingRestorationBytes = restorationLimit;

    for (const recorded of [...events].sort(
      (left, right) => right.event.sequence - left.event.sequence,
    )) {
      if (!recorded.reduction) continue;
      if (recorded.event.kind === 'file_read') {
        if (!latestFiles.currentEventIds.has(recorded.event.id)) continue;
        const prepared = await fileObservation(
          recorded,
          artifactStore,
          remainingRestorationBytes,
        );
        remainingRestorationBytes -= prepared.restoredBytes;
        observations.push(prepared.observation);
      } else {
        observations.push(nonFileObservation(recorded));
      }
    }

    const assembled = assembleContext({
      state,
      observations,
      preExcludedCandidates: latestFiles.excluded,
      tokenBudget,
      tokenEstimator: { id: TOKEN_ESTIMATOR_ID, estimate: estimateTokens },
    });
    const output = canonicalJson({
      context: JSON.parse(assembled.contextText),
      manifest: assembled.manifest,
    });
    const outputPath = stringOption(options, 'output');
    if (outputPath) {
      await writeFile(outputPath, output, { flag: 'wx', mode: 0o600 });
      io.stdout(`Wrote assembled context to ${outputPath}`);
    } else {
      io.stdout(output);
    }
    return assembled.manifest.status === 'within-budget' ? 0 : 2;
  } finally {
    store.close();
  }
}
