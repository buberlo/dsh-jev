# Upstream compatibility

Verification date: **2026-09-19**. Everything below was checked against the
sources named here, not against examples copied from earlier discussions.

## Versions and sources

| Source | Version / commit | How it was obtained |
|---|---|---|
| `deepseek-ai/deepseek-harness` | commit `ddefc45fbc7f8e46dd73185e68295696d1297887` (2026-09-17), root version `0.1.6-alpha.2` | `git clone --depth 1` into a temporary directory |
| `@deepseek-ai/dsh-*` npm packages | `0.1.6-alpha.2` (published; `dsh-tools` also carries `latest: 0.0.1-rc.1`) | `npm view` + installs |
| `@deepseek-ai/dsh` (product CLI) | `0.1.6-alpha.2` | `npm install` into a temporary directory |
| `@deepseek-ai/cordis` | `4.0.2` | npm |
| `@deepseek-ai/schemastery` | `3.18.2` | npm |
| `@typesafe-ai/sdk` | `0.6.0` | npm + published `src/types.ts`, `src/client.ts`, `src/questions.ts` at tag `v0.6.0` |
| TypeSafe docs | docs.typesafe.ai (`llms.txt`, primitives, confidence, models, cookbooks) | fetched |
| Node.js | tested with `26.9.0`; DSH engines require `^22.19.0 || >=24.0.0` | local |
| pnpm | `12.4.2` | local |

All DSH packages named below are **published and externally installable** at
`0.1.6-alpha.2`; no private workspace package is assumed. Each direct
dependency is pinned to an exact version and `pnpm-lock.yaml` is committed.

## Externally verified interfaces

The file references are from the cloned DSH source at the commit above.

### Plugin shape and injection

- A Cordis plugin is `export default class ... extends Service` with
  `static inject` and `static Config` (schemastery) — `packages/core/tools/src/index.ts:789-830`.
- Services are accessed through a context and are `this`-rebound to the
  accessing context; **private `#field`s do not survive the Cordis service
  proxy** (the getter runs with a derived object as `this`). The plugin uses
  TypeScript `private` fields for this reason (found by an integration test
  failure, not by reading).
- The bundle/profile install path is `dsh.bundle.patch` in `package.json` plus
  a `cordis.patch.yml` row (`docs/user/develop/basic/publish.md`,
  `docs/cookbook/adding-a-package.md`).

### Tool lifecycle (the MVP extension points)

- `tools/pre-execute` waterfall:
  `(exec: ToolExecution, next) => Promise<PreToolDecision>` —
  `packages/core/tools/src/index.ts:146`; decision type at `:589`
  (`allow | deny{reason,info?} | cancel | ask{reason?}`).
- `tools/result` observe-only emit: `packages/core/tools/src/index.ts:191`;
  result is deep-frozen; listener failures contained (used for loop counting).
- `ctx.tools.restrict(filter)` requires a **scoped** context (`agent.ctx`) and
  fails on empty filters, unknown global names, scope-local names, and the
  reserved `run_code` transport — `packages/core/tools/src/index.ts:1077-1104`.
  Restrictions intersect and never affect scoped registrations.
- `ctx.tools.guard(guard)` is synchronous and monotonic; no guard can turn a
  denial back into permission — `packages/core/tools/src/index.ts:1116-1122`.
- `ctx.tools.get(name, scope)` / `ctx.tools.schemas(scope)` expose the scope's
  visible set; a global-only lookup (`get(name)` with no scope) is how the
  adapter filters names that `restrict()` may legally mention —
  `packages/core/tools/src/index.ts:1210`, `:1240`.
- The pipeline order is fixed: pre-execute → guards → execute → post-execute →
  finalizeContent → result (`packages/core/tools/README.md`).
- `tools/pre-execute` **cannot rewrite arguments** (upstream limitation,
  `packages/core/tools/README.md` "Known Limitations"), so approval binding
  relies on per-call assessment instead of argument rewriting.

### Agent scope, lifecycle, and model config

- `agent.ctx` is the agent-scoped context (`packages/core/agent/src/runtime-types.ts:174`);
  the loop mints it with `createScope(loopCtx, agent)`
  (`packages/core/agent-loop/src/agent.ts:104`).
- `agent/pre-step` waterfall receives `{ agent, messages, turn, step, signal }`
  — `packages/core/agent/src/runtime-types.ts:320`.
- `agent/request` waterfall receives `{ agent, turn, step, signal }` and its
  `next()` returns an `LlmCallConfig` that may be replaced
  (`packages/core/agent/src/runtime-types.ts:337`,
  `packages/llm/llm/src/call-config.ts:23`). This is the verified mechanism for
  model routing.
- `agent.inject(UserMessage)` queues model-facing context for a later step
  (`packages/core/agent/src/runtime-types.ts:241`) — used for the bounded skill
  hint.
- `agent/disposed` is the teardown notification
  (`packages/core/agent/src/runtime-types.ts:270`).

### Approval and skills

- `ask` runs only after the approval service returns `allowed-once` and fails
  closed when no answerer is composed (`packages/interaction/user-approval/README.md`);
  `approval/request` is a waterfall, and an approval is per request. This is
  the verified approval mechanism; no local approval cache exists.
- `ctx.skills.list({ scope })` returns `SkillSummary` metadata, and
  `isModelInvocable(skill)` honors the invocation policy
  (`packages/skill/skill/src/index.ts:470`, `:126`).

### TypeSafe Jev (System One)

- SDK: `new TypeSafeClient(config)`, `client.systemOne(request, options)` with
  `{ state, questions, model }` and options `{ signal, timeout, retry, headers }`
  (`@typesafe-ai/sdk@0.6.0` `src/client.ts`).
- Reply: `{ model, answers, usage }`; the SDK's own retry policy defaults to
  `maxRetries: 2`, per-attempt timeout 10 000 ms, and the SDK redacts known
  credential headers but **not bodies** at `debug`. The plugin therefore
  defaults the SDK log level to `off` and does not add a second retry loop.
- Primitives and answer shapes (`src/types.ts`, docs):
  - Choice: `{ type:'choice', choice, confidence, probabilities }`; option map
    in the request; documented limit 255 options.
  - Score: `{ type:'score', score, confidence, legend, probabilities }`;
    probabilities keyed by level index; 2–10 levels; `score` is a
    probability-weighted mean that may fall between levels.
  - Noul: `{ type:'noul', noul }` — **no confidence field**; the core never
    synthesizes one.
- Documented model limits: 64k context per request, 32k for `state` plus the
  longest question; aliases `jev-latest` / `jev-preview` (currently both
  `jev-1.13.0`).
- `validateQuestions` rejects empty question maps and score criteria that are
  not a list of at least two entries (SDK `src/questions.ts`).

## Installation path that was actually executed

Reproducible local proof (see also `scripts/packaging-test.mjs`):

1. `pnpm build`, then `pnpm pack` both packages.
2. Fresh consumer project: `npm install <core.tgz> <dsh-jev.tgz> <pinned DSH peers>`
   → plugin loads, fails closed, and resolves the **consumer's** Cordis
   instance (no second runtime bundled).
3. `tsc --noEmit` against the installed declarations → clean.
4. Real product CLI: `npm install @deepseek-ai/dsh@0.1.6-alpha.2`, profile
   created with `--from-default-profile headless`, our tarballs placed in the
   profile and the bundle name added to `dsh.profile.bundles`.
   - `dsh --profile <name> --dump-config` prints the
     `# == @buberlo/dsh-jev` layer with the `jev` row.
   - Booting with a `live`-without-key patch fails through
     `cordis-plugin-loader` with our exact config error, proving the real
     loader instantiated `JevRuntime`.
   - Booting with valid config reaches the LLM credential/authentication stage,
     i.e. the tree (including this plugin) mounted.

## Demonstrated restrictions

- **Not published**: `@buberlo/jev-core` and `@buberlo/dsh-jev` are not on npm.
  `dsh plugin add` resolves the transitive `@buberlo/jev-core` from the
  registry, so until the core is published, both tarballs must be direct
  dependencies of the profile.
- **PTC / code mode**: `run_code` sub-dispatches traverse the same pipeline and
  are assessed (tested with a nested dispatch), but a full PTC runtime was not
  mounted here; `mode: ptc` would additionally require
  `@deepseek-ai/dsh-ptc-runtime-node` or equivalent.
- **Model catalog is advisory**: `ctx.llm.listModels()` is documented as
  advisory and does not validate routing, so the adapter treats absence from
  the catalog as "not verified" and falls back to the existing model. A route
  is never invented.
- **No live run**: without `TYPESAFE_API_KEY` the live path is explicitly
  reported as *not executed*, never as passed.
- **Approval requires an open turn** upstream; assessments only run inside the
  tool pipeline, so this is satisfied by construction.
