# @buberlo/jev-core

Harness-independent decision core for [TypeSafe Jev](https://docs.typesafe.ai/)
(System One): typed questions, validated answers, deterministic policies, and
routing — usable in any application.

```
input state ──▶ provider (mock | live TypeSafe) ──▶ validated answers
                                                          │
                                              policy rules in YOUR code
                                                          │
                                             allow / ask / hold / deny
```

Jev answers small, fast semantic questions (Choice / Score / Noul). This package
never generates prose, never treats a model answer as permission, and never
hides the decision behind a black box: every result carries rule ids and the
measured values it used.

## Install

```sh
npm install @buberlo/jev-core
```

Node `^22.19.0 || >=24.0.0`. The only runtime dependency is the official
`@typesafe-ai/sdk` (pinned), used exclusively by the live provider.

## Quick start

```ts
import { createJevCore, LiveTypeSafeProvider, noul } from '@buberlo/jev-core'

const core = createJevCore({
  provider: new LiveTypeSafeProvider({ apiKey: process.env.TYPESAFE_API_KEY! }),
  mode: 'shadow',                     // off | shadow | enforce
})

const result = await core.evaluate({
  state: { ticket: 'I was charged twice. Please fix this.' },
  questions: { urgent: noul('Does this message need immediate attention?') },
})

if (result.ok) console.log(result.answers.urgent.noul) // probability of yes
```

Offline, deterministic, no key:

```ts
import { createJevCore, MockJevProvider } from '@buberlo/jev-core'
const core = createJevCore({ provider: new MockJevProvider(), mode: 'enforce' })
```

## Public API

| Function | Purpose |
|---|---|
| `createJevCore(config)` / `JevCore` | the configured core (provider, mode, thresholds, limits) |
| `evaluate(input)` | one batched request; validated answers + rule decisions |
| `selectTools(input)` | independent per-category relevance + per-category candidate choice, bounded and chunked |
| `assessToolCall(input)` | task fit, missing information, restriction conflict → `allow`/`ask`/`hold`/`deny` |
| `routeSkills(input)` | at most one relevant skill from metadata (never bodies) |
| `routeModel(input)` | a configured route class resolved to a real, available target |
| `choice()`, `score()`, `noul()` | typed question builders (re-exported from the official SDK) |
| `LoopDetector` | bounded deterministic repetition counter |
| `MockJevProvider`, `LiveTypeSafeProvider` | answer sources |

## Guarantees

- **Boundary validation.** Missing answers, unknown candidates, wrong answer
  types, out-of-range numbers, and invalid distributions are rejected.
- **No invented confidence.** Noul answers have no confidence field; anything
  the provider sends is dropped.
- **Monotonic decisions.** `deny > hold > ask > allow`; a failure produces
  `ask`/`hold` and configuration rejects an assessment failure policy that
  could allow.
- **Bounded and redacted.** Whole-call budget, per-attempt timeout, concurrency
  limit, state/argument bounds, secret-field redaction.
- **SDK-owned retries.** No second retry loop; the SDK's policy applies.

## Modes

| Mode | Requests | Behavior |
|---|---|---|
| `off` | none | nothing happens |
| `shadow` | yes | decisions are computed and logged only |
| `enforce` | yes | decisions are returned as applicable |

## Documentation

- Full project (DSH plugin, policies, evaluations):
  <https://github.com/buberlo/dsh-jev>
- `docs/policy.md` — questions, thresholds, decision precedence
- `docs/evaluation.md` — mock vs live, dataset, calibration
- `docs/architecture.md` — provider / policy / adapter split

## License

MIT
