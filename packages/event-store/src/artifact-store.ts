import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  stat,
  unlink,
} from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';

import { ArtifactUriSchema } from '@acm/core';

import type { ArtifactStore, StoredArtifact } from './contracts.js';
import {
  ArtifactIntegrityError,
  ArtifactUriError,
  DestinationExistsError,
} from './errors.js';

const URI_PREFIX = 'artifact://sha256/';
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const READ_NOFOLLOW_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

async function removeIfPresent(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (!isNodeError(error, 'ENOENT')) throw error;
  }
}

function assertOwnedDirectory(
  path: string,
  status: Awaited<ReturnType<typeof lstat>>,
): void {
  if (status.isSymbolicLink() || !status.isDirectory()) {
    throw new ArtifactIntegrityError(
      `Artifact directory is not a real directory: ${path}`,
    );
  }
  const currentUserId = process.getuid?.();
  if (currentUserId !== undefined && status.uid !== currentUserId) {
    throw new ArtifactIntegrityError(
      `Artifact directory is not owned by the current user: ${path}`,
    );
  }
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  const status = await lstat(path);
  assertOwnedDirectory(path, status);
  await chmod(path, PRIVATE_DIRECTORY_MODE);
}

async function writeChunk(
  handle: Awaited<ReturnType<typeof open>>,
  chunk: Uint8Array,
): Promise<void> {
  let offset = 0;
  while (offset < chunk.byteLength) {
    const { bytesWritten } = await handle.write(
      chunk,
      offset,
      chunk.byteLength - offset,
    );
    if (bytesWritten === 0)
      throw new Error('Artifact temporary-file write made no progress.');
    offset += bytesWritten;
  }
}

export class LocalArtifactStore implements ArtifactStore {
  readonly root: string;
  readonly temporaryRoot: string;

  constructor(root: string) {
    this.root = resolve(root);
    this.temporaryRoot = join(this.root, 'tmp');
  }

  async put(source: NodeJS.ReadableStream): Promise<StoredArtifact> {
    // A caller may construct a stream for a missing file before our first
    // asynchronous directory operation finishes. Observe errors immediately;
    // async iteration below remains responsible for propagating them.
    const preventUnhandledError = (): void => undefined;
    source.on('error', preventUnhandledError);
    try {
      return await this.putObserved(source);
    } finally {
      source.removeListener('error', preventUnhandledError);
    }
  }

  private async putObserved(
    source: NodeJS.ReadableStream,
  ): Promise<StoredArtifact> {
    await ensurePrivateDirectory(this.root);
    await ensurePrivateDirectory(this.temporaryRoot);
    const temporaryPath = join(this.temporaryRoot, `${randomUUID()}.tmp`);
    const handle = await open(temporaryPath, 'wx', PRIVATE_FILE_MODE);
    const hash = createHash('sha256');
    let byteLength = 0;

    try {
      for await (const value of source) {
        const chunk =
          typeof value === 'string'
            ? Buffer.from(value)
            : Buffer.from(value as Uint8Array);
        hash.update(chunk);
        byteLength += chunk.byteLength;
        await writeChunk(handle, chunk);
      }
      await handle.sync();
    } catch (error) {
      await handle.close().catch(() => undefined);
      await removeIfPresent(temporaryPath).catch(() => undefined);
      throw error;
    }
    try {
      await handle.close();
    } catch (error) {
      await removeIfPresent(temporaryPath).catch(() => undefined);
      throw error;
    }

    const digest = hash.digest('hex');
    const uri = `${URI_PREFIX}${digest}`;
    const finalPath = this.pathForDigest(digest);
    let reused = false;

    try {
      await this.ensureDigestDirectories(digest);
      try {
        await link(temporaryPath, finalPath);
        await chmod(finalPath, PRIVATE_FILE_MODE);
      } catch (error) {
        if (!isNodeError(error, 'EEXIST')) throw error;
        reused = true;
      }
      const verified = await this.verify(uri);
      return { ...verified, reused };
    } finally {
      await removeIfPresent(temporaryPath);
    }
  }

  async open(uri: string): Promise<NodeJS.ReadableStream> {
    const digest = this.parseUri(uri);
    const handle = await this.openArtifactFile(digest, uri);
    const hash = createHash('sha256');
    // Read only on consumer demand. Eager piping can finish verification and
    // emit an unhandled error while the caller is still awaiting other work.
    return new Readable({
      read(size): void {
        const chunk = Buffer.allocUnsafe(
          Math.max(1, Math.min(size, 64 * 1024)),
        );
        void handle.read(chunk).then(
          ({ bytesRead }) => {
            if (this.destroyed) return;
            if (bytesRead > 0) {
              const bytes = chunk.subarray(0, bytesRead);
              hash.update(bytes);
              this.push(bytes);
              return;
            }
            const actualDigest = hash.digest('hex');
            if (actualDigest !== digest) {
              this.destroy(
                new ArtifactIntegrityError(
                  `Artifact digest mismatch for ${uri}: observed sha256/${actualDigest}`,
                ),
              );
              return;
            }
            this.push(null);
          },
          (error: Error) => this.destroy(error),
        );
      },
      destroy(error, callback): void {
        // This also closes an opened-but-unconsumed stream and waits for any
        // pending read to finish before reporting close to the consumer.
        void handle.close().then(
          () => callback(error),
          (closeError: Error) => callback(error ?? closeError),
        );
      },
    });
  }

  async verify(uri: string): Promise<StoredArtifact> {
    const digest = this.parseUri(uri);
    const handle = await this.openArtifactFile(digest, uri);
    const hash = createHash('sha256');
    let byteLength = 0;

    try {
      for await (const value of handle.createReadStream({ autoClose: true })) {
        const chunk = Buffer.from(value as Uint8Array);
        hash.update(chunk);
        byteLength += chunk.byteLength;
      }
    } catch (error) {
      await handle.close().catch(() => undefined);
      throw error;
    }

    const actualDigest = hash.digest('hex');
    if (actualDigest !== digest) {
      throw new ArtifactIntegrityError(
        `Artifact digest mismatch for ${uri}: observed sha256/${actualDigest}`,
      );
    }

    return { uri, algorithm: 'sha256', digest, byteLength, reused: true };
  }

  async restore(uri: string, outputPath: string): Promise<void> {
    const digest = this.parseUri(uri);
    const destination = resolve(outputPath);
    await mkdir(dirname(destination), { recursive: true });

    try {
      await stat(destination);
      throw new DestinationExistsError(destination);
    } catch (error) {
      if (!isNodeError(error, 'ENOENT')) throw error;
    }

    const artifactHandle = await this.openArtifactFile(digest, uri);
    const temporaryPath = join(
      dirname(destination),
      `.${randomUUID()}.acm-restore.tmp`,
    );
    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = await open(temporaryPath, 'wx', PRIVATE_FILE_MODE);
    } catch (error) {
      await artifactHandle.close().catch(() => undefined);
      throw error;
    }
    const hash = createHash('sha256');

    try {
      for await (const value of artifactHandle.createReadStream({
        autoClose: true,
      })) {
        const chunk = Buffer.from(value as Uint8Array);
        hash.update(chunk);
        await writeChunk(handle, chunk);
      }
      await handle.sync();
      await handle.close();

      const actualDigest = hash.digest('hex');
      if (actualDigest !== digest) {
        throw new ArtifactIntegrityError(
          `Artifact digest mismatch for ${uri}: observed sha256/${actualDigest}`,
        );
      }

      try {
        await link(temporaryPath, destination);
      } catch (error) {
        if (isNodeError(error, 'EEXIST'))
          throw new DestinationExistsError(destination);
        throw error;
      }
    } catch (error) {
      await handle.close().catch(() => undefined);
      await artifactHandle.close().catch(() => undefined);
      throw error;
    } finally {
      await removeIfPresent(temporaryPath).catch(() => undefined);
    }
  }

  private parseUri(uri: string): string {
    const parsed = ArtifactUriSchema.safeParse(uri);
    if (!parsed.success)
      throw new ArtifactUriError(`Invalid artifact URI: ${uri}`);
    return uri.slice(URI_PREFIX.length);
  }

  private pathForDigest(digest: string): string {
    return join(
      this.root,
      'sha256',
      digest.slice(0, 2),
      digest.slice(2, 4),
      digest,
    );
  }

  private async ensureDigestDirectories(digest: string): Promise<void> {
    const directories = [
      this.root,
      join(this.root, 'sha256'),
      join(this.root, 'sha256', digest.slice(0, 2)),
      join(this.root, 'sha256', digest.slice(0, 2), digest.slice(2, 4)),
    ];
    for (const directory of directories)
      await ensurePrivateDirectory(directory);
  }

  private async openArtifactFile(
    digest: string,
    uri: string,
  ): Promise<Awaited<ReturnType<typeof open>>> {
    const directories = [
      this.root,
      join(this.root, 'sha256'),
      join(this.root, 'sha256', digest.slice(0, 2)),
      join(this.root, 'sha256', digest.slice(0, 2), digest.slice(2, 4)),
    ];
    try {
      for (const directory of directories) {
        assertOwnedDirectory(directory, await lstat(directory));
      }
      const handle = await open(
        this.pathForDigest(digest),
        READ_NOFOLLOW_FLAGS,
      );
      const status = await handle.stat();
      if (!status.isFile()) {
        await handle.close();
        throw new ArtifactIntegrityError(
          `Artifact is not a regular file: ${uri}`,
        );
      }
      return handle;
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) {
        throw new ArtifactIntegrityError(`Artifact is missing: ${uri}`);
      }
      if (isNodeError(error, 'ELOOP')) {
        throw new ArtifactIntegrityError(
          `Artifact path contains a symbolic link: ${uri}`,
        );
      }
      throw error;
    }
  }
}
