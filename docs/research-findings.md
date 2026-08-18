# Research findings

**Reviewed:** August 2026

This document separates research evidence from product decisions. Recent arXiv papers are promising but are not automatically treated as settled results. Peer-reviewed work and official engineering guidance are labeled separately.

## Glossary

- **Context:** Information sent to a model for its next decision.
- **Observation:** Information returned after the agent uses a tool.
- **Trajectory:** The sequence of actions and observations during a task.
- **Compression:** Replacing a large context item with a smaller representation.
- **Compaction:** Reducing an accumulated conversation or trajectory so work can continue.
- **Durable working state:** Structured task state stored separately from conversation history.
- **Provenance:** A record of where a retained fact came from.
- **ReAct:** Reason + Act, an agent loop alternating reasoning, actions, and observations.
- **SWE-bench Verified:** A benchmark of real software-engineering issues with verified tests.
- **NAP:** Next-Action Preservation.

## CoACT

**Source:** [CoACT: Action-Preserving Observation Compression for Coding Agents](https://arxiv.org/abs/2607.02911)
**Date/status:** July 2026 arXiv preprint
**Authors:** Haorui Chen, Yuancheng Zhu, Yitong Zhang, and Jia Li

The title describes the key concept as action-preserving observation compression. The arXiv page does not give a separate official letter-by-letter expansion for “CoACT,” so the project should not invent one.

CoACT asks whether a compressed tool observation leads the agent to choose the same next action as the original observation. It trains a lightweight compressor from candidates rewarded for both action preservation and shorter length.

The paper reports a 33.0% average reduction in total token consumption on SWE-bench Verified while maintaining task-solving effectiveness close to its uncompressed agents.

### Product use

- Replay an agent state with raw and reduced observations.
- Compare requested tools, files, commands, and stated next steps.
- Treat material action divergence as a compression warning.
- Do not assume that a fluent-looking summary is safe.

## ACON

**Source:** [ACON: Optimizing Context Compression for Long-horizon LLM Agents](https://arxiv.org/abs/2510.00615)
**Status:** Listed as ICML 2026
**Authors:** Minki Kang, Wei-Ning Chen, Dongge Han, Huseyin A. Inan, Lukas Wutschitz, Yanzhi Chen, Robert Sim, and Saravan Rajmohan

**ACON** means **Agent Context Optimization**.

ACON studies paired trajectories where full context succeeds but compressed context fails. A capable model diagnoses the missing information and updates natural-language compression guidelines. The optimized compressor can then be distilled into a smaller model.

The paper reports 26-54% lower peak token usage across AppWorld, OfficeBench, and multi-objective question answering while improving over the compression baselines it tested.

### Product use

- Version compression policies.
- Make every full-context success that becomes a managed-context failure a regression case.
- Diagnose the lost fact or relationship.
- Propose and review a new preservation rule.

## SWE-MeM

**Source:** [SWE-MeM: Learning Adaptive Memory Management for Long-Horizon Coding Agents](https://arxiv.org/abs/2606.28434)
**Date/status:** June 2026 arXiv preprint

**SWE** means Software Engineering. **MeM** refers to the paper's adaptive memory-management system.

SWE-MeM gives the coding agent a memory tool so it can decide when, what, and how to compress based on trajectory state, progress, and remaining context. It jointly trains issue resolution and memory management.

The paper reports SWE-bench Verified resolve rates of 43.4% for a 4B model and 60.2% for a 30B model, outperforming the memory baselines in its evaluation.

### Product use

Later versions may expose operations such as:

```text
pin(fact, reason)
fold_steps(start, end, outcome, remaining_work)
archive_observation(event_id)
restore(artifact_id)
```

The host must still protect pinned requirements and unresolved failures. Agent-directed memory is not required for the first slice.

## Context-Folding

**Source:** [Scaling Long-Horizon LLM Agent via Context-Folding](https://arxiv.org/abs/2510.11967)
**Date/status:** October 2025 arXiv preprint

Context-Folding lets an agent branch into a subtask and collapse the internal steps into a concise outcome when that subtask is complete.

The paper reports matching or outperforming its ReAct baselines on deep-research and software-engineering tasks while using an active context approximately ten times smaller.

### Product use

- Keep active and unresolved work detailed.
- Fold completed work to outcome, impact, changed files, and evidence references.
- Do not retain thousands of tokens from a completed investigation solely because they occurred earlier.

## SWE-Pruner Pro

**Source:** [SWE-Pruner Pro: The Coder LLM Already Knows What to Prune](https://arxiv.org/abs/2607.18213)
**Date/status:** July 2026 arXiv preprint

SWE means Software Engineering. The pruner uses a small prediction head over an open coding model's internal representations to label tool-output lines as keep or prune.

The paper reports savings of up to 39% of prompt and completion tokens across two open-weight models and four multi-turn benchmarks while preserving task quality.

### Product use

Treat activation-based pruning as future optional local-model work. It requires model internals and is unsuitable as the model-independent MVP core.

## The Sleeping Agent

**Source:** [The Sleeping Agent: What Gist-Based Context Compression Loses and Why](https://arxiv.org/abs/2608.11775)
**Date/status:** August 12, 2026 single-author arXiv preprint; useful failure analysis that should be replicated

The paper uses Salience-Weighted Consolidation as a diagnostic probe. Its general gist compression often deleted dates and times even while preserving the overall story.

It reports temporal-expression preservation of 3.05% under the original prompt. An explicit one-sentence preservation instruction raised that to 62.39% and recovered substantial temporal-question accuracy.

### Product use

Do not use general semantic similarity as the sole safety check. Define typed required fields:

- Tests: name, location, expected, actual, error, relevant trace.
- Builds: command, exit code, tool version, errors, source locations.
- Requirements: exact positive or negative constraint and source message.
- Files: path, content hash, relevant locations, version validity.

## MemBench

**Source:** [MemBench: Towards More Comprehensive Evaluation on the Memory of LLM-based Agents](https://aclanthology.org/2025.findings-acl.989/)
**Status:** Peer-reviewed Findings of ACL 2025

MemBench means Memory Benchmark. It evaluates factual and reflective memory across participation and observation scenarios. It separates effectiveness, efficiency, and capacity instead of reducing memory quality to one accuracy number.

### Product use

Report task success, efficiency, capacity, factual-state recall, and retained conclusions separately.

## OpenAI engineering guidance

OpenAI's [compaction documentation](https://developers.openai.com/api/docs/guides/compaction) supports server-side and standalone compaction for carrying forward state with fewer tokens.

OpenAI's [memory and compaction cookbook](https://developers.openai.com/cookbook/examples/agents_sdk/building_reliable_agents_memory_compaction) distinguishes:

- Compaction: continue the current long-running task.
- Memory: reuse workflow lessons in future runs.
- Artifact: retain a human-reviewable source of truth.

### Product use

Keep session state, cross-task memory, and raw artifacts as separate concepts. Cross-task memory is outside the initial scope.

## Anthropic engineering guidance

Anthropic's [context-engineering guidance](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) recommends initially maximizing recall and treating old tool-result clearing as one of the safest reductions. It emphasizes preserving architectural decisions, unresolved bugs, and implementation details.

Anthropic's [long-running agent harness article](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents) reports that compaction alone was insufficient. Persistent progress files, structured feature status, Git history, incremental tasks, and explicit handoffs improved continuity.

### Product use

Target tool noise first and make durable working state a structured handoff, not merely a prose summary.

## Vercel platform findings

[Vercel AI SDK 7](https://vercel.com/blog/ai-sdk-7) introduced the experimental `HarnessAgent` abstraction and adapters for coding harnesses such as Codex and Claude Code.

[Vercel Sandbox](https://vercel.com/docs/sandbox) supplies isolated ephemeral compute for agent-generated and untrusted code. Vercel's [HarnessAgent sandbox guide](https://vercel.com/kb/guide/sandboxed-coding-agent-with-harnessagent) demonstrates Codex and Claude Code adapters behind a common interface.

[Vercel AI Gateway](https://vercel.com/docs/ai-gateway) supplies unified model access, budgets, usage monitoring, retries, and fallbacks.

### Product use

- Use HarnessAgent as the first multi-harness integration boundary.
- Isolate its experimental packages behind a stable internal interface.
- Use Sandbox for reproducible hosted evaluations.
- Use AI Gateway for optional model-assisted reducers, judges, and cross-model comparison.
- Keep local raw context local by default.

## Research-informed principles

1. Do not build one universal summarizer.
2. Preserve raw observations outside active context.
3. Keep working state separate from transcript history.
4. Compress completed work more aggressively than active failures.
5. Validate required fields and agent behavior.
6. Use final task outcome as the ultimate correctness gate.
7. Learn preservation rules from compression-induced failures.
8. Measure token savings together with quality, latency, and manager overhead.
