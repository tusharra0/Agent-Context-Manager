import { z } from 'zod';

import { EventIdSchema, SessionIdSchema } from './identifiers.js';
import { JsonValueSchema } from './json.js';
import {
  ArtifactUriSchema,
  ReductionDiagnosticSchema,
  Sha256DigestSchema,
  TestResultObservationV1Schema,
} from './test-result.js';
import {
  BuildResultObservationV1Schema,
  FileReadObservationV1Schema,
  SearchResultObservationV1Schema,
} from './observations.js';
import { WorkingStateTransitionV1Schema } from './working-state.js';

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

const PersistedEventBaseV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    id: EventIdSchema,
    sessionId: SessionIdSchema,
    sequence: z.number().int().positive(),
    createdAt: z.iso.datetime({ offset: true }),
    rawArtifactUri: ArtifactUriSchema,
    contentHash: Sha256DigestSchema,
    byteLength: z.number().int().nonnegative(),
  })
  .strict();

export const PersistedFileReadEventV1Schema = PersistedEventBaseV1Schema.extend(
  {
    kind: z.literal('file_read'),
    payload: FileReadObservationV1Schema,
  },
).strict();

export const PersistedSearchResultEventV1Schema =
  PersistedEventBaseV1Schema.extend({
    kind: z.literal('search_result'),
    payload: SearchResultObservationV1Schema,
  }).strict();

export const PersistedBuildResultEventV1Schema =
  PersistedEventBaseV1Schema.extend({
    kind: z.literal('build_result'),
    payload: BuildResultObservationV1Schema,
  }).strict();

export const PersistedStateUpdateEventV1Schema =
  PersistedEventBaseV1Schema.extend({
    kind: z.literal('state_update'),
    payload: WorkingStateTransitionV1Schema,
  }).strict();

export const PersistedAnyContextEventV1Schema = z.union([
  PersistedContextEventV1Schema,
  PersistedFileReadEventV1Schema,
  PersistedSearchResultEventV1Schema,
  PersistedBuildResultEventV1Schema,
  PersistedStateUpdateEventV1Schema,
]);

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
export type PersistedAnyContextEventV1 = z.infer<
  typeof PersistedAnyContextEventV1Schema
>;
export type ReductionRecord = z.infer<typeof ReductionRecordSchema>;
