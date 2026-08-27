import type { SanitizedExperimentSummaryV1 } from '@acm/hosted-evaluation';

export function formatPercent(value: number | null): string {
  return value === null ? '—' : `${Math.round(value * 10) / 10}%`;
}

export function formatRatio(value: number | null): string {
  return value === null ? '—' : `${Math.round(value * 1000) / 10}%`;
}

export function experimentMetrics(summary: SanitizedExperimentSummaryV1) {
  return [
    {
      label: 'Median input reduction',
      value: formatPercent(summary.aggregate.medianTokenReductionPercent),
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
      label: 'Managed task success',
      value: `${summary.aggregate.managedTaskSuccesses}/${summary.aggregate.rawTaskSuccesses}`,
    },
  ];
}
