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
- **Live provider**: fully implemented, not executed here (no credentials).
- **Packages are not published to npm**, and there is intentionally no release
  workflow; until then both tarballs must be profile dependencies.
- **Thresholds are uncalibrated defaults**; they need tuning against real data.

## Planned (not implemented)

- Calibration tooling for thresholds against a labelled dataset.
- Per-category pre-selection with a documented second-stage ranking for very
  large taxonomies (> 255 candidates) beyond the current chunking.
- An approval-answerer example for headless DSH deployments.
- Optional evaluation against a recorded session fixture for regression
  comparisons.
- Publishing `@buberlo/jev-core` to npm so the plugin can be installed alone.

## Out of scope

Training or self-hosting Jev, a DSH fork, a dashboard/database, a general MCP
platform, and any automatic deployment or release pipeline.
