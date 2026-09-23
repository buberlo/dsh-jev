# @buberlo/dsh-jev

The Jev decision layer plugin and bundle for
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH).

DSH plans, calls tools, and runs them. Jev makes the small, fast decisions in
between — and this plugin maps those decisions onto supported DSH behavior. It
can only narrow or gate, never widen a permission.

```
pre-step  ──▶ Jev: which tools are relevant?   ──▶ tools.restrict
tool call ──▶ Jev: is this call safe to run?   ──▶ ask / hold / deny
result    ──▶ deterministic loop guard (no model)
request   ──▶ Jev: which configured model?     ──▶ verified route
```

## Install

```sh
dsh plugin --profile <name> add @buberlo/dsh-jev@0.1.4
dsh --profile <name> --dump-config   # shows the "# == @buberlo/dsh-jev" layer
```

`0.1.4` is the registry release (`npm view` 2026-09-23, `latest`). Its
dependency on `@buberlo/jev-core` is `^0.1.4`. Do not install `@0.1.2` or
`@0.1.3`: those tarballs still use a literal `workspace:^`, and `npm install`
fails (`EUNSUPPORTEDPROTOCOL`). `0.1.3` was abandoned after a staged-version
conflict (E409).

The bundle inserts one row; defaults are `provider: mock` + `mode: shadow`:
deterministic, offline, and behavior-neutral.

## Configure

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
        run_tests: [tests]
    assessment:               # per-call semantic check
      enabled: true
      onFailure: ask          # ask | hold  (never an allow)
    skills:
      enabled: true
    modelRouting:
      enabled: false
      routes:
        fast: { provider: deepseek-official, model: deepseek-v4-flash }
        reasoning: { provider: deepseek-official, model: deepseek-v4-pro }
```

Live API — two explicit settings, never implicit:

```yaml
    provider: live
    mode: shadow              # live + shadow still transmits state
    apiKey: !!js process.env.TYPESAFE_API_KEY
```

## Web client

In a web/desktop profile the bundle ships a configuration page on the Plugins
page: provider, live mode selector, a write-only API key field, and the five
feature toggles. Writes go to the host settings document and reconfigure the
running service immediately.

## What it does

| Extension point | Decision |
|---|---|
| `agent/pre-step` | tool selection across independent categories; scoped `tools.restrict`, recomputed every turn |
| `tools/pre-execute` | call assessment: task fit, missing information, explicit restriction conflict |
| `tools/result` + `tools/guard` | bounded loop detection; identical repeated calls are denied |
| `agent/request` | model routing to a configured route, only when verified available |
| `ctx.skills` | at most one skill hint per turn; bodies are never auto-loaded |

## Guarantees

- **No implicit live access.** `provider: live` without an explicit key fails
  at plugin load.
- **No model-derived permissions.** Failures, timeouts, stale snapshots, and
  validation errors produce `ask`/`hold`.
- **No premature allow.** The listener always delegates first and composes
  monotonically; later policies are never skipped.
- **No widening.** A Jev selection intersects with existing restrictions.
- **No stale decisions, no cache.** Decisions are bound to a turn/catalog
  snapshot; changed arguments are assessed again.
- **Bounded data.** Only task text, tool metadata, and bounded/redacted
  arguments leave the process.

## Documentation

- Project: <https://github.com/buberlo/dsh-jev>
- `docs/policy.md` · `docs/architecture.md` · `docs/upstream-compatibility.md`
- `docs/getting-started.md` · `docs/skills.md` · `docs/publishing.md`

## License

MIT
