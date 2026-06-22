# ALIGNED / Hader Platform — Complete Technical & Security Report

> **Audience:** Someone with **zero** prior knowledge of this system. By the end you should understand what the product is, how it is built, how every screen and button behaves (and which are real vs. cosmetic), how the data is protected, where money and messages flow, and what is fragile or risky.
>
> **Date:** 2026-06-22 · **Method:** Full read-through of the codebase by a panel of specialist auditors (architecture, data/RLS, auth/security, backend, frontend, adversarial security). Findings are cross-verified against the source; file paths and line numbers are cited so any claim can be checked.
>
> **Scale of the system:** 3 runnable apps + 3 shared packages · 34 backend API modules · 51 web pages · 73 database models · 56 migrations · ~77,000 lines of code (api 38k / web 33k / worker 6k).

---

## Table of Contents

1. [What this product is](#1-what-this-product-is)
2. [Big-picture architecture](#2-big-picture-architecture)
3. [Infrastructure, DevOps & how it ships](#3-infrastructure-devops--how-it-ships)
4. [The database: data model, multi-tenancy & Row-Level Security](#4-the-database-data-model-multi-tenancy--row-level-security)
5. [Authentication, authorization & sessions](#5-authentication-authorization--sessions)
6. [Backend API reference — catalog, commerce & integrations](#6-backend-api-reference--catalog-commerce--integrations)
7. [Backend API reference — messaging channels, AI & growth](#7-backend-api-reference--messaging-channels-ai--growth)
8. [The AI bot engine, in depth](#8-the-ai-bot-engine-in-depth)
9. [Background workers & scheduled jobs](#9-background-workers--scheduled-jobs)
10. [The web app — every page, real vs UI-only](#10-the-web-app--every-page-real-vs-ui-only)
11. [Security audit](#11-security-audit)
12. [Consolidated risk & tech-debt register](#12-consolidated-risk--tech-debt-register)
13. [Glossary](#13-glossary)

---

## 1. What this product is

**ALIGNED / Hader** is a **multi-tenant SaaS**. "Multi-tenant" means many separate customer businesses ("tenants" / "organizations") share one running system and one database, but each can only ever see its own data.

Each tenant uses the platform to:
- **Manage a catalog** — products (with variants, images), services (with pricing tiers and weekly availability), business info (hours, locations, contacts, FAQs, policies).
- **Run AI chatbots** on **WhatsApp, Facebook Messenger, Instagram DMs, and phone (voice)**. The bot answers customers using *only* that tenant's catalog data, can take **orders** (a cart → an order with a payment link) and **bookings** (appointments), and can **hand off** to a human.
- **Operate a shared inbox** where human agents read and reply to every conversation across all channels, pause/resume the AI per conversation, tag, assign, and add internal notes.
- **Do outbound marketing** — WhatsApp **broadcasts** (bulk campaigns with A/B testing, scheduling, per-recipient delivery tracking), **drip sequences**, **contacts/CRM**, and **segments**.
- **Integrate** — CSV/XLSX **imports**, REST **connectors** (pull or webhook push), an **outbound webhook** system, and a cached **read API** that the chatbots query.

Above the tenants sits **ALIGNED HQ** (also called "Hader admin") — a super-admin role that can see and operate across all tenants: suspend/reactivate orgs, change their AI plan, control which features each tenant can use, impersonate ("Control") a tenant to fix their data, view cross-tenant audit logs, AI-reply provenance, revenue, and system health.

There is a **billing** layer (Stripe subscriptions + plan caps), a **white-label/branding** layer (custom domains via auto-TLS), and an **AI provenance** system that records, for every single bot reply, exactly what data and prompt produced it — and flags possible hallucinations.

---

## 2. Big-picture architecture

```
                          Internet (customers + operators)
                                       │
                            ┌──────────┴───────────┐
                            │   Caddy (reverse      │  auto-HTTPS (Let's Encrypt),
                            │   proxy, TLS, gzip)    │  on-demand certs for custom domains
                            └─────┬───────────┬──────┘
                                  │           │
                  hader.ai/app  ──┘           └──  api.hader.ai
                        │                           │
                ┌───────▼───────┐           ┌───────▼────────┐        ┌──────────────────┐
                │  web (Next.js │  REST/SSE │  api (Fastify   │  jobs  │ worker (BullMQ)   │
                │  15, port     │──────────▶│  TS, port 4000) │───────▶│ + tick loops      │
                │  3000)        │           │                 │        │ (metrics :9100)   │
                └───────────────┘           └───┬────────┬────┘        └────────┬──────────┘
                                                │        │                      │
                                       ┌────────▼──┐  ┌──▼──────────┐   ┌───────▼────────┐
                                       │ PgBouncer │  │   Redis 7    │   │  Wasabi (S3)    │
                                       │  ↓        │  │ cache, queue,│   │  files/images   │
                                       │ Postgres  │  │ rate-limit,  │   │  CSV, exports   │
                                       │   16      │  │ locks        │   └────────────────┘
                                       └───────────┘  └─────────────┘
        External: Meta Cloud API (WhatsApp), Meta Graph (Messenger/IG), Stripe, MyFatoorah/PayPal,
                  Groq + OpenAI + Anthropic (LLMs), ElevenLabs/Google (TTS), AWS SES (email),
                  Aseer-time voicebot box (separate server, talks to /api/v1/voice/*)
```

**Three runnable apps:**

| App | What it is | Runtime in production | Port |
|---|---|---|---|
| **api** (`apps/api`) | The Fastify REST API — all business logic, auth, webhooks | Runs **directly from TypeScript source via `tsx`** (no compile step) under systemd | 4000 |
| **web** (`apps/web`) | The Next.js 15 portal that staff log into | `next start` (compiled) under systemd; served at `hader.ai/app` | 3000 |
| **worker** (`apps/worker`) | Background job runner (imports, broadcasts, crawls, reminders, etc.) | `tsx` under systemd; exposes metrics | 9100 (metrics) |

**Three shared packages:**

| Package | Contents | Consumed how |
|---|---|---|
| **`@aligned/db`** | Prisma schema, migrations, generated DB client, RLS SQL, seeds, secret-encryption | as **compiled `dist/`** (gitignored) |
| **`@aligned/shared`** | Zod validation schemas, shared types/enums, the feature-flag registry | as **compiled `dist/`** (gitignored) |
| **`@aligned/config`** | ESLint + TypeScript base configs | source |

> ⚠️ **The single most important architectural gotcha:** `api`/`worker` run via `tsx` (no build), but they `import` `@aligned/db` and `@aligned/shared` as **compiled `dist/` folders that are gitignored**. A plain `git pull` does **not** rebuild those, so deploying without rebuilding them ships *stale Zod schemas / stale Prisma client* — the "fix" appears deployed but doesn't take effect. This caused a documented overnight outage and is why the deploy script *always* rebuilds them (see §3).

---

## 3. Infrastructure, DevOps & how it ships

### 3.1 Monorepo tooling
- **pnpm workspaces + Turborepo.** Root scripts proxy to `turbo run …`. `pnpm@9.12.0`, Node ≥20.11.
- **`turbo.json`** caches `build` outputs (`dist/**`, `.next/**`); `.env` is a global dependency so env changes bust the cache.
- **TypeScript** is strict, with `noUncheckedIndexedAccess: true` (array/record access yields `T | undefined`).

### 3.2 The runtime processes
- **API boot** (`apps/api/src/server.ts`): inits Sentry, tunes the outbound HTTP agent (keep-alive, 64 connections — saves 50–150 ms per LLM/Meta call), builds Fastify with aggressive **pino log redaction**, a **5 MB body limit**, **raw-body capture** (so webhook HMACs hash the original bytes), then loads plugins in a security-significant order: helmet (full CSP + HSTS) → CORS → cookie → multipart → rate-limit → under-pressure (load shedding) → swagger. Then ~45 route modules under `/api/v1`. Graceful shutdown on SIGINT/SIGTERM.
- **Worker boot** (`apps/worker/src/index.ts`): reconciles orphaned crawl jobs, starts Sentry, serves Prometheus metrics + `/health` on **:9100**, then starts **8 BullMQ queue workers** and **7 self-rescheduling tick loops** (each guarded by a Redis lock). One process runs all of it — a single point of failure (see §12).
- **Web**: Next.js App Router, React 19, Tailwind v4, basePath `/app`. `typescript.ignoreBuildErrors` and `eslint.ignoreDuringBuilds` are **on** (a security/quality concern — see §11 F-07).

### 3.3 Reverse proxy & DB pooling
- **Caddy** (`infra/caddy/Caddyfile`): auto-HTTPS, TLS 1.2/1.3, zstd/gzip, HSTS + COOP/CORP + Permissions-Policy headers, health-checked upstreams. Forces correct MIME types on Next static assets (defends a known stale-replica bug). **On-demand TLS** for tenant custom domains, gated by the API's `/caddy/ask` (only mints a cert if the tenant's CNAME is verified). Web is load-balanced with `ip_hash` (pins a client to one replica).
- **PgBouncer** (`infra/pgbouncer/pgbouncer.ini`): **transaction pooling** (`pool_mode=transaction`). This is *why* tenant context uses `SET LOCAL` (transaction-scoped) rather than session settings — pooled connections are recycled between transactions.

### 3.4 Docker (defined but **not the live deploy path**)
Full multi-stage Dockerfiles (`node:20-alpine` + `tini`, system `ffmpeg` for voice-note transcoding) and a `docker-compose.prod.yml` exist (api ×2, worker ×2, web ×1, Caddy, Postgres, PgBouncer, Redis). **But production does not run Docker** — it runs the apps natively via `tsx`/`next start` under systemd. The Dockerfiles compile to `dist/` and run `node dist/…`, which contradicts the native model — effectively dead code relative to the live deploy.

### 3.5 CI/CD and the (broken) deploy reality
| Workflow | Trigger | What it does |
|---|---|---|
| `ci.yml` | PR + push | Ephemeral PG+Redis; lint/typecheck/test are **`continue-on-error` (informational)**; then **HARD GATES that block merge**: tenant-isolation, provenance-access, webhook-signature, read-api tests |
| `deploy.yml` | push to main | SSH-based "native deploy" — **but auto-deploy is broken at the account level** |
| `e2e.yml`, `zap-baseline.yml` (weekly OWASP scan), `load-test.yml`, `embedding-backfill.yml`, `logs.yml` | various | QA / security scan / perf / maintenance |

**Real deploy procedure:** manual SSH to the server, then `bash infra/scripts/redeploy.sh`. That script encodes hard-won fixes:
1. Ensures a **4 GB swapfile** (the Next build OOM'd and crashed the whole box twice).
2. Diffs against the last *successfully* deployed SHA (so aborted runs don't skip the web rebuild).
3. Installs with `--prod=false` (sourcing `.env.production` sets `NODE_ENV=production`, which would otherwise prune the `tsc`/`prisma` devDeps the build needs); removes only `.bin` dirs (running services hold `node_modules` open).
4. `prisma generate` (3 retries for transient OOM flakes).
5. **Always clean-rebuilds `@aligned/db` + `@aligned/shared` dist** (the stale-dist fix).
6. `prisma migrate deploy`.
7. Rebuilds web only if web changed, with a 2 GB heap cap.
8. Restarts `aligned-api`, `aligned-worker` (+ `aligned-web` if rebuilt); polls `/health` for ~60 s (tsx cold-start is 10–20 s).

> ⚠️ **Fresh-DB migration is broken:** migrations from `20260427180000_data_exports` onward call RLS helper functions (`_aligned_apply_tenant_rls`, `rls_bypassed`) that only exist after `rls.sql` runs — which runs *after* migrations. Existing servers are fine (helpers already present); a brand-new database (disaster recovery) needs a manual bootstrap of those helpers first. **Proper fix:** move the helper definitions into an early migration.

### 3.6 Configuration & secrets
Env is Zod-validated at boot in both api and worker (process exits on invalid config). **Required to boot:** `DATABASE_URL`, `REDIS_URL`, `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`. Optional-but-feature-gating: Wasabi keys (uploads 503 without them), `GROQ_API_KEY` (bot replies fail without it), OpenAI/Anthropic (AI tiers), ElevenLabs/Google (voice), Stripe/MyFatoorah (payments 503 without them), `SENTRY_DSN`, and **`SECRET_ENCRYPTION_KEY`** (encrypts WhatsApp tokens at rest — **lose it in prod and the bot goes dark**). WhatsApp/Meta credentials are **not** env vars — they're stored per-tenant in the database.

### 3.7 Observability
- **Sentry** on api + worker (no-op when DSN unset); RLS violations get tagged `rls-violation`.
- **Prometheus** `/metrics`: api exposes HTTP request counters + latency histograms; worker exposes job completed/failed counters + last-job-duration on :9100.
- **Health**: `/health` (liveness), `/health/ready` (pings Postgres + Redis, 503 if degraded). A worker tick self-pings the API every 60 s and stores uptime in Redis.
- **Logging**: pino, JSON in prod, secret-redacted (with gaps — see §11 F-08).
- **Backups**: `infra/scripts/backup.sh` → `pg_dump` → gzip → **age-encrypt** → Wasabi → prune >30 days, cron `5 3 * * *`.

---

## 4. The database: data model, multi-tenancy & Row-Level Security

### 4.1 How isolation works (three layers)
Every tenant-scoped table has an `organization_id` column. Isolation is enforced at three layers, so a bug in one is caught by the next:

1. **Application** — every authenticated request runs its DB work inside `app.tenant(req, fn)` → `withTenant(orgId, fn)`, which opens a Postgres transaction and runs:
   ```sql
   SET LOCAL ROLE aligned_app;                          -- drop superuser privileges
   SELECT set_config('app.current_org_id', $orgId, true); -- transaction-local tenant id
   ```
2. **Postgres role** — Prisma connects as a superuser, and **superusers bypass RLS**. The `SET LOCAL ROLE aligned_app` switch to a non-superuser role is what makes the policies actually apply. (A missing role-switch was a real total-isolation-failure bug, since fixed.)
3. **RLS policies** — every tenant table has `ENABLE` + **`FORCE ROW LEVEL SECURITY`** (FORCE means even the table owner is filtered) and a policy:
   ```sql
   USING      (rls_bypassed() OR organization_id = current_org_id())
   WITH CHECK (rls_bypassed() OR organization_id = current_org_id())
   ```
   `rls_bypassed()` reads a transaction-local flag set only by `withRlsBypass()` (used by the auth bootstrap, super-admin cross-tenant ops, and global tables).

**Bypass primitive:** `withRlsBypass(fn)` turns filtering *off* for genuinely cross-tenant work. It is the highest-trust primitive in the codebase — every call site must be gated by `requireAlignedAdmin`, the auth path, or carry an explicit `organizationId` filter. (Audited: all `/aligned-admin/*` bypass calls are gated; bot-runtime bypass calls carry explicit org filters — see §11 F-02.)

### 4.2 The 73 models, by domain

**Identity / Org / Auth:** `Organization` (the tenant root; `slug`, `status`, `aiPlan`, `disabledFeatures[]`), `User` (global identity, multi-org, `isAlignedAdmin`, TOTP fields), `Membership` (user↔org + `role` + `skills[]`), `Session` (refresh-token sessions, rotation + impersonation flag), `Invitation`, `ApiKey` (sha256-hashed, scoped), `AuditLog` (append-only, **tamper-evident hash chain** via a BEFORE-INSERT trigger).

**Catalog:** `Product` (+`ProductVariant`, `ProductImage`; `searchText` trigram index; `embedding Float[]` for semantic search; soft-delete), `Service` (+`ServicePricingTier`, `AvailabilityWindow`), `Category` (self-referencing tree), `BusinessInfo` (one row/org; hours, booking form, shop form as JSON), `Location`, `ContactChannel`, `FAQ`, `Policy`, `Asset` (Wasabi file metadata).

**Commerce:** `Cart` + `CartItem` (orders; money in integer minor units), `Booking` (appointments; frozen field snapshot + reminder template), `PaymentConfig` (per-tenant provider; credentials AES-256-GCM encrypted).

**Messaging / Inbox:** `WhatsAppChannel` (multi-number Meta config), `MessengerChannel` (FB + IG), `WhatsAppThread` (one per (org, customer); `customerPhone` holds the PSID/IGSID for non-WhatsApp channels), `WhatsAppMessage` (`channel` column multiplexes WA/Messenger/IG), `WhatsAppThreadTag`, `WhatsAppNote`, `CannedResponse`, `WhatsAppTemplate`.

**Bot / AI / Knowledge:** `BotConfig` (persona, reply mode, TTS, `deployedAt` gate), `KnowledgeBaseEntry`, `CrawlJob` + `CrawlPage` (website analysis), `BotTestScenario` + `BotTestRun` + `BotSimulationTurn` + `BotConversationFlowOption` (the test/simulator suite).

**Broadcasts / CRM / Growth:** `Contact` (+`ContactTag`; opt-in/out, block, `channel`), `ContactMemory` (ultra-plan per-customer persona), `Segment` (filter-AST audience), `Broadcast` + `BroadcastRecipient` + `BroadcastEvent`, `Sequence` + `SequenceStep` + `SequenceEnrollment`.

**Integrations:** `ImportJob` + `ImportJobRow`, `ApiConnector` + `SyncRun`, `WebhookEndpoint` + `WebhookDelivery`.

**Billing / Usage:** `Plan` (**global**, no org), `Subscription`, `UsageEvent` + `UsageMonthly`, `BrandingConfig` (white-label + CNAME), `DataExport`, `MetaOnboardingStep`.

**Provenance / Audit:** `SystemPromptSnapshot` (content-addressed prompt dedupe), `MessageProvenance` (per-reply inputs + citations + hallucinations), `ProvenanceSuppression`, `ProvenanceFlagDecision`.

**Voice:** `VoiceCall` + `VoiceCallTurn` (transcripts), `PhoneIntegration` (DID → tenant; phone number globally unique).

**Misc / global:** `CatalogRevision` (versioning snapshots), `Notification`, `Lead` (**global**, marketing-site capture; accessed only via bypass).

**Conventions:** UUID PKs, money as integer minor units, `citext` for case-insensitive unique slugs/SKUs/emails, soft-delete via `deletedAt`, `pg_trgm` GIN indexes + auto-maintained `search_text` triggers for fuzzy search.

> Two tables (`Plan`, `Lead`) are intentionally global (no RLS). One historical leak (`ContactMemory` shipped without RLS) was caught by an automated **RLS-drift gate** and fixed; that gate now blocks deploys.

---

## 5. Authentication, authorization & sessions

### 5.1 The identity model
A **User** is a global identity (one email). A **Membership** ties a user to an organization with a per-org **role** (`viewer` < `editor` < `admin`). A user can belong to many orgs. A separate **`isAlignedAdmin`** flag (a DB column, surfaced as the signed JWT `aa` claim) makes someone an ALIGNED super-admin.

### 5.2 Tokens
- **Access token** (JWT, **15-min** TTL): claims `sub` (user), `org` (active org), `role`, `aa`, `sid` (session). Sent as `Authorization: Bearer`. Held **in memory only** in the browser (never localStorage).
- **Refresh token** (opaque, **7-day** TTL): stored as an **httpOnly, SameSite=Lax cookie** scoped to `/api/v1/auth`. Only its SHA-256 hash is stored server-side.
- HS256 with an **explicit algorithm allowlist** (defeats `alg:none`/RS256 confusion). Separate secrets + audiences for access vs refresh so one can't be replayed as the other.

### 5.3 Endpoints (`/api/v1/auth/*`)
| Endpoint | Auth | What it does |
|---|---|---|
| `POST /signup` | none | Creates user + org + admin membership; sends verify email; **no session until verified** |
| `POST /login` | none | Full gate chain (below); issues tokens |
| `POST /refresh` | refresh cookie | Rotates refresh token, re-mints access token, **re-reads role from DB** |
| `POST /logout` | Bearer | Revokes current session |
| `POST /verify-email` | token | Activates account |
| `POST /forgot-password` | none | Always returns OK (no enumeration); timing-padded; emails reset link |
| `POST /reset-password` | token | Sets password, **revokes ALL sessions** |
| `POST /change-password` | Bearer | Needs current password; revokes all *other* sessions |
| `POST /switch-org` | Bearer | Re-issues a session bound to another org you're a member of |
| `GET /session` | Bearer | Returns user + active org + available orgs |
| `POST /sse-nonce` | Bearer | Mints a 30-s single-use Redis nonce for EventSource auth |
| invites: `create`/`accept`/`revoke` | mixed | Hashed 7-day invite tokens; accepting still requires email verification |

**Login gate order** (each step a distinct error code): user lookup → lockout check → disabled check → bcrypt password verify (5 failures → 15-min lock) → email-verified check → **TOTP** (if enabled) → active-membership check → success bookkeeping (reset counters, invalidate any pending reset token, issue session).

### 5.4 Refresh rotation & reuse detection
On refresh, the presented token is checked against the *already-rotated* slot. A match means replay:
- **Within a 10-minute grace window** → treated as a legitimate concurrent refresh (a slept/backgrounded tab); re-mints an access token without rotating again. (The window was widened from 10 s → 60 s → 10 min because real tab/device wake-ups were logging users out.)
- **Outside the window** → treated as theft: the **entire session family is revoked** and an audit event written.

### 5.5 Authorization (RBAC)
Three Fastify guards: `requireAuth`, `requireRole(min)` (compares the `viewer:1 < editor:2 < admin:3` rank from the JWT), and `requireAlignedAdmin`. The convention across all modules: **reads require `viewer`, writes require `editor`, destructive/config actions require `admin`.** This is genuinely enforced server-side — a viewer literally gets `403` on a write, regardless of what the UI shows.

> **Role changes are real, not cosmetic.** Because the role rides in the 15-min access token and the refresh flow re-reads it from the DB, a change propagates within ≤15 min automatically. A recent fix makes a **downgrade** take effect immediately by revoking the demoted member's sessions (forcing re-auth into the lower role). Deactivate/remove similarly revoke sessions; full account removal tombstones the email so it can be reused.

### 5.6 Other security primitives
- **2FA (TOTP)** implemented from scratch (RFC 6238, SHA-1, 30-s step, ±1 skew, `timingSafeEqual`), with 10 single-use recovery codes (SHA-256 hashed). Enrolment is a deliberate **stage-then-confirm** flow (pending secret in Redis) so a dropped response can't lock you out.
- **Passwords**: bcrypt at 12 rounds.
- **Secret encryption at rest**: AES-256-GCM envelope (`enc:v1:iv:tag:ciphertext`), applied via a Prisma extension. Safe-by-default: when the key is unset it passes through as plaintext.
- **SSE auth**: EventSource can't set headers, so it uses a single-use Redis nonce consumed with atomic `GETDEL`.
- **Impersonation** ("Control tenant"): mints a fresh `isImpersonation` session for the target org (no membership row), revokes the admin's old session, and audits it. The no-membership admin synthesis is gated everywhere by `requireAlignedAdmin`.
- **Rate limiting** (Redis-backed): per-IP for portal, per-API-key for read/voice; auth routes get a tighter per-route cap; a Playwright bypass header works **only outside production**.
- **CSRF posture**: no CSRF token — relies on SameSite=Lax + Bearer-in-header on all state-changing routes (the access token isn't in a cookie, so a cross-site form can't carry it). Documented and considered acceptable.

---

## 6. Backend API reference — catalog, commerce & integrations

> All portal routes are under `/api/v1`, tenant-scoped via `app.tenant`, and guarded by `requireRole`. Write routes typically fire three side-effects: `recordAudit()` (audit row), `emitWebhookEvent()` (which **also invalidates the read cache** for that org), and `recordRevision()` (version snapshot). All three are best-effort and never break the request.

### Catalog — Products (`product.routes.ts`) — **REAL/WORKING**
List (search + filters + cursor pagination + 6 sorts), create (plan-cap gate, SKU/slug dedupe, **currency forced to org currency**, fires a background embedding for semantic search), get, patch (re-embeds if name/desc changed), **soft-delete** (tombstones SKU+slug so they can be reused), replace-set variants, image attach/detach/reorder, bulk-update, bulk-delete (admin).
- **Gap:** variant/image/bulk paths skip `emitWebhookEvent`, so the chatbot read cache isn't actively cleared for those edits — it self-heals on the 60-s TTL.

### Catalog — Services, Categories, Business Info — **REAL/WORKING**
Services mirror products (+ replace-set pricing tiers, full delete-recreate weekly availability). Categories are a tree with a self-parent guard and `onDelete: SetNull`. Business Info is a per-org singleton with child collections (locations, contacts, FAQs, policies); changing the org currency **cascades** an update across all products/services/tiers. Same cache-invalidation gap on sub-resource and delete paths.

### Commerce — Carts/Orders (`carts.routes.ts`) — **REAL/WORKING**
Server-authoritative order engine: **always recomputes totals server-side** (never trusts client), enforces min-order, delivery fee, and free-delivery threshold from the shop form. Cart creation fires an operator **notification** + webhook. Orders are created either manually or promoted from the bot's `[CART:]` marker. Statuses: `draft → new → … `.

### Commerce — Bookings (`bookings.routes.ts`) — **REAL/WORKING**
CRUD for appointments; on update, validates the chosen WhatsApp reminder template is Meta-approved and resets the reminder clock when the appointment moves. The actual reminder send is a separate worker tick. (Booking capture on Messenger is deferred — WhatsApp only.)

### Payments (`payment.routes.ts`, `lib/payments/*`, `lib/myfatoorah.ts`) — **REAL link minting, but no confirmation**
Per-tenant provider config (`none`/`cash`/`static_link`/`bank_transfer`/`myfatoorah`/`stripe`/`paypal`); credentials stored as one AES-256-GCM blob; responses expose only `has*` booleans, never raw secrets. `resolvePaymentLink()` mints **real** payment links: MyFatoorah `SendPayment`, Stripe Checkout Session, PayPal Orders v2 — each returns `null` on error so a payment hiccup never breaks the bot reply.
- ⚠️ **This is link-generation only — there is no payment-confirmation webhook.** "Did the customer actually pay?" is **not tracked**; orders never auto-advance on payment (see §11 F-04).

### Storage (`storage.routes.ts`, `lib/storage.ts`) — **REAL/WORKING**
Wasabi (S3-compatible). Two-step upload: presign PUT → browser uploads directly → finalize. Tenant-scoped keys (`org/<id>/…`); a cross-tenant guard rejects any key not prefixed with the caller's org. Returns **503** if Wasabi keys are missing (dev still boots). MIME + size allowlists; CSV upload is server-side + rate-limited 5/min.

### Imports (`import.routes.ts` + worker) — **REAL/WORKING**
Download an XLSX template → upload a CSV/XLSX → a streaming worker validates each row with Zod and upserts it (products by SKU, services by slug, FAQs create-only, business-info singleton; auto-creates categories). Per-row results, edit-and-retry a failed row, cancel mid-run, **CSV-injection-hardened** error export, bulk-clear. Bonus: imports product images from URLs (SSRF-guarded).

### Connectors (`connector.routes.ts` + worker) — **REAL/WORKING**
REST **pull** (cron-scheduled or manual) or inbound **webhook push**. Auth kinds: none/bearer/api_key/basic/hmac. SSRF-guarded outbound fetches. Test-connection probe. Auto-marks a connector `failing` after 5 consecutive failures.
- ⚠️ The inbound webhook HMAC hashes a **re-serialized** body, not raw bytes (see §11 F-03).

### Read API (`read.routes.ts`, `lib/read-cache.ts`) — **REAL/WORKING**
The endpoints the chatbots query, authed by **`X-Aligned-Api-Key`** with per-key scopes (`read:catalog`, `read:business-info`, `read:faqs`). Redis-cached (60 s fresh / 5 min stale, gzipped >2 KB), `x-cache: HIT|STALE|MISS` header, SCAN-based invalidation on writes (with the coverage gaps noted above).

### Webhooks (`webhooks.routes.ts` + worker) — **REAL/WORKING**
Outbound webhook endpoints subscribe to event kinds; deliveries are HMAC-signed (`sha256=hmac(secret, "<ts>.<body>")`), retried with exponential backoff (8 attempts), short-circuit on 4xx, and the endpoint **auto-disables after 25 consecutive failures**. Manual retry available.

### API keys / Revisions / Data export / Audit — **REAL/WORKING**
API keys: `ak_live_…`, sha256-hashed, scoped, secret shown once. Revisions: full JSONB snapshots per change + a **restore** that writes the snapshot back and fires a `catalog_changed` webhook. Data export: GDPR org bundle → gzip → Wasabi → 900-s signed download link. Audit: per-org read + cross-tenant admin read; broad coverage on lifecycle actions (thin on sub-resource edits).

---

## 7. Backend API reference — messaging channels, AI & growth

### 7.1 WhatsApp (`whatsapp.routes.ts`, ~226 KB — the core) — **REAL/WORKING**
Per-tenant Meta Cloud API config (multi-number), one-click webhook subscription, verify, test-send, free-form + media send (with audio→document transcode fallback). The **inbound webhook**:
- **Meta verify handshake** (constant-time token compare) + **HMAC-SHA256 over raw body** with the channel's app secret.
- **Status receipts** (delivered/read) propagate to `BroadcastRecipient` counters by message id.
- **Inbound dedup** prevents Meta retries from double-replying or double-capturing carts.
- **`maybeReplyAsBot`** — the auto-reply path: coalesces bursts (in-batch + Redis debounce), throttles per phone (20/min), and **stays silent** if the bot isn't deployed, a human owns the thread, the thread is escalated, the org has AI disabled, or the contact is blocked.
- **Voice notes**: download → Whisper transcribe → feed into the same pipeline.
- **Markers** (parsed and stripped server-side): `[HANDOFF]` (escalate), `[IMAGE: sku]` (send product images, dedup), `[BOOKING: {json}]` (persist booking, with a deterministic fallback extractor), `[CART: {json}]` (promote to order, with fallback), `[PAYMENT_LINK]` (resolve a real invoice URL). On a cart-confirm turn it sends a **deterministic receipt** and suppresses the LLM's own confirmation text (avoids double-texting).

### 7.2 Operator Inbox (`inbox.routes.ts`) — **REAL/WORKING**
Threads list (filter by channel/assignee/status/tag/search), messages (with media URLs), reply (channel-aware: WhatsApp vs Messenger/IG), assign/auto-assign (skill-aware), tags, internal notes, status, handoff, typing indicators, SSE live updates, canned responses with `{first_name}`/`{phone}` variables. **The "AI on/off" control is thread ownership**: a human reply/assignment sets `assignedToUserId` (bot pauses); clicking "AI" clears it (bot resumes). ALIGNED-admin-only: a 4-tab **provenance** panel on each bot bubble + flag-decision buttons.

### 7.3 Messenger + Instagram (`messenger.routes.ts`, `lib/messenger-send.ts`) — **REAL/WORKING** (booking deferred)
One webhook serves both (`object: 'instagram'` vs `'messenger'`). **Key fix:** Instagram-Login tokens (`IGAA…`) must use `graph.instagram.com`; Facebook tokens use `graph.facebook.com` — routed by token prefix. Auto-upserts a Contact (PSID stored in `phoneE164` as bare digits so it can't collide with a real `+E.164`), fetches profile names (IG shows `@username`), enforces multi-locale STOP/opt-out, gates on AI-disabled/blocked, supports quick-reply buttons and handoff. Commerce on these channels runs through the **channel-agnostic `cart-flow.ts`** engine (reuses the WhatsApp cart parser). Cart works; **booking capture on Messenger is deferred**.

### 7.4 Voice gateway (`voice.routes.ts`, `phone-integration.routes.ts`, `lib/voice-prompt.ts`) — **REAL/WORKING**
Connects the separate **Aseer-time phone voicebot** as brain + system of record. `GET /voice/config` (API-key authed) returns a compiled phone-style realtime prompt (≤25 words, no markers, `transfer_to_human` escalation) built from the catalog and cached in Redis. Call lifecycle (`calls`/`turns`/`end`) ingestion is **idempotent** and tolerates out-of-order arrival. Phone integrations map a DID → tenant and auto-issue a scoped voice API key. Portal has list/detail of calls + transcripts (no dedicated UI page yet).

### 7.5 Growth
- **Broadcasts** (`broadcasts.routes.ts`) — **REAL/WORKING, WhatsApp-only.** Campaigns with CSV/segment/manual/**contacts** audiences, A/B testing with post-hoc winner, scheduling, pause/resume/cancel, per-recipient delivery tracking (fed by the status webhook), CSV export, rerun-failed, live SSE counters, analytics, and **response attribution** (credits an inbound reply to a campaign within a 72-h window). Never sends to Instagram.
- **Contacts / Segments / Sequences / Notifications / Leads** — all **REAL.** Contacts CRM with channel split + tags + block + opt-out + CSV import; Segments compile a filter AST into a Prisma query; Sequences are WhatsApp-template drip campaigns driven by a worker tick; Notifications power the bell; Leads is the public (unauthenticated, rate-limited) marketing-site capture into the global table.
- **Billing** (`billing.routes.ts`, `lib/billing.ts`) — **REAL** genuine Stripe: plans, Checkout, Customer Portal, **signed** webhook handling subscription/invoice events; plan caps (members/products/webhooks) enforced. Cleanly inert (503) without Stripe keys.
- **SaaS / white-label** (`saas.routes.ts`) — **REAL**: branding (logo + colors), real DNS CNAME verification, the `/caddy/ask` on-demand-TLS authorizer, Meta onboarding stepper state, analytics.
- **Account / Org / Dashboard / Status** — **REAL**: GDPR export + account/org delete, 2FA endpoints, dashboard widget data + per-user layout, public status.

---

## 8. The AI bot engine, in depth

The bot is **channel-agnostic** at its core (`lib/bot-engine.ts`, ~79 KB) and reused across WhatsApp, Messenger/IG, and (in a phone-tuned variant) voice. **Every feature here is REAL/WORKING.**

- **`gatherBotData(orgId)`** — parallel reads of the bot config, products (≤30, with embeddings + images + variants), services, business info, FAQs, policies, locations, contacts. **Every query carries an explicit `organizationId` filter** even though it runs under bypass — defense-in-depth after a past leak.
- **`buildBotResponse`** — assembles the system prompt: persona, languages, a **`channelLabel`** rule (never say "WhatsApp" unless actually on WhatsApp), an **anti-re-greeting** rule, a TTS/voice banner when in voice mode, and all marker instructions. Catalog injection is **semantic**: if ≤12 products it sends the whole catalog, else it embeds the customer's message and sends the top-10 by cosine similarity (always re-including the active cart + pinned products so "confirm" turns don't drop items).
- **Safety (critical, from hard-won experience):** all example product names in the prompt are `<PLACEHOLDER>` tokens, **never** literal SKUs — because the cheaper models would copy literal examples into real replies. Every soft prompt directive is paired with a **deterministic post-LLM validator** (`reply-validators.ts`, an 8-stage pipeline: drop unknown image SKUs, scrub voice apologies, inject cart totals, enforce booking fidelity, currency rewrite, dedupe greetings, etc.).
- **Provider chain by AI plan** (`openai.ts`): `basic` → Groq Llama (→ OpenAI fallback on 429/5xx); `middle` → GPT-4o; `max` → Claude Sonnet with prompt caching; `ultra` → Claude Sonnet for replies + Claude Haiku for aux passes. Any failure **degrades gracefully** down to basic so the bot never goes dark. A **per-org daily token cap (200K)** is enforced atomically in Redis and **pre-charged** before the call — a cost-DoS control.
- **Provenance** (`provenance.ts` + `provenance-scanner.ts`): every reply persists the exact (deduped) system prompt, inputs, model, tokens, latency, plus **citations** (which catalog/FAQ row backs each claim) and **hallucinations** (product/price-shaped phrases not found in the candidate data, with severity).
- **Bot builder** (`bot.routes.ts`, ~83 KB): persona/greeting config, a Playwright **website crawler** → knowledge base, KB CRUD, an **adaptive questionnaire**, a **live simulator**, **test scenarios** with an LLM judge, **conversation flows**, and **deploy/undeploy** (the `deployedAt` flag the inbound webhook checks). All real.

---

## 9. Background workers & scheduled jobs

One `worker` process runs everything. **All REAL/WORKING.**

| Job | Type | What it does |
|---|---|---|
| `import` | BullMQ | Streaming CSV/XLSX row-by-row validate + upsert |
| `sync` | BullMQ | Connector pull → validate → upsert; auto-fail after 5 |
| `webhook-delivery` | BullMQ | Outbound webhook POST + retry/backoff + auto-disable |
| `crawl` | BullMQ (Playwright) | Renders sites, extracts text/products for the KB |
| `data-export` | BullMQ | GDPR bundle → gzip → Wasabi |
| `broadcast-fanout` | BullMQ | Materializes recipients (restart-safe), enqueues per-recipient sends |
| `broadcast-send` | BullMQ | Sends one WhatsApp template, honoring the per-org token bucket |
| `sequence-tick` | 30 s loop | Fires due drip-campaign steps |
| `dunning-tick` | 1 h loop | Auto-suspends orgs past-due beyond the grace window |
| `booking-reminder-tick` | 60 s loop | Sends a reminder ~2 h before each booking (double-send-guarded) |
| `provenance-digest-tick` | 24 h loop | Daily flagged-reply digest email to ALIGNED admins |
| `draft-cart-ttl` | 1 h loop | Expires stale draft carts |
| `inbox-consistency` | 15 min loop | Re-links orphaned messages to threads |
| `uptime-probe` | 60 s loop | Self-pings the API, stores uptime in Redis |

> The `email` queue is defined but **has no worker** — transactional email still sends inline. Tick loops use Redis locks (multi-replica-safe in principle), but prod runs a single worker process (SPOF — see §12).

---

## 10. The web app — every page, real vs UI-only

**How the client works:** `lib/api.ts` is the single HTTP client; the JWT lives in memory only; on a 401 it does one silent cross-tab-serialized refresh and retries. `lib/session.tsx` bootstraps the session and exposes sign-out/switch-org. The `(dashboard)/layout.tsx` guard redirects unauthenticated users to `/login`, sends manual-inbox tenants to `/inbox`, and blocks direct-URL access to any feature disabled for that tenant. `packages/shared/org-features.ts` is the single source of truth that both **hides nav items** and **guards routes** based on `organization.disabledFeatures`.

> **Headline finding: this app is overwhelmingly REAL.** Across all 51 pages, the auditors found essentially **no dead buttons** — every primary action is wired to a real API call. The only genuinely non-functional items are listed at the end of this section. Below, each control is tagged **REAL** (calls the API), **UI-ONLY** (cosmetic/local state), or **PARTIAL**.

### Shell & navigation — REAL
Sidebar (nav filtered by disabled features; live inbox-escalation badge `GET /inbox/counts`; admin leads badge `GET /aligned-admin/leads/count`), top bar (org switcher `POST /auth/switch-org`, sign-out `POST /auth/logout`), notifications bell (`GET /notifications`, mark-read, mark-all-read). UI-only: theme toggle, sidebar collapse, mobile drawer.

### Auth pages — all REAL
`/login` (`POST /auth/login`, with a real TOTP step), `/signup`, `/forgot-password`, `/reset-password`, `/verify-email` (auto-verifies on load), `/invite/[token]` (accepts invite). Show/hide-password etc. are UI-only.

### Dashboard — REAL
Two modes: ALIGNED-admin-in-own-HQ renders the **platform overview** (`AdminPlatformDashboard`: tenants/users/catalog/queue KPIs + system health + tenants table, from `GET /aligned-admin/system` + `/orgs`); everyone else gets the **editable widget board** (layout saved via `GET/PUT /me/dashboard-layout`). All widgets fetch real data (KPIs, onboarding checklist, inbox snapshot, bot performance, outreach, AI budget, connections/sync, recent activity). Edit-mode toggles and the onboarding-dismiss are UI-only/localStorage.

### Catalog — all REAL
- **Products list**: search/filter (`GET /products`), new (`POST`), bulk mark/delete (`POST /products/bulk-update` / `bulk-delete`), row delete (`DELETE`). Pagination/checkboxes UI-only.
- **Product editor**: debounced auto-save (`PATCH /products/:id`), image upload (Wasabi presign → PUT → finalize → attach), make-primary, remove image, variants (local until "Save variants" → `PUT …/variants`), **version history** (list/preview/restore via `/revisions/*`), delete.
- **Services** (mirror), **Categories** (tree with counts, create/bulk-delete/delete/reorder), **Business Info** (6 tabs: profile+hours, FAQs, policies, booking form, shop form, locations+contacts — all save to real endpoints; form-builder rows are local until save).

### Commerce — all REAL
- **Orders** (`/cart`): list (`GET /carts`), status dropdown (`PATCH`), delete; "View chat" links to the inbox. Row expand UI-only.
- **Bookings**: list, status (`PATCH /bookings/:id`), reminder-template dropdown (real; gated/disabled when no parseable date or no approved template — that's gating, not a dead button), delete. List/Calendar tabs UI-only.

### Integrations — all REAL
- **Imports**: job list (auto-poll), template download, delete, clear, the import wizard (`POST /assets/upload-csv` → `POST /imports`). Detail page: rows, cancel, **edit-and-retry a failed row**, download errors CSV.
- **Connectors**: list, runs history, test-connection, run-now, create, delete. "Copy webhook URL" is UI-only (clipboard).
- **API keys**: list, create (scopes; secret shown once), revoke. Reveal/copy UI-only.
- **Webhooks**: list, deliveries, active toggle, create, delete, retry delivery.

### ALIGNED Admin — all REAL
- **`/aligned-admin`** orgs table: **Suspend / Reactivate / Details / AI (usage + plan change) / Access (feature toggles) / Control (impersonate) / Delete** — every one calls a real endpoint. Suspend/Access/Delete are **disabled on your own org** (self-lockout protection). Details dialog: edit member email, issue a one-time reset link.
- **new-tenant** (create org + optional generated password), **leads** (status/delete), **provenance** + **suppressions** (cross-tenant browser, add/remove/promote-global), **revenue** (read-only), **system** (health/traffic/uptime + drain-failed-queue), **audit** (cross-tenant log).

### Settings — mostly REAL
- **Profile**: save profile, change password, export my data, delete account, **full 2FA** (setup/verify/confirm/disable).
- **Billing**: plans + subscription, Upgrade (Stripe Checkout), Manage (Stripe Portal). "Contact us" button is **intentionally disabled** for plans without a Stripe price.
- **Payments**: load/save provider config (masked secrets).
- **Data export**: list, start, download.
- **Messenger**: save creds, connect/subscribe (gated until a token exists), disconnect.
- **`/settings/branding`**: ⚠️ **UI-ONLY placeholder** ("coming soon") — the only non-functional page. The real implementation exists in git history but isn't wired.

### Inbox (the most important screen) — all REAL
A 3,000-line component behind `/inbox` and `/inbox-full`. Thread list filters (incl. channel WhatsApp/Messenger/IG), SSE live updates with polling fallback, send reply (channel-aware), internal notes, status change, take/assign, **AI on/off** (assign/unassign), handoff, per-chat bot reply-mode, reset, delete, rename, tags, customer Info slide-over (with tag editor), load-earlier, file attach, voice-note record/send, canned-response insert, template-send dialog, and the ALIGNED-admin **provenance debug panel** with hallucination flag decisions.

### Bot builder, WhatsApp, Voice, Growth, Analytics — all REAL
Bot builder (deploy/undeploy, crawl start/cancel/review, persona + quick-replies + greeting config, TTS settings, conversation flows, live simulator). WhatsApp (save/verify/live-toggle/test-send/disconnect + onboarding stepper + template builder/submit/sync). Voice phone-integrations (create line, pause/activate, delete, call history). Broadcasts (list/delete/resend; the 4-step wizard with audience picker incl. Contacts; detail page with SSE counters, analytics, recipients, timeline, pause/resume/cancel/rerun/resend/export). Contacts (channel filter, IG `@handle`, infinite scroll, tags, block, import). Analytics + Audit-log (read-only with real filters).

### The complete list of NON-real items (everything else is wired)
1. **`/settings/branding`** — full "coming soon" placeholder (no API).
2. **Billing "Contact us"** — intentionally disabled for no-Stripe-price plans.
3. **`/segments` and `/sequences`** — redirect stubs to `/broadcasts?tab=…` (intentional consolidation).
4. **Pure client controls** that legitimately have no API: theme/collapse/drawer toggles, table expand/collapse, select-all checkboxes, search/filter/pagination *local state* (they drive real queries), "Copy"/"Reveal secret" clipboard buttons, dashboard edit-mode, onboarding-banner dismiss.
5. **Dashboard layout save** fails *soft* (keeps local state on error) — intended resilience, not a dead control.

---

## 11. Security audit

### Executive summary
The platform has a **mature, defense-in-depth posture** unusual for its origin as a sprint MVP: Postgres RLS with `FORCE` + a non-superuser runtime role, rotating refresh tokens with reuse detection, algorithm-pinned JWTs, AES-256-GCM secret encryption, a broadly-applied SSRF guard, raw-body HMAC for WhatsApp webhooks, and a **hard CI gate** that runs tenant-isolation tests without `continue-on-error`. **No critical, directly-exploitable cross-tenant read or privilege-escalation vector was found.** The material findings are about *incomplete* application of otherwise-good controls.

Two of the leads carried into this audit were **refuted after reading the code**: `crawl_pages` *is* RLS-protected, and `withRlsBypass` running as the owner role is *not* a correctness problem (RLS here is flag-based with `FORCE`, so the owner is still filtered unless the bypass flag is set).

### Findings

| ID | Title | Severity | Status |
|---|---|---|---|
| F-01 | Secret encryption covers only `WhatsAppChannel`; `ApiConnector` auth/webhook secrets are plaintext | **High** | Confirmed |
| F-02 | Bot runtime relies on `withRlsBypass` + manual org filters (no RLS backstop) | **High** | Confirmed |
| F-03 | Connector inbound-webhook HMAC hashes re-serialized JSON, not raw bytes | **High** | Confirmed |
| F-04 | Payments are link-only — no payment-confirmation webhook (fraud/repudiation) | **High** | Confirmed |
| F-05 | SSRF guard is literal-IP-only; DNS-rebinding unguarded | Medium | Confirmed |
| F-06 | `SECRET_ENCRYPTION_KEY` SPOF + silent plaintext fallback | Medium | Confirmed |
| F-07 | Web build ignores TypeScript + ESLint errors; CI tests are `continue-on-error` | Medium | Confirmed |
| F-08 | Pino redaction misses `accessToken`/`appSecret`/`pageAccessToken`/`credentials` | Medium | Confirmed |
| F-09 | `decryptSecret` swallows GCM auth-tag failures and returns ciphertext | Low | Confirmed |
| F-12 | API keys sha256 (not bcrypt); CSRF via SameSite+Bearer | Low | Confirmed (acceptable) |
| F-13 | SSH password auth on non-standard port; broken Actions deploy; flat-file secret | Medium (infra) | Confirmed (process) |
| F-10/F-11 | `withRlsBypass` role / `crawl_pages` RLS | — | **Refuted** |

### Detail on the High findings
- **F-01 — Incomplete secret-at-rest.** Only `WhatsAppChannel.accessToken/appSecret` are encrypted. `ApiConnector.authConfig` (bearer tokens / API keys) and `webhookSecret` are plaintext even when the key is set. A DB dump/SQLi/read-replica leak exposes every tenant's upstream integration credentials and lets an attacker forge signed inbound webhooks. **Fix:** extend the Prisma encryption extension to `apiConnector`; backfill.
- **F-02 — Bot-runtime isolation.** The entire inbound-message hot path (`contact-memory`, `cart-flow`, `booking-slots`, `messenger-send`, etc.) runs under `withRlsBypass` (filtering OFF) and relies on a *manual* `organizationId` in each query. Correct today (verified), but this is exactly the class that caused the prior `contact_memory` leak; a single future forgotten filter leaks cross-tenant with no backstop. **Fix:** use `withTenant(orgId, …)` here (the org is always known from the channel) so RLS becomes a backstop again.
- **F-03 — Connector HMAC.** Hashes `JSON.stringify(req.body)` instead of the raw bytes (the WhatsApp route does it correctly with `req.rawBody`). Breaks legitimate senders whose serialization differs and weakens the integrity guarantee. **Fix:** hash `req.rawBody`.
- **F-04 — Payment repudiation.** No signed gateway callback confirms payment; orders never reflect "paid". No authoritative money-moved record; manual reconciliation; dispute exposure. **Fix:** implement + verify provider payment-status webhooks and gate order state on confirmed payment.

### What's done genuinely well
RLS architecture (FORCE + non-superuser role + clean macro across ~67 tables + thoughtful special-case policies); **tenant-isolation is a hard CI gate** (plus provenance/webhook/read-api gates); JWT hygiene (algorithm allowlist, rotation, reuse detection, revoke-on-password-change, lockout); a sound privilege model (admin flag from a signed claim backed by a DB column; audited, gated impersonation); correct raw-body WhatsApp HMAC; a broad, consistently-applied SSRF guard (only DNS-rebinding remains); proper envelope encryption (just incompletely applied); **all raw SQL is parameterized** (no injection found); an LLM cost-DoS control (pre-charged daily token budget); LLM safety (placeholder prompts, post-LLM hallucination scan, double-text suppression); and compliance basics (multi-locale STOP/opt-out, public-endpoint rate limits, prod-gated test bypass).

---

## 12. Consolidated risk & tech-debt register

**Security (from §11):** F-01 incomplete secret encryption (High) · F-02 bot-runtime bypass reliance (High) · F-03 connector HMAC over re-serialized body (High) · F-04 no payment confirmation (High) · F-05 SSRF DNS-rebinding · F-06 encryption-key SPOF + silent fallback · F-07 build ignores type/lint errors · F-08 log-redaction gaps · F-09 decrypt swallows tamper failures · F-13 password SSH + flat-file secret.

**Architecture / operations:**
1. **tsx-in-prod + gitignored `dist/`** for `@aligned/db`/`@aligned/shared` → stale-schema deploys unless `redeploy.sh` is used (it always rebuilds them). Any other deploy path silently ships stale code.
2. **Broken GitHub Actions auto-deploy** — deploys are manual SSH; some `deploy.yml` config still references the old `aligned-tech.com` domain.
3. **Single VM, single instance of everything** (Postgres, Redis, api, worker, web, Caddy). No HA. The Next build OOM'd the box twice (now mitigated by a 4 GB swap + heap cap). The worker is one process running 14 concurrent workloads.
4. **Fresh-DB migration fails** (RLS helpers referenced before creation) — DR rebuild needs a manual bootstrap.
5. **Email queue defined but no worker** — transactional email sends inline.
6. **Read-cache invalidation is partial** — variant/image/bulk/category/location/contact writes and FAQ/policy deletes rely on the 60-s TTL rather than active invalidation.
7. **Docker prod stack is effectively dead code** (diverges from the native run model).

**Functional gaps (deferred, not bugs):** Messenger/Instagram **booking capture** (cart works), a dedicated voice-calls UI page, the branding/white-label page, and audit coverage on sub-resource edits.

---

## 13. Glossary

- **Tenant / Organization** — one customer business on the platform. All data is partitioned by `organization_id`.
- **RLS (Row-Level Security)** — Postgres feature that filters every query to the current tenant; the backstop that makes multi-tenancy safe.
- **`withTenant` / `withRlsBypass`** — the two DB-access modes: tenant-scoped (RLS on) vs. cross-tenant (RLS off, admin/auth/system only).
- **ALIGNED admin / Hader admin** — the super-admin role (`isAlignedAdmin`) that operates across all tenants.
- **Impersonation / "Control"** — an admin temporarily acting inside a tenant's workspace to fix their data.
- **Marker** — a bracketed token (`[CART:]`, `[BOOKING:]`, `[IMAGE:]`, `[HANDOFF]`, `[PAYMENT_LINK]`, `[BUTTONS:]`) the LLM emits; the server parses and acts on it, then strips it from the customer-facing text.
- **Provenance** — the recorded "why" behind each bot reply: the prompt, inputs, model, citations, and flagged hallucinations.
- **Read API** — the cached, API-key-authed endpoints the chatbots query for catalog/business data.
- **Channel** — a messaging surface: WhatsApp, Facebook Messenger, Instagram DM, or phone (voice).
- **PSID/IGSID** — Meta's per-user scoped IDs for Messenger/Instagram; stored in `customerPhone`/`phoneE164` for non-WhatsApp channels.
- **BullMQ** — the Redis-backed job queue powering the worker.
- **Soft-delete** — marking a row deleted (`deletedAt`) instead of physically removing it.
- **AI plan (basic/middle/max/ultra)** — which LLM provider chain a tenant's bot uses.

---

*End of report. Every claim above is traceable to source files; ask for the file:line backing for any specific point and it can be produced from the underlying audit notes.*
