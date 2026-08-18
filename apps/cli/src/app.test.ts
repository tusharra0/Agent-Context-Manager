import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
