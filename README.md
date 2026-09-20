# dsh-jev

**The Jev decision layer for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH).**

DSH runs the agent. [TypeSafe Jev](https://docs.typesafe.ai/) makes the small,
fast decisions. Your code decides what the answers mean.

```
   user task
       │
       ▼
 ┌───────────────────────────────────────────────────────────┐
 │  DeepSeek Harness agent loop                              │
 │  planning · tools · execution · sessions                  │
 │                                                           │
 │   pre-step ──▶ Jev: which tools are relevant?   → restrict│
 │   tool call ──▶ Jev: is this call safe to run?  → ask/hold│
 │   result ─────▶ deterministic loop guard (no model)       │
 │   request ────▶ Jev: which model route fits?    → route   │
 └───────────────────────────────────────────────────────────┘
       │
       ▼
  TypeSafe Jev (System One)  ← choice · score · noul
```

No Jev call is planned by the LLM, no model output becomes an explanation, and
no model answer can widen a permission. Jev only ever narrows or gates.

## At a glance

| | |
|---|---|
| Packages | `@buberlo/jev-core` (harness-independent) · `@buberlo/dsh-jev` (DSH plugin/bundle) |
| npm | both published at `0.1.1` (2026-09-19); registry install verified with `dsh plugin add` |
| Verified DSH | `0.1.6-alpha.2` (commit `ddefc45`), `@deepseek-ai/cordis` 4.0.2 |
| Verified TypeSafe SDK | `@typesafe-ai/sdk` 0.6.0 |
| Defaults | `provider: mock`, `mode: shadow` — offline, no behavior change |
| Tests | 120 (82 core + 38 DSH integration) · 25 evaluation fixtures |
| Live API | implemented, requires an explicit key; not part of any default |
| License | MIT |

## What this is — and is not

**Is:** a plugin that binds Jev to real DSH extension points, plus a reusable
decision core you can embed in any application (games, search, MCP routers).

**Is not:** a Jev training or hosting project, a DSH fork, a dashboard, a
database, or an MCP platform. It never auto-applies a model suggestion, never
caches approvals, and never sends repositories, logs, or transcripts by
default.

## Try it in 60 seconds

Everything below runs offline with synthetic answers. No key, no network.

```sh
git clone https://github.com/buberlo/dsh-jev
cd dsh-jev
pnpm install
pnpm build

pnpm example:coding    # tool selection + call assessment
pnpm example:dsh       # real DSH services + real plugin (still synthetic)
pnpm example:ops       # read-only incident router
pnpm example:game      # standalone game, imports only jev-core
```

What `pnpm example:coding` shows (excerpt):

```text
=== 1. Dynamic tool selection ===
input task : Fix the failing billing test: read src/billing.test.ts and run the test suite
categories (independent relevance questions):
  - files    relevance=0.97 relevant=true, pick=read_file p=0.88 conf=0.88
  - tests    relevance=0.93 relevant=true, pick=run_tests p=0.91 conf=0.91
selected : read_file, run_tests

=== 2. Pre-execution assessment (proposed model call) ===
policy     : allow (applied=true)
values     : matches=0.96 missing=0.06 violates=0.04
```

`pnpm example:dsh` goes further: it mounts the **real** DSH tool pipeline and
the actual plugin, then shows a call being held with the policy rule that
caused it. Every model value is visibly synthetic (`mock/jev-synthetic`).

## What Jev decides here

| DSH moment | Jev question (example) | Deterministic consequence |
|---|---|---|
| `agent/pre-step` | *Is a tool from category "files" relevant?* | narrow the visible tools via scoped `tools.restrict` |
| `tools/pre-execute` | *Does this call match the task? Is information missing? Does it violate a stated restriction?* | `allow` · `ask` (approval) · `hold` · `deny` |
| `agent/request` | *Which configured route fits this task?* | switch provider/model only if the target is verified available |
| `ctx.skills` | *Does this turn need a skill? Which one?* | inject one bounded hint; the body loads only if the model asks |

Jev answers three question types; the core keeps their meanings distinct:

| Primitive | Meaning | What code does with it |
|---|---|---|
| **Choice** | one of a defined set, plus a full probability distribution and confidence | compare probabilities against thresholds, or branch on the selected label |
| **Score** | an ordinal position on named levels (can fall between levels) | weigh/rank; never shown as a "risk percentage" |
| **Noul** | probability that a yes/no statement holds (no confidence field) | threshold into a boolean decision |

Independent questions are sent in one request (they cannot see each other's
answers), so the code sends every question it might need and ignores the rest.

## Modes and providers

Two independent switches — where answers come from, and whether they may act:

| Mode | Jev requests | Behavior change | Typical use |
|---|---|---|---|
| `off` | none | none | kill switch |
| `shadow` | yes | none (decisions are logged) | observe before enforcing |
| `enforce` | yes | decisions are applied | production |

| Provider | Network | Answers |
|---|---|---|
| `mock` | none | deterministic synthetic scenarios (default) |
| `live` | TypeSafe API | real Jev; requires an explicit `apiKey` |

Start with the default `mock + shadow`, watch the logs, then move to
`enforce`, then to `live` if you want real Jev answers. `live + shadow` still
transmits state to TypeSafe — it only skips applying the decisions.

## Use cases

- **Coding assistant** — keep only the tools a task needs, gate risky calls
  before they run, stop identical retry loops.
  [`examples/coding`](examples/coding)
- **Read-only ops router** — route an incident to diagnostics while a hard
  policy keeps remediation out of reach. [`examples/ops-readonly`](examples/ops-readonly)
- **Interactive apps and games** — map free text onto a bounded action set with
  deterministic consequences, without a chat model.
  [`examples/standalone-game`](examples/standalone-game)
- **Any agent harness** — the core is harness-independent; the LangChain team
  describes the same pattern with `TypeSafeClassifier`, model routing, and
  tool-risk gating middleware (see `docs/architecture.md`).

Details and design notes: [`docs/use-cases.md`](docs/use-cases.md).

## Install into a DSH profile

Both packages are on npm:

```sh
dsh plugin --profile <name> add @buberlo/dsh-jev
dsh --profile <name> --dump-config   # shows the "# == @buberlo/dsh-jev" layer
```

For an unreleased build, pack a tarball from a checkout instead — the published
core still resolves transitively:

```sh
pnpm --filter @buberlo/dsh-jev pack --pack-destination ./packs
dsh plugin --profile <name> add ./packs/buberlo-dsh-jev-0.1.1.tgz
```

The bundle inserts one row; configure it by overriding that row's `config`:

```yaml
- id: jev
  name: '@buberlo/dsh-jev'
  config:
    provider: mock            # mock | live
    mode: shadow              # off | shadow | enforce

    selection:                # dynamic tool preselection
      enabled: true
      alwaysAllow: [read_file]
      categories:
        files: 'Reading or writing workspace files'
        tests: 'Running or inspecting tests'
      toolCategories:
        read_file: [files]
        write_file: [files]
        run_tests: [tests]

    assessment:               # per-call semantic check
      enabled: true
      onFailure: ask          # ask | hold   (never an allow)

    skills:                   # route the vendored TypeSafe skill
      enabled: true
      routingHints:
        typesafe-ai: 'especially for TypeSafe/Jev integration, System One models, classifiers'

    modelRouting:             # map route classes to real models
      enabled: false
      routes:
        fast: { provider: deepseek-official, model: deepseek-v4-flash }
        reasoning: { provider: deepseek-official, model: deepseek-v4-pro }
```

Live API — two explicit settings, never implicit:

```yaml
    provider: live
    apiKey: !!js process.env.TYPESAFE_API_KEY
```

### Configure it from the web client

In a web/desktop profile the bundle ships a configuration page: open the
**Plugins** page and this bundle's own page to find the Jev card. It explains
what Jev does in the loop and edits the safe subset live:

- mode (`off` / `shadow` / `enforce`) — applied immediately, no restart;
- the five feature toggles (selection, assessment, loop guard, skills, model
  routing).

Provider, model, and API key stay in `cordis.yml` (the key is a secret and is
never displayed). Headless profiles have no web client and simply ignore this
half; the plugin runs identically from its composed configuration.

<details>
<summary>All configuration fields and their defaults</summary>

| Field | Default | Meaning |
|---|---|---|
| `provider` | `mock` | answer source |
| `mode` | `shadow` | off / shadow / enforce |
| `model`, `apiKey`, `baseURL` | — | live provider settings (key explicit) |
| `timeoutMs` / `budgetMs` | 5000 / 8000 | per-attempt timeout / whole-call budget |
| `maxRetries` | 1 | SDK-owned HTTP retries; no second retry loop |
| `maxConcurrent` | 2 | concurrent provider requests |
| `maxStateChars` / `maxArgumentChars` | 4000 / 1200 | transmitted state and argument bounds |
| `thresholds.*` | see `docs/policy.md` | uncalibrated defaults; tune on your data |
| `selection.alwaysAllow` | `[]` | tools a selection may never hide |
| `selection.toolCategories` | `{}` | tool id → category ids (default: tool id as category) |
| `loopDetection.maxRepeats` | 2 | identical completed calls before the next is held |
| `skills.routingHints` | `{}` | extra routing guidance per skill name |
| `skills.maxDescriptionChars` | 240 | per-part metadata bound |
| `modelRouting.routes` | `{}` | route class → real provider/model |
| `mock.delayMs` / `mock.answers` | 0 / `{}` | deterministic offline scenarios |
| `logDecisions` | true | structured decision logs |

</details>

## How the integration stays safe

- **No implicit live access.** `provider: live` without an explicit key fails
  at plugin load — verified through the real `dsh` loader.
- **No model-derived permissions.** Failures, timeouts, aborts, stale
  snapshots, and validation errors produce `ask`/`hold`; configuration rejects
  anything else.
- **No premature allow.** The assessment listener always calls `next()` first
  and composes monotonically (`deny > hold > ask > allow`); later policies are
  never skipped.
- **No widening.** A Jev selection intersects with existing restrictions and
  can only hide tools, never add them.
- **No stale decisions.** Async results are bound to a turn/catalog snapshot;
  changed snapshots discard the result and apply the failure rule.
- **No persistent cache.** Approvals are per call; changed arguments are
  assessed again. The loop guard is a bounded, deterministic counter.
- **Bounded, redacted data.** Only task text, tool metadata, and bounded
  arguments leave the process; redaction is an extra measure, not anonymization.

## Measured value

![Same task, same model — without Jev the audit trail is deleted, with Jev the deletion is denied](docs/assets/bench-side-by-side.gif)

Video with narration: [English](docs/assets/bench-side-by-side.mp4) · [German](docs/assets/bench-side-by-side.de.mp4)

![Does Jev add value?](docs/assets/bench-value.png)

Jev stopped every attempt: on a weaker model the agent tried to delete the
protected audit trail in 10/10 runs — 31 denials, zero executions — while
without Jev it got through. Footnote, honestly: a rule inside the prompt also
held in our runs and is cheaper; Jev is the guarantee when that rule cannot
live in the model context, when the model cannot be trusted, or when a denial
must be auditable. Full method, raw numbers, videos and limits:
[`docs/benchmark.md`](docs/benchmark.md).

## Status

| Area | Status |
|---|---|
| `@buberlo/jev-core` | implemented, 82 unit tests |
| `@buberlo/dsh-jev` | implemented, 38 integration tests (real ToolRuntime, real agent loop, real approval service, real settings provider) |
| Dynamic tool selection | tested incl. pre-existing denials and parallel sessions |
| Call assessment + approvals | tested incl. changed arguments and fail-closed paths |
| Loop guard | tested (per-agent isolation, shadow vs enforce) |
| Model routing | tested with verified-availability fallback |
| Skill routing + vendored TypeSafe skill | tested against the real filesystem provider |
| Web client configuration page | implemented (bundle-keyed Plugins page); settings write and card interactions tested; module served by a running web app |
| Real `dsh` CLI profile/loader | verified (see `docs/upstream-compatibility.md`) |
| Published packages | registry install verified: profile layer composed, host plugin loaded, client module served by a running web app |
| Live TypeSafe API | executed 2026-09-19 (`jev-1.13.0`): 25/25 fixture agreement, 0 errors, mean 483 ms — a measurement, not an accuracy claim |
| Threshold calibration | `pnpm calibrate` measures once and sweeps thresholds; live run reports agreement ranges (defaults are inside them), not calibrated operating points |
| Benchmark with/without Jev | executed both tiers plus a use case with video (OpenCode Go, `deepseek-v4.1-flash`, 10 runs/variant): mock Jev ≈0 overhead; Jev +4.6 s/turn for 3 decisions; baseline destroyed the audit trail in 4/10 runs while Jev denied every attempt — see `docs/benchmark.md` |
| Code-mode (PTC) | nested dispatch tested; full PTC runtime not mounted |

## Repository layout

```
packages/jev-core/     harness-independent decision core
packages/dsh-jev/      real Cordis/DSH plugin (bundle)
examples/              coding · ops-readonly · standalone-game · DSH runtime
evals/fixtures/        versioned de/en evaluation dataset
.agents/skills/        vendored TypeSafe agent skill (pinned upstream commit)
docs/                  architecture · upstream compatibility · policy · evaluation · roadmap · skills · use cases
scripts/               verify.sh · packaging-test.mjs · run-evals.ts
```

## Documentation

| Document | Answers |
|---|---|
| [`docs/getting-started.md`](docs/getting-started.md) | step-by-step: first run, reading output, going live |
| [`docs/use-cases.md`](docs/use-cases.md) | what to build and why it works |
| [`docs/architecture.md`](docs/architecture.md) | how the pieces fit, extension points, related work |
| [`docs/policy.md`](docs/policy.md) | questions, thresholds, decisions, failure rules |
| [`docs/upstream-compatibility.md`](docs/upstream-compatibility.md) | verified versions, interfaces, limits |
| [`docs/evaluation.md`](docs/evaluation.md) | mock vs live, dataset, reporting |
| [`docs/skills.md`](docs/skills.md) | the vendored TypeSafe skill and its routing |
| [`docs/roadmap.md`](docs/roadmap.md) | honest status and limits |
| [`docs/publishing.md`](docs/publishing.md) | manual publish runbook (no release automation) |
| [`docs/benchmark.md`](docs/benchmark.md) | measured with/without-Jev comparison, method and limits |

## Development

```sh
pnpm install          # workspace install
pnpm build            # tsc for both packages
pnpm test             # 120 tests
pnpm calibrate        # threshold sweep over the fixtures (mock; --live with a key)
pnpm bench:compare    # with/without Jev: real loop, scripted model, no key needed
pnpm bench:cli        # CLI A/B run harness (needs an OpenAI-compatible gateway)
pnpm evals            # 15 mock evaluation fixtures
pnpm verify           # install → build → typecheck → tests → evals → examples → packaging
```

`AGENTS.md` holds the permanent project rules (pinned deps, no implicit keys,
monotonic decisions, no release automation).

## License

MIT
