# Publishing (manual, after an explicit decision)

There is **no** automatic release, publish, or deployment workflow in this
repository, and adding one is out of scope. Publishing is a manual step.

**Status (verified with `npm view` 2026-09-20):** both `@buberlo/jev-core` and
`@buberlo/dsh-jev` are on npm at **`0.1.0` only** (first release 2026-09-19).
There is **no `0.1.1` on the registry.** Workspace `package.json` is
**`0.1.2`**: package READMEs (a local `0.1.1` bump that was never published)
plus the call-scoped assessment wording that stops observe-vs-modify false
positives. `0.1.2` is built, packed and verified locally, and awaits one
manual publish. The `0.1.0` registry install path is verified: `dsh plugin add
@buberlo/dsh-jev` composed the bundle layer, the host plugin loaded, and a
running web app served `@buberlo/dsh-jev/client.js`. The steps below are the
manual process for the next release.

## Why `@buberlo/jev-core` publishes first

`@buberlo/dsh-jev` depends on the published version of `@buberlo/jev-core`.
That is what lets a single `dsh plugin add @buberlo/dsh-jev` (or a
plugin-only tarball install) resolve the core transitively. The alternative —
bundling the core into the plugin — was rejected: it duplicates the policy
code and prevents the core from being reused standalone (games, search, MCP
routers), which is an explicit goal of this repository.

## Steps

```sh
# 1. Authenticate once (interactive; token stays in the local npm config).
npm login

# 2. Verify the exact artifacts that would be uploaded.
pnpm build
pnpm --filter @buberlo/jev-core publish --dry-run --access public --no-git-checks
pnpm --filter @buberlo/dsh-jev publish --dry-run --access public --no-git-checks

# 3. Publish in dependency order.
pnpm --filter @buberlo/jev-core publish --access public --no-git-checks
pnpm --filter @buberlo/dsh-jev publish --access public --no-git-checks

# 4. Verify the consumed form.
dsh plugin --profile demo add @buberlo/dsh-jev
```

## Before each publish

- Confirm the npm account owns the `@buberlo` scope (`npm org ls buberlo` or a
  successful `--dry-run`).
- Run `pnpm verify` on the exact commit to publish.
- `pnpm publish` runs the package's `prepare` (full build including the client
  bundle), so the tarball contains `lib/index.js`, `lib/client.js`, and types.
- `pnpm publish` refuses a dirty working tree; commit first.
- Keep versions exact in dependencies; never publish a `workspace:` protocol
  literally (pnpm rewrites it on pack/publish).

## After publishing

- Record the published versions from `npm view` (not workspace `package.json`)
  in `docs/upstream-compatibility.md`, `docs/publishing.md`, and the README
  npm row. Do not claim a version is on the registry until `npm view` shows it.
- Tag the release commit manually (`git tag -a v<version> -m ...`); tags are
  not workflows. No `0.1.1` or `0.1.2` tag exists yet; the next publish is
  workspace `0.1.2`.
