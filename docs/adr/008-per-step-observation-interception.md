# ADR 008: Reduce observations on the per-step context path

**Status:** Accepted
**Date:** September 7, 2026

## Context

Phase 5 reduces the checkpoint context supplied at the start of a hosted run.
After that first request the adapter is a spectator: the harness owns its own
transcript inside the sandbox, and every later model request carries the full
native history.

The first authenticated paired run made the consequence visible. The managed
checkpoint was 21.9% smaller as an estimate, while provider-reported input
tokens fell 0.5% (33,343 to 33,175). Both numbers are correct. Their distance
is arithmetic: measured input is the harness preamble plus the accumulated
transcript plus the observations ACM controls, and a two-tool-call task leaves
the third term close to zero.

A reduction applied once at the start also cannot be distinguished from one
that compounds, because a turn total reports a single number either way.

Three insertion points were available in `@ai-sdk/harness@1.0.91`.

1. Host-executed tools that shadow the harness's builtin tools. The agent
   settings state that user tools take precedence over builtins on key
   collision, and that the agent executes `tool.execute()` on the host and
   submits the result back to the harness.
2. A model-facing proxy reached through the adapters' base-URL settings, which
   would also see the preamble and the prior transcript.
3. Outer-loop turn chunking through `maxTurns`, re-priming a fresh session with
   assembled state.

Sandbox request transformations were also examined and rejected: they rewrite
headers only and cannot reach a request body.

## Decision

Reduce observations at the tool boundary, by overriding the harness's builtin
tools with host-executed tools that record the raw observation and return the
reduced one.

What such a tool returns is what the harness writes into the agent's
transcript, so the saving is present in every later model request of the
session instead of only the first.

`@acm/harness-port` owns the `ObservationInterceptor` contract.
`@acm/observation-pipeline` implements it over the existing deterministic
reducers, artifact store, and metadata store. `@acm/vercel-harness` owns the
tool overrides and stays the only package that imports experimental Vercel
packages.

Both experimental conditions run the same interception path. Under the `raw`
policy the reduction is still computed and recorded but never substituted, so
the conditions differ in exactly one decision. A baseline that executed tools
natively would differ in tool implementation as well as context policy, and the
comparison would no longer isolate the reduction.

The runner enforces the pairing rather than trusting it: the `raw` condition
must be given a `raw` interceptor and `managed` a `reduced` one.

Per-step usage is recorded alongside turn totals so input growth can be read as
a curve. The slope of that curve is what separates a one-time saving from a
compounding one.

The model-facing proxy is deferred, not rejected. It is the only lever that
reaches the harness-controlled preamble, and it needs provider wire-format
work that this slice does not.

## Consequences

- A reduction now persists across a session rather than being overwritten by
  the harness's own history.
- Reduction never precedes durable evidence. An unavailable artifact store, a
  failed classifier, a failed reducer, an unsafe reduction, or a reduction no
  smaller than its source all fall back to the raw observation and say so in
  the record.
- Overriding a builtin narrows it to the parameters ACM declares. The narrowing
  applies to both conditions, so a paired comparison stays valid; a comparison
  against a natively executed run does not.
- The `raw` condition now measures what the managed condition would have done
  with the same bytes, which makes the reducible share of a run a measurement
  rather than an assumption.
- The harness preamble and prior transcript remain outside ACM's reach until
  the proxy is built.
