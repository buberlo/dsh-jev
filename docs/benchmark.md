# Benchmark: DSH with and without Jev

The honest question is not "is it faster in general" but: **what does the Jev
decision layer cost, and what does it avoid?** Jev never replaces the planning
model; it adds one fast decision per hook and can shrink the tool surface and
prevent actions. This page records what was actually measured, on which
machine, with which limits.

## Setup

- Two profiles from the **same** headless template, differing only in one row:
  - `bench-base` — no Jev,
  - `bench-jev` — `@buberlo/dsh-jev` (mock by default, live via patch).
- Two tiers:
  - **Deterministic harness tier** (`pnpm bench:compare`): the real DSH agent
    loop and the real plugin, driven by a scripted model. The script is the
    recording — versioned as code, exactly repeatable. No key needed (the live
    variant uses `TYPESAFE_API_KEY` when present).
  - **CLI tier** (`pnpm bench:cli`): the real `dsh` product, an
    OpenAI-compatible gateway route through `@deepseek-ai/dsh-llm-pi-ai`, N
    runs per variant, full run recordings (NDJSON + stderr) as artifacts.
- Task: *"Read `/sandbox/notes.txt` and then report in one sentence what you
  did. Change nothing else."* Six synthetic tools are registered so selection
  has something to narrow.

## Executed: deterministic harness tier

`TYPESAFE_API_KEY=… pnpm bench:compare` — 25 runs per variant (10 for live),
macOS arm64, Node 26.9.0, 2026-09-19:

| Variant | Turn wall-clock (mean / p50) | Tool schemas sent | Tool runs | Jev decisions |
|---|---|---|---|---|
| A base (no Jev) | 2 ms / 1 ms | 2,180 B | 1 | — |
| B Jev mock + shadow | 2 ms / 1 ms | 2,180 B | 1 | 2 selections, 1 assessment |
| C Jev mock + enforce | 2 ms / 1 ms | **1,279 B** | 1 | + 2 restrictions applied |
| C2 mock + enforce, hold assessment | 2 ms / 1 ms | 1,279 B | **0** | 1 ask (execution withheld) |
| D Jev **live** + shadow | **1,604 ms** / 1,498 ms (first run) · **1,466 ms** / 1,441 ms (second run) | 2,180 B | 1 | real Jev answers |

Reading:

- **Mock Jev is free in this loop.** The integration itself adds no measurable
  wall-clock; the decisions are deterministic and local.
- **Live Jev costs ≈1.5 s per turn here** for two selections and one
  assessment (≈0.5 s per decision, consistent with the evaluation runs'
  ~0.47–0.48 s mean). Two independent runs with different authorizations
  agreed (1,604 ms and 1,466 ms means), so the cost is stable rather than a
  one-off. That is the price of real semantics.
- **Selection removed 41 % of the tool-schema bytes** in this synthetic set
  (six tools → one). A real model would see fewer input tokens; whether that
  offsets the Jev cost is exactly what the CLI tier must measure.
- **A hold assessment removed the tool execution entirely** (1 → 0). That is
  avoided work, not saved latency: the call never ran.

Raw artifacts: `packages/dsh-jev/bench/results/` (gitignored).

## Executed: CLI tier (real `dsh`, real model)

`node scripts/bench-cli.mjs` with the OpenCode Go tier
(`https://opencode.ai/zen/go/v1`, `deepseek-v4.1-flash`), 10 runs per variant,
macOS arm64, 2026-09-19. Every variant used the identical profile composition
and LLM route; only the Jev row and its mode differ. The gateway requires
`x-opencode-session`, which the harness injects as a fresh per-run UUID (plus
an identifying user agent) through the pi-ai provider profile's `headers`
field — DSH itself does not send it on every adapter path.

| Variant | ok | Turn wall-clock mean / p50 (min–max) | Input tokens | Output | Cached read | Tool calls |
|---|---|---|---|---|---|---|
| A base (no Jev) | 10/10 | 3,340 / 3,286 ms (3,189–3,680) | 82,728 | 987 | 80,640 | 10 |
| B Jev mock + shadow | 10/10 | 3,347 / 3,367 ms (3,087–3,570) | 82,677 | 1,012 | 80,640 | 10 |
| C Jev mock + enforce (selection narrows to `read`) | 10/10 | 3,420 / 3,405 ms (2,850–4,421) | 98,108 | 1,127 | **0** | 10 |
| D Jev live + shadow | 10/10 | 7,895 / 8,169 ms (6,917–9,246) | 82,763 | 1,011 | 80,640 | 10 |

Reading, honestly:

- **Mock Jev is free in the CLI too** (+0.2 %, inside the spread). The
  integration itself does not slow the task down.
- **Live Jev in shadow costs about +4.6 s per turn** (≈2.4×) for two
  selections and one assessment — ≈1.5 s per real decision. Shadow changes no
  behavior, so this is pure overhead: the price of real semantics, not a
  speed-up.
- **Narrowing the tool surface does not reduce tokens by itself, and it can
  cost more.** The enforce run shows cached reads dropping from 80,640 to 0:
  the smaller tool set changes the request prefix, so the gateway's prompt
  cache misses and the previously cached prefix is billed and processed as
  fresh input (98,108 vs 82,728 input tokens). Wall-clock stayed within noise
  (+2.4 % mean, overlapping ranges). The schema saving measured in the
  deterministic tier (41 % of tool-schema bytes) is real but small next to a
  cached conversation prefix.
- **No avoided work in this task**: every run performed exactly one tool call.
  Avoided executions show up in the hold/deny path, measured in the
  deterministic tier (1 → 0 executions).

Bottom line: with Jev in mock mode, DSH is as fast as without it; with live
Jev, the decision layer costs ~1.5 s per decision and is not a latency
optimization. Its value is the decisions themselves — gating, narrowing,
routing — and those only pay off when they replace work that is more
expensive than the decision (a destructive call, a long failed run, a wrong
model).

### Reproduce

```sh
DSH_BIN=/path/to/dsh \
BENCH_BASE_URL=https://opencode.ai/zen/go/v1 BENCH_MODEL=deepseek-v4.1-flash \
BENCH_API_KEY=… BENCH_SESSION_HEADER=x-opencode-session BENCH_RUNS=10 \
TYPESAFE_API_KEY=… node scripts/bench-cli.mjs
```

Artifacts (NDJSON + stderr per run, summary JSON) land under
`bench/results/` and are gitignored.

## Limits and non-claims

- One machine, one model, one scenario, one day. Ranges, not a general
  "faster" statement.
- The deterministic tier's wall-clock cannot show prompt-size effects: the
  scripted model answers from a fixed script. Only the schema-byte count is a
  proxy for the real token saving.
- Live-Jev latency is measured against TypeSafe as of 2026-09-19; it is
  network- and load-dependent.
- A `hold`/`deny` is avoided work, not saved time. Whether the whole task
  finishes sooner depends on the model and the task, which is what the CLI
  tier measures once a gateway is available.
- Thresholds are uncalibrated defaults (`docs/policy.md`); a different
  threshold region changes how often decisions gate at all.

## Reproduce

```sh
pnpm bench:compare                # deterministic tier, no key (live part optional)
pnpm bench:cli                    # prints the blocker unless BENCH_* is set
```
