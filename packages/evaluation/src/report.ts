import { canonicalJson } from '@acm/core';

import type { EvaluationResultV1 } from './schemas.js';

function percent(value: number | null): string {
  return value === null ? 'n/a' : `${value.toFixed(2)}%`;
}

export function renderEvaluationReport(result: EvaluationResultV1): string {
  const lines = [
    `# Evaluation report: ${result.experimentId}`,
    '',
    `Status: **${result.status.toUpperCase()}**`,
    '',
    `Policy: \`${result.policyId}\`  `,
    `Token estimator: \`${result.tokenEstimatorId}\``,
    `Repository fixture: \`${result.repositoryFixture.id}@${result.repositoryFixture.revision}\``,
    '',
    '## Aggregate results',
    '',
    `- Checkpoints: ${result.aggregate.checkpointCount}`,
    `- Median estimated checkpoint-context reduction: ${percent(result.aggregate.medianEstimatedContextReductionPercent)}`,
    `- Measured input-token coverage: ${result.aggregate.measuredInputTokenCaseCount}/${result.aggregate.caseCount} paired cases`,
    `- Measured input tokens, raw/managed (covered pairs): ${result.aggregate.rawMeasuredInputTokens ?? 'n/a'}/${result.aggregate.managedMeasuredInputTokens ?? 'n/a'}`,
    `- Measured input-token reduction (covered pairs): ${percent(result.aggregate.measuredInputTokenReductionPercent)}`,
    `- Median measured input-token reduction (covered pairs): ${percent(result.aggregate.medianMeasuredInputTokenReductionPercent)}`,
    `- Exact next-action agreement: ${result.aggregate.exactNextActionAgreements}/${result.aggregate.checkpointCount}`,
    `- Critical-field recall: ${result.aggregate.criticalFieldsPreserved}/${result.aggregate.criticalFieldsTotal} (${percent(result.aggregate.criticalFieldRecall === null ? null : result.aggregate.criticalFieldRecall * 100)})`,
    `- Raw task successes: ${result.aggregate.rawTaskSuccesses}/${result.cases.length}`,
    `- Managed task successes: ${result.aggregate.managedTaskSuccesses}/${result.cases.length}`,
    `- Baseline-only failures: ${result.aggregate.baselineOnlyFailures}`,
    `- Repeated actions, raw/managed: ${result.aggregate.rawRepeatedActionCount ?? 'n/a'}/${result.aggregate.managedRepeatedActionCount ?? 'n/a'}`,
    `- Forced-compaction recovery: ${result.aggregate.forcedCompactionRecoveries}/${result.aggregate.forcedCompactionCheckpoints}`,
    '',
    '## Cases',
    '',
  ];
  for (const evaluationCase of result.cases) {
    lines.push(
      `### ${evaluationCase.caseId}`,
      '',
      `Outcome: \`${evaluationCase.outcomeClassification}\``,
      '',
    );
    if (
      evaluationCase.rawMeasurements.latencyMs !== undefined ||
      evaluationCase.managedMeasurements.latencyMs !== undefined
    ) {
      lines.push(
        `Recorded latency, raw/managed: ${evaluationCase.rawMeasurements.latencyMs ?? 'n/a'} ms/${evaluationCase.managedMeasurements.latencyMs ?? 'n/a'} ms`,
        '',
      );
    }
    for (const checkpoint of evaluationCase.checkpointResults) {
      const retained = checkpoint.criticalFields.filter(
        (field) => field.preserved && field.provenanceRetained,
      ).length;
      lines.push(
        `- ${checkpoint.checkpointId}: ${percent(checkpoint.estimatedTokenReductionPercent)} estimated context reduction; next action ${checkpoint.exactNextActionAgreement ? 'matched' : 'diverged'}; critical fields ${retained}/${checkpoint.criticalFields.length}; assembly \`${checkpoint.manifest.status}\``,
      );
    }
    lines.push('');
  }
  lines.push('## Policy failures', '');
  if (result.policyFailures.length === 0) {
    lines.push('None.', '');
  } else {
    for (const failure of result.policyFailures) {
      const checkpoint = failure.checkpointId
        ? ` at ${failure.checkpointId}`
        : '';
      lines.push(
        `- **${failure.kind}** in ${failure.caseId}${checkpoint}: ${failure.message}`,
        `  - Evidence: \`${canonicalJson(failure.details)}\``,
      );
    }
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}
