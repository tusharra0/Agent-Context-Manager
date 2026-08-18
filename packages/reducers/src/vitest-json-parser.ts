import type {
  ReductionDiagnostic,
  TestCounts,
  TestFailure,
  TestResultObservationV1,
} from '@acm/core';
import { TestResultObservationV1Schema } from '@acm/core';

export const VITEST_JSON_PARSER_MAX_BYTES = 16 * 1024 * 1024;

export type VitestParseMetadata = { command?: string; exitCode?: number };

const TOP_LEVEL_FIELDS = new Set([
  'numTotalTestSuites',
  'numPassedTestSuites',
  'numFailedTestSuites',
  'numPendingTestSuites',
  'numTotalTests',
  'numPassedTests',
  'numFailedTests',
  'numPendingTests',
  'numTodoTests',
  'snapshot',
  'startTime',
  'success',
  'testResults',
]);
const RESULT_FIELDS = new Set([
  'assertionResults',
  'startTime',
  'endTime',
  'status',
  'message',
  'name',
]);
const ASSERTION_FIELDS = new Set([
  'ancestorTitles',
  'fullName',
  'status',
  'title',
  'duration',
  'failureMessages',
  'location',
  'meta',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function pointerSegment(value: string): string {
  return value.replaceAll('~', '~0').replaceAll('/', '~1');
}

function diagnoseUnknownFields(
  value: Record<string, unknown>,
  known: ReadonlySet<string>,
  path: string,
  diagnostics: ReductionDiagnostic[],
): void {
  for (const key of Object.keys(value).sort()) {
    if (known.has(key)) continue;
    const jsonPath = `${path}/${pointerSegment(key)}`;
    diagnostics.push({
      code: 'UNKNOWN_FIELD',
      message: `Unsupported additive field remains available in the raw artifact: ${jsonPath}`,
      jsonPath,
    });
  }
}

function optionalNonnegativeInteger(
  source: Record<string, unknown>,
  field: string,
  path: string,
  diagnostics: ReductionDiagnostic[],
): number | undefined {
  const value = source[field];
  if (value === undefined) return undefined;
  if (Number.isInteger(value) && (value as number) >= 0) return value as number;
  diagnostics.push({
    code: 'MALFORMED_FIELD',
    message: `${field} must be a nonnegative integer.`,
    jsonPath: `${path}/${field}`,
  });
  return undefined;
}

function extractReportedCounts(
  report: Record<string, unknown>,
  diagnostics: ReductionDiagnostic[],
): TestCounts | undefined {
  const mapping = {
    total: 'numTotalTests',
    passed: 'numPassedTests',
    failed: 'numFailedTests',
    skipped: 'numPendingTests',
    todo: 'numTodoTests',
  } as const;
  const counts: TestCounts = {};
  for (const [target, source] of Object.entries(mapping) as [
    keyof TestCounts,
    string,
  ][]) {
    const value = optionalNonnegativeInteger(report, source, '', diagnostics);
    if (value !== undefined) counts[target] = value;
  }
  return Object.keys(counts).length === 0 ? undefined : counts;
}

function optionalString(
  source: Record<string, unknown>,
  field: string,
  path: string,
  diagnostics: ReductionDiagnostic[],
): string | undefined {
  const value = source[field];
  if (value === undefined) return undefined;
  if (typeof value === 'string') return value;
  diagnostics.push({
    code: 'MALFORMED_FIELD',
    message: `${field} must be a string.`,
    jsonPath: `${path}/${field}`,
  });
  return undefined;
}

function extractTestName(
  assertion: Record<string, unknown>,
  path: string,
  diagnostics: ReductionDiagnostic[],
): { value: string; complete: boolean } {
  const fullName = optionalString(assertion, 'fullName', path, diagnostics);
  if (fullName) return { value: fullName, complete: true };
  const title = optionalString(assertion, 'title', path, diagnostics);
  const ancestors = assertion.ancestorTitles;
  if (
    ancestors !== undefined &&
    (!Array.isArray(ancestors) ||
      ancestors.some((item) => typeof item !== 'string'))
  ) {
    diagnostics.push({
      code: 'MALFORMED_FIELD',
      message: 'ancestorTitles must be an array of strings.',
      jsonPath: `${path}/ancestorTitles`,
    });
  }
  const validAncestors = Array.isArray(ancestors)
    ? ancestors.filter((item): item is string => typeof item === 'string')
    : [];
  const combined = [...validAncestors, ...(title ? [title] : [])]
    .join(' ')
    .trim();
  if (combined) return { value: combined, complete: true };
  diagnostics.push({
    code: 'MISSING_TEST_NAME',
    message: 'Failed assertion has neither fullName nor a usable title.',
    jsonPath: path,
  });
  return { value: '<unnamed failed test>', complete: false };
}

function extractFailureMessages(
  assertion: Record<string, unknown>,
  path: string,
  diagnostics: ReductionDiagnostic[],
): string[] {
  const value = assertion.failureMessages;
  if (Array.isArray(value) && value.every((item) => typeof item === 'string'))
    return value;
  diagnostics.push({
    code: 'MALFORMED_FAILURE_MESSAGES',
    message:
      'A failed assertion must provide failureMessages as an array of strings.',
    jsonPath: `${path}/failureMessages`,
  });
  return [];
}

function extractStackFrames(messages: readonly string[]): string[] {
  return messages.flatMap((message) =>
    message
      .split(/\r?\n/u)
      .filter((line) => /^\s*at\s+/u.test(line))
      .map((line) => line.trim()),
  );
}

function extractExpectedAndActual(messages: readonly string[]): {
  expected?: string;
  actual?: string;
} {
  for (const message of messages) {
    const match = /expected '([^'\r\n]*)' to be '([^'\r\n]*)'/u.exec(message);
    if (match) return { actual: match[1]!, expected: match[2]! };
  }
  return {};
}

function extractLocation(
  assertion: Record<string, unknown>,
  path: string,
  diagnostics: ReductionDiagnostic[],
): { line?: number; column?: number } {
  if (assertion.location === undefined) return {};
  if (!isRecord(assertion.location)) {
    diagnostics.push({
      code: 'MALFORMED_LOCATION',
      message:
        'location must be an object with positive line and column integers.',
      jsonPath: `${path}/location`,
    });
    return {};
  }
  const result: { line?: number; column?: number } = {};
  for (const key of ['line', 'column'] as const) {
    const value = assertion.location[key];
    if (value === undefined) continue;
    if (Number.isInteger(value) && (value as number) > 0)
      result[key] = value as number;
    else
      diagnostics.push({
        code: 'MALFORMED_LOCATION',
        message: `location.${key} must be a positive integer.`,
        jsonPath: `${path}/location/${key}`,
      });
  }
  return result;
}

function countsEqual(left: TestCounts | undefined, right: TestCounts): boolean {
  if (!left) return true;
  return (Object.keys(left) as (keyof TestCounts)[]).every(
    (key) => left[key] === right[key],
  );
}

function opaqueObservation(
  diagnostic: ReductionDiagnostic,
  metadata: VitestParseMetadata,
): TestResultObservationV1 {
  return TestResultObservationV1Schema.parse({
    schemaVersion: 1,
    framework: 'vitest',
    sourceFormat: 'vitest-json',
    ...metadata,
    failures: [],
    diagnostics: [diagnostic],
    parseStatus: 'opaque',
  });
}

export function parseVitestJson(
  bytes: Uint8Array,
  metadata: VitestParseMetadata = {},
  totalByteLength = bytes.byteLength,
): TestResultObservationV1 {
  if (totalByteLength > VITEST_JSON_PARSER_MAX_BYTES) {
    return opaqueObservation(
      {
        code: 'INPUT_TOO_LARGE',
        message: `Input is ${totalByteLength} bytes; parser limit is ${VITEST_JSON_PARSER_MAX_BYTES} bytes.`,
      },
      metadata,
    );
  }

  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return opaqueObservation(
      { code: 'MALFORMED_UTF8', message: 'Input is not valid UTF-8.' },
      metadata,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return opaqueObservation(
      {
        code: 'INVALID_JSON',
        message: 'Input is not a complete valid JSON document.',
      },
      metadata,
    );
  }
  if (!isRecord(parsed)) {
    return opaqueObservation(
      {
        code: 'INVALID_REPORT',
        message: 'Vitest JSON report must be an object.',
      },
      metadata,
    );
  }

  const diagnostics: ReductionDiagnostic[] = [];
  let hasRequiredFieldError = false;
  diagnoseUnknownFields(parsed, TOP_LEVEL_FIELDS, '', diagnostics);
  const reportedCounts = extractReportedCounts(parsed, diagnostics);
  const success = parsed.success;
  if (success !== undefined && typeof success !== 'boolean') {
    diagnostics.push({
      code: 'MALFORMED_FIELD',
      message: 'success must be a boolean.',
      jsonPath: '/success',
    });
    hasRequiredFieldError = true;
  }

  const resultValues = parsed.testResults;
  if (!Array.isArray(resultValues)) {
    diagnostics.push({
      code: 'MALFORMED_TEST_RESULTS',
      message: 'testResults must be an array.',
      jsonPath: '/testResults',
    });
    hasRequiredFieldError = true;
  }

  const observedCounts: {
    total: number;
    passed: number;
    failed: number;
    skipped: number;
    todo: number;
  } = {
    total: 0,
    passed: 0,
    failed: 0,
    skipped: 0,
    todo: 0,
  };
  const failures: TestFailure[] = [];
  for (const [resultIndex, resultValue] of (Array.isArray(resultValues)
    ? resultValues
    : []
  ).entries()) {
    const resultPath = `/testResults/${resultIndex}`;
    if (!isRecord(resultValue)) {
      diagnostics.push({
        code: 'MALFORMED_TEST_RESULT',
        message: 'Each test result must be an object.',
        jsonPath: resultPath,
      });
      hasRequiredFieldError = true;
      continue;
    }
    diagnoseUnknownFields(resultValue, RESULT_FIELDS, resultPath, diagnostics);
    const file = optionalString(resultValue, 'name', resultPath, diagnostics);
    if (!Array.isArray(resultValue.assertionResults)) {
      diagnostics.push({
        code: 'MALFORMED_ASSERTION_RESULTS',
        message: 'assertionResults must be an array.',
        jsonPath: `${resultPath}/assertionResults`,
      });
      hasRequiredFieldError = true;
      continue;
    }

    for (const [
      assertionIndex,
      assertionValue,
    ] of resultValue.assertionResults.entries()) {
      const assertionPath = `${resultPath}/assertionResults/${assertionIndex}`;
      if (!isRecord(assertionValue)) {
        diagnostics.push({
          code: 'MALFORMED_ASSERTION',
          message: 'Each assertion result must be an object.',
          jsonPath: assertionPath,
        });
        hasRequiredFieldError = true;
        continue;
      }
      diagnoseUnknownFields(
        assertionValue,
        ASSERTION_FIELDS,
        assertionPath,
        diagnostics,
      );
      observedCounts.total += 1;
      switch (assertionValue.status) {
        case 'passed':
          observedCounts.passed += 1;
          break;
        case 'failed': {
          observedCounts.failed += 1;
          const failureMessages = extractFailureMessages(
            assertionValue,
            assertionPath,
            diagnostics,
          );
          const name = extractTestName(
            assertionValue,
            assertionPath,
            diagnostics,
          );
          failures.push({
            testName: name.value,
            ...(file ? { file } : {}),
            ...extractLocation(assertionValue, assertionPath, diagnostics),
            ...extractExpectedAndActual(failureMessages),
            failureMessages,
            stackFrames: extractStackFrames(failureMessages),
          });
          if (failureMessages.length === 0 || !name.complete) {
            hasRequiredFieldError = true;
          }
          break;
        }
        case 'pending':
        case 'skipped':
        case 'disabled':
          observedCounts.skipped += 1;
          break;
        case 'todo':
          observedCounts.todo += 1;
          break;
        default:
          diagnostics.push({
            code: 'UNKNOWN_ASSERTION_STATUS',
            message: 'Assertion status is missing or unsupported.',
            jsonPath: `${assertionPath}/status`,
          });
          hasRequiredFieldError = true;
      }
    }
  }

  if (!countsEqual(reportedCounts, observedCounts))
    diagnostics.push({
      code: 'COUNT_MISMATCH',
      message:
        'Top-level reported test counts do not match counts derived from assertion records.',
    });

  return TestResultObservationV1Schema.parse({
    schemaVersion: 1,
    framework: 'vitest',
    sourceFormat: 'vitest-json',
    ...metadata,
    ...(typeof success === 'boolean' ? { success } : {}),
    ...(reportedCounts ? { reportedCounts } : {}),
    observedCounts,
    failures,
    diagnostics,
    parseStatus: hasRequiredFieldError ? 'partial' : 'complete',
  });
}
