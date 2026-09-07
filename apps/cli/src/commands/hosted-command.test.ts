import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createSessionId } from '@acm/core';
import type {
  HostedConditionRunInputV1,
  HostedConditionRunnerPort,
} from '@acm/hosted-evaluation';

import experimentFixture from '../../../../packages/evaluation/test/fixtures/v1/passing-experiment.json' with { type: 'json' };

import type { CliIo, CliRuntime } from '../cli-context.js';
import { hostedCommand } from './hosted-command.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true })),
  );
});

async function fixture(
  observationInterception: 'off' | 'per-step' = 'off',
): Promise<{
  directory: string;
  planPath: string;
  outputPath: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), 'acm-hosted-command-'));
  roots.push(directory);
  const revision = 'a'.repeat(40);
  const experiment = structuredClone(experimentFixture);
  experiment.repositoryFixture.revision = revision;
  const planPath = join(directory, 'plan.json');
  const outputPath = join(directory, 'result.json');
  await writeFile(
    planPath,
    JSON.stringify({
      schemaVersion: 1,
      experiment,
      fixture: {
        id: experiment.repositoryFixture.id,
        repositoryUrl: 'https://github.com/example/fixture.git',
        revision,
        setupCommands: [],
        verificationCommands: [{ id: 'tests', command: 'pnpm test' }],
      },
      harness: 'codex',
      model: 'test/model',
      timeoutMs: 60_000,
      observationInterception,
    }),
  );
  return { directory, planPath, outputPath };
}

function context(directory: string): { runtime: CliRuntime; io: CliIo } {
  return {
    runtime: {
      environment: { ACM_DATA_DIR: join(directory, 'data') },
      now: () => new Date('2026-09-07T12:00:00.000Z'),
    },
    io: { stdout: vi.fn(), stderr: vi.fn() },
  };
}

describe('hostedCommand preflight and evidence', () => {
  it('reserves output paths before constructing a remote runner', async () => {
    const { directory, planPath, outputPath } = await fixture();
    await writeFile(outputPath, 'existing');
    const createRunner = vi.fn<() => HostedConditionRunnerPort>();
    const { runtime, io } = context(directory);

    await expect(
      hostedCommand(
        ['run', planPath],
        new Map([['output', outputPath]]),
        runtime,
        io,
        { createRunner, loadEnvironment: vi.fn() },
      ),
    ).rejects.toThrow();
    expect(createRunner).not.toHaveBeenCalled();
    expect(await readFile(outputPath, 'utf8')).toBe('existing');
  });

  it('keeps streamed private evidence and an error envelope when a run fails', async () => {
    const { directory, planPath, outputPath } = await fixture();
    const summaryPath = join(directory, 'summary.json');
    const runner: HostedConditionRunnerPort = {
      async runCondition(input: HostedConditionRunInputV1) {
        await input.onTrace?.({
          kind: 'harness-event',
          data: {
            kind: 'tool-result',
            output: 'PRIVATE_TOOL_OUTPUT',
            isError: true,
          },
        });
        throw new Error('provider disconnected');
      },
    };
    const { runtime, io } = context(directory);

    await expect(
      hostedCommand(
        ['run', planPath],
        new Map([
          ['output', outputPath],
          ['summary', summaryPath],
        ]),
        runtime,
        io,
        { createRunner: () => runner, loadEnvironment: vi.fn() },
      ),
    ).rejects.toThrow('provider disconnected');

    const privateResult = JSON.parse(await readFile(outputPath, 'utf8')) as {
      status: string;
      tracePath: string;
    };
    const trace = await readFile(`${outputPath}.trace.jsonl`, 'utf8');
    expect(privateResult.status).toBe('error');
    expect(privateResult.tracePath).toContain('.trace.jsonl');
    expect(trace).toContain('PRIVATE_TOOL_OUTPUT');
    await expect(readFile(summaryPath)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});

describe('hostedCommand per-step interception', () => {
  const failing: HostedConditionRunnerPort = {
    async runCondition() {
      throw new Error('runner-stopped');
    },
  };

  async function capture(
    mode: 'off' | 'per-step',
  ): Promise<{ createObservationInterceptor?: unknown }> {
    const { directory, planPath, outputPath } = await fixture(mode);
    const { runtime, io } = context(directory);
    let received: { createObservationInterceptor?: unknown } = {};
    await expect(
      hostedCommand(
        ['run', planPath],
        new Map([['output', outputPath]]),
        runtime,
        io,
        {
          createRunner: (options) => {
            received = options;
            return failing;
          },
          loadEnvironment: vi.fn(),
        },
      ),
    ).rejects.toThrow('runner-stopped');
    return received;
  }

  it('supplies no interceptor when the plan does not ask for one', async () => {
    expect((await capture('off')).createObservationInterceptor).toBeUndefined();
  });

  it('gives each condition the policy the runner will demand of it', async () => {
    const received = await capture('per-step');
    const factory = received.createObservationInterceptor as (input: {
      condition: 'raw' | 'managed';
      harness: 'codex';
      sessionId: string;
      workingDirectory: () => string;
    }) => { interceptor: { policy: string } };
    expect(factory).toBeTypeOf('function');

    const shared = {
      harness: 'codex' as const,
      workingDirectory: () => '/workspace/repo',
    };
    expect(
      factory({
        ...shared,
        condition: 'raw',
        sessionId: createSessionId(),
      }).interceptor.policy,
    ).toBe('raw');
    expect(
      factory({
        ...shared,
        condition: 'managed',
        sessionId: createSessionId(),
      }).interceptor.policy,
    ).toBe('reduced');
  });
});
