#!/usr/bin/env bash
# Reliable manual deploy for the Aligned/Hader server (run ON the server).
#
# Why this exists: the manual SSH deploy used to "git reset + restart" and skip
# rebuilding the workspace packages that api/worker import as COMPILED dist
# (@aligned/db, @aligned/shared, both gitignored). Skipping that shipped stale
# Zod schemas / Prisma client — a fix would "deploy" but not take effect (the
# 2026-06-12 overnight-hours incident). This script ALWAYS rebuilds those
# packages, regenerates the Prisma client, runs migrations, rebuilds web only
# when web source changed, reinstalls only when the lockfile changed, restarts
# the services, and health-checks. One command, no skippable steps.
#
# Usage:  bash infra/scripts/redeploy.sh
set -euo pipefail

APP_DIR=${APP_DIR:-/opt/aligned/app}
API_HEALTH_URL=${API_HEALTH_URL:-https://api.hader.ai/health}
cd "$APP_DIR"

echo "▶ Fetching origin/main…"
# Diff against the last SUCCESSFULLY-deployed SHA, not the pre-reset HEAD. If a
# prior run aborted (e.g. a prisma-generate flake) AFTER git reset but BEFORE
# the web rebuild, HEAD already moved — diffing PREV→NEW would then show no
# changes and wrongly skip the web build. .last-deployed-sha only advances on a
# fully successful run, so this stays correct across aborted runs.
LAST=$(cat .last-deployed-sha 2>/dev/null || true)
git fetch origin --quiet
git reset --hard origin/main
NEW=$(git rev-parse HEAD)
echo "  ${LAST:-<unknown>} → $NEW"

# No known-good baseline (or invalid) → rebuild everything to be safe.
if [ -n "$LAST" ] && git cat-file -e "$LAST^{commit}" 2>/dev/null; then
  CHANGED=$(git diff --name-only "$LAST" "$NEW" || true)
else
  CHANGED="apps/web/ pnpm-lock.yaml"
fi

# Load production env (DATABASE_URL/DIRECT_DATABASE_URL for prisma, NEXT_PUBLIC_*
# baked into the web build, SECRET_ENCRYPTION_KEY for the crypto extension).
set -a; . ./.env.production; set +a

# Install when the lockfile changed OR when devDependencies are missing. The
# build + migrate steps need `prisma` (the CLI) and `tsc`, which are BOTH
# devDependencies — and this script sources .env.production, which sets
# NODE_ENV=production, so a plain `pnpm install` (or anything that prunes to
# prod deps out-of-band) strips them and the next deploy dies with
# "tsc: not found" / "prisma not found". `--prod=false` forces devDeps back in.
NEED_INSTALL=0
echo "$CHANGED" | grep -q '^pnpm-lock.yaml$' && NEED_INSTALL=1
# The build/migrate steps need these per-package bins (tsc + prisma). pnpm's
# frozen check can report "up to date" while a package's node_modules/.bin is
# actually missing its symlinks, so check the real bins, not just the lockfile.
[ -x node_modules/.bin/tsc ] || NEED_INSTALL=1
[ -x packages/db/node_modules/.bin/prisma ] || NEED_INSTALL=1
[ -x packages/db/node_modules/.bin/tsc ] || NEED_INSTALL=1
[ -x packages/shared/node_modules/.bin/tsc ] || NEED_INSTALL=1
if [ "$NEED_INSTALL" = 1 ]; then
  echo "▶ Reinstalling dependencies (clean relink, incl. devDeps)…"
  # Why rm + plain install instead of `pnpm install --force`:
  #   - pnpm --frozen-lockfile alone can report "up to date" while a package's
  #     node_modules/.bin symlinks are missing → build fails with tsc/prisma
  #     not found.
  #   - `--force` fixes that BUT re-extracts every package from the pnpm store,
  #     and a corrupted store entry then aborts the whole deploy
  #     (ENOENT copyfile … — seen in prod after an interrupted install).
  # Removing the workspace node_modules and doing a NON-force install relinks
  # cleanly from the store and re-fetches anything missing, without the
  # store-wide re-extraction that --force triggers.
  # CI=1 + confirmModulesPurge=false keep it non-interactive (no Y/n prompt).
  rm -rf node_modules apps/*/node_modules packages/*/node_modules
  CI=1 pnpm install --frozen-lockfile --prod=false --config.confirmModulesPurge=false
fi

echo "▶ Regenerating Prisma client…"
# Retry up to 3× — prisma generate occasionally flakes (transient OOM under
# concurrent load) and `set -e` would otherwise abort the whole deploy.
GEN_OK=0
for attempt in 1 2 3; do
  if pnpm --filter @aligned/db exec prisma generate >/dev/null 2>&1; then
    GEN_OK=1
    break
  fi
  echo "  prisma generate flaked (attempt $attempt) — retrying…"
  sleep 3
done
[ "$GEN_OK" = 1 ] || { echo "  ✗ prisma generate failed 3× — aborting"; exit 1; }

echo "▶ Rebuilding workspace packages consumed as dist (ALWAYS, clean)…"
# Wipe dist + the incremental tsbuildinfo first. tsc's incremental cache can go
# stale (e.g. index.js referencing a schema whose .js was never re-emitted),
# which surfaces downstream as a web build error like "Can't resolve
# './schemas/user.js'". A clean emit every deploy is cheap and removes the class
# of bug entirely.
rm -rf packages/db/dist packages/db/tsconfig.tsbuildinfo \
       packages/shared/dist packages/shared/tsconfig.tsbuildinfo
pnpm --filter @aligned/db build
pnpm --filter @aligned/shared build

echo "▶ Applying migrations…"
pnpm --filter @aligned/db exec prisma migrate deploy

WEB_CHANGED=0
if echo "$CHANGED" | grep -q '^apps/web/'; then
  echo "▶ web source changed — rebuilding Next…"
  rm -rf apps/web/.next
  pnpm --filter @aligned/web build
  WEB_CHANGED=1
else
  echo "▶ web unchanged — skipping web build."
fi

echo "▶ Restarting services…"
sudo systemctl restart aligned-api aligned-worker
[ "$WEB_CHANGED" = 1 ] && sudo systemctl restart aligned-web

echo "▶ Service status:"
systemctl is-active aligned-api aligned-worker aligned-web || true

# Health check with retry — the api runs under tsx and cold-starts in ~10-20s,
# so a single immediate probe gives a false 502. Poll for up to ~60s.
echo "▶ Health check (waiting for cold start)…"
HEALTHY=0
for i in $(seq 1 20); do
  if curl -fsS --max-time 10 "$API_HEALTH_URL" >/dev/null 2>&1; then
    HEALTHY=1
    echo "  ✓ $API_HEALTH_URL OK (after ~$(( i * 3 ))s)"
    break
  fi
  sleep 3
done
if [ "$HEALTHY" != 1 ]; then
  echo "  ✗ HEALTH CHECK FAILED after ~60s — investigate (journalctl -u aligned-api -n 100)"
  exit 1
fi
# Record the known-good SHA ONLY on full success, so an aborted future run
# still diffs against this baseline (see top of file).
echo "$NEW" > .last-deployed-sha
echo "✓ Deploy complete: $NEW"
