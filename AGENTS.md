# AGENTS.md

Project-specific rules and commands. Keep this file short.

## What this repository is

Two packages: `@buberlo/jev-core` (harness-independent decision core, TypeSafe
Jev) and `@buberlo/dsh-jev` (real DeepSeek Harness plugin/bundle binding the
core to verified extension points). `examples/` are runnable; `evals/` holds the
versioned de/en dataset; `tests/` live inside the plugin package.

## Permanent requirements

- Pin every direct dependency exactly; commit `pnpm-lock.yaml`. Never use
  `latest` aliases.
- Never read `TYPESAFE_API_KEY` implicitly. Live access requires
  `provider: live` **and** an explicit `apiKey`.
- A model answer may only gate execution (`ask`/`hold`/`deny`). Never derive an
  allow from a failure or from model output alone. Local invariants (sandbox,
  permission, loop guard) stay deterministic and monotonic.
- Use the async `tools/pre-execute` waterfall for assessment; never call Jev
  from a synchronous guard.
- Always call `next()` before composing a pre-execute decision; a Jev decision
  must not skip later policies.
- Restricted candidates must never be transmitted; redaction is an extra
  measure, not anonymization.
- No persistent decision cache. Approvals are per call; changed arguments are
  assessed again.
- Do not commit secrets, customer data, or real credentials.
- No automatic release, publish, or deployment workflows.
- Keep mock, shadow, and live behavior clearly separated in docs and output.
- No claim of support without an executed test for that exact path.

## Commands

```sh
pnpm install            # workspace install (runs per-package tsc prepare)
pnpm build              # tsc for both packages
pnpm typecheck          # tsc --noEmit for both packages
pnpm test               # vitest run per package (core 85, dsh-jev 62)
pnpm test --filter ...  # see vitest docs; use pnpm --filter <pkg> test
pnpm evals              # mock evaluation fixtures (offline, 25 cases) plus the on-prem support set
pnpm calibrate          # threshold sweep over the fixtures (mock; --live with a key)
pnpm bench:compare      # deterministic with/without-Jev comparison (scripted model)
pnpm bench:cli          # CLI A/B harness (needs BENCH_* gateway settings)
pnpm example:coding     # offline example (synthetic)
pnpm example:ops        # offline example (synthetic)
pnpm example:game       # offline example (core only)
pnpm example:dsh        # real DSH services + real plugin (synthetic answers)
pnpm test:packaging     # tarballs → temp consumer → load + types
pnpm verify             # the full gate above; run before finishing any task
```

## Conventions

- TypeScript strict, NodeNext ESM, explicit `.js` specifiers in imports.
- `exactOptionalPropertyTypes`: build optional fields conditionally
  (`...(x === undefined ? {} : { x })`).
- Cordis services: TypeScript `private` fields, not `#` (the service proxy
  breaks private fields).
- Vitest integration tests use the real DSH packages, the real ToolRuntime
  pipeline, and the real agent loop via `@deepseek-ai/dsh-agent-loop-testkit`;
  only the LLM is a deterministic scripted test adapter.
- Decisions and logs carry rule ids and measured values, never generated prose.

## Pointers

- `docs/architecture.md` — how the pieces fit
- `docs/upstream-compatibility.md` — verified versions, interfaces, limits
- `docs/policy.md` — thresholds, questions, decisions
- `docs/evaluation.md` — mock vs live, dataset, reporting
- `docs/roadmap.md` — honest status
