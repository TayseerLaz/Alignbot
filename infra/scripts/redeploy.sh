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

if echo "$CHANGED" | grep -q '^pnpm-lock.yaml$'; then
  echo "▶ Lockfile changed — pnpm install…"
  pnpm install --frozen-lockfile
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

echo "▶ Rebuilding workspace packages consumed as dist (ALWAYS)…"
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
