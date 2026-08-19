import { z } from 'zod';

import { EventIdSchema } from './identifiers.js';
import {
  ArtifactUriSchema,
  ReductionDiagnosticSchema,
  Sha256DigestSchema,
} from './test-result.js';

export const FileReadScopeV1Schema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('full') }).strict(),
  z
    .object({
      kind: z.literal('range'),
      startLine: z.number().int().positive(),
      endLine: z.number().int().positive(),
    })
    .strict()
    .refine((value) => value.endLine >= value.startLine, {
      message: 'endLine must be greater than or equal to startLine',
      path: ['endLine'],
    }),
]);

export const FileReadObservationV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    path: z.string().min(1),
    pathKind: z.enum(['repository-relative', 'absolute', 'virtual']),
    scope: FileReadScopeV1Schema,
    encoding: z.literal('utf-8'),
  })
  .strict();

export const ReductionEvidenceV1Schema = z
  .object({
    rawArtifactUri: ArtifactUriSchema,
    contentHash: Sha256DigestSchema,
    byteLength: z.number().int().nonnegative(),
  })
  .strict();

export const ReducedFileReadV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal('file-read'),
    path: z.string().min(1),
    pathKind: z.enum(['repository-relative', 'absolute', 'virtual']),
    scope: FileReadScopeV1Schema,
    encoding: z.literal('utf-8'),
    duplicateOfEventId: EventIdSchema.optional(),
    contentStatus: z.enum(['artifact-required', 'duplicate-reference']),
    evidence: ReductionEvidenceV1Schema,
    safeForContext: z.boolean(),
  })
  .strict();

export const SearchMatchV1Schema = z
  .object({
    path: z.string().min(1),
    line: z.number().int().positive(),
    column: z.number().int().positive().optional(),
    endColumn: z.number().int().positive().optional(),
    byteOffset: z.number().int().nonnegative().optional(),
    endByteOffset: z.number().int().positive().optional(),
    text: z.string(),
  })
  .strict()
  .superRefine((match, context) => {
    const hasColumns =
      match.column !== undefined || match.endColumn !== undefined;
    if (
      hasColumns &&
      (match.column === undefined ||
        match.endColumn === undefined ||
        match.endColumn <= match.column)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'column and endColumn must form a non-empty range.',
        path: ['endColumn'],
      });
    }
    const hasByteOffsets =
      match.byteOffset !== undefined || match.endByteOffset !== undefined;
    if (
      hasByteOffsets &&
      (match.byteOffset === undefined ||
        match.endByteOffset === undefined ||
        match.endByteOffset <= match.byteOffset)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'byteOffset and endByteOffset must form a non-empty range.',
        path: ['endByteOffset'],
      });
    }
  });

export const SearchResultObservationV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    tool: z.literal('ripgrep'),
    sourceFormat: z.literal('ripgrep-json'),
    query: z.string().min(1),
    root: z.string().min(1),
    command: z.string().min(1).optional(),
    exitCode: z.number().int().optional(),
    matches: z.array(SearchMatchV1Schema),
    reportedMatchCount: z.number().int().nonnegative().optional(),
    diagnostics: z.array(ReductionDiagnosticSchema),
    parseStatus: z.enum(['complete', 'partial', 'opaque']),
  })
  .strict();

export const ReducedSearchResultV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal('search-result'),
    tool: z.literal('ripgrep'),
    query: z.string().min(1),
    root: z.string().min(1),
    command: z.string().min(1).optional(),
    exitCode: z.number().int().optional(),
    matches: z.array(SearchMatchV1Schema),
    matchCount: z.number().int().nonnegative(),
    diagnostics: z.array(ReductionDiagnosticSchema),
    evidence: ReductionEvidenceV1Schema,
    safeForContext: z.boolean(),
  })
  .strict();

export const BuildDiagnosticV1Schema = z
  .object({
    category: z.enum(['error', 'warning']),
    code: z.string().min(1),
    message: z.string().min(1),
    file: z.string().min(1).optional(),
    line: z.number().int().positive().optional(),
    column: z.number().int().positive().optional(),
  })
  .strict();

export const BuildResultObservationV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    tool: z.literal('typescript'),
    sourceFormat: z.literal('tsc-pretty-false'),
    command: z.string().min(1),
    workingDirectory: z.string().min(1),
    toolVersion: z.string().min(1).optional(),
    exitCode: z.number().int(),
    buildDiagnostics: z.array(BuildDiagnosticV1Schema),
    diagnostics: z.array(ReductionDiagnosticSchema),
    parseStatus: z.enum(['complete', 'partial', 'opaque']),
  })
  .strict();

export const ReducedBuildResultV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal('build-result'),
    tool: z.literal('typescript'),
    command: z.string().min(1),
    workingDirectory: z.string().min(1),
    toolVersion: z.string().min(1).optional(),
    exitCode: z.number().int(),
    buildDiagnostics: z.array(BuildDiagnosticV1Schema),
    diagnostics: z.array(ReductionDiagnosticSchema),
    evidence: ReductionEvidenceV1Schema,
    safeForContext: z.boolean(),
  })
  .strict();

export const Phase2ObservationPayloadV1Schema = z.union([
  FileReadObservationV1Schema,
  SearchResultObservationV1Schema,
  BuildResultObservationV1Schema,
]);

export const Phase2ReducedValueV1Schema = z.union([
  ReducedFileReadV1Schema,
  ReducedSearchResultV1Schema,
  ReducedBuildResultV1Schema,
]);

export type FileReadObservationV1 = z.infer<typeof FileReadObservationV1Schema>;
export type ReducedFileReadV1 = z.infer<typeof ReducedFileReadV1Schema>;
export type SearchMatchV1 = z.infer<typeof SearchMatchV1Schema>;
export type SearchResultObservationV1 = z.infer<
  typeof SearchResultObservationV1Schema
>;
export type ReducedSearchResultV1 = z.infer<typeof ReducedSearchResultV1Schema>;
export type BuildDiagnosticV1 = z.infer<typeof BuildDiagnosticV1Schema>;
export type BuildResultObservationV1 = z.infer<
  typeof BuildResultObservationV1Schema
>;
export type ReducedBuildResultV1 = z.infer<typeof ReducedBuildResultV1Schema>;
