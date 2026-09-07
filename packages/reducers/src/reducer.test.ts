import { readFile } from 'node:fs/promises';

import type { ContextEvent } from '@acm/core';
import { canonicalJson } from '@acm/core';
import { describe, expect, it } from 'vitest';

import {
  TOKEN_ESTIMATOR_ID,
  UnsupportedEventError,
  VitestJsonReducer,
  estimateTokens,
  estimateTokensFromByteLength,
  parseVitestJson,
} from './index.js';

const fixtureUrl = new URL(
  '../test/fixtures/vitest-json/v1/one-failure.json',
  import.meta.url,
);
const DIGEST = 'a'.repeat(64);

function event(
  payload: ReturnType<typeof parseVitestJson>,
  idSuffix = '1',
): ContextEvent {
  return {
    id: `evt_${idSuffix.repeat(32)}`,
    sessionId: 'ses_11111111111111111111111111111111',
    kind: 'test_result',
    createdAt: '2026-08-18T12:00:00.000Z',
    payload,
    rawArtifactUri: `artifact://sha256/${DIGEST}`,
    contentHash: DIGEST,
    byteLength: 100,
  };
}

describe('VitestJsonReducer', () => {
  it('creates deterministic canonical reductions independent of event identity', async () => {
    const payload = parseVitestJson(await readFile(fixtureUrl), {
      command: 'pnpm test',
      exitCode: 1,
    });
    const reducer = new VitestJsonReducer();
    const first = await reducer.reduce(event(payload, '1'));
    const second = await reducer.reduce({
      ...event(payload, '2'),
      createdAt: '2027-01-01T00:00:00.000Z',
    });
    expect(first.reducedText).toBe(second.reducedText);
    expect(first.reducerId).toBe('test-result/vitest-json');
    expect(first.reducerVersion).toBe('1.1.0');
    expect(first.safeForContext).toBe(true);
    expect(first.preservedFields).toContain('/failures/0/failureMessages');
    expect(canonicalJson(JSON.parse(first.reducedText))).toBe(
      first.reducedText,
    );
  });

  it('marks opaque observations unsafe for context', async () => {
    const reducer = new VitestJsonReducer();
    const result = await reducer.reduce(
      event(parseVitestJson(Buffer.from('{'))),
    );
    expect(result.safeForContext).toBe(false);
    expect(JSON.parse(result.reducedText)).toMatchObject({
      safeForContext: false,
      diagnostics: [{ code: 'INVALID_JSON' }],
    });
  });

  it('keeps suite failures, reporter counts and snapshot evidence in active context', async () => {
    const payload = parseVitestJson(
      Buffer.from(
        JSON.stringify({
          success: false,
          numTotalTestSuites: 1,
          numFailedTestSuites: 1,
          snapshot: { failure: true, filesUnmatched: 1 },
          testResults: [
            {
              name: 'suite.test.ts',
              status: 'failed',
              message: 'suite setup failed',
              assertionResults: [],
            },
          ],
        }),
      ),
    );
    const reduced = await new VitestJsonReducer().reduce(event(payload));
    expect(reduced.safeForContext).toBe(true);
    expect(JSON.parse(reduced.reducedText)).toMatchObject({
      reportedSuiteCounts: payload.reportedSuiteCounts,
      snapshot: payload.snapshot,
      failures: payload.failures,
      evidence: { rawArtifactUri: `artifact://sha256/${DIGEST}` },
    });
    expect(reduced.preservedFields).toContain('/failures/0/scope');
    expect(reduced.preservedFields).toContain('/failures/0/failureMessages/0');
  });

  it('requires restoration for unsupported reporter fields that may contain failures', async () => {
    const payload = parseVitestJson(
      Buffer.from(
        JSON.stringify({
          testResults: [],
          unhandledErrors: [{ message: 'unhandled rejection' }],
        }),
      ),
    );
    const reduced = await new VitestJsonReducer().reduce(event(payload));
    expect(reduced.safeForContext).toBe(false);
    expect(JSON.parse(reduced.reducedText)).toMatchObject({
      diagnostics: [{ code: 'UNKNOWN_FIELD', jsonPath: '/unhandledErrors' }],
      evidence: { rawArtifactUri: `artifact://sha256/${DIGEST}` },
    });
  });

  it('rejects unsupported kinds, versions, and incomplete evidence metadata', async () => {
    const reducer = new VitestJsonReducer();
    const valid = event(parseVitestJson(await readFile(fixtureUrl)));
    await expect(
      reducer.reduce({ ...valid, kind: 'build_result' }),
    ).rejects.toBeInstanceOf(UnsupportedEventError);
    await expect(
      reducer.reduce({
        ...valid,
        payload: { ...valid.payload, schemaVersion: 2 },
      }),
    ).rejects.toBeInstanceOf(UnsupportedEventError);
    await expect(
      reducer.reduce({ ...valid, rawArtifactUri: undefined }),
    ).rejects.toThrow();
  });
});

describe('offline token estimator', () => {
  it('uses one deterministic UTF-8 byte estimator', () => {
    expect(TOKEN_ESTIMATOR_ID).toBe('utf8-bytes-div-4@1');
    expect(estimateTokens('12345')).toBe(2);
    expect(estimateTokens('😀')).toBe(1);
    expect(estimateTokensFromByteLength(0)).toBe(0);
    expect(() => estimateTokensFromByteLength(-1)).toThrow(RangeError);
  });
});
