# Session 3 — Operational checklist (the tasks Claude couldn't execute)

> **Who runs this:** A human with access to the Aligned Cloud Servers,
> Wasabi, GitHub, DNS, UptimeRobot, and the three pilot clients.
> **When:** after Sessions 1 + 2 have landed on `main` and typecheck is
> green. Run top-to-bottom; nothing later works until the earlier steps
> are complete.
>
> Code for Session 3 items **that could be done in code** is already
> merged (accessibility + security fixes, spec amendment, backup script
> hardening, UptimeRobot integration behind env vars). Everything below is
> the human/ops half.

---

## 3.4 — Pre-deploy: accounts, DNS, secrets

### 3.4.1 Wasabi (S3-compatible object storage)

1. **wasabi.com** → create account → create an **Access Key** pair.
2. Create a production bucket: `aligned-prod-<region>` (e.g. `aligned-prod-eu-central-1`).
3. Create a second bucket for backups: `aligned-backups-<region>`.
4. Bucket policy: block public access on both.
5. Capture and save to your password manager:
   - `WASABI_ENDPOINT` (e.g. `https://s3.eu-central-1.wasabisys.com`)
   - `WASABI_REGION` (e.g. `eu-central-1`)
   - `WASABI_BUCKET` (the **prod** bucket; backups uses its own env)
   - `WASABI_ACCESS_KEY_ID`
   - `WASABI_SECRET_ACCESS_KEY`

### 3.4.2 Aligned Cloud Server

1. Provision a VM (2 vCPU / 4 GB RAM / 40 GB disk — the recommended pilot size).
2. Create a deploy user (e.g. `aligned`) with `sudo` access for `systemctl`.
3. Generate an SSH keypair on your laptop specifically for CI:
   ```bash
   ssh-keygen -t ed25519 -f ~/.ssh/aligned_deploy -N ""
   ssh-copy-id -i ~/.ssh/aligned_deploy.pub aligned@<server-ip>
   ```
4. Confirm `ssh aligned@<server-ip>` works keyless.
5. Install on the server: Docker, docker compose plugin, `age`, `awscli`, `postgresql-client` (for `pg_dump`).

### 3.4.3 DNS

Two A records at your DNS provider, pointing at the server's public IP:
- `alignbot.aligned-tech.com` → portal (web)
- `api.aligned-tech.com` → API

Caddy handles Let's Encrypt automatically once DNS resolves.

### 3.4.4 AWS SES (production email)

Already DKIM-verified per `CLAUDE.md`. Confirm:
1. Domain out of sandbox (SES console → Account dashboard).
2. Capture SMTP credentials (not root IAM keys — SES-specific SMTP user):
   - `EMAIL_SMTP_HOST` (e.g. `email-smtp.eu-central-1.amazonaws.com`)
   - `EMAIL_SMTP_PORT` = `587`
   - `EMAIL_SMTP_USER`
   - `EMAIL_SMTP_PASS`
   - `EMAIL_SMTP_SECURE` = `false` (STARTTLS)
   - `EMAIL_FROM` = `"ALIGNED <noreply@alignbot.aligned-tech.com>"`

### 3.4.5 GitHub Actions secrets

Repo → Settings → Secrets and variables → Actions → New repository secret:

| Secret | Value |
|---|---|
| `DEPLOY_HOST` | your server's public IP or hostname |
| `DEPLOY_USER` | `aligned` |
| `DEPLOY_SSH_KEY` | contents of `~/.ssh/aligned_deploy` (the **private** key) |
| `GHCR_PAT` | a GitHub PAT with `write:packages` |
| `API_DOMAIN` | `api.aligned-tech.com` |

### 3.4.6 `.env.production` on the server

SSH in and create `/srv/aligned/.env.production` (chmod 600, owned by `aligned:aligned`):

```ini
NODE_ENV=production
LOG_LEVEL=info

API_HOST=0.0.0.0
API_PORT=4000
API_PUBLIC_URL=https://api.aligned-tech.com
WEB_PUBLIC_URL=https://alignbot.aligned-tech.com
CORS_ORIGINS=https://alignbot.aligned-tech.com

DATABASE_URL=postgres://aligned_app:<strong-pass>@pgbouncer:6432/aligned?schema=public&pgbouncer=true&connection_limit=40
DIRECT_DATABASE_URL=postgres://aligned_app:<strong-pass>@postgres:5432/aligned?schema=public
REDIS_URL=redis://redis:6379/0

JWT_ACCESS_SECRET=<openssl rand -hex 48>
JWT_REFRESH_SECRET=<openssl rand -hex 48>
COOKIE_DOMAIN=aligned-tech.com
COOKIE_SECURE=true

EMAIL_FROM="ALIGNED <noreply@alignbot.aligned-tech.com>"
EMAIL_SMTP_HOST=email-smtp.eu-central-1.amazonaws.com
EMAIL_SMTP_PORT=587
EMAIL_SMTP_USER=<from 3.4.4>
EMAIL_SMTP_PASS=<from 3.4.4>
EMAIL_SMTP_SECURE=false

WASABI_ENDPOINT=https://s3.eu-central-1.wasabisys.com
WASABI_REGION=eu-central-1
WASABI_BUCKET=aligned-prod-eu-central-1
WASABI_ACCESS_KEY_ID=<from 3.4.1>
WASABI_SECRET_ACCESS_KEY=<from 3.4.1>

RATE_LIMIT_AUTH_PER_MINUTE=10
RATE_LIMIT_API_PER_SECOND=100
RATE_LIMIT_READ_API_PER_SECOND=200

SENTRY_DSN=<optional; from sentry.io project settings>
SENTRY_ENVIRONMENT=production
SENTRY_TRACES_SAMPLE_RATE=0.1

# After 3.7 below is set up:
UPTIMEROBOT_API_KEY=<read-only monitor API key>
UPTIMEROBOT_MONITOR_IDS=<csv of monitor ids — optional>
```

---

## 3.5 — Deploy

1. Push to `main`. `.github/workflows/deploy.yml` should:
   - run `pnpm install`, typecheck, test
   - build api/worker/web Docker images
   - push them to `ghcr.io/<org>/aligned-{api,worker,web}:<sha>` and `:latest`
   - SSH to `$DEPLOY_HOST`, run `cd /srv/aligned && docker compose -f docker-compose.prod.yml pull && docker compose -f docker-compose.prod.yml up -d`
   - run `pnpm --filter @aligned/db exec prisma migrate deploy`
   - smoke-test `curl -f https://api.aligned-tech.com/health`

2. Watch the Actions tab. If the deploy job fails at the SSH step, `ssh` into the server and inspect `docker compose -f docker-compose.prod.yml logs --tail=200` to triage.

3. **Do not move on** until:
   - `https://alignbot.aligned-tech.com` loads the login page over HTTPS.
   - `https://api.aligned-tech.com/health` returns `{"ok":true}`.
   - `https://api.aligned-tech.com/docs` renders the OpenAPI UI.

---

## 3.6 — Load test from outside

Run k6 from a machine **not** on the server (same-machine hides network):

```bash
# Issue a throwaway API key first via the portal, then:
export API_KEY=ak_live_xxxxxxxxxxxxxxxxxxxxxxxx
export BASE_URL=https://api.aligned-tech.com
k6 run infra/scripts/load-test.js
```

**Accept thresholds** (per amended §7.1 #3):
- `http_req_duration{expected_response:true} p(95) < 200`
- `http_req_duration{expected_response:true} p(99) < 400`
- `http_req_failed rate < 0.01`

If p95 is over 200 ms: check Redis cache hit ratio (should be mostly `HIT`
on repeat keys), verify PgBouncer is in transaction-pooling mode, and
re-check CPU usage on the VM mid-test. Scale up the droplet before
blaming the code.

---

## 3.7 — UptimeRobot (code side is done; you do the account + monitors)

1. Sign up at **uptimerobot.com** (free tier is fine — 50 monitors, 5-min checks).
2. Create two HTTP(s) monitors:
   - Name: `aligned-api`  ·  URL: `https://api.aligned-tech.com/health`  ·  interval: 5 min
   - Name: `aligned-portal`  ·  URL: `https://alignbot.aligned-tech.com`  ·  interval: 5 min
3. Settings → "My Settings" → API Settings → create a **Read-Only API key** at the account level.
4. Put `UPTIMEROBOT_API_KEY=ur-xxxxxxxxxxxxxxxxxxxxxx` in `/srv/aligned/.env.production`.
5. *(Optional)* `UPTIMEROBOT_MONITOR_IDS=7654321,7654322` to scope the admin tile to just these two. Leave blank to show every monitor on the account.
6. Restart the API container: `docker compose -f docker-compose.prod.yml restart api`.
7. Verify: `/aligned-admin/system` in the portal now shows an **Uptime** card with both monitors.
8. Add a contact (email / Slack) in UptimeRobot so on-call gets paged when either monitor goes red.

---

## 3.8 — Seed 3 pilot tenants

On the server:

```bash
cd /srv/aligned
docker compose -f docker-compose.prod.yml exec api \
  pnpm --filter @aligned/db exec tsx ./seed/pilot.ts
```

This creates three orgs (`pilot-cafe`, `pilot-clinic`, `pilot-store`),
each with an admin user, sample data, and an API key printed once.

**Store the three API keys immediately in 1Password**, one vault item per
pilot. They're hashed at rest in the DB — if you lose the plain value,
issue a new one from the portal, then rotate on the bot side.

---

## 3.9 — Pilot onboarding (2–4 week calendar window)

For each pilot:

1. **Kick-off call.** Walk them through [NO_CODE_CHATBOT_PLAYBOOK.md](NO_CODE_CHATBOT_PLAYBOOK.md):
   - Load products (Path A, B, or C)
   - Fill Business Info (hours, FAQs, policies)
   - Meta Business account + WhatsApp app setup (Meta verification is the long pole — **start this on day 1** because it takes 3–10 business days)
   - Landbot connection (or whatever bot they chose)
   - Test from their own phone
2. **72-hour check-in.** Look at:
   - `/dashboard` — are products/services/faqs populated?
   - `/audit-log` — are they actually editing?
   - `/api-keys` — has `lastUsedAt` populated? (if yes → bot is reading)
   - `/webhooks` → deliveries tab — any auto-disabled endpoints?
3. **Collect feedback** — simple form: what surprised you, what broke, what did you wish existed. Feed into 3.10.
4. **2-week review.** Any pilot with zero catalog writes in 2 weeks is *not* meeting success criterion §7.1 #5. Triage before going to GA.

---

## 3.10 — Bug fixes from pilot feedback

Triage rule: a pilot-reported issue gets fixed *this week* if:
- It blocks any of the 7 amended §7.1 criteria, or
- More than 1 of the 3 pilots has independently hit it.

Everything else goes on a backlog and is revisited before the Phase 2
kick-off.

Re-run Sessions 1+2 deploy-gate tests after every hotfix — tenant
isolation and audit/account round-trips must stay green.

---

## 3.11 — Backup cron (code is done; you install it)

On the server:

1. Install `age`, `awscli`, `postgresql-client` on the **host** (the
   backup script runs outside Docker so it can be restored even if the
   compose stack is down).
2. Generate an age keypair for backups:
   ```bash
   age-keygen -o /etc/aligned/backup.key
   chmod 400 /etc/aligned/backup.key
   chown root:root /etc/aligned/backup.key
   # Print the recipient line to put in backup.env:
   age-keygen -y /etc/aligned/backup.key
   ```
3. **Store the private key in 1Password** too — if the server dies you
   need it to decrypt the backups.
4. Create `/etc/aligned/backup.env`:
   ```ini
   POSTGRES_HOST=localhost
   POSTGRES_USER=aligned
   POSTGRES_PASSWORD=<strong-pass>
   POSTGRES_DB=aligned
   WASABI_BUCKET=aligned-backups-eu-central-1
   WASABI_ENDPOINT=https://s3.eu-central-1.wasabisys.com
   WASABI_ACCESS_KEY_ID=<your wasabi key>
   WASABI_SECRET_ACCESS_KEY=<your wasabi secret>
   AGE_RECIPIENT=age1xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
   HEALTHCHECK_URL=https://hc-ping.com/<uuid-from-healthchecks.io>
   RETENTION_DAYS=30
   ```
   `chmod 600 /etc/aligned/backup.env`.
5. Copy the script into place:
   ```bash
   sudo cp /srv/aligned/infra/scripts/backup.sh /usr/local/bin/aligned-backup.sh
   sudo chmod +x /usr/local/bin/aligned-backup.sh
   ```
6. Add the cron:
   ```bash
   sudo crontab -e
   # add:
   5 3 * * * /usr/local/bin/aligned-backup.sh >> /var/log/aligned-backup.log 2>&1
   ```
7. Run once by hand: `sudo /usr/local/bin/aligned-backup.sh` — should
   complete in under a minute for a young DB. Check the S3 listing:
   ```bash
   aws --endpoint-url "$WASABI_ENDPOINT" s3 ls s3://aligned-backups-eu-central-1/backups/aligned/
   ```
8. **Test restore once, before pilots onboard.** This is non-optional —
   an untested backup is a prayer, not a backup.
   ```bash
   # On a scratch machine or server with a throwaway Postgres:
   aws --endpoint-url "$WASABI_ENDPOINT" s3 cp \
     s3://aligned-backups-eu-central-1/backups/aligned/aligned-20260424T030500Z.dump.age ./restore.dump.age
   age --decrypt -i /etc/aligned/backup.key -o restore.dump restore.dump.age
   createdb aligned_restore
   pg_restore --no-owner --dbname aligned_restore restore.dump
   # Spot-check: row counts in a few tables should match prod.
   ```
9. Document the date of the successful restore in your ops log.

---

## Definition of done (Session 3)

Tick every box before declaring Phase 1 launched:

- [ ] Wasabi buckets + keys live (3.4.1)
- [ ] Aligned Cloud Server provisioned, SSH working keyless (3.4.2)
- [ ] DNS A records resolve (3.4.3)
- [ ] SES SMTP creds captured (3.4.4)
- [ ] GitHub Actions secrets set (3.4.5)
- [ ] `/srv/aligned/.env.production` in place, chmod 600 (3.4.6)
- [ ] First deploy succeeded; `/health`, `/docs`, portal all load over HTTPS (3.5)
- [ ] k6 from external machine: p95 < 200 ms, error rate < 1% (3.6)
- [ ] UptimeRobot monitors green; admin Uptime tile shows them (3.7)
- [ ] Backup cron installed; one successful manual run; **one successful test restore** (3.11)
- [ ] 3 pilot orgs seeded, API keys in 1Password (3.8)
- [ ] Each pilot has populated a catalog + issued an API key + has a working bot reading via that key (3.9)
- [ ] Week-2 triage done; blocking bugs fixed (3.10)
- [ ] Deploy-gate tests (tenant isolation, account round-trip, columnMapping) green on `main`
- [ ] `docs/SPEC_AMENDMENT_2026-04.md` is the authoritative §7.1
- [ ] `CLAUDE.md §5 Current Status` updated to "Phase 1 launched, serving real pilot traffic"

*Checklist owner: the first operator on-call for the launch week.*
