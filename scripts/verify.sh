#!/usr/bin/env bash
# Local verification for dsh-jev. No network calls except the pnpm install and
# the packaging test's npm install of pinned public packages.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== install (frozen lockfile) =="
pnpm install --frozen-lockfile

echo "== build =="
pnpm build

echo "== typecheck =="
pnpm typecheck

echo "== unit + integration tests =="
pnpm test

echo "== offline evaluation (mock) =="
pnpm evals

echo "== examples =="
pnpm example:coding > /dev/null
pnpm example:ops > /dev/null
pnpm example:game > /dev/null
pnpm example:dsh | tail -3

echo "== packaging test (tarballs in a temporary consumer) =="
pnpm test:packaging

echo
echo "verify: OK"
