import { randomUUID } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { loadEnvFile } from 'node:process';
import { TextDecoder } from 'node:util';

import { canonicalJson } from '@acm/core';
import {
  HostedEvaluationPlanV1Schema,
  SanitizedDashboardDatasetV1Schema,
  runHostedEvaluationPlan,
  sanitizeEvaluationResult,
  upsertSanitizedExperiment,
  type SanitizedDashboardDatasetV1,
} from '@acm/hosted-evaluation';
import { TOKEN_ESTIMATOR_ID, estimateTokens } from '@acm/reducers';
import { VercelHostedConditionRunner } from '@acm/vercel-harness';

import {
  UsageError,
  rejectUnknownOptions,
  stringOption,
} from '../arguments.js';
import type { CliIo, CliRuntime } from '../cli-context.js';
import { requirePositionals } from '../command-options.js';

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

function loadLocalVercelEnvironment(): void {
  if (process.env.VERCEL_OIDC_TOKEN) return;
  try {
    loadEnvFile(resolve('.env.local'));
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return;
    }
    throw error;
  }
}

export async function hostedCommand(
  positionals: readonly string[],
  options: ReadonlyMap<string, string | true>,
  runtime: CliRuntime,
  io: CliIo,
): Promise<number> {
  const [operation] = positionals;
  if (operation === 'validate') {
    requirePositionals(
      positionals,
      2,
      'hosted validate requires a plan JSON path.',
    );
    rejectUnknownOptions(options, []);
    const plan = HostedEvaluationPlanV1Schema.parse(
      await readJson(positionals[1]!, 'Hosted evaluation plan'),
    );
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
    rejectUnknownOptions(options, ['output', 'summary', 'dashboard-data']);
    const outputPath = stringOption(options, 'output', true)!;
    const summaryPath = stringOption(options, 'summary');
    const dashboardPath = stringOption(options, 'dashboard-data');
    const paths = [outputPath, summaryPath, dashboardPath].filter(
      (path): path is string => path !== undefined,
    );
    if (new Set(paths.map((path) => resolve(path))).size !== paths.length) {
      throw new UsageError('Hosted output paths must be different.');
    }

    const plan = HostedEvaluationPlanV1Schema.parse(
      await readJson(positionals[1]!, 'Hosted evaluation plan'),
    );
    loadLocalVercelEnvironment();
    const result = await runHostedEvaluationPlan(
      plan,
      new VercelHostedConditionRunner(),
      { id: TOKEN_ESTIMATOR_ID, estimate: estimateTokens },
    );
    await writeFile(outputPath, canonicalJson(result), {
      flag: 'wx',
      mode: 0o600,
    });
    io.stdout(`Wrote private hosted evaluation result to ${outputPath}`);

    const createdAt = runtime.now();
    const summary = sanitizeEvaluationResult(result, plan, createdAt);
    if (summaryPath) {
      await writeFile(summaryPath, canonicalJson(summary), {
        flag: 'wx',
        mode: 0o600,
      });
      io.stdout(`Wrote sanitized hosted evaluation summary to ${summaryPath}`);
    }
    if (dashboardPath) {
      const existing = await readDashboardDataset(dashboardPath, createdAt);
      const dataset = upsertSanitizedExperiment(existing, summary, createdAt);
      await replacePrivateFile(dashboardPath, canonicalJson(dataset));
      io.stdout(`Updated sanitized dashboard data at ${dashboardPath}`);
    }
    return result.status === 'pass' ? 0 : 2;
  }
  throw new UsageError('hosted requires either validate or run.');
}
