import { execFile } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';

import { canonicalJson } from '@acm/core';
import { afterEach, describe, expect, it } from 'vitest';

import type { RecordReductionInput, StoredArtifact } from './contracts.js';
import { SessionNotFoundError, SqliteMetadataStore } from './index.js';

const SESSION_ID = 'ses_11111111111141118111111111111111';
const EVENT_1 = 'evt_11111111111141118111111111111111';
const EVENT_2 = 'evt_22222222222242228222222222222222';
const DIGEST = 'a'.repeat(64);
const NOW = '2026-08-18T12:00:00.000Z';
const temporaryDirectories: string[] = [];
const execFileAsync = promisify(execFile);

async function databasePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'acm-metadata-test-'));
  temporaryDirectories.push(directory);
  return join(directory, 'acm.sqlite3');
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

const artifact: StoredArtifact = {
  uri: `artifact://sha256/${DIGEST}`,
  algorithm: 'sha256',
  digest: DIGEST,
  byteLength: 12,
  reused: false,
};

function reductionInput(
  eventId: typeof EVENT_1 | typeof EVENT_2,
): RecordReductionInput {
  return {
    eventId,
    sessionId: SESSION_ID,
    eventCreatedAt: NOW,
    payload: {
      schemaVersion: 1,
      framework: 'vitest',
      sourceFormat: 'vitest-json',
      reportedCounts: { total: 1, passed: 1, failed: 0 },
      observedCounts: { total: 1, passed: 1, failed: 0, skipped: 0, todo: 0 },
      failures: [],
      diagnostics: [],
      parseStatus: 'complete',
    },
    artifact,
    reduction: {
      reducerId: 'test-result/vitest-json',
      reducerVersion: '1.0.0',
      reducedText: canonicalJson({
        schemaVersion: 1,
        kind: 'test-result',
        framework: 'vitest',
        reportedCounts: { total: 1, passed: 1, failed: 0 },
        observedCounts: { total: 1, passed: 1, failed: 0, skipped: 0, todo: 0 },
        failures: [],
        diagnostics: [],
        evidence: {
          rawArtifactUri: artifact.uri,
          contentHash: artifact.digest,
          byteLength: artifact.byteLength,
        },
        safeForContext: true,
      }),
      safeForContext: true,
      originalTokenEstimate: 3,
      reducedTokenEstimate: 7,
      tokenEstimatorId: 'utf8-bytes-div-4@1',
      preservedFields: ['/reportedCounts'],
      diagnostics: [],
    },
    reductionCreatedAt: NOW,
  };
}

describe('SqliteMetadataStore', () => {
  it('migrates an empty database, records monotonic events, and reopens them', async () => {
    const path = await databasePath();
    let store = new SqliteMetadataStore(path);
    store.createSession({ id: SESSION_ID, createdAt: NOW });
    expect(store.recordReduction(reductionInput(EVENT_1)).event.sequence).toBe(
      1,
    );
    expect(store.recordReduction(reductionInput(EVENT_2)).event.sequence).toBe(
      2,
    );
    store.close();

    store = new SqliteMetadataStore(path);
    const recorded = store.getEvent(EVENT_2);
    expect(recorded?.event).toMatchObject({
      id: EVENT_2,
      sequence: 2,
      rawArtifactUri: artifact.uri,
    });
    expect(recorded?.reduction).toMatchObject({
      reducerId: 'test-result/vitest-json',
      safeForContext: true,
      preservedFields: ['/reportedCounts'],
    });
    store.close();
  });

  it('enforces session foreign keys and rolls failed records back', async () => {
    const path = await databasePath();
    const store = new SqliteMetadataStore(path);
    expect(() => store.recordReduction(reductionInput(EVENT_1))).toThrow(
      SessionNotFoundError,
    );
    store.createSession({ id: SESSION_ID, createdAt: NOW });
    expect(store.recordReduction(reductionInput(EVENT_1)).event.sequence).toBe(
      1,
    );
    expect(() => store.recordReduction(reductionInput(EVENT_1))).toThrow();
    expect(store.recordReduction(reductionInput(EVENT_2)).event.sequence).toBe(
      2,
    );
    store.close();
  });

  it('deduplicates matching artifact metadata and rejects conflicts', async () => {
    const path = await databasePath();
    const store = new SqliteMetadataStore(path);
    store.createSession({ id: SESSION_ID, createdAt: NOW });
    store.recordReduction(reductionInput(EVENT_1));
    expect(store.recordReduction(reductionInput(EVENT_2)).event.sequence).toBe(
      2,
    );

    const conflicting = reductionInput(
      'evt_33333333333343338333333333333333' as typeof EVENT_1,
    );
    conflicting.artifact = { ...artifact, byteLength: 99 };
    const conflictingReducedValue = JSON.parse(
      conflicting.reduction.reducedText,
    ) as { evidence: { byteLength: number } };
    conflictingReducedValue.evidence.byteLength = 99;
    conflicting.reduction = {
      ...conflicting.reduction,
      reducedText: canonicalJson(conflictingReducedValue),
    };
    expect(() => store.recordReduction(conflicting)).toThrow(
      'Artifact metadata conflict',
    );
    store.close();
  });

  it('validates JSON columns on write and read', async () => {
    const path = await databasePath();
    let store = new SqliteMetadataStore(path);
    store.createSession({ id: SESSION_ID, createdAt: NOW });
    const invalid = reductionInput(EVENT_1);
    invalid.reduction = { ...invalid.reduction, reducedText: '{}' };
    expect(() => store.recordReduction(invalid)).toThrow();
    expect(store.recordReduction(reductionInput(EVENT_1)).event.sequence).toBe(
      1,
    );
    store.close();

    const database = new DatabaseSync(path);
    database
      .prepare('UPDATE events SET payload_json = ? WHERE id = ?')
      .run('{', EVENT_1);
    database.close();

    store = new SqliteMetadataStore(path);
    expect(() => store.getEvent(EVENT_1)).toThrow('invalid JSON');
    store.close();
  });

  it('rejects reductions that contradict their payload or artifact evidence', async () => {
    const path = await databasePath();
    const store = new SqliteMetadataStore(path);
    store.createSession({ id: SESSION_ID, createdAt: NOW });
    const inconsistent = reductionInput(EVENT_1);
    const reducedValue = JSON.parse(inconsistent.reduction.reducedText) as {
      safeForContext: boolean;
      evidence: { contentHash: string; rawArtifactUri: string };
    };
    reducedValue.safeForContext = false;
    reducedValue.evidence.contentHash = 'b'.repeat(64);
    reducedValue.evidence.rawArtifactUri = `artifact://sha256/${'b'.repeat(64)}`;
    inconsistent.reduction = {
      ...inconsistent.reduction,
      reducedText: canonicalJson(reducedValue),
    };

    expect(() => store.recordReduction(inconsistent)).toThrow(
      'does not match its source payload',
    );
    expect(store.recordReduction(reductionInput(EVENT_1)).event.sequence).toBe(
      1,
    );
    store.close();
  });

  it('rejects cross-record inconsistencies when reopening persisted data', async () => {
    const path = await databasePath();
    let store = new SqliteMetadataStore(path);
    store.createSession({ id: SESSION_ID, createdAt: NOW });
    store.recordReduction(reductionInput(EVENT_1));
    store.close();

    const database = new DatabaseSync(path);
    database
      .prepare('UPDATE reductions SET safe_for_context = 0 WHERE event_id = ?')
      .run(EVENT_1);
    database.close();

    store = new SqliteMetadataStore(path);
    expect(() => store.getEvent(EVENT_1)).toThrow(
      'safety metadata does not match',
    );
    store.close();
  });

  it('serializes simultaneous first-run migrations', async () => {
    const path = await databasePath();
    const moduleUrl = new URL('../dist/index.js', import.meta.url).href;
    const script = `
      import { SqliteMetadataStore } from ${JSON.stringify(moduleUrl)};
      const store = new SqliteMetadataStore(process.argv[1]);
      store.close();
    `;

    await Promise.all(
      Array.from({ length: 4 }, () =>
        execFileAsync(process.execPath, [
          '--input-type=module',
          '--eval',
          script,
          path,
        ]),
      ),
    );

    const store = new SqliteMetadataStore(path);
    store.createSession({ id: SESSION_ID, createdAt: NOW });
    store.close();
  });

  it.runIf(process.platform !== 'win32')(
    'creates a private metadata database',
    async () => {
      const path = await databasePath();
      const store = new SqliteMetadataStore(path);
      store.close();

      expect((await stat(path)).mode & 0o777).toBe(0o600);
    },
  );
});
