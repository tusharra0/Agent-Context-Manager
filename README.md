# Agent Context Manager

Agent Context Manager is a local-first context-control layer for coding agents such as Codex and Claude Code.

It stores a lossless session record outside the model's immediate prompt, reduces noisy observations with type-specific rules, maintains durable working state, and assembles focused context for each model call. Its purpose is not to minimize tokens at any cost; it is to find how much context can be safely removed while preserving coding-task success.

## Current status

Phases 1 through 6 are implemented. In addition to lossless typed reduction,
replayable working state, and deterministic paired evaluation, Codex and Claude
Code now run behind one project-owned harness contract. Their streamed text,
tool activity, usage, completion, interruption, and errors normalize into
versioned ACM events that can be converted directly into Phase 3 evidence.
Authenticated hosted runs execute paired conditions in fresh Vercel Sandboxes,
derive managed checkpoints from the same typed reducers used locally, and keep
private execution evidence in a durable local journal. A read-only Next.js
dashboard accepts only sanitized aggregate results. Observations are now
reduced on the per-step context path rather than only at a checkpoint, and
per-request usage is recorded so a compounding saving can be told apart from a
one-time one.

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
apps/dashboard/    Read-only sanitized experiment dashboard
packages/core/     Stable domain schemas and types
packages/event-store/ Content-addressed artifacts and SQLite metadata
packages/reducers/ Deterministic test, file, search, and build reducers
packages/working-state/ Pure transitions, invariants, and replay
packages/context-assembler/ Priority and token-budget context selection
packages/evaluation/ Offline paired replay, metrics, and policy reports
packages/harness-port/ Provider-neutral session and event contracts
packages/observation-pipeline/ Per-step observation interception and recording
packages/hosted-evaluation/ Hosted plans, orchestration, and sanitization
packages/vercel-harness/ Isolated AI SDK 7 Codex and Claude Code adapters
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
evaluation machinery and is not an empirical token-saving claim.

## Phase 4 harness integration

`@acm/harness-port` owns the stable lifecycle and normalized event schemas.
`@acm/vercel-harness` is the only package allowed to import the pinned,
experimental Vercel harness packages. It selects either Codex or Claude Code,
forwards cancellation with `AbortSignal`, validates JSON tool evidence, and
keeps additive vendor stream parts visible as diagnostics.

The adapter receives a sandbox provider through dependency injection. All
Phase 4 tests therefore run without credentials; Phase 5 supplies the Vercel
Sandbox provider behind the same project-owned interface.

## Phase 5 hosted evaluation

Validate a hosted plan without contacting Vercel:

```bash
pnpm --filter @acm/cli dev -- hosted validate hosted-plan.json
```

An authenticated run creates a fresh sandbox for each raw and managed
condition, checks out an exact public Git commit, runs the selected harness
through AI Gateway, and applies deterministic verification commands:

```bash
pnpm --filter @acm/cli dev -- hosted run hosted-plan.json \
  --output private-result.json \
  --trace private-result.trace.jsonl \
  --summary sanitized-summary.json \
  --dashboard-data ../../apps/dashboard/data/results.json \
  --data-dir .acm-data
```

`hosted validate` performs schema, digest, provenance, policy, and estimator
checks without contacting Vercel. A plan can use `contextSource:
"typed-reducers"` with one typed `reductionInputs` entry per observation; ACM
then parses the raw evidence and replaces any supplied managed candidate with
the actual reducer output. The default `recorded-candidates` mode remains for
legacy replay fixtures.

Before a paid run begins, private result, summary, and trace paths are reserved
exclusively, and an existing dashboard dataset is validated. The JSONL trace is
synced as setup commands and harness events arrive. Raw observations are stored
in the local content-addressed artifact store. If a provider run fails, the
trace and a small error result remain available while no summary is published.

The full result and trace are never read by the dashboard. The dashboard
dataset is an explicit allow-list:
it omits prompts, source, model responses, tool inputs and outputs, normalized
actions, assertion evidence, and failure details. A policy failure exits with
code 2 and remains visible in the private result and aggregate status.

Estimated context reduction and provider-reported input-token reduction are
reported separately. Measured fields are null when complete usage evidence is
unavailable. Repeated-action counts are also null unless tool-time workspace
revisions are authoritative. The current hosted slice evaluates one checkpoint
per isolated task; it does not continuously replace a native harness's context
throughout a multi-turn session.

Local hosted runs require `vercel login`, a linked Vercel project, and fresh
OIDC credentials from `vercel env pull`. Deployed Vercel workloads receive
OIDC automatically. The dashboard itself never starts a sandbox or accepts
commands, repositories, credentials, or prompts over HTTP.

## Phase 6 per-step context control

A checkpoint reduction only shrinks the first model request of a run. The
harness owns its transcript after that, so the first authenticated paired run
reduced its checkpoint by an estimated 21.9% while provider-reported input
tokens fell 0.5%.

Phase 6 moves the reduction onto the per-step context path. Host-executed tools
shadow the harness's own `read`, `grep`, and `bash` builtins: the raw
observation is stored, a deterministic reducer runs, and the reduced text is
what the harness writes into the transcript. That text is present in every
later model request of the session, so the saving compounds instead of being
overwritten.

Nothing leaves active context before it is recoverable. An unavailable artifact
store, an unclaimed tool, a classifier or reducer fault, a reduction the reducer
marks unsafe, and a reduction no smaller than its source all fall back to the
raw observation and record why.

Both conditions run the same interception path. Under the `raw` policy the
reduction is still computed and recorded but never substituted, so the
conditions differ in exactly one decision and the baseline measures what the
managed condition would have done with the same bytes. The hosted runner
rejects a mismatched pairing rather than trusting the caller.

Per-request usage is recorded as `step-usage` events. A session-global curve is
built only when every completed turn reported usage for each of its steps, and
its least-squares slope is what separates a one-time saving from a compounding
one.

Long-horizon fixtures, a hosted plan field that selects per-step interception,
and the paired run that would validate the two together are not yet built. The
harness preamble and prior transcript still lie outside ACM's reach.
