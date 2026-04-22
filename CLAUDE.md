# ALIGNED Business Platform — CLAUDE.md

> **For next-day Claude:** Read the `## Current Status` section first, then check `## Resume Checklist` at the bottom. The full 4-day plan is the source of truth for scope — do not re-design; execute what's here.

---

## 1. Project Context

**What:** Multi-tenant SaaS where ALIGNED's clients manage product/service catalogs, FAQs, business info. ALIGNED's WhatsApp chatbots read from this platform via a cached, low-latency API.

**Phase 1 goal (this plan):** Ship the Data Management Platform end-to-end in **4 calendar days** of Claude-assisted development.

**Full spec:** See the project details doc the user pasted on 2026-04-19 (Phase 1 §3, NFRs §6, Architecture Appendix). Phase 2 (AI bot builder) is out of scope for these 4 days.

---

## 2. Locked Decisions (do not re-litigate)

| Area | Choice |
|---|---|
| Backend | Node.js 22 + **Fastify** + TypeScript |
| ORM | **Prisma** (migrations + type-safety); raw SQL for RLS policies |
| DB | **PostgreSQL 16** + **PgBouncer** (transaction pooling) |
| Cache / Queue | **Redis 7** + **BullMQ** |
| Frontend | **Next.js 15** (App Router) + Tailwind + **shadcn/ui** + **IBM Plex Sans** |
| Auth | In-house (jose JWT access + httpOnly refresh cookies + bcrypt). RBAC: ALIGNED admin / Client admin / Editor / Viewer |
| Storage | **Wasabi** (S3-compatible) via AWS SDK |
| WhatsApp | **Meta Cloud API** (official, not WBiztool) |
| Email | **Resend** |
| Hosting | **Aligned Cloud Servers** via Docker Compose + Caddy (auto TLS) |
| CI/CD | **GitHub Actions** |
| Observability | Pino + Sentry + Prometheus /metrics endpoint |
| Multi-tenancy | Shared schema, `organization_id` column on every tenant-scoped table, **Postgres RLS** enforced as backstop, middleware sets `app.current_org_id` per request |
| Brand colors | Mediterranean Blue primary; IBM Plex Sans |
| Package manager | **pnpm** workspaces + **Turborepo** |

---

## 3. Repo Structure

```
Alignbot/
├── apps/
│   ├── api/          # Fastify REST API
│   ├── worker/       # BullMQ workers (imports, syncs, webhooks)
│   └── web/          # Next.js 15 client portal + ALIGNED admin
├── packages/
│   ├── db/           # Prisma schema, migrations, seed, RLS SQL
│   ├── shared/       # Zod schemas, types, constants (used by api + web)
│   └── config/       # ESLint, tsconfig bases, Prettier
├── infra/
│   ├── caddy/        # Caddyfile for TLS + reverse proxy
│   ├── pgbouncer/    # pgbouncer.ini
│   └── scripts/      # deploy.sh, backup.sh, load-test.sh
├── .github/workflows/
│   ├── ci.yml        # lint + typecheck + test on PR
│   └── deploy.yml    # build + push + SSH deploy on main
├── docker-compose.yml        # dev
├── docker-compose.prod.yml   # prod
├── pnpm-workspace.yaml
├── turbo.json
├── tsconfig.base.json
├── .env.example
└── CLAUDE.md         # this file — always update Status at end of session
```

---

## 4. The 4-Day Plan

Each day is roughly 8–12 hours of Claude-assisted work. Each day ends with something demoable.

### Day 1 — Foundation, Auth, Portal Shell ✅ COMPLETE (2026-04-19)

**End-of-day demo:** User can sign up, verify email, log in, see an empty dashboard styled in ALIGNED brand, invite a teammate with a role.

- [x] **1.1** pnpm + Turbo monorepo scaffold (root package.json, pnpm-workspace.yaml, turbo.json, tsconfig.base.json)
- [x] **1.2** Shared tooling in `packages/config` (ESLint flat config, Prettier, tsconfig bases)
- [x] **1.3** `packages/db`: Prisma init, schema v0 (Organization, User, Membership, Role enum, Session, Invitation, AuditLog, ApiKey), initial migration
- [x] **1.4** RLS policies SQL (applied after Prisma migrations) — every tenant-scoped table enforces `organization_id = current_setting('app.current_org_id')::uuid`
- [x] **1.5** `packages/shared`: Zod schemas mirroring Prisma models, shared enums, API response envelope types
- [x] **1.6** `apps/api` Fastify skeleton: pino logger, error handler, Zod validation via fastify-type-provider-zod, `@fastify/swagger` OpenAPI, `@fastify/rate-limit`, `@fastify/cookie`, `@fastify/helmet`, `/health` and `/metrics` routes
- [x] **1.7** Tenant-context plugin: extract `org_id` from JWT, run `SET LOCAL app.current_org_id` on a Prisma transaction per request
- [x] **1.8** Auth routes: signup, login, logout, refresh, forgot-password, reset-password, verify-email, invites (create + accept + revoke), session, switch-org
- [x] **1.9** RBAC guard factory: `requireRole('admin' | 'editor' | 'viewer')` + `requireAlignedAdmin`
- [x] **1.10** Resend email templates: verify, reset, invite (Mailhog fallback in dev)
- [x] **1.11** `apps/web` Next.js 15 App Router scaffold: Tailwind v4, shadcn-style UI primitives, IBM Plex Sans via `next/font`, brand tokens
- [x] **1.12** Auth pages: `/signup`, `/login`, `/forgot-password`, `/reset-password`, `/verify-email`, `/invite/[token]`
- [x] **1.13** App shell: responsive sidebar nav (desktop + mobile drawer), top bar with user menu + org switcher, page header
- [x] **1.14** Dashboard page (empty state with counts + getting-started checklist + system status)
- [x] **1.15** Members page: list members, invite modal, role change (live select), deactivate, list + revoke pending invitations
- [x] **1.16** `docker-compose.yml` for dev: postgres, redis, pgbouncer, mailhog (dev email capture)
- [x] **1.17** Seed script: creates one demo org + admin user for quick iteration

### Day 2 — Catalogs + Business Info + Image Uploads ✅ COMPLETE (2026-04-20)

**End-of-day demo:** User can create, edit, search, and delete products (with variants + images), services (with pricing tiers + availability), and business info (hours, FAQs, policies).

- [x] **2.1** Prisma schema extension: `Product`, `ProductVariant`, `ProductImage`, `Category` (self-referencing tree), `Service`, `ServicePricingTier`, `AvailabilityWindow`, `BusinessInfo`, `Location`, `ContactChannel`, `FAQ`, `Policy`, plus `Asset`. pg_trgm GIN indexes + auto-maintained `search_text` triggers (raw SQL). All tables have `organization_id` + RLS.
- [x] **2.2** Wasabi storage module (`apps/api/src/lib/storage.ts`): S3 client, presigned PUT URLs (browser → Wasabi direct), `Asset` table records metadata. Upload path is two-step (presign → PUT → finalize). Returns 503 if Wasabi keys missing so dev still boots.
- [x] **2.3** Product API: `GET /products` (search via name/SKU/search_text, filter by category/availability/price range, cursor pagination), `POST`, `GET /:id`, `PATCH`, soft-`DELETE`, `POST /:id/images`, `DELETE /:id/images/:imageId`, `POST /:id/images/reorder`, `PUT /:id/variants` (replace-set), bulk `POST /products/bulk-update`.
- [x] **2.4** Service API: full CRUD + `PUT /:id/pricing-tiers` (replace-set) + `PUT /:id/availability` (replace-set, weekly grid).
- [x] **2.5** Business Info API: upsert `business-info`, full CRUD on locations / contacts / FAQs (with reorder) / policies (upsert by kind).
- [x] **2.6** Category API: CRUD + reorder. Self-parent guard. Deleting clears products' categoryId via `onDelete: SetNull`.
- [x] **2.7** Product list page: search (debounced), category + availability filters, bulk select with mark-available/unavailable, primary image thumbnail, status badges, dropdown actions.
- [x] **2.8** Product edit page: details with debounced auto-save (800 ms), image uploader (presign → upload → finalize → attach), variant editor with dynamic option keys, status + danger zone cards.
- [x] **2.9** Service list + edit pages: details auto-save, pricing-tier builder (with features list), weekly availability grid (open + start/end per day).
- [x] **2.10** Business info editor: tabbed page — Profile + hours grid, Locations (list + dialog), Contact channels (inline form), FAQs (inline create + visibility toggle + delete), Policies (upsert by kind).
- [x] **2.11** Activity log entries written via `recordAudit()` calls from each route on create/update/delete (product, service, category, faq, policy, business_info, asset_uploaded). Prisma `$use` middleware was avoided in favour of explicit calls for clearer intent.

### Day 3 — CSV Import + API Connectors + Read API ✅ COMPLETE (2026-04-21)

**End-of-day demo:** User uploads a product CSV → watches progress → sees imported products. Chatbot (simulated with curl) queries the read API and gets cached <100ms responses. Outbound webhook fires on change.

- [x] **3.1** BullMQ setup. `apps/api/src/lib/queues.ts` exposes `import`, `sync`, `webhook-delivery`, `email` queues; `apps/worker/src/index.ts` boots three workers (import / sync / webhook-delivery). Email queue is plumbed but no email worker yet (sendEmail still calls Resend/Mailhog directly from auth.service for Day 1 flows).
- [x] **3.2** Import templates — XLSX generator at `GET /api/v1/imports/templates/:kind` with a help sheet listing every field + required/optional + description. Targets: product, service, faq, business_info.
- [x] **3.3** Multipart upload endpoint at `POST /api/v1/assets/upload-csv` — server-side stream to Wasabi, creates an Asset row, returns assetId. `POST /api/v1/imports` accepts the assetId, creates an ImportJob, enqueues BullMQ.
- [x] **3.4** Streaming import worker (`apps/worker/src/jobs/import.ts`) — csv-parse for CSV, ExcelJS streaming for XLSX. Per-row Zod validate + upsert via shared `upsertOne()`. Writes ImportJobRow on success/failure with raw data + error list. Updates job progress every 25 rows. Honors cancellation between batches.
- [x] **3.5** Column mapping — supported in the API (`columnMapping` body field) and stored on ImportJob; UI for now defaults to "header name === field name" (good enough for our generated templates). Custom mapping wizard step deferred to Day 4 polish.
- [x] **3.6** Import status: list page with live polling, detail page with progress bar + per-row results + cancel button + filter to failed-only.
- [x] **3.7** `ApiConnector` + `SyncRun` models with auth config (bearer/api_key/basic/hmac), cron schedule, and webhook secret for inbound push.
- [x] **3.8** Connector UI: list + create dialog with auth-kind selector that swaps the credential fields, test-connection button, copy-webhook-URL action.
- [x] **3.9** Scheduled sync — BullMQ repeatable jobs registered in `connector.routes.ts` on create/update; sync worker pulls JSON, applies mapping, validates with shared upsert, records SyncRun.
- [x] **3.10** Inbound webhook receiver at `POST /api/v1/webhooks/inbound/:connectorId` — HMAC-SHA256 over `<timestamp>.<body>` with the connector's `webhookSecret`. 5-minute timestamp skew window. Creates a SyncRun and enqueues a sync job.
- [x] **3.11** Sync run history rendered inline under each connector in the UI (last 50, polls every 5s).
- [x] **3.12** Chatbot Read API at `/api/v1/read/*` (`/products`, `/products/:id`, `/services`, `/services/:id`, `/business-info`, `/faqs`, `/policies`, `/search`). API-key authed via `X-Aligned-Api-Key`. Scopes enforced per endpoint.
- [x] **3.13** Redis cache (`lib/read-cache.ts`) — keys `read:{orgId}:{endpoint}:{queryHash}`, 60s fresh / 5min stale TTL. SCAN-based pattern delete (no KEYS).
- [x] **3.14** Cache invalidation hooked into `emitWebhookEvent()` so every product/service/business-info/faq/policy create/update/delete clears `read:{orgId}:*` for the org.
- [x] **3.15** Outbound webhook system: WebhookEndpoint + WebhookDelivery models, full CRUD, HMAC-SHA256 signing, BullMQ delivery worker with exponential backoff (8 attempts), permanent-fail short-circuit on 4xx, auto-disable endpoint after 25 consecutive failures, manual retry endpoint.
- [x] **3.16** Per-key rate limit on read API (Redis-backed via `@fastify/rate-limit` keyGenerator), per-IP on portal endpoints. Configurable via `RATE_LIMIT_*` env vars.
- [x] **3.17** Filtered `/docs/chatbot` Swagger UI registered alongside the main `/docs`. Tags now categorise routes (auth, catalog, business-info, imports, connectors, webhooks, api-keys, chatbot-read).

### Day 4 — Versioning + Admin Panel + Hardening + Deploy ✅ COMPLETE (2026-04-22)

**End-of-day demo:** Deployed to Aligned Cloud Servers at a staging subdomain, TLS live, p95 <200ms on seeded data under load, rollback button works, ALIGNED admin sees all tenants.

- [x] **4.1** Versioning: `CatalogRevision` (entity_type, entity_id, organization_id, snapshot JSONB, version_number) + `recordRevision()` helper called from product/service/business-info CRUD.
- [x] **4.2** `<VersionHistory>` component on the product detail page — timeline + click-to-preview JSON snapshot dialog + "Restore this version" button. Restore writes the snapshot back, records a fresh `restored` revision, emits a `catalog_changed` webhook so chatbots see it.
- [x] **4.3** ALIGNED admin panel at `/aligned-admin` (gated by `requireAlignedAdmin`): orgs list with search + suspend / reactivate / delete, queue depth (import/sync/webhook), Redis ops/s, per-org member/product/service counts.
- [x] **4.4** Notifications: `Notification` table (per-user or org-wide), `<NotificationsBell>` in the top bar with unread badge + dropdown + mark-all-read. Import worker emits notifications on succeeded/partial/failed.
- [x] **4.5** Sentry wired into api (`lib/sentry.ts`) and worker (`@sentry/node`). No-op when `SENTRY_DSN` is unset.
- [x] **4.6** Worker now exposes `/metrics` on port 9100 with default Node metrics + `worker_jobs_completed_total` / `worker_jobs_failed_total` / `worker_last_job_duration_seconds`.
- [x] **4.7** Integration tests in `apps/api/test/`: auth, tenant-isolation, products CRUD, read API, webhook signature.
- [x] **4.8** Tenant-isolation test asserts org A cannot read org B's products by ID and vice-versa — fails the build if RLS is broken.
- [x] **4.9** k6 load test at `infra/scripts/load-test.js` — 500 rps for 2 min across 5 read endpoints, thresholds `p95<200ms`, `p99<400ms`, `error rate<1%`.
- [x] **4.10** Multi-stage Dockerfiles for api / worker / web (node:20-alpine + tini). `docker-compose.prod.yml` with 2 replicas of api/worker/web behind Caddy.
- [x] **4.11** Caddyfile: HTTPS via Let's Encrypt, HSTS, gzip+zstd, health-check upstreams.
- [x] **4.12** GitHub Actions: `ci.yml` (lint + typecheck + test against ephemeral Postgres + Redis services) and `deploy.yml` (build + push to GHCR with commit SHA tag → SSH deploy → `prisma migrate deploy` → smoke test `/health`).
- [x] **4.13** `infra/scripts/backup.sh` — pg_dump → gzip → age-encrypt → upload to Wasabi → prune > 30 days. Cron example in the runbook.
- [x] **4.14** `docs/RUNBOOK.md`: topology, day-1 bootstrap, deploys, rollback, migrations, restore-from-backup, add-tenant, rotate secrets, common incidents, pilot onboarding checklist.
- [x] **4.15** `pnpm db:seed:pilot` creates three pilot orgs (`pilot-cafe`, `pilot-clinic`, `pilot-store`) each with an admin user, sample product/service/FAQ, and an API key (printed once).

---

## 5. Current Status

> **Update this section at the end of every Claude session.** Use ISO dates. Be specific about what works and what doesn't.

- **2026-04-21 QA harness session:** Built `apps/e2e/` Playwright harness (13 specs), 7 `.claude/agents/` QA subagent definitions, root `pnpm qa` / `pnpm qa:gate` scripts, and `.github/workflows/e2e.yml`. First live run surfaced a **critical RLS bypass** (Prisma connected as Postgres superuser, which silently skipped every tenant policy; now `withTenant` switches to the `aligned_app` role). Also fixed: scheduled-sync `__pending__` sentinel never writing SyncRun rows; `connectors.endpoint_url` NOT NULL blocking webhook-only connectors (migration `20260421160000_connector_endpoint_url_nullable`); auth rate limit now env-driven + bypasses for `x-e2e-run: 1` header in dev; read-API exposes `x-cache: HIT|STALE|MISS`; `RATE_LIMIT_READ_API_PER_SECOND` now actually wired in. Tenant-isolation **hard deploy gate** is 6/6 green. Full QA notes: [apps/e2e/QA-REPORT.md](apps/e2e/QA-REPORT.md).
- **Last session:** 2026-04-22 — **Phase 1 COMPLETE** (Day 4 all 15 tasks). Versioning, notifications, ALIGNED admin panel, Sentry, prometheus, integration tests, k6 load test, Dockerfiles, prod compose, Caddy, GitHub Actions CI + deploy, backup script, runbook, pilot seed.
- **Current day of plan:** Day 4 ✅ — **Phase 1 done. Ready to deploy.**
- **Next concrete action (deployment session):**
  1. `pnpm install` — picks up `@sentry/node` in api+worker, `prom-client` in worker, plus testing libs.
  2. `pnpm db:migrate` — adds 2 new tables (`catalog_revisions`, `notifications`) + Day 4 enums. Migration name: `day_4_versioning_notifications`. RLS auto-applies.
  3. Run integration tests locally to confirm green: `pnpm --filter @aligned/api test`. **The `tenant-isolation.test.ts` is the hard deploy gate** — do not ship if it fails.
  4. Pre-deploy on the Aligned Cloud Server: copy `.env.production.example` → `.env.production`, fill all secrets, `chmod 600 .env.production`. Configure DNS for `app.aligned.com` and `api.aligned.com` to point at the server. Set GitHub secrets `DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_SSH_KEY`, `GHCR_PAT`, `API_DOMAIN`.
  5. Push to `main` — `deploy.yml` builds, pushes to GHCR, SSHes, runs migrations, smokes `/health`.
  6. After deploy: `pnpm --filter @aligned/db exec tsx ./seed/pilot.ts` on the server to create the three pilot tenants. Capture and securely store the printed API keys.
  7. Run the load test from a machine outside the server: `API_KEY=… BASE_URL=https://api.aligned.com k6 run infra/scripts/load-test.js` — must show `p95<200ms`.
  8. Set up the daily backup cron per `docs/RUNBOOK.md` (5 3 * * *).
- **Blockers (these are the only things stopping deployment):**
  - Wasabi access keys (image uploads + CSV imports rely on this)
  - Aligned Cloud Server SSH user + host + domain (`app.aligned.com`, `api.aligned.com` recommended)
  - Resend API key for production email sending (dev works via Mailhog)
  - GitHub secrets configured: `DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_SSH_KEY`, `GHCR_PAT`, `API_DOMAIN`
  - **(Phase 2 only — not blocking Phase 1)** Meta WhatsApp Business API credentials.
- **What works (code-complete; not yet run end-to-end):**
  - **NEW (Day 4):** Versioning — every product/service/business-info create/update/delete writes a `CatalogRevision` with the full snapshot. UI: timeline + JSON preview + restore button on the product page. Restore writes the snapshot back, records a `restored` revision, and emits a `catalog_changed` webhook.
  - **NEW (Day 4):** Notifications — `Notification` table + bell icon dropdown in the top bar with unread badge + mark-all-read. Import worker emits succeeded/partial/failed notifications.
  - **NEW (Day 4):** ALIGNED admin panel at `/aligned-admin` — orgs list (search, suspend, reactivate, delete), system health (queue depth, Redis ops/s, user counts, org status counts).
  - **NEW (Day 4):** Sentry on api + worker (no-op when DSN unset). Worker exposes `/metrics` on :9100.
  - **NEW (Day 4):** Integration tests (Vitest + Fastify inject): auth, **tenant isolation (HARD GATE)**, products CRUD, read API, webhook signature.
  - **NEW (Day 4):** k6 load test asserting `p95<200ms` at 500 rps on the chatbot read API.
  - **NEW (Day 4):** Multi-stage Dockerfiles for api/worker/web. `docker-compose.prod.yml` with 2 replicas behind Caddy auto-TLS.
  - **NEW (Day 4):** GitHub Actions: `ci.yml` (lint+typecheck+test against ephemeral PG+Redis) and `deploy.yml` (build + push GHCR → SSH → migrate → smoke test).
  - **NEW (Day 4):** Daily Postgres backup script (`infra/scripts/backup.sh`) → encrypted (age) → Wasabi → 30-day retention.
  - **NEW (Day 4):** `docs/RUNBOOK.md` covers deploy, rollback, restore, add-tenant, rotate-secrets, and incident playbooks.
  - **NEW (Day 4):** `pnpm db:seed:pilot` creates three pilot orgs with sample data + API keys.
  - **NEW (Day 3):** Streaming CSV/XLSX import end-to-end — multipart upload → Wasabi → BullMQ worker → row-by-row Zod validation → tenant-scoped upsert → per-row result rows → live progress in the UI. Imports support products, services, FAQs, business info; categorySlug auto-creates categories.
  - **NEW (Day 3):** API connectors (REST pull + inbound webhook push) with auth-kind selector (none/bearer/api-key/basic/hmac), cron-scheduled syncs via BullMQ repeatables, manual "run now", and an HMAC-verified inbound receiver at `POST /api/v1/webhooks/inbound/:connectorId`.
  - **NEW (Day 3):** Chatbot read API at `/api/v1/read/{products,services,business-info,faqs,policies,search}` — API-key authed (X-Aligned-Api-Key), per-key rate-limited, Redis-cached (60s fresh / 5min stale), invalidated on every catalog write.
  - **NEW (Day 3):** Outbound webhook system — endpoints with subscribed event kinds, HMAC-SHA256 signing (`X-Aligned-Signature: sha256=…`), exponential backoff (8 attempts), permanent-fail short-circuit on 4xx, auto-disable after 25 consecutive failures, manual retry button.
  - **NEW (Day 3):** API key issuance (`/api-keys` page) — secret displayed once, hashed at rest (sha256), scope-checked per endpoint, lastUsedAt tracking + first-use audit.
  - **NEW (Day 3):** UI pages: `/imports`, `/imports/[id]`, `/connectors`, `/api-keys`, `/webhooks`. Sidebar updated to surface them.
  - **NEW (Day 3):** Filtered chatbot Swagger UI at `/docs/chatbot`.
  - **NEW (Day 2):** Full catalog data model — products (variants, images, categories), services (pricing tiers, weekly availability), business info (hours, locations, contacts, FAQs, policies), assets (Wasabi-backed). All tables tenant-isolated via RLS + pg_trgm full-text search indexes + auto-maintained `search_text` triggers.
  - **NEW (Day 2):** All CRUD APIs at `/api/v1/{products,services,categories,business-info,assets}` with cursor pagination, search, filters, bulk update, replace-set semantics for variants/tiers/availability windows.
  - **NEW (Day 2):** Two-step Wasabi upload (presign → browser PUT → finalize). Returns signed GET URLs when bucket is private.
  - **NEW (Day 2):** Product list page (search/filter/bulk-select), product edit page (auto-save details + image gallery + variant matrix), service list + edit (pricing tiers + weekly availability grid), business info editor (5 tabs: profile/hours, locations, contacts, FAQs, policies).
  - Multi-tenant data model with Postgres RLS policies (organizations, users, memberships, sessions, invitations, api_keys, audit_logs)
  - Fastify API at `/api/v1/*` with: health, metrics (Prometheus), OpenAPI docs at `/docs`, helmet, CORS, rate-limit (Redis-backed), cookie support, Zod validation
  - Auth: signup, login, refresh (rotating), logout, verify-email, forgot/reset password, invitations (create + accept + revoke), switch-org, session context
  - RBAC: `requireAuth`, `requireRole('admin'|'editor'|'viewer')`, `requireAlignedAdmin`
  - Tenant context: `withTenant(orgId, fn)` wraps every authenticated query in a Postgres transaction with `SET LOCAL app.current_org_id`; RLS enforces isolation
  - Email templates: verify, reset, invite (Mailhog in dev, Resend in prod)
  - Audit log on every meaningful state change
  - Account lockout after 5 failed login attempts (15 min)
  - Sessions revoked on password change
  - Next.js 15 portal: brand-themed (Mediterranean Blue + IBM Plex Sans), responsive shell with sidebar (desktop) + drawer (mobile)
  - Pages: `/login`, `/signup`, `/forgot-password`, `/reset-password`, `/verify-email`, `/invite/[token]`, `/dashboard`, `/members`, `/settings` + stub pages for `/products`, `/services`, `/business-info`
  - Members page: live role changes, deactivate (with last-admin protection), invite modal, pending invitations list with revoke
  - Org switcher + user menu in top bar
  - Dev stack: docker-compose with postgres, pgbouncer, redis, mailhog
  - Seed script: demo org `demo` + admin `admin@aligned.local` / `Aligned123!`
- **What is NOT yet verified at runtime (user to do):**
  1. `pnpm install` — picks up `@fastify/multipart`, `bullmq`, `csv-parse`, `exceljs`, `undici` in api+worker
  2. `pnpm db:migrate` — Day 3 adds 6 new tables; pick name `day_3_imports_connectors_webhooks`
  3. `pnpm dev` — worker boots all three workers (import, sync, webhook-delivery); api on :4000
  4. Issue an API key in the portal → curl `/api/v1/read/products` with `X-Aligned-Api-Key`
  5. Upload a CSV via the import wizard → watch progress on `/imports/:id`
  6. Add a webhook endpoint pointing at webhook.site → edit a product → see signed delivery
  7. Add a connector with cron `*/5 * * * *` and an endpoint that returns JSON → see scheduled SyncRun appear
- **Known tech debt / deferred to later days:**
  - Member endpoints don't yet support cursor-based pagination (returns full list). Fine for Day 1, will add when org sizes warrant.
  - Audit log has no UI yet (Day 4 admin panel surfaces it).
  - `change-password` endpoint not built yet (only forgot/reset). Add on Day 4 when settings/profile is wired.
  - No CSRF token on top of httpOnly cookies. SameSite=Lax + Bearer-token Authorization header on all state-changing routes mitigates; revisit on Day 4.
  - No 2FA. Out of scope for Phase 1.
  - The `ApiKey` model exists but issuance UI + read-API key auth lands on Day 3.
  - **(Day 2)** Description fields use plain `<textarea>` for now; Tiptap rich-text editor was deferred to keep Day 2 in scope. Markdown-style content is fine for chatbot consumption. Upgrade after Day 4 if needed.
  - **(Day 2)** No category management UI yet — use the API directly or wait for a small page on Day 4.
  - **(Day 2)** Product image reorder uses click "Make primary" only; full drag-reorder UI deferred.
  - **(Day 2)** Variant editor saves only on the explicit "Save variants" button (not auto-saved) because partial variant edits are easy to mistake.
  - **(Day 2)** Pricing-tier edits to existing tiers reuse temporary IDs; on save, the API replaces by the `tiers` array (set semantics) — works but a future cleanup could keep stable IDs across the round-trip.
  - **(Day 3)** Column mapping UI step in the import wizard was deferred — for now the CSV headers must match the template field names. Mapping is supported in the API (`columnMapping` on POST /imports), so a quick wizard step can be added later without backend changes.
  - **(Day 3)** Sync worker's BullMQ-repeatable scheduling uses a placeholder `syncRunId` in the queue payload; the worker creates the actual `SyncRun` row at job time. Slightly hacky — consider switching to QueueScheduler-driven SyncRun pre-creation in Day 4.
  - **(Day 3)** API keys are hashed with sha256 (not bcrypt) for fast lookup. Trade-off: full secret leak from DB → grant access. Keys are random 24 bytes (192 bits), so brute-forcing the hash is infeasible. Acceptable for v1; revisit if any compliance pushback.
  - **(Day 3)** Email queue is created but the email worker isn't wired up; the auth service still calls Resend/Mailhog directly. Not blocking; Day 4 can move email sending to the worker if needed.
  - **(Day 3)** Read cache uses `JSON.stringify` for storage. Fine at <1 MB payloads; if a bot org gets 10K-product responses we should consider compression or pagination keys.

---

## 6. Resume Checklist (read this first each new session)

1. Run `git status` in `/Users/tayseerlaz/Projects/Alignbot` — see what's tracked.
2. Read `## 5. Current Status` above — pick up from "Next concrete action."
3. Check off completed tasks in `## 4. The 4-Day Plan` by changing `[ ]` → `[x]`.
4. If a day ran long, carry incomplete tasks forward — don't silently drop scope.
5. After the session, update `## 5. Current Status` with:
   - Date
   - What was completed (task IDs)
   - What's next
   - Any new blockers or decisions made
6. If the user made a new design decision mid-session, add it to `## 2. Locked Decisions` so future-you doesn't re-open it.
7. Never re-design what's already locked — if something is wrong, flag it to the user, don't silently change course.

---

## 7. Operating Principles

- **Ship vertical slices.** Within a day, prefer finishing one feature end-to-end (API + UI + test) over starting three.
- **Tenant isolation is non-negotiable.** Every new tenant-scoped table gets RLS on the same migration it's created in. Never merge a model without `organization_id`.
- **Zod schemas in `packages/shared` are the single source of truth** for request/response shapes. API validates with them; web imports them for forms.
- **No mocks in integration tests** — use a test Postgres + Redis via Docker. Mocks hide tenant-leakage bugs.
- **Prefer Prisma migrations over `db push`** even in dev, so migration history matches prod from day one.
- **Don't skip the load test on Day 4.** The spec commits to <200ms p95; that's a hard success criterion.
- **Keep `.env.example` in sync** — if you add a new env var in code, add it to `.env.example` in the same commit.
