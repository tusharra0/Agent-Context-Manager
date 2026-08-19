import { UsageError, stringOption } from './arguments.js';

export function requirePositionals(
  positionals: readonly string[],
  count: number,
  usage: string,
): void {
  if (positionals.length !== count) throw new UsageError(usage);
}

export function exactOption(
  options: ReadonlyMap<string, string | true>,
  name: string,
  expected: string,
): void {
  const value = stringOption(options, name, true);
  if (value !== expected) {
    throw new UsageError(`--${name} must be ${expected}.`);
  }
}

export function integerOption(
  options: ReadonlyMap<string, string | true>,
  name: string,
): number | undefined {
  const value = stringOption(options, name);
  if (value === undefined) return undefined;
  if (!/^-?\d+$/u.test(value)) {
    throw new UsageError(`--${name} must be an integer.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new UsageError(`--${name} is outside the safe integer range.`);
  }
  return parsed;
}
