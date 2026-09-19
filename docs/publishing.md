# Publishing (manual, after an explicit decision)

There is **no** automatic release, publish, or deployment workflow in this
repository, and adding one is out of scope. Publishing is a manual step.

**Status: registry version is `0.1.1` (2026-09-19); the local `0.1.2` (assessment question fix found by the use-case benchmark) is built, packed and verified, and awaits one manual publish.** `0.1.0` was the first release; `0.1.1` added the package READMEs. The registry
install path is verified: `dsh plugin add @buberlo/dsh-jev` composed the bundle
layer, the host plugin loaded, and a running web app served
`@buberlo/dsh-jev/client.js`. The steps below are the manual process for the
next release.

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

## Before the first publish

- Confirm the npm account owns the `@buberlo` scope (`npm org ls buberlo` or a
  successful `--dry-run`).
- Run `pnpm verify` on the exact commit to publish.
- `pnpm publish` runs the package's `prepare` (full build including the client
  bundle), so the tarball contains `lib/index.js`, `lib/client.js`, and types.
- `pnpm publish` refuses a dirty working tree; commit first.
- Keep versions exact in dependencies; never publish a `workspace:` protocol
  literally (pnpm rewrites it on pack/publish).

## After publishing

- Simplify the README install section to the single-package form.
- Record the published versions in `docs/upstream-compatibility.md`.
- Tag the release commit manually (`git tag -a v0.1.1 -m ...`); tags are not
  workflows.
