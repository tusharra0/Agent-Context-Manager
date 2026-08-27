import type { HarnessV1SandboxProvider } from '@ai-sdk/harness';
import type { HarnessAgentSandboxConfig } from '@ai-sdk/harness/agent';
import type { CodexHarnessSettings } from '@ai-sdk/harness-codex';
import type { ClaudeCodeHarnessSettings } from '@ai-sdk/harness-claude-code';

import {
  CreateHarnessSessionInputV1Schema,
  ManagedAgentHarnessSession,
  type AgentHarnessPort,
  type AgentHarnessSession,
  type CreateHarnessSessionInputV1,
  type HarnessEventDataV1,
  type HarnessKind,
  type HarnessSessionDriver,
  type HarnessTurnInputV1,
} from '@acm/harness-port';

import {
  createRealVercelHarnessClient,
  type VercelHarnessClient,
  type VercelHarnessSessionHandle,
} from './client.js';
import { normalizeVercelStreamPart } from './normalizer.js';

export type VercelHarnessClientFactory = (
  input: CreateHarnessSessionInputV1,
) => VercelHarnessClient;

interface SharedVercelHarnessPortOptions {
  harness: HarnessKind;
  now?: () => Date;
}

export type VercelHarnessPortOptions = SharedVercelHarnessPortOptions &
  (
    | {
        sandbox: HarnessV1SandboxProvider;
        clientFactory?: never;
        codex?: CodexHarnessSettings;
        claudeCode?: ClaudeCodeHarnessSettings;
        sandboxConfig?: HarnessAgentSandboxConfig;
      }
    | {
        clientFactory: VercelHarnessClientFactory;
        sandbox?: never;
        codex?: never;
        claudeCode?: never;
        sandboxConfig?: never;
      }
  );

class VercelHarnessDriver implements HarnessSessionDriver {
  readonly vendorSessionId;
  private destroyed = false;

  constructor(
    private readonly client: VercelHarnessClient,
    private readonly session: VercelHarnessSessionHandle,
  ) {
    this.vendorSessionId = session.sessionId;
  }

  async *streamTurn(
    input: HarnessTurnInputV1,
    signal: AbortSignal,
  ): AsyncGenerator<HarnessEventDataV1> {
    const stream = await this.client.stream({
      session: this.session,
      prompt: input.prompt,
      abortSignal: signal,
    });
    for await (const part of stream) {
      for (const event of normalizeVercelStreamPart(part)) yield event;
    }
  }

  async destroy(): Promise<void> {
    if (this.destroyed) return;
    await this.session.destroy();
    this.destroyed = true;
  }
}

export class VercelHarnessPort implements AgentHarnessPort {
  readonly harness;

  constructor(private readonly options: VercelHarnessPortOptions) {
    this.harness = options.harness;
  }

  async createSession(
    input: CreateHarnessSessionInputV1,
  ): Promise<AgentHarnessSession> {
    const parsedInput = CreateHarnessSessionInputV1Schema.parse(input);
    const client =
      this.options.clientFactory?.(parsedInput) ??
      createRealVercelHarnessClient({
        harness: this.harness,
        sandbox: this.options.sandbox!,
        ...(parsedInput.instructions === undefined
          ? {}
          : { instructions: parsedInput.instructions }),
        ...(this.options.codex === undefined
          ? {}
          : { codex: this.options.codex }),
        ...(this.options.claudeCode === undefined
          ? {}
          : { claudeCode: this.options.claudeCode }),
        ...(this.options.sandboxConfig === undefined
          ? {}
          : { sandboxConfig: this.options.sandboxConfig }),
      });
    const controller = new AbortController();
    const vendorSession = await client.createSession({
      sessionId: parsedInput.sessionId,
      abortSignal: controller.signal,
    });
    const driver = new VercelHarnessDriver(client, vendorSession);
    try {
      return new ManagedAgentHarnessSession(driver, {
        sessionId: parsedInput.sessionId,
        harness: this.harness,
        ...(this.options.now === undefined ? {} : { now: this.options.now }),
      });
    } catch (error) {
      try {
        await driver.destroy();
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          'Harness session creation and cleanup both failed.',
        );
      }
      throw error;
    }
  }
}
