# Publishing (manual, after an explicit decision)

There is **no** automatic release, publish, or deployment workflow in this
repository, and adding one is out of scope. Publishing is a manual step.

As of 2026-09-19 **neither package is on npm**, and `npm whoami` reports no
authenticated npm user in the development environment. Until that changes,
install from tarballs as described in the README.

## Why publish `@buberlo/jev-core` first

`@buberlo/dsh-jev` depends on the exact version of `@buberlo/jev-core`.
`dsh plugin --profile <name> add ./buberlo-dsh-jev-0.1.0.tgz` resolves that
transitive dependency from the registry, so without a published core the user
must install both tarballs as direct dependencies (the current documented
path). The alternative — bundling the core into the plugin — was rejected: it
duplicates the policy code and prevents the core from being reused standalone
(games, search, MCP routers), which is an explicit goal of this repository.

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
- Tag the release commit manually (`git tag -a v0.1.0 -m ...`); tags are not
  workflows.
