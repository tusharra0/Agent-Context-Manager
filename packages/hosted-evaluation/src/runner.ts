import type { TokenEstimator } from '@acm/context-assembler';
import {
  buildConditionEvidenceFromHarnessTrace,
  evaluateExperiment,
  prepareEvaluationCheckpointContexts,
  type EvaluationResultV1,
} from '@acm/evaluation';

import {
  HostedConditionRunOutputV1Schema,
  HostedEvaluationPlanV1Schema,
  type HostedConditionRunOutputV1,
  type HostedEvaluationPlanV1,
  type PublicGitFixtureV1,
} from './schemas.js';

export interface HostedConditionRunInputV1 {
  condition: 'raw' | 'managed';
  harness: HostedEvaluationPlanV1['harness'];
  model: string;
  fixture: PublicGitFixtureV1;
  task: string;
  checkpointId: string;
  contextText: string;
  timeoutMs: number;
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
): Promise<EvaluationResultV1> {
  const plan = HostedEvaluationPlanV1Schema.parse(input);
  const cases = [];

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
    } as const;
    const raw = await runOne(runner, {
      ...shared,
      condition: 'raw',
      contextText: contexts.rawContextText,
    });
    const managed = await runOne(runner, {
      ...shared,
      condition: 'managed',
      contextText: contexts.managedContextText,
    });

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
    });
    cases.push({ ...evaluationCase, rawEvidence, managedEvidence });
  }

  return evaluateExperiment({ ...plan.experiment, cases }, estimator);
}
