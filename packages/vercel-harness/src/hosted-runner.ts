import { createHash } from 'node:crypto';

import { createVercelSandbox } from '@ai-sdk/sandbox-vercel';
import type { HarnessV1SandboxProvider } from '@ai-sdk/harness';

import { JsonValueSchema, createSessionId, type SessionId } from '@acm/core';
import {
  PublicGitFixtureV1Schema,
  renderHostedConditionPrompt,
  type HostedConditionRunInputV1,
  type HostedConditionRunOutputV1,
  type HostedConditionRunnerPort,
  type PublicGitFixtureV1,
} from '@acm/hosted-evaluation';
import type {
  AgentHarnessPort,
  HarnessEventV1,
  HarnessKind,
  ObservationInterceptor,
  ObservationRecordV1,
} from '@acm/harness-port';

import {
  VercelHarnessPort,
  type VercelHarnessPortOptions,
  type VercelObservationOptions,
} from './adapter.js';
import { OBSERVATION_TOOLS_BY_HARNESS } from './observation-tools.js';

export interface SandboxCommandSession {
  run(options: {
    command: string;
    workingDirectory?: string;
    env?: Record<string, string>;
    abortSignal?: AbortSignal;
  }): PromiseLike<{ exitCode: number; stdout: string; stderr: string }>;
}

type CommandPhase = 'fixture' | 'setup' | 'verification' | 'workspace-revision';

export interface ObservationInterceptorRequest {
  readonly condition: HostedConditionRunInputV1['condition'];
  readonly harness: HarnessKind;
  readonly sessionId: SessionId;
  /**
   * Resolves the sandbox session directory. It exists only once the harness
   * has acquired a session, which is after the interceptor has to be built,
   * so it is passed as a resolver rather than a value.
   */
  readonly workingDirectory: () => string;
}

export interface ObservationInterceptorHandle {
  readonly interceptor: ObservationInterceptor;
  /** Audit records produced so far, in the order they were recorded. */
  readonly records: () => readonly ObservationRecordV1[];
}

export interface VercelHostedConditionRunnerDependencies {
  createSandbox(options: {
    runtime: 'node24';
    ports: number[];
    timeout: number;
  }): HarnessV1SandboxProvider;
  createPort(options: VercelHarnessPortOptions): AgentHarnessPort;
  /**
   * Builds the per-step observation interceptor for one condition.
   *
   * Omitting it, or returning `undefined`, leaves the harness's own builtin
   * tools in place: the run then only reduces the checkpoint context it is
   * given, which is the behavior this slice exists to move past.
   */
  createObservationInterceptor?(
    request: ObservationInterceptorRequest,
  ): ObservationInterceptorHandle | undefined;
}

/**
 * The observation policy each condition must use.
 *
 * Enforced rather than trusted: a baseline that quietly reduced its own
 * observations would make every paired comparison meaningless, and the mistake
 * would not be visible in the result.
 */
const REQUIRED_OBSERVATION_POLICY = {
  raw: 'raw',
  managed: 'reduced',
} as const satisfies Record<
  HostedConditionRunInputV1['condition'],
  ObservationInterceptor['policy']
>;

const DEFAULT_DEPENDENCIES: VercelHostedConditionRunnerDependencies = {
  createSandbox: (options) => createVercelSandbox(options),
  createPort: (options) => new VercelHarnessPort(options),
};

async function runCommand(
  session: SandboxCommandSession,
  command: string,
  workingDirectory: string,
  signal: AbortSignal,
  phase: CommandPhase,
  onTrace?: HostedConditionRunInputV1['onTrace'],
  env?: Record<string, string>,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  signal.throwIfAborted();
  const result = await session.run({
    command,
    workingDirectory,
    abortSignal: signal,
    ...(env === undefined ? {} : { env }),
  });
  await onTrace?.({
    kind: 'command',
    data: {
      phase,
      command,
      workingDirectory,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
    },
  });
  signal.throwIfAborted();
  return result;
}

async function requireSuccessfulCommand(
  session: SandboxCommandSession,
  command: string,
  workingDirectory: string,
  signal: AbortSignal,
  phase: CommandPhase,
  onTrace?: HostedConditionRunInputV1['onTrace'],
  env?: Record<string, string>,
): Promise<{ stdout: string; stderr: string }> {
  const result = await runCommand(
    session,
    command,
    workingDirectory,
    signal,
    phase,
    onTrace,
    env,
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `Sandbox command failed with exit code ${result.exitCode}.`,
    );
  }
  return { stdout: result.stdout, stderr: result.stderr };
}

export async function materializePublicGitFixture(
  session: SandboxCommandSession,
  workDir: string,
  fixtureInput: PublicGitFixtureV1,
  signal: AbortSignal,
  onTrace?: HostedConditionRunInputV1['onTrace'],
): Promise<void> {
  const fixture = PublicGitFixtureV1Schema.parse(fixtureInput);
  const environment = {
    ACM_FIXTURE_URL: fixture.repositoryUrl,
    ACM_FIXTURE_REVISION: fixture.revision,
  };
  await requireSuccessfulCommand(
    session,
    [
      'git init .',
      'git remote add origin "$ACM_FIXTURE_URL"',
      'git fetch --depth 1 origin "$ACM_FIXTURE_REVISION"',
      'git checkout --detach FETCH_HEAD',
      'test "$(git rev-parse HEAD)" = "$ACM_FIXTURE_REVISION"',
    ].join(' && '),
    workDir,
    signal,
    'fixture',
    onTrace,
    environment,
  );
  for (const command of fixture.setupCommands) {
    await requireSuccessfulCommand(
      session,
      command,
      workDir,
      signal,
      'setup',
      onTrace,
    );
  }
}

async function verifyFixture(
  session: SandboxCommandSession,
  workDir: string,
  fixture: PublicGitFixtureV1,
  signal: AbortSignal,
  onTrace?: HostedConditionRunInputV1['onTrace'],
): Promise<HostedConditionRunOutputV1['outcome']> {
  const assertions = [];
  for (const verification of fixture.verificationCommands) {
    const result = await runCommand(
      session,
      verification.command,
      workDir,
      signal,
      'verification',
      onTrace,
    );
    assertions.push({
      id: verification.id,
      passed: result.exitCode === 0,
      evidence: `exit code ${result.exitCode}`,
    });
  }
  return {
    success: assertions.every((assertion) => assertion.passed),
    assertions,
  };
}

async function workspaceRevision(
  session: SandboxCommandSession,
  workDir: string,
  signal: AbortSignal,
  onTrace?: HostedConditionRunInputV1['onTrace'],
): Promise<string> {
  const result = await requireSuccessfulCommand(
    session,
    [
      'git rev-parse HEAD',
      'git status --porcelain=v1',
      'git diff --no-ext-diff --binary',
      'git diff --cached --no-ext-diff --binary',
    ].join(' && '),
    workDir,
    signal,
    'workspace-revision',
    onTrace,
  );
  return `sha256:${createHash('sha256')
    .update(result.stdout, 'utf8')
    .digest('hex')}`;
}

function timeoutSignal(timeoutMs: number): AbortSignal {
  return AbortSignal.timeout(timeoutMs);
}

export function requireSuccessfulHarnessTrace(
  events: readonly HarnessEventV1[],
  condition: HostedConditionRunInputV1['condition'],
): void {
  const failure = events.find(
    (event) => event.kind === 'error' || event.kind === 'interrupted',
  );
  if (failure !== undefined) {
    const detail =
      failure.kind === 'error'
        ? failure.message
        : (failure.reason ?? 'The harness turn was interrupted.');
    throw new Error(`Hosted ${condition} condition failed: ${detail}`);
  }
  if (!events.some((event) => event.kind === 'turn-completed')) {
    throw new Error(
      `Hosted ${condition} condition failed: the harness stream ended without a completed turn.`,
    );
  }
}

export class VercelHostedConditionRunner implements HostedConditionRunnerPort {
  private readonly dependencies: VercelHostedConditionRunnerDependencies;

  constructor(
    dependencies: Partial<VercelHostedConditionRunnerDependencies> = {},
  ) {
    this.dependencies = { ...DEFAULT_DEPENDENCIES, ...dependencies };
  }

  /**
   * Resolves the interception the plan asked for.
   *
   * The plan decides, not the caller: an `off` plan never builds an
   * interceptor even when a factory is available, and a `per-step` plan fails
   * rather than quietly running without one, because a run that silently
   * skipped interception would look like a reduction that achieved nothing.
   */
  private observationFor(
    input: HostedConditionRunInputV1,
    sessionId: SessionId,
    workingDirectory: () => string,
  ):
    | {
        options: VercelObservationOptions;
        records: () => readonly ObservationRecordV1[];
      }
    | undefined {
    // Anything but an explicit request leaves the builtins alone. Defaulting
    // the other way would let a malformed plan reduce a baseline by accident.
    if (input.observationInterception !== 'per-step') return undefined;
    const handle = this.dependencies.createObservationInterceptor?.({
      condition: input.condition,
      harness: input.harness,
      sessionId,
      workingDirectory,
    });
    if (handle === undefined) {
      throw new Error(
        'The plan requests per-step observation interception but no interceptor was supplied.',
      );
    }
    const required = REQUIRED_OBSERVATION_POLICY[input.condition];
    if (handle.interceptor.policy !== required) {
      throw new Error(
        `The ${input.condition} condition requires the ${required} observation policy but received ${handle.interceptor.policy}.`,
      );
    }
    return {
      options: {
        interceptor: handle.interceptor,
        tools: OBSERVATION_TOOLS_BY_HARNESS[input.harness],
      },
      records: handle.records,
    };
  }

  async runCondition(
    input: HostedConditionRunInputV1,
  ): Promise<HostedConditionRunOutputV1> {
    const startedAt = performance.now();
    const signal = timeoutSignal(input.timeoutMs);
    const sessionId = createSessionId();
    let sandboxSession: SandboxCommandSession | undefined;
    let sandboxWorkDir: string | undefined;
    const observation = this.observationFor(input, sessionId, () => {
      if (sandboxWorkDir === undefined) {
        throw new Error('The sandbox session directory is not available yet.');
      }
      return sandboxWorkDir;
    });
    const sandbox = this.dependencies.createSandbox({
      runtime: 'node24',
      ports: [4000],
      timeout: input.timeoutMs + 120_000,
    });
    const sandboxConfig: NonNullable<
      VercelHarnessPortOptions['sandboxConfig']
    > = {
      onSession: async ({ session, sessionWorkDir }) => {
        sandboxSession = session;
        sandboxWorkDir = sessionWorkDir;
        await materializePublicGitFixture(
          session,
          sessionWorkDir,
          input.fixture,
          signal,
          input.onTrace,
        );
      },
    };
    const portOptions: VercelHarnessPortOptions =
      input.harness === 'codex'
        ? {
            harness: 'codex',
            sandbox,
            codex: { auth: 'ai-gateway', model: input.model },
            sandboxConfig,
            ...(observation === undefined
              ? {}
              : { observation: observation.options }),
          }
        : {
            harness: 'claude-code',
            sandbox,
            claudeCode: { auth: 'ai-gateway', model: input.model },
            sandboxConfig,
            ...(observation === undefined
              ? {}
              : { observation: observation.options }),
          };
    const port = this.dependencies.createPort(portOptions);
    const session = await port.createSession(
      {
        schemaVersion: 1,
        sessionId,
        instructions:
          'Work only in the current repository. Preserve existing behavior outside the requested task and verify changes before finishing.',
      },
      { abortSignal: signal },
    );
    const events: HarnessEventV1[] = [session.startedEvent];
    let primaryError: unknown;
    try {
      await input.onTrace?.({
        kind: 'harness-event',
        data: JsonValueSchema.parse(session.startedEvent),
      });
      for await (const event of session.stream(
        {
          schemaVersion: 1,
          prompt: renderHostedConditionPrompt(input),
          workspaceRevision: input.fixture.revision,
        },
        { abortSignal: signal },
      )) {
        await input.onTrace?.({
          kind: 'harness-event',
          data: JsonValueSchema.parse(event),
        });
        events.push(event);
      }
      signal.throwIfAborted();
      requireSuccessfulHarnessTrace(events, input.condition);
      if (sandboxSession === undefined || sandboxWorkDir === undefined) {
        throw new Error('Vercel Sandbox session was not captured.');
      }
      const outcome = await verifyFixture(
        sandboxSession,
        sandboxWorkDir,
        input.fixture,
        signal,
        input.onTrace,
      );
      return {
        events,
        workspaceRevision: await workspaceRevision(
          sandboxSession,
          sandboxWorkDir,
          signal,
          input.onTrace,
        ),
        outcome,
        latencyMs: performance.now() - startedAt,
        observationRecords: [...(observation?.records() ?? [])],
      };
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      try {
        const destroyed = await session.destroy();
        await input.onTrace?.({
          kind: 'session-destroyed',
          data: JsonValueSchema.parse(destroyed),
        });
      } catch (cleanupError) {
        if (primaryError !== undefined) {
          throw new AggregateError(
            [primaryError, cleanupError],
            'Hosted condition and session cleanup both failed.',
          );
        }
        throw cleanupError;
      }
    }
  }
}
