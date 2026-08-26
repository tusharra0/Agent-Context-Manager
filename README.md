# Agent Context Manager

Agent Context Manager is a local-first context-control layer for coding agents such as Codex and Claude Code.

It stores a lossless session record outside the model's immediate prompt, reduces noisy observations with type-specific rules, maintains durable working state, and assembles focused context for each model call. Its purpose is not to minimize tokens at any cost; it is to find how much context can be safely removed while preserving coding-task success.

## Current status

Phases 1, 2, and 3 are implemented. In addition to lossless typed reduction and
replayable working state, the CLI can run deterministic paired offline
evaluations. It compares raw and managed context at identical checkpoints and
reports token estimates, next-action agreement, critical-field preservation,
repeated work, final outcomes, and failure-driven policy diagnostics.

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
packages/reducers/ Deterministic test, file, search, and build reducers
packages/working-state/ Pure transitions, invariants, and replay
packages/context-assembler/ Priority and token-budget context selection
packages/evaluation/ Offline paired replay, metrics, and policy reports
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

## Phase 2 walkthrough

Record a UTF-8 file read using an explicit logical path and scope:

```bash
pnpm --filter @acm/cli dev -- reduce src/index.ts \
  --type file-read \
  --path src/index.ts \
  --path-kind repository-relative \
  --scope full \
  --encoding utf-8 \
  --data-dir .acm-data
```

The first read is labeled `artifact-required` and exits with code 2 because its
metadata-only reduction is not a substitute for source text. Assembly verifies
and restores the content when it fits; an exact repeated read can safely use a
small duplicate reference.

Use the returned session ID to apply a typed state update. New item IDs and
self-provenance are generated when omitted:

```json
{
  "schemaVersion": 1,
  "expectedRevision": 0,
  "operations": [
    { "operation": "set-goal", "text": "Implement the current phase" },
    {
      "operation": "add-fact",
      "category": "requirement",
      "text": "Never discard raw evidence"
    }
  ]
}
```

```bash
pnpm --filter @acm/cli dev -- state apply state-update.json \
  --session <session-id> --data-dir .acm-data
pnpm --filter @acm/cli dev -- state verify \
  --session <session-id> --data-dir .acm-data
pnpm --filter @acm/cli dev -- assemble \
  --session <session-id> --token-budget 8000 --data-dir .acm-data
```

Assembly exits with code 2 and reports `mandatory-overflow` when required
context alone exceeds the requested budget. The required context is returned
whole so callers can raise the budget or choose an explicit policy rather than
accept silent information loss.

## Phase 3 walkthrough

Validate and run the committed offline paired-replay fixture:

```bash
pnpm --filter @acm/cli dev -- eval validate \
  ../../packages/evaluation/test/fixtures/v1/passing-experiment.json

pnpm --filter @acm/cli dev -- eval run \
  ../../packages/evaluation/test/fixtures/v1/passing-experiment.json \
  --output evaluation-result.json \
  --report evaluation-report.md
```

The evaluator verifies each raw observation's SHA-256 digest and rejects
future-event leakage or managed provenance that is absent from the raw-visible
checkpoint. Raw and managed contexts use the same instructions, event cutoff,
and token estimator. The result records paired token estimates, normalized
next actions, critical fields, repeated actions under unchanged workspace
revisions, recorded usage and latency, and externally verified task outcomes.

`eval run` exits with code 2 when it produces a valid result containing a
policy failure. Examples include a missing critical field, next-action
divergence, mandatory budget overflow, increased repeated work, or a task that
succeeds with raw context and fails with managed context. Result and report
paths are created exclusively and are never overwritten.

Phase 3 is model- and network-free: its normalized actions and outcomes are
recorded fixture evidence. The included synthetic fixture validates the
evaluation machinery and is not an empirical token-saving claim. Phase 4 will
connect live harness runs to the same evaluation contracts.
