import { TextDecoder } from 'node:util';

/** The longest UTF-8 encoding of a single code point. */
const MAX_UTF8_SEQUENCE_BYTES = 4;

export function decodeStrictUtf8(bytes: Uint8Array): string | undefined {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

export type BoundedText = {
  readonly text: string;
  readonly truncated: boolean;
};

/**
 * Decodes at most `maxBytes` of an observation as UTF-8.
 *
 * Only the shown prefix is validated. Decoding a multi-gigabyte capture twice
 * to prove the tail is text would cost more than the bound saves, and a prefix
 * that is not decodable is enough to treat the observation as binary.
 *
 * Returns `undefined` when the prefix is not valid UTF-8, which the caller must
 * treat as a binary observation rather than as empty text.
 */
export function decodeBoundedUtf8(
  bytes: Uint8Array,
  maxBytes: number,
): BoundedText | undefined {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < MAX_UTF8_SEQUENCE_BYTES) {
    throw new RangeError(
      `maxBytes must be a safe integer of at least ${MAX_UTF8_SEQUENCE_BYTES}.`,
    );
  }
  if (bytes.byteLength <= maxBytes) {
    const text = decodeStrictUtf8(bytes);
    return text === undefined ? undefined : { text, truncated: false };
  }
  // Back off to the nearest code-point boundary at or below the bound.
  for (let end = maxBytes; end > maxBytes - MAX_UTF8_SEQUENCE_BYTES; end -= 1) {
    const text = decodeStrictUtf8(bytes.subarray(0, end));
    if (text !== undefined) return { text, truncated: true };
  }
  return undefined;
}

/**
 * Appends the notice that makes a bounded observation honest: the agent must be
 * able to tell that output was withheld, and where the rest of it lives.
 */
export function withTruncationNotice(
  text: string,
  totalByteLength: number,
  shownByteLength: number,
  rawArtifactUri: string | undefined,
): string {
  const withheld = totalByteLength - shownByteLength;
  const location =
    rawArtifactUri === undefined
      ? 'the full output could not be stored'
      : `full output at ${rawArtifactUri}`;
  return `${text}
[acm: ${withheld} of ${totalByteLength} bytes withheld; ${location}]`;
}

export function binaryReferenceText(
  byteLength: number,
  rawArtifactUri: string | undefined,
): string {
  const location =
    rawArtifactUri === undefined
      ? 'it could not be stored and is unavailable'
      : `full output at ${rawArtifactUri}`;
  return `[acm: ${byteLength} bytes of non-UTF-8 output; ${location}]`;
}
