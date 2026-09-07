import { describe, expect, it } from 'vitest';

import {
  createVercelStreamNormalizer,
  normalizeVercelStreamPart,
} from './normalizer.js';

describe('normalizeVercelStreamPart', () => {
  it('normalizes text, reasoning, tool calls, and results', () => {
    expect(
      normalizeVercelStreamPart({ type: 'text-delta', id: 't1', text: 'hi' }),
    ).toEqual([{ kind: 'text-delta', text: 'hi' }]);
    expect(
      normalizeVercelStreamPart({
        type: 'reasoning-delta',
        id: 'r1',
        text: 'think',
      }),
    ).toEqual([{ kind: 'reasoning-delta', text: 'think' }]);
    expect(
      normalizeVercelStreamPart({
        type: 'tool-call',
        toolCallId: 'call-1',
        toolName: 'read',
        input: { file_path: 'src/index.ts' },
      }),
    ).toEqual([
      {
        kind: 'tool-call',
        toolCallId: 'call-1',
        toolName: 'read',
        input: { file_path: 'src/index.ts' },
      },
    ]);
    expect(
      normalizeVercelStreamPart({
        type: 'tool-result',
        toolCallId: 'call-1',
        toolName: 'read',
        input: { file_path: 'src/index.ts' },
        output: { content: 'export {}' },
      }),
    ).toEqual([
      {
        kind: 'tool-result',
        toolCallId: 'call-1',
        toolName: 'read',
        output: { content: 'export {}' },
        isError: false,
      },
    ]);
  });

  it('normalizes final usage exactly once from the finish part', () => {
    expect(
      normalizeVercelStreamPart({
        type: 'finish',
        finishReason: 'stop',
        rawFinishReason: 'end_turn',
        totalUsage: {
          inputTokens: 12,
          outputTokens: 4,
          totalTokens: 16,
          inputTokenDetails: { cacheReadTokens: 2 },
        },
      }),
    ).toEqual([
      {
        kind: 'usage',
        inputTokens: 12,
        outputTokens: 4,
        totalTokens: 16,
        details: {
          inputTokens: 12,
          outputTokens: 4,
          totalTokens: 16,
          inputTokenDetails: { cacheReadTokens: 2 },
        },
      },
      {
        kind: 'turn-completed',
        finishReason: 'stop',
        rawFinishReason: 'end_turn',
      },
    ]);
    expect(
      normalizeVercelStreamPart({
        type: 'finish-step',
        usage: { inputTokens: 12, outputTokens: 4, totalTokens: 16 },
      }),
    ).toEqual([]);
  });

  it('keeps tool errors, aborts, and stream errors observable', () => {
    expect(
      normalizeVercelStreamPart({
        type: 'tool-error',
        toolCallId: 'call-1',
        toolName: 'bash',
        error: new Error('exit 1'),
      }),
    ).toEqual([
      {
        kind: 'tool-result',
        toolCallId: 'call-1',
        toolName: 'bash',
        output: { error: 'exit 1' },
        isError: true,
      },
    ]);
    expect(
      normalizeVercelStreamPart({ type: 'abort', reason: 'cancelled' }),
    ).toEqual([{ kind: 'interrupted', reason: 'cancelled' }]);
    expect(
      normalizeVercelStreamPart({
        type: 'error',
        error: new Error('connection lost'),
      }),
    ).toEqual([{ kind: 'error', message: 'connection lost' }]);
  });

  it.each([
    undefined,
    null,
    {},
    { inputTokens: 12 },
    { outputTokens: 4 },
    { inputTokens: -1, outputTokens: 4 },
    { inputTokens: 12, outputTokens: Number.NaN },
    { inputTokens: 12, outputTokens: 4, totalTokens: -1 },
  ])('keeps missing or invalid usage unavailable: %j', (totalUsage) => {
    const events = normalizeVercelStreamPart({
      type: 'finish',
      finishReason: 'stop',
      totalUsage,
    });

    expect(events).toEqual([
      expect.objectContaining({
        kind: 'diagnostic',
        code: 'usage-unavailable',
      }),
      { kind: 'turn-completed', finishReason: 'stop' },
    ]);
    expect(events.some((event) => event.kind === 'usage')).toBe(false);
  });

  it('preserves actual zero usage and computes only a missing total from known counts', () => {
    expect(
      normalizeVercelStreamPart({
        type: 'finish',
        totalUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      })[0],
    ).toMatchObject({
      kind: 'usage',
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    });
    expect(
      normalizeVercelStreamPart({
        type: 'finish',
        totalUsage: { inputTokens: 12, outputTokens: 4 },
      })[0],
    ).toMatchObject({
      kind: 'usage',
      inputTokens: 12,
      outputTokens: 4,
      totalTokens: 16,
    });
  });

  it('turns additive and malformed parts into diagnostics', () => {
    expect(
      normalizeVercelStreamPart({ type: 'future-part', value: 42 }),
    ).toEqual([
      expect.objectContaining({
        kind: 'diagnostic',
        code: 'unrecognized-vendor-part',
        rawPart: { type: 'future-part', value: 42 },
      }),
    ]);
    expect(
      normalizeVercelStreamPart({
        type: 'tool-call',
        toolCallId: 'call-1',
        toolName: 'read',
        input: undefined,
      }),
    ).toEqual([
      expect.objectContaining({
        kind: 'diagnostic',
        code: 'invalid-tool-call',
      }),
    ]);
  });
});

describe('createVercelStreamNormalizer', () => {
  it('numbers step usage in arrival order and restarts per normalizer', () => {
    const normalize = createVercelStreamNormalizer();
    expect(
      normalize({
        type: 'finish-step',
        usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110 },
      }),
    ).toEqual([
      {
        kind: 'step-usage',
        stepIndex: 1,
        inputTokens: 100,
        outputTokens: 10,
        totalTokens: 110,
        details: { inputTokens: 100, outputTokens: 10, totalTokens: 110 },
      },
    ]);
    expect(
      normalize({
        type: 'finish-step',
        usage: {
          inputTokens: 220,
          outputTokens: 8,
          totalTokens: 228,
          cachedInputTokens: 96,
        },
      })[0],
    ).toMatchObject({
      kind: 'step-usage',
      stepIndex: 2,
      inputTokens: 220,
      cachedInputTokens: 96,
    });

    expect(
      createVercelStreamNormalizer()({
        type: 'finish-step',
        usage: { inputTokens: 5, outputTokens: 1, totalTokens: 6 },
      })[0],
    ).toMatchObject({ kind: 'step-usage', stepIndex: 1 });
  });

  it('delegates every other part to the pure normalizer', () => {
    const normalize = createVercelStreamNormalizer();
    expect(normalize({ type: 'text-delta', id: 't1', text: 'hi' })).toEqual(
      normalizeVercelStreamPart({ type: 'text-delta', id: 't1', text: 'hi' }),
    );
    expect(normalize({ type: 'start-step' })).toEqual([]);
  });

  it('reports an incomplete step as a diagnostic rather than a zero', () => {
    const normalize = createVercelStreamNormalizer();
    expect(
      normalize({ type: 'finish-step', usage: { outputTokens: 4 } }),
    ).toEqual([
      expect.objectContaining({
        kind: 'diagnostic',
        code: 'step-usage-unavailable',
      }),
    ]);
    // A rejected step still consumes its index, so later steps stay aligned.
    expect(
      normalize({
        type: 'finish-step',
        usage: { inputTokens: 7, outputTokens: 1, totalTokens: 8 },
      })[0],
    ).toMatchObject({ kind: 'step-usage', stepIndex: 2 });
  });
});
