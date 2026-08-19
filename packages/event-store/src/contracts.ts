import type {
  BuildResultObservationV1,
  DurableWorkingStateV1,
  EventId,
  FileReadObservationV1,
  PersistedAnyContextEventV1,
  PersistedContextEventV1,
  ReductionDiagnostic,
  SessionId,
  TestResultObservationV1,
  WorkingStateTransitionV1,
  SearchResultObservationV1,
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

export type Phase2ObservationPayload =
  FileReadObservationV1 | SearchResultObservationV1 | BuildResultObservationV1;

export type RecordObservationReductionInput = {
  eventId: EventId;
  sessionId: SessionId;
  kind: 'file_read' | 'search_result' | 'build_result';
  eventCreatedAt: string;
  payload: Phase2ObservationPayload;
  artifact: StoredArtifact;
  reduction: ReductionMetadata;
  reductionCreatedAt: string;
};

export type RecordedAnyEvent = {
  event: PersistedAnyContextEventV1;
  reduction?: PersistedReduction;
};

export type RecordStateUpdateInput = {
  eventId: EventId;
  sessionId: SessionId;
  eventCreatedAt: string;
  transition: WorkingStateTransitionV1;
  artifact: StoredArtifact;
};

export type RecordedStateUpdate = {
  event: PersistedAnyContextEventV1;
  state: DurableWorkingStateV1;
};

export interface MetadataStore {
  createSession(input: CreateSessionInput): SessionRecord;
  sessionExists(sessionId: SessionId): boolean;
  recordReduction(input: RecordReductionInput): RecordedEvent;
  getEvent(eventId: string): RecordedEvent | undefined;
  getAnyEvent(eventId: string): RecordedAnyEvent | undefined;
  recordObservationReduction(
    input: RecordObservationReductionInput,
  ): RecordedAnyEvent;
  recordStateUpdate(input: RecordStateUpdateInput): RecordedStateUpdate;
  getWorkingState(sessionId: SessionId): DurableWorkingStateV1;
  verifyWorkingState(sessionId: SessionId): DurableWorkingStateV1;
  listSessionEvents(sessionId: SessionId): RecordedAnyEvent[];
  findDuplicateFileRead(
    sessionId: SessionId,
    path: string,
    pathKind: FileReadObservationV1['pathKind'],
    scope: FileReadObservationV1['scope'],
    contentHash: string,
  ): EventId | undefined;
  close(): void;
}
