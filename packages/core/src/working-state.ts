import { z } from 'zod';

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
  updatedAt: z.iso.datetime({ offset: true }),
});

export type DurableWorkingState = z.infer<typeof DurableWorkingStateSchema>;
