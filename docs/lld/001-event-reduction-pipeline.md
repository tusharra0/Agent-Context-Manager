# LLD 001: Lossless event-reduction pipeline

**Status:** Implementation ready
**Scope:** First vertical slice only
**Last updated:** August 17, 2026

## Objective

Accept a Vitest JSON result, store the original bytes losslessly, create a
deterministic typed reduction, persist the event and reduction metadata, and
restore the original bytes by artifact reference.

This slice proves the core product invariant without a live model, Codex,
Claude Code, Vercel credentials, or a dashboard:

> Removing an observation from active context must not remove the underlying
> evidence from recoverable storage.

## Research and platform validation

The design uses the following externally verified constraints:

- [Vitest reporters](https://vitest.dev/guide/reporters) provide a supported
  JSON reporter and `outputFile`. The first parser consumes that format rather
  than scraping colorized terminal output.
- [Node.js 22 SQLite](https://nodejs.org/download/release/v22.17.0/docs/api/sqlite.html)
  provides synchronous prepared statements but remains in active development.
  ADR 003 isolates it inside `@acm/event-store`.
- [Node.js file APIs](https://nodejs.org/api/fs.html) provide exclusive file
  creation, file synchronization, hard links, and rename operations needed for
  same-filesystem atomic publication.
- [CoACT](https://arxiv.org/abs/2607.02911) motivates later next-action replay,
  but Phase 1 only records the provenance needed for that evaluation.
- [ACON](https://arxiv.org/abs/2510.00615) motivates versioned reducers and
  preserving failed managed-context cases as future regressions.
- [The Sleeping Agent](https://arxiv.org/abs/2608.11775) demonstrates why typed
  required fields and explicit fidelity status are safer than gist quality.

These sources inform the design; their reported token reductions are not
treated as results for this project.

## Phase 1 decisions

1. Support one explicit input format: Vitest's JSON reporter output.
2. Preserve raw input as bytes before attempting UTF-8 decoding or parsing.
3. Keep failed-test names, locations, and failure messages detailed.
4. Fold passing tests to aggregate counts; do not retain every passing name in
   active context.
5. Mark a reduction as either ready for context or requiring restoration. A
   parse failure is not reported as safe compression.
6. Use opaque identifiers and a separate per-session sequence for ordering.
7. Use canonical JSON for persisted event payloads and reduced text.
8. Use one documented offline token estimator for both raw and reduced data.
9. Store artifacts before metadata. A metadata failure may leave an orphaned
   artifact, but it must never report a successful reduction.

## User-facing commands

```text
acm reduce test-output.json \
  --type test-result \
  --framework vitest \
  --format json \
  [--session <session-id>] \
  [--command <test-command>] \
  [--exit-code <integer>] \
  [--data-dir <path>]

acm restore artifact://sha256/<digest> \
  --output restored.json \
  [--data-dir <path>]

acm inspect event <event-id> [--data-dir <path>] [--json]
```

`--type test-result`, `--framework vitest`, and `--format json` are explicit in
Phase 1. Later adapters may infer them from normalized harness events, but the
core pipeline must not guess from a filename.

If `--session` is omitted, `reduce` creates a session. If it is supplied, the
session must already exist. The successful output includes the session ID,
event ID, sequence, reduction, artifact URI, content hash, estimator identity,
and token estimates.

The reduction command exits successfully when the reduction operation
succeeds, even when the captured test report represents failed tests. Test
failure is data, not a failure of `acm reduce`.

Exit behavior:

| Exit | Meaning                                                                             |
| ---: | ----------------------------------------------------------------------------------- |
|    0 | Artifact, event, and a context-ready reduction were recorded                        |
|    1 | Usage, storage, persistence, or integrity failure                                   |
|    2 | Artifact and metadata were recorded, but restoration is required before context use |

`restore` refuses to overwrite an existing output path. A later `--force`
option may add an explicit overwrite path, but silent replacement is outside
this slice.

## Data-directory resolution

Resolution order:

1. CLI `--data-dir`
2. `ACM_DATA_DIR`
3. `<home>/.acm`

The default layout is:

```text
<data-dir>/
  acm.sqlite3
  artifacts/
    sha256/ab/cd/<full-digest>
    tmp/<unique-temp-name>
```

If `ACM_ARTIFACT_DIR` is configured, both the artifact tree and its temporary
directory live beneath that root so publication remains on one filesystem.

## End-to-end flow

```text
Input file stream
  -> stream bytes to an artifact temporary file while calculating SHA-256
  -> synchronize and close the temporary file
  -> publish or reuse artifact at its content-addressed path
  -> decode as strict UTF-8 within the parser size bound
  -> validate and normalize the Vitest JSON report
  -> create a versioned event payload
  -> create a deterministic canonical-JSON reduction
  -> estimate raw and reduced tokens with the same estimator
  -> transactionally persist session/event/artifact/reduction metadata
  -> print the recorded envelope
```

The parser does not run until the artifact is durably visible. The SQLite
transaction does not begin until parsing and reduction have completed, keeping
the write transaction short.

## Workspace boundaries

```text
@acm/core
  JSON value and canonical serialization contracts
  identifiers and event schemas
  versioned test-result payload and reduction schemas

@acm/event-store
  ArtifactStore and MetadataStore project-owned interfaces
  local content-addressed artifact implementation
  node:sqlite metadata implementation and migrations

@acm/reducers
  Vitest JSON parser
  deterministic test-result reducer
  offline token estimator

@acm/cli
  argument parsing, configuration, orchestration, and presentation
```

`@acm/core` must not import filesystem, SQLite, Vitest, Vercel, harness, or
model-provider packages. `@acm/reducers` must not import a SQLite driver.

## Stable identifiers and ordering

Identifiers are opaque and generated with `crypto.randomUUID()`:

```text
ses_<uuid-without-hyphens>
evt_<uuid-without-hyphens>
```

Callers must not infer time or ordering from an identifier. Event order is the
integer `sequence`, allocated inside the metadata transaction and unique within
a session.

Required database invariant:

```text
UNIQUE(session_id, sequence)
```

`createdAt` is an ISO 8601 UTC timestamp with millisecond precision. Tests
inject an ID generator and clock; they do not depend on wall-clock values.

## Canonical JSON

Persisted payloads and `reducedText` use canonical JSON version
`acm-canonical-json@1`:

- Only JSON-compatible values are accepted.
- Object keys are sorted lexicographically by Unicode code point.
- Array order is preserved.
- Numbers must be finite; negative zero serializes as `0`.
- Strings use JSON escaping.
- Output is UTF-8 with no insignificant whitespace or trailing newline.

The artifact digest always hashes original input bytes. It is unrelated to
canonical metadata serialization.

## Core schemas

### JSON values

External data is validated at runtime before persistence. The persisted event
schema uses a recursive JSON-value schema rather than `unknown`.

```ts
type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
```

### Event envelope

```ts
type PersistedContextEventV1 = {
  schemaVersion: 1;
  id: string;
  sessionId: string;
  sequence: number;
  kind: 'test_result';
  createdAt: string;
  payload: TestResultObservationV1;
  rawArtifactUri: string;
  contentHash: string;
  byteLength: number;
};
```

The generic in-memory `ContextEvent` may continue to support other event kinds,
but every persisted payload must select a versioned runtime schema.

### Parsed observation

```ts
type TestCounts = {
  total?: number;
  passed?: number;
  failed?: number;
  skipped?: number;
  todo?: number;
};

type TestFailure = {
  testName: string;
  file?: string;
  line?: number;
  column?: number;
  expected?: string;
  actual?: string;
  failureMessages: string[];
  stackFrames: string[];
};

type ReductionDiagnostic = {
  code: string;
  message: string;
  jsonPath?: string;
};

type TestResultObservationV1 = {
  schemaVersion: 1;
  framework: 'vitest';
  sourceFormat: 'vitest-json';
  command?: string;
  exitCode?: number;
  success?: boolean;
  reportedCounts?: TestCounts;
  observedCounts?: TestCounts;
  failures: TestFailure[];
  diagnostics: ReductionDiagnostic[];
  parseStatus: 'complete' | 'partial' | 'opaque';
};
```

`reportedCounts` contains supported top-level fields from the reporter.
`observedCounts` is derived from assertion records. A mismatch is preserved as
a diagnostic; one value must not silently replace the other.

### Reduced representation

```ts
type ReducedTestResultV1 = {
  schemaVersion: 1;
  kind: 'test-result';
  framework: 'vitest';
  command?: string;
  exitCode?: number;
  success?: boolean;
  reportedCounts?: TestCounts;
  observedCounts?: TestCounts;
  failures: TestFailure[];
  diagnostics: ReductionDiagnostic[];
  evidence: {
    rawArtifactUri: string;
    contentHash: string;
    byteLength: number;
  };
  safeForContext: boolean;
};
```

Token estimates are metadata about the serialized reduction and therefore are
not embedded inside `reducedText`. This avoids making the estimate depend on a
representation that contains its own estimate.

## Reducer contract

The reducer remains pure with respect to storage. Its event already contains a
validated, normalized payload and raw artifact reference.

```ts
type ReductionResult = {
  sourceEventId: string;
  reducerId: string;
  reducerVersion: string;
  reducedText: string;
  rawArtifactUri: string;
  safeForContext: boolean;
  preservedFields: readonly string[];
  diagnostics: readonly ReductionDiagnostic[];
};

interface ContextReducer {
  readonly reducerId: string;
  readonly reducerVersion: string;
  readonly supportedKinds: readonly ContextEventKind[];
  reduce(event: ContextEvent): Promise<ReductionResult>;
}
```

The Vitest reducer identity is:

```text
reducerId: test-result/vitest-json
reducerVersion: 1.0.0
```

The reducer must:

1. Reject unsupported event kinds and payload versions.
2. Require a raw artifact URI and matching content hash metadata.
3. Return identical `reducedText` for identical validated event content and
   reducer version. Event IDs and timestamps are not included in reduced text.
4. List preserved fields as JSON Pointer paths.
5. Never fabricate missing expected or actual values.
6. Include every failed assertion and every failure message exposed by the
   supported Vitest JSON fields.
7. Carry every parser diagnostic into the reduction.
8. Set `safeForContext` to false for an opaque parse.

## Vitest JSON parser policy

Generate fixtures using the official reporter:

```text
pnpm vitest run --reporter=json --outputFile=<fixture-path>
```

Fixture generation commands and Vitest version are recorded beside the
fixtures. Generated fixtures are immutable inputs; tests must not regenerate
them during a normal test run.

Parser rules:

- Decode with `TextDecoder('utf-8', { fatal: true })`.
- Parse JSON once and validate supported fields at runtime.
- Preserve top-level result counts when present.
- Derive observed counts independently from assertion results.
- Preserve the complete Vitest `failureMessages` array for every failed
  assertion.
- Prefer `fullName` for `testName`, falling back deterministically to ancestor
  titles plus title.
- Preserve the suite `name` as the file and the assertion `location` when
  present.
- Extract stack-frame lines without removing them from their original failure
  messages.
- Populate `expected` and `actual` only for narrowly recognized, fixture-tested
  delimiters. The original failure message remains authoritative.
- Record unsupported or malformed claimed fields as diagnostics rather than
  silently coercing them.
- Ignore unknown additive fields only after recording their JSON paths in a
  diagnostic. They remain recoverable from the artifact.

Passing assertion names are intentionally omitted from the reduction after
their statuses contribute to counts. This is the first deterministic noise
reduction policy.

## Bounded parsing and conservative failure behavior

Phase 1 stores input of any size that can be streamed to disk, but only parses
inputs up to 16 MiB in memory.

| Condition                                     | Artifact           | Metadata                    | `safeForContext`                                        | CLI exit |
| --------------------------------------------- | ------------------ | --------------------------- | ------------------------------------------------------- | -------: |
| Valid supported Vitest JSON                   | Stored             | Full event and reduction    | `true`                                                  |        0 |
| Valid JSON with recoverable field diagnostics | Stored             | Partial event and reduction | policy-dependent; false if a required field is affected |   0 or 2 |
| Invalid JSON                                  | Stored             | Opaque event and diagnostic | `false`                                                 |        2 |
| Malformed UTF-8                               | Stored             | Opaque event and diagnostic | `false`                                                 |        2 |
| Input exceeds parser bound                    | Stored             | Opaque event and diagnostic | `false`                                                 |        2 |
| Artifact storage failure                      | Not guaranteed     | No success record           | n/a                                                     |        1 |
| Metadata transaction failure                  | Stored or orphaned | Rolled back                 | n/a                                                     |        1 |
| Restore hash mismatch                         | Unchanged          | Integrity error             | n/a                                                     |        1 |

An opaque event contains metadata and diagnostics, not a misleading summary.
Future context assembly must include the raw observation or invoke restoration
before treating such an event as reduced.

## Artifact store contract

```ts
type StoredArtifact = {
  uri: string;
  algorithm: 'sha256';
  digest: string;
  byteLength: number;
  reused: boolean;
};

interface ArtifactStore {
  put(source: NodeJS.ReadableStream): Promise<StoredArtifact>;
  open(uri: string): Promise<NodeJS.ReadableStream>;
  verify(uri: string): Promise<StoredArtifact>;
  restore(uri: string, outputPath: string): Promise<void>;
}
```

URI and path:

```text
artifact://sha256/<64-lowercase-hex-digest>
<artifact-root>/sha256/ab/cd/<full-digest>
```

The URI parser accepts only the exact scheme, algorithm, and digest grammar.
The digest is never used as a path until validation succeeds.

### Publication algorithm

1. Create a unique temporary file beneath `<artifact-root>/tmp` with exclusive
   creation.
2. Stream input once, updating SHA-256 and byte count while writing.
3. Synchronize and close the complete temporary file.
4. Create the digest fan-out directories.
5. Atomically create a hard link from the complete temporary file to the final
   digest path.
6. If the final path already exists, verify its bytes and reuse it.
7. Remove the temporary name.
8. Verify the published file's digest before returning success.

The hard-link publication step never overwrites an existing artifact and only
exposes a complete file. An unsupported filesystem is a storage error in Phase
1; a weaker non-atomic fallback is not silently selected.

Restoration streams into a temporary sibling of the requested output, verifies
the digest, then publishes without replacing an existing file. Failed restore
attempts remove their temporary file and leave the destination unchanged.

## Metadata store

ADR 003 selects `node:sqlite`, isolated behind this contract:

```ts
interface MetadataStore {
  createSession(input: CreateSessionInput): SessionRecord;
  recordReduction(input: RecordReductionInput): RecordedReduction;
  getEvent(eventId: string): RecordedEvent | undefined;
  close(): void;
}
```

Schema version 1:

```sql
CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
) STRICT;

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE artifacts (
  uri TEXT PRIMARY KEY,
  algorithm TEXT NOT NULL CHECK (algorithm = 'sha256'),
  digest TEXT NOT NULL UNIQUE,
  byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE events (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  schema_version INTEGER NOT NULL,
  kind TEXT NOT NULL,
  created_at TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  raw_artifact_uri TEXT NOT NULL REFERENCES artifacts(uri),
  byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
  payload_json TEXT NOT NULL,
  UNIQUE (session_id, sequence)
) STRICT;

CREATE TABLE reductions (
  event_id TEXT PRIMARY KEY REFERENCES events(id),
  reducer_id TEXT NOT NULL,
  reducer_version TEXT NOT NULL,
  reduced_text TEXT NOT NULL,
  safe_for_context INTEGER NOT NULL CHECK (safe_for_context IN (0, 1)),
  original_token_estimate INTEGER NOT NULL CHECK (original_token_estimate >= 0),
  reduced_token_estimate INTEGER NOT NULL CHECK (reduced_token_estimate >= 0),
  token_estimator_id TEXT NOT NULL,
  preserved_fields_json TEXT NOT NULL,
  diagnostics_json TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;
```

Startup enables foreign keys, configures a bounded busy timeout, and applies
forward-only migrations in a transaction. Application schemas validate every
JSON column on write and read; the database does not depend on SQLite JSON
extensions.

`recordReduction` uses one immediate transaction to:

1. Verify the session exists.
2. Insert or validate artifact metadata.
3. Allocate the next session sequence.
4. Insert the event.
5. Insert the reduction.
6. Commit.

Any failure rolls back the metadata transaction. Content-addressed artifact
files are immutable and are not deleted during rollback.

## Token estimation

Phase 1 uses:

```text
estimatorId: utf8-bytes-div-4@1
estimate = ceil(UTF-8 byte length / 4)
```

The original estimate uses raw byte length. The reduced estimate uses the UTF-8
byte length of canonical `reducedText`. The approximation is intentionally
simple, offline, deterministic, and versioned.

These values support pipeline tests and preliminary comparisons. They are not
provider-exact token counts, and the CLI must not describe their difference as
validated cost savings. Counts from different estimator IDs must never be
compared as equivalent.

## Determinism boundary

Given the same:

- raw bytes,
- parser version,
- explicit command and exit-code metadata,
- reducer version, and
- estimator version,

the normalized payload, reduced text, preserved-field list, diagnostics, and
token estimates must be identical. IDs, sequence, timestamps, filesystem path,
and the `reused` flag are intentionally outside that determinism guarantee.

## Required fixtures

Fixtures are grouped by parser version and include a short provenance file:

```text
packages/reducers/test/fixtures/vitest-json/v1/
  provenance.md
  all-pass.json
  one-failure.json
  several-failures.json
  expected-actual.json
  no-summary-counts.json
  truncated.json
  malformed-utf8.bin
  very-large.json
```

Artifact-store tests create their own byte fixtures in a temporary directory
and include duplicate and concurrent writes.

## Required tests

### Core

- Identifier validation and opaque ordering behavior
- Versioned event payload validation
- JSON-only payload rejection for unsupported values
- Canonical serialization stability across object insertion orders
- Reduced-result schema validation

### Artifact store

- Byte-for-byte restore
- Stable SHA-256 URI
- Duplicate artifact reuse
- Concurrent identical writes
- Existing corrupt artifact rejection
- Invalid URI and path-traversal rejection
- Destination non-overwrite
- Temporary-file cleanup after failures
- Large streamed input without whole-file buffering

### Metadata store

- Migration from an empty database
- Foreign-key enforcement
- Monotonic per-session sequence allocation
- Transaction rollback on event or reduction failure
- Artifact metadata deduplication
- JSON validation on read and write
- Reopen and inspect persisted events

### Parser and reducer

- All-pass counts with no retained passing names
- Every failed assertion retained
- Exact failure-message preservation
- Expected/actual extraction only for supported fixtures
- File, line, and column preservation
- Reported-versus-observed count mismatch diagnostics
- Unknown-field diagnostics
- Deterministic canonical reduction
- Unsupported kind and payload-version rejection
- Invalid JSON, malformed UTF-8, truncated, and oversized conservative behavior
- Original and reduced estimates recorded under one estimator ID

### CLI integration

- Reduce then restore a real Vitest fixture
- Repeated reduce reuses the artifact but records a new event
- Inspect returns the stored event and reduction
- Opaque parse exits 2 and remains restorable
- Storage or database failure never prints success

## Implementation sequence

1. Extend `@acm/core` with JSON, identifier, versioned test-result, canonical
   serialization, and reduction schemas.
2. Create `@acm/event-store` and implement the artifact store with invariants.
3. Implement SQLite migration and metadata-store integration.
4. Capture immutable Vitest JSON fixtures.
5. Implement the Vitest parser, reducer, and token estimator.
6. Add CLI configuration plus `reduce`, `restore`, and `inspect event`.
7. Run integration tests and document a manual reduce/restore walkthrough.
8. Run `pnpm check` before handoff.

Each step should land with its observable tests; the pipeline should not defer
all integration risk to the final CLI step.

## Acceptance criteria

- `pnpm check` passes.
- The CLI reduces and restores at least one real Vitest JSON fixture.
- No model, network request, credential, Codex process, Claude process, or
  Vercel dependency is required.
- Raw input is never deleted by reduction.
- Restored bytes exactly match input bytes.
- Identical inputs reuse one immutable artifact.
- All failed assertions and supported exact fields are preserved.
- Every reduction references its raw artifact and records fidelity status.
- Opaque input is never labeled safe for context.
- Documentation explains how to inspect the stored event and artifact.

## Deferred

- Vitest terminal, minimal/agent, JUnit, TAP, pytest, and other parsers
- Streaming JSON parsing beyond the Phase 1 bound
- Live harness integration
- Model-assisted summaries
- Durable working-state updates
- Context assembly
- Next-action replay and final-task evaluation
- Artifact garbage collection
- Vercel Sandbox execution
- Hosted result synchronization
