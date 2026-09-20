# Policy

Everything in this document is implemented in `@buberlo/jev-core` and exercised
by unit tests. No model output ever becomes a free-form explanation; decisions
carry a rule id, the measured values, and the resulting action.

## Thresholds — uncalibrated defaults

These are **starting values, not calibrated operating points** for any target
application. Calibrate them against your own data before relying on them.

`pnpm calibrate` measures each fixture once and sweeps the thresholds in code,
reporting agreement and the parameter range of every perfectly agreeing
combination. The first live run (2026-09-19, 25 fixtures) placed the defaults
inside wide ranges — e.g. `restriction` 0.30..0.85 — which means the sample
cannot separate values inside that range. Treat the sweep as a way to find a
starting region and to detect wrong polarity, not as a finished calibration.

| Setting | Default | Meaning |
|---|---|---|
| `thresholds.relevance` | 0.5 | minimum Noul probability for a category/skill to count as relevant |
| `thresholds.selection` | 0.35 | minimum probability of the chosen candidate |
| `thresholds.confidence` | 0.3 | minimum reported confidence before acting on a Choice/Score |
| `thresholds.restriction` | 0.5 | at/above this Noul probability a restriction conflict denies |
| `thresholds.missingInformation` | 0.5 | at/above this Noul probability missing information asks |
| `thresholds.taskMatch` | 0.35 | below this Noul probability the call asks |
| `thresholds.skill` | 0.5 | minimum "needs a skill" probability |
| `thresholds.modelRoute` | 0.4 | minimum route-choice probability |

Ordinal score, probability, and confidence stay distinct. The optional risk
Score is an ordinal position on a 3-level rubric; it is never normalized into
a "risk percentage", and it does not drive the assessment precedence.

## Decision actions

| Action | Meaning | DSH mapping (enforce) |
|---|---|---|
| `allow` | proceed | `next()` |
| `ask` | require approval for this exact call | `{ kind: 'ask', reason }` |
| `hold` | withhold without a policy denial | `{ kind: 'cancel' }` |
| `deny` | policy denial with a deterministic reason | `{ kind: 'deny', reason, info }` |

Precedence is monotonic: `deny > hold > ask > allow`. Combining evidence can
only make a decision stricter. Failure-derived decisions are `ask`/`hold` only;
configuration rejects an assessment failure policy that could allow.

## Tool selection

Questions (`state` = bounded task + step + untrusted-data notice):

1. Per category: `rel_<category>` — Noul
   *"Is a tool from the category … relevant for completing the current task?"*
   Categories are evaluated independently; a single distribution over all
   tools is deliberately not used.
2. Per relevant category: `pick_<category>` — Choice over the category's tool
   ids plus `__none__`.

Selection rules:

- restricted candidates are removed locally and recorded in
  `diagnostics.restrictedSkipped`; they are never transmitted;
- a category is relevant when `noul ≥ relevance`;
- a candidate is selected when `choice ≠ __none__` and
  `probabilities[choice] ≥ selection`;
- when the winner is uncertain (`__none__`, below `selection`, or confidence
  below `confidence`) the top two alternatives become `expand` entries;
- the union of `selected` and `expand` is capped by `maxSelectedTools` and every
  dropped id is recorded in `diagnostics.prefiltered` (no silent truncation);
- status is `selected`, `abstained` (explicit "no candidate"), `fallback`
  (failure), or `off`;
- in enforce mode only `selected` results narrow the visible set, and never
  below the always-allowed list or above the currently authorized set.

## Tool-call assessment

One batched request with independent questions. State names the concrete
call under `call` (`tool` + bounded `arguments`) plus `task`, `restrictions`,
and an untrusted-data notice. The questions judge **that call**, not the
task as a whole: an observe-only call (read, list, search) does not violate
a restriction that forbids modifying or deleting.

Wording is the current call-scoped text in
`packages/jev-core/src/assessment.ts` (workspace `0.1.2`). The published npm
`0.1.0` still uses the older task-level phrasing ("this action"), which
false-positived harmless reads when the task mentioned a restricted file.

| Question id | Type | Text |
|---|---|---|
| `matches_task` | Noul | Does this tool call serve the current task or work step? |
| `missing_information` | Noul | Does the specific tool call described in `call` need information that is not present in the task or in the call arguments? |
| `violates_restriction` | Noul | Does the specific tool call described in `call` contradict a restriction listed in `restrictions`? |
| `risk` (optional) | Score | How severe is the impact if this tool call is wrong? |

Criteria sent with the questions (the restriction `false` criterion is the
observe-vs-modify distinction):

| Question id | `true` / level | `false` / meaning |
|---|---|---|
| `matches_task` | The call directly advances the stated task or step. | The call does not serve the stated task or step. |
| `missing_information` | A required value, file, target, or confirmation for this exact call is absent from the task and the call arguments. | The call arguments and the task already contain everything this exact call needs; nothing has to be looked up or confirmed before it can run. |
| `violates_restriction` | The tool call itself does what a restriction forbids. | The tool call only observes, or is unrelated to what the restrictions forbid. Calls that only observe (read, list, search) do not violate a restriction that forbids modifying or deleting. |
| `risk` (default levels) | *No material impact; the action is fully reversible.* · *Reversible impact that needs manual cleanup.* · *Hard-to-reverse or destructive impact.* | Score is ordinal and does not gate. |

Rules (first match wins in precedence, all matches reported):

1. `noul(violates_restriction) ≥ restriction` → **deny**
2. `noul(missing_information) ≥ missingInformation` → **ask**
3. `noul(matches_task) < taskMatch` → **ask**
4. otherwise → **allow**

Failure handling: provider error, response validation failure, timeout, abort,
or a stale snapshot (turn/catalog changed while awaiting) applies
`onFailure.toolAssessment` (`ask` or `hold`, default `ask`). A failure is never
an allow, and the decision is applied only in `enforce` mode.

## Loop detection

No Jev involved — a deterministic local invariant:

- `tools/result` counts consecutive identical `(tool id, bounded arguments)`
  calls per agent (observe-only, never modifies the result);
- a synchronous monotonic guard denies the next identical call once the
  counter reaches `loopDetection.maxRepeats` (default 2, meaning the third
  identical call is denied);
- a new user message resets the chain;
- the counter map is bounded (`maxSubjects`) and has no retry escalation.

## Model routing

- One Choice over the configured route classes plus `default`.
- The chosen class is resolved through the user's mapping to a real
  `{ provider, model }` pair.
- The pair is applied only if it appears in the live provider catalog
  (`ctx.llm.listProviders()` + `listModels()`); otherwise the existing model is
  kept, with the reason recorded. No model id or provider route is invented.
- A computed route suggestion is not an executed model change; the adapter
  performs the change only on `agent/request` in enforce mode.

## Skill routing

- One Noul ("does this turn need a skill?") plus one Choice over model-invocable
  skill names plus `__none__`; only metadata (name, description, when-to-use) is
  transmitted, never skill bodies.
- `skills.routingHints` appends extra routing guidance per skill name without
  editing the vendored skill file; the combined when-to-use text is bounded by
  `skills.maxDescriptionChars` separately from the description, so a hint
  cannot be truncated away by a long upstream description.
- Selection requires the needs-skill threshold, the selection threshold, and
  the confidence threshold.
- Enforce mode injects one bounded one-line hint per turn; the skill body is
  loaded only by the normal skill mechanism if it helps.

## Redaction and bounds

- Field-name fragments (`password`, `token`, `apikey`, `authorization`,
  `cookie`, `credential`, `secret`, …) are replaced with `[redacted]`.
- Strings, arrays, object keys, and nesting depth are bounded.
- State and arguments are truncated with an explicit marker.
- Redaction is an additional measure, not guaranteed anonymization; callers
  remain responsible for what they place into the task or arguments.
