# LLD 002: Working state and context assembly

**Status:** Implemented
**Scope:** Phase 2 vertical slice
**Last updated:** August 19, 2026

## Objective

Maintain an auditable structured task handoff, reduce repeated file reads and
structured search/build output, and assemble whole context items under an
explicit token budget without dropping mandatory facts.

## Package boundaries

```text
@acm/core               Versioned schemas and identifiers
@acm/working-state      Pure transitions, invariants, and replay
@acm/context-assembler  Candidate priority and budget selection
@acm/reducers           Deterministic typed observation reducers
@acm/event-store        SQLite event log, provenance, and projection
@acm/cli                Storage and command orchestration
```

The state engine and assembler do not import SQLite, filesystem, harness, or
provider packages. No Phase 2 operation requires a model, network request, or
credential.

## Working-state contract

`DurableWorkingStateV1` records the session, revision, applied sequence, goal,
requirements, decisions, files, failures, work items, test status, and update
time. Facts have opaque IDs, category-specific status rules, retention policy,
source provenance, and introduction/update sequences.

Supported transition operations are:

- `set-goal`
- `add-fact` for a requirement, decision, failure, or work item
- `change-fact-status`
- `record-file`
- `set-test-status`

A transition carries `expectedRevision`; mismatches fail before persistence.
Replacing an active goal or current file requires the exact prior item ID in
`supersedes`. Requirements and decisions may only become superseded, failures
may only become resolved, and work items may become completed or superseded.

## Persistence flow

State updates use this transaction:

1. Validate identifiers, timestamps, artifact metadata, and transition schema.
2. Begin an immediate SQLite transaction.
3. Validate that every provenance event exists in the same session.
4. Load and hash-check the current projection.
5. Allocate the next session event sequence.
6. Apply the pure transition with revision and category invariants.
7. Append the `state_update` event and normalized provenance rows.
8. Upsert canonical projection JSON and its SHA-256 hash.
9. Commit.

Migration 2 creates `working_state_snapshots` and `state_provenance` without
rewriting Phase 1 events or reductions. Replay verification rebuilds from
ordered `state_update` events and requires canonical equality with the stored
projection.

## Deterministic reducers

### File reads

The deduplication key is session, logical path, path kind, exact read scope,
and content hash. A duplicate reduction references the first matching event.
Different paths, line ranges, or hashes remain distinct. Input must be valid
UTF-8 and raw bytes remain in the artifact store. A first observation is marked
`artifact-required`; assembly verifies and restores its content when it can fit
or emits an explicit restoration-required evidence marker. Only an unchanged
duplicate reference is independently context-ready.

Assembly considers only the newest event for each logical file identity (path,
path kind, and scope). Older versions remain recoverable but appear in the
manifest as superseded. Raw file restoration also has one aggregate byte limit
for the whole assembly: the smaller of the approximate context budget in bytes
and 16 MiB. Newer file observations consume that allowance first.

### Search output

The supported source is ripgrep JSON lines. The parser retains query, root,
command, exit code, every unique path/location/excerpt, reported count, and
diagnostics. Invalid UTF-8, malformed records, missing summaries, and count
mismatches lower fidelity instead of being guessed away.

Ripgrep submatch offsets are retained as UTF-8 byte offsets and converted to
one-based JavaScript UTF-16 columns. This keeps locations correct for both raw
tool evidence and TypeScript/JavaScript string consumers, including lines that
contain non-ASCII characters.

### Build output

The supported source is `tsc --pretty false`. The parser retains command,
working directory, version, exit code, diagnostic code/category/message, and
source location. Unrecognized non-empty lines are preserved as diagnostics and
make the reduction partial or opaque.

Both parsers have a documented 16 MiB in-memory parse bound. Larger artifacts
remain restorable and are marked opaque.

## Context assembly

The `priority-whole-item@1` policy orders instructions, goal, requirements,
active failures, decisions, working state, file observations, recent
observations, and completed outcomes. Required items are assembled first and
are never split or truncated. Unsafe reductions are excluded with an explicit
manifest reason.

Failing test and build observations are classified as required active failures,
including under mandatory budget overflow. If a failing report was only
partially parsed, assembly includes a clearly marked incomplete structured
failure with its artifact evidence instead of presenting it as complete.

Optional candidates are considered deterministically by priority, newest
sequence, then candidate ID. The exact canonical candidate envelope is measured
after every attempted inclusion. The result contains context text plus a
manifest with policy and estimator IDs, requested/observed tokens, status,
included IDs, and excluded IDs with reasons.

## CLI

Phase 2 adds explicit `reduce` formats for file reads, ripgrep JSON, and
TypeScript diagnostics, plus:

```text
acm state apply <update.json> --session <id>
acm state verify --session <id>
acm inspect state --session <id> [--json]
acm assemble --session <id> --token-budget <tokens> [--output <path>]
```

When a state operation omits a new item ID or provenance, the CLI generates an
opaque item ID and references the immutable state-update event/artifact. Core
and persistence APIs continue to require normalized explicit values.

Command-specific options and state-update documents are validated before ACM
creates a new session or writes a raw artifact. Invalid usage therefore has no
storage side effects.

## Acceptance criteria

- A fresh process recovers the same canonical working state.
- Replay and the stored projection agree.
- Missing or cross-session provenance is rejected transactionally.
- Supersession and status transitions cannot silently remove active facts.
- Exact repeated file reads reference the prior event.
- Superseded file versions do not enter the assembled context.
- Aggregate raw-file restoration remains bounded.
- Search and build parse failures are not labeled safe.
- Failing test and build observations remain mandatory.
- Unicode search locations preserve byte and UTF-16 coordinates.
- Invalid command input does not create sessions or artifacts.
- Mandatory context survives a forced budget overflow.
- Raw artifacts remain byte-for-byte restorable.
- `pnpm check` passes without a model or network dependency.
