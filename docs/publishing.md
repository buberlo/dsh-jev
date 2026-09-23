# Publishing (manual, after an explicit decision)

There is **no** automatic release, publish, or deployment workflow in this
repository, and adding one is out of scope. Publishing is a manual step.

**Status (`npm view` 2026-09-23):** both `@buberlo/jev-core` and
`@buberlo/dsh-jev` list **`0.1.0`, `0.1.2`, `0.1.3`, and `0.1.4`**. There is
no `0.1.1`. Dist-tag `latest` is **`0.1.4`** for both. Workspace
`package.json` is **`0.1.4`**.

`@buberlo/dsh-jev@0.1.2` was packed with npm rather than pnpm, so the
published tarball still depends on `@buberlo/jev-core` with a literal
`workspace:^`. `npm install @buberlo/dsh-jev@0.1.2` fails with
`EUNSUPPORTEDPROTOCOL`. The downloaded `@buberlo/dsh-jev@0.1.3` tarball has
the same literal `workspace:^` and fails the same way. Do not recommend
either plugin version. `@buberlo/jev-core@0.1.2` and `@buberlo/jev-core@0.1.3`
do install (`@typesafe-ai/sdk@0.6.0`).

`0.1.3` was abandoned. A granular bypass-2FA token stages versions, and
republish of the staged version is rejected with E409 ("Cannot publish over
previously staged version"). The publish that replaced it is **`0.1.4`**.
`npm install @buberlo/dsh-jev@0.1.4` succeeds and resolves
`@buberlo/jev-core@0.1.4` (`^0.1.4`). That is a package install, not a rerun
of the DSH profile boot.

The `0.1.0` profile path was verified when that was the only version:
`dsh plugin add @buberlo/dsh-jev` composed the bundle layer, the host plugin
loaded, and a running web app served `@buberlo/dsh-jev/client.js`. That
profile boot has not been repeated for `0.1.4`. The steps below stay the
manual process for a future release. Pack and publish with pnpm so
`workspace:` is rewritten.

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

# 4. Verify the consumed form of the version just published.
#    Pin it. 0.1.2 and 0.1.3 of @buberlo/dsh-jev do not install.
dsh plugin --profile demo add @buberlo/dsh-jev@<version>
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
  not workflows. No `0.1.1`, `0.1.2`, `0.1.3`, or `0.1.4` git tag exists yet.
  The published npm line is `0.1.4`. Do not republish `0.1.2` or `0.1.3`.
