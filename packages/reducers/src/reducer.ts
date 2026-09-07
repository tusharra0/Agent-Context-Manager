import {
  ContextEventSchema,
  ReducedTestResultV1Schema,
  TestResultObservationV1Schema,
  canonicalJson,
} from '@acm/core';
import type {
  ContextEvent,
  ContextEventKind,
  ReducedTestResultV1,
  ReductionDiagnostic,
} from '@acm/core';

export type ReductionResult = {
  sourceEventId: string;
  reducerId: string;
  reducerVersion: string;
  reducedText: string;
  rawArtifactUri: string;
  safeForContext: boolean;
  preservedFields: readonly string[];
  diagnostics: readonly ReductionDiagnostic[];
};

export interface ContextReducer {
  readonly reducerId: string;
  readonly reducerVersion: string;
  readonly supportedKinds: readonly ContextEventKind[];
  reduce(event: ContextEvent): Promise<ReductionResult>;
}

export class UnsupportedEventError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedEventError';
  }
}

function pointerSegment(value: string): string {
  return value.replaceAll('~', '~0').replaceAll('/', '~1');
}

function preservedFields(reduced: ReducedTestResultV1): string[] {
  const fields: string[] = [];
  function visit(value: unknown, path: string): void {
    if (Array.isArray(value)) {
      fields.push(path);
      value.forEach((item, index) => visit(item, `${path}/${index}`));
      return;
    }
    if (typeof value === 'object' && value !== null) {
      for (const key of Object.keys(value).sort()) {
        visit(
          (value as Record<string, unknown>)[key],
          `${path}/${pointerSegment(key)}`,
        );
      }
      return;
    }
    fields.push(path);
  }
  visit(reduced, '');
  return fields;
}

export class VitestJsonReducer implements ContextReducer {
  readonly reducerId = 'test-result/vitest-json';
  readonly reducerVersion = '1.1.0';
  readonly supportedKinds = ['test_result'] as const;

  async reduce(eventInput: ContextEvent): Promise<ReductionResult> {
    const event = ContextEventSchema.parse(eventInput);
    if (event.kind !== 'test_result') {
      throw new UnsupportedEventError(`Unsupported event kind: ${event.kind}`);
    }
    if (
      !event.rawArtifactUri ||
      !event.contentHash ||
      event.byteLength === undefined
    ) {
      throw new UnsupportedEventError(
        'Test-result events require complete raw artifact metadata.',
      );
    }
    if (!event.rawArtifactUri.endsWith(event.contentHash)) {
      throw new UnsupportedEventError(
        'Artifact URI does not match the event content hash.',
      );
    }
    const payload = TestResultObservationV1Schema.safeParse(event.payload);
    if (!payload.success) {
      throw new UnsupportedEventError(
        'Unsupported test-result payload version or shape.',
      );
    }

    const safeForContext = payload.data.parseStatus === 'complete';
    const reduced = ReducedTestResultV1Schema.parse({
      schemaVersion: 1,
      kind: 'test-result',
      framework: 'vitest',
      ...(payload.data.command ? { command: payload.data.command } : {}),
      ...(payload.data.exitCode !== undefined
        ? { exitCode: payload.data.exitCode }
        : {}),
      ...(payload.data.success !== undefined
        ? { success: payload.data.success }
        : {}),
      ...(payload.data.reportedCounts
        ? { reportedCounts: payload.data.reportedCounts }
        : {}),
      ...(payload.data.reportedSuiteCounts
        ? { reportedSuiteCounts: payload.data.reportedSuiteCounts }
        : {}),
      ...(payload.data.snapshot !== undefined
        ? { snapshot: payload.data.snapshot }
        : {}),
      ...(payload.data.observedCounts
        ? { observedCounts: payload.data.observedCounts }
        : {}),
      failures: payload.data.failures,
      diagnostics: payload.data.diagnostics,
      evidence: {
        rawArtifactUri: event.rawArtifactUri,
        contentHash: event.contentHash,
        byteLength: event.byteLength,
      },
      safeForContext,
    });
    return {
      sourceEventId: event.id,
      reducerId: this.reducerId,
      reducerVersion: this.reducerVersion,
      reducedText: canonicalJson(reduced),
      rawArtifactUri: event.rawArtifactUri,
      safeForContext,
      preservedFields: preservedFields(reduced),
      diagnostics: payload.data.diagnostics,
    };
  }
}
