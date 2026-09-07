import { tool, type Tool, type ToolSet } from 'ai';
import { z } from 'zod';

import { JsonValueSchema, type JsonValue } from '@acm/core';
import type {
  InterceptedObservation,
  ObservationInterceptor,
} from '@acm/harness-port';

/**
 * The part of a sandbox session the observation tools need.
 *
 * Declared structurally so a real `Experimental_SandboxSession` satisfies it
 * and a test can supply a fake without a sandbox. Nothing here can stop the
 * sandbox or change its network policy.
 */
export interface ObservationToolSandbox {
  readBinaryFile(options: {
    path: string;
    abortSignal?: AbortSignal;
  }): PromiseLike<Uint8Array | null>;
  readTextFile(options: {
    path: string;
    startLine?: number;
    endLine?: number;
    abortSignal?: AbortSignal;
  }): PromiseLike<string | null>;
  run(options: {
    command: string;
    workingDirectory?: string;
    abortSignal?: AbortSignal;
  }): PromiseLike<{ exitCode: number; stdout: string; stderr: string }>;
}

export type ObservationToolName = 'read' | 'grep' | 'bash';

/** Overrides that make sense for each harness's own builtin tool set. */
export const OBSERVATION_TOOLS_BY_HARNESS = {
  'claude-code': ['read', 'grep', 'bash'],
  codex: ['bash'],
} as const satisfies Record<string, readonly ObservationToolName[]>;

/** The live sandbox a tool call runs against. */
export interface ObservationToolTarget {
  readonly session: ObservationToolSandbox;
  /**
   * Absolute working directory for this session, as reported by the harness.
   * Taken from the session rather than configuration so a command can never
   * run outside the workspace the agent believes it is in.
   */
  readonly workingDirectory: string;
}

export interface ObservationToolOptions {
  readonly interceptor: ObservationInterceptor;
  /**
   * Resolves the live sandbox. Tools are constructed before a session exists,
   * so the target is looked up per call rather than captured.
   */
  readonly target: () => ObservationToolTarget | undefined;
  /** Which builtins to override. Defaults to every supported tool. */
  readonly tools?: readonly ObservationToolName[];
}

export class ObservationToolSandboxUnavailableError extends Error {
  constructor() {
    super('No sandbox session is attached to the observation tools.');
    this.name = 'ObservationToolSandboxUnavailableError';
  }
}

/**
 * Holds the sandbox session for the tools that need it.
 *
 * `HarnessAgent` surfaces a session through `sandboxConfig.onSession`, which
 * runs after the tool set is built, so the session arrives later than the tools
 * that use it.
 */
export class ObservationToolSession {
  private target: ObservationToolTarget | undefined;

  attach(session: ObservationToolSandbox, workingDirectory: string): void {
    if (workingDirectory.length === 0) {
      throw new TypeError(
        'An observation tool session needs a working directory.',
      );
    }
    this.target = { session, workingDirectory };
  }

  detach(): void {
    this.target = undefined;
  }

  get current(): ObservationToolTarget | undefined {
    return this.target;
  }

  resolve = (): ObservationToolTarget | undefined => this.target;
}

function quoteForShell(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function bytesOfText(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, 'utf8'));
}

/**
 * Records the tool input as JSON. Absent optional parameters are dropped: an
 * explicit `undefined` is not JSON, and a recorded argument list must be
 * exactly what could be replayed.
 */
function toJsonInput(value: Record<string, unknown>): JsonValue {
  return JsonValueSchema.parse(
    Object.fromEntries(
      Object.entries(value).filter(([, item]) => item !== undefined),
    ),
  );
}

/**
 * Joins a command's streams into the single observation the agent sees.
 *
 * Stdout is kept alone whenever stderr is empty. A reporter that writes clean
 * JSON to stdout therefore stays machine-readable and can be reduced; once a
 * command also writes to stderr, fidelity wins and the combined text is used
 * even though no parser will claim it.
 */
export function combineCommandStreams(stdout: string, stderr: string): string {
  return stderr.length === 0 ? stdout : `${stdout}\n[stderr]\n${stderr}`;
}

const READ_INPUT = z.object({
  file_path: z.string().min(1).describe('Path of the file to read.'),
  offset: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('1-based first line to read.'),
  limit: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('How many lines to read from the offset.'),
});

const GREP_INPUT = z.object({
  pattern: z.string().min(1).describe('Regular expression to search for.'),
  path: z
    .string()
    .min(1)
    .optional()
    .describe('File or directory to search. Defaults to the workspace root.'),
  glob: z
    .string()
    .min(1)
    .optional()
    .describe('Glob that limits which files are searched.'),
  caseInsensitive: z
    .boolean()
    .optional()
    .describe('Match without regard to case.'),
});

const BASH_INPUT = z.object({
  command: z.string().min(1).describe('Command to run in the workspace.'),
  description: z
    .string()
    .min(1)
    .optional()
    .describe('Short description of what the command does.'),
});

function requireTarget(options: ObservationToolOptions): ObservationToolTarget {
  const target = options.target();
  if (target === undefined) throw new ObservationToolSandboxUnavailableError();
  return target;
}

async function interceptText(
  options: ObservationToolOptions,
  toolCallId: string,
  toolName: string,
  input: JsonValue,
  bytes: Uint8Array,
  isError: boolean,
  exitCode: number | undefined,
  abortSignal: AbortSignal | undefined,
): Promise<InterceptedObservation> {
  return options.interceptor.intercept(
    { toolCallId, toolName, input },
    {
      bytes,
      isError,
      ...(exitCode === undefined ? {} : { exitCode }),
    },
    { ...(abortSignal === undefined ? {} : { abortSignal }) },
  );
}

function readTool(options: ObservationToolOptions): Tool {
  return tool({
    description:
      'Read a file from the workspace. Returns the file content exactly as stored.',
    inputSchema: READ_INPUT,
    async execute(input, { toolCallId, abortSignal }) {
      const { session } = requireTarget(options);
      const ranged = input.offset !== undefined || input.limit !== undefined;
      const startLine = input.offset ?? 1;
      const bytes = ranged
        ? await session.readTextFile({
            path: input.file_path,
            startLine,
            ...(input.limit === undefined
              ? {}
              : { endLine: startLine + input.limit - 1 }),
            ...(abortSignal === undefined ? {} : { abortSignal }),
          })
        : await session.readBinaryFile({
            path: input.file_path,
            ...(abortSignal === undefined ? {} : { abortSignal }),
          });

      // A missing file is not a file-read observation. Recording the error text
      // as this path's evidence would put a false artifact into the record, so
      // the failure is reported without interception; the harness still emits
      // its own tool-result event for it.
      if (bytes === null) {
        return `[acm: no such file: ${input.file_path}]`;
      }

      const observed = await interceptText(
        options,
        toolCallId,
        'read',
        toJsonInput(input),
        typeof bytes === 'string' ? bytesOfText(bytes) : bytes,
        false,
        undefined,
        abortSignal,
      );
      return observed.text;
    },
  });
}

/**
 * Builds the ripgrep invocation the search reducer can parse.
 *
 * `--json` is what makes the output reducible at all, and `--no-config`
 * prevents a repository's own ripgrep configuration from changing the format
 * out from under the parser.
 */
export function buildRipgrepCommand(input: {
  pattern: string;
  path?: string | undefined;
  glob?: string | undefined;
  caseInsensitive?: boolean | undefined;
}): string {
  const parts = ['rg', '--json', '--no-config'];
  if (input.caseInsensitive === true) parts.push('-i');
  if (input.glob !== undefined) parts.push('-g', quoteForShell(input.glob));
  parts.push('-e', quoteForShell(input.pattern));
  parts.push('--', quoteForShell(input.path ?? '.'));
  return parts.join(' ');
}

function grepTool(options: ObservationToolOptions): Tool {
  return tool({
    description:
      'Search the workspace with ripgrep and return the matching lines.',
    inputSchema: GREP_INPUT,
    async execute(input, { toolCallId, abortSignal }) {
      const { session, workingDirectory } = requireTarget(options);
      const command = buildRipgrepCommand(input);
      const result = await session.run({
        command,
        workingDirectory,
        ...(abortSignal === undefined ? {} : { abortSignal }),
      });
      // ripgrep exits 1 for "no matches", which is a result, not a failure.
      const failed = result.exitCode > 1;
      const text = failed
        ? combineCommandStreams(result.stdout, result.stderr)
        : result.stdout;

      const observed = await interceptText(
        options,
        toolCallId,
        'grep',
        toJsonInput({ ...input, command }),
        bytesOfText(text),
        failed,
        result.exitCode,
        abortSignal,
      );
      return observed.text;
    },
  });
}

function bashTool(options: ObservationToolOptions): Tool {
  return tool({
    description: 'Run a shell command in the workspace and return its output.',
    inputSchema: BASH_INPUT,
    async execute(input, { toolCallId, abortSignal }) {
      const { session, workingDirectory } = requireTarget(options);
      const result = await session.run({
        command: input.command,
        workingDirectory,
        ...(abortSignal === undefined ? {} : { abortSignal }),
      });
      const text = combineCommandStreams(result.stdout, result.stderr);

      const observed = await interceptText(
        options,
        toolCallId,
        'bash',
        toJsonInput(input),
        bytesOfText(text),
        result.exitCode !== 0,
        result.exitCode,
        abortSignal,
      );
      // A reduction already carries the exit code as a field. The raw paths do
      // not, and the exit code must stay visible without entering the evidence
      // that the parsers read.
      return observed.record.mode === 'reduced' || result.exitCode === 0
        ? observed.text
        : `${observed.text}\n[acm: command exited ${result.exitCode}]`;
    },
  });
}

const TOOL_FACTORIES: Record<
  ObservationToolName,
  (options: ObservationToolOptions) => Tool
> = {
  read: readTool,
  grep: grepTool,
  bash: bashTool,
};

/**
 * Builds host-executed tools that shadow the harness's own builtins.
 *
 * `HarnessAgent` gives user tools precedence over builtins on key collision, so
 * these run on the host: the raw observation is recorded and the reduced text
 * is what the harness writes into the agent's transcript. Unlike a prompt
 * prefix, that saving is present in every later model request of the session.
 *
 * Overriding narrows a builtin to the parameters declared here. The same
 * narrowing applies to both experimental conditions, so a paired comparison
 * still isolates the reduction; a comparison against a natively executed run
 * does not.
 */
export function createObservationTools(
  options: ObservationToolOptions,
): ToolSet {
  const names = options.tools ?? (['read', 'grep', 'bash'] as const);
  if (names.length === 0) {
    throw new TypeError('At least one observation tool must be overridden.');
  }
  const tools: Record<string, Tool> = {};
  for (const name of new Set(names)) {
    tools[name] = TOOL_FACTORIES[name](options);
  }
  return tools;
}
