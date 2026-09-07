import type { HarnessV1SandboxProvider } from '@ai-sdk/harness';
import type { HarnessAgentSandboxConfig } from '@ai-sdk/harness/agent';
import type { CodexHarnessSettings } from '@ai-sdk/harness-codex';
import type { ClaudeCodeHarnessSettings } from '@ai-sdk/harness-claude-code';

import type { ObservationInterceptor } from '@acm/harness-port';
import {
  CreateHarnessSessionInputV1Schema,
  ManagedAgentHarnessSession,
  type AgentHarnessPort,
  type AgentHarnessSession,
  type CreateHarnessSessionInputV1,
  type HarnessEventDataV1,
  type HarnessExecutionOptions,
  type HarnessKind,
  type HarnessSessionDriver,
  type HarnessTurnInputV1,
} from '@acm/harness-port';

import {
  createRealVercelHarnessClient,
  type VercelHarnessClient,
  type VercelHarnessSessionHandle,
} from './client.js';
import { createVercelStreamNormalizer } from './normalizer.js';
import {
  ObservationToolSession,
  createObservationTools,
  type ObservationToolName,
} from './observation-tools.js';

export type VercelHarnessClientFactory = (
  input: CreateHarnessSessionInputV1,
) => VercelHarnessClient;

interface SharedVercelHarnessPortOptions {
  harness: HarnessKind;
  now?: () => Date;
}

/**
 * Puts ACM on the per-step context path by shadowing the harness's own builtin
 * tools with host-executed ones. What the interceptor returns is what the
 * harness writes into the agent's transcript, so the reduction is present in
 * every later model request rather than only the first.
 */
export interface VercelObservationOptions {
  readonly interceptor: ObservationInterceptor;
  /** Which builtins to override. Defaults to every supported tool. */
  readonly tools?: readonly ObservationToolName[];
}

/**
 * Composes the sandbox configuration the observation tools need.
 *
 * The live session only exists once the harness has acquired it, and any
 * caller-supplied `onSession` still runs afterwards.
 */
export function createObservationSandboxConfig(
  base: HarnessAgentSandboxConfig | undefined,
  session: ObservationToolSession,
): HarnessAgentSandboxConfig {
  return {
    ...base,
    async onSession(options) {
      session.attach(options.session, options.sessionWorkDir);
      await base?.onSession?.(options);
    },
  };
}

export type VercelHarnessPortOptions = SharedVercelHarnessPortOptions &
  (
    | {
        sandbox: HarnessV1SandboxProvider;
        clientFactory?: never;
        codex?: CodexHarnessSettings;
        claudeCode?: ClaudeCodeHarnessSettings;
        sandboxConfig?: HarnessAgentSandboxConfig;
        observation?: VercelObservationOptions;
      }
    | {
        clientFactory: VercelHarnessClientFactory;
        sandbox?: never;
        codex?: never;
        claudeCode?: never;
        sandboxConfig?: never;
        observation?: never;
      }
  );

class VercelHarnessDriver implements HarnessSessionDriver {
  readonly vendorSessionId;
  private destroyed = false;

  constructor(
    private readonly client: VercelHarnessClient,
    private readonly session: VercelHarnessSessionHandle,
    private readonly observationSession?: ObservationToolSession,
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
    // One normalizer per turn: step indices are turn-scoped.
    const normalize = createVercelStreamNormalizer();
    for await (const part of stream) {
      for (const event of normalize(part)) yield event;
    }
  }

  async destroy(): Promise<void> {
    if (this.destroyed) return;
    // Detached first: a tool must never reach a sandbox that is going away.
    this.observationSession?.detach();
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
    execution: HarnessExecutionOptions = {},
  ): Promise<AgentHarnessSession> {
    execution.abortSignal?.throwIfAborted();
    const parsedInput = CreateHarnessSessionInputV1Schema.parse(input);
    const observation = this.options.observation;
    // One holder per session: a tool call must reach its own sandbox.
    const observationSession =
      observation === undefined ? undefined : new ObservationToolSession();
    const sandboxConfig =
      observationSession === undefined
        ? this.options.sandboxConfig
        : createObservationSandboxConfig(
            this.options.sandboxConfig,
            observationSession,
          );
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
        ...(sandboxConfig === undefined ? {} : { sandboxConfig }),
        ...(observation === undefined || observationSession === undefined
          ? {}
          : {
              tools: createObservationTools({
                interceptor: observation.interceptor,
                target: observationSession.resolve,
                ...(observation.tools === undefined
                  ? {}
                  : { tools: observation.tools }),
              }),
            }),
      });
    const vendorSession = await client.createSession({
      sessionId: parsedInput.sessionId,
      ...(execution.abortSignal === undefined
        ? {}
        : { abortSignal: execution.abortSignal }),
    });
    const driver = new VercelHarnessDriver(
      client,
      vendorSession,
      observationSession,
    );
    try {
      execution.abortSignal?.throwIfAborted();
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
