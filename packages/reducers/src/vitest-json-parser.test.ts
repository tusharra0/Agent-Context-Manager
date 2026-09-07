import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import {
  VITEST_JSON_PARSER_MAX_BYTES,
  parseVitestJson,
} from './vitest-json-parser.js';

const fixtureRoot = new URL(
  '../test/fixtures/vitest-json/v1/',
  import.meta.url,
);

async function fixture(name: string): Promise<Buffer> {
  return readFile(new URL(name, fixtureRoot));
}

describe('parseVitestJson', () => {
  it('folds passing names into counts while preserving skipped and todo counts', async () => {
    const result = parseVitestJson(await fixture('all-pass.json'));
    expect(result.parseStatus).toBe('complete');
    expect(result.reportedCounts).toEqual({
      total: 3,
      passed: 1,
      failed: 0,
      skipped: 1,
      todo: 1,
    });
    expect(result.observedCounts).toEqual({
      total: 3,
      passed: 1,
      failed: 0,
      skipped: 1,
      todo: 1,
    });
    expect(result.failures).toEqual([]);
    expect(JSON.stringify(result)).not.toContain('adds values');
  });

  it('retains every failed assertion, exact messages, files, and stack frames', async () => {
    const bytes = await fixture('several-failures.json');
    const source = JSON.parse(bytes.toString('utf8')) as {
      testResults: { assertionResults: { failureMessages: string[] }[] }[];
    };
    const result = parseVitestJson(bytes);
    expect(result.failures).toHaveLength(2);
    expect(result.failures.map((failure) => failure.testName)).toEqual([
      'multiple failures keeps the first failure',
      'multiple failures keeps the second failure',
    ]);
    expect(result.failures[0]?.failureMessages).toEqual(
      source.testResults[0]?.assertionResults[0]?.failureMessages,
    );
    expect(result.failures[0]?.file).toMatch(/several-failures\.test\.ts$/u);
    expect(result.failures[0]?.stackFrames.length).toBeGreaterThan(0);
  });

  it('extracts expected and actual only for the fixture-tested delimiter', async () => {
    const recognized = parseVitestJson(await fixture('expected-actual.json'));
    expect(recognized.failures[0]).toMatchObject({
      expected: 'expected-value',
      actual: 'observed-value',
    });
    const unsupported = parseVitestJson(await fixture('one-failure.json'));
    expect(unsupported.failures[0]).not.toHaveProperty('expected');
    expect(unsupported.failures[0]).not.toHaveProperty('actual');
  });

  it('preserves supported location fields and reports unknown fields', () => {
    const result = parseVitestJson(
      Buffer.from(
        JSON.stringify({
          numTotalTests: 1,
          numPassedTests: 0,
          numFailedTests: 1,
          numPendingTests: 0,
          numTodoTests: 0,
          success: false,
          futureTopLevelField: true,
          testResults: [
            {
              name: '/repo/example.test.ts',
              assertionResults: [
                {
                  fullName: 'example fails',
                  status: 'failed',
                  failureMessages: ['failure'],
                  location: { line: 12, column: 7 },
                  futureAssertionField: 42,
                },
              ],
            },
          ],
        }),
      ),
    );
    expect(result.failures[0]).toMatchObject({
      file: '/repo/example.test.ts',
      line: 12,
      column: 7,
    });
    expect(
      result.diagnostics.filter(
        (diagnostic) => diagnostic.code === 'UNKNOWN_FIELD',
      ),
    ).toHaveLength(2);
    expect(result.parseStatus).toBe('partial');
  });

  it('preserves suite import errors even when no assertions ran', () => {
    const message =
      'Error: Cannot find module ./missing.js\n    at src/import.test.ts:1:1';
    const snapshot = { failure: false, uncheckedKeysByFile: [] };
    const result = parseVitestJson(
      Buffer.from(
        JSON.stringify({
          success: false,
          numTotalTests: 0,
          numFailedTests: 0,
          numTotalTestSuites: 1,
          numFailedTestSuites: 1,
          snapshot,
          testResults: [
            {
              name: 'src/import.test.ts',
              status: 'failed',
              message,
              assertionResults: [],
            },
          ],
        }),
      ),
      { exitCode: 1 },
    );

    expect(result).toMatchObject({
      parseStatus: 'complete',
      reportedCounts: { total: 0, failed: 0 },
      observedCounts: { total: 0, failed: 0 },
      reportedSuiteCounts: { total: 1, failed: 1 },
      snapshot,
      failures: [
        {
          scope: 'suite',
          testName: 'src/import.test.ts',
          file: 'src/import.test.ts',
          suiteStatus: 'failed',
          failureMessages: [message],
          stackFrames: ['at src/import.test.ts:1:1'],
        },
      ],
    });
  });

  it('keeps suite errors alongside failed assertions without changing assertion counts', () => {
    const result = parseVitestJson(
      Buffer.from(
        JSON.stringify({
          success: false,
          testResults: [
            {
              name: 'src/hook.test.ts',
              status: 'failed',
              message: 'afterAll cleanup failed',
              assertionResults: [
                {
                  fullName: 'assertion failure',
                  status: 'failed',
                  failureMessages: ['assertion failed'],
                },
              ],
            },
          ],
        }),
      ),
    );
    expect(result.parseStatus).toBe('complete');
    expect(result.observedCounts).toMatchObject({ total: 1, failed: 1 });
    expect(result.failures).toHaveLength(2);
    expect(result.failures[0]).toMatchObject({
      scope: 'suite',
      failureMessages: ['afterAll cleanup failed'],
    });
    expect(result.failures[1]).toMatchObject({
      testName: 'assertion failure',
      failureMessages: ['assertion failed'],
    });
  });

  it.each([
    { status: 'failed', message: '' },
    { status: 'failed', message: { error: 'not a reporter string' } },
    { status: 'unknown', message: 'unsupported status' },
  ])('requires restoration for incomplete suite fields: %j', (fields) => {
    const result = parseVitestJson(
      Buffer.from(
        JSON.stringify({
          success: false,
          testResults: [
            { name: 'src/failing.test.ts', assertionResults: [], ...fields },
          ],
        }),
      ),
    );
    expect(result.parseStatus).toBe('partial');
    expect(result.diagnostics.length).toBeGreaterThan(0);
  });

  it('does not declare unexplained reporter failure or malformed known fields complete', () => {
    for (const report of [
      { success: false, testResults: [] },
      { numFailedTestSuites: 1, testResults: [] },
      { numTotalTests: '1', testResults: [] },
      { snapshot: null, testResults: [] },
      {
        testResults: [
          { status: 'failed', message: 'import failed', assertionResults: [] },
        ],
      },
      {
        testResults: [
          {
            assertionResults: [
              {
                fullName: 'fails',
                status: 'failed',
                failureMessages: ['error'],
                location: { line: -1 },
              },
            ],
          },
        ],
      },
    ]) {
      expect(
        parseVitestJson(Buffer.from(JSON.stringify(report))).parseStatus,
      ).toBe('partial');
    }
  });

  it('derives counts without a summary and diagnoses reported mismatches', async () => {
    const withoutSummary = parseVitestJson(
      await fixture('no-summary-counts.json'),
    );
    expect(withoutSummary.reportedCounts).toBeUndefined();
    expect(withoutSummary.observedCounts?.total).toBe(3);

    const mismatch = parseVitestJson(
      Buffer.from(
        JSON.stringify({
          numTotalTests: 99,
          testResults: [],
        }),
      ),
    );
    expect(mismatch.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'COUNT_MISMATCH' }),
    );
  });

  it.each([
    ['truncated.json', 'INVALID_JSON'],
    ['malformed-utf8.bin', 'MALFORMED_UTF8'],
    ['very-large.json', 'INPUT_TOO_LARGE'],
  ])('marks %s opaque with %s', async (name, code) => {
    const bytes = await fixture(name);
    if (name === 'very-large.json')
      expect(bytes.byteLength).toBeGreaterThan(VITEST_JSON_PARSER_MAX_BYTES);
    const result = parseVitestJson(bytes);
    expect(result.parseStatus).toBe('opaque');
    expect(result.diagnostics[0]?.code).toBe(code);
  });

  it('marks malformed required fields partial rather than claiming a safe parse', () => {
    const result = parseVitestJson(
      Buffer.from('{"success":"yes","testResults":{}}'),
    );
    expect(result.parseStatus).toBe('partial');
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      'MALFORMED_FIELD',
      'MALFORMED_TEST_RESULTS',
    ]);
  });

  it('marks a failed assertion without a recoverable name partial', () => {
    const result = parseVitestJson(
      Buffer.from(
        JSON.stringify({
          numTotalTests: 1,
          numFailedTests: 1,
          testResults: [
            {
              name: '/repo/example.test.ts',
              assertionResults: [
                { status: 'failed', failureMessages: ['failure'] },
              ],
            },
          ],
        }),
      ),
    );

    expect(result.parseStatus).toBe('partial');
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'MISSING_TEST_NAME' }),
    );
  });

  it('retains usable error messages when the reporter failure array is partially malformed', () => {
    const result = parseVitestJson(
      Buffer.from(
        JSON.stringify({
          testResults: [
            {
              name: 'src/failure.test.ts',
              assertionResults: [
                {
                  fullName: 'retains error details',
                  status: 'failed',
                  failureMessages: ['exact error message', null],
                },
              ],
            },
          ],
        }),
      ),
    );
    expect(result.parseStatus).toBe('partial');
    expect(result.failures[0]?.failureMessages).toEqual([
      'exact error message',
    ]);
  });
});
