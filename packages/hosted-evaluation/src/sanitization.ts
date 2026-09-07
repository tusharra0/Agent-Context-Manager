import type { EvaluationResultV1 } from '@acm/evaluation';

import {
  SanitizedDashboardDatasetV1Schema,
  SanitizedExperimentSummaryV1Schema,
  type HostedEvaluationPlanV1,
  type SanitizedDashboardDatasetV1,
  type SanitizedExperimentSummaryV1,
} from './schemas.js';

const FAILURE_KINDS = [
  'missing-critical-field',
  'next-action-divergence',
  'baseline-success-managed-failure',
  'repeated-work-increase',
  'mandatory-overflow',
] as const;

export function sanitizeEvaluationResult(
  result: EvaluationResultV1,
  plan: Pick<HostedEvaluationPlanV1, 'harness' | 'model'> &
    Partial<
      Pick<HostedEvaluationPlanV1, 'contextSource' | 'observationInterception'>
    >,
  createdAt: Date,
): SanitizedExperimentSummaryV1 {
  const counts = Object.fromEntries(
    FAILURE_KINDS.map((kind) => [
      kind,
      result.policyFailures.filter((failure) => failure.kind === kind).length,
    ]),
  );
  return SanitizedExperimentSummaryV1Schema.parse({
    schemaVersion: 1,
    experimentId: result.experimentId,
    createdAt: createdAt.toISOString(),
    repositoryFixture: result.repositoryFixture,
    policyId: result.policyId,
    tokenEstimatorId: result.tokenEstimatorId,
    status: result.status,
    harness: plan.harness,
    model: plan.model,
    contextSource: plan.contextSource ?? 'recorded-candidates',
    observationInterception: plan.observationInterception ?? 'off',
    aggregate: result.aggregate,
    policyFailureCounts: counts,
  });
}

export function upsertSanitizedExperiment(
  datasetInput: SanitizedDashboardDatasetV1,
  summaryInput: SanitizedExperimentSummaryV1,
  generatedAt: Date,
): SanitizedDashboardDatasetV1 {
  const dataset = SanitizedDashboardDatasetV1Schema.parse(datasetInput);
  const summary = SanitizedExperimentSummaryV1Schema.parse(summaryInput);
  const experiments = dataset.experiments
    .filter((item) => item.experimentId !== summary.experimentId)
    .concat(summary)
    .sort(
      (left, right) =>
        right.createdAt.localeCompare(left.createdAt) ||
        left.experimentId.localeCompare(right.experimentId),
    );
  return SanitizedDashboardDatasetV1Schema.parse({
    schemaVersion: 1,
    generatedAt: generatedAt.toISOString(),
    experiments,
  });
}
