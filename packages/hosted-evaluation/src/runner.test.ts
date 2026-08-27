import { describe, expect, it } from 'vitest';

import { createSessionId } from '@acm/core';
import {
  EvaluationExperimentV1Schema,
  type EvaluationExperimentV1,
} from '@acm/evaluation';
import type { HarnessEventV1 } from '@acm/harness-port';

import experimentFixture from '../../evaluation/test/fixtures/v1/passing-experiment.json' with { type: 'json' };

import {
  type HostedConditionRunInputV1,
  type HostedConditionRunnerPort,
  runHostedEvaluationPlan,
} from './runner.js';
import { HostedEvaluationPlanV1Schema } from './schemas.js';

const REVISION = 'a'.repeat(40);
const SESSION_ID = createSessionId(
  () => '00000000-0000-4000-8000-000000000010',
);

function experiment(): EvaluationExperimentV1 {
  const parsed = EvaluationExperimentV1Schema.parse(experimentFixture);
  return {
    ...parsed,
    repositoryFixture: { ...parsed.repositoryFixture, revision: REVISION },
  };
}

function events(): HarnessEventV1[] {
  const base = {
    schemaVersion: 1 as const,
    sessionId: SESSION_ID,
    harness: 'codex' as const,
    createdAt: '2026-08-27T12:00:00.000Z',
  };
  return [
    {
      ...base,
      sequence: 1,
      kind: 'tool-call',
      toolCallId: 'call-1',
      toolName: 'bash',
      input: { command: 'pnpm check' },
    },
    {
      ...base,
      sequence: 2,
      kind: 'usage',
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
    },
    {
      ...base,
      sequence: 3,
      kind: 'turn-completed',
      finishReason: 'stop',
    },
  ];
}

function plan() {
  return HostedEvaluationPlanV1Schema.parse({
    schemaVersion: 1,
    experiment: experiment(),
    fixture: {
      id: 'synthetic-typescript-project',
      repositoryUrl: 'https://github.com/example/acm-fixture.git',
      revision: REVISION,
      setupCommands: ['pnpm install --frozen-lockfile'],
      verificationCommands: [{ id: 'tests', command: 'pnpm check' }],
    },
    harness: 'codex',
    model: 'openai/gpt-5.4',
    timeoutMs: 60_000,
  });
}

describe('runHostedEvaluationPlan', () => {
  it('runs isolated paired conditions with only their context differing', async () => {
    const inputs: HostedConditionRunInputV1[] = [];
    const runner: HostedConditionRunnerPort = {
      async runCondition(input) {
        inputs.push(input);
        return {
          events: events(),
          workspaceRevision: `workspace-${input.condition}`,
          outcome: {
            success: true,
            assertions: [{ id: 'tests', passed: true }],
          },
          latencyMs: input.condition === 'raw' ? 100 : 80,
        };
      },
    };
    const result = await runHostedEvaluationPlan(plan(), runner, {
      id: 'utf8-bytes-div-4@1',
      estimate: (text) => Math.ceil(Buffer.byteLength(text, 'utf8') / 4),
    });

    expect(inputs).toHaveLength(2);
    expect(inputs.map((input) => input.condition)).toEqual(['raw', 'managed']);
    expect(inputs[0]).toMatchObject({
      task: inputs[1]?.task,
      fixture: inputs[1]?.fixture,
      checkpointId: inputs[1]?.checkpointId,
      harness: inputs[1]?.harness,
      model: inputs[1]?.model,
    });
    expect(inputs[0]?.contextText).not.toBe(inputs[1]?.contextText);
    expect(result.status).toBe('pass');
    expect(result.cases[0]?.rawProducer.kind).toBe('recorded-harness');
    expect(result.cases[0]?.managedMeasurements).toMatchObject({
      inputTokens: 100,
      outputTokens: 20,
    });
  });

  it('rejects fixture drift and multi-checkpoint hosted cases', () => {
    const input = plan();
    expect(() =>
      HostedEvaluationPlanV1Schema.parse({
        ...input,
        fixture: { ...input.fixture, revision: 'b'.repeat(40) },
      }),
    ).toThrow('revisions must match');
    expect(() =>
      HostedEvaluationPlanV1Schema.parse({
        ...input,
        experiment: {
          ...input.experiment,
          cases: [
            {
              ...input.experiment.cases[0]!,
              checkpoints: [
                input.experiment.cases[0]!.checkpoints[0]!,
                input.experiment.cases[0]!.checkpoints[0]!,
              ],
            },
          ],
        },
      }),
    ).toThrow('exactly one checkpoint');
  });
});
