# LLD 003: Offline paired evaluation

**Status:** Implemented
**Scope:** Phase 3 vertical slice
**Last updated:** August 26, 2026

## Objective

Replay identical recorded trajectory checkpoints with raw and managed
observations, then measure context size, next-action agreement, critical-field
preservation, repeated work, and final task outcomes.

The slice is offline. It consumes normalized recorded actions and verified task
outcomes rather than invoking a model, Codex, Claude Code, or Vercel.

## Package boundaries

```text
@acm/evaluation         Evaluation schemas, replay, metrics, and reports
@acm/context-assembler Managed whole-item budget policy
@acm/core               Existing event, state, JSON, and provenance schemas
@acm/cli                File loading, command orchestration, and output
```

`@acm/evaluation` may depend on stable core and assembly contracts. It must not
import a harness, model SDK, network client, SQLite driver, or provider package.

## Experiment input

An experiment contains one or more cases. Each case contains ordered replay
checkpoints plus paired raw and managed run evidence. A checkpoint records:

- The exact event-sequence cutoff
- Pinned instructions shared by both conditions
- Durable working state at that cutoff
- Raw observation text and its SHA-256 digest
- The managed candidate produced from the same observation
- Critical-field assertions with source provenance and managed locators
- An explicit context budget and estimator identity
- Repository fixture identity and revision
- Whether the checkpoint represents forced-compaction recovery

Recorded run evidence contains normalized next actions at each checkpoint, an
action trace with workspace revisions, actual usage when available, latency,
producer identity (synthetic or recorded harness), and an externally determined
final outcome. Recorded harness evidence requires both harness and model IDs.

## Replay rules

1. Validate every schema before evaluation.
2. Reject observations or state newer than the checkpoint.
3. Recompute and verify every raw-text SHA-256 digest.
4. Render raw instructions and observations in chronological order.
5. Assemble managed instructions, state, and safe observation candidates with
   the configured versioned policy.
6. Reject managed provenance that points outside the raw-visible event set.
7. Estimate raw and managed context with the same estimator.
8. Never silently accept a mandatory unsafe candidate.

## Metrics

- Input-token difference and percentage reduction per checkpoint
- Exact normalized next-action agreement
- Action-kind and target agreement as diagnostics
- Critical-field exact-value preservation and source-provenance retention
- Repeated action count under an unchanged workspace revision
- Raw and managed task-success outcomes
- Recorded agent latency, usage, and cost when available

An action is repeated only when its canonical kind, name, arguments, and target
set recur under the same workspace revision. Re-running a command after a
workspace change is not counted as repeated work.

## Failure reports

The evaluator emits structured policy failures for missing critical fields,
next-action divergence, baseline-only task success, increased repeated work,
and mandatory budget overflow. Reports include case/checkpoint IDs, policy and
estimator versions, source events, and evidence details. They may recommend a
preservation rule but never mutate policy automatically.

## CLI

```text
acm eval validate <experiment.json>
acm eval run <experiment.json> [--output <result.json>] [--report <report.md>]
```

Outputs use canonical JSON. Explicit output paths are created exclusively and
never overwritten.

## Acceptance criteria

- Raw and managed conditions use identical instructions and event visibility.
- Hash mismatch, future leakage, or invalid provenance fails evaluation.
- Mandatory critical-field recall is 100% in the deterministic fixture suite.
- Every raw-success/managed-failure pair is reported as a policy regression.
- Repeated-work measurement distinguishes unchanged and changed workspaces.
- Reports are byte-for-byte deterministic for identical inputs.
- No model, network, credential, harness, or Vercel dependency is required.
- `pnpm check` passes.
