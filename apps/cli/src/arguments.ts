export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

export type ParsedArguments = {
  command: string;
  positionals: string[];
  options: ReadonlyMap<string, string | true>;
};

export function parseArguments(arguments_: readonly string[]): ParsedArguments {
  const [command = 'help', ...tokens] = arguments_;
  const positionals: string[] = [];
  const options = new Map<string, string | true>();

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (!token.startsWith('--')) {
      positionals.push(token);
      continue;
    }
    if (token === '--') {
      positionals.push(...tokens.slice(index + 1));
      break;
    }
    const name = token.slice(2);
    if (!name || name.includes('=')) {
      throw new UsageError(`Unsupported option syntax: ${token}`);
    }
    if (options.has(name))
      throw new UsageError(`Option may be specified only once: --${name}`);
    if (name === 'json') {
      options.set(name, true);
      continue;
    }
    const value = tokens[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new UsageError(`Option requires a value: --${name}`);
    }
    options.set(name, value);
    index += 1;
  }

  return { command, positionals, options };
}

export function rejectUnknownOptions(
  options: ReadonlyMap<string, string | true>,
  allowed: readonly string[],
): void {
  const allowedSet = new Set(allowed);
  for (const name of options.keys()) {
    if (!allowedSet.has(name))
      throw new UsageError(`Unknown option: --${name}`);
  }
}

export function stringOption(
  options: ReadonlyMap<string, string | true>,
  name: string,
  required = false,
): string | undefined {
  const value = options.get(name);
  if (value === undefined) {
    if (required) throw new UsageError(`Missing required option: --${name}`);
    return undefined;
  }
  if (value === true)
    throw new UsageError(`Option requires a value: --${name}`);
  return value;
}
