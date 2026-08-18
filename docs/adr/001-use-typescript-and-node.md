# ADR 001: Use TypeScript and Node.js for the MVP

**Status:** Accepted
**Date:** August 16, 2026

## Context

The product must process structured agent events, integrate Codex and Claude Code, use Vercel's agent platform, maintain local state, and iterate quickly while the compression policy is still research-driven.

Rust was considered for a native proxy or high-performance standalone binary. Python was considered for its research ecosystem.

## Decision

Use TypeScript with Node.js 22 LTS as the primary MVP stack and pnpm as the workspace package manager.

Use Python later only for notebooks, benchmark preparation, statistical analysis, or model-training experiments. Add Rust only if profiling identifies a concrete native interception or throughput bottleneck.

## Reasons

- Vercel AI SDK and its harness adapters are TypeScript-first.
- The official Codex SDK is a TypeScript package.
- Anthropic provides an official TypeScript SDK and middleware.
- Event streams, schemas, and API payloads are naturally represented in TypeScript.
- One language reduces setup and debugging cost during early iteration.
- Node.js performance is sufficient for one local agent session and API-bound evaluation.

## Consequences

- Core code must use runtime validation for external JSON; compile-time types are insufficient.
- Experimental Vercel APIs must be isolated behind project-owned interfaces.
- A native single-binary distribution is deferred.
- Research scripts may eventually form a separate Python workspace.

## Reconsider when

- The primary product becomes a transparent low-level wrapper around arbitrary CLIs.
- Profiling shows text processing or interception overhead is material.
- A native binary becomes a distribution requirement rather than a preference.
