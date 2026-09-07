import { describe, expect, it, vi } from 'vitest';

import type {
  HostedConditionRunInputV1,
  PublicGitFixtureV1,
} from '@acm/hosted-evaluation';

import type { VercelHarnessPortOptions } from './adapter.js';
import {
  materializePublicGitFixture,
  requireSuccessfulHarnessTrace,
  VercelHostedConditionRunner,
  type ObservationInterceptorRequest,
  type SandboxCommandSession,
  type VercelHostedConditionRunnerDependencies,
} from './hosted-runner.js';
import type {
  AgentHarnessPort,
  AgentHarnessSession,
  HarnessEventV1,
  ObservationInterceptor,
} from '@acm/harness-port';

const FIXTURE: PublicGitFixtureV1 = {
  id: 'fixture',
  repositoryUrl: 'https://github.com/example/repository.git',
  revision: 'a'.repeat(40),
  setupCommands: ['pnpm install --frozen-lockfile'],
  verificationCommands: [{ id: 'tests', command: 'pnpm test' }],
};

function harnessEvent(
  data:
    | { kind: 'turn-completed'; finishReason: string }
    | { kind: 'error'; message: string }
    | { kind: 'interrupted'; reason?: string }
    | { kind: 'session-destroyed' },
): HarnessEventV1 {
  return {
    schemaVersion: 1,
    sessionId: 'ses_01j00000000000000000000000',
    harness: 'codex',
    sequence: 1,
    createdAt: '2026-08-27T00:00:00.000Z',
    ...data,
  } as HarnessEventV1;
}

describe('materializePublicGitFixture', () => {
  it('uses fixed shell text and passes fixture values through the environment', async () => {
    const run = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' }));
    await materializePublicGitFixture(
      { run },
      '/workspace/session',
      FIXTURE,
      new AbortController().signal,
    );

    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[0]?.[0]).toMatchObject({
      workingDirectory: '/workspace/session',
      env: {
        ACM_FIXTURE_URL: FIXTURE.repositoryUrl,
        ACM_FIXTURE_REVISION: FIXTURE.revision,
      },
    });
    expect(run.mock.calls[0]?.[0].command).not.toContain(FIXTURE.repositoryUrl);
    expect(run.mock.calls[1]?.[0].command).toBe(
      'pnpm install --frozen-lockfile',
    );
  });

  it('stops immediately on a failed setup command without exposing output', async () => {
    let call = 0;
    const session: SandboxCommandSession = {
      async run() {
        call += 1;
        return call === 1
          ? { exitCode: 0, stdout: '', stderr: '' }
          : {
              exitCode: 7,
              stdout: 'PRIVATE_SOURCE',
              stderr: 'PRIVATE_ERROR',
            };
      },
    };
    let thrown: unknown;
    try {
      await materializePublicGitFixture(
        session,
        '/workspace/session',
        FIXTURE,
        new AbortController().signal,
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain('exit code 7');
    expect((thrown as Error).message).not.toContain('PRIVATE');
  });
});

describe('requireSuccessfulHarnessTrace', () => {
  it('accepts a completed harness turn', () => {
    expect(() =>
      requireSuccessfulHarnessTrace(
        [harnessEvent({ kind: 'turn-completed', finishReason: 'stop' })],
        'raw',
      ),
    ).not.toThrow();
  });

  it('fails immediately when the provider stream reports an error', () => {
    expect(() =>
      requireSuccessfulHarnessTrace(
        [harnessEvent({ kind: 'error', message: 'rate limited' })],
        'raw',
      ),
    ).toThrow('Hosted raw condition failed: rate limited');
  });

  it('treats an interrupted turn as a failed condition', () => {
    expect(() =>
      requireSuccessfulHarnessTrace(
        [harnessEvent({ kind: 'interrupted', reason: 'timeout' })],
        'managed',
      ),
    ).toThrow('Hosted managed condition failed: timeout');
  });

  it('rejects a stream that ends without a terminal event', () => {
    expect(() => requireSuccessfulHarnessTrace([], 'raw')).toThrow(
      'without a completed turn',
    );
  });
});

describe('VercelHostedConditionRunner', () => {
  it('applies one deadline to creation and streaming, journals evidence, and destroys the session', async () => {
    const trace: string[] = [];
    const commandSession: SandboxCommandSession = {
      run: vi.fn(async () => ({
        exitCode: 0,
        stdout: 'fixture output',
        stderr: '',
      })),
    };
    let creationSignal: AbortSignal | undefined;
    let streamSignal: AbortSignal | undefined;
    const destroy = vi.fn(async () =>
      harnessEvent({ kind: 'session-destroyed' }),
    );
    const session: AgentHarnessSession = {
      id: 'ses_01j00000000000000000000000',
      harness: 'codex',
      startedEvent: {
        schemaVersion: 1,
        sessionId: 'ses_01j00000000000000000000000',
        harness: 'codex',
        sequence: 1,
        createdAt: '2026-08-27T00:00:00.000Z',
        kind: 'session-started',
        vendorSessionId: 'vendor',
      },
      stream(_input, options) {
        streamSignal = options?.abortSignal;
        return (async function* () {
          if (!streamSignal?.aborted) {
            await new Promise<void>((resolve) =>
              streamSignal?.addEventListener('abort', () => resolve(), {
                once: true,
              }),
            );
          }
          yield harnessEvent({ kind: 'interrupted', reason: 'deadline' });
        })();
      },
      interrupt: async () => undefined,
      destroy,
    };
    const port: AgentHarnessPort = {
      harness: 'codex',
      async createSession(_input, options) {
        creationSignal = options?.abortSignal;
        return session;
      },
    };
    const runner = new VercelHostedConditionRunner({
      createSandbox: () => ({}) as never,
      createPort: (options) => {
        const config = (
          options as {
            sandboxConfig: {
              onSession(input: {
                session: SandboxCommandSession;
                sessionWorkDir: string;
              }): Promise<void>;
            };
          }
        ).sandboxConfig;
        const originalCreate = port.createSession.bind(port);
        port.createSession = async (input, execution) => {
          await config.onSession({
            session: commandSession,
            sessionWorkDir: '/workspace',
          });
          return originalCreate(input, execution);
        };
        return port;
      },
    });

    await expect(
      runner.runCondition({
        condition: 'raw',
        harness: 'codex',
        model: 'test/model',
        fixture: FIXTURE,
        task: 'Make the change.',
        checkpointId: 'checkpoint',
        contextText: 'context',
        timeoutMs: 20,
        onTrace: async (entry) => {
          trace.push(entry.kind);
        },
      }),
    ).rejects.toThrow(/timeout|deadline/u);

    expect(creationSignal).toBe(streamSignal);
    expect(creationSignal?.aborted).toBe(true);
    expect(trace).toContain('command');
    expect(trace).toContain('harness-event');
    expect(trace.at(-1)).toBe('session-destroyed');
    expect(destroy).toHaveBeenCalledOnce();
  });
});

describe('per-step observation interception', () => {
  function conditionInput(
    condition: 'raw' | 'managed',
    harness: 'codex' | 'claude-code' = 'claude-code',
  ): HostedConditionRunInputV1 {
    return {
      condition,
      harness,
      model: 'test-model',
      fixture: FIXTURE,
      task: 'Fix the failing test.',
      checkpointId: 'after-setup',
      contextText: 'prior state',
      timeoutMs: 60_000,
    };
  }

  function stubInterceptor(policy: 'raw' | 'reduced'): ObservationInterceptor {
    return {
      policy,
      intercept: () => {
        throw new Error('The stub interceptor is never invoked.');
      },
    };
  }

  function captureOptions(
    dependencies: Partial<VercelHostedConditionRunnerDependencies>,
  ): {
    run: (input: HostedConditionRunInputV1) => Promise<void>;
    options: () => VercelHarnessPortOptions | undefined;
  } {
    let captured: VercelHarnessPortOptions | undefined;
    const runner = new VercelHostedConditionRunner({
      createSandbox: () => ({}) as never,
      createPort: (options) => {
        captured = options;
        return {
          harness: options.harness,
          createSession: async () => {
            throw new Error('session-not-created');
          },
        };
      },
      ...dependencies,
    });
    return {
      run: async (input) => {
        await expect(runner.runCondition(input)).rejects.toThrow(
          'session-not-created',
        );
      },
      options: () => captured,
    };
  }

  it('leaves the harness builtins in place when no interceptor is supplied', async () => {
    const capture = captureOptions({});
    await capture.run(conditionInput('managed'));
    expect(capture.options()?.observation).toBeUndefined();
  });

  it('overrides the builtins each harness actually owns', async () => {
    const codex = captureOptions({
      createObservationInterceptor: () => stubInterceptor('reduced'),
    });
    await codex.run(conditionInput('managed', 'codex'));
    expect(codex.options()?.observation?.tools).toEqual(['bash']);

    const claudeCode = captureOptions({
      createObservationInterceptor: () => stubInterceptor('reduced'),
    });
    await claudeCode.run(conditionInput('managed', 'claude-code'));
    expect(claudeCode.options()?.observation?.tools).toEqual([
      'read',
      'grep',
      'bash',
    ]);
  });

  it('passes the session identity the interceptor must record against', async () => {
    const requests: ObservationInterceptorRequest[] = [];
    const capture = captureOptions({
      createObservationInterceptor: (request) => {
        requests.push(request);
        return stubInterceptor('raw');
      },
    });

    await capture.run(conditionInput('raw', 'codex'));

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ condition: 'raw', harness: 'codex' });
    expect(requests[0]?.sessionId).toMatch(/^ses_[0-9a-f]{32}$/u);
  });

  it('refuses a baseline that would reduce its own observations', async () => {
    const runner = new VercelHostedConditionRunner({
      createSandbox: () => ({}) as never,
      createPort: () => {
        throw new Error('the port must never be created');
      },
      createObservationInterceptor: () => stubInterceptor('reduced'),
    });

    await expect(runner.runCondition(conditionInput('raw'))).rejects.toThrow(
      'requires the raw observation policy but received reduced',
    );
  });

  it('refuses a managed condition that would not reduce anything', async () => {
    const runner = new VercelHostedConditionRunner({
      createSandbox: () => ({}) as never,
      createPort: () => {
        throw new Error('the port must never be created');
      },
      createObservationInterceptor: () => stubInterceptor('raw'),
    });

    await expect(
      runner.runCondition(conditionInput('managed')),
    ).rejects.toThrow(
      'requires the reduced observation policy but received raw',
    );
  });
});
