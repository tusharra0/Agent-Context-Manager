import { describe, expect, it } from 'vitest';

import {
  ArtifactUriSchema,
  ContextEventSchema,
  DurableWorkingStateSchema,
  EventIdSchema,
  JsonValueSchema,
  PersistedContextEventV1Schema,
  ReducedTestResultV1Schema,
  SessionIdSchema,
  canonicalJson,
  createEventId,
  createSessionId,
} from './index.js';

const DIGEST = 'a'.repeat(64);
const UUID = '01234567-89ab-4def-8123-456789abcdef';

describe('opaque identifiers', () => {
  it('generates validated identifiers without encoding ordering', () => {
    expect(createSessionId(() => UUID)).toBe(
      'ses_0123456789ab4def8123456789abcdef',
    );
    expect(createEventId(() => UUID)).toBe(
      'evt_0123456789ab4def8123456789abcdef',
    );
  });

  it('rejects malformed identifiers and artifact URIs', () => {
    expect(SessionIdSchema.safeParse('session_1').success).toBe(false);
    expect(EventIdSchema.safeParse('evt_123').success).toBe(false);
    expect(
      ArtifactUriSchema.safeParse(`artifact://sha256/${DIGEST}/../x`).success,
    ).toBe(false);
  });
});

describe('canonicalJson', () => {
  it('is stable across insertion order and sorts by Unicode code point', () => {
    const first = { z: -0, a: { b: 2, a: 1 }, '\u{10000}': 3, '\ue000': 4 };
    const second = { '\ue000': 4, '\u{10000}': 3, a: { a: 1, b: 2 }, z: 0 };
    expect(canonicalJson(first)).toBe(canonicalJson(second));
    expect(canonicalJson(first)).toBe(
      '{"a":{"a":1,"b":2},"z":0,"\ue000":4,"𐀀":3}',
    );
  });

  it('rejects non-JSON and non-finite values', () => {
    for (const value of [
      undefined,
      1n,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      { bad: undefined },
    ]) {
      expect(JsonValueSchema.safeParse(value).success).toBe(false);
      expect(() => canonicalJson(value)).toThrow();
    }
  });

  it('preserves valid keys that overlap object prototype names', () => {
    const value = JSON.parse(
      '{"__proto__":{"polluted":true},"constructor":{"name":"data"}}',
    ) as unknown;

    expect(canonicalJson(value)).toBe(
      '{"__proto__":{"polluted":true},"constructor":{"name":"data"}}',
    );
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it('rejects cyclic, accessor-backed, and non-plain objects', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const accessor = Object.defineProperty({}, 'value', {
      enumerable: true,
      get: () => 1,
    });

    const sparse = new Array(1);
    const arrayWithExtraProperty = Object.assign([1], { metadata: true });

    for (const value of [
      cyclic,
      accessor,
      new Date(),
      sparse,
      arrayWithExtraProperty,
    ]) {
      expect(JsonValueSchema.safeParse(value).success).toBe(false);
    }
  });
});

describe('versioned schemas', () => {
  const payload = {
    schemaVersion: 1 as const,
    framework: 'vitest' as const,
    sourceFormat: 'vitest-json' as const,
    failures: [],
    diagnostics: [],
    parseStatus: 'complete' as const,
  };

  it('validates generic and persisted event payloads', () => {
    const base = {
      id: createEventId(() => UUID),
      sessionId: createSessionId(() => UUID),
      kind: 'test_result' as const,
      createdAt: '2026-08-16T12:00:00.000Z',
      payload,
      rawArtifactUri: `artifact://sha256/${DIGEST}`,
      contentHash: DIGEST,
      byteLength: 12,
    };
    expect(ContextEventSchema.parse(base).kind).toBe('test_result');
    expect(
      PersistedContextEventV1Schema.parse({
        ...base,
        schemaVersion: 1,
        sequence: 1,
      }).sequence,
    ).toBe(1);
    expect(
      PersistedContextEventV1Schema.safeParse({
        ...base,
        schemaVersion: 2,
        sequence: 1,
      }).success,
    ).toBe(false);
  });

  it('validates a reduced result and rejects missing evidence', () => {
    const reduction = {
      schemaVersion: 1,
      kind: 'test-result',
      framework: 'vitest',
      failures: [],
      diagnostics: [],
      evidence: {
        rawArtifactUri: `artifact://sha256/${DIGEST}`,
        contentHash: DIGEST,
        byteLength: 12,
      },
      safeForContext: true,
    };
    expect(ReducedTestResultV1Schema.parse(reduction).safeForContext).toBe(
      true,
    );
    expect(
      ReducedTestResultV1Schema.safeParse({ ...reduction, evidence: undefined })
        .success,
    ).toBe(false);
  });
});

describe('DurableWorkingStateSchema', () => {
  it('requires an explicit versioned session projection', () => {
    const state = DurableWorkingStateSchema.parse({
      schemaVersion: 1,
      sessionId: createSessionId(() => UUID),
      revision: 0,
      throughSequence: 0,
      requirements: [],
      decisions: [],
      files: [],
      failures: [],
      workItems: [],
      updatedAt: '2026-08-16T12:00:00.000Z',
    });
    expect(state.requirements).toEqual([]);
    expect(state.failures).toEqual([]);
  });

  it('rejects category-invalid statuses in persisted projections', () => {
    const sourceEventId = createEventId(() => UUID);
    expect(
      DurableWorkingStateSchema.safeParse({
        schemaVersion: 1,
        sessionId: createSessionId(() => UUID),
        revision: 1,
        throughSequence: 1,
        requirements: [
          {
            id: 'sti_0123456789ab4def8123456789abcdef',
            text: 'Requirement',
            status: 'resolved',
            retention: 'required',
            provenance: [{ sourceEventId }],
            introducedAtSequence: 1,
            updatedAtSequence: 1,
          },
        ],
        decisions: [],
        files: [],
        failures: [],
        workItems: [],
        updatedAt: '2026-08-16T12:00:00.000Z',
      }).success,
    ).toBe(false);
  });
});
