import { describe, expect, it } from 'vitest';

import { createSessionId } from '@acm/core';
import type { HarnessEventDataV1, HarnessEventV1 } from '@acm/harness-port';

import { buildConditionEvidenceFromHarnessTrace } from './harness-trace.js';
import { countRepeatedActions } from './evaluator.js';

const SESSION_ID = createSessionId(
  () => '00000000-0000-4000-8000-000000000003',
);

function event(sequence: number, data: HarnessEventDataV1): HarnessEventV1 {
  return {
    schemaVersion: 1,
    sessionId: SESSION_ID,
    harness: 'codex',
    sequence,
    createdAt: '2026-08-26T12:00:00.000Z',
    ...data,
  };
}

describe('buildConditionEvidenceFromHarnessTrace', () => {
  it('maps tools, workspace revisions, checkpoints, and usage', () => {
    const evidence = buildConditionEvidenceFromHarnessTrace({
      condition: 'managed',
      harness: 'codex',
      model: 'gpt-5.4',
      turns: [
        {
          checkpointId: 'after-observation',
          workspaceRevision: 'rev-a',
          events: [
            event(1, {
              kind: 'tool-call',
              toolCallId: 'call-1',
              toolName: 'bash',
              input: { command: 'pnpm test' },
              workspaceRevision: 'rev-a',
            }),
            event(2, {
              kind: 'usage',
              inputTokens: 20,
              outputTokens: 5,
              totalTokens: 25,
            }),
            event(3, { kind: 'turn-completed', finishReason: 'stop' }),
          ],
        },
      ],
      outcome: {
        success: true,
        assertions: [{ id: 'tests', passed: true }],
      },
      latencyMs: 125,
    });

    expect(evidence.producer).toEqual({
      kind: 'recorded-harness',
      harness: 'codex',
      model: 'gpt-5.4',
    });
    expect(evidence.checkpointActions[0]?.nextAction).toMatchObject({
      kind: 'test',
      name: 'bash',
      targets: ['pnpm test'],
    });
    expect(evidence.actions[0]).toMatchObject({
      workspaceRevision: 'rev-a',
      action: { kind: 'test' },
    });
    expect(evidence).toMatchObject({
      inputTokens: 20,
      outputTokens: 5,
      tokenSource: 'ai-sdk-harness-stream@1',
      latencyMs: 125,
    });
  });

  it('preserves tool boundary revisions and distinguishes test-edit-test from repeated work', () => {
    const evidence = buildConditionEvidenceFromHarnessTrace({
      condition: 'managed',
      harness: 'codex',
      model: 'fixture-model',
      turns: [
        {
          workspaceRevision: 'rev-final',
          events: [
            event(1, {
              kind: 'tool-call',
              toolCallId: 'test-1',
              toolName: 'bash',
              input: { command: 'pnpm test' },
              workspaceRevision: 'rev-before',
            }),
            event(2, {
              kind: 'tool-call',
              toolCallId: 'edit',
              toolName: 'fileChange',
              input: { path: 'index.ts' },
              workspaceRevision: 'rev-before',
            }),
            event(3, {
              kind: 'tool-call',
              toolCallId: 'test-2',
              toolName: 'bash',
              input: { command: 'pnpm test' },
              workspaceRevision: 'rev-after',
            }),
            event(4, {
              kind: 'tool-call',
              toolCallId: 'test-3',
              toolName: 'bash',
              input: { command: 'pnpm test' },
              workspaceRevision: 'rev-after',
            }),
            event(5, { kind: 'turn-completed', finishReason: 'stop' }),
          ],
        },
      ],
      outcome: { success: true, assertions: [{ id: 'tests', passed: true }] },
    });

    expect(evidence.actions.map((entry) => entry.workspaceRevision)).toEqual([
      'rev-before',
      'rev-before',
      'rev-after',
      'rev-after',
    ]);
    expect(evidence.actions[1]?.action.kind).toBe('edit-file');
    expect(countRepeatedActions(evidence.actions.slice(0, 3))).toBe(0);
    expect(countRepeatedActions(evidence.actions)).toBe(1);
  });

  it('never assigns the final turn hash to tools without authoritative revisions', () => {
    const evidence = buildConditionEvidenceFromHarnessTrace({
      condition: 'raw',
      harness: 'codex',
      model: 'fixture-model',
      turns: [
        {
          workspaceRevision: 'rev-final',
          events: [
            event(1, {
              kind: 'tool-call',
              toolCallId: 'test-1',
              toolName: 'bash',
              input: { command: 'pnpm test' },
            }),
            event(2, {
              kind: 'tool-call',
              toolCallId: 'edit',
              toolName: 'edit',
              input: { path: 'index.ts' },
            }),
            event(3, {
              kind: 'tool-call',
              toolCallId: 'test-2',
              toolName: 'bash',
              input: { command: 'pnpm test' },
              workspaceRevision: null,
            }),
            event(4, { kind: 'turn-completed', finishReason: 'stop' }),
          ],
        },
      ],
      outcome: { success: true, assertions: [{ id: 'tests', passed: true }] },
    });

    expect(evidence.actions.map((entry) => entry.workspaceRevision)).toEqual([
      null,
      null,
      null,
    ]);
    expect(countRepeatedActions(evidence.actions)).toBeNull();
  });

  it('does not sum partial usage into an apparently complete multi-turn total', () => {
    const evidence = buildConditionEvidenceFromHarnessTrace({
      condition: 'raw',
      harness: 'codex',
      model: 'fixture-model',
      turns: [
        {
          workspaceRevision: 'rev-a',
          events: [
            event(1, {
              kind: 'usage',
              inputTokens: 100,
              outputTokens: 10,
              totalTokens: 110,
            }),
            event(2, { kind: 'turn-completed', finishReason: 'stop' }),
          ],
        },
        {
          workspaceRevision: 'rev-b',
          events: [event(3, { kind: 'turn-completed', finishReason: 'stop' })],
        },
      ],
      outcome: { success: true, assertions: [{ id: 'tests', passed: true }] },
    });

    expect(evidence.inputTokens).toBeUndefined();
    expect(evidence.outputTokens).toBeUndefined();
    expect(evidence.tokenSource).toBeUndefined();
  });

  it('sums complete usage from every turn including measured zeros', () => {
    const evidence = buildConditionEvidenceFromHarnessTrace({
      condition: 'raw',
      harness: 'codex',
      model: 'fixture-model',
      turns: [
        {
          workspaceRevision: 'rev-a',
          events: [
            event(1, {
              kind: 'usage',
              inputTokens: 100,
              outputTokens: 10,
              totalTokens: 110,
            }),
            event(2, { kind: 'turn-completed', finishReason: 'stop' }),
          ],
        },
        {
          workspaceRevision: 'rev-b',
          events: [
            event(3, {
              kind: 'usage',
              inputTokens: 0,
              outputTokens: 0,
              totalTokens: 0,
            }),
            event(4, { kind: 'turn-completed', finishReason: 'stop' }),
          ],
        },
      ],
      outcome: { success: true, assertions: [{ id: 'tests', passed: true }] },
    });

    expect(evidence).toMatchObject({
      inputTokens: 100,
      outputTokens: 10,
      tokenSource: 'ai-sdk-harness-stream@1',
    });
  });

  it.each(['duplicate', 'interrupted', 'incomplete'] as const)(
    'keeps %s usage totals unavailable',
    (problem) => {
      const events = [
        event(1, {
          kind: 'usage',
          inputTokens: 100,
          outputTokens: 10,
          totalTokens: 110,
        }),
      ];
      if (problem === 'duplicate')
        events.push(
          event(2, {
            kind: 'usage',
            inputTokens: 100,
            outputTokens: 10,
            totalTokens: 110,
          }),
        );
      if (problem === 'interrupted')
        events.push(event(2, { kind: 'interrupted' }));
      if (problem !== 'incomplete')
        events.push(event(3, { kind: 'turn-completed', finishReason: 'stop' }));
      const evidence = buildConditionEvidenceFromHarnessTrace({
        condition: 'raw',
        harness: 'codex',
        model: 'fixture-model',
        turns: [{ workspaceRevision: 'rev-a', events }],
        outcome: { success: true, assertions: [{ id: 'tests', passed: true }] },
      });

      expect(evidence.inputTokens).toBeUndefined();
      expect(evidence.outputTokens).toBeUndefined();
    },
  );

  it('rejects mixed harnesses and non-monotonic traces', () => {
    const first = event(1, { kind: 'turn-completed', finishReason: 'stop' });
    expect(() =>
      buildConditionEvidenceFromHarnessTrace({
        condition: 'raw',
        harness: 'claude-code',
        model: 'claude-sonnet',
        turns: [{ workspaceRevision: 'rev-a', events: [first] }],
        outcome: {
          success: false,
          assertions: [{ id: 'tests', passed: false }],
        },
      }),
    ).toThrow('does not match');

    expect(() =>
      buildConditionEvidenceFromHarnessTrace({
        condition: 'raw',
        harness: 'codex',
        model: 'gpt-5.4',
        turns: [
          {
            workspaceRevision: 'rev-a',
            events: [first, first],
          },
        ],
        outcome: {
          success: false,
          assertions: [{ id: 'tests', passed: false }],
        },
      }),
    ).toThrow('must increase');
  });
});
