# ADR 005: Use paired checkpoint replay for offline evaluation

**Status:** Accepted
**Date:** August 26, 2026

## Context

Phase 3 must measure whether managed context changes agent behavior or task
outcomes without depending on the live harness integrations scheduled for
Phase 4. Comparing unrelated runs, prompts, or trajectory positions would
confound the effect of context management with unrelated variation.

## Decision

Evaluate raw and managed context as a pair at explicit trajectory checkpoints.
Both conditions use the same pinned instructions, visible source events, event
cutoff, task, and normalized recorded run evidence.

The raw condition renders verified original observations. The managed condition
uses the versioned reducers, durable state, and context-assembly policy. Every
managed fact must retain provenance to an event visible to the raw condition.

Phase 3 consumes recorded normalized actions and externally verified task
outcomes. It does not invoke a model or harness. Phase 4 adapters will produce
new evidence using the same schemas.

## Consequences

- Offline evaluation is deterministic, local, and credential-free.
- A replay cannot read events newer than its checkpoint.
- Missing or hash-mismatched raw evidence fails the replay.
- Token reduction is reported only beside preservation and outcome results.
- Phase 3 validates evaluation mechanics and recorded traces; live behavioral
  claims require Phase 4 or Phase 5 runs.
