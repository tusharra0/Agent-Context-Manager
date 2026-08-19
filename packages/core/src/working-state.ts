import { z } from 'zod';

import {
  EventIdSchema,
  SessionIdSchema,
  StateItemIdSchema,
} from './identifiers.js';
import { ArtifactUriSchema, Sha256DigestSchema } from './test-result.js';

export const EvidenceReferenceV1Schema = z
  .object({
    sourceEventId: EventIdSchema,
    jsonPointer: z.string().startsWith('/').optional(),
    artifactUri: ArtifactUriSchema.optional(),
  })
  .strict();

const FactStatusSchema = z.enum([
  'active',
  'resolved',
  'completed',
  'superseded',
]);
const RetentionSchema = z.enum(['required', 'preferred']);

export const WorkingFactV1Schema = z
  .object({
    id: StateItemIdSchema,
    text: z.string().min(1),
    status: FactStatusSchema,
    retention: RetentionSchema,
    provenance: z.array(EvidenceReferenceV1Schema).min(1),
    introducedAtSequence: z.number().int().positive(),
    updatedAtSequence: z.number().int().positive(),
    supersedes: StateItemIdSchema.optional(),
  })
  .strict();

export const WorkingFileV1Schema = z
  .object({
    id: StateItemIdSchema,
    path: z.string().min(1),
    pathKind: z.enum(['repository-relative', 'absolute', 'virtual']),
    status: z.enum(['current', 'stale']),
    contentHash: Sha256DigestSchema.optional(),
    modified: z.boolean(),
    provenance: z.array(EvidenceReferenceV1Schema).min(1),
    introducedAtSequence: z.number().int().positive(),
    updatedAtSequence: z.number().int().positive(),
    supersedes: StateItemIdSchema.optional(),
  })
  .strict();

export const TestStatusV1Schema = z
  .object({
    status: z.enum(['passed', 'failed', 'partial', 'unknown']),
    summary: z.string().min(1),
    provenance: z.array(EvidenceReferenceV1Schema).min(1),
    updatedAtSequence: z.number().int().positive(),
  })
  .strict();

export const DurableWorkingStateV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    sessionId: SessionIdSchema,
    revision: z.number().int().nonnegative(),
    throughSequence: z.number().int().nonnegative(),
    goal: WorkingFactV1Schema.optional(),
    requirements: z.array(WorkingFactV1Schema),
    decisions: z.array(WorkingFactV1Schema),
    files: z.array(WorkingFileV1Schema),
    failures: z.array(WorkingFactV1Schema),
    workItems: z.array(WorkingFactV1Schema),
    testStatus: TestStatusV1Schema.optional(),
    updatedAt: z.iso.datetime({ offset: true }),
  })
  .strict()
  .superRefine((state, context) => {
    const entries = [
      ...(state.goal ? [{ category: 'goal', item: state.goal }] : []),
      ...state.requirements.map((item) => ({ category: 'requirement', item })),
      ...state.decisions.map((item) => ({ category: 'decision', item })),
      ...state.failures.map((item) => ({ category: 'failure', item })),
      ...state.workItems.map((item) => ({ category: 'work-item', item })),
    ];
    const allowed: Record<string, readonly WorkingFactV1['status'][]> = {
      goal: ['active'],
      requirement: ['active', 'superseded'],
      decision: ['active', 'superseded'],
      failure: ['active', 'resolved'],
      'work-item': ['active', 'completed', 'superseded'],
    };
    const ids = new Set<string>();
    for (const { category, item } of entries) {
      if (!allowed[category]!.includes(item.status)) {
        context.addIssue({
          code: 'custom',
          message: `Status ${item.status} is invalid for ${category}.`,
        });
      }
      if (ids.has(item.id)) {
        context.addIssue({
          code: 'custom',
          message: `Duplicate state item ID: ${item.id}`,
        });
      }
      ids.add(item.id);
      if (
        item.introducedAtSequence > item.updatedAtSequence ||
        item.updatedAtSequence > state.throughSequence
      ) {
        context.addIssue({
          code: 'custom',
          message: `State item sequence is inconsistent: ${item.id}`,
        });
      }
    }
    const currentFiles = new Set<string>();
    for (const file of state.files) {
      if (ids.has(file.id)) {
        context.addIssue({
          code: 'custom',
          message: `Duplicate state item ID: ${file.id}`,
        });
      }
      ids.add(file.id);
      if (
        file.introducedAtSequence > file.updatedAtSequence ||
        file.updatedAtSequence > state.throughSequence
      ) {
        context.addIssue({
          code: 'custom',
          message: `File-state sequence is inconsistent: ${file.id}`,
        });
      }
      if (file.status === 'current') {
        const key = `${file.pathKind}\u0000${file.path}`;
        if (currentFiles.has(key)) {
          context.addIssue({
            code: 'custom',
            message: `Multiple current file states exist for ${file.path}.`,
          });
        }
        currentFiles.add(key);
      }
    }
    if (
      state.testStatus &&
      state.testStatus.updatedAtSequence > state.throughSequence
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Test status is newer than the working-state sequence.',
      });
    }
  });

const NewFactFieldsSchema = z
  .object({
    itemId: StateItemIdSchema,
    text: z.string().min(1),
    retention: RetentionSchema.optional(),
    provenance: z.array(EvidenceReferenceV1Schema).min(1),
    supersedes: StateItemIdSchema.optional(),
  })
  .strict();

const SetGoalOperationSchema = NewFactFieldsSchema.extend({
  operation: z.literal('set-goal'),
}).strict();

const AddFactOperationSchema = NewFactFieldsSchema.extend({
  operation: z.literal('add-fact'),
  category: z.enum(['requirement', 'decision', 'failure', 'work-item']),
}).strict();

const ChangeFactStatusOperationSchema = z
  .object({
    operation: z.literal('change-fact-status'),
    category: z.enum(['requirement', 'decision', 'failure', 'work-item']),
    itemId: StateItemIdSchema,
    status: FactStatusSchema,
    provenance: z.array(EvidenceReferenceV1Schema).min(1),
  })
  .strict();

const RecordFileOperationSchema = z
  .object({
    operation: z.literal('record-file'),
    itemId: StateItemIdSchema,
    path: z.string().min(1),
    pathKind: z.enum(['repository-relative', 'absolute', 'virtual']),
    contentHash: Sha256DigestSchema.optional(),
    modified: z.boolean(),
    provenance: z.array(EvidenceReferenceV1Schema).min(1),
    supersedes: StateItemIdSchema.optional(),
  })
  .strict();

const SetTestStatusOperationSchema = z
  .object({
    operation: z.literal('set-test-status'),
    status: z.enum(['passed', 'failed', 'partial', 'unknown']),
    summary: z.string().min(1),
    provenance: z.array(EvidenceReferenceV1Schema).min(1),
  })
  .strict();

export const WorkingStateOperationV1Schema = z.discriminatedUnion('operation', [
  SetGoalOperationSchema,
  AddFactOperationSchema,
  ChangeFactStatusOperationSchema,
  RecordFileOperationSchema,
  SetTestStatusOperationSchema,
]);

export const WorkingStateTransitionV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    expectedRevision: z.number().int().nonnegative(),
    operations: z.array(WorkingStateOperationV1Schema).min(1),
  })
  .strict();

export type EvidenceReferenceV1 = z.infer<typeof EvidenceReferenceV1Schema>;
export type WorkingFactV1 = z.infer<typeof WorkingFactV1Schema>;
export type WorkingFileV1 = z.infer<typeof WorkingFileV1Schema>;
export type TestStatusV1 = z.infer<typeof TestStatusV1Schema>;
export type DurableWorkingStateV1 = z.infer<typeof DurableWorkingStateV1Schema>;
export type WorkingStateOperationV1 = z.infer<
  typeof WorkingStateOperationV1Schema
>;
export type WorkingStateTransitionV1 = z.infer<
  typeof WorkingStateTransitionV1Schema
>;

export const DurableWorkingStateSchema = DurableWorkingStateV1Schema;
export type DurableWorkingState = DurableWorkingStateV1;
