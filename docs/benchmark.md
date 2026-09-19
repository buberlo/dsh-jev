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
| D Jev **live** + shadow | **1,604 ms** / 1,498 ms (min 1,377, max 2,343) | 2,180 B | 1 | real Jev answers |

Reading:

- **Mock Jev is free in this loop.** The integration itself adds no measurable
  wall-clock; the decisions are deterministic and local.
- **Live Jev costs ≈1.6 s per turn here** for two selections and one
  assessment (≈0.5 s per decision, consistent with the evaluation run's
  483 ms mean). That is the price of real semantics.
- **Selection removed 41 % of the tool-schema bytes** in this synthetic set
  (six tools → one). A real model would see fewer input tokens; whether that
  offsets the Jev cost is exactly what the CLI tier must measure.
- **A hold assessment removed the tool execution entirely** (1 → 0). That is
  avoided work, not saved latency: the call never ran.

Raw artifacts: `packages/dsh-jev/bench/results/` (gitignored).

## CLI tier: built and mechanically verified, blocked at the gateway

`node scripts/bench-cli.mjs` creates both profiles, applies one identical LLM
route patch (a hand-declared `openai-completions` gateway for
`@deepseek-ai/dsh-llm-pi-ai`), adds the plugin to the Jev profile, runs N
recorded turns per variant and writes NDJSON/stderr recordings.

A full dry-run was executed; the harness composed both profiles and reached
the model call. It cannot produce results in this environment because the only
available key is the author's opencode-go key, which is **not usable from an
external harness** (measured 2026-09-19):

| Request | Result |
|---|---|
| `GET https://opencode.ai/zen/v1/models` with the key | 200 — key valid, lists `deepseek-v4.1-flash` |
| `POST …/chat/completions` with `deepseek-v4.1-flash` | **402** `Upstream request failed: Insufficient account funds` |
| `POST …/chat/completions` with a `-free` model | **403** `FreeTierError: OpenCode's free tier can only be used from within OpenCode` |

The recorded run artifacts therefore contain the gateway's 402 as the failure
reason — a concrete blocker, not a silent skip.

### Running it for real

Any working OpenAI-compatible gateway unblocks the tier:

```sh
DSH_BIN=/path/to/dsh \
BENCH_BASE_URL=https://gateway.example/v1 \
BENCH_MODEL=<model-id> \
BENCH_API_KEY=<key> \
BENCH_RUNS=5 \
TYPESAFE_API_KEY=<key> \
node scripts/bench-cli.mjs
```

`apiKeyEnv` references an environment variable in the generated profile patch;
the key itself is passed to the child process only and never written to a file.
Artifacts land in `bench/results/<variant>/run-*.jsonl` and
`cli-<timestamp>.json`.

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
