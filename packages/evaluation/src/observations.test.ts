import { describe, expect, it } from 'vitest';

import type { ObservationRecordV1 } from '@acm/harness-port';

import { summarizeObservationRecords } from './observations.js';

function record(
  overrides: Partial<ObservationRecordV1> = {},
): ObservationRecordV1 {
  return {
    schemaVersion: 1,
    toolCallId: 'call-1',
    toolName: 'read',
    policy: 'reduced',
    mode: 'raw',
    reductionOutcome: 'no-reducer',
    rawByteLength: 400,
    rawTokenEstimate: 100,
    observedTokenEstimate: 100,
    tokenEstimatorId: 'utf8-bytes-div-4@1',
    diagnostics: [],
    ...overrides,
  };
}

describe('summarizeObservationRecords', () => {
  it('reports nothing when a run intercepted nothing', () => {
    expect(summarizeObservationRecords([])).toBeUndefined();
  });

  it('separates what was reduced from what a reduction could reach', () => {
    const summary = summarizeObservationRecords([
      // Applied: 100 raw tokens became 10.
      record({
        reductionOutcome: 'applied',
        mode: 'reduced',
        reductionUsable: true,
        reducedTokenEstimate: 10,
        observedTokenEstimate: 10,
      }),
      // Refused as unsafe: the raw observation stayed, and it says nothing
      // about what a reduction could have achieved.
      record({ reductionOutcome: 'unsafe', reductionUsable: false }),
      // No classifier claimed it.
      record({ reductionOutcome: 'no-reducer' }),
    ]);

    expect(summary).toEqual({
      observationCount: 3,
      tokenEstimatorId: 'utf8-bytes-div-4@1',
      rawTokenEstimate: 300,
      observedTokenEstimate: 210,
      reducibleRawTokenEstimate: 100,
      reducibleReducedTokenEstimate: 10,
      reducibleSharePercent: 33.333333,
      observedReductionPercent: 30,
      outcomes: {
        applied: 1,
        'not-requested': 0,
        'no-reducer': 1,
        unsafe: 1,
        'not-smaller': 0,
        failed: 0,
        'raw-evidence-unavailable': 0,
        'binary-output': 0,
      },
    });
  });

  it('measures the reducible share from a baseline that saved nothing', () => {
    const summary = summarizeObservationRecords([
      record({
        policy: 'raw',
        reductionOutcome: 'not-requested',
        reductionUsable: true,
        reducedTokenEstimate: 20,
      }),
      record({ policy: 'raw', reductionOutcome: 'no-reducer' }),
    ]);

    // The baseline substituted nothing, so it saved nothing...
    expect(summary?.observedReductionPercent).toBe(0);
    // ...but it still measured what the managed condition would have reached.
    expect(summary?.reducibleSharePercent).toBe(50);
    expect(summary?.reducibleReducedTokenEstimate).toBe(20);
  });

  it('refuses to add totals produced by different estimators', () => {
    expect(() =>
      summarizeObservationRecords([
        record(),
        record({ tokenEstimatorId: 'other-estimator@2' }),
      ]),
    ).toThrow(/mix token estimators/u);
  });

  it('leaves shares null when there were no raw tokens to reduce', () => {
    const summary = summarizeObservationRecords([
      record({ rawTokenEstimate: 0, observedTokenEstimate: 0 }),
    ]);

    expect(summary?.reducibleSharePercent).toBeNull();
    expect(summary?.observedReductionPercent).toBeNull();
  });
});
