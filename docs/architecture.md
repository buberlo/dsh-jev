# Architecture

## Responsibility split

```
┌──────────────────────────────┐
│ DSH (agents, lifecycle,      │
│ tools, execution)            │
└──────────────┬───────────────┘
               │ verified extension points
┌──────────────▼───────────────┐
│ Adapter                      │  packages/dsh-jev
│ events → state → DSH actions │
└──────────────┬───────────────┘
               │ core API only
┌──────────────▼───────────────┐
│ Policy                       │  jev-core: rules, thresholds, decisions
└──────────────┬───────────────┘
               │ validated answers
┌──────────────▼───────────────┐
│ Provider                     │  jev-core: mock | live TypeSafe SDK
└──────────────────────────────┘
```

- **Provider** executes a Jev request and returns validated answers. The live
  provider wraps `@typesafe-ai/sdk` (no extra retry loop, SDK log level `off`
  by default); the mock provider is deterministic and offline.
- **Policy** derives decisions from answers, configuration, and trusted facts
  (selected ids, category relevance, probabilities, confidence, thresholds,
  local restrictions). It never invents prose.
- **Adapter** translates decisions into supported DSH behavior and owns scope,
  state, cancellation, and disposal.

The core imports nothing from DSH. `examples/standalone-game` proves that by
importing only `@buberlo/jev-core`.

## Vertical slice

```
turn               tool call                  result
 │                    │                         │
agent/pre-step ──▶ snapshot ──▶ selection ──▶ tools.restrict (enforce)
tools/pre-execute ─────────────▶ assessment ──▶ ask | hold | deny (enforce)
tools/result ──────────────────────────────▶ bounded loop counter
tools/guard (sync) ◀── bounded counter ◀────┘
agent/request ────────────────▶ model route ──▶ verified target (enforce)
```

## Per-agent state

State is keyed by the exact agent object and lives only in `JevRuntime`.

- `ensureState(agent)` creates an `AgentState` lazily.
- `AgentState` holds the bounded snapshot (task, step, turn, version), the
  current selection-restriction disposer, in-flight request controllers, and
  the loop `LoopDetector` entry (owned by the service).
- `agent/disposed` disposes the state: aborts in-flight requests, lifts the
  selection restriction, and drops counters. Plugin disposal does the same for
  every tracked agent and aborts the core's requests.
- Two parallel sessions never share state; this is covered by a test where one
  agent's repeated call is denied while the other agent's identical call runs.

## Tool selection mechanics

1. Lift the previous selection restriction, so candidates are computed from
   the unrestricted-but-already-authorized set (recovery path).
2. Build candidates from `ctx.tools.schemas(agent)`, keeping only names that
   `ctx.tools.get(name)` resolves globally (restrictable names).
3. Stage 1: one independent Noul per category ("is a tool from this category
   relevant?"), chunked by `maxCategories`.
4. Stage 2: one Choice per relevant category over its candidates plus an
   explicit "no tool" option, chunked by `maxCandidatesPerQuestion` so no
   candidate is silently dropped (TypeSafe accepts at most 255 options).
   A tool may serve several categories and can be selected by each.
5. Policy: relevance threshold, selection probability threshold, confidence
   gate. Uncertain categories contribute an `expand` set instead of a hard
   decision.
6. Enforce mode applies `restrict({ allow: selected ∪ expand ∪ alwaysAllow })`,
   after re-checking the snapshot and catalog version. Failure or an explicit
   "no candidate" **keeps the existing tool set** — selection only ever
   narrows.
7. Out-of-band alternatives (the "expand" set) keep the agent able to recover
   when the preselection was too narrow; the next step recomputes everything.

## Call assessment mechanics

One batched request with independent questions:

- `matches_task` (Noul), `missing_information` (Noul),
  `violates_restriction` (Noul), optional ordinal `risk` (Score).
- State: bounded task/step/tool id, redacted+bounded arguments, configured
  restrictions, and an explicit untrusted-data notice.
- Policy order: restriction violation → deny; missing information → ask; task
  mismatch → ask; otherwise allow. Precedence is monotonic, so a denial is
  never softened by a weaker `ask`.
- The adapter always delegates first (`next()`), then composes its decision
  with the downstream one (`deny > hold > ask > allow`). It can never skip a
  later policy, and it can never turn a `deny`, `cancel`, or `ask` into an
  allow.
- On any failure to obtain a usable assessment (provider error, validation
  failure, timeout, abort, stale snapshot) the configured failure action
  applies: `ask` or `hold`, never `allow`. Configuration rejects anything else
  at core construction.
- The result carries a local signature over the tool id and bounded arguments
  for diagnostics and approval binding. There is no cache; changed arguments
  are assessed again.

## Loop detection

- `tools/result` (observe-only) counts consecutive identical calls per agent;
  the key is the tool id plus the canonical bounded arguments.
- A synchronous `ctx.tools.guard()` denies the next identical call once the
  bounded counter reaches `maxRepeats` in `enforce` mode only.
- A new user message resets the chain; the detector has a hard subject cap and
  no retry or escalation logic of its own.
- The immutable final result is never modified.

## Model and skill routing

- **Model**: `agent/request` returns an `LlmCallConfig`; the adapter replaces
  provider/model only when the core selected a configured route **and** the
  target appears in the live provider catalog. Otherwise the existing model is
  kept (catalog membership is documented as advisory, so absence falls back).
- **Skill**: `ctx.skills.list({ scope: agent })` gives trusted metadata; the
  core selects at most one model-invocable skill. Enforce mode injects a single
  bounded one-line hint through `agent.inject`; the skill body is never loaded
  automatically. One hint per turn.

## Bounds, budget, and cancellation

- Whole-call budget (`budgetMs`) and per-attempt timeout (`timeoutMs`) are
  passed to the core/provider; the SDK owns HTTP retries.
- `maxConcurrent` is enforced by an in-process semaphore in the core.
- Caller signals are combined with the plugin's per-agent controllers; agent
  or plugin disposal aborts every in-flight request.
- State and arguments are bounded and redacted before transmission.

## Failure and recovery summary

| Function | On failure | Recovery |
|---|---|---|
| Tool selection | keep the existing tool set (`fallback`) | next step recomputes from the unrestricted set |
| Tool assessment | `ask` or `hold` (configurable; never allow) | approval can still allow the concrete call |
| Skill routing | no skill suggestion | normal agent flow |
| Model routing | keep the existing model | normal agent flow |
