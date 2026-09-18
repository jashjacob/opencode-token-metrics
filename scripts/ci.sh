#!/usr/bin/env sh
# Local CI: the same checks as the GitHub workflow, run on this machine.
#
#   npm run ci
#
# Installs dependencies only when node_modules is missing, then runs the test
# suite, typecheck, the packed-package smoke test, and a pack dry-run.
set -eu
cd "$(dirname "$0")/.."

if [ ! -d node_modules ]; then
  echo "== npm ci =="
  npm ci
fi

echo "== npm test =="
npm test

echo "== npm run typecheck =="
npm run typecheck

echo "== npm run smoke =="
npm run smoke

echo "== npm pack --dry-run =="
npm pack --dry-run

echo
echo "local CI passed on node $(node -v)"
