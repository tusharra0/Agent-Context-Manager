import { z } from 'zod';

import {
  JsonValueSchema,
  SessionIdSchema,
  type JsonValue,
  type SessionId,
} from '@acm/core';

export const HarnessKindSchema = z.enum(['codex', 'claude-code']);

export const CreateHarnessSessionInputV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    sessionId: SessionIdSchema,
    instructions: z.string().min(1).optional(),
    metadata: JsonValueSchema.optional(),
  })
  .strict();

export const HarnessTurnInputV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    prompt: z.string().min(1),
    workspaceRevision: z.string().min(1),
  })
  .strict();

const SessionStartedDataV1Schema = z
  .object({
    kind: z.literal('session-started'),
    vendorSessionId: z.string().min(1),
  })
  .strict();

const TextDeltaDataV1Schema = z
  .object({
    kind: z.literal('text-delta'),
    text: z.string(),
  })
  .strict();

const ReasoningDeltaDataV1Schema = z
  .object({
    kind: z.literal('reasoning-delta'),
    text: z.string(),
  })
  .strict();

const ToolCallDataV1Schema = z
  .object({
    kind: z.literal('tool-call'),
    toolCallId: z.string().min(1),
    toolName: z.string().min(1),
    input: JsonValueSchema,
    workspaceRevision: z.string().min(1).nullable().optional(),
  })
  .strict();

const ToolResultDataV1Schema = z
  .object({
    kind: z.literal('tool-result'),
    toolCallId: z.string().min(1),
    toolName: z.string().min(1),
    output: JsonValueSchema,
    isError: z.boolean(),
  })
  .strict();

const UsageDataV1Schema = z
  .object({
    kind: z.literal('usage'),
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    totalTokens: z.number().int().nonnegative(),
    cachedInputTokens: z.number().int().nonnegative().optional(),
    details: JsonValueSchema.optional(),
  })
  .strict();

/**
 * Usage for one model request inside a turn. A turn can issue many requests,
 * and `usage` reports only the turn total, which hides how the request input
 * grows step by step. Per-step usage is what makes a compounding context
 * reduction visible; a turn total cannot distinguish it from a one-time saving.
 *
 * `stepIndex` is per turn and starts at 1. Sessions renumber across turns.
 */
const StepUsageDataV1Schema = z
  .object({
    kind: z.literal('step-usage'),
    stepIndex: z.number().int().positive(),
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    totalTokens: z.number().int().nonnegative(),
    cachedInputTokens: z.number().int().nonnegative().optional(),
    details: JsonValueSchema.optional(),
  })
  .strict();

const TurnCompletedDataV1Schema = z
  .object({
    kind: z.literal('turn-completed'),
    finishReason: z.string().min(1),
    rawFinishReason: z.string().min(1).optional(),
  })
  .strict();

const InterruptedDataV1Schema = z
  .object({
    kind: z.literal('interrupted'),
    reason: z.string().min(1).optional(),
  })
  .strict();

const DiagnosticDataV1Schema = z
  .object({
    kind: z.literal('diagnostic'),
    code: z.string().min(1),
    message: z.string().min(1),
    rawPart: JsonValueSchema.optional(),
  })
  .strict();

const ErrorDataV1Schema = z
  .object({
    kind: z.literal('error'),
    message: z.string().min(1),
  })
  .strict();

const SessionDestroyedDataV1Schema = z
  .object({
    kind: z.literal('session-destroyed'),
  })
  .strict();

export const HarnessEventDataV1Schema = z.discriminatedUnion('kind', [
  SessionStartedDataV1Schema,
  TextDeltaDataV1Schema,
  ReasoningDeltaDataV1Schema,
  ToolCallDataV1Schema,
  ToolResultDataV1Schema,
  UsageDataV1Schema,
  StepUsageDataV1Schema,
  TurnCompletedDataV1Schema,
  InterruptedDataV1Schema,
  DiagnosticDataV1Schema,
  ErrorDataV1Schema,
  SessionDestroyedDataV1Schema,
]);

const HarnessEventEnvelopeV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    sessionId: SessionIdSchema,
    harness: HarnessKindSchema,
    sequence: z.number().int().positive(),
    createdAt: z.iso.datetime({ offset: true }),
  })
  .strict();

const eventSchema = <T extends z.ZodRawShape>(shape: T) =>
  HarnessEventEnvelopeV1Schema.extend(shape).strict();

export const HarnessEventV1Schema = z.discriminatedUnion('kind', [
  eventSchema(SessionStartedDataV1Schema.shape),
  eventSchema(TextDeltaDataV1Schema.shape),
  eventSchema(ReasoningDeltaDataV1Schema.shape),
  eventSchema(ToolCallDataV1Schema.shape),
  eventSchema(ToolResultDataV1Schema.shape),
  eventSchema(UsageDataV1Schema.shape),
  eventSchema(StepUsageDataV1Schema.shape),
  eventSchema(TurnCompletedDataV1Schema.shape),
  eventSchema(InterruptedDataV1Schema.shape),
  eventSchema(DiagnosticDataV1Schema.shape),
  eventSchema(ErrorDataV1Schema.shape),
  eventSchema(SessionDestroyedDataV1Schema.shape),
]);

export type HarnessKind = z.infer<typeof HarnessKindSchema>;
export type CreateHarnessSessionInputV1 = z.infer<
  typeof CreateHarnessSessionInputV1Schema
>;
export type HarnessTurnInputV1 = z.infer<typeof HarnessTurnInputV1Schema>;
export type HarnessEventDataV1 = z.infer<typeof HarnessEventDataV1Schema>;
export type HarnessEventV1 = z.infer<typeof HarnessEventV1Schema>;

/** Runtime controls are separate from the serializable session/turn input. */
export interface HarnessExecutionOptions {
  abortSignal?: AbortSignal;
}

export interface AgentHarnessSession {
  readonly id: SessionId;
  readonly harness: HarnessKind;
  readonly startedEvent: HarnessEventV1;
  stream(
    input: HarnessTurnInputV1,
    options?: HarnessExecutionOptions,
  ): AsyncIterable<HarnessEventV1>;
  interrupt(reason?: string): Promise<void>;
  destroy(): Promise<HarnessEventV1>;
}

export interface AgentHarnessPort {
  readonly harness: HarnessKind;
  createSession(
    input: CreateHarnessSessionInputV1,
    options?: HarnessExecutionOptions,
  ): Promise<AgentHarnessSession>;
}

export interface HarnessSessionDriver {
  readonly vendorSessionId: string;
  streamTurn(
    input: HarnessTurnInputV1,
    signal: AbortSignal,
  ): AsyncIterable<HarnessEventDataV1>;
  destroy(): Promise<void>;
}

export interface HarnessEventFactoryOptions {
  sessionId: SessionId;
  harness: HarnessKind;
  now?: () => Date;
}

export type { JsonValue };
