# dsh-jev

Jev-powered decision layer for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH),
built on [TypeSafe Jev](https://docs.typesafe.ai/) (System One).

DSH keeps managing agents, lifecycle, tools, and execution. Jev answers small,
typed semantic questions. Deterministic application code decides what happens
with the answers. The generative model still does planning, prose, and code.

## What this does — and what it does not

**Does**

- Registers as a real DSH bundle/plugin (`@buberlo/dsh-jev`) and binds to
  verified extension points: `agent/pre-step`, `tools/pre-execute`,
  `tools/result`, `agent/request`, `tools/guard`, `tools/restrict`.
- Dynamically narrows the visible tool set per turn from independent category
  questions (not a single choice over all tools).
- Semantically assesses each tool call before execution: task fit, missing
  information, explicit restriction conflicts. A model answer can only gate
  (`ask`/`hold`/`deny`), never widen a permission.
- Observes completed calls and denies only repeated *identical* calls through a
  bounded, deterministic guard.
- Routes skills from metadata (bounded hint injection) and models across
  configured route classes, with a verified-availability check and fallback to
  the existing model.
- Ships a harness-independent core (`@buberlo/jev-core`) usable in games,
  semantic search, MCP routers, or any other consumer.

**Does not**

- Train, fine-tune, or self-host Jev; no DSH fork; no dashboard, database, or
  MCP platform.
- Turn model output into free-form explanations. Decisions show rule ids,
  selected ids, and measured values only.
- Make a model answer override a sandbox rule, permission, or local invariant.
- Send full repositories, logs, or transcripts by default.
- Publish itself to npm automatically, deploy anything, or ship CI release
  workflows.

## Status (verified in this repository)

| Area | Status |
|---|---|
| `@buberlo/jev-core`: providers, validation, policies, selection, assessment, routing, loop detector | implemented, unit-tested (79 tests) |
| `@buberlo/dsh-jev`: plugin, service, adapters | implemented, integration-tested (26 tests) |
| Real DSH runtime: ToolRuntime pipeline + full agent loop + approval service | tested |
| TypeSafe agent skill vendored in `.agents/skills/` (pinned, MIT) | installed; discovery + routing tested with the real filesystem provider |
| Real `dsh` CLI profile boot with this bundle | verified (see `docs/upstream-compatibility.md`) |
| Live TypeSafe API | implemented, **not executed** (no credentials in this environment); mock tests prove program logic only |
| Code-mode (PTC) execution path binding | tested via nested sub-dispatch; full PTC runtime not mounted |
| Everything else in `docs/roadmap.md` | see that file |

## Requirements and exact tested versions

- Node `^22.19.0 || >=24.0.0` (DSH engine range; verified on Node 26.9.0)
- pnpm 12.4.2
- `@typesafe-ai/sdk` 0.6.0 (live provider)
- DSH packages pinned to `0.1.6-alpha.2`, `@deepseek-ai/cordis` 4.0.2,
  `@deepseek-ai/schemastery` 3.18.2
- TypeScript 6.0.3, Vitest 4.1.11

See `docs/upstream-compatibility.md` for the verified upstream commit and every
interface used.

## Install

The published npm names would be `@buberlo/dsh-jev` and `@buberlo/jev-core`.
They are **not published yet** (this repository intentionally has no release
workflow). Install from a checkout or from tarballs:

```sh
pnpm install
pnpm build
pnpm --filter @buberlo/dsh-jev pack --pack-destination ./packs
pnpm --filter @buberlo/jev-core pack --pack-destination ./packs

# into a DSH profile (both tarballs as direct dependencies until the core is published)
dsh plugin --profile <name> add ./packs/buberlo-jev-core-0.1.0.tgz
dsh plugin --profile <name> add ./packs/buberlo-dsh-jev-0.1.0.tgz
dsh --profile <name> --dump-config   # shows the "# == @buberlo/dsh-jev" layer
```

The bundle manifest (`dsh.bundle.patch` → `cordis.patch.yml`) inserts one row:

```yaml
- id: jev
  name: '@buberlo/dsh-jev'
```

Configure it by overriding that row's `config` in your profile patch:

```yaml
- id: jev
  name: '@buberlo/dsh-jev'
  config:
    provider: mock          # mock | live
    mode: shadow            # off | shadow | enforce
    selection:
      enabled: true
      alwaysAllow: [read_file]
      categories:
        files: 'Reading or writing workspace files'
        tests: 'Running or inspecting tests'
      toolCategories:
        read_file: [files]
        write_file: [files]
        run_tests: [tests]
    assessment:
      enabled: true
      onFailure: ask        # ask | hold
    skills:
      enabled: true
      routingHints:
        typesafe-ai: 'especially for TypeSafe/Jev integration, System One models, classifiers, and semantic routing'
    modelRouting:
      enabled: false
      routes:
        fast: { provider: deepseek-official, model: deepseek-v4-flash }
        reasoning: { provider: deepseek-official, model: deepseek-v4-pro }
```

## Offline start (no network, no key)

```sh
pnpm install
pnpm build
pnpm example:coding     # tool selection + call assessment on synthetic data
pnpm example:ops        # read-only ops router (synthetic incident)
pnpm example:game       # standalone game importing only jev-core
pnpm example:dsh        # real DSH services + real plugin, synthetic answers
pnpm evals              # 15 mock evaluation fixtures (de/en)
pnpm test               # unit + integration tests
pnpm verify             # install → build → typecheck → tests → evals → examples → packaging
```

Every mock value is synthetic and labeled as such in the output.

## Enabling the live API explicitly

Live access needs **two** explicit settings — a key alone changes nothing:

```yaml
- id: jev
  name: '@buberlo/dsh-jev'
  config:
    provider: live
    mode: shadow            # or enforce
    apiKey: !!js process.env.TYPESAFE_API_KEY
```

- The plugin never reads `TYPESAFE_API_KEY` implicitly. `provider: live`
  without an explicit `apiKey` fails at plugin load (verified through the real
  `dsh` loader).
- `mode: off` performs no requests at all, even with a key configured.
- `provider: live` + `mode: shadow` **still transmits state to TypeSafe** and
  only skips applying the decisions. This is logged as a warning at load.
- `TYPESAFE_MODEL` / `TYPESAFE_BASE_URL` are optional explicit overrides; the
  default model alias is the documented `jev-latest`.

## Data flow, modes, and failure behavior

```
DSH turn ─▶ pre-step snapshot ─▶ Jev selection ─▶ tools.restrict (enforce only)
tool call ─▶ tools/pre-execute ─▶ Jev assessment ─▶ ask / hold / deny (enforce only)
result    ─▶ tools/result (observe-only) ─▶ bounded loop counter ─▶ sync guard
request   ─▶ agent/request ─▶ Jev route ─▶ verified target (enforce only)
```

- **Data transmitted**: bounded task text, step label, tool ids/descriptions,
  bounded+redacted argument values, explicitly configured restrictions. No
  repositories, logs, or transcripts. Secrets matching the redaction fragments
  are replaced; redaction is an extra measure, not guaranteed anonymization.
- **Bounds**: whole-call time budget, per-attempt timeout, max concurrent
  requests, max state characters, candidate/question caps, max selected tools.
  Cancellation is wired to the call signal and to agent/plugin disposal.
- **Retries**: the TypeSafe SDK owns HTTP retries (`maxRetries`, default 1 in
  the plugin). There is no second retry loop and no automatic provider switch.
- **Failure behavior per function**: selection falls back to the existing tool
  set; model and skill routing keep the existing model/skill; tool assessment
  requires approval (`ask`) or withholds (`hold`). A failure never produces an
  allow.
- **Staleness**: async decisions are bound to a turn/catalog snapshot; a result
  that arrives after a turn, catalog, or policy change is discarded and the
  assessment failure rule applies.
- **No persistent decision cache**: approvals are per call. Changed arguments
  are assessed again.

## Repository layout

```
packages/jev-core/     harness-independent decision core
packages/dsh-jev/      real Cordis/DSH plugin (bundle)
examples/              coding, ops-readonly, standalone-game, DSH runtime
tests/                 (integration tests live with the plugin package)
evals/fixtures/        versioned de/en evaluation dataset
.agents/skills/        vendored TypeSafe agent skill (pinned upstream commit)
docs/                  architecture, upstream compatibility, policy, evaluation, roadmap
scripts/               verify.sh, packaging-test.mjs, run-evals.ts
```

## Documentation

- `docs/architecture.md` — responsibilities, data flow, extension points
- `docs/upstream-compatibility.md` — verified date, commit, interfaces, limits
- `docs/policy.md` — questions, thresholds (uncalibrated), decisions, failures
- `docs/evaluation.md` — mock vs live, fixture format, reporting
- `docs/roadmap.md` — implemented, limited, planned
- `docs/skills.md` — the vendored TypeSafe skill, discovery, and routing
- `AGENTS.md` — commands and permanent project rules

## License

MIT
