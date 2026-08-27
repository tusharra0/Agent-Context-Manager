import { describe, expect, it, vi } from 'vitest';

import type { PublicGitFixtureV1 } from '@acm/hosted-evaluation';

import {
  materializePublicGitFixture,
  type SandboxCommandSession,
} from './hosted-runner.js';

const FIXTURE: PublicGitFixtureV1 = {
  id: 'fixture',
  repositoryUrl: 'https://github.com/example/repository.git',
  revision: 'a'.repeat(40),
  setupCommands: ['pnpm install --frozen-lockfile'],
  verificationCommands: [{ id: 'tests', command: 'pnpm test' }],
};

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
