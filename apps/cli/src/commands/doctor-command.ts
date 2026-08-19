import type { CliIo } from '../cli-context.js';

export function doctorCommand(io: CliIo): number {
  const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
  const supported = major > 22 || (major === 22 && minor >= 13);
  io.stdout(
    `${supported ? 'PASS' : 'FAIL'}  Node.js 22.13+ (${process.version})`,
  );
  if (supported) io.stdout('PASS  Phase 2 runtime is ready.');
  return supported ? 0 : 1;
}
