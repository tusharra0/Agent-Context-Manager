import type {
  EventId,
  PersistedContextEventV1,
  ReductionDiagnostic,
  SessionId,
  TestResultObservationV1,
} from '@acm/core';

export type StoredArtifact = {
  uri: string;
  algorithm: 'sha256';
  digest: string;
  byteLength: number;
  reused: boolean;
};

export interface ArtifactStore {
  put(source: NodeJS.ReadableStream): Promise<StoredArtifact>;
  open(uri: string): Promise<NodeJS.ReadableStream>;
  verify(uri: string): Promise<StoredArtifact>;
  restore(uri: string, outputPath: string): Promise<void>;
}

export type SessionRecord = {
  id: SessionId;
  createdAt: string;
};

export type CreateSessionInput = SessionRecord;

export type ReductionMetadata = {
  reducerId: string;
  reducerVersion: string;
  reducedText: string;
  safeForContext: boolean;
  originalTokenEstimate: number;
  reducedTokenEstimate: number;
  tokenEstimatorId: string;
  preservedFields: readonly string[];
  diagnostics: readonly ReductionDiagnostic[];
};

export type RecordReductionInput = {
  eventId: EventId;
  sessionId: SessionId;
  eventCreatedAt: string;
  payload: TestResultObservationV1;
  artifact: StoredArtifact;
  reduction: ReductionMetadata;
  reductionCreatedAt: string;
};

export type PersistedReduction = ReductionMetadata & {
  sourceEventId: EventId;
  rawArtifactUri: string;
  createdAt: string;
};

export type RecordedEvent = {
  event: PersistedContextEventV1;
  reduction: PersistedReduction;
};

export interface MetadataStore {
  createSession(input: CreateSessionInput): SessionRecord;
  sessionExists(sessionId: SessionId): boolean;
  recordReduction(input: RecordReductionInput): RecordedEvent;
  getEvent(eventId: string): RecordedEvent | undefined;
  close(): void;
}
