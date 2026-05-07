# ALIGNED Business Platform — Runbook

This document is the source of truth for operating the platform in production.
Keep it up to date when procedures change.

---

## Topology

- **Aligned Cloud Server** running Docker Compose:
  - `caddy` (TLS terminator) → `web` (Next.js) and `api` (Fastify)
  - `worker` (BullMQ) consumes jobs from `redis`
  - `postgres` (data) ← `pgbouncer` (transaction pooling) ← `api` + `worker`
- **Wasabi** holds product images, CSV uploads, and encrypted DB backups
- **GitHub Container Registry** (`ghcr.io/<org>/aligned-{api,worker,web}`) holds versioned images
- **Sentry** receives unhandled exceptions
- **Prometheus** scrapes `/metrics` on the api (port 4000) and worker (port 9100)

## Domains

| Service | Domain |
|---|---|
| Portal (Next.js) | `app.aligned.com` |
| API + chatbot read API | `api.aligned.com` |

---

## Day-1 server bootstrap

1. SSH to the server, install Docker + Docker Compose plugin.
2. Clone the repo to `/srv/aligned`.
3. `cp .env.production.example .env.production`, edit, `chmod 600 .env.production`.
4. `docker login ghcr.io -u <username>` with a PAT that has `read:packages`.
5. `docker compose -f docker-compose.prod.yml --env-file .env.production pull`.
6. Run migrations once: `docker compose -f docker-compose.prod.yml --env-file .env.production run --rm api node node_modules/prisma/build/index.js migrate deploy --schema packages/db/prisma/schema.prisma`.
7. `docker compose -f docker-compose.prod.yml --env-file .env.production up -d`.
8. Verify: `curl -sf https://api.aligned.com/health` returns `{"status":"ok"}`.

---

## Deploys

Pushing to `main` triggers `.github/workflows/deploy.yml` which:

1. Builds and pushes new images to GHCR with the short commit SHA as the tag.
2. SSHes to the server, pulls the new images, runs Prisma migrations, and `up -d --remove-orphans`.
3. Smoke-tests `/health`.

If the smoke test fails the deploy job exits non-zero. The previous containers
keep running until the new ones are ready (Compose's default behaviour).

---

## Rollback

```bash
ssh deploy@aligned-cloud
cd /srv/aligned
export TAG=<previous-short-sha>
export REGISTRY=ghcr.io/<org>
docker compose -f docker-compose.prod.yml --env-file .env.production pull
docker compose -f docker-compose.prod.yml --env-file .env.production up -d --remove-orphans
```

If you also need to roll back a Prisma migration, see "Database migrations" below — Prisma does not auto-down-migrate; restore from backup is the safer path.

---

## Database migrations

- Schema lives in `packages/db/prisma/schema.prisma`.
- New migrations go through `pnpm db:migrate` locally first, committed, then `migrate deploy` runs in CI/CD.
- RLS policies are re-applied automatically after every migration via `pnpm rls:apply`.
- **Never** edit a migration file after it has been applied to production.

If a bad migration ships:
1. `docker compose stop api worker` (stop writes).
2. Decide: forward-fix (preferred) or restore from backup.
3. Forward fix → write a new migration that undoes the damage, deploy as usual.
4. Restore → see next section.

---

## Restore from backup

Backups are written nightly to `s3://aligned-prod/backups/aligned/` by `infra/scripts/backup.sh`. They are gzipped + age-encrypted with the recipient configured in `/etc/aligned/backup.env`.

```bash
# 1. Pull the dump
aws --endpoint-url $WASABI_ENDPOINT s3 cp \
  s3://$WASABI_BUCKET/backups/aligned/aligned-YYYYMMDDTHHMMSSZ.sql.gz.age .

# 2. Decrypt + decompress
age --decrypt --identity ~/.config/age/aligned.key aligned-*.sql.gz.age | gunzip > restore.sql

# 3. Stop writers
docker compose stop api worker

# 4. Restore
docker compose exec -T postgres psql -U $POSTGRES_USER $POSTGRES_DB < restore.sql

# 5. Re-apply RLS (just in case)
docker compose run --rm api node packages/db/scripts/apply-rls.ts

# 6. Start writers
docker compose start api worker
```

---

## Add a new tenant (manual)

If a pilot client needs a hand-held setup before self-serve signup is opened:

```bash
docker compose exec api node -e '
  const { PrismaClient } = require("@aligned/db");
  const p = new PrismaClient();
  (async () => {
    await p.$executeRawUnsafe("SET app.bypass_rls = on");
    const org = await p.organization.create({ data: { slug: "newclient", name: "New Client" } });
    console.log(JSON.stringify(org, null, 2));
    await p.$disconnect();
  })();
'
```

Then send the client an invitation through the ALIGNED admin UI.

---

## Rotate secrets

| Secret | Rotation procedure |
|---|---|
| `JWT_ACCESS_SECRET` | Generate new value, update `.env.production`, restart api. **Existing access tokens become invalid immediately**, users will reauthenticate via refresh cookie. |
| `JWT_REFRESH_SECRET` | Same as above; **also forces a full re-login**. Coordinate with users. |
| `EMAIL_SMTP_PASS` | In AWS IAM, delete the SES SMTP user's password and generate a new one. Update env, restart api. The `AKIA…` username stays the same. |
| `WASABI_*` | Issue new keys, update env, restart api+worker. Existing presigned URLs (15-min TTL) keep working until they expire. |
| API keys (per org) | Issue a new one in the portal `/api-keys`, hand to the bot operator, revoke the old. |
| Webhook signing secrets | The portal allows recreating an endpoint to rotate. |

---

## Common incidents

### Read API p95 spiking
1. Check `/metrics` — `http_request_duration_seconds` histogram.
2. Confirm Redis is healthy (`redis-cli ping`). Cache misses → DB hits → slowness.
3. If Redis is full (`maxmemory` reached): bump `--maxmemory` on Redis container or scale up.
4. If the DB is the bottleneck: check `pg_stat_activity`, kill long queries, consider read replicas.

### Worker queue depth growing
1. Check the ALIGNED admin panel → System health → Queues.
2. If `failed` is climbing: `docker logs aligned-worker | grep error`.
3. Scale worker replicas in `docker-compose.prod.yml` (`replicas: N`) and redeploy.

### Webhook deliveries failing
1. Check `/webhooks` page — endpoints with `consecutiveFailures > 0` are flagged.
2. Endpoints auto-disable after 25 consecutive failures.
3. Manual retry from the deliveries log if the customer's endpoint is back up.

### Broadcast stuck in `sending` with no progress
1. Check worker logs: `docker logs aligned-worker | grep broadcast`.
2. Verify the `broadcast-fanout` and `broadcast-send` queues are draining: ALIGNED admin → System health.
3. Check the WhatsApp channel is active (`/whatsapp` page) — token expiry or Meta-side disable.
4. Pause the broadcast (button on detail page), fix the underlying issue, then Resume.
5. The send worker auto-pauses after 25 consecutive recipient failures inside a 60s window; look for a `recipient_failed_burst` event in the timeline.

---

## Operating broadcasts

- **Audience materialization**: manual + segment recipients land in `broadcast_recipients` immediately on send. CSV recipients land in the fanout worker (streaming, restart-safe).
- **Per-org rate limit**: the send worker honors `WHATSAPP_SEND_TOKENS_PER_SECOND` (default 80). Bump after Meta tier upgrades.
- **Permanent vs transient errors**: the send worker classifies Meta error codes into permanent (skip + count as failed) and transient (BullMQ retries with exponential backoff up to 5 attempts).
- **Status updates**: delivered/read/failed on a recipient row are driven by the existing `message_status` webhook, joined by `meta_message_id`.
- **A/B tests**: 50/50 deterministic split by phone hash. Variant counters are inferred by filtering recipients on the detail page.

---

## Pilot onboarding checklist

For each new client:

- [ ] Create the org via `/aligned-admin` (or have client self-signup).
- [ ] Invite the client admin (their work email).
- [ ] Walk them through: products → services → business info.
- [ ] Issue an API key (in `/api-keys`) and hand the secret to the bot team.
- [ ] (Optional) Help them upload a CSV via `/imports`.
- [ ] (Optional) Set up an outbound webhook from the chatbot to the platform if the bot needs change notifications.
- [ ] Verify the read API works end-to-end:
      `curl -H "X-Aligned-Api-Key: $KEY" https://api.aligned.com/api/v1/read/products`
