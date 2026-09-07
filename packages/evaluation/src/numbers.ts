/**
 * Rounds derived ratios and percentages to six decimal places so repeated runs
 * of the same evidence serialize identically. Counts are never rounded.
 */
export function round(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
