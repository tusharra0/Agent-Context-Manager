import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { runCli } from '../app.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    if (
      !resolve(directory).startsWith(join(resolve(tmpdir()), 'acm-assembly-'))
    ) {
      throw new Error('Unexpected assembly test cleanup path.');
    }
    await rm(directory, { recursive: true, force: true });
  }
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'acm-assembly-'));
  temporaryDirectories.push(directory);
  return directory;
}

async function invoke(arguments_: string[]) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exitCode = await runCli(
    arguments_,
    {
      stdout: (message) => stdout.push(message),
      stderr: (message) => stderr.push(message),
    },
    {
      environment: {},
      now: () => new Date('2026-09-07T12:00:00.000Z'),
    },
  );
  expect(stderr).toEqual([]);
  return { exitCode, output: JSON.parse(stdout[0]!) };
}

async function updateState(
  directory: string,
  sessionId: string,
  expectedRevision: number,
  operations: unknown[],
) {
  const path = join(directory, `state-${expectedRevision}.json`);
  await writeFile(
    path,
    JSON.stringify({ schemaVersion: 1, expectedRevision, operations }),
  );
  return invoke([
    'state',
    'apply',
    path,
    '--session',
    sessionId,
    '--data-dir',
    directory,
  ]);
}

async function assemble(directory: string, sessionId: string, budget = 10000) {
  return invoke([
    'assemble',
    '--session',
    sessionId,
    '--data-dir',
    directory,
    '--token-budget',
    String(budget),
  ]);
}

async function recordBuild(
  directory: string,
  sessionId?: string,
  passing = false,
) {
  const path = join(
    directory,
    passing ? 'passing-build.txt' : 'failing-build.txt',
  );
  await writeFile(
    path,
    passing ? '' : 'src/index.ts(1,7): error TS2322: Broken assignment.\n',
  );
  return invoke([
    'reduce',
    path,
    '--type',
    'build-result',
    '--tool',
    'typescript',
    '--format',
    'tsc-pretty-false',
    '--command',
    'pnpm typecheck',
    '--working-directory',
    '.',
    '--exit-code',
    passing ? '0' : '2',
    '--data-dir',
    directory,
    ...(sessionId ? ['--session', sessionId] : []),
  ]);
}

describe('state-aware CLI assembly', () => {
  it('excludes stale file content after record-file while retaining modified state and restorable evidence', async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, 'source.ts');
    const oldText = 'export const version = "obsolete";\n';
    await writeFile(path, oldText);
    const reduced = await invoke([
      'reduce',
      path,
      '--type',
      'file-read',
      '--path',
      'src/source.ts',
      '--path-kind',
      'repository-relative',
      '--scope',
      'full',
      '--encoding',
      'utf-8',
      '--data-dir',
      directory,
    ]);
    const { sessionId, eventId } = reduced.output;
    const state = await updateState(directory, sessionId, 0, [
      {
        operation: 'record-file',
        path: 'src/source.ts',
        pathKind: 'repository-relative',
        modified: true,
        contentHash: createHash('sha256')
          .update('export const version = "current";\n')
          .digest('hex'),
      },
    ]);
    expect(state.exitCode).toBe(0);
    const result = await assemble(directory, sessionId);
    expect(result.exitCode).toBe(0);
    expect(JSON.stringify(result.output.context)).not.toContain('obsolete');
    expect(result.output.context.items).toContainEqual(
      expect.objectContaining({
        class: 'working-state',
        text: expect.stringContaining('src/source.ts'),
      }),
    );
    expect(result.output.manifest.excludedCandidates).toContainEqual({
      id: `event:${eventId}`,
      reason: 'superseded',
    });
    const restoredPath = join(directory, 'restored.ts');
    const messages: string[] = [];
    const digest = createHash('sha256').update(oldText).digest('hex');
    const restored = await runCli(
      [
        'restore',
        `artifact://sha256/${digest}`,
        '--output',
        restoredPath,
        '--data-dir',
        directory,
      ],
      {
        stdout: (message) => messages.push(message),
        stderr: (message) => messages.push(message),
      },
      {
        environment: {},
        now: () => new Date('2026-09-07T12:00:00.000Z'),
      },
    );
    expect(restored, messages.join('\n')).toBe(0);
    expect(await readFile(restoredPath, 'utf8')).toBe(oldText);
  });

  it('folds explicitly resolved failure observations with their full details and evidence', async () => {
    const directory = await temporaryDirectory();
    const reduced = await recordBuild(directory);
    const { sessionId, eventId } = reduced.output;
    const added = await updateState(directory, sessionId, 0, [
      {
        operation: 'add-fact',
        category: 'failure',
        text: 'Resolve the failed build',
        provenance: [{ sourceEventId: eventId }],
      },
    ]);
    const failureId = added.output.state.failures[0].id;
    const passing = await recordBuild(directory, sessionId, true);
    await updateState(directory, sessionId, 1, [
      {
        operation: 'change-fact-status',
        category: 'failure',
        itemId: failureId,
        status: 'resolved',
        provenance: [{ sourceEventId: passing.output.eventId }],
      },
      {
        operation: 'set-test-status',
        status: 'passed',
        summary: 'Typecheck passed',
        provenance: [{ sourceEventId: passing.output.eventId }],
      },
    ]);
    const result = await assemble(directory, sessionId);
    const observation = result.output.context.items.find(
      (item: { id: string }) => item.id === `event:${eventId}`,
    );
    expect(observation.class).toBe('completed-outcome');
    expect(JSON.parse(observation.text)).toMatchObject({
      kind: 'resolved-failure',
      observation: {
        buildDiagnostics: [expect.objectContaining({ code: 'TS2322' })],
      },
      resolutions: [
        expect.objectContaining({ id: failureId, status: 'resolved' }),
      ],
      evidence: {
        rawArtifactUri: expect.stringMatching(/^artifact:\/\/sha256\//u),
      },
    });
    const constrained = await assemble(directory, sessionId, 100);
    expect(constrained.output.manifest.status).toBe('within-budget');
    expect(constrained.output.context.items).not.toContainEqual(
      expect.objectContaining({ class: 'active-failure' }),
    );
  });

  it('keeps a failed report mandatory after a passing command without explicit resolution', async () => {
    const directory = await temporaryDirectory();
    const failed = await recordBuild(directory);
    const { sessionId, eventId } = failed.output;
    const passing = await recordBuild(directory, sessionId, true);
    await updateState(directory, sessionId, 0, [
      {
        operation: 'set-test-status',
        status: 'passed',
        summary: 'A later build passed',
        provenance: [{ sourceEventId: passing.output.eventId }],
      },
    ]);
    const result = await assemble(directory, sessionId, 1);
    expect(result.exitCode).toBe(2);
    expect(result.output.context.items).toContainEqual(
      expect.objectContaining({
        id: `event:${eventId}`,
        class: 'active-failure',
        text: expect.stringContaining('TS2322'),
      }),
    );
  });
});
