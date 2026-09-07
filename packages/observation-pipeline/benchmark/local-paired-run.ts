/**
 * Local paired observation run.
 *
 * Replays one realistic coding session through both observation policies and
 * reports how many tokens each one puts into the agent's transcript. It uses
 * ACM's own estimator rather than provider-reported usage, so it answers
 * whether a per-step reduction compounds — not what a provider will bill.
 *
 * Every observation is real: files from this repository, vitest reports from
 * actual runs, tsc diagnostics from an actual compile, and ripgrep-format
 * records built from actual matches.
 *
 * Run with: pnpm --filter @acm/observation-pipeline benchmark
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { createSessionId, type JsonValue } from '@acm/core';
import { LocalArtifactStore, SqliteMetadataStore } from '@acm/event-store';
import type { ObservationPolicy } from '@acm/harness-port';

import { RecordingObservationInterceptor } from '../src/interceptor.js';

const REPOSITORY_ROOT = resolve(import.meta.dirname, '../../..');
const CAPTURE = join(import.meta.dirname, 'fixtures');
const WORKING_DIRECTORY = '/workspace/repo';

type Step = {
  readonly label: string;
  readonly toolName: string;
  readonly input: JsonValue;
  readonly bytes: Uint8Array;
  readonly exitCode?: number;
};

async function repositoryFile(path: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(join(REPOSITORY_ROOT, path)));
}

async function captured(name: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(join(CAPTURE, name)));
}

function read(path: string, bytes: Uint8Array, label: string): Step {
  return {
    label,
    toolName: 'read',
    input: { file_path: path },
    bytes,
  };
}

function grep(pattern: string, bytes: Uint8Array, label: string): Step {
  return {
    label,
    toolName: 'grep',
    input: { pattern, path: 'packages' },
    bytes,
    exitCode: 0,
  };
}

function shell(
  command: string,
  bytes: Uint8Array,
  exitCode: number,
  label: string,
): Step {
  return { label, toolName: 'bash', input: { command }, bytes, exitCode };
}

/**
 * Whether a re-read returns the same bytes as the read before it.
 *
 * `identical` is the best case for exact deduplication. `edited` is the worst:
 * the agent changed the file between reads, the content hash differs, and no
 * duplicate reference is possible. A real session falls between the two, so
 * both are reported rather than one being presented as the result.
 */
type RepeatMode = 'identical' | 'edited';

function edited(bytes: Uint8Array, revision: number): Uint8Array {
  const header = Buffer.from(`// revision ${revision}\n`, 'utf8');
  return new Uint8Array(Buffer.concat([header, Buffer.from(bytes)]));
}

/**
 * A debugging session in this repository: locate a behavior, run the suite,
 * re-read the same sources while iterating, and finish once the suite passes.
 * Re-reads and repeated searches are the point — they are what a long session
 * accumulates and what a per-step reduction is supposed to remove.
 */
async function buildSession(repeats: RepeatMode): Promise<Step[]> {
  const revise = (bytes: Uint8Array, revision: number): Uint8Array =>
    repeats === 'identical' ? bytes : edited(bytes, revision);
  const reducers = await repositoryFile(
    'packages/reducers/src/phase2-reducers.ts',
  );
  const observations = await repositoryFile(
    'packages/core/src/observations.ts',
  );
  const evaluator = await repositoryFile(
    'packages/evaluation/src/evaluator.ts',
  );
  const manifest = await repositoryFile('package.json');
  const searchSafe = await captured('rg-safeforcontext.json');
  const searchReducer = await captured('rg-reducer.json');
  const failingTests = await captured('vitest-failing.json');
  const passingTests = await captured('vitest-passing.json');
  const buildErrors = await captured('tsc-errors.txt');

  const vitest = 'pnpm vitest run --reporter=json';
  const tsc = 'pnpm tsc -p tsconfig.json --pretty false';

  return [
    read('package.json', manifest, 'read package.json'),
    read(
      'packages/reducers/src/phase2-reducers.ts',
      reducers,
      'read phase2-reducers.ts',
    ),
    grep('safeForContext', searchSafe, 'search safeForContext'),
    shell(vitest, failingTests, 1, 'run tests (3 failing)'),
    read(
      'packages/reducers/src/phase2-reducers.ts',
      revise(reducers, 1),
      're-read phase2-reducers.ts',
    ),
    read(
      'packages/core/src/observations.ts',
      observations,
      'read observations.ts',
    ),
    grep('reducedText|reducerId', searchReducer, 'search reducedText'),
    shell(vitest, failingTests, 1, 'run tests (still failing)'),
    read(
      'packages/core/src/observations.ts',
      revise(observations, 1),
      're-read observations.ts',
    ),
    read(
      'packages/reducers/src/phase2-reducers.ts',
      revise(reducers, 2),
      're-read phase2-reducers.ts',
    ),
    grep('safeForContext', searchSafe, 'repeat search safeForContext'),
    shell(tsc, buildErrors, 2, 'run tsc (3 errors)'),
    read(
      'packages/evaluation/src/evaluator.ts',
      evaluator,
      'read evaluator.ts',
    ),
    shell(vitest, passingTests, 0, 'run tests (passing)'),
  ];
}

type StepResult = {
  readonly label: string;
  readonly tokens: number;
  readonly outcome: string;
  readonly mode: string;
};

async function runPolicy(
  policy: ObservationPolicy,
  steps: readonly Step[],
): Promise<{ results: StepResult[]; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), `acm-bench-${policy}-`));
  const metadata = new SqliteMetadataStore(join(root, 'acm.sqlite3'));
  const interceptor = new RecordingObservationInterceptor({
    sessionId: createSessionId(),
    policy,
    artifacts: new LocalArtifactStore(join(root, 'artifacts')),
    metadata,
    workingDirectory: WORKING_DIRECTORY,
  });

  const results: StepResult[] = [];
  for (const [index, step] of steps.entries()) {
    const observed = await interceptor.intercept(
      {
        toolCallId: `call-${index + 1}`,
        toolName: step.toolName,
        input: step.input,
      },
      {
        bytes: step.bytes,
        isError: (step.exitCode ?? 0) !== 0,
        ...(step.exitCode === undefined ? {} : { exitCode: step.exitCode }),
      },
    );
    results.push({
      label: step.label,
      tokens: observed.record.observedTokenEstimate,
      outcome: observed.record.reductionOutcome,
      mode: observed.record.mode,
    });
  }

  return {
    results,
    cleanup: async () => {
      metadata.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

/**
 * Tokens an observation set contributes across a whole session.
 *
 * Observation `j` is present in the transcript for every request after it, so
 * it is paid for `stepCount + 1 - j` times. This weighting is what a turn total
 * cannot show and what makes a per-step reduction compound.
 */
function sessionObservationTokens(tokens: readonly number[]): number {
  const requests = tokens.length + 1;
  return tokens.reduce(
    (total, value, index) => total + value * (requests - (index + 1)),
    0,
  );
}

function percent(raw: number, managed: number): string {
  return raw === 0 ? 'n/a' : `${(((raw - managed) / raw) * 100).toFixed(1)}%`;
}

function pad(value: string, width: number): string {
  return value.padEnd(width);
}

function padStart(value: string | number, width: number): string {
  return String(value).padStart(width);
}

type Summary = {
  readonly produced: { raw: number; reduced: number };
  readonly paidFor: { raw: number; reduced: number };
};

async function measure(repeats: RepeatMode): Promise<Summary> {
  const steps = await buildSession(repeats);
  const raw = await runPolicy('raw', steps);
  const reduced = await runPolicy('reduced', steps);
  try {
    const rawTokens = raw.results.map((step) => step.tokens);
    const managedTokens = reduced.results.map((step) => step.tokens);
    return {
      produced: { raw: sum(rawTokens), reduced: sum(managedTokens) },
      paidFor: {
        raw: sessionObservationTokens(rawTokens),
        reduced: sessionObservationTokens(managedTokens),
      },
    };
  } finally {
    await raw.cleanup();
    await reduced.cleanup();
  }
}

async function main(): Promise<void> {
  const steps = await buildSession('identical');
  const raw = await runPolicy('raw', steps);
  const reduced = await runPolicy('reduced', steps);

  try {
    console.log('\nPer-step observation tokens (ACM estimator)\n');
    console.log(
      `${pad('#', 3)}${pad('observation', 32)}${padStart('raw', 8)}${padStart('reduced', 9)}${padStart('saved', 8)}  outcome`,
    );
    console.log('-'.repeat(78));
    for (const [index, rawStep] of raw.results.entries()) {
      const managedStep = reduced.results[index]!;
      const saved = rawStep.tokens - managedStep.tokens;
      console.log(
        `${pad(String(index + 1), 3)}${pad(rawStep.label, 32)}` +
          `${padStart(rawStep.tokens, 8)}${padStart(managedStep.tokens, 9)}` +
          `${padStart(saved === 0 ? '-' : saved, 8)}  ${managedStep.outcome}`,
      );
    }

    const rawTokens = raw.results.map((step) => step.tokens);
    const managedTokens = reduced.results.map((step) => step.tokens);
    const rawTotal = sum(rawTokens);
    const managedTotal = sum(managedTokens);
    const rawSession = sessionObservationTokens(rawTokens);
    const managedSession = sessionObservationTokens(managedTokens);

    console.log('-'.repeat(78));
    console.log(
      `${pad('', 3)}${pad('observation tokens produced', 32)}${padStart(rawTotal, 8)}${padStart(managedTotal, 9)}${padStart(rawTotal - managedTotal, 8)}  ${percent(rawTotal, managedTotal)}`,
    );
    console.log(
      `${pad('', 3)}${pad('observation tokens paid for', 32)}${padStart(rawSession, 8)}${padStart(managedSession, 9)}${padStart(rawSession - managedSession, 8)}  ${percent(rawSession, managedSession)}`,
    );

    console.log(
      '\n"Produced" counts each observation once. "Paid for" counts it in every',
    );
    console.log(
      `request that follows it, across ${steps.length + 1} model requests.\n`,
    );

    console.log('Session input tokens, by assumed per-request preamble\n');
    console.log(
      `${pad('preamble', 12)}${padStart('raw', 12)}${padStart('reduced', 12)}${padStart('saved', 10)}${padStart('reduction', 12)}`,
    );
    console.log('-'.repeat(58));
    const requests = steps.length + 1;
    for (const preamble of [4000, 8000, 12000, 16000]) {
      const fixed = preamble * requests;
      const rawInput = fixed + rawSession;
      const managedInput = fixed + managedSession;
      console.log(
        `${pad(String(preamble), 12)}${padStart(rawInput, 12)}${padStart(managedInput, 12)}` +
          `${padStart(rawInput - managedInput, 10)}${padStart(percent(rawInput, managedInput), 12)}`,
      );
    }
    console.log(
      '\nThe preamble is the harness system prompt and tool schemas, which ACM',
    );
    console.log(
      'does not touch. It is an assumption here; the rows show its effect.\n',
    );

    const editedRun = await measure('edited');
    console.log('Bounds on the session saving\n');
    console.log(
      `${pad('re-reads', 22)}${padStart('raw', 10)}${padStart('reduced', 10)}${padStart('reduction', 12)}`,
    );
    console.log('-'.repeat(54));
    console.log(
      `${pad('identical bytes', 22)}${padStart(rawSession, 10)}${padStart(managedSession, 10)}${padStart(percent(rawSession, managedSession), 12)}`,
    );
    console.log(
      `${pad('edited between reads', 22)}${padStart(editedRun.paidFor.raw, 10)}${padStart(editedRun.paidFor.reduced, 10)}${padStart(percent(editedRun.paidFor.raw, editedRun.paidFor.reduced), 12)}`,
    );
    console.log(
      '\nDeduplication needs byte-identical repeats. The second row is the floor:',
    );
    console.log(
      'the agent edited every file between reads, so no duplicate reference is',
    );
    console.log('possible and only searches and test output reduce.\n');

    const gates = new Map<string, number>();
    for (const step of reduced.results) {
      gates.set(step.outcome, (gates.get(step.outcome) ?? 0) + 1);
    }
    console.log('Reduction outcomes under the reduced policy\n');
    for (const [outcome, count] of [...gates].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${pad(outcome, 28)}${count}`);
    }
    console.log('');
  } finally {
    await raw.cleanup();
    await reduced.cleanup();
  }
}

await main();
