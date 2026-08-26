import { createHash } from 'node:crypto';
import {
  access,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import type { CliIo, CliRuntime } from './app.js';
import { runCli } from './app.js';

const fixtureRoot = new URL(
  '../../../packages/reducers/test/fixtures/vitest-json/v1/',
  import.meta.url,
);
const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'acm-cli-test-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('Phase 3 CLI', () => {
  it('validates and runs an offline paired evaluation with deterministic outputs', async () => {
    const directory = await temporaryDirectory();
    const experimentPath = join(directory, 'experiment.json');
    const resultPath = join(directory, 'result.json');
    const reportPath = join(directory, 'report.md');
    const rawText = `build noise ${'x'.repeat(600)} error TS2345 on line 7`;
    const eventId = `evt_${'2'.repeat(32)}`;
    const action = {
      kind: 'edit-file',
      name: 'apply_patch',
      arguments: { path: 'src/index.ts' },
      targets: ['src/index.ts'],
    };
    await writeFile(
      experimentPath,
      JSON.stringify({
        schemaVersion: 1,
        id: 'cli-phase3',
        name: 'CLI Phase 3 fixture',
        createdAt: '2026-08-26T12:00:00.000Z',
        repositoryFixture: {
          id: 'cli-synthetic-project',
          revision: 'fixture-revision-1',
        },
        policyId: 'priority-whole-item@1',
        tokenEstimatorId: 'utf8-bytes-div-4@1',
        cases: [
          {
            id: 'build-failure',
            task: 'Fix the build failure.',
            checkpoints: [
              {
                id: 'after-build',
                throughSequence: 1,
                tokenBudget: 1000,
                state: {
                  schemaVersion: 1,
                  sessionId: `ses_${'1'.repeat(32)}`,
                  revision: 0,
                  throughSequence: 0,
                  requirements: [],
                  decisions: [],
                  files: [],
                  failures: [],
                  workItems: [],
                  updatedAt: '2026-08-26T12:00:00.000Z',
                },
                instructions: [{ id: 'task', text: 'Fix the build.' }],
                observations: [
                  {
                    eventId,
                    sequence: 1,
                    rawText,
                    contentHash: createHash('sha256')
                      .update(rawText)
                      .digest('hex'),
                    safeForContext: true,
                    managedCandidate: {
                      id: `event:${eventId}`,
                      class: 'active-failure',
                      required: true,
                      sequence: 1,
                      text: '{"code":"TS2345","line":7}',
                      sourceEventIds: [eventId],
                    },
                  },
                ],
                criticalFields: [
                  {
                    id: 'line',
                    category: 'build-field',
                    sourceEventId: eventId,
                    sourceText: 'line 7',
                    expectedValue: 7,
                    locator: {
                      mode: 'candidate-json-pointer',
                      candidateId: `event:${eventId}`,
                      jsonPointer: '/line',
                    },
                  },
                ],
              },
            ],
            rawEvidence: {
              condition: 'raw',
              producer: { kind: 'synthetic' },
              checkpointActions: [
                { checkpointId: 'after-build', nextAction: action },
              ],
              actions: [{ action, workspaceRevision: 'rev-1' }],
              outcome: {
                success: true,
                assertions: [{ id: 'tests', passed: true }],
              },
            },
            managedEvidence: {
              condition: 'managed',
              producer: { kind: 'synthetic' },
              checkpointActions: [
                { checkpointId: 'after-build', nextAction: action },
              ],
              actions: [{ action, workspaceRevision: 'rev-1' }],
              outcome: {
                success: true,
                assertions: [{ id: 'tests', passed: true }],
              },
            },
          },
        ],
      }),
    );

    const validated = await invoke(['eval', 'validate', experimentPath]);
    expect(validated.exitCode).toBe(0);
    expect(JSON.parse(validated.stdout[0]!)).toEqual({
      caseCount: 1,
      checkpointCount: 1,
      experimentId: 'cli-phase3',
      valid: true,
    });

    const evaluated = await invoke([
      'eval',
      'run',
      experimentPath,
      '--output',
      resultPath,
      '--report',
      reportPath,
    ]);
    expect(evaluated.exitCode).toBe(0);
    expect(JSON.parse(await readFile(resultPath, 'utf8'))).toMatchObject({
      experimentId: 'cli-phase3',
      status: 'pass',
      aggregate: {
        criticalFieldRecall: 1,
        exactNextActionAgreementRate: 1,
      },
    });
    expect(await readFile(reportPath, 'utf8')).toContain('Status: **PASS**');

    const repeated = await invoke([
      'eval',
      'run',
      experimentPath,
      '--output',
      resultPath,
    ]);
    expect(repeated.exitCode).toBe(1);
    expect(repeated.stderr[0]).toMatch(/exist/u);
  });
});

const runtime: CliRuntime = {
  environment: {},
  now: () => new Date('2026-08-18T12:00:00.000Z'),
};

async function invoke(arguments_: string[]): Promise<{
  exitCode: number;
  stdout: string[];
  stderr: string[];
}> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const io: CliIo = {
    stdout: (message) => stdout.push(message),
    stderr: (message) => stderr.push(message),
  };
  return { exitCode: await runCli(arguments_, io, runtime), stdout, stderr };
}

describe('Phase 1 CLI', () => {
  it('reduces, inspects, and restores a real Vitest JSON report byte-for-byte', async () => {
    const dataDirectory = await temporaryDirectory();
    const input = new URL('one-failure.json', fixtureRoot);
    const reduced = await invoke([
      'reduce',
      fileURLToPath(input),
      '--type',
      'test-result',
      '--framework',
      'vitest',
      '--format',
      'json',
      '--command',
      'pnpm test',
      '--exit-code',
      '1',
      '--data-dir',
      dataDirectory,
    ]);
    expect(reduced.exitCode).toBe(0);
    expect(reduced.stderr).toEqual([]);
    const envelope = JSON.parse(reduced.stdout[0]!) as {
      sessionId: string;
      eventId: string;
      artifactUri: string;
      sequence: number;
      safeForContext: boolean;
      tokenEstimatorId: string;
      reduction: { failures: unknown[] };
    };
    expect(envelope).toMatchObject({
      sequence: 1,
      safeForContext: true,
      tokenEstimatorId: 'utf8-bytes-div-4@1',
    });
    expect(envelope.reduction.failures).toHaveLength(1);

    const inspected = await invoke([
      'inspect',
      'event',
      envelope.eventId,
      '--data-dir',
      dataDirectory,
      '--json',
    ]);
    expect(inspected.exitCode).toBe(0);
    expect(JSON.parse(inspected.stdout[0]!)).toMatchObject({
      event: { id: envelope.eventId, rawArtifactUri: envelope.artifactUri },
      reduction: { safeForContext: true },
    });

    const output = join(dataDirectory, 'restored.json');
    const restored = await invoke([
      'restore',
      envelope.artifactUri,
      '--output',
      output,
      '--data-dir',
      dataDirectory,
    ]);
    expect(restored.exitCode).toBe(0);
    expect(await readFile(output)).toEqual(await readFile(input));
  });

  it('reuses identical artifacts while recording a new ordered event', async () => {
    const dataDirectory = await temporaryDirectory();
    const input = fileURLToPath(new URL('all-pass.json', fixtureRoot));
    const base = [
      'reduce',
      input,
      '--type',
      'test-result',
      '--framework',
      'vitest',
      '--format',
      'json',
      '--data-dir',
      dataDirectory,
    ];
    const first = JSON.parse((await invoke(base)).stdout[0]!) as {
      sessionId: string;
      eventId: string;
      artifactUri: string;
      artifactReused: boolean;
      sequence: number;
    };
    const secondInvocation = await invoke([
      ...base,
      '--session',
      first.sessionId,
    ]);
    expect(secondInvocation.exitCode).toBe(0);
    const second = JSON.parse(secondInvocation.stdout[0]!) as typeof first;
    expect(second).toMatchObject({
      artifactUri: first.artifactUri,
      artifactReused: true,
      sequence: 2,
    });
    expect(second.eventId).not.toBe(first.eventId);
  });

  it('records opaque input, exits 2, and keeps it restorable', async () => {
    const dataDirectory = await temporaryDirectory();
    const input = new URL('truncated.json', fixtureRoot);
    const reduced = await invoke([
      'reduce',
      fileURLToPath(input),
      '--type',
      'test-result',
      '--framework',
      'vitest',
      '--format',
      'json',
      '--data-dir',
      dataDirectory,
    ]);
    expect(reduced.exitCode).toBe(2);
    const envelope = JSON.parse(reduced.stdout[0]!) as {
      artifactUri: string;
      safeForContext: boolean;
      reduction: { diagnostics: { code: string }[] };
    };
    expect(envelope.safeForContext).toBe(false);
    expect(envelope.reduction.diagnostics[0]?.code).toBe('INVALID_JSON');

    const output = join(dataDirectory, 'opaque-restored.json');
    expect(
      (
        await invoke([
          'restore',
          envelope.artifactUri,
          '--output',
          output,
          '--data-dir',
          dataDirectory,
        ])
      ).exitCode,
    ).toBe(0);
    expect(await readFile(output)).toEqual(await readFile(input));
  });

  it('never prints success output after a storage or usage failure', async () => {
    const dataDirectory = await temporaryDirectory();
    const missing = await invoke([
      'reduce',
      join(dataDirectory, 'missing.json'),
      '--type',
      'test-result',
      '--framework',
      'vitest',
      '--format',
      'json',
      '--data-dir',
      dataDirectory,
    ]);
    expect(missing.exitCode).toBe(1);
    expect(missing.stdout).toEqual([]);
    expect(missing.stderr).toHaveLength(1);

    const invalid = await invoke([
      'reduce',
      'anything.json',
      '--type',
      'test-result',
    ]);
    expect(invalid.exitCode).toBe(1);
    expect(invalid.stdout).toEqual([]);
  });

  it('refuses to overwrite a restore destination', async () => {
    const dataDirectory = await temporaryDirectory();
    const input = new URL('all-pass.json', fixtureRoot);
    const reduced = await invoke([
      'reduce',
      fileURLToPath(input),
      '--type',
      'test-result',
      '--framework',
      'vitest',
      '--format',
      'json',
      '--data-dir',
      dataDirectory,
    ]);
    const { artifactUri } = JSON.parse(reduced.stdout[0]!) as {
      artifactUri: string;
    };
    const output = join(dataDirectory, 'existing.json');
    await writeFile(output, 'do not replace');
    const restored = await invoke([
      'restore',
      artifactUri,
      '--output',
      output,
      '--data-dir',
      dataDirectory,
    ]);
    expect(restored.exitCode).toBe(1);
    expect(await readFile(output, 'utf8')).toBe('do not replace');
  });
});

describe('Phase 2 CLI', () => {
  it('deduplicates exact file reads within a session', async () => {
    const dataDirectory = await temporaryDirectory();
    const input = join(dataDirectory, 'index.ts');
    await writeFile(input, 'export const value = 1;\n');
    const base = [
      'reduce',
      input,
      '--type',
      'file-read',
      '--path',
      'src/index.ts',
      '--path-kind',
      'repository-relative',
      '--scope',
      'full',
      '--encoding',
      'utf-8',
      '--data-dir',
      dataDirectory,
    ];
    const first = JSON.parse((await invoke(base)).stdout[0]!) as {
      sessionId: string;
      eventId: string;
      reduction: { duplicateOfEventId?: string };
    };
    expect(first.reduction.duplicateOfEventId).toBeUndefined();
    const second = JSON.parse(
      (await invoke([...base, '--session', first.sessionId])).stdout[0]!,
    ) as typeof first;
    expect(second.reduction.duplicateOfEventId).toBe(first.eventId);
    const inspected = await invoke([
      'inspect',
      'event',
      second.eventId,
      '--data-dir',
      dataDirectory,
      '--json',
    ]);
    expect(inspected.exitCode).toBe(0);
    expect(JSON.parse(inspected.stdout[0]!)).toMatchObject({
      event: { kind: 'file_read' },
      reduction: { safeForContext: true },
    });
    const assembled = await invoke([
      'assemble',
      '--session',
      first.sessionId,
      '--token-budget',
      '10000',
      '--data-dir',
      dataDirectory,
    ]);
    expect(assembled.exitCode).toBe(0);
    expect(assembled.stdout[0]).toContain('export const value = 1;');
  });

  it('recovers mandatory state after fresh-process compaction and reports budget overflow', async () => {
    const dataDirectory = await temporaryDirectory();
    const file = join(dataDirectory, 'source.ts');
    await writeFile(file, 'export {};\n');
    const reduced = await invoke([
      'reduce',
      file,
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
      dataDirectory,
    ]);
    const { sessionId } = JSON.parse(reduced.stdout[0]!) as {
      sessionId: string;
    };
    const updatePath = join(dataDirectory, 'state-update.json');
    await writeFile(
      updatePath,
      JSON.stringify({
        schemaVersion: 1,
        expectedRevision: 0,
        operations: [
          { operation: 'set-goal', text: 'Finish Phase 2 safely' },
          {
            operation: 'add-fact',
            category: 'requirement',
            text: 'Never discard raw evidence',
          },
          {
            operation: 'add-fact',
            category: 'failure',
            text: 'Active failure must remain detailed',
          },
        ],
      }),
    );
    const applied = await invoke([
      'state',
      'apply',
      updatePath,
      '--session',
      sessionId,
      '--data-dir',
      dataDirectory,
    ]);
    expect(applied.exitCode).toBe(0);
    expect(JSON.parse(applied.stdout[0]!)).toMatchObject({ revision: 1 });

    const verified = await invoke([
      'state',
      'verify',
      '--session',
      sessionId,
      '--data-dir',
      dataDirectory,
    ]);
    expect(verified.exitCode).toBe(0);
    expect(JSON.parse(verified.stdout[0]!)).toMatchObject({
      status: 'verified',
      revision: 1,
    });

    const assembled = await invoke([
      'assemble',
      '--session',
      sessionId,
      '--token-budget',
      '1',
      '--data-dir',
      dataDirectory,
    ]);
    expect(assembled.exitCode).toBe(2);
    const context = JSON.parse(assembled.stdout[0]!) as {
      context: { items: { text: string }[] };
      manifest: { status: string };
    };
    expect(context.manifest.status).toBe('mandatory-overflow');
    expect(context.context.items.map((item) => item.text)).toEqual(
      expect.arrayContaining([
        'Finish Phase 2 safely',
        'Never discard raw evidence',
        'Active failure must remain detailed',
      ]),
    );
  });

  it('records structured ripgrep and TypeScript build observations', async () => {
    const dataDirectory = await temporaryDirectory();
    const searchPath = join(dataDirectory, 'search.jsonl');
    await writeFile(
      searchPath,
      `${JSON.stringify({
        type: 'match',
        data: {
          path: { text: 'src/index.ts' },
          lines: { text: 'const value = 1;\n' },
          line_number: 1,
          submatches: [{ start: 0, end: 5 }],
        },
      })}\n${JSON.stringify({ type: 'summary', data: { stats: { matches: 1 } } })}\n`,
    );
    const search = await invoke([
      'reduce',
      searchPath,
      '--type',
      'search-result',
      '--tool',
      'ripgrep',
      '--format',
      'json',
      '--query',
      'const',
      '--root',
      '.',
      '--exit-code',
      '0',
      '--data-dir',
      dataDirectory,
    ]);
    expect(search.exitCode).toBe(0);
    const { sessionId } = JSON.parse(search.stdout[0]!) as {
      sessionId: string;
    };

    const buildPath = join(dataDirectory, 'build.txt');
    await writeFile(
      buildPath,
      'src/index.ts(1,7): error TS2322: Broken assignment.\nFound 1 error.\n',
    );
    const build = await invoke([
      'reduce',
      buildPath,
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
      '2',
      '--session',
      sessionId,
      '--data-dir',
      dataDirectory,
    ]);
    expect(build.exitCode).toBe(0);
    expect(JSON.parse(build.stdout[0]!)).toMatchObject({
      sequence: 2,
      reduction: {
        buildDiagnostics: [{ code: 'TS2322', file: 'src/index.ts' }],
      },
    });
  });

  it('keeps a failing build mandatory even when the context budget is too small', async () => {
    const dataDirectory = await temporaryDirectory();
    const buildPath = join(dataDirectory, 'build.txt');
    await writeFile(
      buildPath,
      'src/index.ts(1,7): error TS2322: Broken assignment.\n',
    );
    const build = await invoke([
      'reduce',
      buildPath,
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
      '2',
      '--data-dir',
      dataDirectory,
    ]);
    const { sessionId, eventId } = JSON.parse(build.stdout[0]!) as {
      sessionId: string;
      eventId: string;
    };

    const assembled = await invoke([
      'assemble',
      '--session',
      sessionId,
      '--token-budget',
      '1',
      '--data-dir',
      dataDirectory,
    ]);
    expect(assembled.exitCode).toBe(2);
    const output = JSON.parse(assembled.stdout[0]!) as {
      context: { items: { id: string; class: string; text: string }[] };
      manifest: { status: string };
    };
    expect(output.manifest.status).toBe('mandatory-overflow');
    expect(output.context.items).toContainEqual(
      expect.objectContaining({
        id: `event:${eventId}`,
        class: 'active-failure',
        text: expect.stringContaining('TS2322'),
      }),
    );
  });

  it('assembles only the newest observation of the same logical file', async () => {
    const dataDirectory = await temporaryDirectory();
    const input = join(dataDirectory, 'changing.ts');
    const base = [
      'reduce',
      input,
      '--type',
      'file-read',
      '--path',
      'src/changing.ts',
      '--path-kind',
      'repository-relative',
      '--scope',
      'full',
      '--encoding',
      'utf-8',
      '--data-dir',
      dataDirectory,
    ];
    await writeFile(input, 'export const version = "old";\n');
    const first = JSON.parse((await invoke(base)).stdout[0]!) as {
      sessionId: string;
      eventId: string;
    };
    await writeFile(input, 'export const version = "new";\n');
    await invoke([...base, '--session', first.sessionId]);

    const assembled = await invoke([
      'assemble',
      '--session',
      first.sessionId,
      '--token-budget',
      '10000',
      '--data-dir',
      dataDirectory,
    ]);
    const output = JSON.parse(assembled.stdout[0]!) as {
      context: { items: { text: string }[] };
      manifest: { excludedCandidates: { id: string; reason: string }[] };
    };
    const contextText = output.context.items
      .map((item) => item.text)
      .join('\n');
    expect(contextText).toContain('version = \\"new\\"');
    expect(contextText).not.toContain('version = \\"old\\"');
    expect(output.manifest.excludedCandidates).toContainEqual({
      id: `event:${first.eventId}`,
      reason: 'superseded',
    });
  });

  it('bounds total restored file content across an assembly', async () => {
    const dataDirectory = await temporaryDirectory();
    const firstPath = join(dataDirectory, 'first.txt');
    const secondPath = join(dataDirectory, 'second.txt');
    await writeFile(firstPath, 'A'.repeat(9000));
    await writeFile(secondPath, 'B'.repeat(9000));
    const reduceFile = async (
      input: string,
      logicalPath: string,
      sessionId?: string,
    ) =>
      invoke([
        'reduce',
        input,
        '--type',
        'file-read',
        '--path',
        logicalPath,
        '--path-kind',
        'repository-relative',
        '--scope',
        'full',
        '--encoding',
        'utf-8',
        ...(sessionId ? ['--session', sessionId] : []),
        '--data-dir',
        dataDirectory,
      ]);
    const first = JSON.parse(
      (await reduceFile(firstPath, 'first.txt')).stdout[0]!,
    ) as { sessionId: string };
    await reduceFile(secondPath, 'second.txt', first.sessionId);

    const assembled = await invoke([
      'assemble',
      '--session',
      first.sessionId,
      '--token-budget',
      '4000',
      '--data-dir',
      dataDirectory,
    ]);
    expect(assembled.exitCode).toBe(0);
    const output = JSON.parse(assembled.stdout[0]!) as {
      context: { items: { text: string }[] };
    };
    const texts = output.context.items.map((item) => item.text);
    expect(texts.some((text) => text.includes('B'.repeat(9000)))).toBe(true);
    expect(
      texts.some((text) => text.includes('file-read-restoration-required')),
    ).toBe(true);
    expect(texts.some((text) => text.includes('A'.repeat(9000)))).toBe(false);
  });

  it('does not write storage for invalid command-specific options', async () => {
    const root = await temporaryDirectory();
    const input = join(root, 'search.jsonl');
    const storage = join(root, 'storage');
    await writeFile(input, '{}\n');
    const invalid = await invoke([
      'reduce',
      input,
      '--type',
      'search-result',
      '--tool',
      'ripgrep',
      '--format',
      'wrong',
      '--query',
      'value',
      '--root',
      '.',
      '--data-dir',
      storage,
    ]);
    expect(invalid.exitCode).toBe(1);
    await expect(access(storage)).rejects.toThrow();
  });

  it('does not store an invalid state-update document', async () => {
    const dataDirectory = await temporaryDirectory();
    const input = join(dataDirectory, 'source.ts');
    await writeFile(input, 'export {};\n');
    const reduced = await invoke([
      'reduce',
      input,
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
      dataDirectory,
    ]);
    const { sessionId } = JSON.parse(reduced.stdout[0]!) as {
      sessionId: string;
    };
    const artifacts = join(dataDirectory, 'artifacts');
    const before = await readdir(artifacts, { recursive: true });
    const updatePath = join(dataDirectory, 'invalid-state.json');
    await writeFile(updatePath, '{');

    const applied = await invoke([
      'state',
      'apply',
      updatePath,
      '--session',
      sessionId,
      '--data-dir',
      dataDirectory,
    ]);
    expect(applied.exitCode).toBe(1);
    expect(await readdir(artifacts, { recursive: true })).toEqual(before);
  });
});
