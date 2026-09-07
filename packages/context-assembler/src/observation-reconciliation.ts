import { canonicalJson } from '@acm/core';
import type {
  ContextExcludedCandidateV1,
  DurableWorkingStateV1,
  PersistedAnyContextEventV1,
  WorkingFileV1,
} from '@acm/core';

type FileReadEvent = Extract<PersistedAnyContextEventV1, { kind: 'file_read' }>;

export type ReconciledObservations = {
  currentFileReadEventIds: ReadonlySet<string>;
  resolvedFailureEventIds: ReadonlySet<string>;
  excludedCandidates: ContextExcludedCandidateV1[];
};

export function isFailureObservation(
  event: PersistedAnyContextEventV1,
): boolean {
  if (event.kind === 'test_result') {
    return (
      event.payload.success === false ||
      event.payload.failures.length > 0 ||
      (event.payload.exitCode !== undefined && event.payload.exitCode !== 0)
    );
  }
  if (event.kind === 'build_result') {
    return (
      event.payload.exitCode !== 0 ||
      event.payload.buildDiagnostics.some(
        (diagnostic) => diagnostic.category === 'error',
      )
    );
  }
  if (event.kind === 'search_result') {
    return event.payload.exitCode !== undefined && event.payload.exitCode > 1;
  }
  return false;
}

function logicalFileKey(file: { path: string; pathKind: string }): string {
  return canonicalJson({ path: file.path, pathKind: file.pathKind });
}

function invalidatedByState(
  event: FileReadEvent,
  versions: readonly WorkingFileV1[],
): boolean {
  const newer = versions.filter(
    (file) => file.introducedAtSequence > event.sequence,
  );
  const current = newer.find((file) => file.status === 'current');
  // A whole-file digest can validate a whole-file snapshot even after edits
  // have been reverted. A range digest must never be compared to this digest.
  if (current?.contentHash) {
    return (
      event.payload.scope.kind === 'range' ||
      current.contentHash !== event.contentHash
    );
  }
  // Preserve a record of intervening edits even if the latest record only
  // confirms an already-modified version without supplying a new digest.
  return newer.some(
    (file) =>
      file.modified ||
      (file.contentHash !== undefined &&
        (event.payload.scope.kind === 'range' ||
          file.contentHash !== event.contentHash)),
  );
}

function explicitlyResolved(
  event: PersistedAnyContextEventV1,
  state: DurableWorkingStateV1,
): boolean {
  const linked = state.failures.filter((failure) =>
    failure.provenance.some(
      (reference) => reference.sourceEventId === event.id,
    ),
  );
  if (linked.some((failure) => failure.status === 'active')) return false;
  // A field-level resolution does not establish that a whole report is
  // resolved. Require explicit whole-observation provenance and a later
  // resolution; passing verification alone is deliberately insufficient.
  return linked.some(
    (failure) =>
      failure.status === 'resolved' &&
      failure.updatedAtSequence > event.sequence &&
      failure.provenance.some(
        (reference) =>
          reference.sourceEventId === event.id &&
          (reference.jsonPointer === undefined ||
            reference.jsonPointer === '/payload'),
      ),
  );
}

/** Reconcile observations with explicit durable state without mutating history. */
export function reconcileObservationEvents(
  state: DurableWorkingStateV1,
  events: readonly PersistedAnyContextEventV1[],
): ReconciledObservations {
  if (events.some((event) => event.sessionId !== state.sessionId)) {
    throw new TypeError(
      'Observations must belong to the working-state session.',
    );
  }
  const filesByPath = new Map<string, WorkingFileV1[]>();
  for (const file of state.files) {
    const key = logicalFileKey(file);
    const versions = filesByPath.get(key) ?? [];
    versions.push(file);
    filesByPath.set(key, versions);
  }
  const latestByScope = new Map<string, FileReadEvent>();
  for (const event of events) {
    if (event.kind !== 'file_read') continue;
    const key = canonicalJson({
      ...event.payload,
      sessionId: event.sessionId,
    });
    const latest = latestByScope.get(key);
    if (!latest || latest.sequence < event.sequence)
      latestByScope.set(key, event);
  }
  const currentFileReadEventIds = new Set<string>();
  for (const event of latestByScope.values()) {
    if (
      !invalidatedByState(
        event,
        filesByPath.get(logicalFileKey(event.payload)) ?? [],
      )
    ) {
      currentFileReadEventIds.add(event.id);
    }
  }
  return {
    currentFileReadEventIds,
    resolvedFailureEventIds: new Set(
      events
        .filter(
          (event) =>
            isFailureObservation(event) && explicitlyResolved(event, state),
        )
        .map((event) => event.id),
    ),
    excludedCandidates: events.flatMap((event) =>
      event.kind === 'file_read' && !currentFileReadEventIds.has(event.id)
        ? [{ id: `event:${event.id}`, reason: 'superseded' as const }]
        : [],
    ),
  };
}
