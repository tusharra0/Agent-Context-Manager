#!/usr/bin/env node

import { ContextEventSchema } from '@acm/core';

const command = process.argv[2] ?? 'help';

function printHelp(): void {
  console.log(`Agent Context Manager

Usage:
  acm doctor   Verify the starter environment
  acm help     Show this help

The first product command will be implemented from
docs/lld/001-event-reduction-pipeline.md.`);
}

function runDoctor(): void {
  const majorVersion = Number.parseInt(
    process.versions.node.split('.')[0] ?? '0',
    10,
  );
  const sampleEvent = ContextEventSchema.parse({
    id: 'evt_doctor',
    sessionId: 'session_doctor',
    kind: 'system',
    createdAt: new Date().toISOString(),
    payload: { check: 'schema-validation' },
  });

  const checks = [
    {
      name: 'Node.js 22+',
      ok: majorVersion >= 22,
      detail: process.version,
    },
    {
      name: 'Core schema import',
      ok: sampleEvent.id === 'evt_doctor',
      detail: sampleEvent.id,
    },
  ];

  for (const check of checks) {
    console.log(
      `${check.ok ? 'PASS' : 'FAIL'}  ${check.name} (${check.detail})`,
    );
  }

  if (checks.some((check) => !check.ok)) {
    process.exitCode = 1;
    return;
  }

  console.log('PASS  Starter workspace is ready.');
}

switch (command) {
  case 'doctor':
    runDoctor();
    break;
  case 'help':
  case '--help':
  case '-h':
    printHelp();
    break;
  default:
    console.error(`Unknown command: ${command}`);
    printHelp();
    process.exitCode = 1;
}
