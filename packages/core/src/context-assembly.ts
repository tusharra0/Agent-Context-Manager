import { z } from 'zod';

import { EventIdSchema, StateItemIdSchema } from './identifiers.js';

export const ContextCandidateV1Schema = z
  .object({
    id: z.string().min(1),
    class: z.enum([
      'instruction',
      'goal',
      'requirement',
      'active-failure',
      'decision',
      'working-state',
      'file-observation',
      'recent-observation',
      'completed-outcome',
    ]),
    required: z.boolean(),
    sequence: z.number().int().nonnegative(),
    text: z.string().min(1),
    sourceEventIds: z.array(EventIdSchema),
    stateItemId: StateItemIdSchema.optional(),
  })
  .strict();

export const ContextExcludedCandidateV1Schema = z
  .object({
    id: z.string().min(1),
    reason: z.enum(['budget', 'unsafe', 'superseded']),
  })
  .strict();

export const ContextAssemblyManifestV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    policyId: z.string().min(1),
    tokenEstimatorId: z.string().min(1),
    requestedTokenBudget: z.number().int().nonnegative(),
    assembledTokenEstimate: z.number().int().nonnegative(),
    status: z.enum(['within-budget', 'mandatory-overflow']),
    includedCandidateIds: z.array(z.string().min(1)),
    excludedCandidates: z.array(ContextExcludedCandidateV1Schema),
  })
  .strict();

export type ContextCandidateV1 = z.infer<typeof ContextCandidateV1Schema>;
export type ContextExcludedCandidateV1 = z.infer<
  typeof ContextExcludedCandidateV1Schema
>;
export type ContextAssemblyManifestV1 = z.infer<
  typeof ContextAssemblyManifestV1Schema
>;
