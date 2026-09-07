import { describe, expect, it } from 'vitest';

import { experimentMetrics, formatPercent, formatRatio } from './view-model';

const aggregate = {
  caseCount: 3,
  checkpointCount: 3,
  medianEstimatedContextReductionPercent: 35.57,
  measuredInputTokenCaseCount: 1,
  rawMeasuredInputTokens: 100,
  managedMeasuredInputTokens: 100,
  measuredInputTokenReductionPercent: 0,
  medianMeasuredInputTokenReductionPercent: 0,
  exactNextActionAgreements: 3,
  exactNextActionAgreementRate: 1,
  criticalFieldsPreserved: 3,
  criticalFieldsTotal: 3,
  criticalFieldRecall: 1,
  rawTaskSuccesses: 1,
  managedTaskSuccesses: 2,
  baselineOnlyFailures: 0,
  rawRepeatedActionCount: null,
  managedRepeatedActionCount: null,
  forcedCompactionCheckpoints: 0,
  forcedCompactionRecoveries: 0,
};

describe('dashboard view model', () => {
  it('formats reductions and ratios without inventing missing measurements', () => {
    expect(formatPercent(31.234)).toBe('31.2%');
    expect(formatRatio(0.9876)).toBe('98.8%');
    expect(formatPercent(null)).toBe('—');
    expect(formatRatio(null)).toBe('—');
  });

  it('shows both task success rates against total cases even when managed succeeds more often', () => {
    const metrics = experimentMetrics({ aggregate });

    expect(metrics).toContainEqual({
      label: 'Raw task success',
      value: '1/3 (33.3%)',
    });
    expect(metrics).toContainEqual({
      label: 'Managed task success',
      value: '2/3 (66.7%)',
    });
    expect(
      experimentMetrics({ aggregate: { ...aggregate, rawTaskSuccesses: 0 } }),
    ).toContainEqual({ label: 'Managed task success', value: '2/3 (66.7%)' });
  });

  it('distinguishes estimated context reduction from measured input usage and its coverage', () => {
    const metrics = experimentMetrics({ aggregate });

    expect(metrics).toContainEqual({
      label: 'Median estimated context reduction',
      value: '35.6%',
    });
    expect(metrics).toContainEqual({
      label: 'Measured input reduction (covered pairs)',
      value: '0%',
    });
    expect(metrics).toContainEqual({
      label: 'Cases with paired usage',
      value: '1/3',
    });
    expect(
      experimentMetrics({
        aggregate: {
          ...aggregate,
          measuredInputTokenReductionPercent: null,
          measuredInputTokenCaseCount: 0,
        },
      }),
    ).toContainEqual({
      label: 'Measured input reduction (covered pairs)',
      value: '—',
    });
  });
});
