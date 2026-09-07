import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  EvaluationExperimentV1Schema,
  type EvaluationExperimentV1,
} from '@acm/evaluation';

import experimentFixture from '../../evaluation/test/fixtures/v1/passing-experiment.json' with { type: 'json' };

import { prepareHostedEvaluationPlan } from './preparation.js';
import { HostedEvaluationPlanV1Schema } from './schemas.js';

const ESTIMATOR = {
  id: 'utf8-bytes-div-4@1',
  estimate: (text: string) => Math.ceil(Buffer.byteLength(text, 'utf8') / 4),
};

function typedPlan() {
  const experiment = EvaluationExperimentV1Schema.parse(
    structuredClone(experimentFixture),
  ) as EvaluationExperimentV1;
  const revision = 'a'.repeat(40);
  experiment.repositoryFixture.revision = revision;
  const observation = experiment.cases[0]!.checkpoints[0]!.observations[0]!;
  observation.managedCandidate.text = 'FORGED_MANAGED_CONTEXT';
  return HostedEvaluationPlanV1Schema.parse({
    schemaVersion: 1,
    experiment,
    fixture: {
      id: experiment.repositoryFixture.id,
      repositoryUrl: 'https://github.com/example/fixture.git',
      revision,
      setupCommands: [],
      verificationCommands: [{ id: 'tests', command: 'pnpm test' }],
    },
    harness: 'codex',
    model: 'test/model',
    contextSource: 'typed-reducers',
    reductionInputs: [
      {
        caseId: experiment.cases[0]!.id,
        eventId: observation.eventId,
        kind: 'build_result',
        command: 'pnpm exec tsc --noEmit --pretty false',
        workingDirectory: '.',
        exitCode: 1,
      },
    ],
  });
}

describe('prepareHostedEvaluationPlan', () => {
  it('derives managed context from typed raw evidence and restores unsafe parses', async () => {
    const prepared = await prepareHostedEvaluationPlan(typedPlan(), ESTIMATOR);
    const observation =
      prepared.plan.experiment.cases[0]!.checkpoints[0]!.observations[0]!;

    expect(observation.managedCandidate.text).not.toContain(
      'FORGED_MANAGED_CONTEXT',
    );
    expect(observation.managedCandidate.text).toContain('restored-observation');
    expect(observation.managedCandidate.text).toContain(observation.rawText);
    expect(prepared.reductions[0]?.reduction.reducerId).toBe(
      'build-result/tsc-pretty-false',
    );
  });

  it('rejects raw evidence whose declared digest does not match', async () => {
    const plan = typedPlan();
    plan.experiment.cases[0]!.checkpoints[0]!.observations[0]!.contentHash =
      createHash('sha256').update('different').digest('hex');

    await expect(prepareHostedEvaluationPlan(plan, ESTIMATOR)).rejects.toThrow(
      'Raw observation hash mismatch',
    );
  });
});
