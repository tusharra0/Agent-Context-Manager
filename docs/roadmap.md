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

- [ ] Implement durable working-state transitions
- [ ] Add provenance and supersession rules
- [ ] Implement file-read deduplication
- [ ] Implement search- and build-output reducers
- [ ] Assemble context under a configurable budget
- [ ] Add forced-compaction recovery probes

## Phase 3: Offline evaluation

- [ ] Define experiment and result schemas
- [ ] Replay raw versus managed observations
- [ ] Measure next-action agreement
- [ ] Measure critical-field preservation
- [ ] Measure repeated work
- [ ] Compare final task outcomes
- [ ] Generate failure-driven policy reports

## Phase 4: Vercel harness integration

- [ ] Define `AgentHarnessPort`
- [ ] Add Vercel AI SDK `HarnessAgent` adapter
- [ ] Normalize Codex events
- [ ] Normalize Claude Code events
- [ ] Verify session creation, streaming, interruption, and cleanup
- [ ] Keep experimental packages isolated

## Phase 5: Vercel-hosted evaluation

- [ ] Add Vercel Sandbox adapter
- [ ] Materialize repository fixtures in isolated sandboxes
- [ ] Run baseline and managed conditions
- [ ] Add AI Gateway for selected model-assisted operations
- [ ] Store sanitized aggregate results
- [ ] Add a minimal Next.js experiment dashboard

## Exit criterion for the MVP

Demonstrate meaningful median input-token reduction on a defined coding-task suite without a statistically meaningful task-success regression, while maintaining extremely high recall for user requirements, active failures, modified files, and remaining work.
