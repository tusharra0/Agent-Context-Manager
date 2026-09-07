import type { TokenEstimator } from '@acm/context-assembler';
import { JsonValueSchema, type JsonValue } from '@acm/core';
import {
  buildConditionEvidenceFromHarnessTrace,
  evaluateExperiment,
  prepareEvaluationCheckpointContexts,
} from '@acm/evaluation';

import {
  HostedConditionRunOutputV1Schema,
  HostedEvaluationPlanV1Schema,
  HostedEvaluationResultV1Schema,
  HostedTraceRecordV1Schema,
  type HostedConditionRunOutputV1,
  type HostedEvaluationPlanV1,
  type HostedObservationInterception,
  type PublicGitFixtureV1,
  type HostedEvaluationResultV1,
  type HostedTraceRecordV1,
} from './schemas.js';
import { prepareHostedEvaluationPlan } from './preparation.js';

export type HostedConditionTraceEntry = {
  kind: 'harness-event' | 'command' | 'session-destroyed';
  data: JsonValue;
};

export interface HostedConditionRunInputV1 {
  condition: 'raw' | 'managed';
  harness: HostedEvaluationPlanV1['harness'];
  model: string;
  fixture: PublicGitFixtureV1;
  task: string;
  checkpointId: string;
  contextText: string;
  timeoutMs: number;
  observationInterception: HostedObservationInterception;
  onTrace?: (entry: HostedConditionTraceEntry) => Promise<void>;
}

export interface HostedConditionRunnerPort {
  runCondition(
    input: HostedConditionRunInputV1,
  ): Promise<HostedConditionRunOutputV1>;
}

export function renderHostedConditionPrompt(
  input: Pick<HostedConditionRunInputV1, 'task' | 'contextText'>,
): string {
  return [
    'Complete the coding task in the current repository.',
    'Use the supplied context as prior session state. Verify the result before finishing.',
    '',
    'TASK',
    input.task,
    '',
    'SESSION CONTEXT',
    input.contextText,
  ].join('\n');
}

async function runOne(
  runner: HostedConditionRunnerPort,
  input: HostedConditionRunInputV1,
): Promise<HostedConditionRunOutputV1> {
  return HostedConditionRunOutputV1Schema.parse(
    await runner.runCondition(input),
  );
}

export async function runHostedEvaluationPlan(
  input: HostedEvaluationPlanV1,
  runner: HostedConditionRunnerPort,
  estimator: TokenEstimator,
  options: {
    onRecord?: (record: HostedTraceRecordV1) => Promise<void>;
    persistArtifact?: (
      rawText: string,
    ) => Promise<{ uri: string; digest: string; byteLength: number }>;
    now?: () => Date;
  } = {},
): Promise<HostedEvaluationResultV1> {
  const { plan, reductions } = await prepareHostedEvaluationPlan(
    input,
    estimator,
  );
  const cases = [];
  const records: HostedTraceRecordV1[] = [];
  const record = async (
    kind: HostedTraceRecordV1['kind'],
    data: unknown,
    scope: { caseId?: string; condition?: 'raw' | 'managed' } = {},
  ) => {
    const entry = HostedTraceRecordV1Schema.parse({
      schemaVersion: 1,
      sequence: records.length + 1,
      createdAt: (options.now?.() ?? new Date()).toISOString(),
      kind,
      ...scope,
      data: JsonValueSchema.parse(data),
    });
    // Persist before advancing execution, including while a condition is streaming.
    await options.onRecord?.(entry);
    records.push(entry);
  };
  await record('plan', { plan, reductions });
  if (options.persistArtifact) {
    for (const evaluationCase of plan.experiment.cases) {
      for (const checkpoint of evaluationCase.checkpoints) {
        for (const observation of checkpoint.observations) {
          const artifact = await options.persistArtifact(observation.rawText);
          if (
            artifact.digest !== observation.contentHash ||
            artifact.uri !== `artifact://sha256/${observation.contentHash}` ||
            artifact.byteLength !==
              Buffer.byteLength(observation.rawText, 'utf8')
          )
            throw new Error(
              'Persisted hosted artifact does not match its observation.',
            );
          await record(
            'artifact',
            { eventId: observation.eventId, ...artifact },
            { caseId: evaluationCase.id },
          );
        }
      }
    }
  }

  for (const evaluationCase of plan.experiment.cases) {
    const checkpoint = evaluationCase.checkpoints[0]!;
    const contexts = prepareEvaluationCheckpointContexts(checkpoint, estimator);
    const shared = {
      harness: plan.harness,
      model: plan.model,
      fixture: plan.fixture,
      task: evaluationCase.task,
      checkpointId: checkpoint.id,
      timeoutMs: plan.timeoutMs,
      observationInterception: plan.observationInterception,
    } as const;
    const run = async (condition: 'raw' | 'managed', contextText: string) => {
      const scope = { caseId: evaluationCase.id, condition };
      const conditionInput = { ...shared, condition, contextText };
      await record('condition-start', conditionInput, scope);
      try {
        const output = await runOne(runner, {
          ...conditionInput,
          onTrace: (entry) => record(entry.kind, entry.data, scope),
        });
        await record('condition-result', output, scope);
        return output;
      } catch (error) {
        await record(
          'condition-error',
          { message: error instanceof Error ? error.message : String(error) },
          scope,
        );
        throw error;
      }
    };
    const raw = await run('raw', contexts.rawContextText);
    const managed = await run('managed', contexts.managedContextText);

    const rawEvidence = buildConditionEvidenceFromHarnessTrace({
      condition: 'raw',
      harness: plan.harness,
      model: plan.model,
      turns: [
        {
          checkpointId: checkpoint.id,
          workspaceRevision: raw.workspaceRevision,
          events: raw.events,
        },
      ],
      outcome: raw.outcome,
      latencyMs: raw.latencyMs,
      observationRecords: raw.observationRecords,
    });
    const managedEvidence = buildConditionEvidenceFromHarnessTrace({
      condition: 'managed',
      harness: plan.harness,
      model: plan.model,
      turns: [
        {
          checkpointId: checkpoint.id,
          workspaceRevision: managed.workspaceRevision,
          events: managed.events,
        },
      ],
      outcome: managed.outcome,
      latencyMs: managed.latencyMs,
      observationRecords: managed.observationRecords,
    });
    cases.push({ ...evaluationCase, rawEvidence, managedEvidence });
  }

  return HostedEvaluationResultV1Schema.parse({
    ...evaluateExperiment({ ...plan.experiment, cases }, estimator),
    hostedEvidence: records,
  });
}
