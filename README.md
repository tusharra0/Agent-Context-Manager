# Agent Context Manager

Agent Context Manager is a local-first context-control layer for coding agents such as Codex and Claude Code.

It stores a lossless session record outside the model's immediate prompt, reduces noisy observations with type-specific rules, maintains durable working state, and assembles focused context for each model call. Its purpose is not to minimize tokens at any cost; it is to find how much context can be safely removed while preserving coding-task success.

## Current status

Early development. The repository currently contains a verified TypeScript workspace, starter domain schemas, a reducer contract, and a small environment-checking CLI.

## Requirements

- Node.js 22 LTS or later
- pnpm 10 or later
- Git

## Setup

```bash
corepack enable
pnpm install
pnpm check
pnpm run doctor
```

Copy `.env.example` to `.env.local` only when beginning an integration that requires credentials. The initial core and tests require no API keys.

## Useful commands

```bash
pnpm build          # compile every workspace package
pnpm typecheck      # strict TypeScript checks
pnpm test           # run unit tests
pnpm format         # format source and documentation
pnpm format:check   # check formatting without edits
pnpm check          # formatting, types, tests, and build
pnpm run doctor     # verify the local project environment
pnpm dev            # run the starter CLI in watch-friendly mode
```

## Repository layout

```text
apps/cli/          Local command-line entry point
packages/core/     Stable domain schemas and types
packages/reducers/ Reducer contracts and future implementations
```

Additional packages should be created when their implementation starts, not merely to mirror a future diagram.
