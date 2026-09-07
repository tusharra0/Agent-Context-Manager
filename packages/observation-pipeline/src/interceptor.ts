import { Readable } from 'node:stream';

import {
  ContextEventSchema,
  createEventId,
  type EventId,
  type ReductionDiagnostic,
  type SessionId,
  type UuidGenerator,
} from '@acm/core';
import type {
  ArtifactStore,
  MetadataStore,
  StoredArtifact,
} from '@acm/event-store';
import {
  ObservationRecordV1Schema,
  type HarnessToolInvocation,
  type InterceptedObservation,
  type ObservationInterceptionOptions,
  type ObservationInterceptor,
  type ObservationMode,
  type ObservationPolicy,
  type ObservationRecordV1,
  type ObservationReductionOutcome,
  type RawToolOutput,
} from '@acm/harness-port';
import {
  FileReadReducer,
  RipgrepJsonReducer,
  TOKEN_ESTIMATOR_ID,
  TypescriptBuildReducer,
  VitestJsonReducer,
  estimateTokens,
  estimateTokensFromByteLength,
  type ContextReducer,
  type ReductionResult,
} from '@acm/reducers';

import {
  defaultObservationClassifiers,
  type ObservationClassification,
  type ObservationClassifier,
  type ObservationContext,
} from './classifiers.js';
import {
  binaryReferenceText,
  decodeBoundedUtf8,
  withTruncationNotice,
} from './text.js';

/**
 * Default ceiling on how much of one observation may enter the transcript.
 *
 * Native coding-agent tools already bound their output. An unbounded raw
 * condition would not be the baseline it claims to be — it would be a worse
 * agent than the one a developer actually runs, and any saving measured
 * against it would be inflated.
 */
export const DEFAULT_MAX_OBSERVATION_BYTES = 64 * 1024;

export interface RecordingObservationInterceptorOptions {
  readonly sessionId: SessionId;
  readonly policy: ObservationPolicy;
  readonly artifacts: ArtifactStore;
  readonly metadata: MetadataStore;
  /** Absolute directory tools run in; recorded as build and search provenance. */
  readonly workingDirectory: string;
  readonly classifiers?: readonly ObservationClassifier[];
  readonly maxObservationBytes?: number;
  readonly now?: () => Date;
  readonly generateUuid?: UuidGenerator;
  /**
   * Receives every audit record as it is produced. Synchronous on purpose:
   * interception is already serialized, and an awaited sink here would let a
   * slow consumer reorder the records it is meant to describe. Collect and
   * flush afterwards when persistence is needed.
   */
  readonly onRecord?: (record: ObservationRecordV1) => void;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) return error.message;
  if (typeof error === 'string' && error.length > 0) return error;
  return 'The observation pipeline reported an unknown error.';
}

function byteLengthOf(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

type ReducedAttempt = {
  readonly reduction: ReductionResult;
  readonly reducedTokenEstimate: number;
  readonly eventId: EventId;
};

/**
 * Replaces a raw tool observation with a deterministic reduction, keeping the
 * original recoverable.
 *
 * The interceptor sits on the per-step context path: what it returns is what
 * the harness writes into the agent's transcript, so a saving here persists
 * into every later model request in the session rather than only the first.
 *
 * Both experimental conditions run this same path. Under the `raw` policy the
 * reduction is still computed and recorded but never substituted, so the two
 * conditions differ in exactly one decision.
 */
export class RecordingObservationInterceptor implements ObservationInterceptor {
  readonly policy: ObservationPolicy;

  private readonly sessionId: SessionId;
  private readonly artifacts: ArtifactStore;
  private readonly metadata: MetadataStore;
  private readonly context: ObservationContext;
  private readonly classifiers: readonly ObservationClassifier[];
  private readonly maxObservationBytes: number;
  private readonly now: () => Date;
  private readonly generateUuid: UuidGenerator | undefined;
  private readonly onRecord:
    ((record: ObservationRecordV1) => void) | undefined;

  /** Serializes interception so ordering is reproducible across replays. */
  private queue: Promise<void> = Promise.resolve();
  private sessionEnsured = false;

  constructor(options: RecordingObservationInterceptorOptions) {
    const maxObservationBytes =
      options.maxObservationBytes ?? DEFAULT_MAX_OBSERVATION_BYTES;
    if (
      !Number.isSafeInteger(maxObservationBytes) ||
      maxObservationBytes < 1024
    ) {
      throw new RangeError(
        'maxObservationBytes must be a safe integer of at least 1024.',
      );
    }
    if (options.workingDirectory.length === 0) {
      throw new TypeError('workingDirectory must not be empty.');
    }
    this.policy = options.policy;
    this.sessionId = options.sessionId;
    this.artifacts = options.artifacts;
    this.metadata = options.metadata;
    this.context = { workingDirectory: options.workingDirectory };
    this.classifiers = options.classifiers ?? defaultObservationClassifiers();
    this.maxObservationBytes = maxObservationBytes;
    this.now = options.now ?? (() => new Date());
    this.generateUuid = options.generateUuid;
    this.onRecord = options.onRecord;
  }

  async intercept(
    invocation: HarnessToolInvocation,
    output: RawToolOutput,
    options: ObservationInterceptionOptions = {},
  ): Promise<InterceptedObservation> {
    const previous = this.queue;
    let release!: () => void;
    this.queue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await this.run(invocation, output, options);
    } finally {
      release();
    }
  }

  private nextEventId(): EventId {
    return this.generateUuid === undefined
      ? createEventId()
      : createEventId(this.generateUuid);
  }

  private ensureSession(createdAt: string): void {
    if (this.sessionEnsured) return;
    if (!this.metadata.sessionExists(this.sessionId)) {
      this.metadata.createSession({ id: this.sessionId, createdAt });
    }
    this.sessionEnsured = true;
  }

  private async run(
    invocation: HarnessToolInvocation,
    output: RawToolOutput,
    options: ObservationInterceptionOptions,
  ): Promise<InterceptedObservation> {
    const diagnostics: ReductionDiagnostic[] = [];
    const rawByteLength = output.bytes.byteLength;
    if (options.abortSignal?.aborted === true) {
      // Recording still completes: the bytes already exist, and discarding
      // them would lose evidence that cancellation cannot give back.
      diagnostics.push({
        code: 'OBSERVATION_DURING_ABORT',
        message: 'The observation arrived after the turn was cancelled.',
      });
    }

    // Raw evidence is stored before anything is considered for removal. The
    // whole product rule depends on this ordering.
    let artifact: StoredArtifact | undefined;
    try {
      artifact = await this.artifacts.put(
        Readable.from([Buffer.from(output.bytes)]),
      );
    } catch (error) {
      diagnostics.push({
        code: 'ARTIFACT_STORE_FAILED',
        message: `Raw evidence could not be stored: ${errorMessage(error)}`,
      });
    }

    const bounded = decodeBoundedUtf8(output.bytes, this.maxObservationBytes);
    if (bounded === undefined) {
      const text = binaryReferenceText(rawByteLength, artifact?.uri);
      return this.finish(invocation, output, {
        text,
        mode: 'binary-reference',
        reductionOutcome:
          artifact === undefined ? 'raw-evidence-unavailable' : 'binary-output',
        rawByteLength,
        rawTokenEstimate: estimateTokens(text),
        diagnostics,
        ...(artifact === undefined ? {} : { artifact }),
      });
    }

    const shownByteLength = byteLengthOf(bounded.text);
    const rawText = bounded.truncated
      ? withTruncationNotice(
          bounded.text,
          rawByteLength,
          shownByteLength,
          artifact?.uri,
        )
      : bounded.text;
    const rawMode: ObservationMode = bounded.truncated
      ? 'raw-truncated'
      : 'raw';
    const rawTokenEstimate = estimateTokens(rawText);
    if (bounded.truncated) {
      diagnostics.push({
        code: 'OBSERVATION_TRUNCATED',
        message: `Observation is ${rawByteLength} bytes; ${shownByteLength} were shown under the ${this.maxObservationBytes}-byte bound.`,
      });
    }

    const rawResult = (
      reductionOutcome: ObservationReductionOutcome,
      attempt?: ReducedAttempt,
      recorded?: boolean,
    ): InterceptedObservation =>
      this.finish(invocation, output, {
        text: rawText,
        mode: rawMode,
        reductionOutcome,
        rawByteLength,
        rawTokenEstimate,
        diagnostics,
        ...(artifact === undefined ? {} : { artifact }),
        ...(attempt === undefined
          ? {}
          : {
              reduction: attempt.reduction,
              reducedTokenEstimate: attempt.reducedTokenEstimate,
              reductionUsable: false,
              ...(recorded === true ? { eventId: attempt.eventId } : {}),
            }),
      });

    if (artifact === undefined) return rawResult('raw-evidence-unavailable');

    const createdAt = this.now().toISOString();
    try {
      this.ensureSession(createdAt);
    } catch (error) {
      diagnostics.push({
        code: 'SESSION_RECORD_FAILED',
        message: `The observation session could not be opened: ${errorMessage(error)}`,
      });
      // Without a session no typed event can be recorded, so nothing may be
      // removed from view even though the artifact itself was stored.
      return rawResult('raw-evidence-unavailable');
    }

    let classification: ObservationClassification | undefined;
    try {
      for (const classifier of this.classifiers) {
        classification = classifier.classify({
          invocation,
          bytes: output.bytes,
          exitCode: output.exitCode,
          context: this.context,
        });
        if (classification !== undefined) break;
      }
    } catch (error) {
      diagnostics.push({
        code: 'CLASSIFIER_FAILED',
        message: `Classification failed: ${errorMessage(error)}`,
      });
      return rawResult('failed');
    }
    if (classification === undefined) return rawResult('no-reducer');

    const eventId = this.nextEventId();
    let attempt: ReducedAttempt;
    try {
      const reducer = this.reducerFor(classification, artifact);
      const reduction = await reducer.reduce(
        ContextEventSchema.parse({
          id: eventId,
          sessionId: this.sessionId,
          kind: classification.kind,
          createdAt,
          payload: classification.payload,
          rawArtifactUri: artifact.uri,
          contentHash: artifact.digest,
          byteLength: artifact.byteLength,
        }),
      );
      attempt = {
        reduction,
        reducedTokenEstimate: estimateTokens(reduction.reducedText),
        eventId,
      };
    } catch (error) {
      diagnostics.push({
        code: 'REDUCER_FAILED',
        message: `Reduction failed: ${errorMessage(error)}`,
      });
      return rawResult('failed');
    }

    diagnostics.push(...attempt.reduction.diagnostics);

    try {
      this.record(classification, artifact, attempt, createdAt);
    } catch (error) {
      diagnostics.push({
        code: 'EVENT_RECORD_FAILED',
        message: `Reduced observation could not be recorded: ${errorMessage(error)}`,
      });
      // The reduction is not trusted when its provenance is not durable.
      return rawResult('raw-evidence-unavailable', attempt);
    }

    if (!attempt.reduction.safeForContext) {
      return rawResult('unsafe', attempt, true);
    }
    if (attempt.reducedTokenEstimate >= rawTokenEstimate) {
      return rawResult('not-smaller', attempt, true);
    }
    if (this.policy === 'raw') {
      return this.finish(invocation, output, {
        text: rawText,
        mode: rawMode,
        reductionOutcome: 'not-requested',
        rawByteLength,
        rawTokenEstimate,
        diagnostics,
        artifact,
        reduction: attempt.reduction,
        reducedTokenEstimate: attempt.reducedTokenEstimate,
        reductionUsable: true,
        eventId: attempt.eventId,
      });
    }

    return this.finish(invocation, output, {
      text: attempt.reduction.reducedText,
      mode: 'reduced',
      reductionOutcome: 'applied',
      rawByteLength,
      rawTokenEstimate,
      diagnostics,
      artifact,
      reduction: attempt.reduction,
      reducedTokenEstimate: attempt.reducedTokenEstimate,
      reductionUsable: true,
      eventId: attempt.eventId,
    });
  }

  private reducerFor(
    classification: ObservationClassification,
    artifact: StoredArtifact,
  ): ContextReducer {
    switch (classification.kind) {
      case 'file_read': {
        // Looked up inside the serialized section so an identical read cannot
        // race the record that would let it fold into a reference.
        const duplicateOfEventId = this.metadata.findDuplicateFileRead(
          this.sessionId,
          classification.payload.path,
          classification.payload.pathKind,
          classification.payload.scope,
          artifact.digest,
        );
        return new FileReadReducer(duplicateOfEventId);
      }
      case 'search_result':
        return new RipgrepJsonReducer();
      case 'build_result':
        return new TypescriptBuildReducer();
      case 'test_result':
        return new VitestJsonReducer();
    }
  }

  private record(
    classification: ObservationClassification,
    artifact: StoredArtifact,
    attempt: ReducedAttempt,
    createdAt: string,
  ): void {
    const reduction = {
      reducerId: attempt.reduction.reducerId,
      reducerVersion: attempt.reduction.reducerVersion,
      reducedText: attempt.reduction.reducedText,
      safeForContext: attempt.reduction.safeForContext,
      originalTokenEstimate: estimateTokensFromByteLength(artifact.byteLength),
      reducedTokenEstimate: attempt.reducedTokenEstimate,
      tokenEstimatorId: TOKEN_ESTIMATOR_ID,
      preservedFields: attempt.reduction.preservedFields,
      diagnostics: attempt.reduction.diagnostics,
    };
    const shared = {
      eventId: attempt.eventId,
      sessionId: this.sessionId,
      eventCreatedAt: createdAt,
      artifact,
      reduction,
      reductionCreatedAt: createdAt,
    };
    if (classification.kind === 'test_result') {
      this.metadata.recordReduction({
        ...shared,
        payload: classification.payload,
      });
      return;
    }
    this.metadata.recordObservationReduction({
      ...shared,
      kind: classification.kind,
      payload: classification.payload,
    });
  }

  private finish(
    invocation: HarnessToolInvocation,
    output: RawToolOutput,
    input: {
      text: string;
      mode: ObservationMode;
      reductionOutcome: ObservationReductionOutcome;
      rawByteLength: number;
      rawTokenEstimate: number;
      diagnostics: readonly ReductionDiagnostic[];
      artifact?: StoredArtifact;
      reduction?: ReductionResult;
      reducedTokenEstimate?: number;
      reductionUsable?: boolean;
      eventId?: EventId;
    },
  ): InterceptedObservation {
    const record: ObservationRecordV1 = ObservationRecordV1Schema.parse({
      schemaVersion: 1,
      toolCallId: invocation.toolCallId,
      toolName: invocation.toolName,
      policy: this.policy,
      mode: input.mode,
      reductionOutcome: input.reductionOutcome,
      rawByteLength: input.rawByteLength,
      rawTokenEstimate: input.rawTokenEstimate,
      observedTokenEstimate: estimateTokens(input.text),
      tokenEstimatorId: TOKEN_ESTIMATOR_ID,
      diagnostics: input.diagnostics,
      ...(input.reducedTokenEstimate === undefined
        ? {}
        : { reducedTokenEstimate: input.reducedTokenEstimate }),
      ...(input.reductionUsable === undefined
        ? {}
        : { reductionUsable: input.reductionUsable }),
      ...(input.reduction === undefined
        ? {}
        : {
            reducerId: input.reduction.reducerId,
            reducerVersion: input.reduction.reducerVersion,
          }),
      ...(input.artifact === undefined
        ? {}
        : {
            evidence: {
              rawArtifactUri: input.artifact.uri,
              contentHash: input.artifact.digest,
              byteLength: input.artifact.byteLength,
              ...(input.eventId === undefined
                ? {}
                : { eventId: input.eventId }),
            },
          }),
    });
    this.onRecord?.(record);
    return { text: input.text, isError: output.isError, record };
  }
}
