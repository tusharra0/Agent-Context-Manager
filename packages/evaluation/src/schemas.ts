import { z } from 'zod';

import {
  ContextAssemblyManifestV1Schema,
  ContextCandidateV1Schema,
  DurableWorkingStateV1Schema,
  EventIdSchema,
  JsonValueSchema,
  Sha256DigestSchema,
} from '@acm/core';

const StableNameSchema = z
  .string()
  .min(1)
  .regex(/^[a-z0-9][a-z0-9._/-]*$/u);

export const EvaluationConditionSchema = z.enum(['raw', 'managed']);

export const RepositoryFixtureV1Schema = z
  .object({
    id: StableNameSchema,
    revision: z.string().min(1),
  })
  .strict();

export const EvaluationProducerV1Schema = z
  .object({
    kind: z.enum(['synthetic', 'recorded-harness']),
    harness: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((producer, context) => {
    if (
      producer.kind === 'recorded-harness' &&
      (!producer.harness || !producer.model)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Recorded harness evidence requires harness and model IDs.',
      });
    }
  });

export const PinnedEvaluationInstructionV1Schema = z
  .object({
    id: StableNameSchema,
    text: z.string().min(1),
    sourceEventIds: z.array(EventIdSchema).default([]),
  })
  .strict();

export const ReplayObservationV1Schema = z
  .object({
    eventId: EventIdSchema,
    sequence: z.number().int().positive(),
    rawText: z.string(),
    contentHash: Sha256DigestSchema,
    safeForContext: z.boolean(),
    managedCandidate: ContextCandidateV1Schema,
  })
  .strict();

export const CriticalFieldLocatorV1Schema = z.discriminatedUnion('mode', [
  z
    .object({
      mode: z.literal('candidate-text'),
      candidateId: z.string().min(1),
    })
    .strict(),
  z
    .object({
      mode: z.literal('candidate-json-pointer'),
      candidateId: z.string().min(1),
      jsonPointer: z.string().startsWith('/'),
    })
    .strict(),
]);

export const CriticalFieldExpectationV1Schema = z
  .object({
    id: StableNameSchema,
    category: z.enum([
      'requirement',
      'active-failure',
      'modified-file',
      'remaining-work',
      'decision',
      'test-field',
      'build-field',
      'search-field',
    ]),
    sourceEventId: EventIdSchema,
    sourceText: z.string().min(1),
    expectedValue: JsonValueSchema,
    locator: CriticalFieldLocatorV1Schema,
  })
  .strict();

export const NormalizedAgentActionV1Schema = z
  .object({
    kind: z.enum([
      'read-file',
      'search',
      'run-command',
      'edit-file',
      'test',
      'respond',
      'finish',
      'other',
    ]),
    name: z.string().min(1),
    arguments: JsonValueSchema,
    targets: z.array(z.string().min(1)).default([]),
  })
  .strict();

export const RecordedActionV1Schema = z
  .object({
    action: NormalizedAgentActionV1Schema,
    workspaceRevision: z.string().min(1),
  })
  .strict();

export const TaskOutcomeV1Schema = z
  .object({
    success: z.boolean(),
    assertions: z
      .array(
        z
          .object({
            id: StableNameSchema,
            passed: z.boolean(),
            evidence: z.string().min(1).optional(),
          })
          .strict(),
      )
      .min(1),
  })
  .strict()
  .superRefine((outcome, context) => {
    if (outcome.success && outcome.assertions.some((item) => !item.passed)) {
      context.addIssue({
        code: 'custom',
        message: 'A successful outcome cannot contain a failed assertion.',
      });
    }
  });

export const ConditionEvidenceV1Schema = z
  .object({
    condition: EvaluationConditionSchema,
    producer: EvaluationProducerV1Schema,
    checkpointActions: z.array(
      z
        .object({
          checkpointId: StableNameSchema,
          nextAction: NormalizedAgentActionV1Schema,
        })
        .strict(),
    ),
    actions: z.array(RecordedActionV1Schema),
    outcome: TaskOutcomeV1Schema,
    inputTokens: z.number().int().nonnegative().optional(),
    outputTokens: z.number().int().nonnegative().optional(),
    tokenSource: z.string().min(1).optional(),
    latencyMs: z.number().nonnegative().optional(),
    costUsd: z.number().nonnegative().optional(),
  })
  .strict();

export const ConditionMeasurementsV1Schema = z
  .object({
    inputTokens: z.number().int().nonnegative().optional(),
    outputTokens: z.number().int().nonnegative().optional(),
    tokenSource: z.string().min(1).optional(),
    latencyMs: z.number().nonnegative().optional(),
    costUsd: z.number().nonnegative().optional(),
  })
  .strict();

export const ReplayCheckpointV1Schema = z
  .object({
    id: StableNameSchema,
    throughSequence: z.number().int().nonnegative(),
    tokenBudget: z.number().int().nonnegative(),
    state: DurableWorkingStateV1Schema,
    instructions: z.array(PinnedEvaluationInstructionV1Schema),
    observations: z.array(ReplayObservationV1Schema),
    criticalFields: z.array(CriticalFieldExpectationV1Schema),
    forcedCompaction: z.boolean().default(false),
  })
  .strict();

export const EvaluationCaseV1Schema = z
  .object({
    id: StableNameSchema,
    task: z.string().min(1),
    checkpoints: z.array(ReplayCheckpointV1Schema).min(1),
    rawEvidence: ConditionEvidenceV1Schema,
    managedEvidence: ConditionEvidenceV1Schema,
  })
  .strict();

export const EvaluationExperimentV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    id: StableNameSchema,
    name: z.string().min(1),
    createdAt: z.iso.datetime({ offset: true }),
    repositoryFixture: RepositoryFixtureV1Schema,
    policyId: z.string().min(1),
    tokenEstimatorId: z.string().min(1),
    cases: z.array(EvaluationCaseV1Schema).min(1),
  })
  .strict();

export const CriticalFieldResultV1Schema = z
  .object({
    id: StableNameSchema,
    category: CriticalFieldExpectationV1Schema.shape.category,
    preserved: z.boolean(),
    provenanceRetained: z.boolean(),
    sourceEventId: EventIdSchema,
    expectedValue: JsonValueSchema,
    actualValue: JsonValueSchema.optional(),
  })
  .strict();

export const PolicyFailureV1Schema = z
  .object({
    kind: z.enum([
      'missing-critical-field',
      'next-action-divergence',
      'baseline-success-managed-failure',
      'repeated-work-increase',
      'mandatory-overflow',
    ]),
    caseId: StableNameSchema,
    checkpointId: StableNameSchema.optional(),
    message: z.string().min(1),
    sourceEventIds: z.array(EventIdSchema),
    details: JsonValueSchema,
  })
  .strict();

export const EvaluationCheckpointResultV1Schema = z
  .object({
    checkpointId: StableNameSchema,
    rawTokenEstimate: z.number().int().nonnegative(),
    managedTokenEstimate: z.number().int().nonnegative(),
    tokenReduction: z.number().int(),
    tokenReductionPercent: z.number().nullable(),
    forcedCompaction: z.boolean(),
    recoveryPassed: z.boolean().nullable(),
    rawNextAction: NormalizedAgentActionV1Schema,
    managedNextAction: NormalizedAgentActionV1Schema,
    exactNextActionAgreement: z.boolean(),
    actionKindAgreement: z.boolean(),
    targetAgreement: z.number().min(0).max(1),
    criticalFields: z.array(CriticalFieldResultV1Schema),
    manifest: ContextAssemblyManifestV1Schema,
  })
  .strict();

export const EvaluationCaseResultV1Schema = z
  .object({
    caseId: StableNameSchema,
    checkpointResults: z.array(EvaluationCheckpointResultV1Schema).min(1),
    rawRepeatedActionCount: z.number().int().nonnegative(),
    managedRepeatedActionCount: z.number().int().nonnegative(),
    rawSuccess: z.boolean(),
    managedSuccess: z.boolean(),
    outcomeClassification: z.enum([
      'both-success',
      'raw-only-success',
      'managed-only-success',
      'neither-success',
    ]),
    rawActions: z.array(RecordedActionV1Schema),
    managedActions: z.array(RecordedActionV1Schema),
    rawOutcome: TaskOutcomeV1Schema,
    managedOutcome: TaskOutcomeV1Schema,
    rawProducer: EvaluationProducerV1Schema,
    managedProducer: EvaluationProducerV1Schema,
    rawMeasurements: ConditionMeasurementsV1Schema,
    managedMeasurements: ConditionMeasurementsV1Schema,
  })
  .strict();

export const EvaluationAggregateV1Schema = z
  .object({
    checkpointCount: z.number().int().nonnegative(),
    medianTokenReductionPercent: z.number().nullable(),
    exactNextActionAgreements: z.number().int().nonnegative(),
    exactNextActionAgreementRate: z.number().min(0).max(1).nullable(),
    criticalFieldsPreserved: z.number().int().nonnegative(),
    criticalFieldsTotal: z.number().int().nonnegative(),
    criticalFieldRecall: z.number().min(0).max(1).nullable(),
    rawTaskSuccesses: z.number().int().nonnegative(),
    managedTaskSuccesses: z.number().int().nonnegative(),
    baselineOnlyFailures: z.number().int().nonnegative(),
    rawRepeatedActionCount: z.number().int().nonnegative(),
    managedRepeatedActionCount: z.number().int().nonnegative(),
    forcedCompactionCheckpoints: z.number().int().nonnegative(),
    forcedCompactionRecoveries: z.number().int().nonnegative(),
  })
  .strict();

export const EvaluationResultV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    experimentId: StableNameSchema,
    repositoryFixture: RepositoryFixtureV1Schema,
    policyId: z.string().min(1),
    tokenEstimatorId: z.string().min(1),
    status: z.enum(['pass', 'fail']),
    cases: z.array(EvaluationCaseResultV1Schema),
    aggregate: EvaluationAggregateV1Schema,
    policyFailures: z.array(PolicyFailureV1Schema),
  })
  .strict();

export type EvaluationExperimentV1 = z.infer<
  typeof EvaluationExperimentV1Schema
>;
export type EvaluationCaseV1 = z.infer<typeof EvaluationCaseV1Schema>;
export type ReplayCheckpointV1 = z.infer<typeof ReplayCheckpointV1Schema>;
export type NormalizedAgentActionV1 = z.infer<
  typeof NormalizedAgentActionV1Schema
>;
export type RecordedActionV1 = z.infer<typeof RecordedActionV1Schema>;
export type EvaluationResultV1 = z.infer<typeof EvaluationResultV1Schema>;
export type EvaluationCheckpointResultV1 = z.infer<
  typeof EvaluationCheckpointResultV1Schema
>;
export type EvaluationCaseResultV1 = z.infer<
  typeof EvaluationCaseResultV1Schema
>;
export type PolicyFailureV1 = z.infer<typeof PolicyFailureV1Schema>;
