import { LocalArtifactStore } from '@acm/event-store';

import { rejectUnknownOptions, stringOption } from '../arguments.js';
import type { CliIo, CliRuntime } from '../cli-context.js';
import { requirePositionals } from '../command-options.js';
import { resolveStorageConfiguration } from '../configuration.js';

export async function restoreCommand(
  positionals: readonly string[],
  options: ReadonlyMap<string, string | true>,
  runtime: CliRuntime,
  io: CliIo,
): Promise<number> {
  requirePositionals(
    positionals,
    1,
    'restore requires exactly one artifact URI.',
  );
  rejectUnknownOptions(options, ['output', 'data-dir']);
  const output = stringOption(options, 'output', true)!;
  const configuration = resolveStorageConfiguration(
    stringOption(options, 'data-dir'),
    runtime.environment,
  );
  await new LocalArtifactStore(configuration.artifactRoot).restore(
    positionals[0]!,
    output,
  );
  io.stdout(`Restored ${positionals[0]} to ${output}`);
  return 0;
}
