import { describe, expect, it } from 'vitest';

import { ContextEventSchema, DurableWorkingStateSchema } from './index.js';

describe('ContextEventSchema', () => {
  it('accepts a valid typed event', () => {
    const event = ContextEventSchema.parse({
      id: 'evt_001',
      sessionId: 'session_001',
      kind: 'test_result',
      createdAt: '2026-08-16T12:00:00.000Z',
      payload: { passed: 10, failed: 1 },
      tokenEstimate: 1200,
    });

    expect(event.kind).toBe('test_result');
  });

  it('rejects a negative token estimate', () => {
    expect(() =>
      ContextEventSchema.parse({
        id: 'evt_002',
        sessionId: 'session_001',
        kind: 'tool_result',
        createdAt: '2026-08-16T12:00:00.000Z',
        payload: 'output',
        tokenEstimate: -1,
      }),
    ).toThrow();
  });
});

describe('DurableWorkingStateSchema', () => {
  it('adds safe empty defaults', () => {
    const state = DurableWorkingStateSchema.parse({
      updatedAt: '2026-08-16T12:00:00.000Z',
    });

    expect(state.requirements).toEqual([]);
    expect(state.currentFailures).toEqual([]);
  });
});
