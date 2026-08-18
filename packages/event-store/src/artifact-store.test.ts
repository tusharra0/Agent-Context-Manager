import { createHash } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { afterEach, describe, expect, it } from 'vitest';

import {
  ArtifactIntegrityError,
  ArtifactUriError,
  DestinationExistsError,
  LocalArtifactStore,
} from './index.js';

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'acm-artifact-test-'));
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

async function readStream(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream as NodeJS.ReadableStream &
    AsyncIterable<Uint8Array>) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

describe('LocalArtifactStore', () => {
  it('stores and restores bytes exactly with a stable SHA-256 URI', async () => {
    const root = await temporaryDirectory();
    const store = new LocalArtifactStore(join(root, 'artifacts'));
    const input = Buffer.from([0, 1, 2, 255, 10, 13]);
    const digest = createHash('sha256').update(input).digest('hex');

    const stored = await store.put(
      Readable.from([input.subarray(0, 2), input.subarray(2)]),
    );
    expect(stored).toMatchObject({
      uri: `artifact://sha256/${digest}`,
      digest,
      byteLength: input.byteLength,
      reused: false,
    });

    const output = join(root, 'nested', 'restored.bin');
    await store.restore(stored.uri, output);
    expect(await readFile(output)).toEqual(input);
  });

  it('deduplicates identical content, including concurrent writes', async () => {
    const root = await temporaryDirectory();
    const store = new LocalArtifactStore(join(root, 'artifacts'));
    const input = Buffer.from('same immutable bytes');

    const [first, second] = await Promise.all([
      store.put(Readable.from(input)),
      store.put(Readable.from(input)),
    ]);
    expect(first.uri).toBe(second.uri);
    expect([first.reused, second.reused].sort()).toEqual([false, true]);

    const third = await store.put(Readable.from(input));
    expect(third.reused).toBe(true);
  });

  it('rejects corrupt existing artifacts rather than replacing them', async () => {
    const root = await temporaryDirectory();
    const artifactRoot = join(root, 'artifacts');
    const store = new LocalArtifactStore(artifactRoot);
    const input = Buffer.from('original');
    const stored = await store.put(Readable.from(input));
    const artifactPath = join(
      artifactRoot,
      'sha256',
      stored.digest.slice(0, 2),
      stored.digest.slice(2, 4),
      stored.digest,
    );
    await writeFile(artifactPath, 'corrupt');

    await expect(store.put(Readable.from(input))).rejects.toBeInstanceOf(
      ArtifactIntegrityError,
    );
    expect(await readFile(artifactPath, 'utf8')).toBe('corrupt');
  });

  it('verifies the bytes emitted by an open artifact stream', async () => {
    const root = await temporaryDirectory();
    const artifactRoot = join(root, 'artifacts');
    const store = new LocalArtifactStore(artifactRoot);
    const stored = await store.put(Readable.from('trusted'));
    const stream = await store.open(stored.uri);
    const artifactPath = join(
      artifactRoot,
      'sha256',
      stored.digest.slice(0, 2),
      stored.digest.slice(2, 4),
      stored.digest,
    );

    await writeFile(artifactPath, 'tampered');
    try {
      // The open handle may already contain the original immutable bytes. If
      // not, the verifying stream must reject the changed content.
      expect((await readStream(stream)).toString()).toBe('trusted');
    } catch (error) {
      expect(error).toBeInstanceOf(ArtifactIntegrityError);
    }

    await expect(
      readStream(await store.open(stored.uri)),
    ).rejects.toBeInstanceOf(ArtifactIntegrityError);
  });

  it('rejects invalid URIs and refuses destination overwrite', async () => {
    const root = await temporaryDirectory();
    const store = new LocalArtifactStore(join(root, 'artifacts'));
    const stored = await store.put(Readable.from('evidence'));
    const output = join(root, 'output');
    await writeFile(output, 'keep me');

    await expect(
      store.verify('artifact://sha256/../../secret'),
    ).rejects.toBeInstanceOf(ArtifactUriError);
    await expect(store.restore(stored.uri, output)).rejects.toBeInstanceOf(
      DestinationExistsError,
    );
    expect(await readFile(output, 'utf8')).toBe('keep me');
  });

  it('streams large input and cleans temporary files after source failure', async () => {
    const root = await temporaryDirectory();
    const artifactRoot = join(root, 'artifacts');
    const store = new LocalArtifactStore(artifactRoot);
    const block = Buffer.alloc(64 * 1024, 7);
    const large = Readable.from(Array.from({ length: 64 }, () => block));
    const stored = await store.put(large);
    expect(stored.byteLength).toBe(4 * 1024 * 1024);

    const failing = Readable.from(
      (async function* () {
        yield Buffer.from('partial');
        throw new Error('source failed');
      })(),
    );
    await expect(store.put(failing)).rejects.toThrow('source failed');
    expect(await readdir(join(artifactRoot, 'tmp'))).toEqual([]);
  });

  it('cleans temporary bytes when digest-directory creation fails', async () => {
    const root = await temporaryDirectory();
    const artifactRoot = join(root, 'artifacts');
    await mkdir(artifactRoot);
    await writeFile(join(artifactRoot, 'sha256'), 'blocks directory creation');
    const store = new LocalArtifactStore(artifactRoot);

    await expect(store.put(Readable.from('sensitive bytes'))).rejects.toThrow();
    expect(await readdir(join(artifactRoot, 'tmp'))).toEqual([]);
  });

  it.runIf(process.platform !== 'win32')(
    'creates private artifact directories and files',
    async () => {
      const root = await temporaryDirectory();
      const artifactRoot = join(root, 'artifacts');
      const store = new LocalArtifactStore(artifactRoot);
      const stored = await store.put(Readable.from('private'));
      const artifactPath = join(
        artifactRoot,
        'sha256',
        stored.digest.slice(0, 2),
        stored.digest.slice(2, 4),
        stored.digest,
      );

      expect((await stat(artifactRoot)).mode & 0o777).toBe(0o700);
      expect((await stat(artifactPath)).mode & 0o777).toBe(0o600);
    },
  );
});
