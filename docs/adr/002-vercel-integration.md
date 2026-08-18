# ADR 002: Use Vercel as the harness and hosted-evaluation platform

**Status:** Accepted with an experimental-API boundary
**Date:** August 16, 2026

## Context

Agent Context Manager must support Codex and Claude Code through a common integration while remaining agent-independent. It also needs repeatable isolated evaluation and observable optional model calls.

Vercel AI SDK 7 exposes experimental `HarnessAgent` adapters for Codex and Claude Code. Vercel Sandbox can execute coding harnesses in isolated ephemeral environments, and AI Gateway can provide unified model access and observability.

## Decision

Use:

- Vercel AI SDK 7 `HarnessAgent` as the first multi-harness integration.
- Vercel Sandbox for hosted benchmark and evaluation execution.
- Vercel AI Gateway for optional model-assisted state extraction, summarization, judging, and cross-model experiments.
- Vercel hosting for a later sanitized experiment dashboard.

Preserve a local-first mode that does not upload raw source code, messages, or tool output by default.

## Boundary

Define a stable internal `AgentHarnessPort`. Only the Vercel adapter may import experimental packages such as:

```text
@ai-sdk/harness
@ai-sdk/harness-codex
@ai-sdk/harness-claude-code
@ai-sdk/sandbox-vercel
```

The core may depend only on internal event and harness contracts.

## Consequences

- Vercel is a meaningful product dependency rather than decorative hosting.
- The same evaluation flow can select Codex or Claude Code.
- Hosted evaluation gains isolation and reproducibility.
- Experimental adapter changes should be localized.
- Privacy boundaries and opt-in hosted execution must be explicit.

## Reconsider when

- HarnessAgent no longer exposes the events needed for context observation or replacement.
- Experimental churn makes the adapter unmaintainable.
- Hosted evaluation cannot satisfy repository privacy requirements.
