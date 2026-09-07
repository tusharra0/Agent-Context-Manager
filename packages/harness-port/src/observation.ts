import { z } from 'zod';

import {
  ArtifactUriSchema,
  EventIdSchema,
  JsonValueSchema,
  ReductionDiagnosticSchema,
  Sha256DigestSchema,
  type JsonValue,
} from '@acm/core';

/**
 * Which experimental condition an interceptor serves.
 *
 * Both conditions run the same interception path so the only difference between
 * them is whether a reduction replaces the raw observation. Comparing a managed
 * run against a natively executed run would compare two agent architectures
 * rather than two context policies.
 */
export const ObservationPolicySchema = z.enum(['raw', 'reduced']);

/** What the agent actually received, as opposed to what was requested. */
export const ObservationModeSchema = z.enum([
  /** A deterministic reducer's output stood in for the raw observation. */
  'reduced',
  /** The exact raw observation text. */
  'raw',
  /** Raw text bounded by the observation cap, with the remainder recoverable. */
  'raw-truncated',
  /** Output was not decodable text; only a reference to it is representable. */
  'binary-reference',
]);

/** Why a reduction was or was not used. Every non-`applied` value is auditable. */
export const ObservationReductionOutcomeSchema = z.enum([
  'applied',
  /** The condition asked for raw observations. */
  'not-requested',
  /** No classifier claimed this tool, so there was nothing to reduce. */
  'no-reducer',
  /** The reducer declared its output unfit to stand in for the raw evidence. */
  'unsafe',
  /** The reduction would have cost at least as many tokens as the raw text. */
  'not-smaller',
  /** The classifier or reducer threw. */
  'failed',
  /** Raw evidence could not be stored, so nothing may be removed from view. */
  'raw-evidence-unavailable',
  /** The observation was not valid UTF-8 and cannot be reduced as text. */
  'binary-output',
]);

export const ObservationEvidenceV1Schema = z
  .object({
    rawArtifactUri: ArtifactUriSchema,
    contentHash: Sha256DigestSchema,
    byteLength: z.number().int().nonnegative(),
    /** Present once the observation is persisted as a typed context event. */
    eventId: EventIdSchema.optional(),
  })
  .strict();

/**
 * The audit record for one intercepted observation.
 *
 * `reducedTokenEstimate` is recorded under both policies. Under `raw` it is the
 * reduction that was computed but deliberately not used, which is what makes
 * the reducible share of a run measurable instead of assumed.
 */
export const ObservationRecordV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    toolCallId: z.string().min(1),
    toolName: z.string().min(1),
    policy: ObservationPolicySchema,
    mode: ObservationModeSchema,
    reductionOutcome: ObservationReductionOutcomeSchema,
    rawByteLength: z.number().int().nonnegative(),
    rawTokenEstimate: z.number().int().nonnegative(),
    observedTokenEstimate: z.number().int().nonnegative(),
    reducedTokenEstimate: z.number().int().nonnegative().optional(),
    /**
     * Whether the computed reduction passed every safety gate. Under the `raw`
     * policy this is what the paired managed condition would have done with the
     * same bytes, which is what makes the reducible share of a run measurable
     * from the baseline rather than assumed.
     */
    reductionUsable: z.boolean().optional(),
    tokenEstimatorId: z.string().min(1),
    reducerId: z.string().min(1).optional(),
    reducerVersion: z.string().min(1).optional(),
    evidence: ObservationEvidenceV1Schema.optional(),
    diagnostics: z.array(ReductionDiagnosticSchema),
  })
  .strict();

export type ObservationPolicy = z.infer<typeof ObservationPolicySchema>;
export type ObservationMode = z.infer<typeof ObservationModeSchema>;
export type ObservationReductionOutcome = z.infer<
  typeof ObservationReductionOutcomeSchema
>;
export type ObservationEvidenceV1 = z.infer<typeof ObservationEvidenceV1Schema>;
export type ObservationRecordV1 = z.infer<typeof ObservationRecordV1Schema>;

/** The tool call the agent issued, before it is executed. */
export interface HarnessToolInvocation {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly input: JsonValue;
}

/**
 * Exactly what executing the tool produced. Bytes rather than a string: raw
 * evidence is stored byte-for-byte, and decoding is a decision the pipeline
 * makes explicitly rather than an accident of the transport.
 */
export interface RawToolOutput {
  readonly bytes: Uint8Array;
  readonly isError: boolean;
  readonly exitCode?: number;
}

/** The observation that enters the agent's transcript, plus its audit record. */
export interface InterceptedObservation {
  readonly text: string;
  readonly isError: boolean;
  readonly record: ObservationRecordV1;
}

export interface ObservationInterceptionOptions {
  readonly abortSignal?: AbortSignal;
}

/**
 * Turns a raw tool observation into the text the agent sees.
 *
 * An interceptor must never fail a tool call it was asked to record: a
 * classifier fault, a reducer fault, or an unavailable artifact store degrades
 * to the raw observation instead of propagating. The agent keeps working and
 * the record says what happened.
 */
export interface ObservationInterceptor {
  readonly policy: ObservationPolicy;
  intercept(
    invocation: HarnessToolInvocation,
    output: RawToolOutput,
    options?: ObservationInterceptionOptions,
  ): Promise<InterceptedObservation>;
}

export const HarnessToolInvocationSchema = z
  .object({
    toolCallId: z.string().min(1),
    toolName: z.string().min(1),
    input: JsonValueSchema,
  })
  .strict();
