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

`evals/fixtures/decisions.v1.jsonl` (versioned by filename) contains 15 cases
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

Each fixture carries an `answers` block for mock mode and an `expect` block;
live mode ignores `answers`.

## What is not claimed

- No accuracy, savings, or latency comparison against any baseline.
- No statement about languages beyond the tested German/English fixtures.
- No claim that a live fixture expectation is ground truth.

## Reproducing the numbers in the README

```sh
pnpm verify
```

runs, in order: frozen install, build, typecheck, both test suites (114 tests),
mock evaluation (15/15), all four examples, and the packaging test (tarball
install + real plugin load + consumer typecheck).
