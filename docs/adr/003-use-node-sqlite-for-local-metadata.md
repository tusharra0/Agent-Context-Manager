# ADR 003: Use the Node.js SQLite module for local metadata

**Status:** Accepted
**Date:** August 17, 2026

## Context

The first event-reduction slice needs transactional local persistence for
sessions, artifact metadata, normalized events, and reductions. The raw bytes
remain in a content-addressed filesystem store; SQLite stores structured
metadata and provenance.

The project targets Node.js 22 LTS and is local-first. Candidate drivers were:

- Node's built-in `node:sqlite` `DatabaseSync`
- `better-sqlite3`
- an asynchronous native SQLite package
- a pure JavaScript or WebAssembly SQLite implementation

Node's SQLite module was added in Node 22.5 and remains marked active
development in the
[Node 22 documentation](https://nodejs.org/download/release/v22.17.0/docs/api/sqlite.html).
It provides the prepared statements and synchronous transaction behavior this
single-process local CLI needs.

`better-sqlite3` has a mature API and broad usage, but it adds a native addon,
platform-specific prebuilds, install-script approval, and source-build failure
modes. Those distribution costs do not buy a needed capability in the first
slice.

## Decision

Use `node:sqlite` `DatabaseSync` for the first local metadata-store
implementation.

The dependency is isolated inside `@acm/event-store` behind a project-owned
`MetadataStore` interface. No `node:sqlite` type may appear in `@acm/core`,
`@acm/reducers`, the harness port, or public domain schemas.

Raise the effective minimum runtime to Node.js 22.13 before implementing the
package. This version exposes the module without the earlier command-line
feature flag and is still within the existing Node 22 LTS decision. Development
and CI should pin a specific current Node 22 patch rather than the floating
major alone.

Use synchronous database calls intentionally. The first product serves one
local agent session, writes small metadata records, and performs raw artifact
I/O outside the database transaction. Transactions must be short and no raw
artifact bytes are stored as SQLite blobs.

## Operational policy

- Enable foreign-key enforcement.
- Use prepared statements for all values.
- Use `STRICT` tables and application-level Zod validation.
- Set a bounded busy timeout.
- Apply forward-only, versioned migrations transactionally.
- Allocate per-session event sequence numbers inside an immediate transaction.
- Keep the database private to `@acm/event-store`; callers use domain records.
- Do not enable arbitrary SQLite extensions.

## Consequences

- Phase 1 needs no third-party native SQLite dependency or install script.
- The CLI may emit Node's experimental-feature warning on Node 22 releases
  where the runtime still does so.
- Upstream API changes are localized to one adapter.
- Synchronous calls are acceptable for the current single-session CLI but
  should not be assumed suitable for a future concurrent server.
- `package.json`, `.node-version`, `.nvmrc`, CI, and `doctor` must agree on the
  supported Node 22 patch floor when implementation begins.

## Rejected alternatives

### `better-sqlite3`

Rejected for Phase 1 because the native addon and install lifecycle increase
cross-platform distribution risk. Reconsider if the built-in API proves
unstable, lacks a required feature, or benchmarks show a material problem.

### Asynchronous native SQLite packages

Rejected because they retain native distribution costs while adding callback
or worker coordination that the short local transactions do not require.

### Pure JavaScript or WebAssembly SQLite

Rejected because they add packaging and persistence semantics without a current
portability requirement that justifies them.

### JSON files instead of SQLite

Rejected because session ordering, multi-record atomicity, migrations, and
queryable evaluation provenance are immediate requirements rather than future
possibilities.

## Reconsider when

- `node:sqlite` changes incompatibly or remains operationally noisy after the
  MVP.
- The application becomes a concurrent daemon or hosted multi-user service.
- Packaging targets a Node version without the built-in module.
- A single-binary distribution or browser runtime becomes a requirement.
- Profiling identifies database calls as meaningful manager overhead.
