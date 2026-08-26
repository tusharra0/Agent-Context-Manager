import {
  HarnessAgent,
  type HarnessAgentAdapter,
  type HarnessAgentSession,
} from '@ai-sdk/harness/agent';
import type { HarnessV1SandboxProvider } from '@ai-sdk/harness';
import { createCodex, type CodexHarnessSettings } from '@ai-sdk/harness-codex';
import {
  createClaudeCode,
  type ClaudeCodeHarnessSettings,
} from '@ai-sdk/harness-claude-code';

import type { HarnessKind } from '@acm/harness-port';

export interface VercelHarnessSessionHandle {
  readonly sessionId: string;
  destroy(): Promise<void>;
}

export interface VercelHarnessClient {
  createSession(options: {
    sessionId: string;
    abortSignal?: AbortSignal;
  }): Promise<VercelHarnessSessionHandle>;
  stream(options: {
    session: VercelHarnessSessionHandle;
    prompt: string;
    abortSignal: AbortSignal;
  }): Promise<AsyncIterable<unknown>>;
}

export interface RealVercelHarnessClientOptions {
  harness: HarnessKind;
  sandbox: HarnessV1SandboxProvider;
  instructions?: string;
  codex?: CodexHarnessSettings;
  claudeCode?: ClaudeCodeHarnessSettings;
}

const RAW_SESSION = Symbol('raw-harness-agent-session');

interface RealSessionHandle extends VercelHarnessSessionHandle {
  readonly [RAW_SESSION]: HarnessAgentSession;
}

function wrapAgent<TAdapter extends HarnessAgentAdapter<any>>(
  agent: HarnessAgent<TAdapter>,
): VercelHarnessClient {
  return {
    async createSession(options) {
      const raw = await agent.createSession(options);
      return {
        sessionId: raw.sessionId,
        [RAW_SESSION]: raw,
        destroy: () => raw.destroy(),
      } satisfies RealSessionHandle;
    },
    async stream(options) {
      const realSession = options.session as Partial<RealSessionHandle>;
      if (realSession[RAW_SESSION] === undefined) {
        throw new TypeError(
          'The session was not created by this Vercel harness client.',
        );
      }
      const result = await agent.stream({
        session: realSession[RAW_SESSION],
        prompt: options.prompt,
        abortSignal: options.abortSignal,
      });
      return result.stream;
    },
  };
}

export function createRealVercelHarnessClient(
  options: RealVercelHarnessClientOptions,
): VercelHarnessClient {
  const shared = {
    sandbox: options.sandbox,
    ...(options.instructions === undefined
      ? {}
      : { instructions: options.instructions }),
  };

  if (options.harness === 'codex') {
    return wrapAgent(
      new HarnessAgent({
        harness: createCodex(options.codex),
        ...shared,
      }),
    );
  }

  return wrapAgent(
    new HarnessAgent({
      harness: createClaudeCode(options.claudeCode),
      ...shared,
    }),
  );
}
