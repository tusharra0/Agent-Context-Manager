import {
  UsageError,
  parseArguments,
  rejectUnknownOptions,
} from './arguments.js';
import type { CliIo, CliRuntime } from './cli-context.js';
import { requirePositionals } from './command-options.js';
import { assembleCommand } from './commands/assemble-command.js';
import { doctorCommand } from './commands/doctor-command.js';
import { inspectCommand } from './commands/inspect-command.js';
import { reduceCommand } from './commands/reduce-command.js';
import { restoreCommand } from './commands/restore-command.js';
import { stateCommand } from './commands/state-command.js';

export type { CliIo, CliRuntime } from './cli-context.js';

const DEFAULT_IO: CliIo = {
  stdout: (message) => console.log(message),
  stderr: (message) => console.error(message),
};

const DEFAULT_RUNTIME: CliRuntime = {
  environment: process.env,
  now: () => new Date(),
};

export const HELP_TEXT = `Agent Context Manager

Usage:
  acm reduce <input> --type test-result --framework vitest --format json [options]
  acm reduce <input> --type file-read --path <logical-path> --path-kind <kind> --scope full [options]
  acm reduce <input> --type search-result --tool ripgrep --format json --query <query> --root <path> [options]
  acm reduce <input> --type build-result --tool typescript --format tsc-pretty-false --command <command> --working-directory <path> --exit-code <code> [options]
  acm restore <artifact-uri> --output <path> [--data-dir <path>]
  acm inspect event <event-id> [--data-dir <path>] [--json]
  acm inspect state --session <session-id> [--data-dir <path>] [--json]
  acm state apply <update.json> --session <session-id> [--data-dir <path>]
  acm state verify --session <session-id> [--data-dir <path>]
  acm assemble --session <session-id> --token-budget <tokens> [--output <path>] [--data-dir <path>]
  acm doctor

Reduce options:
  --session <id>       Append to an existing session
  --command <command>  Record the command that produced the report
  --exit-code <code>   Record the captured command's integer exit code
  --data-dir <path>    Override ACM_DATA_DIR and the default ~/.acm directory`;

export async function runCli(
  arguments_: readonly string[],
  io: CliIo = DEFAULT_IO,
  runtime: CliRuntime = DEFAULT_RUNTIME,
): Promise<number> {
  try {
    const parsed = parseArguments(arguments_);
    switch (parsed.command) {
      case 'reduce':
        return await reduceCommand(
          parsed.positionals,
          parsed.options,
          runtime,
          io,
        );
      case 'restore':
        return await restoreCommand(
          parsed.positionals,
          parsed.options,
          runtime,
          io,
        );
      case 'inspect':
        return inspectCommand(parsed.positionals, parsed.options, runtime, io);
      case 'state':
        return await stateCommand(
          parsed.positionals,
          parsed.options,
          runtime,
          io,
        );
      case 'assemble':
        return await assembleCommand(
          parsed.positionals,
          parsed.options,
          runtime,
          io,
        );
      case 'doctor':
        requirePositionals(
          parsed.positionals,
          0,
          'doctor accepts no positional arguments.',
        );
        rejectUnknownOptions(parsed.options, []);
        return doctorCommand(io);
      case 'help':
      case '--help':
      case '-h':
        io.stdout(HELP_TEXT);
        return 0;
      default:
        throw new UsageError(`Unknown command: ${parsed.command}`);
    }
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
