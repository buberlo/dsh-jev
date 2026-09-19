# Roadmap

Status is honest: implemented and tested, implemented with limits, or planned.
Nothing here is a promise of a release.

## Implemented and tested

- `@buberlo/jev-core`
  - TypeSafe primitives re-exported with boundary validation (missing answers,
    unknown candidates, invalid numbers, wrong answer types, invalid
    distributions; Noul confidence never invented).
  - Deterministic `MockJevProvider`; `LiveTypeSafeProvider` with explicit API
    key, SDK-owned retries, `off` logging by default, and error classification
    (auth, permission, rate limit, bad request, timeout, aborted, connection,
    server).
  - `evaluate()`, `selectTools()`, `assessToolCall()`, `routeSkills()`,
    `routeModel()`, serializable decision rules, monotonic decision precedence.
  - Bounded concurrency, whole-call budget, cancellation, redaction/bounding,
    deterministic loop detector.
- `@buberlo/dsh-jev`
  - Real Cordis service `ctx.jev` (default class plugin with schemastery
    `Config`), bundle patch, verified bundle/profile install path.
  - Per-agent state with disposal; two-session isolation.
  - Dynamic tool selection with scoped `tools.restrict` and a defined recovery
    path.
  - Call assessment on the async `tools/pre-execute` waterfall with approval
    composition and no premature allow.
  - Observe-only result counting plus a deterministic monotonic loop guard.
  - Model routing on `agent/request` with catalog verification and fallback.
  - Skill routing with bounded hint injection.
  - Explicit `off` / `shadow` / `enforce` modes and `mock` / `live` providers.
- Examples: coding, read-only ops, standalone game (core only), real DSH
  runtime.
- Vendored TypeSafe agent skill (`.agents/skills/typesafe-ai`, pinned upstream
  commit + license) with real-provider discovery and routing tests, a
  configured routing-hint overlay, and de/en evaluation cases.
- Web client configuration page for the bundle (`plugins.bundle.config`):
  provider/mode/feature state plus immediate settings writes through the host
  settings document, covered by host and browser tests. A running `web`
  profile serves the client module (verified end to end with the `dsh` CLI).
- First live TypeSafe evaluation (2026-09-19, `jev-1.13.0`): 15/15 fixture
  agreement, 0 errors, mean 528 ms — recorded as a measurement in
  `docs/evaluation.md`.
- Manual publish runbook (`docs/publishing.md`) and a test-only CI workflow
  (`.github/workflows/verify.yml`); no release or deployment automation.
- Evaluation dataset grown to 25 de/en cases (negations, injection, duplicate
  category membership, all-restricted catalogs, below-threshold picks, task
  mismatch, risk-score non-gating) and a threshold calibration sweep
  (`pnpm calibrate`) with a first live measurement.
- Registry distribution: `dsh plugin add @buberlo/dsh-jev` verified end to end
  (profile layer, host load, served client module).
- Packaging test: tarballs in a fresh consumer, real plugin load, consumer
  typecheck, single-Cordis check.
- Real `dsh` CLI profile composition and loader instantiation.

## Implemented with documented limits

- **Code mode / PTC**: nested sub-dispatches traverse the same assessment gate
  (tested), but a full PTC runtime was not mounted; `mode: ptc` additionally
  requires `@deepseek-ai/dsh-ptc-runtime-node` or equivalent.
- **Model routing**: availability uses the live provider catalog, which DSH
  documents as advisory; absence falls back rather than routing anyway.
- **Skill routing**: injects a bounded hint only; automatic skill body loading
  is not attempted (the normal skill mechanism remains in charge).
- **Web client page**: edits mode, provider, the write-only API key, and
  feature toggles; model and base URL stay in `cordis.yml`. It shows
  configured state, not live counters (see the blocked Remote capability in
  `docs/upstream-compatibility.md`).
- **Client test runtime**: the published
  `@deepseek-ai/dsh-client-test-runtime@0.1.6-alpha.2` cannot be loaded from
  npm (it imports renderer `src/` paths the published renderer does not ship),
  so the browser tests exercise `apply()` and the component directly.
- **Live provider**: fully implemented, not executed here (no credentials).
- **Published** (first release `0.1.0` on 2026-09-19, currently `0.1.1`); future releases stay manual
  (`docs/publishing.md`), intentionally without release automation.
- **Thresholds are uncalibrated defaults**; `pnpm calibrate` now reports the
  region they sit in, but the 25-case sample cannot separate values inside it.
  Real calibration needs labeled cases per consequence class.

## Planned (not implemented)

- Labeled calibration corpus with enough cases per consequence class to narrow
  the reported threshold ranges.
- Per-category pre-selection with a documented second-stage ranking for very
  large taxonomies (> 255 candidates) beyond the current chunking.
- An approval-answerer example for headless DSH deployments.
- Optional evaluation against a recorded session fixture for regression
  comparisons.
- Publishing `@buberlo/jev-core` to npm so the plugin can be installed alone.

## Out of scope

Training or self-hosting Jev, a DSH fork, a dashboard/database, a general MCP
platform, and any automatic deployment or release pipeline.
