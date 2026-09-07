import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { canonicalJson } from '@acm/core';
import { CONTEXT_ASSEMBLY_POLICY_ID } from '@acm/context-assembler';
import { describe, expect, it } from 'vitest';

import {
  EvaluationExperimentV1Schema,
  countRepeatedActions,
  evaluateExperiment,
  prepareEvaluationCheckpointContexts,
  renderEvaluationReport,
} from './index.js';
import type {
  EvaluationExperimentV1,
  NormalizedAgentActionV1,
} from './index.js';

const SESSION = `ses_${'1'.repeat(32)}`;
const EVENT = `evt_${'2'.repeat(32)}`;
const ESTIMATOR = {
  id: 'test-characters@1',
  estimate: (text: string) => text.length,
};

const ACTION: NormalizedAgentActionV1 = {
  kind: 'edit-file',
  name: 'apply_patch',
  arguments: { path: 'src/index.ts' },
  targets: ['src/index.ts'],
};

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function experiment(): EvaluationExperimentV1 {
  const rawText = `Requirement: do not weaken type safety. Remaining work: repair the compiler error. Modified file: src/index.ts. Active failure: TS2345.\n${'noise\n'.repeat(300)}src/index.ts(7,3): error TS2345: wrong value`;
  const managedText = canonicalJson({
    error: { code: 'TS2345', line: 7 },
  });
  return EvaluationExperimentV1Schema.parse({
    schemaVersion: 1,
    id: 'phase3-fixture',
    name: 'Phase 3 deterministic fixture',
    createdAt: '2026-08-26T12:00:00.000Z',
    repositoryFixture: {
      id: 'synthetic-typescript-project',
      revision: 'fixture-revision-1',
    },
    policyId: CONTEXT_ASSEMBLY_POLICY_ID,
    tokenEstimatorId: ESTIMATOR.id,
    cases: [
      {
        id: 'preserve-build-failure',
        task: 'Repair a TypeScript build failure.',
        checkpoints: [
          {
            id: 'after-build',
            throughSequence: 1,
            tokenBudget: 3_000,
            state: {
              schemaVersion: 1,
              sessionId: SESSION,
              revision: 1,
              throughSequence: 1,
              requirements: [
                {
                  id: `sti_${'3'.repeat(32)}`,
                  text: 'do not weaken type safety',
                  status: 'active',
                  retention: 'required',
                  provenance: [{ sourceEventId: EVENT }],
                  introducedAtSequence: 1,
                  updatedAtSequence: 1,
                },
              ],
              decisions: [],
              files: [
                {
                  id: `sti_${'4'.repeat(32)}`,
                  path: 'src/index.ts',
                  pathKind: 'repository-relative',
                  status: 'current',
                  modified: true,
                  provenance: [{ sourceEventId: EVENT }],
                  introducedAtSequence: 1,
                  updatedAtSequence: 1,
                },
              ],
              failures: [
                {
                  id: `sti_${'5'.repeat(32)}`,
                  text: 'TS2345',
                  status: 'active',
                  retention: 'required',
                  provenance: [{ sourceEventId: EVENT }],
                  introducedAtSequence: 1,
                  updatedAtSequence: 1,
                },
              ],
              workItems: [
                {
                  id: `sti_${'6'.repeat(32)}`,
                  text: 'repair the compiler error',
                  status: 'active',
                  retention: 'required',
                  provenance: [{ sourceEventId: EVENT }],
                  introducedAtSequence: 1,
                  updatedAtSequence: 1,
                },
              ],
              updatedAt: '2026-08-26T12:00:00.000Z',
            },
            instructions: [
              {
                id: 'task',
                text: 'Repair the build without weakening type safety.',
                sourceEventIds: [],
              },
            ],
            observations: [
              {
                eventId: EVENT,
                sequence: 1,
                rawText,
                contentHash: sha256(rawText),
                safeForContext: true,
                managedCandidate: {
                  id: `event:${EVENT}`,
                  class: 'active-failure',
                  required: true,
                  sequence: 1,
                  text: managedText,
                  sourceEventIds: [EVENT],
                },
              },
            ],
            criticalFields: [
              {
                id: 'build-error-line',
                category: 'build-field',
                sourceEventId: EVENT,
                sourceText: 'src/index.ts(7,3)',
                expectedValue: 7,
                locator: {
                  mode: 'candidate-json-pointer',
                  candidateId: `event:${EVENT}`,
                  jsonPointer: '/error/line',
                },
              },
              {
                id: 'negative-requirement',
                category: 'requirement',
                sourceEventId: EVENT,
                sourceText: 'do not weaken type safety',
                expectedValue: 'do not weaken type safety',
                locator: {
                  mode: 'candidate-text',
                  candidateId: `state:sti_${'3'.repeat(32)}`,
                },
              },
              {
                id: 'modified-file',
                category: 'modified-file',
                sourceEventId: EVENT,
                sourceText: 'src/index.ts',
                expectedValue: 'src/index.ts',
                locator: {
                  mode: 'candidate-json-pointer',
                  candidateId: `state:sti_${'4'.repeat(32)}`,
                  jsonPointer: '/path',
                },
              },
              {
                id: 'active-failure',
                category: 'active-failure',
                sourceEventId: EVENT,
                sourceText: 'TS2345',
                expectedValue: 'TS2345',
                locator: {
                  mode: 'candidate-text',
                  candidateId: `state:sti_${'5'.repeat(32)}`,
                },
              },
              {
                id: 'remaining-work',
                category: 'remaining-work',
                sourceEventId: EVENT,
                sourceText: 'repair the compiler error',
                expectedValue: 'repair the compiler error',
                locator: {
                  mode: 'candidate-text',
                  candidateId: `state:sti_${'6'.repeat(32)}`,
                },
              },
            ],
            forcedCompaction: true,
          },
        ],
        rawEvidence: {
          condition: 'raw',
          producer: { kind: 'synthetic' },
          checkpointActions: [
            { checkpointId: 'after-build', nextAction: ACTION },
          ],
          actions: [
            { action: ACTION, workspaceRevision: 'rev-a' },
            { action: ACTION, workspaceRevision: 'rev-a' },
          ],
          outcome: {
            success: true,
            assertions: [{ id: 'tests', passed: true }],
          },
        },
        managedEvidence: {
          condition: 'managed',
          producer: { kind: 'synthetic' },
          checkpointActions: [
            { checkpointId: 'after-build', nextAction: ACTION },
          ],
          actions: [{ action: ACTION, workspaceRevision: 'rev-a' }],
          outcome: {
            success: true,
            assertions: [{ id: 'tests', passed: true }],
          },
        },
      },
    ],
  });
}

describe('offline paired evaluation', () => {
  it('reports estimated context reduction without inventing measured token savings', () => {
    const result = evaluateExperiment(experiment(), ESTIMATOR);

    expect(result.status).toBe('pass');
    expect(
      result.aggregate.medianEstimatedContextReductionPercent,
    ).toBeGreaterThan(0);
    expect(result.aggregate.measuredInputTokenCaseCount).toBe(0);
    expect(result.aggregate.rawMeasuredInputTokens).toBeNull();
    expect(result.aggregate.managedMeasuredInputTokens).toBeNull();
    expect(result.aggregate.measuredInputTokenReductionPercent).toBeNull();
    expect(
      result.aggregate.medianMeasuredInputTokenReductionPercent,
    ).toBeNull();
    expect(result.aggregate.exactNextActionAgreementRate).toBe(1);
    expect(result.aggregate.criticalFieldRecall).toBe(1);
    expect(result.aggregate.rawRepeatedActionCount).toBe(1);
    expect(result.aggregate.managedRepeatedActionCount).toBe(0);
    expect(result.aggregate.baselineOnlyFailures).toBe(0);
    expect(result.aggregate.forcedCompactionRecoveries).toBe(1);
    expect(result.policyFailures).toEqual([]);
  });

  it('reports zero measured savings for equal usage despite a shorter checkpoint', () => {
    const input = experiment();
    input.cases[0]!.rawEvidence.inputTokens = 100;
    input.cases[0]!.managedEvidence.inputTokens = 100;

    const result = evaluateExperiment(input, ESTIMATOR);

    expect(result.aggregate).toMatchObject({
      caseCount: 1,
      measuredInputTokenCaseCount: 1,
      rawMeasuredInputTokens: 100,
      managedMeasuredInputTokens: 100,
      measuredInputTokenReductionPercent: 0,
      medianMeasuredInputTokenReductionPercent: 0,
      rawTaskSuccesses: 1,
      managedTaskSuccesses: 1,
    });
    expect(
      result.aggregate.medianEstimatedContextReductionPercent,
    ).toBeGreaterThan(0);
    const report = renderEvaluationReport(result);
    expect(report).toContain(
      'Measured input-token reduction (covered pairs): 0.00%',
    );
    expect(report).toContain('Raw task successes: 1/1');
    expect(report).toContain('Managed task successes: 1/1');
  });

  it('pairs measured case totals and reports coverage separately from checkpoint estimates', () => {
    const input = experiment();
    const first = input.cases[0]!;
    first.rawEvidence.inputTokens = 100;
    first.managedEvidence.inputTokens = 50;
    const second = structuredClone(first);
    second.id = 'second';
    second.rawEvidence.inputTokens = 300;
    second.managedEvidence.inputTokens = 270;
    const unpaired = structuredClone(first);
    unpaired.id = 'unpaired';
    unpaired.rawEvidence.inputTokens = 1_000;
    delete unpaired.managedEvidence.inputTokens;
    input.cases.push(second, unpaired);

    const result = evaluateExperiment(input, ESTIMATOR);

    expect(result.aggregate).toMatchObject({
      caseCount: 3,
      measuredInputTokenCaseCount: 2,
      rawMeasuredInputTokens: 400,
      managedMeasuredInputTokens: 320,
      measuredInputTokenReductionPercent: 20,
      medianMeasuredInputTokenReductionPercent: 30,
      rawTaskSuccesses: 3,
      managedTaskSuccesses: 3,
    });
  });

  it('preserves measured zero usage while leaving percentage reduction undefined', () => {
    const input = experiment();
    input.cases[0]!.rawEvidence.inputTokens = 0;
    input.cases[0]!.managedEvidence.inputTokens = 0;

    expect(evaluateExperiment(input, ESTIMATOR).aggregate).toMatchObject({
      measuredInputTokenCaseCount: 1,
      rawMeasuredInputTokens: 0,
      managedMeasuredInputTokens: 0,
      measuredInputTokenReductionPercent: null,
      medianMeasuredInputTokenReductionPercent: null,
    });
  });

  it('turns managed regressions into detailed policy failures', () => {
    const input = structuredClone(experiment());
    const evaluationCase = input.cases[0]!;
    evaluationCase.checkpoints[0]!.criticalFields[0]!.expectedValue = 8;
    evaluationCase.managedEvidence.checkpointActions[0]!.nextAction = {
      kind: 'finish',
      name: 'finish',
      arguments: {},
      targets: [],
    };
    evaluationCase.managedEvidence.actions = [
      { action: ACTION, workspaceRevision: 'rev-a' },
      { action: ACTION, workspaceRevision: 'rev-a' },
      { action: ACTION, workspaceRevision: 'rev-a' },
    ];
    evaluationCase.managedEvidence.outcome = {
      success: false,
      assertions: [{ id: 'tests', passed: false, evidence: 'Still failing' }],
    };

    const result = evaluateExperiment(input, ESTIMATOR);

    expect(result.status).toBe('fail');
    expect(result.cases[0]!.outcomeClassification).toBe('raw-only-success');
    expect(result.policyFailures.map((failure) => failure.kind)).toEqual(
      expect.arrayContaining([
        'missing-critical-field',
        'next-action-divergence',
        'repeated-work-increase',
        'baseline-success-managed-failure',
      ]),
    );
  });

  it('rejects corrupt raw evidence and future checkpoint data', () => {
    const corrupt = structuredClone(experiment());
    corrupt.cases[0]!.checkpoints[0]!.observations[0]!.contentHash = '0'.repeat(
      64,
    );
    expect(() => evaluateExperiment(corrupt, ESTIMATOR)).toThrow(
      'Raw observation hash mismatch',
    );

    const future = structuredClone(experiment());
    future.cases[0]!.checkpoints[0]!.observations[0]!.sequence = 2;
    future.cases[0]!.checkpoints[0]!.observations[0]!.managedCandidate.sequence = 2;
    expect(() => evaluateExperiment(future, ESTIMATOR)).toThrow(
      'data from the future',
    );
  });

  it('retains superseded observations in the raw baseline and records their managed exclusion', () => {
    const input = experiment();
    const checkpoint = input.cases[0]!.checkpoints[0]!;
    checkpoint.observations[0]!.managedExclusion = 'superseded';

    const contexts = prepareEvaluationCheckpointContexts(checkpoint, ESTIMATOR);
    const result = evaluateExperiment(input, ESTIMATOR);

    expect(contexts.rawContextText).toContain('noise');
    expect(contexts.managedContextText).not.toContain('noise');
    expect(JSON.parse(contexts.managedContextText).items).not.toContainEqual(
      expect.objectContaining({ id: `event:${EVENT}` }),
    );
    expect(
      result.cases[0]!.checkpointResults[0]!.manifest.excludedCandidates,
    ).toContainEqual({ id: `event:${EVENT}`, reason: 'superseded' });
    // Exclusion does not excuse losing a critical field declared by the case.
    expect(result.policyFailures).toContainEqual(
      expect.objectContaining({ kind: 'missing-critical-field' }),
    );
  });

  it('rejects incomparable token estimators', () => {
    expect(() =>
      evaluateExperiment(experiment(), {
        id: 'different@1',
        estimate: ESTIMATOR.estimate,
      }),
    ).toThrow('Token estimator mismatch');
  });

  it('reports mandatory overflow instead of truncating required facts', () => {
    const input = structuredClone(experiment());
    input.cases[0]!.checkpoints[0]!.tokenBudget = 0;

    const result = evaluateExperiment(input, ESTIMATOR);

    expect(result.status).toBe('fail');
    expect(result.cases[0]!.checkpointResults[0]!.manifest.status).toBe(
      'mandatory-overflow',
    );
    expect(result.aggregate.criticalFieldRecall).toBe(1);
    expect(result.policyFailures).toContainEqual(
      expect.objectContaining({ kind: 'mandatory-overflow' }),
    );
  });

  it('rejects critical facts that are absent from their cited raw evidence', () => {
    const input = structuredClone(experiment());
    input.cases[0]!.checkpoints[0]!.criticalFields[0]!.sourceText =
      'not in the raw event';

    expect(() => evaluateExperiment(input, ESTIMATOR)).toThrow(
      'is not present in its cited raw evidence',
    );
  });

  it('counts repeated work only under an unchanged workspace revision', () => {
    expect(
      countRepeatedActions([
        { action: ACTION, workspaceRevision: 'a' },
        { action: ACTION, workspaceRevision: 'b' },
        { action: ACTION, workspaceRevision: 'b' },
      ]),
    ).toBe(1);
  });

  it('reports repeated work as unavailable when any action revision is unknown', () => {
    expect(
      countRepeatedActions([{ action: ACTION, workspaceRevision: null }]),
    ).toBeNull();
    const input = experiment();
    input.cases[0]!.managedEvidence.actions = [
      { action: ACTION, workspaceRevision: null },
      { action: ACTION, workspaceRevision: null },
    ];

    const result = evaluateExperiment(input, ESTIMATOR);

    expect(result.cases[0]!.managedRepeatedActionCount).toBeNull();
    expect(result.aggregate.managedRepeatedActionCount).toBeNull();
    expect(
      result.policyFailures.some(
        (failure) => failure.kind === 'repeated-work-increase',
      ),
    ).toBe(false);
    expect(renderEvaluationReport(result)).toContain(
      'Repeated actions, raw/managed: 1/n/a',
    );
  });

  it('renders deterministic human-readable reports', () => {
    const result = evaluateExperiment(experiment(), ESTIMATOR);
    const first = renderEvaluationReport(result);
    const second = renderEvaluationReport(result);

    expect(first).toBe(second);
    expect(first).toContain('Median estimated checkpoint-context reduction');
    expect(first).toContain('Policy failures');
    expect(first).toContain('None.');
  });

  it('replays the committed offline evaluation fixture', async () => {
    const fixture = new URL(
      '../test/fixtures/v1/passing-experiment.json',
      import.meta.url,
    );
    const input = EvaluationExperimentV1Schema.parse(
      JSON.parse(await readFile(fixture, 'utf8')),
    );
    const result = evaluateExperiment(input, {
      id: 'utf8-bytes-div-4@1',
      estimate: (text) => Math.ceil(Buffer.byteLength(text, 'utf8') / 4),
    });

    expect(result.status).toBe('pass');
    expect(result.aggregate.criticalFieldRecall).toBe(1);
    expect(result.cases[0]!.rawMeasurements).toMatchObject({
      inputTokens: 120,
      latencyMs: 100,
    });
  });
});

describe('observation aggregate', () => {
  function summary(
    observedTokenEstimate: number,
  ): NonNullable<
    EvaluationExperimentV1['cases'][number]['rawEvidence']['observations']
  > {
    return {
      observationCount: 4,
      tokenEstimatorId: 'test-characters@1',
      rawTokenEstimate: 1000,
      observedTokenEstimate,
      reducibleRawTokenEstimate: 600,
      reducibleReducedTokenEstimate: 100,
      reducibleSharePercent: 60,
      observedReductionPercent: ((1000 - observedTokenEstimate) / 1000) * 100,
      outcomes: {
        applied: 2,
        'not-requested': 0,
        'no-reducer': 1,
        unsafe: 1,
        'not-smaller': 0,
        failed: 0,
        'raw-evidence-unavailable': 0,
        'binary-output': 0,
      },
    };
  }

  function withObservations(): EvaluationExperimentV1 {
    const input = experiment();
    const evaluationCase = input.cases[0]!;
    return {
      ...input,
      cases: [
        {
          ...evaluationCase,
          rawEvidence: {
            ...evaluationCase.rawEvidence,
            observations: summary(1000),
          },
          managedEvidence: {
            ...evaluationCase.managedEvidence,
            observations: summary(500),
          },
        },
      ],
    };
  }

  it('measures the saving against the baseline that kept its observations', () => {
    expect(
      evaluateExperiment(withObservations(), ESTIMATOR).aggregate,
    ).toMatchObject({
      observationCaseCount: 1,
      rawObservationTokens: 1000,
      managedObservationTokens: 500,
      observationTokenReductionPercent: 50,
      medianObservationTokenReductionPercent: 50,
      // Taken from the baseline: what a reduction could reach, not what it did.
      reducibleSharePercent: 60,
    });
  });

  it('reports nothing when a run recorded no observations', () => {
    expect(evaluateExperiment(experiment(), ESTIMATOR).aggregate).toMatchObject(
      {
        observationCaseCount: 0,
        rawObservationTokens: null,
        managedObservationTokens: null,
        observationTokenReductionPercent: null,
        reducibleSharePercent: null,
      },
    );
  });

  it('carries the summary through to case measurements', () => {
    const result = evaluateExperiment(withObservations(), ESTIMATOR);
    expect(result.cases[0]?.rawMeasurements.observations).toMatchObject({
      observationCount: 4,
      reducibleSharePercent: 60,
    });
    expect(
      result.cases[0]?.managedMeasurements.observations?.observedTokenEstimate,
    ).toBe(500);
  });
});
