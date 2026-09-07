# Phase 6 long-horizon suite

Four paired hosted plans that exercise per-step observation interception on real
coding tasks in this repository at a pinned public revision
(`4931e521de5813fc981841c4c2681e67767813c4`).

The Phase 5 smoke plan creates one file. It cannot show a compounding reduction
because it produces almost no observations to reduce. These tasks require
reading source, searching for a symbol, running a package's tests, and running
them again after an edit — the repetition a long session actually accumulates.

## One plan per task

Verification commands belong to the fixture and run for every case in a plan, so
tasks that assert different things cannot share one. Each file here is a
complete plan with a single case.

## What each plan asserts

Every task names the exact identifier it must introduce, so success is decided
by a command rather than by reading the diff.

| Plan                             | Introduces                | Tests that must still pass            |
| -------------------------------- | ------------------------- | ------------------------------------- |
| `search-empty-query-diagnostic`  | `SEARCH_QUERY_EMPTY`      | `@acm/reducers`                       |
| `build-diagnostic-continuation`  | `DIAGNOSTIC_CONTINUATION` | `@acm/reducers`                       |
| `assembler-duplicate-read-count` | `duplicateReadCount`      | `@acm/context-assembler`, `@acm/core` |
| `duplicate-test-name-diagnostic` | `DUPLICATE_TEST_NAME`     | `@acm/reducers`                       |

All fifteen verification commands were checked against the pinned revision
before these plans were committed: every "introduces" assertion fails there, so
no task is already solved, and every "must still pass" assertion passes, so no
task starts from a broken tree.

`build-diagnostic-continuation` is worth noting: the benchmark fixture in
`packages/observation-pipeline/benchmark/fixtures/tsc-errors.txt` contains
exactly the wrapped diagnostic this task is about. Completing it would make that
observation reducible, which is a real improvement to the pipeline and not only
a task to score.

## Checkpoints are empty on purpose

A per-step run reduces the observations the agent produces, not a recorded
checkpoint. Each plan therefore starts both conditions from identical context —
the task instruction and nothing else — so every difference between them comes
from interception rather than from a checkpoint that was prepared differently.

Because the two conditions start identical, a next-action divergence at the
checkpoint is model nondeterminism rather than an effect of the reduction, and
the evaluator does not raise a policy failure for it.

## Harness and model

These plans use `claude-code`, whose builtin `read`, `grep`, and `bash` tools
ACM can all shadow. Codex exposes only `bash`, so a Codex run would leave file
reads and searches unintercepted and understate the mechanism.

**Set `model` to an id your AI Gateway actually serves before running.** The
committed value is a placeholder; a wrong id fails at session creation, which is
cheap, but it fails.

## Running one

```bash
cd apps/cli

pnpm exec tsx src/index.ts hosted validate \
  ../../examples/phase6-suite/search-empty-query-diagnostic.json

pnpm exec tsx src/index.ts hosted run \
  ../../examples/phase6-suite/search-empty-query-diagnostic.json \
  --output private-result.json \
  --trace private-result.trace.jsonl \
  --summary sanitized-summary.json \
  --data-dir ../../.acm-data
```

Each plan runs both conditions in fresh sandboxes and bills for both. Validate
every plan first, run one end to end, and read its trace before launching the
rest.

## What a result answers

`observationTokenReductionPercent` is what interception saved.
`reducibleSharePercent` is how much of the baseline's observation tokens a
reduction could reach at all — measured from the baseline, which computes its
reductions without substituting them. A saving is only interpretable next to
that share.

Four tasks is a seed, not the suite the MVP exit criterion needs. It asks for a
median across a defined suite with no meaningful task-success regression, and
four paired runs cannot support a claim about a median or detect a small
regression. Decide the non-inferiority margin before growing this, so the number
of tasks is chosen to answer a stated question.
