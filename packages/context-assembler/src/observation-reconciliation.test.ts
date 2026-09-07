import { describe, expect, it } from 'vitest';

import type {
  DurableWorkingStateV1,
  PersistedAnyContextEventV1,
  WorkingFactV1,
  WorkingFileV1,
} from '@acm/core';

import { reconcileObservationEvents } from './observation-reconciliation.js';

const SESSION = `ses_${'1'.repeat(32)}`;
const NOW = '2026-09-07T12:00:00.000Z';
const HASH = 'a'.repeat(64);
const OTHER_HASH = 'b'.repeat(64);
const eventId = (sequence: number) =>
  `evt_${String(sequence).padStart(32, '0')}`;
const itemId = (sequence: number) =>
  `sti_${String(sequence).padStart(32, '0')}`;

function state(): DurableWorkingStateV1 {
  return {
    schemaVersion: 1,
    sessionId: SESSION,
    revision: 3,
    throughSequence: 10,
    requirements: [],
    decisions: [],
    files: [],
    failures: [],
    workItems: [],
    updatedAt: NOW,
  };
}

function eventBase(sequence: number) {
  return {
    schemaVersion: 1 as const,
    id: eventId(sequence),
    sessionId: SESSION,
    sequence,
    createdAt: NOW,
    rawArtifactUri: `artifact://sha256/${HASH}`,
    contentHash: HASH,
    byteLength: 25,
  };
}

function fileRead(
  sequence: number,
  payload: Partial<
    Extract<PersistedAnyContextEventV1, { kind: 'file_read' }>['payload']
  > = {},
): Extract<PersistedAnyContextEventV1, { kind: 'file_read' }> {
  return {
    ...eventBase(sequence),
    kind: 'file_read',
    payload: {
      schemaVersion: 1,
      path: 'src/index.ts',
      pathKind: 'repository-relative',
      scope: { kind: 'full' },
      encoding: 'utf-8',
      ...payload,
    },
  };
}

function fileState(overrides: Partial<WorkingFileV1> = {}): WorkingFileV1 {
  return {
    id: itemId(1),
    path: 'src/index.ts',
    pathKind: 'repository-relative',
    status: 'current',
    contentHash: OTHER_HASH,
    modified: true,
    provenance: [{ sourceEventId: eventId(5) }],
    introducedAtSequence: 5,
    updatedAtSequence: 5,
    ...overrides,
  };
}

function buildFailure(sequence = 1): PersistedAnyContextEventV1 {
  return {
    ...eventBase(sequence),
    kind: 'build_result',
    payload: {
      schemaVersion: 1,
      tool: 'typescript',
      sourceFormat: 'tsc-pretty-false',
      command: 'pnpm typecheck',
      workingDirectory: '.',
      exitCode: 2,
      buildDiagnostics: [],
      diagnostics: [],
      parseStatus: 'complete',
    },
  };
}

function resolvedFailure(
  overrides: Partial<WorkingFactV1> = {},
): WorkingFactV1 {
  return {
    id: itemId(2),
    text: 'Build failed',
    status: 'resolved',
    retention: 'required',
    provenance: [{ sourceEventId: eventId(1) }, { sourceEventId: eventId(8) }],
    introducedAtSequence: 2,
    updatedAtSequence: 8,
    ...overrides,
  };
}

describe('durable observation reconciliation', () => {
  it('excludes old full content after a later file state records a different hash', () => {
    const input = state();
    input.files = [fileState({ modified: false })];
    const result = reconcileObservationEvents(input, [fileRead(1)]);
    expect([...result.currentFileReadEventIds]).toEqual([]);
    expect(result.excludedCandidates).toEqual([
      { id: `event:${eventId(1)}`, reason: 'superseded' },
    ]);
  });

  it('invalidates every old range after an edit without comparing range and full-file hashes', () => {
    const input = state();
    input.files = [fileState({ contentHash: HASH })];
    const reads = [
      fileRead(1, { scope: { kind: 'range', startLine: 1, endLine: 3 } }),
      fileRead(2, { scope: { kind: 'range', startLine: 7, endLine: 9 } }),
    ];
    expect([
      ...reconcileObservationEvents(input, reads).currentFileReadEventIds,
    ]).toEqual([]);
  });

  it('keeps identical full content, fresh reads, and unrelated path identities', () => {
    const input = state();
    input.files = [fileState({ contentHash: HASH })];
    const reads = [
      fileRead(1),
      fileRead(2, { pathKind: 'virtual' }),
      fileRead(3, { path: 'src/other.ts' }),
      fileRead(6, { scope: { kind: 'range', startLine: 1, endLine: 3 } }),
    ];
    expect([
      ...reconcileObservationEvents(input, reads).currentFileReadEventIds,
    ]).toEqual(reads.map((event) => event.id));
  });

  it('requires a fresh range read when a later whole-file version cannot validate its scope', () => {
    const input = state();
    input.files = [fileState({ modified: false })];
    const reads = [
      fileRead(1, {
        scope: { kind: 'range', startLine: 1, endLine: 3 },
      }),
    ];
    expect([
      ...reconcileObservationEvents(input, reads).currentFileReadEventIds,
    ]).toEqual([]);
  });

  it('retains unknown unmodified versions and selects newest scope by sequence rather than input order', () => {
    const input = state();
    const { contentHash: _hash, ...unknownFile } = fileState({
      modified: false,
    });
    input.files = [unknownFile];
    const result = reconcileObservationEvents(input, [
      fileRead(3),
      fileRead(1),
    ]);
    expect([...result.currentFileReadEventIds]).toEqual([eventId(3)]);
  });

  it('remembers a recorded edit even when a later file state omits its hash', () => {
    const input = state();
    const { contentHash: _hash, ...unknownFile } = fileState({
      id: itemId(3),
      modified: false,
      introducedAtSequence: 7,
      updatedAtSequence: 7,
    });
    input.files = [
      fileState({ status: 'stale', updatedAtSequence: 7 }),
      unknownFile,
    ];
    const result = reconcileObservationEvents(input, [fileRead(1)]);
    expect([...result.currentFileReadEventIds]).toEqual([]);
  });

  it('only resolves observations with explicit later resolution provenance', () => {
    const input = state();
    input.failures = [resolvedFailure()];
    expect([
      ...reconcileObservationEvents(input, [buildFailure(), buildFailure(9)])
        .resolvedFailureEventIds,
    ]).toEqual([eventId(1)]);
    input.failures = [resolvedFailure({ updatedAtSequence: 1 })];
    expect([
      ...reconcileObservationEvents(input, [buildFailure()])
        .resolvedFailureEventIds,
    ]).toEqual([]);
  });

  it('does not resolve failures from generic passing verification', () => {
    const input = state();
    input.testStatus = {
      status: 'passed',
      summary: 'A different test passed',
      updatedAtSequence: 8,
      provenance: [{ sourceEventId: eventId(8) }],
    };
    expect([
      ...reconcileObservationEvents(input, [buildFailure()])
        .resolvedFailureEventIds,
    ]).toEqual([]);
  });

  it('keeps the whole failure detailed while any linked failure remains active', () => {
    const input = state();
    input.failures = [
      resolvedFailure(),
      resolvedFailure({ id: itemId(3), status: 'active' }),
    ];
    expect([
      ...reconcileObservationEvents(input, [buildFailure()])
        .resolvedFailureEventIds,
    ]).toEqual([]);
  });

  it('does not treat field-level resolution as resolution of the entire report', () => {
    const input = state();
    input.failures = [
      resolvedFailure({
        provenance: [
          {
            sourceEventId: eventId(1),
            jsonPointer: '/payload/buildDiagnostics/0',
          },
        ],
      }),
    ];
    expect([
      ...reconcileObservationEvents(input, [buildFailure()])
        .resolvedFailureEventIds,
    ]).toEqual([]);
  });

  it('rejects cross-session observations before applying state evidence', () => {
    expect(() =>
      reconcileObservationEvents(state(), [
        {
          ...fileRead(1),
          sessionId: `ses_${'2'.repeat(32)}`,
        },
      ]),
    ).toThrow('working-state session');
  });
});
