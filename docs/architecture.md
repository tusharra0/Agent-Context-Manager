# High-level architecture

## Design objective

Keep the context-management core independent of agent harnesses and model providers while preserving enough provenance and raw evidence to audit every reduction.

## System view

```text
Codex / Claude Code
        |
        v
Harness adapter
        |
        v
Normalized event recorder -----------------------+
        |                                        |
        v                                        |
Lossless event metadata + raw artifact store     |
        |                                        |
        +------------------+                     |
        |                  |                     |
        v                  v                     |
Typed reducers       Working-state updater       |
        |                  |                     |
        +---------+--------+                     |
                  |                              |
                  v                              |
           Context assembler                     |
                  |                              |
                  v                              |
            Coding agent                         |
                  |                              |
                  +------ restore(artifact) ------+
```

## Components

### Harness adapter

Converts harness-specific messages, tool calls, and results into internal events. The first implementation will use Vercel AI SDK 7 `HarnessAgent` adapters for Codex and Claude Code.

The project owns a stable `AgentHarnessPort`. Experimental Vercel packages must not leak into core types.

### Event recorder

Assigns ordered event IDs and records timestamps, event kind, session ID, payload metadata, token estimates, hashes, and artifact references.

The event sequence is append-oriented. Corrections are represented as later events rather than destructive edits to history.

### Raw artifact store

Stores large original observations by content hash. Examples include full test logs, terminal output, file snapshots, and search results.

Properties:

- Byte-for-byte restoration
- Deduplication
- Integrity verification
- Local by default
- A stable artifact URI in reduced context

### Observation interceptor

Sits between a tool's execution and the agent's transcript. It stores the raw
observation, classifies it, reduces it, and returns the reduced text as the
tool result, so the saving persists across the session instead of being
overwritten by the harness's own history.

Both experimental conditions traverse this path. Under the raw policy the
reduction is computed and recorded but never substituted, so the conditions
differ in one decision and the reducible share of a run stays measurable from
the baseline.

### Typed reducers

Replace raw observations with smaller representations. Each reducer declares:

- Supported event kinds
- Required preserved fields
- Deterministic or model-assisted behavior
- Original and reduced token estimates
- Evidence or artifact reference

Deterministic reducers are preferred for tests, exit codes, hashes, counts, and exact deduplication.

### Durable working-state manager

Maintains a structured task handoff containing:

- Goal
- User requirements and constraints
- Decisions and reasons
- Files read and modified
- Current and resolved failures
- Test status
- Remaining work

Every important value contains provenance and status. State is stored separately from raw conversation history.

### Context assembler

Builds the active input under a configurable token budget. Priority order:

1. System, user, and project instructions
2. Active requirements and constraints
3. Current failures and remaining work
4. Relevant working state
5. Recent actions and observations
6. Folded older outcomes and artifact references

### Evaluation recorder

Records experimental condition, harness, model, repository fixture, task outcome, tests, tokens, latency, repeated work, next-action agreement, fact preservation, and recovery results.

Estimated checkpoint reduction and provider-reported input-token reduction are
separate measurements. Missing provider usage and missing authoritative
tool-time workspace revisions remain unknown rather than becoming zero.

## Data classes and default policy

| Class                | Examples                              | Default policy                                        |
| -------------------- | ------------------------------------- | ----------------------------------------------------- |
| Pinned instruction   | User requirement, repository rule     | Preserve verbatim or as validated normalized state    |
| Active state         | Current failure, next step            | Keep detailed                                         |
| Evidence             | Search hit, code read, stack trace    | Extract required fields and retain artifact reference |
| Completed trajectory | Finished investigation                | Fold to outcome, impact, and evidence                 |
| Replayable noise     | Repeated success logs, duplicate read | Remove from active context after durable recording    |

## Vercel deployment boundary

### Local developer mode

- Core process, SQLite, and artifacts run locally.
- Harness execution may be local.
- AI Gateway use is optional and explicit.
- No raw session upload occurs merely to use the CLI.

### Hosted evaluation mode

- A repository fixture is materialized in Vercel Sandbox.
- A selected harness runs the baseline or managed condition.
- Typed hosted plans derive managed candidates from raw observations with the
  same deterministic reducers used by the local pipeline.
- Tests and evaluation probes run inside the sandbox.
- Aggregated results may be sent to a hosted dashboard.
- Raw observations and streamed execution evidence stay in private local
  artifacts and journals; only explicit plan context reaches the sandbox.

## Internal package boundaries

```text
@acm/core             Domain schemas and types
@acm/reducers         Reducer contracts and implementations
@acm/event-store      SQLite metadata and raw artifacts
@acm/working-state    Durable state transitions
@acm/context-assembler
@acm/harness-port     Stable internal adapter interface
@acm/observation-pipeline  Per-step observation interception
@acm/vercel-harness   Experimental Vercel integration boundary
@acm/evaluation       Experiment definitions and metrics
```

Only create a package when its vertical slice starts.

The core, reducers, event store, working-state, context assembler, offline
evaluation, harness adapter, hosted evaluation, and observation pipeline
packages are implemented.

Observations are now reduced on the per-step context path: host-executed tools
shadow the harness's own builtins, so a reduced observation stays reduced in
every later model request of a session rather than only the first. The harness
preamble and prior transcript remain outside ACM's reach; reaching them needs
the model-facing proxy described in ADR 008.

## Architectural risks

- Harness APIs are experimental and may change.
- An adapter may observe events but lack authority to replace all context supplied by a native CLI.
- Model-assisted summaries may hallucinate or omit exact information.
- Local repositories may contain sensitive data.
- Token estimation differs between providers.
- A next-action match does not guarantee final task success.

These risks are addressed with adapter isolation, deterministic extraction, typed validation, local-first storage, multiple evaluation gates, and final task-outcome comparison.
