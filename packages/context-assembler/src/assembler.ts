import {
  ContextAssemblyManifestV1Schema,
  ContextCandidateV1Schema,
  ContextExcludedCandidateV1Schema,
  DurableWorkingStateV1Schema,
  canonicalJson,
} from '@acm/core';
import type {
  ContextAssemblyManifestV1,
  ContextCandidateV1,
  ContextExcludedCandidateV1,
  DurableWorkingStateV1,
  EvidenceReferenceV1,
  WorkingFactV1,
} from '@acm/core';

export const CONTEXT_ASSEMBLY_POLICY_ID = 'priority-whole-item@1';

export type TokenEstimator = {
  id: string;
  estimate(text: string): number;
};

export type ObservationCandidate = {
  candidate: ContextCandidateV1;
  safeForContext: boolean;
};

export type PinnedInstruction = {
  id: string;
  text: string;
  sourceEventIds?: ContextCandidateV1['sourceEventIds'];
};

export type AssembleContextInput = {
  state: DurableWorkingStateV1;
  pinnedInstructions?: readonly PinnedInstruction[];
  observations?: readonly ObservationCandidate[];
  preExcludedCandidates?: readonly ContextExcludedCandidateV1[];
  tokenBudget: number;
  tokenEstimator: TokenEstimator;
};

export type AssembledContext = {
  contextText: string;
  manifest: ContextAssemblyManifestV1;
};

const CLASS_PRIORITY: Record<ContextCandidateV1['class'], number> = {
  instruction: 0,
  goal: 1,
  requirement: 2,
  'active-failure': 3,
  decision: 4,
  'working-state': 5,
  'file-observation': 6,
  'recent-observation': 7,
  'completed-outcome': 8,
};

function sourceIds(
  provenance: readonly EvidenceReferenceV1[],
): ContextCandidateV1['sourceEventIds'] {
  return [...new Set(provenance.map((reference) => reference.sourceEventId))];
}

function factCandidate(
  item: WorkingFactV1,
  kind: ContextCandidateV1['class'],
  required: boolean,
): ContextCandidateV1 {
  return ContextCandidateV1Schema.parse({
    id: `state:${item.id}`,
    class: kind,
    required,
    sequence: item.updatedAtSequence,
    text: item.text,
    sourceEventIds: sourceIds(item.provenance),
    stateItemId: item.id,
  });
}

export function candidatesFromWorkingState(stateInput: DurableWorkingStateV1): {
  candidates: ContextCandidateV1[];
  supersededCandidateIds: string[];
} {
  const state = DurableWorkingStateV1Schema.parse(stateInput);
  const candidates: ContextCandidateV1[] = [];
  const supersededCandidateIds: string[] = [];
  if (state.goal) {
    if (state.goal.status === 'active')
      candidates.push(factCandidate(state.goal, 'goal', true));
    else supersededCandidateIds.push(`state:${state.goal.id}`);
  }

  for (const requirement of state.requirements) {
    if (requirement.status === 'active') {
      candidates.push(factCandidate(requirement, 'requirement', true));
    } else supersededCandidateIds.push(`state:${requirement.id}`);
  }
  for (const decision of state.decisions) {
    if (decision.status === 'active') {
      candidates.push(
        factCandidate(decision, 'decision', decision.retention === 'required'),
      );
    } else supersededCandidateIds.push(`state:${decision.id}`);
  }
  for (const failure of state.failures) {
    if (failure.status === 'active') {
      candidates.push(factCandidate(failure, 'active-failure', true));
    } else {
      candidates.push(factCandidate(failure, 'completed-outcome', false));
    }
  }
  for (const item of state.workItems) {
    if (item.status === 'active') {
      candidates.push(factCandidate(item, 'working-state', true));
    } else if (item.status === 'completed') {
      candidates.push(factCandidate(item, 'completed-outcome', false));
    } else supersededCandidateIds.push(`state:${item.id}`);
  }
  for (const file of state.files) {
    if (file.status === 'stale') {
      supersededCandidateIds.push(`state:${file.id}`);
      continue;
    }
    candidates.push(
      ContextCandidateV1Schema.parse({
        id: `state:${file.id}`,
        class: 'working-state',
        required: file.modified,
        sequence: file.updatedAtSequence,
        text: canonicalJson({
          path: file.path,
          pathKind: file.pathKind,
          modified: file.modified,
          ...(file.contentHash ? { contentHash: file.contentHash } : {}),
        }),
        sourceEventIds: sourceIds(file.provenance),
        stateItemId: file.id,
      }),
    );
  }
  if (state.testStatus) {
    candidates.push(
      ContextCandidateV1Schema.parse({
        id: 'state:test-status',
        class:
          state.testStatus.status === 'failed'
            ? 'active-failure'
            : 'working-state',
        required: ['failed', 'partial'].includes(state.testStatus.status),
        sequence: state.testStatus.updatedAtSequence,
        text: canonicalJson({
          status: state.testStatus.status,
          summary: state.testStatus.summary,
        }),
        sourceEventIds: sourceIds(state.testStatus.provenance),
      }),
    );
  }
  return { candidates, supersededCandidateIds };
}

function render(candidates: readonly ContextCandidateV1[]): string {
  return canonicalJson({
    schemaVersion: 1,
    items: candidates.map((candidate) => ({
      id: candidate.id,
      class: candidate.class,
      text: candidate.text,
      sourceEventIds: candidate.sourceEventIds,
      ...(candidate.stateItemId ? { stateItemId: candidate.stateItemId } : {}),
    })),
  });
}

function compareCandidates(
  a: ContextCandidateV1,
  b: ContextCandidateV1,
): number {
  return (
    CLASS_PRIORITY[a.class] - CLASS_PRIORITY[b.class] ||
    b.sequence - a.sequence ||
    a.id.localeCompare(b.id)
  );
}

export function assembleContext(input: AssembleContextInput): AssembledContext {
  if (!Number.isSafeInteger(input.tokenBudget) || input.tokenBudget < 0) {
    throw new RangeError('tokenBudget must be a non-negative safe integer.');
  }
  if (!input.tokenEstimator.id)
    throw new TypeError('Token estimator ID is required.');
  const estimate = (text: string): number => {
    const value = input.tokenEstimator.estimate(text);
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new TypeError(
        `Token estimator ${input.tokenEstimator.id} returned an invalid estimate.`,
      );
    }
    return value;
  };
  const stateCandidates = candidatesFromWorkingState(input.state);
  const instructions = (input.pinnedInstructions ?? []).map(
    (instruction, index) =>
      ContextCandidateV1Schema.parse({
        id: `instruction:${instruction.id}`,
        class: 'instruction',
        required: true,
        sequence: Number.MAX_SAFE_INTEGER - index,
        text: instruction.text,
        sourceEventIds: instruction.sourceEventIds ?? [],
      }),
  );
  const parsedObservations = (input.observations ?? []).map((entry) => ({
    safeForContext: entry.safeForContext,
    candidate: ContextCandidateV1Schema.parse(entry.candidate),
  }));
  const preExcluded = (input.preExcludedCandidates ?? []).map((entry) =>
    ContextExcludedCandidateV1Schema.parse(entry),
  );
  const unsafe = parsedObservations.filter((entry) => !entry.safeForContext);
  for (const entry of unsafe) {
    if (entry.candidate.required) {
      throw new TypeError(
        `Unsafe context candidate cannot be mandatory: ${entry.candidate.id}`,
      );
    }
  }
  const safeObservations = parsedObservations
    .filter((entry) => entry.safeForContext)
    .map((entry) => entry.candidate);
  const all = [
    ...instructions,
    ...stateCandidates.candidates,
    ...safeObservations,
  ];
  const ids = new Set<string>();
  for (const id of [
    ...all.map((candidate) => candidate.id),
    ...unsafe.map((entry) => entry.candidate.id),
    ...preExcluded.map((entry) => entry.id),
    ...stateCandidates.supersededCandidateIds,
  ]) {
    if (ids.has(id))
      throw new TypeError(`Duplicate context candidate ID: ${id}`);
    ids.add(id);
  }
  const required = all
    .filter((candidate) => candidate.required)
    .sort(compareCandidates);
  const optional = all
    .filter((candidate) => !candidate.required)
    .sort(compareCandidates);
  const included = [...required];
  const excluded: ContextAssemblyManifestV1['excludedCandidates'] = [
    ...preExcluded,
    ...stateCandidates.supersededCandidateIds.map((id) => ({
      id,
      reason: 'superseded' as const,
    })),
    ...unsafe.map((entry) => ({
      id: entry.candidate.id,
      reason: 'unsafe' as const,
    })),
  ];
  const requiredEstimate = estimate(render(included));
  const requiredOverflow = requiredEstimate > input.tokenBudget;
  if (!requiredOverflow) {
    for (const candidate of optional) {
      const attempted = [...included, candidate];
      if (estimate(render(attempted)) <= input.tokenBudget) {
        included.push(candidate);
      } else excluded.push({ id: candidate.id, reason: 'budget' });
    }
  } else {
    excluded.push(
      ...optional.map((candidate) => ({
        id: candidate.id,
        reason: 'budget' as const,
      })),
    );
  }
  const contextText = render(included);
  const assembledTokenEstimate = estimate(contextText);
  const manifest = ContextAssemblyManifestV1Schema.parse({
    schemaVersion: 1,
    policyId: CONTEXT_ASSEMBLY_POLICY_ID,
    tokenEstimatorId: input.tokenEstimator.id,
    requestedTokenBudget: input.tokenBudget,
    assembledTokenEstimate,
    status: requiredOverflow ? 'mandatory-overflow' : 'within-budget',
    includedCandidateIds: included.map((candidate) => candidate.id),
    excludedCandidates: excluded.sort(
      (left, right) =>
        left.id.localeCompare(right.id) ||
        left.reason.localeCompare(right.reason),
    ),
  });
  return { contextText, manifest };
}
