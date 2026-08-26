import { readFile, writeFile } from 'node:fs/promises';
import { TextDecoder } from 'node:util';

import { canonicalJson } from '@acm/core';
import {
  EvaluationExperimentV1Schema,
  evaluateExperiment,
  renderEvaluationReport,
} from '@acm/evaluation';
import { TOKEN_ESTIMATOR_ID, estimateTokens } from '@acm/reducers';

import {
  UsageError,
  rejectUnknownOptions,
  stringOption,
} from '../arguments.js';
import type { CliIo } from '../cli-context.js';
import { requirePositionals } from '../command-options.js';

async function readExperiment(path: string) {
  const bytes = await readFile(path);
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    throw new UsageError('Evaluation experiment must be valid UTF-8.', {
      cause: error,
    });
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new UsageError('Evaluation experiment must be valid JSON.', {
      cause: error,
    });
  }
  return EvaluationExperimentV1Schema.parse(value);
}

export async function evalCommand(
  positionals: readonly string[],
  options: ReadonlyMap<string, string | true>,
  io: CliIo,
): Promise<number> {
  const [operation] = positionals;
  if (operation === 'validate') {
    requirePositionals(
      positionals,
      2,
      'eval validate requires an experiment JSON path.',
    );
    rejectUnknownOptions(options, []);
    const experiment = await readExperiment(positionals[1]!);
    evaluateExperiment(experiment, {
      id: TOKEN_ESTIMATOR_ID,
      estimate: estimateTokens,
    });
    io.stdout(
      canonicalJson({
        valid: true,
        experimentId: experiment.id,
        caseCount: experiment.cases.length,
        checkpointCount: experiment.cases.reduce(
          (sum, evaluationCase) => sum + evaluationCase.checkpoints.length,
          0,
        ),
      }),
    );
    return 0;
  }
  if (operation === 'run') {
    requirePositionals(
      positionals,
      2,
      'eval run requires an experiment JSON path.',
    );
    rejectUnknownOptions(options, ['output', 'report']);
    const outputPath = stringOption(options, 'output');
    const reportPath = stringOption(options, 'report');
    if (outputPath && reportPath && outputPath === reportPath) {
      throw new UsageError('--output and --report must use different paths.');
    }
    const experiment = await readExperiment(positionals[1]!);
    const result = evaluateExperiment(experiment, {
      id: TOKEN_ESTIMATOR_ID,
      estimate: estimateTokens,
    });
    const serialized = canonicalJson(result);
    if (outputPath) {
      await writeFile(outputPath, serialized, { flag: 'wx', mode: 0o600 });
      io.stdout(`Wrote evaluation result to ${outputPath}`);
    } else io.stdout(serialized);
    if (reportPath) {
      await writeFile(reportPath, renderEvaluationReport(result), {
        flag: 'wx',
        mode: 0o600,
      });
      io.stdout(`Wrote evaluation report to ${reportPath}`);
    }
    return result.status === 'pass' ? 0 : 2;
  }
  throw new UsageError('eval requires either validate or run.');
}
