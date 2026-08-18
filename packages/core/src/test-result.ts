import { z } from 'zod';

export const Sha256DigestSchema = z.string().regex(/^[0-9a-f]{64}$/);
export const ArtifactUriSchema = z
  .string()
  .regex(/^artifact:\/\/sha256\/[0-9a-f]{64}$/);

export const TestCountsSchema = z
  .object({
    total: z.number().int().nonnegative().optional(),
    passed: z.number().int().nonnegative().optional(),
    failed: z.number().int().nonnegative().optional(),
    skipped: z.number().int().nonnegative().optional(),
    todo: z.number().int().nonnegative().optional(),
  })
  .strict();

export const TestFailureSchema = z
  .object({
    testName: z.string().min(1),
    file: z.string().min(1).optional(),
    line: z.number().int().positive().optional(),
    column: z.number().int().positive().optional(),
    expected: z.string().optional(),
    actual: z.string().optional(),
    failureMessages: z.array(z.string()),
    stackFrames: z.array(z.string()),
  })
  .strict();

export const ReductionDiagnosticSchema = z
  .object({
    code: z.string().min(1),
    message: z.string().min(1),
    jsonPath: z.string().min(1).optional(),
  })
  .strict();

export const TestResultObservationV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    framework: z.literal('vitest'),
    sourceFormat: z.literal('vitest-json'),
    command: z.string().min(1).optional(),
    exitCode: z.number().int().optional(),
    success: z.boolean().optional(),
    reportedCounts: TestCountsSchema.optional(),
    observedCounts: TestCountsSchema.optional(),
    failures: z.array(TestFailureSchema),
    diagnostics: z.array(ReductionDiagnosticSchema),
    parseStatus: z.enum(['complete', 'partial', 'opaque']),
  })
  .strict();

export const ReducedTestResultV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal('test-result'),
    framework: z.literal('vitest'),
    command: z.string().min(1).optional(),
    exitCode: z.number().int().optional(),
    success: z.boolean().optional(),
    reportedCounts: TestCountsSchema.optional(),
    observedCounts: TestCountsSchema.optional(),
    failures: z.array(TestFailureSchema),
    diagnostics: z.array(ReductionDiagnosticSchema),
    evidence: z
      .object({
        rawArtifactUri: ArtifactUriSchema,
        contentHash: Sha256DigestSchema,
        byteLength: z.number().int().nonnegative(),
      })
      .strict(),
    safeForContext: z.boolean(),
  })
  .strict();

export type TestCounts = z.infer<typeof TestCountsSchema>;
export type TestFailure = z.infer<typeof TestFailureSchema>;
export type ReductionDiagnostic = z.infer<typeof ReductionDiagnosticSchema>;
export type TestResultObservationV1 = z.infer<
  typeof TestResultObservationV1Schema
>;
export type ReducedTestResultV1 = z.infer<typeof ReducedTestResultV1Schema>;
