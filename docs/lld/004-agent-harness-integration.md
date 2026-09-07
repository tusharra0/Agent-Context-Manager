# LLD 004: Agent harness integration

**Status:** Implemented; live verification pending Phase 5 infrastructure
**Scope:** Phase 4 vertical slice
**Last updated:** August 26, 2026

## Objective

Run Codex and Claude Code behind one project-owned harness interface, normalize
their streamed activity into versioned ACM events, and verify session creation,
streaming, interruption, completion, and cleanup without leaking experimental
Vercel types into core packages.

## Package boundaries

```text
@acm/harness-port      Stable lifecycle and normalized event contracts
@acm/vercel-harness    Experimental AI SDK 7 adapter boundary
@acm/evaluation        Converts normalized traces into Phase 3 run evidence
@acm/core              Stable JSON and identifier primitives
```

Only `@acm/vercel-harness` imports experimental Vercel harness packages.

## Stable port

`AgentHarnessPort` creates a session with an ACM session ID and optional
instructions. Session creation and streaming accept an external abort signal so
one hosted deadline covers fixture setup, provider startup, the model turn,
verification, and final workspace capture. The port instance owns the harness
identity. A session
exposes:

- `stream()` for one turn at a time
- `interrupt()` for the active turn
- `destroy()` for deterministic cleanup
- A stable ACM session ID independent of vendor IDs

Stream events are ordered with a per-session sequence and include session
start, text deltas, tool calls, tool results, usage, completion, interruption,
errors, and destruction. Tool inputs and outputs contain validated JSON only.

Only one turn may run in a session at once. Streaming after destruction and
concurrent turns fail locally. Interruption and destruction are idempotent.

## Vercel adapter

The adapter pins the validated AI SDK package versions and accepts a sandbox
provider rather than constructing Vercel Sandbox itself. It selects either the
Codex or Claude Code factory, creates `HarnessAgent`, opens a session, consumes
the translated AI SDK stream, and destroys the vendor session through explicit
lifecycle cleanup.

Unknown additive vendor stream parts become `diagnostic` events. They are not
silently discarded. Sensitive values are not logged by the adapter.

## Evaluation bridge

Phase 3 recorded condition evidence is built from normalized harness traces,
not vendor events. Tool calls become normalized agent actions. Repeated work is
computed only when a tool call carries an authoritative workspace revision;
the final post-turn hash is not assigned retroactively to every action. Usage
and latency are carried through when the provider supplies complete evidence,
and final success still comes from an external verification oracle.

## Verification

Credential-free tests use scripted sessions and injected vendor doubles to
verify:

- Codex and Claude Code selection
- Session creation and vendor-ID isolation
- Text, tool-call, tool-result, usage, error, and completion normalization
- Concurrent-turn rejection
- Interruption and cleanup
- External deadline propagation during creation and streaming
- Cleanup after stream failure
- Unknown-part diagnostics
- Evaluation evidence conversion

Live smoke verification is intentionally deferred to the first Phase 5 slice,
which supplies the Vercel Sandbox provider and repository fixture. Phase 4 is
credential-free and does not construct hosted infrastructure.

## Acceptance criteria

- Experimental packages are imported only by `@acm/vercel-harness`.
- Both harnesses pass the same credential-free lifecycle contract tests.
- Every normalized event is runtime validated and monotonically sequenced.
- Unknown vendor parts remain observable as diagnostics.
- Cleanup occurs on success, interruption, and failure.
- Phase 3 accepts evidence produced from normalized traces.
- `pnpm check` passes without credentials or network access.
