# Roadmap

## Phase 0: Repository foundation

- [x] Product brief
- [x] Research brief
- [x] High-level architecture
- [x] TypeScript and Node decision
- [x] Vercel integration decision
- [x] Strict TypeScript workspace
- [x] Starter domain schemas and tests
- [x] First vertical-slice LLD

## Phase 1: Lossless event reduction

- [x] Define stable event identifiers and serialization
- [x] Implement content hashing
- [x] Implement local raw artifact storage
- [x] Implement test-output reducer
- [x] Restore artifacts byte-for-byte
- [x] Deduplicate identical raw content
- [x] Record original and reduced token estimates
- [x] Add fixtures for success, one failure, many failures, malformed, and enormous output

## Phase 2: Working state and context assembly

- [x] Implement durable working-state transitions
- [x] Add provenance and supersession rules
- [x] Implement file-read deduplication
- [x] Implement search- and build-output reducers
- [x] Assemble context under a configurable budget
- [x] Add forced-compaction recovery probes

## Phase 3: Offline evaluation

- [x] Define experiment and result schemas
- [x] Replay raw versus managed observations
- [x] Measure next-action agreement
- [x] Measure critical-field preservation
- [x] Measure repeated work
- [x] Compare final task outcomes
- [x] Generate failure-driven policy reports

## Phase 4: Vercel harness integration

- [x] Define `AgentHarnessPort`
- [x] Add Vercel AI SDK `HarnessAgent` adapter
- [x] Normalize Codex events
- [x] Normalize Claude Code events
- [x] Verify session creation, streaming, interruption, and cleanup
- [x] Keep experimental packages isolated

## Phase 5: Vercel-hosted evaluation

- [x] Add Vercel Sandbox adapter
- [x] Materialize repository fixtures in isolated sandboxes
- [x] Run baseline and managed conditions
- [x] Add AI Gateway for selected model-assisted operations
- [x] Store sanitized aggregate results
- [x] Add a minimal Next.js experiment dashboard

## Exit criterion for the MVP

Demonstrate meaningful median input-token reduction on a defined coding-task suite without a statistically meaningful task-success regression, while maintaining extremely high recall for user requirements, active failures, modified files, and remaining work.
