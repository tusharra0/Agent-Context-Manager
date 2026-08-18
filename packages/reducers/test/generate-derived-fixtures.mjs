import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = new URL('./fixtures/vitest-json/v1/', import.meta.url);
const workspacePath = fileURLToPath(
  new URL('../../../', import.meta.url),
).replace(/[\\/]$/u, '');
const workspaceSlashPath = workspacePath.replaceAll('\\', '/');

function sanitizeWorkspacePaths(value) {
  if (typeof value === 'string') {
    return value
      .replaceAll(workspacePath, '<workspace>')
      .replaceAll(workspaceSlashPath, '<workspace>');
  }
  if (Array.isArray(value)) return value.map(sanitizeWorkspacePaths);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        sanitizeWorkspacePaths(item),
      ]),
    );
  }
  return value;
}

for (const name of [
  'all-pass.json',
  'one-failure.json',
  'several-failures.json',
  'expected-actual.json',
]) {
  const report = JSON.parse(await readFile(new URL(name, root), 'utf8'));
  await writeFile(
    new URL(name, root),
    JSON.stringify(sanitizeWorkspacePaths(report)),
  );
}

const allPass = JSON.parse(
  await readFile(new URL('all-pass.json', root), 'utf8'),
);
for (const key of [
  'numTotalTests',
  'numPassedTests',
  'numFailedTests',
  'numPendingTests',
  'numTodoTests',
]) {
  delete allPass[key];
}
await writeFile(
  new URL('no-summary-counts.json', root),
  JSON.stringify(allPass),
);

const oneFailure = await readFile(new URL('one-failure.json', root));
await writeFile(
  new URL('truncated.json', root),
  oneFailure.subarray(0, oneFailure.byteLength - 17),
);
await writeFile(new URL('malformed-utf8.bin', root), Buffer.from([0xc3, 0x28]));

const paddingLength = 16 * 1024 * 1024 + 1;
await writeFile(
  new URL('very-large.json', root),
  `{"padding":"${'x'.repeat(paddingLength)}"}`,
);
