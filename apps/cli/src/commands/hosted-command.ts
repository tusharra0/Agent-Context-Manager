import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import {
  open,
  readFile,
  rename,
  rm,
  writeFile,
  type FileHandle,
} from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { loadEnvFile } from 'node:process';
import { Readable } from 'node:stream';
import { TextDecoder } from 'node:util';

import { canonicalJson } from '@acm/core';
import {
  HostedEvaluationPlanV1Schema,
  SanitizedDashboardDatasetV1Schema,
  prepareHostedEvaluationPlan,
  runHostedEvaluationPlan,
  sanitizeEvaluationResult,
  upsertSanitizedExperiment,
  type SanitizedDashboardDatasetV1,
  type HostedConditionRunnerPort,
} from '@acm/hosted-evaluation';
import { LocalArtifactStore } from '@acm/event-store';
import { TOKEN_ESTIMATOR_ID, estimateTokens } from '@acm/reducers';
import { VercelHostedConditionRunner } from '@acm/vercel-harness';

import {
  UsageError,
  rejectUnknownOptions,
  stringOption,
} from '../arguments.js';
import type { CliIo, CliRuntime } from '../cli-context.js';
import { requirePositionals } from '../command-options.js';
import { resolveStorageConfiguration } from '../configuration.js';

const ESTIMATOR = { id: TOKEN_ESTIMATOR_ID, estimate: estimateTokens } as const;

export interface HostedCommandDependencies {
  createRunner(): HostedConditionRunnerPort;
  loadEnvironment(): void;
}

const DEFAULT_DEPENDENCIES: HostedCommandDependencies = {
  createRunner: () => new VercelHostedConditionRunner(),
  loadEnvironment: loadLocalVercelEnvironment,
};

async function readJson(path: string, label: string): Promise<unknown> {
  const bytes = await readFile(path);
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    throw new UsageError(`${label} must be valid UTF-8.`, { cause: error });
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new UsageError(`${label} must be valid JSON.`, { cause: error });
  }
}

async function readDashboardDataset(
  path: string,
  now: Date,
): Promise<SanitizedDashboardDatasetV1> {
  try {
    return SanitizedDashboardDatasetV1Schema.parse(
      await readJson(path, 'Dashboard dataset'),
    );
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return {
        schemaVersion: 1,
        generatedAt: now.toISOString(),
        experiments: [],
      };
    }
    throw error;
  }
}

async function replacePrivateFile(
  path: string,
  content: string,
): Promise<void> {
  const target = resolve(path);
  const temporary = resolve(
    dirname(target),
    `.${process.pid}.${randomUUID()}.tmp`,
  );
  await writeFile(temporary, content, { flag: 'wx', mode: 0o600 });
  try {
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function reservePrivateFile(path: string): Promise<FileHandle> {
  return open(resolve(path), 'wx', 0o600);
}

async function writeReservedFile(
  handle: FileHandle,
  content: string,
): Promise<void> {
  await handle.truncate(0);
  await handle.writeFile(content, { encoding: 'utf8' });
  await handle.sync();
}

async function removeReservation(
  handle: FileHandle | undefined,
  path: string | undefined,
): Promise<void> {
  if (handle === undefined || path === undefined) return;
  await handle.close().catch(() => undefined);
  await rm(resolve(path), { force: true }).catch(() => undefined);
}

async function verifyReplaceDestination(path: string): Promise<void> {
  const target = resolve(path);
  const probe = resolve(
    dirname(target),
    `.${process.pid}.${randomUUID()}.probe`,
  );
  const handle = await open(probe, 'wx', 0o600);
  await handle.close();
  await rm(probe, { force: true });
}

export function findLocalVercelEnvironmentFile(
  startDirectory: string,
): string | undefined {
  let directory = resolve(startDirectory);
  const direct = join(directory, '.env.local');
  if (existsSync(direct)) return direct;

  while (true) {
    if (existsSync(join(directory, 'pnpm-workspace.yaml'))) {
      const workspaceEnvironment = join(directory, '.env.local');
      return existsSync(workspaceEnvironment)
        ? workspaceEnvironment
        : undefined;
    }
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

function loadLocalVercelEnvironment(): void {
  if (process.env.VERCEL_OIDC_TOKEN) return;
  const path = findLocalVercelEnvironmentFile(process.cwd());
  if (path) loadEnvFile(path);
}

export async function hostedCommand(
  positionals: readonly string[],
  options: ReadonlyMap<string, string | true>,
  runtime: CliRuntime,
  io: CliIo,
  dependencies: HostedCommandDependencies = DEFAULT_DEPENDENCIES,
): Promise<number> {
  const [operation] = positionals;
  if (operation === 'validate') {
    requirePositionals(
      positionals,
      2,
      'hosted validate requires a plan JSON path.',
    );
    rejectUnknownOptions(options, []);
    const parsedPlan = HostedEvaluationPlanV1Schema.parse(
      await readJson(positionals[1]!, 'Hosted evaluation plan'),
    );
    const { plan } = await prepareHostedEvaluationPlan(parsedPlan, ESTIMATOR);
    io.stdout(
      canonicalJson({
        valid: true,
        experimentId: plan.experiment.id,
        fixtureId: plan.fixture.id,
        caseCount: plan.experiment.cases.length,
        harness: plan.harness,
        model: plan.model,
      }),
    );
    return 0;
  }
  if (operation === 'run') {
    requirePositionals(positionals, 2, 'hosted run requires a plan JSON path.');
    rejectUnknownOptions(options, [
      'output',
      'summary',
      'dashboard-data',
      'trace',
      'data-dir',
    ]);
    const outputPath = stringOption(options, 'output', true)!;
    const summaryPath = stringOption(options, 'summary');
    const dashboardPath = stringOption(options, 'dashboard-data');
    const tracePath =
      stringOption(options, 'trace') ?? `${outputPath}.trace.jsonl`;
    const dataDirectory = stringOption(options, 'data-dir');
    const paths = [outputPath, summaryPath, dashboardPath, tracePath].filter(
      (path): path is string => path !== undefined,
    );
    if (new Set(paths.map((path) => resolve(path))).size !== paths.length) {
      throw new UsageError('Hosted output paths must be different.');
    }

    const parsedPlan = HostedEvaluationPlanV1Schema.parse(
      await readJson(positionals[1]!, 'Hosted evaluation plan'),
    );
    const { plan } = await prepareHostedEvaluationPlan(parsedPlan, ESTIMATOR);
    const createdAt = runtime.now();
    const existingDashboard = dashboardPath
      ? await readDashboardDataset(dashboardPath, createdAt)
      : undefined;
    if (dashboardPath) await verifyReplaceDestination(dashboardPath);

    let outputHandle: FileHandle | undefined;
    let summaryHandle: FileHandle | undefined;
    let traceHandle: FileHandle | undefined;
    let resultWritten = false;
    try {
      outputHandle = await reservePrivateFile(outputPath);
      traceHandle = await reservePrivateFile(tracePath);
      if (summaryPath) summaryHandle = await reservePrivateFile(summaryPath);
    } catch (error) {
      await removeReservation(outputHandle, outputPath);
      await removeReservation(traceHandle, tracePath);
      await removeReservation(summaryHandle, summaryPath);
      throw error;
    }

    try {
      dependencies.loadEnvironment();
      const storage = resolveStorageConfiguration(
        dataDirectory,
        runtime.environment,
      );
      const artifactStore = new LocalArtifactStore(storage.artifactRoot);
      const result = await runHostedEvaluationPlan(
        plan,
        dependencies.createRunner(),
        ESTIMATOR,
        {
          onRecord: async (record) => {
            await traceHandle!.appendFile(`${canonicalJson(record)}\n`, 'utf8');
            await traceHandle!.sync();
          },
          persistArtifact: async (rawText) => {
            const stored = await artifactStore.put(
              Readable.from([Buffer.from(rawText, 'utf8')]),
            );
            return {
              uri: stored.uri,
              digest: stored.digest,
              byteLength: stored.byteLength,
            };
          },
        },
      );
      await writeReservedFile(outputHandle, canonicalJson(result));
      resultWritten = true;
      io.stdout(`Wrote private hosted evaluation result to ${outputPath}`);

      const summary = sanitizeEvaluationResult(result, plan, createdAt);
      if (summaryHandle && summaryPath) {
        await writeReservedFile(summaryHandle, canonicalJson(summary));
        io.stdout(
          `Wrote sanitized hosted evaluation summary to ${summaryPath}`,
        );
      }
      if (dashboardPath && existingDashboard) {
        const dataset = upsertSanitizedExperiment(
          existingDashboard,
          summary,
          createdAt,
        );
        await replacePrivateFile(dashboardPath, canonicalJson(dataset));
        io.stdout(`Updated sanitized dashboard data at ${dashboardPath}`);
      }
      await traceHandle.sync();
      return result.status === 'pass' ? 0 : 2;
    } catch (error) {
      if (!resultWritten) {
        await writeReservedFile(
          outputHandle,
          canonicalJson({
            schemaVersion: 1,
            status: 'error',
            experimentId: plan.experiment.id,
            tracePath: resolve(tracePath),
            message: error instanceof Error ? error.message : String(error),
          }),
        ).catch(() => undefined);
        await removeReservation(summaryHandle, summaryPath);
        summaryHandle = undefined;
      }
      throw error;
    } finally {
      await outputHandle.close().catch(() => undefined);
      await traceHandle.close().catch(() => undefined);
      await summaryHandle?.close().catch(() => undefined);
    }
  }
  throw new UsageError('hosted requires either validate or run.');
}
