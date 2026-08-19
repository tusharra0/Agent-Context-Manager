import {
  DurableWorkingStateV1Schema,
  SessionIdSchema,
  WorkingStateTransitionV1Schema,
} from '@acm/core';
import type {
  DurableWorkingStateV1,
  EvidenceReferenceV1,
  SessionId,
  WorkingFactV1,
  WorkingStateTransitionV1,
} from '@acm/core';

export class WorkingStateInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkingStateInvariantError';
  }
}

export class StateRevisionConflictError extends WorkingStateInvariantError {
  constructor(expected: number, actual: number) {
    super(
      `Working-state revision conflict: expected ${expected}, observed ${actual}.`,
    );
    this.name = 'StateRevisionConflictError';
  }
}

export type TransitionContext = {
  sequence: number;
  createdAt: string;
};

export type ReplayableTransition = TransitionContext & {
  transition: WorkingStateTransitionV1;
};

export function createEmptyWorkingState(
  sessionIdInput: SessionId,
  createdAt: string,
): DurableWorkingStateV1 {
  const sessionId = SessionIdSchema.parse(sessionIdInput);
  return DurableWorkingStateV1Schema.parse({
    schemaVersion: 1,
    sessionId,
    revision: 0,
    throughSequence: 0,
    requirements: [],
    decisions: [],
    files: [],
    failures: [],
    workItems: [],
    updatedAt: createdAt,
  });
}

function evidenceKey(value: EvidenceReferenceV1): string {
  return `${value.sourceEventId}\u0000${value.jsonPointer ?? ''}\u0000${value.artifactUri ?? ''}`;
}

function mergeProvenance(
  first: readonly EvidenceReferenceV1[],
  second: readonly EvidenceReferenceV1[],
): EvidenceReferenceV1[] {
  const values = new Map<string, EvidenceReferenceV1>();
  for (const value of [...first, ...second])
    values.set(evidenceKey(value), value);
  return [...values.values()];
}

function allIds(state: DurableWorkingStateV1): Set<string> {
  return new Set([
    ...(state.goal ? [state.goal.id] : []),
    ...state.requirements.map((item) => item.id),
    ...state.decisions.map((item) => item.id),
    ...state.failures.map((item) => item.id),
    ...state.workItems.map((item) => item.id),
    ...state.files.map((item) => item.id),
  ]);
}

function factArray(
  state: DurableWorkingStateV1,
  category: 'requirement' | 'decision' | 'failure' | 'work-item',
): WorkingFactV1[] {
  switch (category) {
    case 'requirement':
      return state.requirements;
    case 'decision':
      return state.decisions;
    case 'failure':
      return state.failures;
    case 'work-item':
      return state.workItems;
  }
}

function requireActiveFact(
  items: WorkingFactV1[],
  itemId: string,
): WorkingFactV1 {
  const item = items.find((candidate) => candidate.id === itemId);
  if (!item)
    throw new WorkingStateInvariantError(
      `State item does not exist: ${itemId}`,
    );
  if (item.status !== 'active') {
    throw new WorkingStateInvariantError(
      `State item is not active: ${itemId} (${item.status}).`,
    );
  }
  return item;
}

function allowedStatus(
  category: 'requirement' | 'decision' | 'failure' | 'work-item',
  status: WorkingFactV1['status'],
): boolean {
  switch (category) {
    case 'requirement':
    case 'decision':
      return status === 'superseded';
    case 'failure':
      return status === 'resolved';
    case 'work-item':
      return status === 'completed' || status === 'superseded';
  }
}

export function applyWorkingStateTransition(
  stateInput: DurableWorkingStateV1,
  transitionInput: WorkingStateTransitionV1,
  context: TransitionContext,
): DurableWorkingStateV1 {
  const state = DurableWorkingStateV1Schema.parse(stateInput);
  const transition = WorkingStateTransitionV1Schema.parse(transitionInput);
  if (transition.expectedRevision !== state.revision) {
    throw new StateRevisionConflictError(
      transition.expectedRevision,
      state.revision,
    );
  }
  if (
    !Number.isSafeInteger(context.sequence) ||
    context.sequence <= state.throughSequence
  ) {
    throw new WorkingStateInvariantError(
      `Transition sequence must be greater than ${state.throughSequence}.`,
    );
  }
  const next = DurableWorkingStateV1Schema.parse(state);
  const ids = allIds(next);

  for (const operation of transition.operations) {
    if (operation.operation === 'set-goal') {
      if (ids.has(operation.itemId)) {
        throw new WorkingStateInvariantError(
          `Duplicate state item ID: ${operation.itemId}`,
        );
      }
      if (next.goal?.status === 'active') {
        if (operation.supersedes !== next.goal.id) {
          throw new WorkingStateInvariantError(
            `A new goal must explicitly supersede ${next.goal.id}.`,
          );
        }
        next.goal.status = 'superseded';
        next.goal.updatedAtSequence = context.sequence;
      } else if (operation.supersedes) {
        throw new WorkingStateInvariantError(
          'A first goal cannot supersede another item.',
        );
      }
      next.goal = {
        id: operation.itemId,
        text: operation.text,
        status: 'active',
        retention: operation.retention ?? 'required',
        provenance: operation.provenance,
        introducedAtSequence: context.sequence,
        updatedAtSequence: context.sequence,
        ...(operation.supersedes ? { supersedes: operation.supersedes } : {}),
      };
      ids.add(operation.itemId);
      continue;
    }

    if (operation.operation === 'add-fact') {
      if (ids.has(operation.itemId)) {
        throw new WorkingStateInvariantError(
          `Duplicate state item ID: ${operation.itemId}`,
        );
      }
      const items = factArray(next, operation.category);
      if (operation.supersedes) {
        const prior = requireActiveFact(items, operation.supersedes);
        prior.status = 'superseded';
        prior.updatedAtSequence = context.sequence;
      }
      items.push({
        id: operation.itemId,
        text: operation.text,
        status: 'active',
        retention: operation.retention ?? 'required',
        provenance: operation.provenance,
        introducedAtSequence: context.sequence,
        updatedAtSequence: context.sequence,
        ...(operation.supersedes ? { supersedes: operation.supersedes } : {}),
      });
      ids.add(operation.itemId);
      continue;
    }

    if (operation.operation === 'change-fact-status') {
      if (!allowedStatus(operation.category, operation.status)) {
        throw new WorkingStateInvariantError(
          `Status ${operation.status} is invalid for ${operation.category}.`,
        );
      }
      const item = requireActiveFact(
        factArray(next, operation.category),
        operation.itemId,
      );
      item.status = operation.status;
      item.updatedAtSequence = context.sequence;
      item.provenance = mergeProvenance(item.provenance, operation.provenance);
      continue;
    }

    if (operation.operation === 'record-file') {
      if (ids.has(operation.itemId)) {
        throw new WorkingStateInvariantError(
          `Duplicate state item ID: ${operation.itemId}`,
        );
      }
      const current = next.files.find(
        (file) =>
          file.path === operation.path &&
          file.pathKind === operation.pathKind &&
          file.status === 'current',
      );
      if (current) {
        if (operation.supersedes !== current.id) {
          throw new WorkingStateInvariantError(
            `A new version of ${operation.path} must supersede ${current.id}.`,
          );
        }
        current.status = 'stale';
        current.updatedAtSequence = context.sequence;
      } else if (operation.supersedes) {
        throw new WorkingStateInvariantError(
          `File supersession target is not current: ${operation.supersedes}`,
        );
      }
      next.files.push({
        id: operation.itemId,
        path: operation.path,
        pathKind: operation.pathKind,
        status: 'current',
        ...(operation.contentHash
          ? { contentHash: operation.contentHash }
          : {}),
        modified: operation.modified,
        provenance: operation.provenance,
        introducedAtSequence: context.sequence,
        updatedAtSequence: context.sequence,
        ...(operation.supersedes ? { supersedes: operation.supersedes } : {}),
      });
      ids.add(operation.itemId);
      continue;
    }

    next.testStatus = {
      status: operation.status,
      summary: operation.summary,
      provenance: operation.provenance,
      updatedAtSequence: context.sequence,
    };
  }

  next.revision += 1;
  next.throughSequence = context.sequence;
  next.updatedAt = context.createdAt;
  return DurableWorkingStateV1Schema.parse(next);
}

export function replayWorkingState(
  sessionId: SessionId,
  sessionCreatedAt: string,
  transitions: readonly ReplayableTransition[],
): DurableWorkingStateV1 {
  let state = createEmptyWorkingState(sessionId, sessionCreatedAt);
  for (const entry of [...transitions].sort(
    (a, b) => a.sequence - b.sequence,
  )) {
    state = applyWorkingStateTransition(state, entry.transition, entry);
  }
  return state;
}
