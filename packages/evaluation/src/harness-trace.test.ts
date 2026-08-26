import { describe, expect, it } from 'vitest';

import { createSessionId } from '@acm/core';
import type { HarnessEventV1 } from '@acm/harness-port';

import { buildConditionEvidenceFromHarnessTrace } from './harness-trace.js';

const SESSION_ID = createSessionId(
  () => '00000000-0000-4000-8000-000000000003',
);

function event(
  sequence: number,
  data:
    | {
        kind: 'tool-call';
        toolCallId: string;
        toolName: string;
        input: Record<string, string>;
      }
    | {
        kind: 'usage';
        inputTokens: number;
        outputTokens: number;
        totalTokens: number;
      }
    | { kind: 'turn-completed'; finishReason: string },
): HarnessEventV1 {
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
