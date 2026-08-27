# ADR 007: Orchestrate hosted evaluation locally

**Status:** Accepted
**Date:** August 27, 2026

## Context

Phase 5 needs Vercel Sandbox and AI Gateway without turning the dashboard into
an unauthenticated code-execution endpoint or uploading local raw artifacts.
The evaluator already produces a deterministic result once paired evidence is
available.

## Decision

Run hosted evaluations from the trusted local ACM CLI. The CLI creates a fresh
Vercel Sandbox for each raw or managed condition, materializes an explicitly
configured public Git fixture at an exact commit, drives the project-owned
harness port, runs deterministic verification commands, and destroys the
sandbox.

The first hosted slice accepts exactly one replay checkpoint per case. This
keeps a case equivalent to one isolated task run while retaining Phase 3's
paired checkpoint metrics.

Only an allow-listed sanitized summary may be written to the dashboard data
file. Prompts, source code, tool inputs and outputs, actions, assertions,
artifact URIs, model responses, and failure details remain outside the hosted
dashboard.

The dashboard is read-only. It never starts a sandbox or accepts repository
URLs, commands, prompts, or credentials from HTTP requests.

## Consequences

- A live evaluation requires an authenticated Vercel CLI/project and explicit
  user invocation.
- Every condition begins from the same pinned repository revision.
- Raw and managed source evidence reaches the selected isolated sandbox but is
  not persisted by the dashboard.
- The dashboard can be deployed safely with an empty or sanitized result set.
- Multi-checkpoint live trajectories remain future work.
