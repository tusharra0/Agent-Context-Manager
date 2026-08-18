import { z } from 'zod';

import { EventIdSchema, SessionIdSchema } from './identifiers.js';
import { JsonValueSchema } from './json.js';
import {
  ArtifactUriSchema,
  ReductionDiagnosticSchema,
  Sha256DigestSchema,
  TestResultObservationV1Schema,
} from './test-result.js';

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
  id: EventIdSchema,
  sessionId: SessionIdSchema,
  kind: ContextEventKindSchema,
  createdAt: z.iso.datetime({ offset: true }),
  payload: JsonValueSchema,
  rawArtifactUri: ArtifactUriSchema.optional(),
  contentHash: Sha256DigestSchema.optional(),
  byteLength: z.number().int().nonnegative().optional(),
  tokenEstimate: z.number().int().nonnegative().optional(),
});

export const PersistedContextEventV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    id: EventIdSchema,
    sessionId: SessionIdSchema,
    sequence: z.number().int().positive(),
    kind: z.literal('test_result'),
    createdAt: z.iso.datetime({ offset: true }),
    payload: TestResultObservationV1Schema,
    rawArtifactUri: ArtifactUriSchema,
    contentHash: Sha256DigestSchema,
    byteLength: z.number().int().nonnegative(),
  })
  .strict();

export const ReductionRecordSchema = z
  .object({
    sourceEventId: EventIdSchema,
    reducerId: z.string().min(1),
    reducerVersion: z.string().min(1),
    reducedText: z.string(),
    rawArtifactUri: ArtifactUriSchema,
    safeForContext: z.boolean(),
    preservedFields: z.array(z.string().startsWith('/')),
    diagnostics: z.array(ReductionDiagnosticSchema),
  })
  .strict();

export type ContextEventKind = z.infer<typeof ContextEventKindSchema>;
export type ContextEvent = z.infer<typeof ContextEventSchema>;
export type PersistedContextEventV1 = z.infer<
  typeof PersistedContextEventV1Schema
>;
export type ReductionRecord = z.infer<typeof ReductionRecordSchema>;
