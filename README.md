# Agent Context Manager

Agent Context Manager is a local-first context-control layer for coding agents such as Codex and Claude Code.

It stores a lossless session record outside the model's immediate prompt, reduces noisy observations with type-specific rules, maintains durable working state, and assembles focused context for each model call. Its purpose is not to minimize tokens at any cost; it is to find how much context can be safely removed while preserving coding-task success.

## Current status

Phase 1, lossless event reduction, is implemented. The CLI can ingest a Vitest
JSON report, retain its original bytes in local content-addressed storage,
record versioned event and reduction metadata in SQLite, emit a deterministic
reduction, inspect the record, and restore the original bytes.

## Requirements

- Node.js 22.13 or later (the repository pins 22.16.0)
- pnpm 10 or later
- Git

## Setup

```bash
corepack enable
pnpm install
pnpm check
pnpm run doctor
```

Copy `.env.example` to `.env.local` only when beginning an integration that requires credentials. The initial core and tests require no API keys.

## Useful commands

```bash
pnpm build          # compile every workspace package
pnpm typecheck      # strict TypeScript checks
pnpm test           # run unit tests
pnpm format         # format source and documentation
pnpm format:check   # check formatting without edits
pnpm check          # formatting, types, tests, and build
pnpm run doctor     # verify the local project environment
pnpm dev            # run the CLI through tsx
```

## Repository layout

```text
apps/cli/          Local command-line entry point
packages/core/     Stable domain schemas and types
packages/event-store/ Content-addressed artifacts and SQLite metadata
packages/reducers/ Vitest JSON parser, deterministic reducer, token estimator
```

Additional packages should be created when their implementation starts, not merely to mirror a future diagram.

## Phase 1 walkthrough

Capture a Vitest report with its supported JSON reporter:

```bash
pnpm vitest run --reporter=json --outputFile=test-output.json
```

Record and reduce it. The type, framework, and format flags are intentionally
explicit in this phase:

```bash
pnpm --filter @acm/cli dev -- reduce test-output.json \
  --type test-result \
  --framework vitest \
  --format json \
  --command "pnpm vitest run" \
  --exit-code 0 \
  --data-dir .acm-data
```

The JSON response contains the session ID, event ID, sequence, artifact URI,
content hash, reduction, reducer version, estimator identity, and both token
estimates. Passing-test names are folded into counts; every failed assertion
and supported exact field remains in the reduction.

Inspect the persisted record and restore its raw evidence using the IDs from
that response:

```bash
pnpm --filter @acm/cli dev -- inspect event <event-id> --data-dir .acm-data --json
pnpm --filter @acm/cli dev -- restore artifact://sha256/<digest> \
  --output restored.json \
  --data-dir .acm-data
```

Restore refuses to overwrite an existing file. A reduce command exits with
code 2 when its artifact and metadata were recorded but the input was opaque
or otherwise unsafe to use as reduced context. Such evidence remains fully
restorable.

Storage configuration resolves in this order: `--data-dir`, `ACM_DATA_DIR`,
then `~/.acm`. `ACM_ARTIFACT_DIR` can place the complete artifact tree on a
different local filesystem. Artifact reads are verified against their digest
as they are consumed. On POSIX systems, ACM-owned storage directories and
files are restricted to the current user, and storage components reject
symbolic links at managed artifact and database paths. No network service,
model, or credential is used.
