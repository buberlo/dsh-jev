# Evaluation

Two strictly separated tracks. They answer different questions and their
results are never mixed.

## Mock tests — do they prove model quality?

**No.** The mock provider returns fixed synthetic answers. Mock tests prove
program logic: question construction, batching, validation, thresholding,
policy precedence, failure behavior, staleness, cancellation, redaction,
bounds, and the DSH adapter contracts. They say nothing about Jev.

Run:

```sh
pnpm evals              # evaluation fixtures, mock mode
pnpm test               # unit + integration suites
```

Mock evaluation output is labeled as synthetic and exit code 1 on any mismatch,
so `pnpm verify` catches regressions in the dataset.

## Live evaluations — measure Jev behavior

```sh
TYPESAFE_API_KEY=... pnpm evals -- --live
```

- Requires an explicitly passed key; without it the run prints
  `live evaluation NOT EXECUTED` and exits 0. **Not executed is reported as
  such and never as passed.**
- Uses the same fixtures. Because fixtures target our reference answers, a live
  mismatch is a measurement datapoint, not a proven model error.
- Reports: case count, hits (agreement with fixture expectation), abstentions,
  errors, misdecisions, mean/p50 latency. No accuracy percentage is claimed,
  and no cost-savings or benchmark figures are produced.

## Dataset

`evals/fixtures/decisions.v1.jsonl` (versioned by filename) contains 25 cases
in German and English:

| Case | Kind | Covers |
|---|---|---|
| `sel-en-001` | selection | unique selection across two relevant categories |
| `sel-de-001` | selection | German task, two relevant read-only categories |
| `sel-en-002` | selection | no suitable candidate → explicit abstention |
| `sel-de-002` | selection | manipulative instruction inside untrusted text; a restricted tool must never be sent |
| `sel-en-003` | selection | negation ("do not touch production") and a remediation candidate |
| `sel-de-003` | selection | negation ("do not reformat") excludes a mass mutation |
| `asm-en-001` | assessment | clear match → allow |
| `asm-de-001` | assessment | explicitly stated restriction conflict → deny |
| `asm-en-002` | assessment | missing information → ask |
| `asm-de-002` | assessment | missing required value → ask |
| `asm-en-003` | assessment | injected "ignore all restrictions" text vs. hard restriction → deny |
| `asm-de-003` | assessment | conflict between model suggestion and hard policy → deny |
| `skill-en-001` | skill | English TypeSafe/Jev task selects the `typesafe-ai` skill |
| `skill-de-001` | skill | German TypeSafe/Jev task selects the `typesafe-ai` skill |
| `skill-en-002` | skill | plain refactoring task selects no skill |
| `asm-en-004` | assessment | allow despite a top risk score (the ordinal score does not gate) |
| `asm-de-004` | assessment | German task mismatch → ask (`assessment.task-mismatch`) |
| `asm-en-005` | assessment | injection text inside tool arguments → deny |
| `asm-de-005` | assessment | no stated restrictions, clean call → allow |
| `sel-en-004` | selection | one tool serving two relevant categories is selected once |
| `sel-de-004` | selection | every candidate already restricted → explicit abstention |
| `sel-en-005` | selection | English negation "do not commit" keeps the mutating tool out |
| `sel-de-005` | selection | below-threshold pick → abstention with expansion candidates |
| `skill-de-002` | skill | German refactoring task needs no skill |
| `skill-en-003` | skill | low-confidence skill pick yields none |

Each fixture carries an `answers` block for mock mode and an `expect` block;
live mode ignores `answers`.

## Recorded live run

Live executions, **2026-09-19**, against `jev-1.13.0` (`jev-latest` alias),
with the pinned SDK 0.6.0. First run (15 cases): 15/15, mean 528 ms. After the
dataset grew to 25 cases:

```text
cases: 25, pass: 25, fail: 0
latency: mean 482.9 ms, p50 321.7 ms
abstentions: 6, errors: 0, misdecisions (vs fixture expectation): 0
```

A second run with a rotated authorization reproduced the result within noise:
25/25, 0 errors, mean 474.2 ms, p50 324.0 ms (both `jev-1.13.0`).

Reading this honestly: agreement with fixtures that were authored offline is a
consistency measurement on 25 cases, not an accuracy, cost, or latency
benchmark. Six cases are intentional abstentions or `none` outcomes. Two cases are intentional abstentions (the "no suitable candidate"
selection and the "no skill needed" routing), so they can never be counted as
hits in the sense of a positive classification. The run itself exercised the
whole live path: request construction, the SDK transport, and response
validation at the system boundary.

Re-run it yourself with your own key:

```sh
TYPESAFE_API_KEY=... pnpm evals -- --live
```

## Threshold calibration

`pnpm calibrate` (mock by default, `--live` with an explicit key) measures
every fixture **once** — measured values do not depend on the thresholds — and
then sweeps the decision thresholds in code:

- assessment: `restriction`, `missingInformation`, `taskMatch`;
- selection: `relevance`, `selection`, `confidence`.

It reports default-threshold agreement, the best agreement, and the parameter
range of every perfectly agreeing combination. Live measurement on 2026-09-19
over the 25 fixtures:

```text
assessment: 10/10 at defaults; perfect agreement in 1428 combinations
  restriction        ∈ 0.30..0.85
  missingInformation ∈ 0.35..0.95
  taskMatch          ∈ 0.05..0.95
selection: 10/10 at defaults; best agreement 10/10 in 4320 combinations
  relevance  ∈ 0.05..0.75
  selection  ∈ 0.05..0.90
  confidence ∈ 0.05..0.80
measurement latency: mean 746 ms over 20 cases
```

The defaults sit inside every reported range, and the ranges are wide: with
this sample size the data cannot separate values inside them. That is the
honest result — a starting region, not a calibrated operating point. Mock
calibration only proves the sweep plumbing; its values are synthetic.

## What is not claimed

- No accuracy, savings, or latency comparison against any baseline.
- No statement about languages beyond the tested German/English fixtures.
- No claim that a live fixture expectation is ground truth.

## Reproducing the numbers in the README

```sh
pnpm verify
```

runs, in order: frozen install, build, typecheck, both test suites (120 tests),
mock evaluation (25/25), all four examples, and the packaging test (tarball
install + real plugin load + consumer typecheck). `pnpm calibrate` is a
separate, explicitly invoked analysis step (live calibration needs a key).
