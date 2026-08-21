#!/usr/bin/env bash
# Setup helper: install-github — bundles the preflight + install commands
# from the /add-github skill into one idempotent script so /new-setup can
# run them programmatically before continuing to credentials.
#
# Copies the GitHub adapter in from the `channels` branch; appends the
# self-registration import; installs the pinned @chat-adapter/github package;
# builds. All steps are safe to re-run.
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

echo "=== NANOCLAW SETUP: INSTALL_GITHUB ==="

needs_install=false
[[ -f src/channels/github.ts ]] || needs_install=true
grep -q "import './github.js';" src/channels/index.ts || needs_install=true
grep -q '"@chat-adapter/github"' package.json || needs_install=true
[[ -d node_modules/@chat-adapter/github ]] || needs_install=true

if ! $needs_install; then
  echo "STATUS: already-installed"
  echo "=== END ==="
  exit 0
fi

echo "STEP: fetch-channels-branch"
git fetch origin channels

echo "STEP: copy-files"
# `> dest` truncates before git runs, so a git show that fails (branch gone,
# path not in the ref) would leave a 0-byte src/channels/github.ts behind — and
# the file-present check above reads that stub as an installed adapter on the
# next run. Stage alongside the destination and move it in only on success.
git show origin/channels:src/channels/github.ts > src/channels/github.ts.nc-tmp \
  || { rm -f src/channels/github.ts.nc-tmp; exit 1; }
mv src/channels/github.ts.nc-tmp src/channels/github.ts

echo "STEP: register-import"
if ! grep -q "import './github.js';" src/channels/index.ts; then
  printf "import './github.js';\n" >> src/channels/index.ts
fi

echo "STEP: pnpm-install"
pnpm install @chat-adapter/github@4.29.0

echo "STEP: pnpm-build"
pnpm run build

echo "STATUS: installed"
echo "=== END ==="
