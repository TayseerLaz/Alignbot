#!/usr/bin/env bash
# Daily Postgres backup → Wasabi.
#
# Encrypts the dump with age, uploads, and prunes anything older than 30 days.
# Schedule via crontab on the prod host:
#   5 3 * * * /srv/aligned/infra/scripts/backup.sh >> /var/log/aligned-backup.log 2>&1
#
# Required env vars (load via /etc/aligned/backup.env):
#   POSTGRES_USER POSTGRES_PASSWORD POSTGRES_DB POSTGRES_HOST
#   WASABI_BUCKET WASABI_ENDPOINT WASABI_ACCESS_KEY_ID WASABI_SECRET_ACCESS_KEY
#   AGE_RECIPIENT      # e.g. "age1xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
set -euo pipefail

if [[ -f /etc/aligned/backup.env ]]; then
  # shellcheck disable=SC1091
  source /etc/aligned/backup.env
fi

: "${POSTGRES_DB:?required}"
: "${POSTGRES_USER:?required}"
: "${POSTGRES_PASSWORD:?required}"
: "${POSTGRES_HOST:=localhost}"
: "${WASABI_BUCKET:?required}"
: "${WASABI_ENDPOINT:?required}"
: "${AGE_RECIPIENT:?required}"

STAMP=$(date -u +"%Y%m%dT%H%M%SZ")
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

DUMP="$TMP/aligned-$STAMP.sql.gz"
ENCRYPTED="$DUMP.age"

echo "[backup] dumping…"
PGPASSWORD="$POSTGRES_PASSWORD" pg_dump \
  --host="$POSTGRES_HOST" --username="$POSTGRES_USER" \
  --format=custom --no-owner --no-privileges \
  --dbname="$POSTGRES_DB" \
  | gzip -9 > "$DUMP"

echo "[backup] encrypting…"
age --encrypt --recipient "$AGE_RECIPIENT" --output "$ENCRYPTED" "$DUMP"

echo "[backup] uploading to s3://$WASABI_BUCKET/backups/aligned/…"
AWS_ACCESS_KEY_ID="$WASABI_ACCESS_KEY_ID" \
AWS_SECRET_ACCESS_KEY="$WASABI_SECRET_ACCESS_KEY" \
aws --endpoint-url "$WASABI_ENDPOINT" s3 cp "$ENCRYPTED" \
  "s3://$WASABI_BUCKET/backups/aligned/$(basename "$ENCRYPTED")"

echo "[backup] pruning > 30 days…"
CUTOFF=$(date -u -d "30 days ago" +"%Y%m%d" 2>/dev/null || date -u -v-30d +"%Y%m%d")
AWS_ACCESS_KEY_ID="$WASABI_ACCESS_KEY_ID" \
AWS_SECRET_ACCESS_KEY="$WASABI_SECRET_ACCESS_KEY" \
aws --endpoint-url "$WASABI_ENDPOINT" s3 ls "s3://$WASABI_BUCKET/backups/aligned/" \
  | awk '{print $4}' | grep -E '\.sql\.gz\.age$' || true \
  | while read -r key; do
      key_date=$(echo "$key" | sed -E 's/aligned-([0-9]{8})T.*/\1/')
      if [[ -n "$key_date" && "$key_date" < "$CUTOFF" ]]; then
        echo "  removing $key"
        AWS_ACCESS_KEY_ID="$WASABI_ACCESS_KEY_ID" \
        AWS_SECRET_ACCESS_KEY="$WASABI_SECRET_ACCESS_KEY" \
        aws --endpoint-url "$WASABI_ENDPOINT" s3 rm "s3://$WASABI_BUCKET/backups/aligned/$key"
      fi
    done

echo "[backup] done."
