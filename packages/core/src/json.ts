import { z } from 'zod';

export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

function isJsonValue(
  value: unknown,
  ancestors: Set<object>,
): value is JsonValue {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return true;
  }
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object') return false;
  if (ancestors.has(value)) return false;

  const prototype = Object.getPrototypeOf(value) as unknown;
  if (
    !Array.isArray(value) &&
    prototype !== Object.prototype &&
    prototype !== null
  ) {
    return false;
  }
  if (Object.getOwnPropertySymbols(value).length > 0) return false;

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const propertyNames = Object.getOwnPropertyNames(value);
      if (
        propertyNames.length !== value.length + 1 ||
        !propertyNames.includes('length')
      ) {
        return false;
      }
      for (let index = 0; index < value.length; index += 1) {
        const key = String(index);
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor?.enumerable || !('value' in descriptor)) return false;
        if (!isJsonValue(descriptor.value, ancestors)) return false;
      }
      return true;
    }

    for (const key of Object.getOwnPropertyNames(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !('value' in descriptor)) return false;
      if (!isJsonValue(descriptor.value, ancestors)) return false;
    }
    return true;
  } finally {
    ancestors.delete(value);
  }
}

/**
 * Validates without rebuilding objects, preserving every valid JSON key,
 * including names such as "__proto__".
 */
export const JsonValueSchema: z.ZodType<JsonValue> = z.custom<JsonValue>(
  (value) => isJsonValue(value, new Set()),
  'Value must contain only finite, acyclic JSON data.',
);

export const CANONICAL_JSON_VERSION = 'acm-canonical-json@1' as const;

function compareUnicodeCodePoints(left: string, right: string): number {
  const leftPoints = Array.from(left, (character) => character.codePointAt(0)!);
  const rightPoints = Array.from(right, (character) =>
    character.codePointAt(0)!,
  );
  const sharedLength = Math.min(leftPoints.length, rightPoints.length);

  for (let index = 0; index < sharedLength; index += 1) {
    const difference = leftPoints[index]! - rightPoints[index]!;
    if (difference !== 0) return difference;
  }

  return leftPoints.length - rightPoints.length;
}

function serialize(value: JsonValue): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number')
    return Object.is(value, -0) ? '0' : String(value);
  if (Array.isArray(value)) return `[${value.map(serialize).join(',')}]`;

  return `{${Object.keys(value)
    .sort(compareUnicodeCodePoints)
    .map((key) => `${JSON.stringify(key)}:${serialize(value[key]!)}`)
    .join(',')}}`;
}

/** Serializes a runtime-validated JSON value using acm-canonical-json@1. */
export function canonicalJson(value: unknown): string {
  return serialize(JsonValueSchema.parse(value));
}

export function parseJson(text: string): JsonValue {
  return JsonValueSchema.parse(JSON.parse(text));
}
