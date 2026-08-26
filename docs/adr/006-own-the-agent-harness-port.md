# ADR 006: Own the agent harness port

**Status:** Accepted
**Date:** August 26, 2026

## Context

Phase 4 integrates Codex and Claude Code through Vercel AI SDK 7
`HarnessAgent`. The harness packages are experimental and their session,
streaming, and sandbox APIs may change independently of ACM's event, state, and
evaluation contracts.

Allowing those package types into core packages would make experimental API
changes architectural changes rather than localized adapter maintenance.

## Decision

Define a project-owned `AgentHarnessPort` in `@acm/harness-port`. It owns the
stable session lifecycle, normalized stream events, interruption, and cleanup
contracts used by the rest of ACM.

Only `@acm/vercel-harness` may import `@ai-sdk/harness`,
`@ai-sdk/harness-codex`, or `@ai-sdk/harness-claude-code`. That package pins
exact dependency versions. It translates vendor stream parts into versioned ACM
events and accepts a sandbox provider through dependency injection.

Vercel Sandbox construction, repository materialization, and hosted execution
remain Phase 5 responsibilities.

## Consequences

- Core packages remain provider- and harness-independent.
- Codex and Claude Code share one contract and contract-test suite.
- Vendor API churn is localized to one adapter package.
- Phase 4 can test lifecycle and normalization without credentials.
- A live run still requires a concrete sandbox provider and Vercel
  authentication.
