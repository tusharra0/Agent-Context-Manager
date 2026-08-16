import { z } from 'zod';

export const ContextEventKindSchema = z.enum([
  'system',
  'user_message',
  'assistant_message',
  'tool_call',
  'tool_result',
  'file_read',
  'file_write',
  'search_result',
  'test_result',
  'build_result',
  'decision',
  'state_update',
]);

export const ContextEventSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  kind: ContextEventKindSchema,
  createdAt: z.iso.datetime(),
  payload: z.unknown(),
  rawArtifactUri: z.string().min(1).optional(),
  contentHash: z.string().min(1).optional(),
  tokenEstimate: z.number().int().nonnegative().optional(),
});

export type ContextEventKind = z.infer<typeof ContextEventKindSchema>;
export type ContextEvent = z.infer<typeof ContextEventSchema>;

export const ProvenancedValueSchema = z.object({
  value: z.string().min(1),
  sourceEventIds: z.array(z.string().min(1)).min(1),
  status: z.enum(['active', 'resolved', 'superseded']).default('active'),
});

export const DurableWorkingStateSchema = z.object({
  goal: z.string().default(''),
  requirements: z.array(ProvenancedValueSchema).default([]),
  decisions: z.array(ProvenancedValueSchema).default([]),
  filesRead: z.array(z.string()).default([]),
  filesModified: z.array(z.string()).default([]),
  currentFailures: z.array(ProvenancedValueSchema).default([]),
  resolvedFailures: z.array(ProvenancedValueSchema).default([]),
  remainingWork: z.array(ProvenancedValueSchema).default([]),
  updatedAt: z.iso.datetime(),
});

export type DurableWorkingState = z.infer<typeof DurableWorkingStateSchema>;
