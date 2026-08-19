import { describe, expect, it } from 'vitest';

import {
  StateRevisionConflictError,
  WorkingStateInvariantError,
  applyWorkingStateTransition,
  createEmptyWorkingState,
  replayWorkingState,
} from './state-engine.js';

const SESSION = 'ses_11111111111141118111111111111111';
const EVENT_1 = 'evt_11111111111141118111111111111111';
const EVENT_2 = 'evt_22222222222242228222222222222222';
const ITEM_1 = 'sti_11111111111141118111111111111111';
const ITEM_2 = 'sti_22222222222242228222222222222222';
const NOW = '2026-08-18T12:00:00.000Z';
const LATER = '2026-08-18T12:01:00.000Z';
const evidence = (sourceEventId: typeof EVENT_1 | typeof EVENT_2) => [
  { sourceEventId },
];

describe('working-state engine', () => {
  it('applies explicit facts and reproduces the same canonical state by replay', () => {
    const first = {
      schemaVersion: 1 as const,
      expectedRevision: 0,
      operations: [
        {
          operation: 'set-goal' as const,
          itemId: ITEM_1,
          text: 'Implement Phase 2',
          provenance: evidence(EVENT_1),
        },
      ],
    };
    const second = {
      schemaVersion: 1 as const,
      expectedRevision: 1,
      operations: [
        {
          operation: 'add-fact' as const,
          category: 'requirement' as const,
          itemId: ITEM_2,
          text: 'Never discard raw evidence',
          provenance: evidence(EVENT_2),
        },
      ],
    };
    const initial = createEmptyWorkingState(SESSION, NOW);
    const afterFirst = applyWorkingStateTransition(initial, first, {
      sequence: 1,
      createdAt: NOW,
    });
    const expected = applyWorkingStateTransition(afterFirst, second, {
      sequence: 2,
      createdAt: LATER,
    });

    expect(
      replayWorkingState(SESSION, NOW, [
        { transition: second, sequence: 2, createdAt: LATER },
        { transition: first, sequence: 1, createdAt: NOW },
      ]),
    ).toEqual(expected);
    expect(expected.requirements[0]).toMatchObject({
      text: 'Never discard raw evidence',
      retention: 'required',
      status: 'active',
    });
  });

  it('requires explicit supersession and preserves the prior goal', () => {
    const initial = createEmptyWorkingState(SESSION, NOW);
    const state = applyWorkingStateTransition(
      initial,
      {
        schemaVersion: 1,
        expectedRevision: 0,
        operations: [
          {
            operation: 'set-goal',
            itemId: ITEM_1,
            text: 'First goal',
            provenance: evidence(EVENT_1),
          },
        ],
      },
      { sequence: 1, createdAt: NOW },
    );
    expect(() =>
      applyWorkingStateTransition(
        state,
        {
          schemaVersion: 1,
          expectedRevision: 1,
          operations: [
            {
              operation: 'set-goal',
              itemId: ITEM_2,
              text: 'Replacement',
              provenance: evidence(EVENT_2),
            },
          ],
        },
        { sequence: 2, createdAt: LATER },
      ),
    ).toThrow(WorkingStateInvariantError);

    const replaced = applyWorkingStateTransition(
      state,
      {
        schemaVersion: 1,
        expectedRevision: 1,
        operations: [
          {
            operation: 'set-goal',
            itemId: ITEM_2,
            text: 'Replacement',
            provenance: evidence(EVENT_2),
            supersedes: ITEM_1,
          },
        ],
      },
      { sequence: 2, createdAt: LATER },
    );
    expect(replaced.goal).toMatchObject({ id: ITEM_2, supersedes: ITEM_1 });
  });

  it('rejects stale revisions and invalid category status changes', () => {
    const initial = createEmptyWorkingState(SESSION, NOW);
    expect(() =>
      applyWorkingStateTransition(
        initial,
        {
          schemaVersion: 1,
          expectedRevision: 1,
          operations: [
            {
              operation: 'set-goal',
              itemId: ITEM_1,
              text: 'Goal',
              provenance: evidence(EVENT_1),
            },
          ],
        },
        { sequence: 1, createdAt: NOW },
      ),
    ).toThrow(StateRevisionConflictError);

    const withFailure = applyWorkingStateTransition(
      initial,
      {
        schemaVersion: 1,
        expectedRevision: 0,
        operations: [
          {
            operation: 'add-fact',
            category: 'failure',
            itemId: ITEM_1,
            text: 'Build failed',
            provenance: evidence(EVENT_1),
          },
        ],
      },
      { sequence: 1, createdAt: NOW },
    );
    expect(() =>
      applyWorkingStateTransition(
        withFailure,
        {
          schemaVersion: 1,
          expectedRevision: 1,
          operations: [
            {
              operation: 'change-fact-status',
              category: 'failure',
              itemId: ITEM_1,
              status: 'completed',
              provenance: evidence(EVENT_2),
            },
          ],
        },
        { sequence: 2, createdAt: LATER },
      ),
    ).toThrow('invalid for failure');
  });

  it('versions changed files and rejects ambiguous replacement', () => {
    const hash1 = 'a'.repeat(64);
    const hash2 = 'b'.repeat(64);
    const first = applyWorkingStateTransition(
      createEmptyWorkingState(SESSION, NOW),
      {
        schemaVersion: 1,
        expectedRevision: 0,
        operations: [
          {
            operation: 'record-file',
            itemId: ITEM_1,
            path: 'src/index.ts',
            pathKind: 'repository-relative',
            contentHash: hash1,
            modified: false,
            provenance: evidence(EVENT_1),
          },
        ],
      },
      { sequence: 1, createdAt: NOW },
    );
    expect(() =>
      applyWorkingStateTransition(
        first,
        {
          schemaVersion: 1,
          expectedRevision: 1,
          operations: [
            {
              operation: 'record-file',
              itemId: ITEM_2,
              path: 'src/index.ts',
              pathKind: 'repository-relative',
              contentHash: hash2,
              modified: true,
              provenance: evidence(EVENT_2),
            },
          ],
        },
        { sequence: 2, createdAt: LATER },
      ),
    ).toThrow('must supersede');

    const second = applyWorkingStateTransition(
      first,
      {
        schemaVersion: 1,
        expectedRevision: 1,
        operations: [
          {
            operation: 'record-file',
            itemId: ITEM_2,
            path: 'src/index.ts',
            pathKind: 'repository-relative',
            contentHash: hash2,
            modified: true,
            provenance: evidence(EVENT_2),
            supersedes: ITEM_1,
          },
        ],
      },
      { sequence: 2, createdAt: LATER },
    );
    expect(second.files.map((file) => file.status)).toEqual([
      'stale',
      'current',
    ]);
  });
});
