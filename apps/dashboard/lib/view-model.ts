import type { SanitizedExperimentSummaryV1 } from '@acm/hosted-evaluation';

export function formatPercent(value: number | null): string {
  return value === null ? '—' : `${Math.round(value * 10) / 10}%`;
}

export function formatRatio(value: number | null): string {
  return value === null ? '—' : `${Math.round(value * 1000) / 10}%`;
}

function taskSuccess(successes: number, cases: number): string {
  return cases === 0
    ? '—'
    : `${successes}/${cases} (${formatRatio(successes / cases)})`;
}

/**
 * Describes what per-step interception was allowed to touch.
 *
 * A measured input reduction is only interpretable next to it: the reduction
 * acts on observations, and everything else in a request — the harness system
 * prompt, its tool schemas, the conversation the harness owns — is out of
 * reach. A small saving over a small reducible share is a different result
 * from a small saving over a large one.
 */
export function observationMetrics(
  summary: Pick<
    SanitizedExperimentSummaryV1,
    'aggregate' | 'observationInterception'
  >,
) {
  if (summary.observationInterception !== 'per-step') return [];
  return [
    {
      label: 'Observation token reduction',
      value: formatPercent(summary.aggregate.observationTokenReductionPercent),
    },
    {
      label: 'Reducible share of observations',
      value: formatPercent(summary.aggregate.reducibleSharePercent),
    },
    {
      label: 'Cases with paired observations',
      value: `${summary.aggregate.observationCaseCount}/${summary.aggregate.caseCount}`,
    },
  ];
}

export function experimentMetrics(
  summary: Pick<
    SanitizedExperimentSummaryV1,
    'aggregate' | 'observationInterception'
  >,
) {
  return [
    {
      label: 'Median estimated context reduction',
      value: formatPercent(
        summary.aggregate.medianEstimatedContextReductionPercent,
      ),
    },
    {
      label: 'Measured input reduction (covered pairs)',
      value: formatPercent(
        summary.aggregate.measuredInputTokenReductionPercent,
      ),
    },
    {
      label: 'Cases with paired usage',
      value: `${summary.aggregate.measuredInputTokenCaseCount}/${summary.aggregate.caseCount}`,
    },
    ...observationMetrics(summary),
    {
      label: 'Next-action agreement',
      value: formatRatio(summary.aggregate.exactNextActionAgreementRate),
    },
    {
      label: 'Critical-field recall',
      value: formatRatio(summary.aggregate.criticalFieldRecall),
    },
    {
      label: 'Raw task success',
      value: taskSuccess(
        summary.aggregate.rawTaskSuccesses,
        summary.aggregate.caseCount,
      ),
    },
    {
      label: 'Managed task success',
      value: taskSuccess(
        summary.aggregate.managedTaskSuccesses,
        summary.aggregate.caseCount,
      ),
    },
  ];
}
