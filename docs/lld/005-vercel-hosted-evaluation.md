# LLD 005: Vercel-hosted evaluation

**Status:** Implemented
**Scope:** Phase 5 vertical slice
**Last updated:** August 27, 2026

## Objective

Execute paired raw and managed coding tasks in isolated Vercel Sandboxes, feed
their normalized traces into the Phase 3 evaluator, and publish only sanitized
aggregate measurements to a minimal read-only Next.js dashboard.

## Boundaries

```text
@acm/hosted-evaluation  Stable hosted plan, runner, and sanitization
@acm/vercel-harness     Vercel Sandbox and HarnessAgent implementation
@acm/evaluation         Existing evidence conversion and paired evaluator
@acm/cli                Trusted local orchestration entry point
@acm/dashboard          Read-only sanitized experiment display
```

Only `@acm/vercel-harness` imports the experimental Sandbox and harness
packages. The hosted orchestrator depends on project-owned ports.

## Hosted plan

A versioned plan contains an offline evaluation experiment plus:

- A public HTTPS Git repository URL
- An exact 40-character commit revision matching the experiment fixture
- Optional deterministic setup commands
- One or more deterministic verification commands with stable assertion IDs
- Harness and model selection
- A context source: legacy recorded candidates or typed reducer inputs

The MVP hosted runner requires one checkpoint per case. Raw and managed
conditions receive the same task, fixture, model, verification oracle, and
checkpoint cutoff. Only their rendered context differs.

In `typed-reducers` mode, each raw observation has an explicit input kind and
parser metadata. Plan preparation verifies its SHA-256 digest, invokes the real
deterministic parser and reducer, reconciles stale file observations and
resolved failures, and replaces the plan's supplied managed candidate. Unsafe
or partial parses retain the verified raw text in managed context. The legacy
`recorded-candidates` mode is retained for existing replay fixtures.

## Sandbox lifecycle

Each condition uses a fresh sandbox. Before the harness starts, the adapter:

1. Initializes an empty Git worktree in the harness session directory.
2. Fetches only the configured commit from the configured public repository.
3. Checks out the detached commit and verifies the exact SHA.
4. Runs configured setup commands sequentially and fails on the first non-zero
   exit.

After the agent turn, verification commands run in the same worktree. Their
exit codes determine the task outcome. One abort signal covers session creation,
setup, streaming, verification, and workspace capture. A stream without a
completed terminal event fails the condition. Session and sandbox cleanup runs
in `finally`.

Before creating a remote runner, the CLI validates the complete plan, validates
an existing dashboard dataset, checks dashboard-directory writability, and
reserves result, summary, and trace paths without overwriting them. Raw
observations enter the local content-addressed artifact store. Commands and
normalized harness events, including tool outputs and failures, are appended to
a private JSONL journal and synced during execution. A failed run keeps that
journal and writes an error envelope to the private result path; it does not
publish a summary.

## AI Gateway

Codex and Claude Code adapters use `ai-gateway` authentication for hosted runs.
Deployed Vercel workloads receive OIDC automatically. Local runs obtain a
short-lived OIDC value through the linked Vercel project. Provider keys are not
written into plan or result files.

## Sanitization

The dashboard summary allow-list contains only:

- Experiment, fixture, policy, and estimator IDs
- Creation time and pass/fail status
- Harness/model labels
- Aggregate estimated context reduction, measured input-token coverage and
  reduction, agreement, recall, success, recovery, and
  repeated-work counts
- Policy-failure counts grouped by failure kind

It excludes case tasks, prompts, actions, outcomes' assertion evidence,
critical values, source event IDs, raw/managed measurements by case, and all
tool content.

Measured input-token fields are null unless both paired conditions provide one
complete final usage record. Repeated-action fields are null when tool-time
workspace revisions are unavailable. The current adapter can evaluate a paired
checkpoint, but cannot continuously replace the native harness context during a
multi-turn trajectory.

## Verification

Credential-free tests cover plan validation, paired orchestration with fake
condition runners, equal fixture/task inputs, cleanup behavior, result
sanitization, typed reducer preparation, preflight output reservation, durable
failure traces, fixture command construction, timeout cancellation, and
dashboard view models. The authenticated `acm hosted run` command is the gated
live smoke path for real Sandbox and HarnessAgent integration.
