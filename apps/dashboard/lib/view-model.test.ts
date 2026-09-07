import { describe, expect, it } from 'vitest';

import {
  experimentMetrics,
  formatPercent,
  formatRatio,
  observationMetrics,
} from './view-model';

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
  observationCaseCount: 0,
  rawObservationTokens: null,
  managedObservationTokens: null,
  observationTokenReductionPercent: null,
  medianObservationTokenReductionPercent: null,
  reducibleSharePercent: null,
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
    const metrics = experimentMetrics({
      aggregate,
      observationInterception: 'off',
    });

    expect(metrics).toContainEqual({
      label: 'Raw task success',
      value: '1/3 (33.3%)',
    });
    expect(metrics).toContainEqual({
      label: 'Managed task success',
      value: '2/3 (66.7%)',
    });
    expect(
      experimentMetrics({
        aggregate: { ...aggregate, rawTaskSuccesses: 0 },
        observationInterception: 'off',
      }),
    ).toContainEqual({ label: 'Managed task success', value: '2/3 (66.7%)' });
  });

  it('distinguishes estimated context reduction from measured input usage and its coverage', () => {
    const metrics = experimentMetrics({
      aggregate,
      observationInterception: 'off',
    });

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
        observationInterception: 'off',
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

describe('observation metrics', () => {
  const interceptedAggregate = {
    ...aggregate,
    observationCaseCount: 2,
    rawObservationTokens: 1000,
    managedObservationTokens: 400,
    observationTokenReductionPercent: 60,
    medianObservationTokenReductionPercent: 60,
    reducibleSharePercent: 75,
  };

  it('stays silent for a run that reduced only its checkpoint', () => {
    expect(
      observationMetrics({
        aggregate: interceptedAggregate,
        observationInterception: 'off',
      }),
    ).toEqual([]);
  });

  it('publishes the saving next to the share a reduction could reach', () => {
    expect(
      observationMetrics({
        aggregate: interceptedAggregate,
        observationInterception: 'per-step',
      }),
    ).toEqual([
      { label: 'Observation token reduction', value: '60%' },
      { label: 'Reducible share of observations', value: '75%' },
      { label: 'Cases with paired observations', value: '2/3' },
    ]);
  });

  it('shows an unmeasured share as missing rather than as zero', () => {
    expect(
      observationMetrics({
        aggregate: { ...aggregate, observationCaseCount: 0 },
        observationInterception: 'per-step',
      }),
    ).toContainEqual({
      label: 'Reducible share of observations',
      value: '—',
    });
  });

  it('includes the observation rows in the published metric list', () => {
    const labels = experimentMetrics({
      aggregate: interceptedAggregate,
      observationInterception: 'per-step',
    }).map((metric) => metric.label);
    expect(labels).toContain('Observation token reduction');
    expect(
      experimentMetrics({
        aggregate: interceptedAggregate,
        observationInterception: 'off',
      }).map((metric) => metric.label),
    ).not.toContain('Observation token reduction');
  });
});
