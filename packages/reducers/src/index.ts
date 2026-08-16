import type { ContextEvent, ContextEventKind } from '@acm/core';

export type ReductionResult = {
  sourceEventId: string;
  reducedText: string;
  rawArtifactUri: string;
  preservedFields: readonly string[];
  originalTokenEstimate?: number;
  reducedTokenEstimate?: number;
};

export interface ContextReducer {
  readonly supportedKinds: readonly ContextEventKind[];
  reduce(event: ContextEvent): Promise<ReductionResult>;
}

export class UnsupportedEventError extends Error {
  constructor(kind: ContextEventKind) {
    super(`No reducer is configured for event kind: ${kind}`);
    this.name = 'UnsupportedEventError';
  }
}
