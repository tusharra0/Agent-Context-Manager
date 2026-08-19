import { describe, expect, it } from 'vitest';

import type { DurableWorkingStateV1 } from '@acm/core';

import { assembleContext } from './assembler.js';

const SESSION = 'ses_11111111111141118111111111111111';
const EVENT = 'evt_11111111111141118111111111111111';
const ITEM_1 = 'sti_11111111111141118111111111111111';
const ITEM_2 = 'sti_22222222222242228222222222222222';
const NOW = '2026-08-18T12:00:00.000Z';
const estimator = {
  id: 'characters@1',
  estimate: (text: string) => text.length,
};

function fact(id: typeof ITEM_1 | typeof ITEM_2, text: string) {
  return {
    id,
    text,
    status: 'active' as const,
    retention: 'required' as const,
    provenance: [{ sourceEventId: EVENT }],
    introducedAtSequence: 1,
    updatedAtSequence: 1,
  };
}

function state(): DurableWorkingStateV1 {
  return {
    schemaVersion: 1,
    sessionId: SESSION,
    revision: 1,
    throughSequence: 1,
    goal: fact(ITEM_1, 'Keep required context'),
    requirements: [fact(ITEM_2, 'Never discard raw evidence')],
    decisions: [],
    files: [],
    failures: [],
    workItems: [],
    updatedAt: NOW,
  };
}

describe('context assembler', () => {
  it('keeps every mandatory fact and reports overflow instead of truncating', () => {
    const assembled = assembleContext({
      state: state(),
      tokenBudget: 1,
      tokenEstimator: estimator,
    });
    expect(assembled.manifest.status).toBe('mandatory-overflow');
    expect(assembled.contextText).toContain('Keep required context');
    expect(assembled.contextText).toContain('Never discard raw evidence');
  });

  it('selects safe optional observations deterministically and rejects unsafe ones', () => {
    const baseCandidate = {
      class: 'recent-observation' as const,
      required: false,
      sequence: 2,
      sourceEventIds: [EVENT],
    };
    const assembled = assembleContext({
      state: state(),
      tokenBudget: 10_000,
      tokenEstimator: estimator,
      observations: [
        {
          safeForContext: true,
          candidate: { ...baseCandidate, id: 'safe', text: 'safe observation' },
        },
        {
          safeForContext: false,
          candidate: {
            ...baseCandidate,
            id: 'unsafe',
            text: 'unsafe observation',
          },
        },
      ],
    });
    expect(assembled.contextText).toContain('safe observation');
    expect(assembled.contextText).not.toContain('unsafe observation');
    expect(assembled.manifest.excludedCandidates).toContainEqual({
      id: 'unsafe',
      reason: 'unsafe',
    });
  });

  it('is monotonic as the optional budget increases', () => {
    const observation = {
      safeForContext: true,
      candidate: {
        id: 'optional',
        class: 'recent-observation' as const,
        required: false,
        sequence: 2,
        text: 'optional context',
        sourceEventIds: [EVENT],
      },
    };
    const mandatory = assembleContext({
      state: state(),
      tokenBudget: 10_000,
      tokenEstimator: estimator,
    });
    const small = assembleContext({
      state: state(),
      observations: [observation],
      tokenBudget: mandatory.manifest.assembledTokenEstimate,
      tokenEstimator: estimator,
    });
    const large = assembleContext({
      state: state(),
      observations: [observation],
      tokenBudget: 10_000,
      tokenEstimator: estimator,
    });
    expect(small.manifest.includedCandidateIds).not.toContain('optional');
    expect(large.manifest.includedCandidateIds).toEqual(
      expect.arrayContaining(small.manifest.includedCandidateIds),
    );
    expect(large.manifest.includedCandidateIds).toContain('optional');
  });

  it('records observations superseded before candidate selection', () => {
    const assembled = assembleContext({
      state: state(),
      preExcludedCandidates: [
        { id: 'event:older-file-read', reason: 'superseded' },
      ],
      tokenBudget: 10_000,
      tokenEstimator: estimator,
    });
    expect(assembled.manifest.excludedCandidates).toContainEqual({
      id: 'event:older-file-read',
      reason: 'superseded',
    });
  });

  it('rejects invalid estimator output and mandatory unsafe candidates', () => {
    expect(() =>
      assembleContext({
        state: state(),
        tokenBudget: 100,
        tokenEstimator: { id: 'invalid@1', estimate: () => Number.NaN },
      }),
    ).toThrow('invalid estimate');
    expect(() =>
      assembleContext({
        state: state(),
        tokenBudget: 100,
        tokenEstimator: estimator,
        observations: [
          {
            safeForContext: false,
            candidate: {
              id: 'unsafe-required',
              class: 'active-failure',
              required: true,
              sequence: 2,
              text: 'opaque failure',
              sourceEventIds: [EVENT],
            },
          },
        ],
      }),
    ).toThrow('cannot be mandatory');
  });
});
