# Product brief

## Product

**Name:** Agent Context Manager
**Category:** Local developer infrastructure for coding agents

## Problem

Long-running coding agents accumulate user messages, file reads, searches, terminal output, tests, tool calls, decisions, and repeated observations. Repeatedly supplying this entire history consumes tokens, increases cost and latency, and can bury important task state beneath low-value information.

The naive solutions are unsafe:

- Truncation can remove a requirement or unresolved failure.
- General summarization can preserve the gist while losing exact paths, dates, values, or negative constraints.
- A larger context window still costs more and can suffer from distraction.

## Goal

Reduce context consumed by coding agents without materially reducing their ability to complete coding tasks correctly.

The product must answer:

> How much context can a coding agent safely remove while preserving the information required to complete the task?

## Target user

A developer who uses Codex, Claude Code, or another tool-using coding agent on sessions that are long, tool-heavy, or span context compactions.

## Desired user experience

The developer enables Agent Context Manager and continues using the coding agent normally. The manager quietly:

1. Observes session events.
2. Stores recoverable raw observations.
3. Reduces repetitive and noisy information.
4. Maintains important structured working state.
5. Reassembles focused context.
6. Restores details when requested.
7. Reports whether efficiency improved without hurting success.

## MVP scope

1. Reduce noisy test, terminal, search, and repeated file-read output.
2. Maintain durable session working state.
3. Preserve raw observations as restorable artifacts.
4. Replay recorded trajectories with raw and reduced context.
5. Compare tokens, latency, next actions, state recall, and task outcomes.
6. Integrate Codex and Claude Code through a thin harness layer.
7. Run reproducible hosted evaluations in Vercel Sandbox.

## Non-goals for the MVP

- Repository-wide retrieval or embeddings
- Cross-user or organizational memory
- Semantic caching
- Neural model training
- A complex production dashboard
- Replacing the coding agent's own reasoning or permission system

## Core product rules

- Raw evidence is removed from immediate view, not silently destroyed.
- User requirements and project instructions have the highest retention priority.
- Active failures remain detailed until resolved.
- Completed work may be folded into outcome plus evidence.
- Different event types use different preservation schemas.
- Compression quality is measured behaviorally and by final task success.

## Success measurements

- Coding-task resolve rate and tests passed
- Input and output tokens
- Total model cost
- End-to-end latency and manager overhead
- Next-action agreement between raw and managed context
- Critical-fact and required-field preservation
- Recovery after forced compaction
- Repeated file reads, searches, and commands
- Full-context successes that become managed-context failures

An initial engineering target is a 30% reduction in median input tokens without a statistically meaningful reduction in task success and with extremely high preservation of user requirements, active failures, modified files, and remaining work. This is a target to test, not an assumed result.

## Vercel role

- AI SDK 7 `HarnessAgent`: common Codex and Claude Code adapter surface
- AI Gateway: optional model access, budgets, routing, and observability
- Vercel Sandbox: isolated evaluation runs
- Vercel hosting: a later experiment and reporting dashboard

Local source code and raw session content remain local by default.
