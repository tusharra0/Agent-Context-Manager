export const TOKEN_ESTIMATOR_ID = 'utf8-bytes-div-4@1' as const;

export function estimateTokensFromByteLength(byteLength: number): number {
  if (!Number.isSafeInteger(byteLength) || byteLength < 0) {
    throw new RangeError('Byte length must be a nonnegative safe integer.');
  }
  return Math.ceil(byteLength / 4);
}

export function estimateTokens(text: string): number {
  return estimateTokensFromByteLength(Buffer.byteLength(text, 'utf8'));
}
