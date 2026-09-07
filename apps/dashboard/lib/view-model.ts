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

export function experimentMetrics(
  summary: Pick<SanitizedExperimentSummaryV1, 'aggregate'>,
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
