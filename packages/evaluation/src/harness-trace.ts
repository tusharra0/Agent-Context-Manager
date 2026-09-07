import { z } from 'zod';

import { JsonValueSchema, type JsonValue } from '@acm/core';
import {
  HarnessEventV1Schema,
  HarnessKindSchema,
  type HarnessEventV1,
} from '@acm/harness-port';

import {
  ConditionEvidenceV1Schema,
  EvaluationConditionSchema,
  NormalizedAgentActionV1Schema,
  TaskOutcomeV1Schema,
  type ConditionEvidenceV1,
  type NormalizedAgentActionV1,
  type RecordedActionV1,
} from './schemas.js';

const StableNameSchema = z
  .string()
  .min(1)
  .regex(/^[a-z0-9][a-z0-9._/-]*$/u);

export const HarnessTraceTurnV1Schema = z
  .object({
    checkpointId: StableNameSchema.optional(),
    workspaceRevision: z.string().min(1),
    events: z.array(HarnessEventV1Schema),
  })
  .strict();

export const RecordedHarnessEvidenceInputV1Schema = z
  .object({
    condition: EvaluationConditionSchema,
    harness: HarnessKindSchema,
    model: z.string().min(1),
    turns: z.array(HarnessTraceTurnV1Schema),
    outcome: TaskOutcomeV1Schema,
    latencyMs: z.number().nonnegative().optional(),
    costUsd: z.number().nonnegative().optional(),
  })
  .strict();

export type HarnessTraceTurnV1 = z.infer<typeof HarnessTraceTurnV1Schema>;
export type RecordedHarnessEvidenceInputV1 = z.infer<
  typeof RecordedHarnessEvidenceInputV1Schema
>;

function inputRecord(input: JsonValue): Record<string, JsonValue> | undefined {
  return input !== null && !Array.isArray(input) && typeof input === 'object'
    ? input
    : undefined;
}

function stringValues(value: JsonValue | undefined): string[] {
  if (typeof value === 'string' && value.length > 0) return [value];
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is string => typeof item === 'string' && item.length > 0,
  );
}

function targetsFor(input: JsonValue): string[] {
  const value = inputRecord(input);
  if (value === undefined) return [];
  const keys = [
    'file_path',
    'filePath',
    'path',
    'paths',
    'pattern',
    'query',
    'command',
  ];
  return Array.from(new Set(keys.flatMap((key) => stringValues(value[key]))));
}

function actionKind(toolName: string, input: JsonValue) {
  const normalized = toolName.toLowerCase().replaceAll('_', '-');
  if (['read', 'read-file', 'readfile'].includes(normalized)) {
    return 'read-file' as const;
  }
  if (
    ['grep', 'glob', 'search', 'web-search', 'websearch', 'find'].includes(
      normalized,
    )
  ) {
    return 'search' as const;
  }
  if (
    [
      'write',
      'edit',
      'edit-file',
      'apply-patch',
      'file-change',
      'filechange',
    ].includes(normalized)
  ) {
    return 'edit-file' as const;
  }
  if (['test', 'run-tests'].includes(normalized)) return 'test' as const;
  if (
    ['bash', 'shell', 'exec', 'exec-command', 'run-command'].includes(
      normalized,
    )
  ) {
    const command = inputRecord(input)?.command;
    if (
      typeof command === 'string' &&
      /(?:^|\s)(?:pnpm|npm|yarn|bun)?\s*(?:test|check)(?:\s|$)|\b(?:vitest|jest|pytest)\b/u.test(
        command,
      )
    ) {
      return 'test' as const;
    }
    return 'run-command' as const;
  }
  return 'other' as const;
}

export function normalizeHarnessToolCall(
  event: Extract<HarnessEventV1, { kind: 'tool-call' }>,
): NormalizedAgentActionV1 {
  return NormalizedAgentActionV1Schema.parse({
    kind: actionKind(event.toolName, event.input),
    name: event.toolName,
    arguments: event.input,
    targets: targetsFor(event.input),
  });
}

function actionsForTurn(turn: HarnessTraceTurnV1): RecordedActionV1[] {
  const calls = turn.events
    .filter(
      (event): event is Extract<HarnessEventV1, { kind: 'tool-call' }> =>
        event.kind === 'tool-call',
    )
    .map((event) => ({
      action: normalizeHarnessToolCall(event),
      // A turn-level snapshot cannot establish the workspace before each tool.
      workspaceRevision: event.workspaceRevision ?? null,
    }));
  if (calls.length > 0) return calls;

  const text = turn.events
    .filter(
      (event): event is Extract<HarnessEventV1, { kind: 'text-delta' }> =>
        event.kind === 'text-delta',
    )
    .map((event) => event.text)
    .join('');
  if (text.length > 0) {
    return [
      {
        action: NormalizedAgentActionV1Schema.parse({
          kind: 'respond',
          name: 'assistant-response',
          arguments: { text },
          targets: [],
        }),
        workspaceRevision: turn.workspaceRevision,
      },
    ];
  }

  if (turn.events.some((event) => event.kind === 'turn-completed')) {
    return [
      {
        action: NormalizedAgentActionV1Schema.parse({
          kind: 'finish',
          name: 'turn-completed',
          arguments: null,
          targets: [],
        }),
        workspaceRevision: turn.workspaceRevision,
      },
    ];
  }
  return [];
}

/** Builds Phase 3 evidence from provider-neutral Phase 4 traces. */
export function buildConditionEvidenceFromHarnessTrace(
  input: RecordedHarnessEvidenceInputV1,
): ConditionEvidenceV1 {
  const parsedInput = RecordedHarnessEvidenceInputV1Schema.parse(input);
  let previousSequence = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let completeUsage = parsedInput.turns.length > 0;
  const actions: RecordedActionV1[] = [];
  const checkpointActions: ConditionEvidenceV1['checkpointActions'] = [];

  for (const turn of parsedInput.turns) {
    let usageEvents = 0;
    let turnCompleted = false;
    let interrupted = false;
    for (const event of turn.events) {
      if (event.harness !== parsedInput.harness) {
        throw new TypeError(
          `Trace event harness ${event.harness} does not match ${parsedInput.harness}.`,
        );
      }
      if (event.sequence <= previousSequence) {
        throw new TypeError('Harness trace event sequences must increase.');
      }
      previousSequence = event.sequence;
      if (event.kind === 'usage') {
        usageEvents += 1;
        inputTokens += event.inputTokens;
        outputTokens += event.outputTokens;
      }
      if (event.kind === 'turn-completed') turnCompleted = true;
      if (event.kind === 'interrupted' || event.kind === 'error') {
        interrupted = true;
      }
    }
    // Partial or duplicate totals must never look like complete run usage.
    completeUsage &&= usageEvents === 1 && turnCompleted && !interrupted;

    const turnActions = actionsForTurn(turn);
    actions.push(...turnActions);
    if (turn.checkpointId !== undefined) {
      const nextAction = turnActions[0]?.action;
      if (nextAction === undefined) {
        throw new TypeError(
          `Checkpoint ${turn.checkpointId} has no normalized next action.`,
        );
      }
      checkpointActions.push({
        checkpointId: turn.checkpointId,
        nextAction,
      });
    }
  }

  return ConditionEvidenceV1Schema.parse({
    condition: parsedInput.condition,
    producer: {
      kind: 'recorded-harness',
      harness: parsedInput.harness,
      model: parsedInput.model,
    },
    checkpointActions,
    actions,
    outcome: parsedInput.outcome,
    ...(completeUsage
      ? {
          inputTokens,
          outputTokens,
          tokenSource: 'ai-sdk-harness-stream@1',
        }
      : {}),
    ...(parsedInput.latencyMs === undefined
      ? {}
      : { latencyMs: parsedInput.latencyMs }),
    ...(parsedInput.costUsd === undefined
      ? {}
      : { costUsd: parsedInput.costUsd }),
  });
}

export function validateHarnessTraceEvent(event: unknown): HarnessEventV1 {
  return HarnessEventV1Schema.parse(event);
}

export function validateHarnessTraceJson(value: unknown): JsonValue {
  return JsonValueSchema.parse(value);
}
