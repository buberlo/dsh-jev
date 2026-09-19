# Getting started

A step-by-step path from zero to a live Jev decision, with what to look at in
each step. Everything before "Going live" runs offline with synthetic answers.

## 0. What you need

- Node `^22.19.0 || >=24.0.0` and pnpm (this repo is verified on Node 26.9.0,
  pnpm 12.4.2)
- No API key for anything except the optional live step at the end
- About five minutes

## 1. Install and build

```sh
git clone https://github.com/buberlo/dsh-jev
cd dsh-jev
pnpm install
pnpm build
```

`pnpm install` builds both packages through their `prepare` scripts, so a
fresh checkout is immediately runnable. If the build fails, stop here — every
later step assumes it succeeded.

## 2. Watch the two core decisions offline

```sh
pnpm example:coding
```

The output has two halves:

**Tool selection.** The task is synthetic, and so are the answers
(`mock/jev-synthetic`). Look for:

- one line per **category**, each with its own relevance probability — these
  are independent questions, not one distribution over all tools;
- `pick=read_file p=0.88 conf=0.88` — the per-category choice, its probability,
  and the reported confidence (three different numbers);
- `selected: read_file, run_tests` — only these two would stay visible to the
  model if enforcement were on.

**Call assessment.** A proposed `write_file` call is checked with three
questions (task fit, missing information, restriction conflict) plus an
ordinal risk score. Look for:

- `policy: allow` — the effective action;
- the rule ids (`assessment.*`) and measured values — decisions never contain
  generated prose;
- `signature: …` — a local hash binding this assessment to the tool id and the
  bounded arguments. Change the arguments and the assessment happens again.

`pnpm example:ops` shows a read-only incident router, `pnpm example:game`
shows the core in a standalone app (no DSH at all).

## 3. See the real DSH pipeline

```sh
pnpm example:dsh
```

This mounts the actual `@deepseek-ai/dsh-system-prompt` and
`@deepseek-ai/dsh-tools` services and the real plugin from this repository. The
synthetic model reports that information is missing, so the call is held:

```text
pipeline result : ERROR
model sees      : [jev] ask by assessment.missing-information: required information is likely missing (noul=0.920 >= 0.500)
tool executed   : false
```

Two things to notice:

1. The tool body never ran — the decision happened **before** execution.
2. The model-facing text is the policy rule plus measured values, not an
   explanation written by a model.

The second call uses different arguments and is assessed from scratch (no
cache), which is what makes per-call approvals meaningful.

## 4. Understand what the tests prove

```sh
pnpm test        # 105 tests
pnpm evals       # 15 evaluation fixtures, mock mode
```

- `pnpm test` proves program logic against the real DSH runtime: the real tool
  pipeline, the real agent loop, the real approval service. Only the *LLM* is a
  deterministic scripted test adapter. Jev itself is mocked.
- `pnpm evals` runs German and English decision fixtures and asserts the
  expected selection/assessment/skill outcome.

Neither proves how well real Jev performs on your data. That is what the live
evaluation is for (step 9), and it is deliberately not part of `pnpm verify`.

## 5. Use the core without DSH

The core has no harness dependency. A minimal integration:

```ts
import { createJevCore, LiveTypeSafeProvider, noul } from '@buberlo/jev-core'

const core = createJevCore({
  provider: new LiveTypeSafeProvider({ apiKey: process.env.TYPESAFE_API_KEY! }),
  mode: 'enforce',
})

const result = await core.evaluate({
  state: { ticket: 'I was charged twice. Please fix this.' },
  questions: { urgent: noul('Does this message need immediate attention?') },
})

if (result.ok) console.log(result.answers.urgent.noul) // probability of yes
```

`pnpm example:game` is the same idea with a deterministic world and no
network.

## 6. Install the plugin into a DSH profile

```sh
pnpm --filter @buberlo/jev-core pack --pack-destination ./packs
pnpm --filter @buberlo/dsh-jev pack --pack-destination ./packs

dsh plugin --profile demo add ./packs/buberlo-jev-core-0.1.0.tgz
dsh plugin --profile demo add ./packs/buberlo-dsh-jev-0.1.0.tgz
dsh --profile demo --dump-config | grep -A 2 'buberlo'
```

You should see a `# == @buberlo/dsh-jev` layer with one `jev` row. The plugin
starts in `mock + shadow`: it computes decisions and logs them, but nothing
about your agent changes yet.

## 7. Shadow, then enforce

Run your profile normally and read the logs:

```text
[dsh-jev] tool selection selected {"mode":"shadow","selected":2,...}
[dsh-jev] tool assessment ask {"tool":"write_file","rule":"assessment.missing-information",...}
```

`mode: shadow` is where you decide whether the thresholds fit your workload
(they are uncalibrated defaults — see `docs/policy.md`). When the logged
decisions look right, switch the row to `mode: enforce`:

```yaml
- id: jev
  name: '@buberlo/dsh-jev'
  config:
    provider: mock        # keep mock while you tune
    mode: enforce
```

What changes in enforce mode:

| Decision | Effect |
|---|---|
| selection `selected` | the visible tool set narrows to the chosen tools (+ alwaysAllow + uncertain alternatives) |
| assessment `ask` | the call runs only after your DSH approval answerer allows it |
| assessment `hold`/`deny` | the call does not run; the model sees the rule that caused it |
| loop guard | the next identical repeated call is denied |
| model route | the request uses the configured, verified-available model |
| skill hint | one bounded suggestion line is injected for that turn |

Failures still fall back or ask — never allow.

## 8. Tune it from the web client (web profiles)

A web or desktop profile mounts the plugin's configuration page on the
**Plugins** page, under this bundle. The card explains the integration and
lets you change, live and without a restart:

- **mode** — `off`, `shadow`, or `enforce`; the hint under the buttons says
  exactly what changes;
- **feature toggles** — selection, assessment, loop guard, skills, model
  routing.

What you see:

- the current **provider** (the card cannot edit it — the API key is a secret
  and stays in `cordis.yml`);
- each toggle with its settings field path, so the value you change is
  traceable back to the configuration.

Writes go into the host settings document (the same place a user-edited
`settings.yaml` would), and the running service reconfigures on every
committed change. If a write is rejected, the card shows the schema error and
the last good configuration stays active.

Headless profiles have no web client; skip this step — the plugin behaves the
same from its composed entry.

## 9. Go live (optional)

```yaml
- id: jev
  name: '@buberlo/dsh-jev'
  config:
    provider: live
    mode: shadow            # observe real Jev first
    apiKey: !!js process.env.TYPESAFE_API_KEY
```

- The key is never read implicitly; without it the plugin fails at load with an
  explicit message.
- `live + shadow` still sends state to TypeSafe. The plugin logs a warning at
  load to make that impossible to miss.
- What is sent: bounded task text, step label, tool ids/descriptions, bounded
  and redacted argument values, configured restrictions. Nothing else.

Evaluate with real answers without touching the agent:

```sh
TYPESAFE_API_KEY=... pnpm evals -- --live
```

Without a key this prints `live evaluation NOT EXECUTED` — a non-run is never
reported as a pass. See `docs/evaluation.md` for what the numbers mean (and do
not mean).

## 10. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `provider "live" requires an explicit apiKey` | you set `provider: live` without a key; add `apiKey` or use `mock`/`off` |
| `tool selection restriction rejected: … unknown global tool` | a selected tool id is not a global registration; check `selection.toolCategories` and tool names |
| No skill is ever selected | `ctx.skills` is not mounted, or the skill is not model-invocable, or `skills.enabled` is false |
| Model routing never applies | the target is not in the live provider catalog; the adapter falls back rather than routing anyway |
| Decisions never change behavior | `mode` is still `shadow` (check the `[dsh-jev] loaded` log line) |
| Everything is very slow | lower `budgetMs`, raise thresholds, or disable selection/assessment individually |

## Where to go next

- `docs/use-cases.md` — what to build with this
- `docs/policy.md` — every question, threshold, and decision rule
- `docs/architecture.md` — how the pieces fit, and the LangChain comparison
- `docs/roadmap.md` — honest status and known limits
