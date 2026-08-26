import { describe, expect, it } from 'vitest';

import { normalizeVercelStreamPart } from './normalizer.js';

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
