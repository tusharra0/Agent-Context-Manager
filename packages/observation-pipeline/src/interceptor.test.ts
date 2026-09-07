import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createSessionId, type UuidGenerator } from '@acm/core';
import {
  LocalArtifactStore,
  SqliteMetadataStore,
  type ArtifactStore,
  type MetadataStore,
  type StoredArtifact,
} from '@acm/event-store';
import type {
  HarnessToolInvocation,
  ObservationPolicy,
} from '@acm/harness-port';

import type {
  ClassifierInput,
  ObservationClassification,
  ObservationClassifier,
} from './classifiers.js';
import {
  RecordingObservationInterceptor,
  type RecordingObservationInterceptorOptions,
} from './interceptor.js';

const SESSION_ID = createSessionId(
  () => '00000000-0000-4000-8000-000000000042',
);
const WORKING_DIRECTORY = '/workspace/repo';

const temporaryDirectories: string[] = [];
const openStores: SqliteMetadataStore[] = [];

afterEach(async () => {
  for (const store of openStores.splice(0)) store.close();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

function uuidSequence(): UuidGenerator {
  let issued = 0;
  return () => {
    issued += 1;
    return `00000000-0000-4000-8000-${issued.toString(16).padStart(12, '0')}`;
  };
}

type Harness = {
  interceptor: RecordingObservationInterceptor;
  artifacts: ArtifactStore;
  metadata: SqliteMetadataStore;
};

async function createHarness(
  policy: ObservationPolicy,
  overrides: Partial<RecordingObservationInterceptorOptions> = {},
): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'acm-observation-'));
  temporaryDirectories.push(root);
  const artifacts = new LocalArtifactStore(join(root, 'artifacts'));
  const metadata = new SqliteMetadataStore(join(root, 'acm.sqlite3'));
  openStores.push(metadata);
  const interceptor = new RecordingObservationInterceptor({
    sessionId: SESSION_ID,
    policy,
    artifacts,
    metadata,
    workingDirectory: WORKING_DIRECTORY,
    generateUuid: uuidSequence(),
    now: () => new Date('2026-09-07T12:00:00.000Z'),
    ...overrides,
  });
  return { interceptor, artifacts, metadata };
}

function readInvocation(
  toolCallId: string,
  path = 'src/index.ts',
): HarnessToolInvocation {
  return { toolCallId, toolName: 'read', input: { file_path: path } };
}

function bytesOf(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, 'utf8'));
}

async function readStream(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

const FILE_TEXT = `${'export const value = 1;\n'.repeat(80)}`;

function ripgrepJson(fileCount: number): string {
  const lines: string[] = [];
  for (let index = 0; index < fileCount; index += 1) {
    const path = `src/module-${index}.ts`;
    lines.push(
      JSON.stringify({ type: 'begin', data: { path: { text: path } } }),
    );
    lines.push(
      JSON.stringify({
        type: 'match',
        data: {
          path: { text: path },
          lines: { text: 'const value = compute();\n' },
          line_number: index + 1,
          absolute_offset: index * 40,
          submatches: [{ match: { text: 'value' }, start: 6, end: 11 }],
        },
      }),
    );
    lines.push(JSON.stringify({ type: 'end', data: { path: { text: path } } }));
  }
  lines.push(
    JSON.stringify({
      type: 'summary',
      data: { stats: { matches: fileCount } },
    }),
  );
  return `${lines.join('\n')}\n`;
}

describe('RecordingObservationInterceptor', () => {
  it('keeps the first read whole and folds an identical repeat into a reference', async () => {
    const { interceptor } = await createHarness('reduced');

    const first = await interceptor.intercept(readInvocation('call-1'), {
      bytes: bytesOf(FILE_TEXT),
      isError: false,
    });
    const second = await interceptor.intercept(readInvocation('call-2'), {
      bytes: bytesOf(FILE_TEXT),
      isError: false,
    });

    // A first read has no substitute: its reduction is metadata, not content.
    expect(first.text).toBe(FILE_TEXT);
    expect(first.record).toMatchObject({
      mode: 'raw',
      reductionOutcome: 'unsafe',
      reductionUsable: false,
    });
    expect(first.record.evidence?.eventId).toBeDefined();

    expect(second.record).toMatchObject({
      mode: 'reduced',
      reductionOutcome: 'applied',
      reductionUsable: true,
      reducerId: 'file-read/exact-hash',
    });
    expect(second.text).toContain('"contentStatus":"duplicate-reference"');
    expect(second.record.observedTokenEstimate).toBeLessThan(
      second.record.rawTokenEstimate,
    );
  });

  it('computes but never substitutes a reduction under the raw policy', async () => {
    const { interceptor } = await createHarness('raw');

    await interceptor.intercept(readInvocation('call-1'), {
      bytes: bytesOf(FILE_TEXT),
      isError: false,
    });
    const second = await interceptor.intercept(readInvocation('call-2'), {
      bytes: bytesOf(FILE_TEXT),
      isError: false,
    });

    expect(second.text).toBe(FILE_TEXT);
    expect(second.record).toMatchObject({
      policy: 'raw',
      mode: 'raw',
      reductionOutcome: 'not-requested',
      // The baseline still measures what the managed condition would have done.
      reductionUsable: true,
    });
    expect(second.record.reducedTokenEstimate).toBeLessThan(
      second.record.rawTokenEstimate,
    );
    expect(second.record.observedTokenEstimate).toBe(
      second.record.rawTokenEstimate,
    );
  });

  it('restores the raw observation byte-for-byte after it leaves the transcript', async () => {
    const { interceptor, artifacts } = await createHarness('reduced');

    await interceptor.intercept(readInvocation('call-1'), {
      bytes: bytesOf(FILE_TEXT),
      isError: false,
    });
    const second = await interceptor.intercept(readInvocation('call-2'), {
      bytes: bytesOf(FILE_TEXT),
      isError: false,
    });

    const uri = second.record.evidence?.rawArtifactUri;
    expect(uri).toBeDefined();
    const restored = await readStream(await artifacts.open(uri!));
    expect(restored.toString('utf8')).toBe(FILE_TEXT);
    await expect(artifacts.verify(uri!)).resolves.toMatchObject({
      byteLength: Buffer.byteLength(FILE_TEXT, 'utf8'),
    });
  });

  it('reduces a complete ripgrep search result', async () => {
    const { interceptor } = await createHarness('reduced');
    const raw = ripgrepJson(10);

    const result = await interceptor.intercept(
      {
        toolCallId: 'call-1',
        toolName: 'grep',
        input: { pattern: 'value', path: 'src' },
      },
      { bytes: bytesOf(raw), isError: false, exitCode: 0 },
    );

    expect(result.record).toMatchObject({
      mode: 'reduced',
      reductionOutcome: 'applied',
      reducerId: 'search-result/ripgrep-json',
    });
    expect(result.record.observedTokenEstimate).toBeLessThan(
      result.record.rawTokenEstimate,
    );
    expect(result.text).toContain('"matchCount":10');
  });

  it('passes an unclassified tool through and records only its evidence', async () => {
    const { interceptor } = await createHarness('reduced');

    const result = await interceptor.intercept(
      { toolCallId: 'call-1', toolName: 'glob', input: { pattern: '**/*.ts' } },
      { bytes: bytesOf('src/index.ts\nsrc/app.ts\n'), isError: false },
    );

    expect(result.text).toBe('src/index.ts\nsrc/app.ts\n');
    expect(result.record).toMatchObject({
      mode: 'raw',
      reductionOutcome: 'no-reducer',
    });
    expect(result.record.reducedTokenEstimate).toBeUndefined();
    // Evidence is still stored; only the typed event is absent.
    expect(result.record.evidence?.rawArtifactUri).toMatch(/^artifact:\/\//u);
    expect(result.record.evidence?.eventId).toBeUndefined();
  });

  it('describes non-UTF-8 output instead of emitting damaged text', async () => {
    const { interceptor } = await createHarness('reduced');

    const result = await interceptor.intercept(
      {
        toolCallId: 'call-1',
        toolName: 'bash',
        input: { command: 'cat a.bin' },
      },
      {
        bytes: new Uint8Array([0xff, 0xfe, 0x00, 0x80, 0x81]),
        isError: false,
        exitCode: 0,
      },
    );

    expect(result.record).toMatchObject({
      mode: 'binary-reference',
      reductionOutcome: 'binary-output',
      rawByteLength: 5,
    });
    expect(result.text).toContain('5 bytes of non-UTF-8 output');
    expect(result.text).toContain(result.record.evidence!.rawArtifactUri);
    expect(result.text).not.toContain('�');
  });

  it('bounds an oversized observation on a code-point boundary and says so', async () => {
    const { interceptor } = await createHarness('reduced', {
      maxObservationBytes: 1024,
    });
    // Three bytes per character, so the 1024-byte bound lands mid-character.
    const raw = '€'.repeat(1000);

    const result = await interceptor.intercept(
      { toolCallId: 'call-1', toolName: 'glob', input: { pattern: '*' } },
      { bytes: bytesOf(raw), isError: false },
    );

    expect(result.record.mode).toBe('raw-truncated');
    expect(result.text).not.toContain('�');
    expect(result.text.startsWith('€'.repeat(341))).toBe(true);
    expect(result.text).toContain('bytes withheld');
    expect(result.text).toContain(result.record.evidence!.rawArtifactUri);
    expect(result.record.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'OBSERVATION_TRUNCATED' }),
    );
  });

  it('refuses a reduction that would cost more than the observation it replaces', async () => {
    const { interceptor } = await createHarness('reduced');
    const tiny = 'ok\n';

    await interceptor.intercept(readInvocation('call-1', 'src/tiny.ts'), {
      bytes: bytesOf(tiny),
      isError: false,
    });
    const second = await interceptor.intercept(
      readInvocation('call-2', 'src/tiny.ts'),
      { bytes: bytesOf(tiny), isError: false },
    );

    expect(second.text).toBe(tiny);
    expect(second.record).toMatchObject({
      mode: 'raw',
      reductionOutcome: 'not-smaller',
      reductionUsable: false,
    });
    expect(second.record.reducedTokenEstimate).toBeGreaterThanOrEqual(
      second.record.rawTokenEstimate,
    );
  });

  it('never reduces when raw evidence could not be stored', async () => {
    const failing: ArtifactStore = {
      put: () => Promise.reject(new Error('disk is full')),
      open: () => Promise.reject(new Error('unavailable')),
      verify: () => Promise.reject(new Error('unavailable')),
      restore: () => Promise.reject(new Error('unavailable')),
    };
    const { interceptor } = await createHarness('reduced', {
      artifacts: failing,
    });

    const result = await interceptor.intercept(readInvocation('call-1'), {
      bytes: bytesOf(FILE_TEXT),
      isError: false,
    });

    expect(result.text).toBe(FILE_TEXT);
    expect(result.record).toMatchObject({
      mode: 'raw',
      reductionOutcome: 'raw-evidence-unavailable',
    });
    expect(result.record.evidence).toBeUndefined();
    expect(result.record.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'ARTIFACT_STORE_FAILED' }),
    );
  });

  it('degrades to the raw observation when a classifier throws', async () => {
    const exploding: ObservationClassifier = {
      id: 'exploding',
      classify(): ObservationClassification {
        throw new Error('classifier is broken');
      },
    };
    const { interceptor } = await createHarness('reduced', {
      classifiers: [exploding],
    });

    const result = await interceptor.intercept(readInvocation('call-1'), {
      bytes: bytesOf(FILE_TEXT),
      isError: false,
    });

    expect(result.text).toBe(FILE_TEXT);
    expect(result.record.reductionOutcome).toBe('failed');
    expect(result.record.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'CLASSIFIER_FAILED' }),
    );
  });

  it('degrades to the raw observation when a reducer rejects its payload', async () => {
    const malformed: ObservationClassifier = {
      id: 'malformed',
      classify(_input: ClassifierInput): ObservationClassification {
        // A payload the reducer must refuse, exercising the fault path rather
        // than any particular parser bug.
        return {
          kind: 'test_result',
          payload: { schemaVersion: 1 },
        } as unknown as ObservationClassification;
      },
    };
    const { interceptor } = await createHarness('reduced', {
      classifiers: [malformed],
    });

    const result = await interceptor.intercept(readInvocation('call-1'), {
      bytes: bytesOf(FILE_TEXT),
      isError: false,
    });

    expect(result.text).toBe(FILE_TEXT);
    expect(result.record.reductionOutcome).toBe('failed');
    expect(result.record.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'REDUCER_FAILED' }),
    );
  });

  it('serializes concurrent identical reads so exactly one becomes the reference', async () => {
    const { interceptor } = await createHarness('reduced');

    const results = await Promise.all([
      interceptor.intercept(readInvocation('call-1'), {
        bytes: bytesOf(FILE_TEXT),
        isError: false,
      }),
      interceptor.intercept(readInvocation('call-2'), {
        bytes: bytesOf(FILE_TEXT),
        isError: false,
      }),
    ]);

    const outcomes = results.map((result) => result.record.reductionOutcome);
    expect(outcomes).toEqual(['unsafe', 'applied']);
  });

  it('marks an observation that arrived after cancellation without discarding it', async () => {
    const { interceptor } = await createHarness('reduced');
    const controller = new AbortController();
    controller.abort();

    const result = await interceptor.intercept(
      readInvocation('call-1'),
      { bytes: bytesOf(FILE_TEXT), isError: false },
      { abortSignal: controller.signal },
    );

    expect(result.text).toBe(FILE_TEXT);
    expect(result.record.evidence?.rawArtifactUri).toBeDefined();
    expect(result.record.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'OBSERVATION_DURING_ABORT' }),
    );
  });

  it('preserves the tool error flag through interception', async () => {
    const { interceptor } = await createHarness('reduced');

    const result = await interceptor.intercept(
      { toolCallId: 'call-1', toolName: 'bash', input: { command: 'false' } },
      { bytes: bytesOf('command failed\n'), isError: true, exitCode: 1 },
    );

    expect(result.isError).toBe(true);
    expect(result.record.mode).toBe('raw');
  });

  it('rejects an observation bound too small to hold a code point', async () => {
    await expect(
      createHarness('reduced', { maxObservationBytes: 3 }),
    ).rejects.toThrow(RangeError);
  });
});

describe('artifact deduplication', () => {
  it('reuses stored evidence for identical observations', async () => {
    const { interceptor } = await createHarness('reduced');

    const first = await interceptor.intercept(readInvocation('call-1'), {
      bytes: bytesOf(FILE_TEXT),
      isError: false,
    });
    const second = await interceptor.intercept(readInvocation('call-2'), {
      bytes: bytesOf(FILE_TEXT),
      isError: false,
    });

    const firstEvidence = first.record.evidence as { rawArtifactUri: string };
    const secondEvidence = second.record.evidence as { rawArtifactUri: string };
    expect(secondEvidence.rawArtifactUri).toBe(firstEvidence.rawArtifactUri);
  });
});

describe('StoredArtifact contract', () => {
  it('reports the digest the reduction cites as evidence', async () => {
    const { interceptor, artifacts } = await createHarness('reduced');

    const result = await interceptor.intercept(
      { toolCallId: 'call-1', toolName: 'glob', input: { pattern: '*' } },
      { bytes: bytesOf('a\n'), isError: false },
    );

    const evidence = result.record.evidence!;
    const verified: StoredArtifact = await artifacts.verify(
      evidence.rawArtifactUri,
    );
    expect(verified.digest).toBe(evidence.contentHash);
    expect(verified.byteLength).toBe(evidence.byteLength);
  });
});

describe('durable-record failures', () => {
  /** Keeps the real store's behavior while making one method fail. */
  function brokenMetadata(
    real: SqliteMetadataStore,
    overrides: Partial<MetadataStore>,
  ): MetadataStore {
    return Object.assign(Object.create(real) as MetadataStore, overrides);
  }

  it('does not reduce when the typed event cannot be recorded', async () => {
    const { metadata } = await createHarness('reduced');
    const root = await mkdtemp(join(tmpdir(), 'acm-observation-'));
    temporaryDirectories.push(root);
    const interceptor = new RecordingObservationInterceptor({
      sessionId: SESSION_ID,
      policy: 'reduced',
      artifacts: new LocalArtifactStore(join(root, 'artifacts')),
      metadata: brokenMetadata(metadata, {
        recordObservationReduction: () => {
          throw new Error('the events table is locked');
        },
      }),
      workingDirectory: WORKING_DIRECTORY,
      generateUuid: uuidSequence(),
    });

    const result = await interceptor.intercept(readInvocation('call-1'), {
      bytes: bytesOf(FILE_TEXT),
      isError: false,
    });

    expect(result.text).toBe(FILE_TEXT);
    expect(result.record.reductionOutcome).toBe('raw-evidence-unavailable');
    expect(result.record.evidence?.eventId).toBeUndefined();
    expect(result.record.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'EVENT_RECORD_FAILED' }),
    );
  });

  it('does not reduce when the observation session cannot be opened', async () => {
    const { metadata } = await createHarness('reduced');
    const root = await mkdtemp(join(tmpdir(), 'acm-observation-'));
    temporaryDirectories.push(root);
    const interceptor = new RecordingObservationInterceptor({
      sessionId: SESSION_ID,
      policy: 'reduced',
      artifacts: new LocalArtifactStore(join(root, 'artifacts')),
      metadata: brokenMetadata(metadata, {
        sessionExists: () => false,
        createSession: () => {
          throw new Error('the sessions table is locked');
        },
      }),
      workingDirectory: WORKING_DIRECTORY,
      generateUuid: uuidSequence(),
    });

    const result = await interceptor.intercept(readInvocation('call-1'), {
      bytes: bytesOf(FILE_TEXT),
      isError: false,
    });

    expect(result.text).toBe(FILE_TEXT);
    expect(result.record.reductionOutcome).toBe('raw-evidence-unavailable');
    expect(result.record.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'SESSION_RECORD_FAILED' }),
    );
  });
});
