import { describe, expect, it } from 'vitest';

import {
  EvaluationResultV1Schema,
  type EvaluationResultV1,
} from '@acm/evaluation';

import {
  sanitizeEvaluationResult,
  upsertSanitizedExperiment,
} from './sanitization.js';
import { SanitizedDashboardDatasetV1Schema } from './schemas.js';

function result(experimentId = 'hosted-result'): EvaluationResultV1 {
  return EvaluationResultV1Schema.parse({
    schemaVersion: 1,
    experimentId,
    repositoryFixture: { id: 'fixture', revision: 'a'.repeat(40) },
    policyId: 'policy@1',
    tokenEstimatorId: 'estimator@1',
    status: 'fail',
    cases: [],
    aggregate: {
      caseCount: 1,
      checkpointCount: 1,
      medianEstimatedContextReductionPercent: 32,
      measuredInputTokenCaseCount: 1,
      rawMeasuredInputTokens: 100,
      managedMeasuredInputTokens: 70,
      measuredInputTokenReductionPercent: 30,
      medianMeasuredInputTokenReductionPercent: 30,
      exactNextActionAgreements: 0,
      exactNextActionAgreementRate: 0,
      criticalFieldsPreserved: 4,
      criticalFieldsTotal: 4,
      criticalFieldRecall: 1,
      rawTaskSuccesses: 1,
      managedTaskSuccesses: 0,
      baselineOnlyFailures: 1,
      rawRepeatedActionCount: 0,
      managedRepeatedActionCount: 1,
      observationCaseCount: 1,
      rawObservationTokens: 1000,
      managedObservationTokens: 400,
      observationTokenReductionPercent: 60,
      medianObservationTokenReductionPercent: 60,
      reducibleSharePercent: 75,
      forcedCompactionCheckpoints: 0,
      forcedCompactionRecoveries: 0,
    },
    policyFailures: [
      {
        kind: 'next-action-divergence',
        caseId: 'private-case',
        message: 'PRIVATE_FAILURE_TEXT',
        sourceEventIds: [],
        details: { privatePrompt: 'DO_NOT_PUBLISH' },
      },
    ],
  });
}

describe('hosted result sanitization', () => {
  it('retains only aggregate allow-listed data', () => {
    const summary = sanitizeEvaluationResult(
      result(),
      { harness: 'codex', model: 'openai/gpt-5.4' },
      new Date('2026-08-27T12:00:00.000Z'),
    );
    const serialized = JSON.stringify(summary);

    expect(summary.policyFailureCounts['next-action-divergence']).toBe(1);
    expect(summary.aggregate.medianEstimatedContextReductionPercent).toBe(32);
    expect(summary.aggregate.measuredInputTokenReductionPercent).toBe(30);
    expect(serialized).not.toContain('PRIVATE_FAILURE_TEXT');
    expect(serialized).not.toContain('DO_NOT_PUBLISH');
    expect(serialized).not.toContain('private-case');
  });

  it('replaces matching experiment IDs and orders newest first', () => {
    const empty = SanitizedDashboardDatasetV1Schema.parse({
      schemaVersion: 1,
      generatedAt: '2026-08-27T10:00:00.000Z',
      experiments: [],
    });
    const older = sanitizeEvaluationResult(
      result('one'),
      { harness: 'codex', model: 'openai/gpt-5.4' },
      new Date('2026-08-27T11:00:00.000Z'),
    );
    const newer = sanitizeEvaluationResult(
      result('two'),
      { harness: 'claude-code', model: 'anthropic/claude-sonnet-4.6' },
      new Date('2026-08-27T12:00:00.000Z'),
    );
    const first = upsertSanitizedExperiment(
      upsertSanitizedExperiment(
        empty,
        older,
        new Date('2026-08-27T11:00:00.000Z'),
      ),
      newer,
      new Date('2026-08-27T12:00:00.000Z'),
    );
    const replaced = upsertSanitizedExperiment(
      first,
      { ...older, status: 'pass' },
      new Date('2026-08-27T13:00:00.000Z'),
    );

    expect(replaced.experiments.map((item) => item.experimentId)).toEqual([
      'two',
      'one',
    ]);
    expect(
      replaced.experiments.find((item) => item.experimentId === 'one')?.status,
    ).toBe('pass');
  });
});
