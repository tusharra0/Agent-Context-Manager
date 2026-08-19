# ADR 004: Use append-only working-state transitions and a rebuildable projection

**Status:** Accepted
**Date:** August 18, 2026

## Context

Phase 2 must preserve task state across context compaction and process restart.
Replacing a JSON state document in place would make lost requirements,
incorrect resolution, and provenance mistakes difficult to detect or audit.
Replaying an entire session for every assembly is correct but unnecessarily
expensive as trajectories grow.

## Decision

Represent every working-state change as a versioned `state_update` event in the
existing per-session event sequence. Apply each transition with a pure state
engine and store the resulting materialized projection in SQLite within the
same immediate transaction.

The event sequence is authoritative. The projection is a cache that carries a
canonical JSON hash, revision, and last applied event sequence. Verification
replays all state updates and compares the canonical rebuilt state with the
stored projection.

Every state value must carry one or more source event references. Persistence
rejects missing and cross-session provenance. Supersession, failure resolution,
and work completion are explicit operations; no transition silently removes a
prior fact.

Context assembly treats its token budget as a target. Mandatory requirements,
active failures, goals, and required work are retained whole. When those values
exceed the requested budget, the assembler returns `mandatory-overflow` rather
than truncating them.

## Consequences

- State can be audited, replayed, and recovered after forced compaction.
- Stale callers are rejected using an expected revision.
- State updates and projections cannot diverge after a committed transaction.
- The projection adds migration and integrity-verification complexity.
- Semantic extraction of state from conversation remains outside Phase 2;
  callers submit explicit typed operations.

## Rejected alternatives

### Mutable JSON document only

Rejected because it loses history and cannot prove why a value changed.

### Rebuild on every read

Rejected as the only access path because assembly will be frequent. Replay is
retained as an integrity and recovery mechanism.

### Model-generated prose summary

Rejected because Phase 2 requires exact typed fields, deterministic behavior,
and no model or network dependency.
