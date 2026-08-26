import { describe, expect, it, vi } from 'vitest';

import { createSessionId } from '@acm/core';
import type { HarnessEventV1, HarnessKind } from '@acm/harness-port';

import { VercelHarnessPort } from './adapter.js';
import type {
  VercelHarnessClient,
  VercelHarnessSessionHandle,
} from './client.js';

const SESSION_ID = createSessionId(
  () => '00000000-0000-4000-8000-000000000002',
);

async function collect(
  iterable: AsyncIterable<HarnessEventV1>,
): Promise<HarnessEventV1[]> {
  const events: HarnessEventV1[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

function fakeClient(parts: readonly unknown[]): {
  client: VercelHarnessClient;
  destroy: ReturnType<typeof vi.fn>;
  stream: ReturnType<typeof vi.fn>;
} {
  const destroy = vi.fn(async () => undefined);
  const stream = vi.fn(async function* () {
    for (const part of parts) yield part;
  });
  const session: VercelHarnessSessionHandle = {
    sessionId: 'vendor-session-id',
    destroy,
  };
  return {
    destroy,
    stream,
    client: {
      createSession: vi.fn(async () => session),
      stream: async (options) => stream(options),
    },
  };
}

function exerciseAdapter(harness: HarnessKind): void {
  describe(`${harness} Vercel adapter`, () => {
    it('isolates vendor IDs and normalizes a complete stream', async () => {
      const fake = fakeClient([
        { type: 'text-delta', id: 't1', text: 'working' },
        {
          type: 'tool-call',
          toolCallId: 'c1',
          toolName: harness === 'codex' ? 'bash' : 'read',
          input:
            harness === 'codex'
              ? { command: 'pnpm test' }
              : { file_path: 'src/index.ts' },
        },
        {
          type: 'finish',
          finishReason: 'stop',
          totalUsage: { inputTokens: 10, outputTokens: 3, totalTokens: 13 },
        },
      ]);
      const port = new VercelHarnessPort({
        harness,
        clientFactory: () => fake.client,
      });
      const session = await port.createSession({
        schemaVersion: 1,
        sessionId: SESSION_ID,
        instructions: 'Be precise.',
      });
      const events = await collect(
        session.stream({
          schemaVersion: 1,
          prompt: 'Run the task.',
          workspaceRevision: 'rev-1',
        }),
      );

      expect(session.id).toBe(SESSION_ID);
      expect(session.startedEvent).toMatchObject({
        kind: 'session-started',
        vendorSessionId: 'vendor-session-id',
      });
      expect(events.map((event) => event.kind)).toEqual([
        'text-delta',
        'tool-call',
        'usage',
        'turn-completed',
      ]);
      await session.destroy();
      expect(fake.destroy).toHaveBeenCalledOnce();
    });

    it('cleans up after a stream failure', async () => {
      const destroy = vi.fn(async () => undefined);
      const client: VercelHarnessClient = {
        createSession: async () => ({
          sessionId: 'vendor-failure',
          destroy,
        }),
        stream: async () =>
          (async function* () {
            throw new Error('bridge disconnected');
          })(),
      };
      const port = new VercelHarnessPort({
        harness,
        clientFactory: () => client,
      });
      const session = await port.createSession({
        schemaVersion: 1,
        sessionId: SESSION_ID,
      });
      const events = await collect(
        session.stream({
          schemaVersion: 1,
          prompt: 'Run.',
          workspaceRevision: 'rev-1',
        }),
      );

      expect(events).toEqual([
        expect.objectContaining({
          kind: 'error',
          message: 'bridge disconnected',
        }),
      ]);
      await session.destroy();
      expect(destroy).toHaveBeenCalledOnce();
    });

    it('forwards interruption through the vendor abort signal', async () => {
      const destroy = vi.fn(async () => undefined);
      const client: VercelHarnessClient = {
        createSession: async () => ({
          sessionId: 'vendor-interrupt',
          destroy,
        }),
        stream: async ({ abortSignal }) =>
          (async function* () {
            yield { type: 'text-delta', id: 't1', text: 'working' };
            if (!abortSignal.aborted) {
              await new Promise<void>((resolve) => {
                abortSignal.addEventListener('abort', () => resolve(), {
                  once: true,
                });
              });
            }
          })(),
      };
      const port = new VercelHarnessPort({
        harness,
        clientFactory: () => client,
      });
      const session = await port.createSession({
        schemaVersion: 1,
        sessionId: SESSION_ID,
      });
      const collection = collect(
        session.stream({
          schemaVersion: 1,
          prompt: 'Run.',
          workspaceRevision: 'rev-1',
        }),
      );
      await Promise.resolve();
      await session.interrupt('stop-now');

      expect((await collection).at(-1)).toMatchObject({
        kind: 'interrupted',
        reason: 'stop-now',
      });
      await session.destroy();
      expect(destroy).toHaveBeenCalledOnce();
    });
  });
}

exerciseAdapter('codex');
exerciseAdapter('claude-code');
