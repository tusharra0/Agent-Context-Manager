import type {
  BuildResultObservationV1,
  FileReadObservationV1,
  JsonValue,
  SearchResultObservationV1,
  TestResultObservationV1,
} from '@acm/core';
import {
  BuildResultObservationV1Schema,
  FileReadObservationV1Schema,
} from '@acm/core';
import type { HarnessToolInvocation } from '@acm/harness-port';
import {
  parseRipgrepJson,
  parseTypescriptBuildOutput,
  parseVitestJson,
} from '@acm/reducers';

/** Everything a classifier may know beyond the tool call itself. */
export interface ObservationContext {
  /** Absolute working directory the tool ran in. */
  readonly workingDirectory: string;
}

export type ObservationClassification =
  | { readonly kind: 'file_read'; readonly payload: FileReadObservationV1 }
  | {
      readonly kind: 'search_result';
      readonly payload: SearchResultObservationV1;
    }
  | {
      readonly kind: 'build_result';
      readonly payload: BuildResultObservationV1;
    }
  | { readonly kind: 'test_result'; readonly payload: TestResultObservationV1 };

export interface ClassifierInput {
  readonly invocation: HarnessToolInvocation;
  readonly bytes: Uint8Array;
  readonly exitCode: number | undefined;
  readonly context: ObservationContext;
}

/**
 * Recognizes the observations a deterministic reducer can handle.
 *
 * A classifier may claim an observation optimistically: every parser reports a
 * `parseStatus`, and a reduction that is not `complete` is rejected downstream
 * in favor of the raw observation. Claiming wrongly therefore costs parse time,
 * never information.
 */
export interface ObservationClassifier {
  readonly id: string;
  classify(input: ClassifierInput): ObservationClassification | undefined;
}

function inputRecord(input: JsonValue): Record<string, JsonValue> | undefined {
  return input !== null && typeof input === 'object' && !Array.isArray(input)
    ? input
    : undefined;
}

function stringField(
  input: JsonValue,
  ...keys: readonly string[]
): string | undefined {
  const record = inputRecord(input);
  if (record === undefined) return undefined;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

/**
 * Reads an optional positive integer. `null` distinguishes "present but
 * unusable" from "absent": a malformed line range must not be silently widened
 * into a whole-file read.
 */
function positiveIntegerField(
  input: JsonValue,
  key: string,
): number | undefined | null {
  const record = inputRecord(input);
  const value = record?.[key];
  if (value === undefined || value === null) return undefined;
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? value
    : null;
}

const ABSOLUTE_PATH = /^(?:\/|[A-Za-z]:[\\/])/u;

function normalizedToolName(toolName: string): string {
  return toolName.toLowerCase().replaceAll('_', '-');
}

const FILE_READ_TOOLS = new Set(['read', 'read-file', 'readfile', 'view']);

export class FileReadClassifier implements ObservationClassifier {
  readonly id = 'file-read';

  classify(input: ClassifierInput): ObservationClassification | undefined {
    if (!FILE_READ_TOOLS.has(normalizedToolName(input.invocation.toolName))) {
      return undefined;
    }
    const path = stringField(
      input.invocation.input,
      'file_path',
      'filePath',
      'path',
    );
    if (path === undefined) return undefined;

    const offset = positiveIntegerField(input.invocation.input, 'offset');
    const limit = positiveIntegerField(input.invocation.input, 'limit');
    // An unusable range is not a whole-file read; leave it to the raw path.
    if (offset === null || limit === null) return undefined;

    // An open-ended range ("from line N to the end") has no representation in
    // the observation schema. Recording a fabricated end line would put a
    // false span into durable evidence, so the read stays unclassified.
    if (offset !== undefined && limit === undefined) return undefined;

    const scope =
      offset === undefined && limit === undefined
        ? { kind: 'full' as const }
        : {
            kind: 'range' as const,
            startLine: offset ?? 1,
            endLine: (offset ?? 1) + (limit ?? 1) - 1,
          };
    if (scope.kind === 'range' && !Number.isSafeInteger(scope.endLine)) {
      return undefined;
    }

    const parsed = FileReadObservationV1Schema.safeParse({
      schemaVersion: 1,
      path,
      pathKind: ABSOLUTE_PATH.test(path) ? 'absolute' : 'repository-relative',
      scope,
      encoding: 'utf-8',
    } satisfies Record<string, unknown>);
    return parsed.success
      ? { kind: 'file_read', payload: parsed.data }
      : undefined;
  }
}

const SEARCH_TOOLS = new Set(['grep', 'search', 'ripgrep', 'rg']);

/**
 * Claims ripgrep JSON. The interception layer chooses the command it runs, so
 * a wrapper that does not emit `--json` produces an `opaque` parse and the raw
 * observation is used instead.
 */
export class RipgrepJsonClassifier implements ObservationClassifier {
  readonly id = 'search-result';

  classify(input: ClassifierInput): ObservationClassification | undefined {
    if (!SEARCH_TOOLS.has(normalizedToolName(input.invocation.toolName))) {
      return undefined;
    }
    const query = stringField(input.invocation.input, 'pattern', 'query');
    if (query === undefined) return undefined;
    const root =
      stringField(input.invocation.input, 'path', 'root') ??
      input.context.workingDirectory;
    const command = stringField(input.invocation.input, 'command');
    return {
      kind: 'search_result',
      payload: parseRipgrepJson(input.bytes, {
        query,
        root,
        ...(command === undefined ? {} : { command }),
        ...(input.exitCode === undefined ? {} : { exitCode: input.exitCode }),
      }),
    };
  }
}

const SHELL_TOOLS = new Set([
  'bash',
  'shell',
  'exec',
  'exec-command',
  'run-command',
]);

const VITEST_JSON_COMMAND =
  /\bvitest\b(?=.*--reporter[= ](?:json|"json"|'json'))/u;
const TSC_COMMAND = /\btsc\b/u;
const TSC_PRETTY_FALSE = /--pretty[= ](?:false|"false"|'false')/u;

function shellCommand(input: ClassifierInput): string | undefined {
  return SHELL_TOOLS.has(normalizedToolName(input.invocation.toolName))
    ? stringField(input.invocation.input, 'command')
    : undefined;
}

export class VitestJsonClassifier implements ObservationClassifier {
  readonly id = 'test-result';

  classify(input: ClassifierInput): ObservationClassification | undefined {
    const command = shellCommand(input);
    if (command === undefined || !VITEST_JSON_COMMAND.test(command)) {
      return undefined;
    }
    return {
      kind: 'test_result',
      payload: parseVitestJson(input.bytes, {
        command,
        ...(input.exitCode === undefined ? {} : { exitCode: input.exitCode }),
      }),
    };
  }
}

/**
 * Claims non-pretty `tsc` output. The reducer's parser only understands
 * `--pretty false`, so a pretty run is left alone rather than reduced into a
 * diagnostic list that would drop every unrecognized line.
 */
export class TypescriptBuildClassifier implements ObservationClassifier {
  readonly id = 'build-result';

  classify(input: ClassifierInput): ObservationClassification | undefined {
    const command = shellCommand(input);
    if (
      command === undefined ||
      !TSC_COMMAND.test(command) ||
      !TSC_PRETTY_FALSE.test(command)
    ) {
      return undefined;
    }
    // The reducer records the exit code as evidence; without one there is no
    // way to tell a clean build from a crashed compiler.
    if (input.exitCode === undefined) return undefined;
    const parsed = BuildResultObservationV1Schema.safeParse(
      parseTypescriptBuildOutput(input.bytes, {
        command,
        workingDirectory: input.context.workingDirectory,
        exitCode: input.exitCode,
      }),
    );
    return parsed.success
      ? { kind: 'build_result', payload: parsed.data }
      : undefined;
  }
}

/** The classifiers enabled by default, in the order they are consulted. */
export function defaultObservationClassifiers(): ObservationClassifier[] {
  return [
    new FileReadClassifier(),
    new RipgrepJsonClassifier(),
    new VitestJsonClassifier(),
    new TypescriptBuildClassifier(),
  ];
}
