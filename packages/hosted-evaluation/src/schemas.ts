import { z } from 'zod';

import {
  EvaluationAggregateV1Schema,
  EvaluationExperimentV1Schema,
  EvaluationResultV1Schema,
  TaskOutcomeV1Schema,
} from '@acm/evaluation';
import { HarnessEventV1Schema, HarnessKindSchema } from '@acm/harness-port';

const StableNameSchema = z
  .string()
  .min(1)
  .regex(/^[a-z0-9][a-z0-9._/-]*$/u);

export const PublicGitFixtureV1Schema = z
  .object({
    id: StableNameSchema,
    repositoryUrl: z
      .url()
      .regex(
        /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/u,
      ),
    revision: z.string().regex(/^[0-9a-f]{40}$/u),
    setupCommands: z.array(z.string().min(1)).max(10).default([]),
    verificationCommands: z
      .array(
        z
          .object({
            id: StableNameSchema,
            command: z.string().min(1),
          })
          .strict(),
      )
      .min(1)
      .max(20),
  })
  .strict();

export const HostedEvaluationPlanV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    experiment: EvaluationExperimentV1Schema,
    fixture: PublicGitFixtureV1Schema,
    harness: HarnessKindSchema,
    model: z.string().min(1),
    timeoutMs: z
      .number()
      .int()
      .positive()
      .max(45 * 60 * 1000)
      .default(900_000),
  })
  .strict()
  .superRefine((plan, context) => {
    if (plan.fixture.id !== plan.experiment.repositoryFixture.id) {
      context.addIssue({
        code: 'custom',
        path: ['fixture', 'id'],
        message: 'Hosted and evaluation fixture IDs must match.',
      });
    }
    if (plan.fixture.revision !== plan.experiment.repositoryFixture.revision) {
      context.addIssue({
        code: 'custom',
        path: ['fixture', 'revision'],
        message: 'Hosted and evaluation fixture revisions must match.',
      });
    }
    for (const evaluationCase of plan.experiment.cases) {
      if (evaluationCase.checkpoints.length !== 1) {
        context.addIssue({
          code: 'custom',
          path: ['experiment', 'cases'],
          message: `Hosted case ${evaluationCase.id} must contain exactly one checkpoint.`,
        });
      }
    }
  });

export const HostedConditionRunOutputV1Schema = z
  .object({
    events: z.array(HarnessEventV1Schema),
    workspaceRevision: z.string().min(1),
    outcome: TaskOutcomeV1Schema,
    latencyMs: z.number().nonnegative(),
  })
  .strict();

const PolicyFailureCountsV1Schema = z
  .object({
    'missing-critical-field': z.number().int().nonnegative(),
    'next-action-divergence': z.number().int().nonnegative(),
    'baseline-success-managed-failure': z.number().int().nonnegative(),
    'repeated-work-increase': z.number().int().nonnegative(),
    'mandatory-overflow': z.number().int().nonnegative(),
  })
  .strict();

export const SanitizedExperimentSummaryV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    experimentId: StableNameSchema,
    createdAt: z.iso.datetime({ offset: true }),
    repositoryFixture: EvaluationResultV1Schema.shape.repositoryFixture,
    policyId: z.string().min(1),
    tokenEstimatorId: z.string().min(1),
    status: z.enum(['pass', 'fail']),
    harness: HarnessKindSchema,
    model: z.string().min(1),
    aggregate: EvaluationAggregateV1Schema,
    policyFailureCounts: PolicyFailureCountsV1Schema,
  })
  .strict();

export const SanitizedDashboardDatasetV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    generatedAt: z.iso.datetime({ offset: true }),
    experiments: z.array(SanitizedExperimentSummaryV1Schema),
  })
  .strict();

export type PublicGitFixtureV1 = z.infer<typeof PublicGitFixtureV1Schema>;
export type HostedEvaluationPlanV1 = z.infer<
  typeof HostedEvaluationPlanV1Schema
>;
export type HostedConditionRunOutputV1 = z.infer<
  typeof HostedConditionRunOutputV1Schema
>;
export type SanitizedExperimentSummaryV1 = z.infer<
  typeof SanitizedExperimentSummaryV1Schema
>;
export type SanitizedDashboardDatasetV1 = z.infer<
  typeof SanitizedDashboardDatasetV1Schema
>;
