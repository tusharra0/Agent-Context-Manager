import { describe, expect, it } from 'vitest';

import {
  FileReadReducer,
  RipgrepJsonReducer,
  TypescriptBuildReducer,
  parseRipgrepJson,
  parseTypescriptBuildOutput,
} from './phase2-reducers.js';

const EVENT = 'evt_11111111111141118111111111111111';
const DUPLICATE = 'evt_22222222222242228222222222222222';
const SESSION = 'ses_11111111111141118111111111111111';
const DIGEST = 'a'.repeat(64);
const base = {
  id: EVENT,
  sessionId: SESSION,
  createdAt: '2026-08-18T12:00:00.000Z',
  rawArtifactUri: `artifact://sha256/${DIGEST}`,
  contentHash: DIGEST,
  byteLength: 12,
};

describe('file-read reducer', () => {
  it('records exact duplicate provenance without discarding evidence', async () => {
    const result = await new FileReadReducer(DUPLICATE).reduce({
      ...base,
      kind: 'file_read',
      payload: {
        schemaVersion: 1,
        path: 'src/index.ts',
        pathKind: 'repository-relative',
        scope: { kind: 'full' },
        encoding: 'utf-8',
      },
    });
    expect(JSON.parse(result.reducedText)).toMatchObject({
      duplicateOfEventId: DUPLICATE,
      contentStatus: 'duplicate-reference',
      evidence: { contentHash: DIGEST },
      safeForContext: true,
    });
  });

  it('requires verified artifact content for the first observation', async () => {
    const reduced = await new FileReadReducer().reduce({
      ...base,
      kind: 'file_read',
      payload: {
        schemaVersion: 1,
        path: 'src/index.ts',
        pathKind: 'repository-relative',
        scope: { kind: 'full' },
        encoding: 'utf-8',
      },
    });
    expect(reduced.safeForContext).toBe(false);
    expect(JSON.parse(reduced.reducedText)).toMatchObject({
      contentStatus: 'artifact-required',
    });
  });
});

describe('ripgrep JSON parser and reducer', () => {
  it('preserves and deterministically deduplicates exact match records', async () => {
    const match = JSON.stringify({
      type: 'match',
      data: {
        path: { text: 'src/index.ts' },
        lines: { text: 'export const value = 1;\n' },
        line_number: 4,
        submatches: [{ start: 7, end: 12, match: { text: 'const' } }],
      },
    });
    const summary = JSON.stringify({
      type: 'summary',
      data: { stats: { matches: 1 } },
    });
    const payload = parseRipgrepJson(
      Buffer.from(`${match}\n${match}\n${summary}\n`),
      { query: 'const', root: '.', exitCode: 0 },
    );
    expect(payload).toMatchObject({
      parseStatus: 'complete',
      reportedMatchCount: 1,
      matches: [
        {
          path: 'src/index.ts',
          line: 4,
          column: 8,
          byteOffset: 7,
          text: 'export const value = 1;',
        },
      ],
    });

    const reduced = await new RipgrepJsonReducer().reduce({
      ...base,
      kind: 'search_result',
      payload,
    });
    expect(reduced.safeForContext).toBe(true);
    expect(JSON.parse(reduced.reducedText)).toMatchObject({ matchCount: 1 });
  });

  it('marks malformed or incomplete streams unsafe', () => {
    expect(
      parseRipgrepJson(Buffer.from('{\n'), { query: 'x', root: '.' }),
    ).toMatchObject({ parseStatus: 'opaque' });
    expect(
      parseRipgrepJson(Buffer.from([0xff]), { query: 'x', root: '.' }),
    ).toMatchObject({
      parseStatus: 'opaque',
      diagnostics: [{ code: 'INVALID_UTF8' }],
    });
  });

  it('converts ripgrep byte offsets to UTF-16 columns', () => {
    const line = '😀 value\n';
    const match = JSON.stringify({
      type: 'match',
      data: {
        path: { text: 'src/unicode.ts' },
        lines: { text: line },
        line_number: 1,
        submatches: [{ start: 5, end: 10, match: { text: 'value' } }],
      },
    });
    const summary = JSON.stringify({
      type: 'summary',
      data: { stats: { matches: 1 } },
    });
    const payload = parseRipgrepJson(Buffer.from(`${match}\n${summary}\n`), {
      query: 'value',
      root: '.',
    });
    expect(payload.matches[0]).toMatchObject({
      column: 4,
      endColumn: 9,
      byteOffset: 5,
      endByteOffset: 10,
    });
  });
});

describe('TypeScript build parser and reducer', () => {
  it('preserves exact structured diagnostics', async () => {
    const payload = parseTypescriptBuildOutput(
      Buffer.from(
        'src/index.ts(3,7): error TS2322: Type string is not assignable to number.\nFound 1 error.\n',
      ),
      {
        command: 'pnpm typecheck',
        workingDirectory: '.',
        toolVersion: '5.9.2',
        exitCode: 2,
      },
    );
    expect(payload).toMatchObject({
      parseStatus: 'complete',
      buildDiagnostics: [
        {
          file: 'src/index.ts',
          line: 3,
          column: 7,
          code: 'TS2322',
        },
      ],
    });
    const reduced = await new TypescriptBuildReducer().reduce({
      ...base,
      kind: 'build_result',
      payload,
    });
    expect(reduced.safeForContext).toBe(true);
  });

  it('retains unexplained output as a diagnostic and marks the result partial', () => {
    const payload = parseTypescriptBuildOutput(
      Buffer.from(
        'src/index.ts(3,7): error TS2322: Broken\nunrecognized tool output\n',
      ),
      { command: 'tsc --pretty false', workingDirectory: '.', exitCode: 2 },
    );
    expect(payload).toMatchObject({
      parseStatus: 'partial',
      diagnostics: [{ code: 'UNPARSED_LINE' }],
    });
  });
});
