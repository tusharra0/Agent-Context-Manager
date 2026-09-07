import { JsonValueSchema, type JsonValue } from '@acm/core';
import type { HarnessEventDataV1 } from '@acm/harness-port';

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function nonemptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function json(value: unknown): JsonValue | undefined {
  const parsed = JsonValueSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) return error.message;
  if (typeof error === 'string' && error.length > 0) return error;
  const value = json(error);
  return value === undefined
    ? 'The vendor stream reported an unknown error.'
    : JSON.stringify(value);
}

function diagnostic(
  code: string,
  message: string,
  part: unknown,
): HarnessEventDataV1 {
  const rawPart = json(part);
  return {
    kind: 'diagnostic',
    code,
    message,
    ...(rawPart === undefined ? {} : { rawPart }),
  };
}

function tokenCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function usageEvent(usage: unknown): HarnessEventDataV1 {
  const usageRecord = record(usage) ?? {};
  const inputTokens = tokenCount(usageRecord.inputTokens);
  const outputTokens = tokenCount(usageRecord.outputTokens);
  const reportedTotal = tokenCount(usageRecord.totalTokens);
  if (
    inputTokens === undefined ||
    outputTokens === undefined ||
    (usageRecord.totalTokens !== undefined && reportedTotal === undefined) ||
    !Number.isSafeInteger(inputTokens + outputTokens)
  ) {
    return diagnostic(
      'usage-unavailable',
      'Complete valid input and output token usage was not reported for this turn.',
      usage,
    );
  }
  const details = json(usage);
  return {
    kind: 'usage',
    inputTokens,
    outputTokens,
    totalTokens: reportedTotal ?? inputTokens + outputTokens,
    ...(details === undefined ? {} : { details }),
  };
}

const STRUCTURAL_PARTS = new Set([
  'start',
  'start-step',
  'finish-step',
  'text-start',
  'text-end',
  'reasoning-start',
  'reasoning-end',
  'tool-input-start',
  'tool-input-delta',
  'tool-input-end',
]);

/** Converts one AI SDK stream part into zero or more stable ACM events. */
export function normalizeVercelStreamPart(part: unknown): HarnessEventDataV1[] {
  const value = record(part);
  const type = nonemptyString(value?.type);
  if (value === undefined || type === undefined) {
    return [
      diagnostic(
        'invalid-vendor-part',
        'The vendor emitted a stream part without a string type.',
        part,
      ),
    ];
  }

  if (STRUCTURAL_PARTS.has(type)) return [];

  switch (type) {
    case 'text-delta': {
      if (typeof value.text !== 'string') {
        return [
          diagnostic(
            'invalid-text-delta',
            'A text delta did not contain string text.',
            part,
          ),
        ];
      }
      return [{ kind: 'text-delta', text: value.text }];
    }
    case 'reasoning-delta': {
      if (typeof value.text !== 'string') {
        return [
          diagnostic(
            'invalid-reasoning-delta',
            'A reasoning delta did not contain string text.',
            part,
          ),
        ];
      }
      return [{ kind: 'reasoning-delta', text: value.text }];
    }
    case 'tool-call': {
      const toolCallId = nonemptyString(value.toolCallId);
      const toolName = nonemptyString(value.toolName);
      const input = json(value.input);
      if (
        toolCallId === undefined ||
        toolName === undefined ||
        input === undefined
      ) {
        return [
          diagnostic(
            'invalid-tool-call',
            'A tool call was missing its ID, name, or JSON input.',
            part,
          ),
        ];
      }
      return [{ kind: 'tool-call', toolCallId, toolName, input }];
    }
    case 'tool-result': {
      const toolCallId = nonemptyString(value.toolCallId);
      const toolName = nonemptyString(value.toolName);
      const output = json(value.output);
      if (
        toolCallId === undefined ||
        toolName === undefined ||
        output === undefined
      ) {
        return [
          diagnostic(
            'invalid-tool-result',
            'A tool result was missing its ID, name, or JSON output.',
            part,
          ),
        ];
      }
      return [
        { kind: 'tool-result', toolCallId, toolName, output, isError: false },
      ];
    }
    case 'tool-error': {
      const toolCallId = nonemptyString(value.toolCallId);
      const toolName = nonemptyString(value.toolName);
      if (toolCallId === undefined || toolName === undefined) {
        return [
          diagnostic(
            'invalid-tool-error',
            'A tool error was missing its ID or name.',
            part,
          ),
        ];
      }
      return [
        {
          kind: 'tool-result',
          toolCallId,
          toolName,
          output: { error: errorMessage(value.error) },
          isError: true,
        },
      ];
    }
    case 'finish': {
      const finishReason = nonemptyString(value.finishReason) ?? 'unknown';
      const rawFinishReason = nonemptyString(value.rawFinishReason);
      return [
        usageEvent(value.totalUsage),
        {
          kind: 'turn-completed',
          finishReason,
          ...(rawFinishReason === undefined ? {} : { rawFinishReason }),
        },
      ];
    }
    case 'abort': {
      const reason = nonemptyString(value.reason);
      return [
        reason === undefined
          ? { kind: 'interrupted' }
          : { kind: 'interrupted', reason },
      ];
    }
    case 'error':
      return [{ kind: 'error', message: errorMessage(value.error) }];
    default:
      return [
        diagnostic(
          'unrecognized-vendor-part',
          `The vendor emitted an unrecognized ${JSON.stringify(type)} stream part.`,
          part,
        ),
      ];
  }
}
