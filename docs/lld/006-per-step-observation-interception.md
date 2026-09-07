# LLD 006: Per-step observation interception

**Status:** Implemented; hosted verification pending a paired run on long tasks
**Scope:** Phase 6 vertical slice
**Last updated:** September 7, 2026

## Objective

Put ACM on the context path the agent actually uses, so a reduced observation
stays reduced for every later model request in a session, and make the
resulting change measurable per model request rather than per turn.

## Package boundaries

```text
@acm/harness-port           ObservationInterceptor contract and record schema
@acm/observation-pipeline   Classification, reduction, recording, safety gates
@acm/vercel-harness         Builtin-tool overrides and sandbox execution
@acm/reducers               Deterministic parsers and reducers (unchanged)
@acm/event-store            Content-addressed artifacts and typed events
```

`@acm/harness-port` keeps its `@acm/core` and `zod` dependencies only, so the
contract stays usable from packages that must not depend on storage.

## Interception path

```text
agent tool call
      |
      v
host tool override (read | grep | bash)
      |
      v
sandbox execution -> raw bytes + exit code
      |
      v
ObservationInterceptor
      |  store artifact  -> classify -> reduce -> record typed event
      v
observation text -> harness transcript -> every later model request
```

The override is possible because `HarnessAgent` gives user tools precedence
over harness builtins on key collision and executes them on the host.

## Ordering rule

Raw evidence is stored before anything is removed from view. Every path that
cannot store it returns the raw observation. The interceptor never fails a tool
call it was asked to record; a fault degrades to raw and is stated in the
record.

## Safety gates

A reduction replaces an observation only when all of these hold.

| Gate                     | Failure outcome            |
| ------------------------ | -------------------------- |
| Artifact stored          | `raw-evidence-unavailable` |
| A classifier claimed it  | `no-reducer`               |
| Classifier did not throw | `failed`                   |
| Reducer did not throw    | `failed`                   |
| Session opened           | `raw-evidence-unavailable` |
| Typed event recorded     | `raw-evidence-unavailable` |
| `safeForContext` is true | `unsafe`                   |
| Reduction is smaller     | `not-smaller`              |
| Policy is `reduced`      | `not-requested`            |

`unsafe` is the ordinary case for a first file read: its reduction is metadata,
not content, so the file text is returned whole. A repeat read of identical
bytes folds to a duplicate reference, which is where the saving comes from.

## Bounds and encoding

Observations are bounded (64 KiB by default) because native tools bound their
own output; an unbounded baseline would not be the agent a developer runs, and
a saving measured against it would be inflated. Truncation backs off to a UTF-8
code-point boundary and states how many bytes were withheld and where the rest
lives. Only the shown prefix is validated as UTF-8; a prefix that is not
decodable makes the observation a binary reference rather than damaged text.

## Ordering and concurrency

Interception is serialized per interceptor. Tool calls can run in parallel, and
a duplicate-read lookup must not interleave with the record that would satisfy
it. Serializing also makes the recorded order reproducible across replays.

## Classification

| Tool                             | Observation     | Reducer                         |
| -------------------------------- | --------------- | ------------------------------- |
| `read`                           | `file_read`     | `file-read/exact-hash`          |
| `grep`                           | `search_result` | `search-result/ripgrep-json`    |
| `bash` with vitest JSON          | `test_result`   | `test-result/vitest-json`       |
| `bash` with `tsc --pretty false` | `build_result`  | `build-result/tsc-pretty-false` |

Classifiers may claim optimistically because every parser reports a
`parseStatus` and an incomplete parse is rejected by the safety gates. Claiming
wrongly costs parse time, never information.

Two cases are deliberately left unclassified rather than approximated. An
open-ended read range (`offset` with no `limit`) has no representation in the
observation schema, and a fabricated end line would be a false record. A `tsc`
run without a recorded exit code cannot distinguish a clean build from a
crashed compiler.

## Command output

The `bash` override keeps stdout alone whenever stderr is empty, so a reporter
writing clean JSON stays reducible. Once a command also writes to stderr,
fidelity wins and the combined text is used even though no parser will claim
it. A non-zero exit code is annotated on the returned text only when no
reduction carried it as a field, which keeps the annotation out of the evidence
the parsers read.

A missing file is reported without interception. It is not a file-read
observation, and recording the error text as that path's evidence would put a
false artifact into the record. The harness still emits its own tool-result
event for it.

## Measurement

`step-usage` events carry usage for one model request. A session-global curve
is built only when every completed turn reported usage for each of its steps;
one missing step would understate the run rather than merely omit part of it.
The curve reports total, peak, final, and mean input tokens, plus the
least-squares slope of input tokens over step index. A flat slope is a saving
applied once; a lower slope than the paired condition is a saving that
compounds.

Each observation record carries `rawTokenEstimate`, `observedTokenEstimate`,
and — whenever a reduction was computed — `reducedTokenEstimate` and
`reductionUsable`. Under the `raw` policy those last two describe what the
managed condition would have done with the same bytes, which is what makes the
reducible share of a run measurable from the baseline.

## Local measurement

`pnpm --filter @acm/observation-pipeline benchmark` replays one realistic
session through both policies and reports the tokens each puts into the
transcript. It needs no sandbox, credentials, or spend.

Each observation is counted in every request that follows it, because that is
where a compounding reduction appears and a turn total cannot show it. On the
committed session that is 41.1% fewer observation tokens when re-reads are
byte-identical and 23.6% when every file is edited between reads, which bounds
what deduplication contributes.

The estimate is ACM's own, not provider tokenization, and it counts tokens
rather than correctness. It answers whether the reduction compounds; it does not
answer whether the agent still finishes the task.

## Verification

Credential-free tests cover:

- First read whole, identical repeat folded to a reference
- The `raw` policy computing but never substituting a reduction
- Byte-for-byte restoration after a reduction replaced an observation
- Complete ripgrep search reduction
- Unclassified tools passing through with evidence but no typed event
- Non-UTF-8 output becoming a reference instead of damaged text
- Bounded output truncating on a code-point boundary and saying so
- A reduction larger than its source being refused
- Artifact-store, session, event-record, classifier, and reducer faults
  degrading to raw
- Concurrent identical reads producing exactly one reference
- An observation arriving after cancellation being recorded, not discarded
- Ripgrep command construction and argument quoting
- Sandbox session attachment, detachment, and absence
- The runner refusing a baseline that would reduce its own observations

## Acceptance criteria

- A reduced observation stays reduced in every later request of the session.
- No reduction is ever substituted without durable raw evidence.
- Both conditions traverse the same interception path.
- Per-step usage is recorded, or reported as unavailable — never as zero.
- `pnpm check` passes without credentials or network access.

## Running it hosted

A plan sets `observationInterception: "per-step"`. The plan decides in both
directions: an `off` plan never builds an interceptor even when one is
available, anything other than an explicit `per-step` is treated as off, and a
`per-step` plan with no interceptor fails rather than running without one.

`examples/phase6-suite` holds four paired plans against a pinned public revision
of this repository. Every verification command was checked against that revision
before they were committed, so no task is already solved and none starts from a
broken tree.

A fixture may state the command conventions that make its own output reducible.
Deterministic reducers only fold output they can parse, and an agent left to
itself runs `pnpm test` rather than a machine-readable reporter. The conventions
are appended identically to both conditions' prompts, so they are a declared
property of the experiment rather than an advantage for either arm.

## Not in this slice

- The harness preamble and prior transcript, which need the model-facing proxy
  described in ADR 008.
- A suite large enough to support a claim about a median, and the
  non-inferiority margin that would decide how large that is.
- The paired hosted run itself, which is the first step that costs money and the
  only one that reports provider-measured tokens and task outcomes.
