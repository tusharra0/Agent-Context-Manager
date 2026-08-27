import { createHash } from 'node:crypto';

import { createVercelSandbox } from '@ai-sdk/sandbox-vercel';

import { createSessionId } from '@acm/core';
import {
  PublicGitFixtureV1Schema,
  renderHostedConditionPrompt,
  type HostedConditionRunInputV1,
  type HostedConditionRunOutputV1,
  type HostedConditionRunnerPort,
  type PublicGitFixtureV1,
} from '@acm/hosted-evaluation';
import type { HarnessEventV1 } from '@acm/harness-port';

import { VercelHarnessPort, type VercelHarnessPortOptions } from './adapter.js';

export interface SandboxCommandSession {
  run(options: {
    command: string;
    workingDirectory?: string;
    env?: Record<string, string>;
    abortSignal?: AbortSignal;
  }): PromiseLike<{ exitCode: number; stdout: string; stderr: string }>;
}

async function requireSuccessfulCommand(
  session: SandboxCommandSession,
  command: string,
  workingDirectory: string,
  signal: AbortSignal,
  env?: Record<string, string>,
): Promise<{ stdout: string; stderr: string }> {
  const result = await session.run({
    command,
    workingDirectory,
    abortSignal: signal,
    ...(env === undefined ? {} : { env }),
  });
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
    environment,
  );
  for (const command of fixture.setupCommands) {
    await requireSuccessfulCommand(session, command, workDir, signal);
  }
}

async function verifyFixture(
  session: SandboxCommandSession,
  workDir: string,
  fixture: PublicGitFixtureV1,
  signal: AbortSignal,
): Promise<HostedConditionRunOutputV1['outcome']> {
  const assertions = [];
  for (const verification of fixture.verificationCommands) {
    const result = await session.run({
      command: verification.command,
      workingDirectory: workDir,
      abortSignal: signal,
    });
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
  );
  return `sha256:${createHash('sha256')
    .update(result.stdout, 'utf8')
    .digest('hex')}`;
}

function timeoutSignal(timeoutMs: number): AbortSignal {
  return AbortSignal.timeout(timeoutMs);
}

export class VercelHostedConditionRunner implements HostedConditionRunnerPort {
  async runCondition(
    input: HostedConditionRunInputV1,
  ): Promise<HostedConditionRunOutputV1> {
    const startedAt = performance.now();
    const signal = timeoutSignal(input.timeoutMs);
    let sandboxSession: SandboxCommandSession | undefined;
    let sandboxWorkDir: string | undefined;
    const sandbox = createVercelSandbox({
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
          }
        : {
            harness: 'claude-code',
            sandbox,
            claudeCode: { auth: 'ai-gateway', model: input.model },
            sandboxConfig,
          };
    const port = new VercelHarnessPort(portOptions);
    const session = await port.createSession({
      schemaVersion: 1,
      sessionId: createSessionId(),
      instructions:
        'Work only in the current repository. Preserve existing behavior outside the requested task and verify changes before finishing.',
    });
    const events: HarnessEventV1[] = [session.startedEvent];
    try {
      for await (const event of session.stream({
        schemaVersion: 1,
        prompt: renderHostedConditionPrompt(input),
        workspaceRevision: input.fixture.revision,
      })) {
        events.push(event);
      }
      if (sandboxSession === undefined || sandboxWorkDir === undefined) {
        throw new Error('Vercel Sandbox session was not captured.');
      }
      const outcome = await verifyFixture(
        sandboxSession,
        sandboxWorkDir,
        input.fixture,
        signal,
      );
      return {
        events,
        workspaceRevision: await workspaceRevision(
          sandboxSession,
          sandboxWorkDir,
          signal,
        ),
        outcome,
        latencyMs: performance.now() - startedAt,
      };
    } finally {
      await session.destroy();
    }
  }
}
