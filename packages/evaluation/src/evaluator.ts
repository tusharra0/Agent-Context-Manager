import { createHash } from 'node:crypto';

import {
  ContextCandidateV1Schema,
  JsonValueSchema,
  canonicalJson,
} from '@acm/core';
import type { JsonValue } from '@acm/core';
import {
  CONTEXT_ASSEMBLY_POLICY_ID,
  assembleContext,
} from '@acm/context-assembler';
import type { TokenEstimator } from '@acm/context-assembler';
import { z } from 'zod';

import { round } from './numbers.js';
import {
  EvaluationExperimentV1Schema,
  EvaluationResultV1Schema,
} from './schemas.js';
import type {
  EvaluationCaseResultV1,
  EvaluationCaseV1,
  EvaluationCheckpointResultV1,
  EvaluationExperimentV1,
  EvaluationResultV1,
  NormalizedAgentActionV1,
  PolicyFailureV1,
  RecordedActionV1,
  ReplayCheckpointV1,
} from './schemas.js';

const RenderedContextItemV1Schema = ContextCandidateV1Schema.omit({
  required: true,
  sequence: true,
});

const RenderedContextV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    items: z.array(RenderedContextItemV1Schema),
  })
  .strict();

type RenderedContextItemV1 = z.infer<typeof RenderedContextItemV1Schema>;

function digest(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function unique<T>(values: readonly T[], label: string): void {
  if (new Set(values).size !== values.length) {
    throw new Error(`Duplicate ${label}.`);
  }
}

function validateCase(evaluationCase: EvaluationCaseV1): void {
  unique(
    evaluationCase.checkpoints.map((checkpoint) => checkpoint.id),
    `checkpoint ID in case ${evaluationCase.id}`,
  );
  if (evaluationCase.rawEvidence.condition !== 'raw') {
    throw new Error(
      `Case ${evaluationCase.id} raw evidence has wrong condition.`,
    );
  }
  if (evaluationCase.managedEvidence.condition !== 'managed') {
    throw new Error(
      `Case ${evaluationCase.id} managed evidence has wrong condition.`,
    );
  }
  const checkpointIds = evaluationCase.checkpoints.map(
    (checkpoint) => checkpoint.id,
  );
  for (const evidence of [
    evaluationCase.rawEvidence,
    evaluationCase.managedEvidence,
  ]) {
    const evidenceIds = evidence.checkpointActions.map(
      (entry) => entry.checkpointId,
    );
    unique(evidenceIds, `${evidence.condition} checkpoint action`);
    if (
      evidenceIds.length !== checkpointIds.length ||
      checkpointIds.some((id) => !evidenceIds.includes(id))
    ) {
      throw new Error(
        `Case ${evaluationCase.id} ${evidence.condition} evidence must contain exactly one action for every checkpoint.`,
      );
    }
  }
}

function visibleEventIds(checkpoint: ReplayCheckpointV1): Set<string> {
  return new Set([
    ...checkpoint.observations.map((observation) => observation.eventId),
    ...checkpoint.instructions.flatMap(
      (instruction) => instruction.sourceEventIds,
    ),
  ]);
}

function validateCheckpoint(checkpoint: ReplayCheckpointV1): void {
  if (checkpoint.state.throughSequence > checkpoint.throughSequence) {
    throw new Error(
      `Checkpoint ${checkpoint.id} contains working state from the future.`,
    );
  }
  unique(
    checkpoint.observations.map((observation) => observation.eventId),
    `observation event ID in checkpoint ${checkpoint.id}`,
  );
  unique(
    checkpoint.observations.map(
      (observation) => observation.managedCandidate.id,
    ),
    `managed candidate ID in checkpoint ${checkpoint.id}`,
  );
  unique(
    checkpoint.criticalFields.map((field) => field.id),
    `critical-field ID in checkpoint ${checkpoint.id}`,
  );

  const visible = visibleEventIds(checkpoint);
  for (const observation of checkpoint.observations) {
    if (
      observation.sequence > checkpoint.throughSequence ||
      observation.managedCandidate.sequence > checkpoint.throughSequence
    ) {
      throw new Error(
        `Checkpoint ${checkpoint.id} contains observation data from the future.`,
      );
    }
    if (observation.managedCandidate.sequence !== observation.sequence) {
      throw new Error(
        `Checkpoint ${checkpoint.id} observation and candidate sequences differ for ${observation.eventId}.`,
      );
    }
    if (
      !observation.managedCandidate.sourceEventIds.includes(observation.eventId)
    ) {
      throw new Error(
        `Managed candidate ${observation.managedCandidate.id} does not cite its source observation.`,
      );
    }
    if (digest(observation.rawText) !== observation.contentHash) {
      throw new Error(
        `Raw observation hash mismatch for ${observation.eventId}.`,
      );
    }
  }
  for (const field of checkpoint.criticalFields) {
    if (!visible.has(field.sourceEventId)) {
      throw new Error(
        `Critical field ${field.id} cites an event not visible at checkpoint ${checkpoint.id}.`,
      );
    }
    const sourceTexts = [
      ...checkpoint.observations
        .filter((observation) => observation.eventId === field.sourceEventId)
        .map((observation) => observation.rawText),
      ...checkpoint.instructions
        .filter((instruction) =>
          instruction.sourceEventIds.includes(field.sourceEventId),
        )
        .map((instruction) => instruction.text),
    ];
    if (!sourceTexts.some((text) => text.includes(field.sourceText))) {
      throw new Error(
        `Critical field ${field.id} is not present in its cited raw evidence.`,
      );
    }
  }
}

function renderRawContext(checkpoint: ReplayCheckpointV1): string {
  const instructions: RenderedContextItemV1[] = checkpoint.instructions.map(
    (instruction) => ({
      id: `instruction:${instruction.id}`,
      class: 'instruction',
      text: instruction.text,
      sourceEventIds: instruction.sourceEventIds,
    }),
  );
  const observations: RenderedContextItemV1[] = [...checkpoint.observations]
    .sort(
      (left, right) =>
        left.sequence - right.sequence ||
        left.managedCandidate.id.localeCompare(right.managedCandidate.id),
    )
    .map((observation) => ({
      id: observation.managedCandidate.id,
      class: observation.managedCandidate.class,
      text: observation.rawText,
      sourceEventIds: observation.managedCandidate.sourceEventIds,
      ...(observation.managedCandidate.stateItemId
        ? { stateItemId: observation.managedCandidate.stateItemId }
        : {}),
    }));
  return canonicalJson({
    schemaVersion: 1,
    items: [...instructions, ...observations],
  });
}

function assembleManagedCheckpoint(
  checkpoint: ReplayCheckpointV1,
  estimator: TokenEstimator,
) {
  return assembleContext({
    state: checkpoint.state,
    pinnedInstructions: checkpoint.instructions,
    observations: checkpoint.observations
      .filter((observation) => observation.managedExclusion === undefined)
      .map((observation) => ({
        candidate: observation.managedCandidate,
        safeForContext: observation.safeForContext,
      })),
    preExcludedCandidates: checkpoint.observations.flatMap((observation) =>
      observation.managedExclusion === undefined
        ? []
        : [
            {
              id: observation.managedCandidate.id,
              reason: observation.managedExclusion,
            },
          ],
    ),
    tokenBudget: checkpoint.tokenBudget,
    tokenEstimator: estimator,
  });
}

export function prepareEvaluationCheckpointContexts(
  checkpoint: ReplayCheckpointV1,
  estimator: TokenEstimator,
): {
  rawContextText: string;
  managedContextText: string;
  rawTokenEstimate: number;
  managedTokenEstimate: number;
} {
  validateCheckpoint(checkpoint);
  const rawContextText = renderRawContext(checkpoint);
  const managed = assembleManagedCheckpoint(checkpoint, estimator);
  return {
    rawContextText,
    managedContextText: managed.contextText,
    rawTokenEstimate: estimator.estimate(rawContextText),
    managedTokenEstimate: managed.manifest.assembledTokenEstimate,
  };
}

function parseRenderedContext(
  text: string,
): Map<string, RenderedContextItemV1> {
  const parsed = RenderedContextV1Schema.parse(JSON.parse(text));
  return new Map(parsed.items.map((item) => [item.id, item]));
}

function decodePointerSegment(segment: string): string {
  if (/~(?:[^01]|$)/u.test(segment)) {
    throw new Error(`Invalid JSON Pointer escape: ${segment}`);
  }
  return segment.replaceAll('~1', '/').replaceAll('~0', '~');
}

function valueAtPointer(
  value: JsonValue,
  pointer: string,
): JsonValue | undefined {
  let current: JsonValue | undefined = value;
  for (const encodedSegment of pointer.slice(1).split('/')) {
    const segment = decodePointerSegment(encodedSegment);
    if (Array.isArray(current)) {
      if (!/^(?:0|[1-9]\d*)$/u.test(segment)) return undefined;
      current = current[Number(segment)];
    } else if (current !== null && typeof current === 'object') {
      current = current[segment];
    } else return undefined;
  }
  return current;
}

function criticalFieldResults(
  checkpoint: ReplayCheckpointV1,
  managedContextText: string,
): EvaluationCheckpointResultV1['criticalFields'] {
  const items = parseRenderedContext(managedContextText);
  return checkpoint.criticalFields.map((expectation) => {
    const item = items.get(expectation.locator.candidateId);
    let actual: JsonValue | undefined;
    if (item) {
      if (expectation.locator.mode === 'candidate-text') {
        actual = item.text;
      } else {
        let parsedText: JsonValue | undefined;
        try {
          parsedText = JsonValueSchema.parse(JSON.parse(item.text));
        } catch {
          parsedText = undefined;
        }
        if (parsedText !== undefined) {
          actual = valueAtPointer(parsedText, expectation.locator.jsonPointer);
        }
      }
    }
    return {
      id: expectation.id,
      category: expectation.category,
      preserved:
        actual !== undefined &&
        canonicalJson(actual) === canonicalJson(expectation.expectedValue),
      provenanceRetained:
        item?.sourceEventIds.includes(expectation.sourceEventId) ?? false,
      sourceEventId: expectation.sourceEventId,
      expectedValue: expectation.expectedValue,
      ...(actual !== undefined ? { actualValue: actual } : {}),
    };
  });
}

function normalizedActionValue(action: NormalizedAgentActionV1): JsonValue {
  return {
    kind: action.kind,
    name: action.name,
    arguments: action.arguments,
    targets: [...new Set(action.targets)].sort(),
  };
}

function actionFingerprint(action: NormalizedAgentActionV1): string {
  return canonicalJson(normalizedActionValue(action));
}

function targetAgreement(
  raw: NormalizedAgentActionV1,
  managed: NormalizedAgentActionV1,
): number {
  const rawTargets = new Set(raw.targets);
  const managedTargets = new Set(managed.targets);
  const union = new Set([...rawTargets, ...managedTargets]);
  if (union.size === 0) return 1;
  let intersection = 0;
  for (const target of rawTargets) {
    if (managedTargets.has(target)) intersection += 1;
  }
  return round(intersection / union.size);
}

export function countRepeatedActions(
  actions: readonly RecordedActionV1[],
): number | null {
  if (actions.some((entry) => entry.workspaceRevision === null)) return null;
  const counts = new Map<string, number>();
  let repeated = 0;
  for (const entry of actions) {
    const key = `${entry.workspaceRevision}\u0000${actionFingerprint(entry.action)}`;
    const count = counts.get(key) ?? 0;
    if (count > 0) repeated += 1;
    counts.set(key, count + 1);
  }
  return repeated;
}

function outcomeClassification(
  rawSuccess: boolean,
  managedSuccess: boolean,
): EvaluationCaseResultV1['outcomeClassification'] {
  if (rawSuccess && managedSuccess) return 'both-success';
  if (rawSuccess) return 'raw-only-success';
  if (managedSuccess) return 'managed-only-success';
  return 'neither-success';
}

function conditionMeasurements(
  evidence: EvaluationCaseV1['rawEvidence'],
): EvaluationCaseResultV1['rawMeasurements'] {
  return {
    ...(evidence.inputTokens !== undefined
      ? { inputTokens: evidence.inputTokens }
      : {}),
    ...(evidence.outputTokens !== undefined
      ? { outputTokens: evidence.outputTokens }
      : {}),
    ...(evidence.tokenSource !== undefined
      ? { tokenSource: evidence.tokenSource }
      : {}),
    ...(evidence.latencyMs !== undefined
      ? { latencyMs: evidence.latencyMs }
      : {}),
    ...(evidence.costUsd !== undefined ? { costUsd: evidence.costUsd } : {}),
    ...(evidence.usageCurve !== undefined
      ? { usageCurve: evidence.usageCurve }
      : {}),
    ...(evidence.observations !== undefined
      ? { observations: evidence.observations }
      : {}),
  };
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle]!;
  return round((sorted[middle - 1]! + sorted[middle]!) / 2);
}

function reductionPercent(raw: number, managed: number): number | null {
  return raw === 0 ? null : round(((raw - managed) / raw) * 100);
}

function sumAvailable(values: readonly (number | null)[]): number | null {
  if (values.some((value) => value === null)) return null;
  return values.reduce<number>((sum, value) => sum + value!, 0);
}

function observationAggregate(cases: readonly EvaluationCaseResultV1[]) {
  const pairs = cases.flatMap((evaluationCase) => {
    const raw = evaluationCase.rawMeasurements.observations;
    const managed = evaluationCase.managedMeasurements.observations;
    return raw === undefined || managed === undefined ? [] : [{ raw, managed }];
  });
  const raw = pairs.reduce((sum, pair) => sum + pair.raw.rawTokenEstimate, 0);
  const managed = pairs.reduce(
    (sum, pair) => sum + pair.managed.observedTokenEstimate,
    0,
  );
  // Taken from the baseline: it is the condition whose observations were left
  // whole, so its reducible share describes the opportunity, not the outcome.
  const reducibleRaw = pairs.reduce(
    (sum, pair) => sum + pair.raw.reducibleRawTokenEstimate,
    0,
  );
  return {
    observationCaseCount: pairs.length,
    rawObservationTokens: pairs.length === 0 ? null : raw,
    managedObservationTokens: pairs.length === 0 ? null : managed,
    observationTokenReductionPercent:
      pairs.length === 0 ? null : reductionPercent(raw, managed),
    medianObservationTokenReductionPercent: median(
      pairs.flatMap((pair) => {
        const reduction = reductionPercent(
          pair.raw.rawTokenEstimate,
          pair.managed.observedTokenEstimate,
        );
        return reduction === null ? [] : [reduction];
      }),
    ),
    reducibleSharePercent:
      pairs.length === 0 || raw === 0
        ? null
        : round((reducibleRaw / raw) * 100),
  };
}

function measuredInputTokenAggregate(cases: readonly EvaluationCaseResultV1[]) {
  const pairs = cases.flatMap((evaluationCase) => {
    const raw = evaluationCase.rawMeasurements.inputTokens;
    const managed = evaluationCase.managedMeasurements.inputTokens;
    return raw === undefined || managed === undefined ? [] : [{ raw, managed }];
  });
  const raw = pairs.reduce((sum, pair) => sum + pair.raw, 0);
  const managed = pairs.reduce((sum, pair) => sum + pair.managed, 0);
  return {
    measuredInputTokenCaseCount: pairs.length,
    rawMeasuredInputTokens: pairs.length === 0 ? null : raw,
    managedMeasuredInputTokens: pairs.length === 0 ? null : managed,
    measuredInputTokenReductionPercent:
      pairs.length === 0 ? null : reductionPercent(raw, managed),
    medianMeasuredInputTokenReductionPercent: median(
      pairs.flatMap((pair) => {
        const reduction = reductionPercent(pair.raw, pair.managed);
        return reduction === null ? [] : [reduction];
      }),
    ),
  };
}

function checkpointResult(
  evaluationCase: EvaluationCaseV1,
  checkpoint: ReplayCheckpointV1,
  estimator: TokenEstimator,
): { result: EvaluationCheckpointResultV1; failures: PolicyFailureV1[] } {
  validateCheckpoint(checkpoint);
  const rawContextText = renderRawContext(checkpoint);
  const managed = assembleManagedCheckpoint(checkpoint, estimator);
  const visible = visibleEventIds(checkpoint);
  const managedItems = parseRenderedContext(managed.contextText);
  for (const item of managedItems.values()) {
    for (const sourceEventId of item.sourceEventIds) {
      if (!visible.has(sourceEventId)) {
        throw new Error(
          `Managed candidate ${item.id} cites evidence not visible in raw checkpoint ${checkpoint.id}.`,
        );
      }
    }
  }

  const rawAction = evaluationCase.rawEvidence.checkpointActions.find(
    (entry) => entry.checkpointId === checkpoint.id,
  )!.nextAction;
  const managedAction = evaluationCase.managedEvidence.checkpointActions.find(
    (entry) => entry.checkpointId === checkpoint.id,
  )!.nextAction;
  const rawTokenEstimate = estimator.estimate(rawContextText);
  const managedTokenEstimate = managed.manifest.assembledTokenEstimate;
  for (const [label, value] of [
    ['raw', rawTokenEstimate],
    ['managed', managedTokenEstimate],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(
        `${label} token estimate is invalid at ${checkpoint.id}.`,
      );
    }
  }
  const estimatedTokenReduction = rawTokenEstimate - managedTokenEstimate;
  const criticalFields = criticalFieldResults(checkpoint, managed.contextText);
  const exactNextActionAgreement =
    actionFingerprint(rawAction) === actionFingerprint(managedAction);
  const result: EvaluationCheckpointResultV1 = {
    checkpointId: checkpoint.id,
    rawTokenEstimate,
    managedTokenEstimate,
    estimatedTokenReduction,
    estimatedTokenReductionPercent: reductionPercent(
      rawTokenEstimate,
      managedTokenEstimate,
    ),
    forcedCompaction: checkpoint.forcedCompaction,
    recoveryPassed: checkpoint.forcedCompaction
      ? exactNextActionAgreement &&
        criticalFields.every(
          (field) => field.preserved && field.provenanceRetained,
        )
      : null,
    rawNextAction: rawAction,
    managedNextAction: managedAction,
    exactNextActionAgreement,
    actionKindAgreement: rawAction.kind === managedAction.kind,
    targetAgreement: targetAgreement(rawAction, managedAction),
    criticalFields,
    manifest: managed.manifest,
  };
  const failures: PolicyFailureV1[] = [];
  for (const field of criticalFields) {
    if (field.preserved && field.provenanceRetained) continue;
    failures.push({
      kind: 'missing-critical-field',
      caseId: evaluationCase.id,
      checkpointId: checkpoint.id,
      message: `Critical field ${field.id} was not preserved with provenance.`,
      sourceEventIds: [field.sourceEventId],
      details: {
        fieldId: field.id,
        expectedValue: field.expectedValue,
        ...(field.actualValue !== undefined
          ? { actualValue: field.actualValue }
          : {}),
        valuePreserved: field.preserved,
        provenanceRetained: field.provenanceRetained,
      },
    });
  }
  if (!exactNextActionAgreement) {
    failures.push({
      kind: 'next-action-divergence',
      caseId: evaluationCase.id,
      checkpointId: checkpoint.id,
      message: `Managed context changed the normalized next action at ${checkpoint.id}.`,
      sourceEventIds: [],
      details: {
        rawNextAction: normalizedActionValue(rawAction),
        managedNextAction: normalizedActionValue(managedAction),
      },
    });
  }
  if (managed.manifest.status === 'mandatory-overflow') {
    failures.push({
      kind: 'mandatory-overflow',
      caseId: evaluationCase.id,
      checkpointId: checkpoint.id,
      message: `Mandatory context exceeded the ${checkpoint.tokenBudget}-token budget.`,
      sourceEventIds: [],
      details: {
        requestedTokenBudget: checkpoint.tokenBudget,
        assembledTokenEstimate: managed.manifest.assembledTokenEstimate,
        includedCandidateIds: managed.manifest.includedCandidateIds,
      },
    });
  }
  return { result, failures };
}

export function evaluateExperiment(
  input: EvaluationExperimentV1,
  estimator: TokenEstimator,
): EvaluationResultV1 {
  const experiment = EvaluationExperimentV1Schema.parse(input);
  if (experiment.policyId !== CONTEXT_ASSEMBLY_POLICY_ID) {
    throw new Error(
      `Unsupported evaluation policy ${experiment.policyId}; expected ${CONTEXT_ASSEMBLY_POLICY_ID}.`,
    );
  }
  if (experiment.tokenEstimatorId !== estimator.id) {
    throw new Error(
      `Token estimator mismatch: experiment uses ${experiment.tokenEstimatorId}, evaluator uses ${estimator.id}.`,
    );
  }
  unique(
    experiment.cases.map((evaluationCase) => evaluationCase.id),
    'evaluation case ID',
  );

  const cases: EvaluationCaseResultV1[] = [];
  const policyFailures: PolicyFailureV1[] = [];
  for (const evaluationCase of experiment.cases) {
    validateCase(evaluationCase);
    const checkpointResults: EvaluationCheckpointResultV1[] = [];
    for (const checkpoint of evaluationCase.checkpoints) {
      const evaluated = checkpointResult(evaluationCase, checkpoint, estimator);
      checkpointResults.push(evaluated.result);
      policyFailures.push(...evaluated.failures);
    }
    const rawRepeatedActionCount = countRepeatedActions(
      evaluationCase.rawEvidence.actions,
    );
    const managedRepeatedActionCount = countRepeatedActions(
      evaluationCase.managedEvidence.actions,
    );
    if (
      rawRepeatedActionCount !== null &&
      managedRepeatedActionCount !== null &&
      managedRepeatedActionCount > rawRepeatedActionCount
    ) {
      policyFailures.push({
        kind: 'repeated-work-increase',
        caseId: evaluationCase.id,
        message: `Managed run repeated ${managedRepeatedActionCount - rawRepeatedActionCount} more action(s) than raw.`,
        sourceEventIds: [],
        details: {
          rawRepeatedActionCount,
          managedRepeatedActionCount,
        },
      });
    }
    const rawSuccess = evaluationCase.rawEvidence.outcome.success;
    const managedSuccess = evaluationCase.managedEvidence.outcome.success;
    if (rawSuccess && !managedSuccess) {
      policyFailures.push({
        kind: 'baseline-success-managed-failure',
        caseId: evaluationCase.id,
        message: 'Raw context succeeded but managed context failed.',
        sourceEventIds: [],
        details: JsonValueSchema.parse({
          rawOutcome: evaluationCase.rawEvidence.outcome,
          managedOutcome: evaluationCase.managedEvidence.outcome,
        }),
      });
    }
    cases.push({
      caseId: evaluationCase.id,
      checkpointResults,
      rawRepeatedActionCount,
      managedRepeatedActionCount,
      rawSuccess,
      managedSuccess,
      outcomeClassification: outcomeClassification(rawSuccess, managedSuccess),
      rawActions: evaluationCase.rawEvidence.actions,
      managedActions: evaluationCase.managedEvidence.actions,
      rawOutcome: evaluationCase.rawEvidence.outcome,
      managedOutcome: evaluationCase.managedEvidence.outcome,
      rawProducer: evaluationCase.rawEvidence.producer,
      managedProducer: evaluationCase.managedEvidence.producer,
      rawMeasurements: conditionMeasurements(evaluationCase.rawEvidence),
      managedMeasurements: conditionMeasurements(
        evaluationCase.managedEvidence,
      ),
    });
  }

  const checkpoints = cases.flatMap((item) => item.checkpointResults);
  const criticalFields = checkpoints.flatMap((item) => item.criticalFields);
  const preservedFields = criticalFields.filter(
    (field) => field.preserved && field.provenanceRetained,
  ).length;
  const exactAgreements = checkpoints.filter(
    (checkpoint) => checkpoint.exactNextActionAgreement,
  ).length;
  const result = {
    schemaVersion: 1 as const,
    experimentId: experiment.id,
    repositoryFixture: experiment.repositoryFixture,
    policyId: experiment.policyId,
    tokenEstimatorId: experiment.tokenEstimatorId,
    status: policyFailures.length === 0 ? ('pass' as const) : ('fail' as const),
    cases,
    aggregate: {
      caseCount: cases.length,
      checkpointCount: checkpoints.length,
      medianEstimatedContextReductionPercent: median(
        checkpoints.flatMap((checkpoint) =>
          checkpoint.estimatedTokenReductionPercent === null
            ? []
            : [checkpoint.estimatedTokenReductionPercent],
        ),
      ),
      ...measuredInputTokenAggregate(cases),
      ...observationAggregate(cases),
      exactNextActionAgreements: exactAgreements,
      exactNextActionAgreementRate:
        checkpoints.length === 0
          ? null
          : round(exactAgreements / checkpoints.length),
      criticalFieldsPreserved: preservedFields,
      criticalFieldsTotal: criticalFields.length,
      criticalFieldRecall:
        criticalFields.length === 0
          ? null
          : round(preservedFields / criticalFields.length),
      rawTaskSuccesses: cases.filter((item) => item.rawSuccess).length,
      managedTaskSuccesses: cases.filter((item) => item.managedSuccess).length,
      baselineOnlyFailures: cases.filter(
        (item) => item.outcomeClassification === 'raw-only-success',
      ).length,
      rawRepeatedActionCount: sumAvailable(
        cases.map((item) => item.rawRepeatedActionCount),
      ),
      managedRepeatedActionCount: sumAvailable(
        cases.map((item) => item.managedRepeatedActionCount),
      ),
      forcedCompactionCheckpoints: checkpoints.filter(
        (checkpoint) => checkpoint.forcedCompaction,
      ).length,
      forcedCompactionRecoveries: checkpoints.filter(
        (checkpoint) => checkpoint.recoveryPassed === true,
      ).length,
    },
    policyFailures,
  };
  return EvaluationResultV1Schema.parse(result);
}
