import { describe, expect, it } from 'vitest';

import type { JsonValue } from '@acm/core';

import {
  FileReadClassifier,
  RipgrepJsonClassifier,
  TypescriptBuildClassifier,
  VitestJsonClassifier,
  defaultObservationClassifiers,
  type ClassifierInput,
} from './classifiers.js';

const WORKING_DIRECTORY = '/workspace/repo';

function input(
  toolName: string,
  toolInput: JsonValue,
  overrides: Partial<Pick<ClassifierInput, 'bytes' | 'exitCode'>> = {},
): ClassifierInput {
  return {
    invocation: { toolCallId: 'call-1', toolName, input: toolInput },
    bytes: overrides.bytes ?? new Uint8Array(),
    exitCode: overrides.exitCode,
    context: { workingDirectory: WORKING_DIRECTORY },
  };
}

describe('FileReadClassifier', () => {
  const classifier = new FileReadClassifier();

  it('claims read-shaped tool names regardless of casing or separator', () => {
    for (const toolName of ['read', 'Read', 'read_file', 'readFile', 'view']) {
      expect(
        classifier.classify(input(toolName, { file_path: 'src/index.ts' })),
      ).toMatchObject({ kind: 'file_read' });
    }
    expect(
      classifier.classify(input('write', { file_path: 'src/index.ts' })),
    ).toBeUndefined();
  });

  it('records a whole-file read with a repository-relative path', () => {
    expect(
      classifier.classify(input('read', { file_path: 'src/index.ts' })),
    ).toEqual({
      kind: 'file_read',
      payload: {
        schemaVersion: 1,
        path: 'src/index.ts',
        pathKind: 'repository-relative',
        scope: { kind: 'full' },
        encoding: 'utf-8',
      },
    });
  });

  it('recognizes POSIX and Windows absolute paths', () => {
    expect(
      classifier.classify(input('read', { file_path: '/workspace/a.ts' }))
        ?.payload,
    ).toMatchObject({ pathKind: 'absolute' });
    expect(
      classifier.classify(input('read', { file_path: 'C:\\workspace\\a.ts' }))
        ?.payload,
    ).toMatchObject({ pathKind: 'absolute' });
  });

  it('converts an offset and limit into a closed line range', () => {
    expect(
      classifier.classify(
        input('read', { file_path: 'src/index.ts', offset: 5, limit: 10 }),
      )?.payload,
    ).toMatchObject({ scope: { kind: 'range', startLine: 5, endLine: 14 } });
    expect(
      classifier.classify(
        input('read', { file_path: 'src/index.ts', limit: 3 }),
      )?.payload,
    ).toMatchObject({ scope: { kind: 'range', startLine: 1, endLine: 3 } });
  });

  it('leaves an open-ended range unclassified rather than inventing an end', () => {
    expect(
      classifier.classify(
        input('read', { file_path: 'src/index.ts', offset: 5 }),
      ),
    ).toBeUndefined();
  });

  it('leaves a malformed range unclassified rather than widening it', () => {
    for (const bad of [
      { offset: 0 },
      { offset: -2, limit: 3 },
      { limit: 0 },
      { offset: 1.5, limit: 2 },
      { offset: 'first', limit: 2 },
      { limit: Number.MAX_SAFE_INTEGER, offset: Number.MAX_SAFE_INTEGER },
    ]) {
      expect(
        classifier.classify(
          input('read', { file_path: 'src/index.ts', ...bad } as JsonValue),
        ),
      ).toBeUndefined();
    }
  });

  it('ignores a read without a usable path', () => {
    expect(
      classifier.classify(input('read', { file_path: '' })),
    ).toBeUndefined();
    expect(classifier.classify(input('read', {}))).toBeUndefined();
    expect(classifier.classify(input('read', 'src/index.ts'))).toBeUndefined();
  });
});

describe('RipgrepJsonClassifier', () => {
  const classifier = new RipgrepJsonClassifier();

  it('defaults the search root to the working directory', () => {
    expect(
      classifier.classify(input('grep', { pattern: 'value' }))?.payload,
    ).toMatchObject({ query: 'value', root: WORKING_DIRECTORY });
  });

  it('prefers an explicit search path', () => {
    expect(
      classifier.classify(input('grep', { pattern: 'value', path: 'src' }))
        ?.payload,
    ).toMatchObject({ root: 'src' });
  });

  it('marks unparseable output opaque instead of claiming a clean parse', () => {
    const payload = classifier.classify(
      input(
        'grep',
        { pattern: 'value' },
        {
          bytes: new Uint8Array(Buffer.from('not ripgrep json\n', 'utf8')),
        },
      ),
    )?.payload;
    expect(payload).toMatchObject({ parseStatus: 'opaque' });
  });

  it('ignores a search without a pattern', () => {
    expect(classifier.classify(input('grep', {}))).toBeUndefined();
    expect(
      classifier.classify(input('bash', { pattern: 'value' })),
    ).toBeUndefined();
  });
});

describe('VitestJsonClassifier', () => {
  const classifier = new VitestJsonClassifier();

  it('claims only a vitest run that emits the JSON reporter', () => {
    expect(
      classifier.classify(
        input('bash', { command: 'pnpm vitest run --reporter=json' }),
      ),
    ).toMatchObject({ kind: 'test_result' });
    expect(
      classifier.classify(
        input('bash', { command: 'pnpm vitest run --reporter json' }),
      ),
    ).toMatchObject({ kind: 'test_result' });
    expect(
      classifier.classify(input('bash', { command: 'pnpm vitest run' })),
    ).toBeUndefined();
    expect(
      classifier.classify(input('bash', { command: 'pnpm test' })),
    ).toBeUndefined();
  });

  it('only reads commands from shell-shaped tools', () => {
    expect(
      classifier.classify(
        input('read', { command: 'pnpm vitest run --reporter=json' }),
      ),
    ).toBeUndefined();
  });
});

describe('TypescriptBuildClassifier', () => {
  const classifier = new TypescriptBuildClassifier();
  const command = 'pnpm tsc -p tsconfig.json --pretty false';

  it('claims non-pretty tsc output with a recorded exit code', () => {
    expect(
      classifier.classify(input('bash', { command }, { exitCode: 2 })),
    ).toMatchObject({
      kind: 'build_result',
      payload: { command, workingDirectory: WORKING_DIRECTORY, exitCode: 2 },
    });
  });

  it('leaves pretty output alone because its parser cannot read it', () => {
    expect(
      classifier.classify(
        input(
          'bash',
          { command: 'pnpm tsc -p tsconfig.json' },
          { exitCode: 0 },
        ),
      ),
    ).toBeUndefined();
  });

  it('refuses to record a build without an exit code', () => {
    expect(classifier.classify(input('bash', { command }))).toBeUndefined();
  });
});

describe('defaultObservationClassifiers', () => {
  it('consults file reads before shell classifiers', () => {
    expect(defaultObservationClassifiers().map((item) => item.id)).toEqual([
      'file-read',
      'search-result',
      'test-result',
      'build-result',
    ]);
  });
});
