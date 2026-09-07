import { describe, expect, it } from 'vitest';

import { createSessionId } from '@acm/core';

import type { HarnessEventV1, HarnessKind } from './contracts.js';
import { HarnessSessionStateError } from './session.js';
import { ScriptedHarnessPort } from './testing.js';

const SESSION_ID = createSessionId(
  () => '00000000-0000-4000-8000-000000000001',
);

async function collect(
  events: AsyncIterable<HarnessEventV1>,
): Promise<HarnessEventV1[]> {
  const collected: HarnessEventV1[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

function exerciseContract(harness: HarnessKind): void {
  describe(`${harness} contract`, () => {
    it('sequences normalized lifecycle and turn events', async () => {
      const port = new ScriptedHarnessPort({
        harness,
        now: () => new Date('2026-08-26T12:00:00.000Z'),
        turns: [
          {
            events: [
              { kind: 'text-delta', text: 'done' },
              {
                kind: 'usage',
                inputTokens: 10,
                outputTokens: 2,
                totalTokens: 12,
              },
              { kind: 'turn-completed', finishReason: 'stop' },
            ],
          },
        ],
      });
      const session = await port.createSession({
        schemaVersion: 1,
        sessionId: SESSION_ID,
      });
      const events = await collect(
        session.stream({
          schemaVersion: 1,
          prompt: 'Finish the task.',
          workspaceRevision: 'abc123',
        }),
      );
      const destroyed = await session.destroy();

      expect(session.startedEvent).toMatchObject({
        sequence: 1,
        kind: 'session-started',
        harness,
      });
      expect(events.map((event) => [event.sequence, event.kind])).toEqual([
        [2, 'text-delta'],
        [3, 'usage'],
        [4, 'turn-completed'],
      ]);
      expect(destroyed).toMatchObject({
        sequence: 5,
        kind: 'session-destroyed',
      });
      await expect(session.destroy()).resolves.toBe(destroyed);
      expect(() =>
        session.stream({
          schemaVersion: 1,
          prompt: 'again',
          workspaceRevision: 'abc124',
        }),
      ).toThrow(HarnessSessionStateError);
    });

    it('rejects overlapping turns and supports interruption', async () => {
      const port = new ScriptedHarnessPort({
        harness,
        turns: [
          {
            events: [{ kind: 'text-delta', text: 'working' }],
            waitForAbort: true,
          },
        ],
      });
      const session = await port.createSession({
        schemaVersion: 1,
        sessionId: SESSION_ID,
      });
      const first = session.stream({
        schemaVersion: 1,
        prompt: 'Work.',
        workspaceRevision: 'abc123',
      });

      expect(() =>
        session.stream({
          schemaVersion: 1,
          prompt: 'Overlap.',
          workspaceRevision: 'abc123',
        }),
      ).toThrow(HarnessSessionStateError);

      const collection = collect(first);
      await Promise.resolve();
      await session.interrupt('user-requested');
      const events = await collection;
      expect(events.at(-1)).toMatchObject({
        kind: 'interrupted',
        reason: 'user-requested',
      });
      await session.destroy();
    });

    it('does not deadlock when an unconsumed turn is interrupted', async () => {
      const port = new ScriptedHarnessPort({
        harness,
        turns: [{ events: [], waitForAbort: true }],
      });
      const session = await port.createSession({
        schemaVersion: 1,
        sessionId: SESSION_ID,
      });
      const abandoned = session.stream({
        schemaVersion: 1,
        prompt: 'Work.',
        workspaceRevision: 'abc123',
      });

      await expect(
        session.interrupt('cancel-before-read'),
      ).resolves.toBeUndefined();
      const events = await collect(abandoned);
      expect(events).toEqual([
        expect.objectContaining({
          kind: 'interrupted',
          reason: 'cancel-before-read',
        }),
      ]);
      await session.destroy();
    });

    it('destroys while a consumer is paused at a stream event', async () => {
      const port = new ScriptedHarnessPort({
        harness,
        turns: [
          {
            events: [{ kind: 'text-delta', text: 'working' }],
            waitForAbort: true,
          },
        ],
      });
      const session = await port.createSession({
        schemaVersion: 1,
        sessionId: SESSION_ID,
      });
      const iterator = session
        .stream({
          schemaVersion: 1,
          prompt: 'Work.',
          workspaceRevision: 'abc123',
        })
        [Symbol.asyncIterator]();
      await expect(iterator.next()).resolves.toMatchObject({
        value: { kind: 'text-delta' },
      });

      await expect(session.destroy()).resolves.toMatchObject({
        kind: 'session-destroyed',
      });
      await iterator.return?.();
    });

    it('turns driver failures into evidence-bearing error events', async () => {
      const port = new ScriptedHarnessPort({
        harness,
        turns: [{ events: [], error: new Error('vendor disconnected') }],
      });
      const session = await port.createSession({
        schemaVersion: 1,
        sessionId: SESSION_ID,
      });
      const events = await collect(
        session.stream({
          schemaVersion: 1,
          prompt: 'Work.',
          workspaceRevision: 'abc123',
        }),
      );

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        kind: 'error',
        message: 'vendor disconnected',
      });
      await session.destroy();
    });

    it('forwards an external abort signal into an active turn', async () => {
      const port = new ScriptedHarnessPort({
        harness,
        turns: [{ events: [], waitForAbort: true }],
      });
      const session = await port.createSession({
        schemaVersion: 1,
        sessionId: SESSION_ID,
      });
      const controller = new AbortController();
      const collection = collect(
        session.stream(
          {
            schemaVersion: 1,
            prompt: 'Work.',
            workspaceRevision: 'abc123',
          },
          { abortSignal: controller.signal },
        ),
      );

      controller.abort('deadline-exceeded');
      expect((await collection).at(-1)).toMatchObject({
        kind: 'interrupted',
        reason: 'deadline-exceeded',
      });
      await session.destroy();
    });
  });
}

exerciseContract('codex');
exerciseContract('claude-code');
