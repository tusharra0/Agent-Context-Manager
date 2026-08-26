import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { canonicalJson } from '@acm/core';
import { CONTEXT_ASSEMBLY_POLICY_ID } from '@acm/context-assembler';
import { describe, expect, it } from 'vitest';

import {
  EvaluationExperimentV1Schema,
  countRepeatedActions,
  evaluateExperiment,
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
  it('reports paired token reduction without losing behavior or critical fields', () => {
    const result = evaluateExperiment(experiment(), ESTIMATOR);

    expect(result.status).toBe('pass');
    expect(result.aggregate.medianTokenReductionPercent).toBeGreaterThan(0);
    expect(result.aggregate.exactNextActionAgreementRate).toBe(1);
    expect(result.aggregate.criticalFieldRecall).toBe(1);
    expect(result.aggregate.rawRepeatedActionCount).toBe(1);
    expect(result.aggregate.managedRepeatedActionCount).toBe(0);
    expect(result.aggregate.baselineOnlyFailures).toBe(0);
    expect(result.aggregate.forcedCompactionRecoveries).toBe(1);
    expect(result.policyFailures).toEqual([]);
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

  it('renders deterministic human-readable reports', () => {
    const result = evaluateExperiment(experiment(), ESTIMATOR);
    const first = renderEvaluationReport(result);
    const second = renderEvaluationReport(result);

    expect(first).toBe(second);
    expect(first).toContain('Median input-token reduction');
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
