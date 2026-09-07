import { z } from 'zod';

import {
  ObservationReductionOutcomeSchema,
  type ObservationRecordV1,
} from '@acm/harness-port';

import { round } from './numbers.js';

/** How many observations ended at each reduction outcome. */
export const ObservationOutcomeCountsV1Schema = z.record(
  ObservationReductionOutcomeSchema,
  z.number().int().nonnegative(),
);

/**
 * What per-step interception did to one condition's observations.
 *
 * Counts each observation once. How many times the transcript then carried it
 * is a property of the run, not of the observation, and per-request usage
 * already reports that without a model of its own.
 */
export const ObservationSummaryV1Schema = z
  .object({
    observationCount: z.number().int().positive(),
    tokenEstimatorId: z.string().min(1),
    /** Tokens the raw observations would have contributed. */
    rawTokenEstimate: z.number().int().nonnegative(),
    /** Tokens that actually entered the transcript. */
    observedTokenEstimate: z.number().int().nonnegative(),
    /** Raw tokens of the observations whose reduction passed every gate. */
    reducibleRawTokenEstimate: z.number().int().nonnegative(),
    /** What those same observations would cost reduced. */
    reducibleReducedTokenEstimate: z.number().int().nonnegative(),
    /**
     * Share of raw observation tokens a reduction was able to reach.
     *
     * Recorded under both policies, because the baseline computes its
     * reductions without substituting them. It is what makes a small measured
     * saving interpretable: a reduction can only ever act on this share.
     */
    reducibleSharePercent: z.number().nullable(),
    /** What the condition actually saved on its observations. */
    observedReductionPercent: z.number().nullable(),
    outcomes: ObservationOutcomeCountsV1Schema,
  })
  .strict();

export type ObservationOutcomeCountsV1 = z.infer<
  typeof ObservationOutcomeCountsV1Schema
>;
export type ObservationSummaryV1 = z.infer<typeof ObservationSummaryV1Schema>;

function emptyOutcomeCounts(): ObservationOutcomeCountsV1 {
  return Object.fromEntries(
    ObservationReductionOutcomeSchema.options.map((outcome) => [outcome, 0]),
  ) as ObservationOutcomeCountsV1;
}

function percent(from: number, to: number): number | null {
  return from === 0 ? null : round(((from - to) / from) * 100);
}

/**
 * Folds interception records into one condition's summary.
 *
 * Returns `undefined` when a run recorded no observations, so a condition that
 * never intercepted anything reports nothing rather than a row of zeros that
 * would read as a measured absence of saving.
 */
export function summarizeObservationRecords(
  records: readonly ObservationRecordV1[],
): ObservationSummaryV1 | undefined {
  if (records.length === 0) return undefined;

  const estimators = new Set(records.map((record) => record.tokenEstimatorId));
  if (estimators.size > 1) {
    throw new TypeError(
      `Observation records mix token estimators: ${[...estimators].sort().join(', ')}.`,
    );
  }

  const outcomes = emptyOutcomeCounts();
  let rawTokenEstimate = 0;
  let observedTokenEstimate = 0;
  let reducibleRawTokenEstimate = 0;
  let reducibleReducedTokenEstimate = 0;

  for (const record of records) {
    outcomes[record.reductionOutcome] += 1;
    rawTokenEstimate += record.rawTokenEstimate;
    observedTokenEstimate += record.observedTokenEstimate;
    // Only a reduction that passed every gate describes reducible work. One
    // that was refused says nothing about what a reduction could achieve.
    if (record.reductionUsable === true) {
      reducibleRawTokenEstimate += record.rawTokenEstimate;
      reducibleReducedTokenEstimate += record.reducedTokenEstimate ?? 0;
    }
  }

  return ObservationSummaryV1Schema.parse({
    observationCount: records.length,
    tokenEstimatorId: records[0]!.tokenEstimatorId,
    rawTokenEstimate,
    observedTokenEstimate,
    reducibleRawTokenEstimate,
    reducibleReducedTokenEstimate,
    reducibleSharePercent:
      rawTokenEstimate === 0
        ? null
        : round((reducibleRawTokenEstimate / rawTokenEstimate) * 100),
    observedReductionPercent: percent(rawTokenEstimate, observedTokenEstimate),
    outcomes,
  });
}
