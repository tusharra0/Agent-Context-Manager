import { createHash } from 'node:crypto';

import {
  ContextEventSchema,
  JsonValueSchema,
  canonicalJson,
  PersistedAnyContextEventV1Schema,
  type JsonValue,
  type PersistedAnyContextEventV1,
} from '@acm/core';
import {
  isFailureObservation,
  reconcileObservationEvents,
  type TokenEstimator,
} from '@acm/context-assembler';
import { evaluateExperiment, type ReplayCheckpointV1 } from '@acm/evaluation';
import {
  FileReadReducer,
  RipgrepJsonReducer,
  TypescriptBuildReducer,
  VitestJsonReducer,
  parseRipgrepJson,
  parseTypescriptBuildOutput,
  parseVitestJson,
  type ReductionResult,
} from '@acm/reducers';

import {
  HostedEvaluationPlanV1Schema,
  type HostedEvaluationPlanV1,
  type HostedReductionInputV1,
} from './schemas.js';

type ReducedObservation = {
  event: PersistedAnyContextEventV1;
  reduction: ReductionResult;
};
export interface PreparedHostedPlan {
  plan: HostedEvaluationPlanV1;
  reductions: ReducedObservation[];
}

async function reduceObservation(
  observation: ReplayCheckpointV1['observations'][number],
  input: HostedReductionInputV1,
  checkpoint: ReplayCheckpointV1,
  createdAt: string,
  prior: readonly ReducedObservation[],
): Promise<ReducedObservation> {
  const bytes = Buffer.from(observation.rawText, 'utf8');
  const contentHash = createHash('sha256').update(bytes).digest('hex');
  if (contentHash !== observation.contentHash)
    throw new Error(
      `Raw observation hash mismatch for ${observation.eventId}.`,
    );
  let payload: JsonValue;
  let reducer;
  if (input.kind === 'test_result') {
    payload = JsonValueSchema.parse(
      parseVitestJson(bytes, {
        ...(input.command === undefined ? {} : { command: input.command }),
        ...(input.exitCode === undefined ? {} : { exitCode: input.exitCode }),
      }),
    );
    reducer = new VitestJsonReducer();
  } else if (input.kind === 'build_result') {
    payload = JsonValueSchema.parse(
      parseTypescriptBuildOutput(bytes, {
        command: input.command,
        workingDirectory: input.workingDirectory,
        exitCode: input.exitCode,
        ...(input.toolVersion === undefined
          ? {}
          : { toolVersion: input.toolVersion }),
      }),
    );
    reducer = new TypescriptBuildReducer();
  } else if (input.kind === 'search_result') {
    payload = JsonValueSchema.parse(
      parseRipgrepJson(bytes, {
        query: input.query,
        root: input.root,
        ...(input.command === undefined ? {} : { command: input.command }),
        ...(input.exitCode === undefined ? {} : { exitCode: input.exitCode }),
      }),
    );
    reducer = new RipgrepJsonReducer();
  } else {
    payload = JsonValueSchema.parse(input.metadata);
    const duplicate = prior.find(
      ({ event }) =>
        event.kind === 'file_read' &&
        event.contentHash === contentHash &&
        canonicalJson(event.payload) === canonicalJson(payload),
    );
    reducer = new FileReadReducer(duplicate?.event.id);
  }
  const event = PersistedAnyContextEventV1Schema.parse({
    schemaVersion: 1,
    id: observation.eventId,
    sessionId: checkpoint.state.sessionId,
    sequence: observation.sequence,
    kind: input.kind,
    createdAt,
    payload,
    rawArtifactUri: `artifact://sha256/${contentHash}`,
    contentHash,
    byteLength: bytes.byteLength,
  });
  return {
    event,
    reduction: await reducer.reduce(ContextEventSchema.parse(event)),
  };
}

/** Validates every case before remote work and derives typed-mode candidates from raw evidence. */
export async function prepareHostedEvaluationPlan(
  input: HostedEvaluationPlanV1,
  estimator: TokenEstimator,
): Promise<PreparedHostedPlan> {
  const plan = HostedEvaluationPlanV1Schema.parse(input);
  const reductions: ReducedObservation[] = [];
  if (
    plan.contextSource === 'recorded-candidates' &&
    plan.reductionInputs.length > 0
  ) {
    throw new Error('Reduction inputs require contextSource typed-reducers.');
  }
  if (plan.contextSource === 'typed-reducers') {
    const inputs = new Map<string, HostedReductionInputV1>();
    for (const entry of plan.reductionInputs) {
      const key = `${entry.caseId}:${entry.eventId}`;
      if (inputs.has(key)) throw new Error(`Duplicate reduction input: ${key}`);
      inputs.set(key, entry);
    }
    for (const evaluationCase of plan.experiment.cases) {
      const checkpoint = evaluationCase.checkpoints[0]!;
      const reduced: ReducedObservation[] = [];
      for (const observation of [...checkpoint.observations].sort(
        (a, b) => a.sequence - b.sequence,
      )) {
        const key = `${evaluationCase.id}:${observation.eventId}`;
        const entry = inputs.get(key);
        if (!entry) throw new Error(`Missing typed reduction input: ${key}`);
        inputs.delete(key);
        reduced.push(
          await reduceObservation(
            observation,
            entry,
            checkpoint,
            plan.experiment.createdAt,
            reduced,
          ),
        );
      }
      const reconciled = reconcileObservationEvents(
        checkpoint.state,
        reduced.map((entry) => entry.event),
      );
      for (const observation of checkpoint.observations) {
        const { event, reduction } = reduced.find(
          (entry) => entry.event.id === observation.eventId,
        )!;
        const failure = isFailureObservation(event);
        const resolved = reconciled.resolvedFailureEventIds.has(event.id);
        const evidence = {
          rawArtifactUri: event.rawArtifactUri,
          contentHash: event.contentHash,
          byteLength: event.byteLength,
        };
        let text = reduction.reducedText;
        if (event.kind === 'file_read') {
          text = canonicalJson({
            kind: 'file-read-content',
            ...event.payload,
            content: observation.rawText,
            evidence,
          });
        } else if (!reduction.safeForContext) {
          // Restoring the verified original is the conservative fallback, not an unsafe summary.
          text = canonicalJson({
            kind: 'restored-observation',
            eventKind: event.kind,
            rawText: observation.rawText,
            diagnostics: reduction.diagnostics,
            evidence,
          });
        }
        if (resolved)
          text = canonicalJson({
            kind: 'resolved-failure',
            observation: event.payload,
            evidence,
            resolution: checkpoint.state.failures.filter(
              (item) =>
                item.status === 'resolved' &&
                item.provenance.some(
                  (reference) => reference.sourceEventId === event.id,
                ),
            ),
          });
        observation.managedCandidate = {
          id: observation.managedCandidate.id,
          class: resolved
            ? 'completed-outcome'
            : failure
              ? 'active-failure'
              : event.kind === 'file_read'
                ? 'file-observation'
                : 'recent-observation',
          required: failure && !resolved,
          sequence: event.sequence,
          text,
          sourceEventIds: [event.id],
        };
        observation.safeForContext = true;
        delete observation.managedExclusion;
        if (
          event.kind === 'file_read' &&
          !reconciled.currentFileReadEventIds.has(event.id)
        )
          observation.managedExclusion = 'superseded';
      }
      reductions.push(...reduced);
    }
    if (inputs.size > 0)
      throw new Error(`Unused reduction input: ${inputs.keys().next().value}`);
  }
  // The offline evaluator checks policy/estimator identity, hashes, cutoffs,
  // duplicate IDs and raw-visible provenance for the complete plan.
  evaluateExperiment(plan.experiment, estimator);
  return { plan, reductions };
}
