import { TextDecoder } from 'node:util';

import {
  BuildResultObservationV1Schema,
  ContextEventSchema,
  FileReadObservationV1Schema,
  ReducedBuildResultV1Schema,
  ReducedFileReadV1Schema,
  ReducedSearchResultV1Schema,
  SearchResultObservationV1Schema,
  canonicalJson,
} from '@acm/core';
import type {
  BuildDiagnosticV1,
  BuildResultObservationV1,
  ContextEvent,
  EventId,
  ReductionDiagnostic,
  SearchMatchV1,
  SearchResultObservationV1,
} from '@acm/core';

import type { ContextReducer, ReductionResult } from './reducer.js';

export const PHASE_2_TEXT_PARSER_MAX_BYTES = 16 * 1024 * 1024;

function decodeUtf8(bytes: Uint8Array): string | undefined {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

function utf16ColumnAtByteOffset(
  text: string,
  byteOffset: number,
): number | undefined {
  const bytes = Buffer.from(text, 'utf8');
  if (byteOffset > bytes.byteLength) return undefined;
  const prefix = decodeUtf8(bytes.subarray(0, byteOffset));
  return prefix === undefined ? undefined : prefix.length + 1;
}

function pointers(value: unknown): string[] {
  const result: string[] = [];
  function visit(current: unknown, path: string): void {
    if (Array.isArray(current)) {
      result.push(path || '/');
      current.forEach((item, index) => visit(item, `${path}/${index}`));
      return;
    }
    if (typeof current === 'object' && current !== null) {
      for (const key of Object.keys(current).sort()) {
        const segment = key.replaceAll('~', '~0').replaceAll('/', '~1');
        visit((current as Record<string, unknown>)[key], `${path}/${segment}`);
      }
      return;
    }
    result.push(path || '/');
  }
  visit(value, '');
  return result;
}

function requireArtifact(event: ContextEvent): {
  rawArtifactUri: string;
  contentHash: string;
  byteLength: number;
} {
  if (
    !event.rawArtifactUri ||
    !event.contentHash ||
    event.byteLength === undefined
  ) {
    throw new TypeError(
      `${event.kind} events require complete artifact metadata.`,
    );
  }
  if (!event.rawArtifactUri.endsWith(event.contentHash)) {
    throw new TypeError('Artifact URI does not match the event content hash.');
  }
  return {
    rawArtifactUri: event.rawArtifactUri,
    contentHash: event.contentHash,
    byteLength: event.byteLength,
  };
}

function result(
  event: ContextEvent,
  reducerId: string,
  reducedValue: unknown,
  safeForContext: boolean,
  diagnostics: readonly ReductionDiagnostic[],
): ReductionResult {
  return {
    sourceEventId: event.id,
    reducerId,
    reducerVersion: '1.0.0',
    reducedText: canonicalJson(reducedValue),
    rawArtifactUri: requireArtifact(event).rawArtifactUri,
    safeForContext,
    preservedFields: pointers(reducedValue),
    diagnostics,
  };
}

export class FileReadReducer implements ContextReducer {
  readonly reducerId = 'file-read/exact-hash';
  readonly reducerVersion = '1.0.0';
  readonly supportedKinds = ['file_read'] as const;

  constructor(private readonly duplicateOfEventId?: EventId) {}

  async reduce(eventInput: ContextEvent): Promise<ReductionResult> {
    const event = ContextEventSchema.parse(eventInput);
    if (event.kind !== 'file_read')
      throw new TypeError(`Unsupported event kind: ${event.kind}`);
    const payload = FileReadObservationV1Schema.parse(event.payload);
    const safeForContext = this.duplicateOfEventId !== undefined;
    const reduced = ReducedFileReadV1Schema.parse({
      kind: 'file-read',
      ...payload,
      ...(this.duplicateOfEventId
        ? { duplicateOfEventId: this.duplicateOfEventId }
        : {}),
      contentStatus: this.duplicateOfEventId
        ? 'duplicate-reference'
        : 'artifact-required',
      evidence: requireArtifact(event),
      safeForContext,
    });
    return result(event, this.reducerId, reduced, safeForContext, []);
  }
}

type RipgrepValue = {
  type?: unknown;
  data?: {
    path?: { text?: unknown };
    lines?: { text?: unknown };
    line_number?: unknown;
    submatches?: { start?: unknown; end?: unknown }[];
    stats?: { matches?: unknown };
  };
};

export type SearchParseMetadata = {
  query: string;
  root: string;
  command?: string;
  exitCode?: number;
};

export function parseRipgrepJson(
  bytes: Uint8Array,
  metadata: SearchParseMetadata,
): SearchResultObservationV1 {
  const diagnostics: ReductionDiagnostic[] = [];
  const matches = new Map<string, SearchMatchV1>();
  let reportedMatchCount: number | undefined;
  if (bytes.byteLength > PHASE_2_TEXT_PARSER_MAX_BYTES) {
    return SearchResultObservationV1Schema.parse({
      schemaVersion: 1,
      tool: 'ripgrep',
      sourceFormat: 'ripgrep-json',
      ...metadata,
      matches: [],
      diagnostics: [
        {
          code: 'INPUT_TOO_LARGE',
          message: `Input exceeds the ${PHASE_2_TEXT_PARSER_MAX_BYTES}-byte parser bound.`,
        },
      ],
      parseStatus: 'opaque',
    });
  }
  const text = decodeUtf8(bytes);
  if (text === undefined) {
    return SearchResultObservationV1Schema.parse({
      schemaVersion: 1,
      tool: 'ripgrep',
      sourceFormat: 'ripgrep-json',
      ...metadata,
      matches: [],
      diagnostics: [
        { code: 'INVALID_UTF8', message: 'Input is not valid UTF-8.' },
      ],
      parseStatus: 'opaque',
    });
  }

  for (const [index, line] of text.split(/\r?\n/u).entries()) {
    if (!line.trim()) continue;
    let value: RipgrepValue;
    try {
      value = JSON.parse(line) as RipgrepValue;
    } catch {
      diagnostics.push({
        code: 'INVALID_JSON_LINE',
        message: `Line ${index + 1} is not valid ripgrep JSON.`,
        jsonPath: `/${index}`,
      });
      continue;
    }
    if (value.type === 'match') {
      const path = value.data?.path?.text;
      const lineText = value.data?.lines?.text;
      const lineNumber = value.data?.line_number;
      if (
        typeof path !== 'string' ||
        typeof lineText !== 'string' ||
        !Number.isSafeInteger(lineNumber) ||
        (lineNumber as number) <= 0
      ) {
        diagnostics.push({
          code: 'INVALID_MATCH',
          message: `Line ${index + 1} contains an incomplete match record.`,
          jsonPath: `/${index}/data`,
        });
        continue;
      }
      const submatches = value.data?.submatches ?? [];
      if (submatches.length === 0) {
        const match: SearchMatchV1 = {
          path,
          line: lineNumber as number,
          text: lineText.replace(/\r?\n$/u, ''),
        };
        matches.set(canonicalJson(match), match);
      }
      for (const submatch of submatches) {
        const start = submatch.start;
        const end = submatch.end;
        if (
          !Number.isSafeInteger(start) ||
          (start as number) < 0 ||
          !Number.isSafeInteger(end) ||
          (end as number) <= (start as number)
        ) {
          diagnostics.push({
            code: 'INVALID_SUBMATCH',
            message: `Line ${index + 1} contains invalid submatch offsets.`,
            jsonPath: `/${index}/data/submatches`,
          });
          continue;
        }
        const column = utf16ColumnAtByteOffset(lineText, start as number);
        const endColumn = utf16ColumnAtByteOffset(lineText, end as number);
        if (column === undefined || endColumn === undefined) {
          diagnostics.push({
            code: 'INVALID_SUBMATCH',
            message: `Line ${index + 1} contains submatch offsets that do not align with UTF-8 text.`,
            jsonPath: `/${index}/data/submatches`,
          });
          continue;
        }
        const match: SearchMatchV1 = {
          path,
          line: lineNumber as number,
          column,
          endColumn,
          byteOffset: start as number,
          endByteOffset: end as number,
          text: lineText.replace(/\r?\n$/u, ''),
        };
        matches.set(canonicalJson(match), match);
      }
    } else if (value.type === 'summary') {
      const count = value.data?.stats?.matches;
      if (Number.isSafeInteger(count) && (count as number) >= 0) {
        reportedMatchCount = count as number;
      } else {
        diagnostics.push({
          code: 'INVALID_SUMMARY',
          message: `Line ${index + 1} contains an invalid summary count.`,
          jsonPath: `/${index}/data/stats/matches`,
        });
      }
    } else if (value.type === 'context') {
      diagnostics.push({
        code: 'CONTEXT_RECORD_UNSUPPORTED',
        message: `Line ${index + 1} contains a ripgrep context record that cannot be safely folded.`,
        jsonPath: `/${index}`,
      });
    } else if (!['begin', 'end'].includes(String(value.type))) {
      diagnostics.push({
        code: 'UNKNOWN_RECORD',
        message: `Line ${index + 1} has an unsupported ripgrep record type.`,
        jsonPath: `/${index}/type`,
      });
    }
  }
  if (reportedMatchCount === undefined) {
    diagnostics.push({
      code: 'MISSING_SUMMARY',
      message: 'Ripgrep summary record is missing.',
    });
  }
  if (reportedMatchCount !== undefined && reportedMatchCount !== matches.size) {
    diagnostics.push({
      code: 'MATCH_COUNT_MISMATCH',
      message: `Ripgrep reported ${reportedMatchCount} matches but ${matches.size} unique match records were observed.`,
    });
  }
  const observed = [...matches.values()].sort(
    (a, b) =>
      a.path.localeCompare(b.path) ||
      a.line - b.line ||
      (a.column ?? 0) - (b.column ?? 0),
  );
  return SearchResultObservationV1Schema.parse({
    schemaVersion: 1,
    tool: 'ripgrep',
    sourceFormat: 'ripgrep-json',
    ...metadata,
    matches: observed,
    ...(reportedMatchCount !== undefined ? { reportedMatchCount } : {}),
    diagnostics,
    parseStatus:
      diagnostics.length === 0
        ? 'complete'
        : observed.length
          ? 'partial'
          : 'opaque',
  });
}

export class RipgrepJsonReducer implements ContextReducer {
  readonly reducerId = 'search-result/ripgrep-json';
  readonly reducerVersion = '1.0.0';
  readonly supportedKinds = ['search_result'] as const;

  async reduce(eventInput: ContextEvent): Promise<ReductionResult> {
    const event = ContextEventSchema.parse(eventInput);
    if (event.kind !== 'search_result')
      throw new TypeError(`Unsupported event kind: ${event.kind}`);
    const payload = SearchResultObservationV1Schema.parse(event.payload);
    const safe = payload.parseStatus === 'complete';
    const reduced = ReducedSearchResultV1Schema.parse({
      schemaVersion: 1,
      kind: 'search-result',
      tool: 'ripgrep',
      query: payload.query,
      root: payload.root,
      ...(payload.command ? { command: payload.command } : {}),
      ...(payload.exitCode !== undefined ? { exitCode: payload.exitCode } : {}),
      matches: payload.matches,
      matchCount: payload.matches.length,
      diagnostics: payload.diagnostics,
      evidence: requireArtifact(event),
      safeForContext: safe,
    });
    return result(event, this.reducerId, reduced, safe, payload.diagnostics);
  }
}

export type BuildParseMetadata = {
  command: string;
  workingDirectory: string;
  toolVersion?: string;
  exitCode: number;
};

const TSC_DIAGNOSTIC =
  /^(?:(.+)\((\d+),(\d+)\): )?(error|warning) TS(\d+): (.+)$/u;
const TSC_SUMMARY = /^Found \d+ errors?(?: in \d+ files?)?\.?$/u;

export function parseTypescriptBuildOutput(
  bytes: Uint8Array,
  metadata: BuildParseMetadata,
): BuildResultObservationV1 {
  const diagnostics: ReductionDiagnostic[] = [];
  const buildDiagnostics: BuildDiagnosticV1[] = [];
  const tooLarge = bytes.byteLength > PHASE_2_TEXT_PARSER_MAX_BYTES;
  const text = tooLarge ? undefined : decodeUtf8(bytes);
  if (text === undefined) {
    return BuildResultObservationV1Schema.parse({
      schemaVersion: 1,
      tool: 'typescript',
      sourceFormat: 'tsc-pretty-false',
      ...metadata,
      buildDiagnostics: [],
      diagnostics: [
        tooLarge
          ? {
              code: 'INPUT_TOO_LARGE',
              message: `Input exceeds the ${PHASE_2_TEXT_PARSER_MAX_BYTES}-byte parser bound.`,
            }
          : { code: 'INVALID_UTF8', message: 'Input is not valid UTF-8.' },
      ],
      parseStatus: 'opaque',
    });
  }

  for (const [index, line] of text.split(/\r?\n/u).entries()) {
    if (!line.trim() || TSC_SUMMARY.test(line.trim())) continue;
    const match = TSC_DIAGNOSTIC.exec(line);
    if (!match) {
      diagnostics.push({
        code: 'UNPARSED_LINE',
        message: `Line ${index + 1} is not a recognized non-pretty TypeScript diagnostic: ${line}`,
      });
      continue;
    }
    const [, file, lineText, columnText, category, code, message] = match;
    buildDiagnostics.push({
      category: category as 'error' | 'warning',
      code: `TS${code}`,
      message: message!,
      ...(file ? { file } : {}),
      ...(lineText ? { line: Number(lineText) } : {}),
      ...(columnText ? { column: Number(columnText) } : {}),
    });
  }
  if (metadata.exitCode !== 0 && buildDiagnostics.length === 0) {
    diagnostics.push({
      code: 'FAILED_WITHOUT_DIAGNOSTIC',
      message:
        'The compiler exited unsuccessfully without a recognized diagnostic.',
    });
  }
  return BuildResultObservationV1Schema.parse({
    schemaVersion: 1,
    tool: 'typescript',
    sourceFormat: 'tsc-pretty-false',
    ...metadata,
    buildDiagnostics,
    diagnostics,
    parseStatus:
      diagnostics.length === 0
        ? 'complete'
        : buildDiagnostics.length
          ? 'partial'
          : 'opaque',
  });
}

export class TypescriptBuildReducer implements ContextReducer {
  readonly reducerId = 'build-result/tsc-pretty-false';
  readonly reducerVersion = '1.0.0';
  readonly supportedKinds = ['build_result'] as const;

  async reduce(eventInput: ContextEvent): Promise<ReductionResult> {
    const event = ContextEventSchema.parse(eventInput);
    if (event.kind !== 'build_result')
      throw new TypeError(`Unsupported event kind: ${event.kind}`);
    const payload = BuildResultObservationV1Schema.parse(event.payload);
    const safe = payload.parseStatus === 'complete';
    const reduced = ReducedBuildResultV1Schema.parse({
      schemaVersion: 1,
      kind: 'build-result',
      tool: 'typescript',
      command: payload.command,
      workingDirectory: payload.workingDirectory,
      ...(payload.toolVersion ? { toolVersion: payload.toolVersion } : {}),
      exitCode: payload.exitCode,
      buildDiagnostics: payload.buildDiagnostics,
      diagnostics: payload.diagnostics,
      evidence: requireArtifact(event),
      safeForContext: safe,
    });
    return result(event, this.reducerId, reduced, safe, payload.diagnostics);
  }
}
