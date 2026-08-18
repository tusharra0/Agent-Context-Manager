# Agent Context Manager instructions

## Mission

Build a local-first context-control layer for coding agents. The system should reduce repeatedly supplied context without materially reducing an agent's ability to complete coding tasks correctly.

## Read order

Before changing architecture or behavior, read:

1. `docs/product-brief.md`
2. `docs/architecture.md`
3. The relevant file in `docs/lld/`
4. The relevant ADR in `docs/adr/`
5. `docs/research-findings.md` when changing compression, preservation, memory, or evaluation behavior

Do not load every document for an unrelated implementation task.

## Non-negotiable principles

- Remove information from active model context, not automatically from recoverable storage.
- Keep the core independent of Codex, Claude Code, Vercel, and any single model provider.
- Put provider- and harness-specific behavior behind adapters.
- Preserve provenance for user requirements, decisions, active failures, and working-state updates.
- Prefer deterministic reducers before model-assisted summaries.
- Keep active and unresolved failures detailed.
- Treat completed subtasks as candidates for folding, but retain outcomes and evidence references.
- Judge context reduction using task correctness and agent behavior, not token savings alone.
- Keep raw source code, messages, and tool output local by default.

## Current technical decisions

- TypeScript on Node.js 22 LTS
- pnpm workspace
- SQLite for structured local persistence when the event-store slice is implemented
- Content-addressed files for large raw artifacts
- Vercel AI SDK 7 `HarnessAgent` as the first multi-harness adapter
- Vercel Sandbox for hosted, isolated evaluation
- Vercel AI Gateway for optional model-assisted operations and model-call observability

Vercel harness packages are experimental. Only the Vercel adapter may import them; core packages must depend on the project-owned harness interface.

## MVP non-goals

- Repository-wide embeddings
- Semantic caching
- Cross-user memory
- Model routing logic beyond evaluation needs
- Complex dashboards
- Neural-activation pruning
- Training a custom model

## Quality bar

Run `pnpm check` before handing off a change. Add tests for observable behavior and preservation invariants. Do not claim token savings without reporting the corresponding correctness result.
