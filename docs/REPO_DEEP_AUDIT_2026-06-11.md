# Alignbot / "Hader AI" — Whole-Repository Deep Audit

> **Produced:** 2026-06-11. **Method:** every tracked source file (441 files, ~95,700 lines) was read line-by-line by a fleet of reader agents, then cross-checked against the actual code (never against names, comments, or `CLAUDE.md`). Findings below are grounded in the source, with `file:line` citations. Where a comment, doc, or UI label contradicts the code, that is recorded explicitly.
>
> This document is the canonical "what the system actually is" reference. It deliberately diverges from `CLAUDE.md` and `docs/` wherever those drifted from reality (and there is a lot of drift — see §13).

---

## 0. TL;DR — the ten things you must know

1. **The product is mid-rebrand from "ALIGNED" → "Hader AI".** Code, emails, and several UI surfaces say "Hader"/`hader.ai`; `CLAUDE.md` and a few pages still say "ALIGNED"/Mediterranean-Blue/`aligned.app`. The login/auth shell is hard-coded to an "Oxblood + Sand" palette that bypasses theme tokens. This is cosmetic but pervasive (§12).
2. **Production does NOT run on Docker.** Despite `CLAUDE.md` §2/§4 and `docker-compose.prod.yml`, the real deploy is **native systemd + `tsx`** over SSH (`deploy.yml` line 9: *"No Docker / no GHCR"*, line 515: `systemctl restart aligned-api aligned-worker aligned-web`). The Dockerfiles **cannot even start** (`CMD node dist/server.js` but there is no build step → no `dist/`), and `docker-compose.prod.yml`/Caddyfile/pgbouncer.ini are dead config. (§3, §14)
3. **The Stripe billing webhook is broken in a way that disables the entire billing lifecycle.** `billing.routes.ts:381` verifies the signature against `JSON.stringify(req.body)` instead of the captured `req.rawBody`; Stripe signs the exact pretty-printed bytes, so **every** real webhook fails signature verification → subscriptions never activate, `past_due`/cancellations never mirror. The fix is one line and the codebase already does it correctly for the WhatsApp webhook. (§6.8, §13)
4. **The RLS bootstrap is fragile and partly broken.** `rls.sql` is **not idempotent** (a sessions-policy DROP/CREATE name mismatch makes every re-apply fail at line 233); the production deploy swallows that failure with `|| true`; and a fresh-DB `prisma migrate deploy` **cannot complete** because three migrations call `_aligned_apply_tenant_rls()` which only exists in `rls.sql` (not yet run). Three tenant tables (`bookings`, `bot_test_scenarios`, `bot_conversation_flow_options`) are missing from `rls.sql` entirely. (§5)
5. **The worker process has NO RLS enforcement — and no test can catch a regression there.** `apps/worker/src/jobs/db.ts` `withTenant()` sets `app.current_org_id` but never `SET LOCAL ROLE aligned_app` (the API does). Prisma connects as a superuser, which bypasses RLS unconditionally, so tenant isolation in *every* worker write path (import/sync upsert, crawl draft creation, broadcast fanout/send, data-export, inbox-consistency, sequence-tick) rests **entirely** on hand-written `organizationId` filters with no DB backstop. Critically, the "hard gate" `tenant-isolation.test.ts` exercises the **API process only** — there is no test asserting cross-tenant isolation in any worker job, so a single missing `organizationId` predicate is an unguarded *and untested* cross-tenant write. The platform's headline safety claim ("RLS is the non-negotiable backstop") is simply false in the worker. (§5, §9, §10)
6. **The WhatsApp bot auto-replies to real customers, but several UI surfaces still claim it doesn't.** The `/whatsapp` page's "honesty banner" and Live-toggle copy say replies are handled "by your bot runtime — Landbot… or Phase 2 when it ships." That's stale: `maybeReplyAsBot` ships autonomous replies whenever the channel has `accessToken + phoneNumberId + isActive`. (§6.1, §8, §12)
7. **The chatbot's catalog is silently capped at 30 products with no deterministic ordering.** `gatherBotData` uses `take: 30` with **no `orderBy`**; for any tenant with >30 products the bot sees an arbitrary, unstable subset and tells customers the others "aren't in the catalog." Even a customer's own past-order item can be unrecoverable. (§7)
8. **A large class of catalog writes never invalidate the read cache or emit webhooks.** Variant edits, image attach/detach/reorder, pricing-tier and availability replacement, bulk-update/bulk-delete, all location/contact CRUD, FAQ/policy deletes, **every** category route, and the website-crawl writes all skip `emitWebhookEvent()` — which is the ONLY cache-invalidation path. The bot serves deleted FAQs and stale prices for up to the full cache TTL. (§6.4, §7.6, §13)
9. **The provenance system's "production failure" is already fixed — `CLAUDE.md` is stale.** The documented "no provenance rows in prod" mystery was a `void` (fire-and-forget) bug fixed in the same 2026-05-22 session (`335bbea` flipped `void → await`; `66530a8` 37 min later confirmed the happy path firing). Two latent risks still silently drop rows (a throwing persist-tx skips provenance; a racy snapshot check-then-insert's P2002 drops the whole row), both swallowed as WARN with no metric/Sentry. (§8.6)
10. **The test "deploy gate" protects very little and is not wired to the deploy.** The hard gate is one Vitest file (`tenant-isolation.test.ts`) that does direct-RLS probes on only `contacts` + `api_connectors`; everything else relies on route 404s. `lint`/`typecheck`/`test` are all `continue-on-error`. Crucially, `deploy.yml` does **not** `needs:` CI — both fire independently on push to `main`. And `setup.ts` runs `TRUNCATE … CASCADE` against whatever `DATABASE_URL` is in the shell, with zero environment guard. (§10)

---

## 1. What the system actually is

**Alignbot** (product name "Hader AI", domain `hader.ai`; legacy `alignbot.aligned-tech.com`) is a **multi-tenant WhatsApp AI customer-service / commerce platform**. Each tenant ("organization") manages a product/service catalog, business info, FAQs, and policies; connects a Meta WhatsApp Cloud API number; and the platform runs an **LLM chatbot** that answers inbound WhatsApp messages grounded in that tenant's data — taking orders (carts), bookings, escalating to human agents, sending images and voice replies, and (Phase 8) recording a per-reply **provenance/hallucination audit trail**.

It is more than the "Data Management Platform" that `CLAUDE.md`'s 4-day plan describes. The repo has grown through (at least) Phases 1–13 and into uncommitted "voice calls" work. The actually-shipped surface includes:

- **Auth & RBAC** (in-house JWT + refresh cookies, TOTP 2FA, org switching, ALIGNED-admin impersonation).
- **Catalog** (products + variants + images, services + pricing tiers + availability, categories, business info, locations, contacts, FAQs, policies) with version history.
- **CSV/XLSX imports**, **REST/webhook connectors** (scheduled pull + HMAC inbound push), **outbound webhooks**, **chatbot read API** (API-key authed, Redis-cached).
- **WhatsApp**: channel config + multi-number, Meta message templates, the **inbox** (threads, tags, notes, canned replies, SSE), and the **bot engine** (KB retrieval, prompt assembly, OpenAI/Groq/Anthropic by plan, reply validators, cart/booking/handoff/image/voice protocols, provenance).
- **CRM/outreach**: contacts, segments (filter-AST), broadcasts (A/B, scheduled, send-window, pause/resume), drip sequences.
- **Commerce**: carts/orders, bookings (+2h reminder), MyFatoorah payment links.
- **Billing** (Stripe — broken webhook), plans/caps/usage, dunning.
- **AI bot builder**: website crawler (Playwright) → KB/draft-catalog extraction, personality/voice config, conversation-flow editor, LLM-judged test scenarios, simulator, one-click deploy.
- **ALIGNED super-admin**: tenant CRUD, impersonation, system health, traffic, uptime, cross-tenant audit, provenance browser, suppressions, revenue, leads.
- **Phase 8 provenance**: per-reply system-prompt snapshot + citations + hallucination scan + flag decisions + daily digest.
- **White-label branding** (logo/accent/custom CNAME via Caddy on-demand TLS).
- **Uncommitted (in working tree at audit time):** a "voice calls" gateway (`/api/v1/voice/*`, Aseer-time Asterisk voicebot) — new `VoiceCall`/`VoiceCallTurn` models, `voice-prompt.ts`, `schemas/voice.ts`, migration `20260611130000_voice_calls`.

---

## 2. Locked tech stack (as actually used)

| Area | Reality |
|---|---|
| Runtime | Node 20 (`.nvmrc`, engines `>=20.11`, all workflows) — **not Node 22** as `CLAUDE.md` claims |
| API | Fastify + TypeScript, run via **`tsx` directly** (no build/emit). `fastify-type-provider-zod`, helmet, CORS, `@fastify/rate-limit` (Redis), under-pressure, swagger |
| Worker | BullMQ workers + `setInterval`/`setTimeout` "ticks", run via `tsx` |
| Web | Next.js 15 App Router, Tailwind v4, TanStack Query, hand-rolled theme + session; `basePath: '/app'` |
| ORM/DB | Prisma 6 + PostgreSQL 16; **Postgres RLS** as backstop (API only); `pg_trgm`, `citext`, `pgcrypto` |
| Pooling | PgBouncer (transaction mode) — but the committed `pgbouncer.ini` is **dead config**; prod uses a host install |
| Cache/Queue | Redis 7 (one shared ioredis client for rate-limit + cache + SSE) + BullMQ |
| LLM | **Groq Llama-3.3-70B** (basic, primary chat) with OpenAI gpt-4o-mini fallback; **OpenAI gpt-4o** (middle); **Anthropic Sonnet** (max/ultra) + **Haiku** (ultra aux/intent/persona). OpenAI also for embeddings + transcription. `CLAUDE.md`'s "GPT-4" framing is stale |
| Storage | Wasabi (S3) via AWS SDK v3, presigned PUT (browser-direct) + server PUT |
| WhatsApp | Meta Cloud API v20.0 (hardcoded in ~12 sites) |
| Email | **nodemailer/SES** (+ Mailhog/Mailpit dev). `CLAUDE.md`'s "Resend" is **wrong** — there is no Resend code |
| Payments | Stripe (subscriptions — webhook broken) + MyFatoorah (WhatsApp payment links) |
| Hosting | **Native systemd on a single host** (`88.80.145.171:269`, user `aligned`, `/opt/aligned/app`) behind a **bare-metal Caddy** — **not** Docker Compose |
| CI/CD | GitHub Actions: `deploy.yml` (SSH native deploy), `ci.yml` + `e2e.yml` (mostly non-blocking), plus `logs`, `zap-baseline`, `load-test`, `embedding-backfill` |
| Observability | Pino + Sentry (no-op without DSN) + Prometheus `/metrics` (api :4000, worker :9100) — both unauthenticated |

---

## 3. Deployment reality (this overrides the docs)

`.github/workflows/deploy.yml` is the source of truth. On push to `main` it SSHes to the host and:

1. Syncs `.env.production` from GitHub secrets via an embedded Python heredoc (skips blank secrets so it never blanks an on-disk credential; `chmod 600`).
2. `git reset --hard origin/main`; apt-installs `ffmpeg` if missing (npm `ffmpeg-static` segfaults on the host's libc — documented incident).
3. Tears down `node_modules` (to dodge pnpm's interactive prompt over non-TTY SSH), probes the pnpm store, `NODE_ENV=development pnpm install --frozen-lockfile` (forces devDeps so `tsx` is present).
4. `prisma generate` → `prisma migrate resolve --rolled-back` for two hardcoded migrations → `prisma migrate deploy` → **`psql -f rls.sql || true`** (RLS failure swallowed).
5. Builds **only** `@aligned/shared`, `@aligned/db`, `@aligned/web` (`next build`). **api + worker are never built — run via `tsx`.**
6. Runs `super-admin.ts` seed (force-resets the super-admin password on every deploy — see §5).
7. Runs **five diagnostic `psql` blocks that echo customer message bodies + phone numbers into the GitHub Actions log** (PII leak — §11).
8. Audits TTS env, syncs Wasabi CORS, sed-patches the **live** `/etc/caddy/Caddyfile` (mic policy + domain swap), `systemctl restart` the three units, writes the **plaintext super-admin password** to `/opt/aligned/secrets/super-admin.txt`, and smoke-tests `/health` (no rollback on failure).

**Dead/broken infra paths** (referenced by docs but not used, and broken if resurrected): `apps/{api,worker,web}/Dockerfile` (no `dist/`, no `tsx` in `--prod` deploy → crash-loop), `docker-compose.prod.yml`, `infra/caddy/Caddyfile` (Docker upstreams `web:3000`/`api:4000`; live host uses `localhost`), `infra/pgbouncer/pgbouncer.ini` (nothing mounts it), `infra/scripts/deploy-remote.sh` (a stale near-duplicate of the inline deploy script — **already drifted**: it has no GROQ handling and a different ELEVENLABS_MODEL default). `embedding-backfill.yml` runs `docker compose exec` against a stack that isn't running → broken.

**Notable deploy risks:** no `concurrency:` group (two rapid pushes = two concurrent SSH deploys both `rm -rf node_modules`); CI is **not** a gate for deploy; `appleboy/ssh-action@v1` (mutable tag) receives the prod SSH key + every secret; `.env.production` and `.env.development` are **not** in `.gitignore` (a `git add -A` on the server would commit prod secrets); `migration_lock.toml` **is** gitignored by an over-broad rule and therefore untracked (Prisma wants it committed).

---

## 4. Monorepo map

```
apps/
  api/      Fastify REST API (117 files). Modules under src/modules/*, libs under src/lib/*, plugins under src/plugins/*
  worker/   BullMQ workers + recurring ticks (27 files)
  web/      Next.js 15 portal (116 files)
  e2e/      Playwright harness (26 files)
packages/
  db/       Prisma schema (2,500 lines, 59 models, 30 enums) + rls.sql + migrations (45 dirs) + seeds
  shared/   Zod schemas + enums + url-guard (the cross-app contract; 33 files)
  config/   eslint/tsconfig/prettier bases (7 files) — eslint presets are NOT wired into any lint script
infra/      caddy / pgbouncer / scripts (mostly dead — see §3)
docs/       15 docs (heavily drifted from code — §13)
aligned-design-system/  design tokens + component docs
imports/aseer-time/     sample CSVs (a real pilot tenant's data)
```

Tooling: pnpm 9.12 workspaces + Turborepo. `tsconfig.base` is `strict` with `noUncheckedIndexedAccess` but `noUnusedLocals/Parameters: false` (dead imports/vars abound). The `packages/config` eslint flat-configs exist but **no package's `lint` script references them** — linting is effectively unconfigured.

---

## 5. Data model & multi-tenancy (Prisma + RLS)

**Schema:** `packages/db/prisma/schema.prisma`, 59 models / 30 enums. Conventions: `gen_random_uuid()` PKs, `citext` emails/slugs/SKUs, money as `Int` minor units, soft-delete via `deletedAt`, `pg_trgm` GIN + `search_text` triggers (defined in `rls.sql`, **not** in migrations — so `search_text` is null until `rls.sql` runs).

**Tenancy model:** every tenant table carries `organization_id`. The API's `withTenant(orgId, fn)` opens a Prisma interactive transaction, runs `SET LOCAL ROLE aligned_app` then `set_config('app.current_org_id', orgId, true)`. RLS policies are `(rls_bypassed() OR organization_id = current_org_id())`. Outside `withTenant` (audit, notifications, webhooks emit, all worker queries, all `withRlsBypass`) the connection runs as the **owner/superuser role, which bypasses RLS entirely** — so RLS only protects code paths inside the API's `withTenant`.

### 5.1 RLS is the system's #1 invariant and it is the most fragile thing in the repo

- **`rls.sql` is not idempotent (HIGH).** `rls.sql:229-235` drops policy `tenant_isolation` on `sessions` but creates `sessions_bypass_only`; there is no `DROP POLICY IF EXISTS sessions_bypass_only`, and Postgres `CREATE POLICY` has no `IF NOT EXISTS`. Any DB where the file ran once errors `42710` on every re-apply. Via `apply-rls.ts` (one `client.query(sql)` = one implicit transaction) this **rolls back the entire file** — so on a long-lived DB, every table added after the first successful apply may have **no policy**. In prod, `psql -f rls.sql || true` masks it: lines before 233 re-apply (why prod limps along) but the `organizations`/`users` policies after 233 never re-apply. Unchanged since the initial commit.
- **Fresh-DB bootstrap is broken (HIGH).** Migrations `20260427180000`, `20260507105400`, `20260507150000` call `_aligned_apply_tenant_rls()`, which is defined **only** in `rls.sql` (runs *after* `migrate deploy`). On an empty DB, `migrate deploy` fails at the 2026-04-27 migration. This breaks the e2e CI DB setup path, `pnpm db:reset`, and any from-scratch prod restore (RUNBOOK). Fail-closed, but un-bootable without manual intervention. (CI/e2e get away with it because `e2e.yml` creates the role and applies `rls.sql` separately.)
- **Three tenant tables missing from `rls.sql` (MEDIUM):** `bookings`, `bot_test_scenarios`, `bot_conversation_flow_options`. Their policies exist only inline in their creating migrations. `bot_test_scenarios`/`bot_conversation_flow_options` migrations do `ENABLE` **without `FORCE`** and aren't in the replay list → table-owner connections bypass them.
- **`leads` and `plans` are intentionally global (no RLS).** `aligned_app` has full DML on them (and on `_prisma_migrations`) via a blanket GRANT — an SQL-injection in any tenant transaction could read all leads (PII), rewrite plan caps/prices, or tamper migration history.

### 5.2 Plaintext secrets at rest (MEDIUM)

`WhatsAppChannel.accessToken` + `appSecret` (Meta system-user tokens = full messaging control of a tenant's number), `ApiConnector.authConfig` + `webhookSecret`, `WebhookEndpoint.signingSecret`, `User.totpSecret` — all plaintext columns. A DB dump or RLS bypass leaks live Meta tokens, client API creds, and 2FA seeds. Acknowledged tech debt, but the blast radius has grown well past the original "v1" scope.

### 5.3 Schema sharp edges

- **`whatsapp_messages` has no org FK** and **no index on `meta_message_id`** (MEDIUM) — every Meta `message_status` callback updates by wamid → seq-scan on the largest table; `BroadcastRecipient` got the right `(org, metaMessageId)` index but `WhatsAppMessage` didn't.
- **13 tenant tables have `organization_id` but no `organization` relation** (`WhatsAppMessage`, `CannedResponse`, `WhatsAppTemplate`, `KnowledgeBaseEntry`, `CrawlJob`/`Page`, `BotTest*`, `BotConversationFlowOption`, `BotSimulationTurn`, `UsageEvent`/`Monthly`, `MetaOnboardingStep`) → the aligned-admin hard-delete cascade **does not reach them**; org delete orphans message bodies + KB content forever (unreachable PII + bloat).
- **Bare-UUID cross-references with no FK:** `Broadcast.channelId`/`variantA/BTemplateId`/`csvAssetId`, `Sequence.channelId`, `SequenceStep.templateId`, `ImportJob.sourceAssetId`, `BrandingConfig.logoAssetId`, `WhatsAppMessage.mediaAssetId`. Deleting the referenced channel/template/asset leaves dangling refs that fail at send time.
- **`Product.embedding Float[]` (1536 dims, ~12 KB/row) with no pgvector** → top-K retrieval brute-forces cosine in Node, loading every product's embedding per bot turn.
- **`MessageProvenance.system_prompt_snapshot_id` is `ON DELETE RESTRICT`** while `organizations → system_prompt_snapshots` is `CASCADE` → an org delete can hit a FK violation and abort (the aligned-admin "delete org" path is real).
- **Status columns are free-text `String` (no enum/CHECK)** on `Cart`, `Booking`, `DataExport`, `WhatsAppTemplate`, `BrandingConfig.cnameStatus` — only Zod guards the value set.
- **Destructive data migrations:** `20260522220000_kb_route_to_canonical_homes` tags pre-existing operator-authored FAQs as `from_kb` and **deletes** them in step 3 (data loss for any operator FAQ whose question text matched a KB question, and for orgs whose `about` was already operator-authored).
- **`20260601120000` drift:** `sessions.previous_token_rotated_at` is `timestamptz(3)` in DB but `DateTime?` (no `@db.Timestamptz`) in schema → `prisma migrate dev` will report drift.

### 5.4 Seeds (`packages/db/seed/*`)

All seeds set `app.bypass_rls` **session-scoped on one pooled connection** (works only because the seed role is the superuser; flaky if roles tighten). `super-admin.ts` runs on **every deploy** and **force-overwrites the super-admin password** from `INITIAL_ADMIN_PASSWORD` (an in-app password change is silently reverted next deploy; <12-char passwords only warn) and forces the root org `status: 'active'` (un-suspends it). Demo creds: `admin@aligned.local` / `Aligned123!`. Pilot creds: shared `Pilot1234!` across all three pilot admins, printed to stdout.

---

## 6. The API surface (by module)

Server bootstrap: `apps/api/src/server.ts` registers ~36 route modules under `/api/v1`, six plugins (error-handler → metrics → healthcheck → auth → api-key → tenant-context), a custom JSON content-type parser that stashes `req.rawBody` (for HMAC), helmet/CSP, CORS, Redis-backed rate-limit, under-pressure, swagger at `/docs` (+ a broken `/docs/chatbot`).

**Guards:** `requireAuth` (JWT bearer or single-use SSE nonce), `requireRole('viewer'|'editor'|'admin')` (rank-based), `requireAlignedAdmin` (JWT `aa` claim), `app.tenant(req, fn)` = `requireAuth` + `withTenant`. **No server-side session/revocation check on the access-token path** — role/org/`isAlignedAdmin` claims are authoritative until the 15-min JWT expiry, so demotion/deactivation/org-suspension lag.

A recurring, codebase-wide problem: **there is no Prisma `P2025`/`P2002` mapping anywhere** (grep: zero matches). So "row not found on update" → 500 (not 404) and "duplicate" → 500 (not 409) across dozens of routes (duplicate SKU/slug, duplicate template, re-attach image, missing id on PATCH/DELETE, etc.).

Another recurring problem: **`emitWebhookEvent()` is the only read-cache invalidation path**, and many mutating routes skip it; many routes also call it *inside* the open tenant transaction (its own header says "after commit"), so a concurrent read can re-cache pre-commit data.

### 6.1 WhatsApp webhook + messaging — `whatsapp.routes.ts` (4,687 lines, the biggest file)

Two surfaces in one file. **Tenant routes** (`GET/PUT/DELETE /whatsapp`, `/verify`, `/test-send`, `/send`, `/send-media`, `/messages`, `/numbers*`) and the **public Meta webhook** (`GET`/`POST /whatsapp/webhook/:orgId`). The POST handler persists status receipts + contacts + threads + messages under `withRlsBypass`, then fire-and-forgets `storeInboundImage` and **`maybeReplyAsBot`** — the ~2,400-line bot pipeline (traced in §8).

Key findings:
- **No idempotency on inbound deliveries (HIGH).** `metaMessageId` has no unique constraint; the message create is unconditional. Meta redelivers on timeout/5xx → duplicate rows, double-counted `inboundCount`, and a possible second bot reply (the 2s Redis coalesce only catches near-simultaneous redeliveries).
- **Cross-tenant webhook replay possible when app secrets are shared (HIGH).** The HMAC signs only the body — not the `:orgId` URL, no timestamp/nonce. The file itself notes Meta's app secret is shared across all numbers under one app. A captured signed payload replays verifiably into any other tenant's webhook URL (forged inbound messages, possibly triggering that tenant's bot).
- **Bot/template sends bypass the rate limiter AND billing caps (MEDIUM).** A comment claims the bot "sends through the existing token-bucket" — false. No `consumeSendToken`, no `capCheck`, no `bumpUsage` for any bot-sent text/voice/image, or for `/whatsapp/test-send`. The bot generates the overwhelming majority of outbound volume → monthly caps dramatically under-count.
- **Escalation is silently undone (MEDIUM).** Every inbound unconditionally sets thread `status: 'open'`, flipping `escalated`/`pending` back to `open` *before* `maybeReplyAsBot`'s `status === 'escalated'` skip-check runs → bot escalates, customer says "ok thanks", thread reopens, bot resumes. Only thread *assignment* durably mutes the bot.
- **`search_text` rolling blob is wiped on every inbound (MEDIUM)** — set to `''` then the "append" SQL appends only the latest message → thread search only ever finds the most recent message.
- **Multi-number is half-wired (MEDIUM):** transcription, image storage, and all bot replies use the **primary** channel even for inbound on a secondary number.
- **STOP/opt-out only affects broadcasts (MEDIUM)** — the bot still converses with opted-out customers, including replying conversationally to the "STOP" message itself.
- **"New conversation" notification is dead code** (`inboundCount === 0` never true after upsert).
- **Broadcast delivered/read counters double-increment** on duplicate Meta status events.
- Lows: typing-indicator fetch has no timeout (can hang a socket); fast-path/handoff persist + escalate without checking Meta's response `ok`; `[PAYMENT_LINK]` can leak verbatim when MyFatoorah is configured-but-failing; plaintext tokens; PII in logs; Graph version `v20.0` hardcoded ~12×; the "we do NOT auto-respond" comment is stale.

### 6.2 Bot builder routes — `bot.routes.ts` (2,130 lines) + fastpath/intent/link-rules

~35 routes under `/bot/*`: config CRUD, website-crawl lifecycle, crawl-draft review, KB CRUD, factory reset, questionnaire, simulator, LLM-judged scenarios, conversation-flow candidates, voice diagnostics, deploy/undeploy. Findings:
- **Per-row listing approve/deny ignores the crawl-job param and the draft check (MEDIUM).** `POST /bot/analyze/<anyUuid>/listings/<productId>/deny` soft-deletes **any** product in the org (including published, manually-created ones) at editor level, unaudited, no webhook. Contradicts its own "namespaced under the crawl" comment.
- **`PUT /bot/config` cannot null `personality`/`escalationRules`/`conversationFlow`/`responseTemplates`** (`?? undefined` collapses explicit `null` to "skip"), despite the schema advertising nullable. Factory-reset's raw-SQL workaround proves the team hit this.
- **`POST /bot/analyze` has no SSRF guard at this layer and no concurrent-crawl cap** (the worker must block private IPs — and it only partially does; §7.1).
- **Arabic handoff regex over-fires (MEDIUM):** matches standalone `موظف`/`انسان`/`توقف`; the negative-signal guard is English-only → innocent Arabic messages can falsely escalate live.
- `/bot/scenarios/run` executes up to ~20 serial LLM calls inside one HTTP request (multi-minute, no lock, no idempotency); factory-reset deletes the *selected* flow and does **not** clear `deployedAt` (a deployed bot keeps answering with an empty brain); deploy is a pure flag flip with no readiness gating; **all 11 audit writes use `action: 'business_info_updated'`**; undeploy is unaudited; crawl-review mutations emit no webhook/cache-invalidation.

### 6.3 Auth — `auth.service.ts` (919 lines) + routes + 2FA + account

Solid in shape: bcrypt-12, account lockout (5 fails/15 min), refresh-token rotation with reuse detection (60s grace window for concurrent-tab refresh), email-verify/reset with hashed tokens, RFC-6238 TOTP from scratch, self-serve data export + soft-delete-account with last-admin guard + advisory locks. Findings:
- **Recovery-code match comment claims "constant-time" but uses `indexOf`** (negligible impact — values are sha256 hashes).
- **`verifyRefreshToken` is dead code** — refresh tokens are validated purely by DB hash lookup; the JWT signature/exp is never checked at runtime.
- **Grace-window refresh ignores session `expiresAt`** (only checks `!revokedAt`).
- **TOTP codes can be replayed within their ±1-step (~90s) window** (no used-counter); **no per-user TOTP brute-force lockout** on `/2fa/disable|enable|regenerate` (a stolen bearer token can brute-force the disable password without tripping `failedLoginAttempts`).
- **All 2FA events audit as `password_changed`.**
- **Rate-limit keyGenerators that read `req.body`/`req.auth` silently degrade to per-IP** because `@fastify/rate-limit` runs at the `onRequest` hook before body parse / `requireAuth` populate those: forgot-password's "per-email" cap, `/account/export`'s "per-user" cap, org-export, data-export, multipart-upload — all are actually per-IP.
- `COOKIE_SECURE` defaults `false`; `generateTempPassword` has a `Math.random()` fallback pad; recovery-code generation has modulo bias; `switchOrganization` drops the impersonation flag; DELETE /account leaves the user's issued API keys live.

### 6.4 Catalog — `product/service/business-info/category.routes.ts`

The CRUD heart. Findings:
- **HIGH — many mutations never invalidate the read cache / emit webhooks** (variants, images, bulk-update, bulk-delete, pricing-tiers, availability, all location/contact CRUD, FAQ delete, FAQ reorder, policy delete, **all** category routes). The bot serves deleted FAQs and stale variant/tier prices and bulk-"unavailable" products for up to the cache TTL.
- **HIGH — bulk-delete doesn't tombstone-rename `sku`/`slug`** (single-delete does), but create's dupe check only filters `deletedAt: null` → re-creating/CSV-re-importing any bulk-deleted SKU/slug 500s on the DB unique constraint. (A primary "delete all then re-import" workflow hits this.)
- **MEDIUM — `capCheck` is missing on `POST /services`** (products enforce it; services don't, though `serviceCap` exists) → service plan caps unenforced.
- **MEDIUM — pricing-tier `currency` is client-settable** while products/services lock currency to the org → mixed-currency catalog the bot then quotes.
- **MEDIUM — changing `BusinessInfo.currency` doesn't cascade** to existing products/services/tiers (the "single source of truth" only holds at create time).
- **MEDIUM — replace-set updates child rows by bare PK** (`productVariant.update({where:{id}})`, tier likewise) — not scoped to parent → within an org an editor can overwrite another product's variant/tier.
- **MEDIUM — `parentId`/`categoryId` written as raw scalars with no in-org existence check** → cross-tenant FK injection (the FK check bypasses RLS); category PATCH only blocks direct self-parenting, so A→B→A cycles infinite-loop tree walkers.
- **MEDIUM — `recordRevision` snapshots the full 1536-float embedding** into `catalog_revisions` JSONB (unbounded bloat); restore writes a stale embedding back and **cannot restore variants/images/tiers** (scalar-only) despite the UI implying full restore.
- Slugs from non-Latin (Arabic) names slugify to `''`; reorder endpoints run concurrent queries on one interactive-tx connection (Prisma-unsupported); soft-deleted entities still fetchable by id; many `deleteMany`-by-id return `{ok:true}` with no 404 and write phantom audit rows.

### 6.5 Read API + integrations — `read.routes.ts`, `read-cache.ts`, api-keys, webhooks, revisions, imports

- **Read API pagination is advertised but unimplemented (MEDIUM):** `cursor` accepted and ignored, `nextCursor` hardcoded `null`, hard ceiling of 100 rows (50 for search). Tenants with >100 products cannot expose their full catalog to bots.
- **Stale-while-revalidate is documented but never serves stale (LOW):** entries >60s are recomputed synchronously; the 300s retention only powers the `x-cache: STALE` label; no stale fallback on loader failure (→ 500); no dogpile protection.
- **`ApiKey.keyHash` has no index** despite the plugin comment "indexed unique lookup" — every read-API request seq-scans `api_keys`. Combined with the read-path rate limiter keying on the **raw `x-aligned-api-key` header value**, an attacker sending a unique random header per request gets a fresh bucket every time (rate limit never trips) while each request costs a sha256 + table scan before the 401. (The raw secret is also reproduced into Redis keyspace — weakens the at-rest hashing model.)
- **Manual webhook-delivery retry gets exactly one attempt then strands the row in `pending` forever (MEDIUM):** the retry enqueue omits `attempts`/`backoff` (BullMQ default 1) while the worker's retry mechanism is "set to pending + throw" — so the first transient failure dead-ends the job.
- **Import row fix-and-retry never invalidates cache or emits a webhook (MEDIUM).**
- **Import upsert update-path clobbers omitted fields (MEDIUM):** a minimal `sku+name` re-import NULLs price/description/stock, forces `isAvailable: true` (re-enables hidden products), resets currency to USD, detaches category, resurrects soft-deleted rows. **FAQ import is `create` (no dedupe)** → re-running duplicates every FAQ.
- **`recordRevision` version-number race silently drops revisions (MEDIUM):** read-then-insert at READ COMMITTED, P2002 swallowed; the docstring claims the opposite.
- Import templates ship a realistic sample data row with no skip marker (uploading the unedited template imports "Premium Widget" into the live catalog the bot quotes); `boolish` rejects title-case `True`/`False` (common Excel export); `DELETE /imports/:id` comment says it cancels the running worker first — it doesn't (orphans the worker).

### 6.6 CRM — broadcasts/contacts/segments/sequences

- **`PATCH /broadcasts/:id` skips every referential validation `POST` does** and **silently drops half the accepted body** (tags, send-window, A/B winner strategy are immutable; combined with the no-FK `channelId`/templateId, an editor can point a draft at a nonexistent/another-org template; only `/resend` re-checks variant A).
- **`skipDuplicates: true` on `broadcastRecipient.createMany` is a no-op** — there's no unique on `(broadcast_id, phone_e164)`; `/resend` copies source rows verbatim, so accumulated duplicates re-send.
- **A/B variant assignment is an unsalted hash of the phone** → a given customer is permanently variant A (or B) across every campaign, biasing every test.
- **Deleting a segment makes draft broadcasts silently send to nobody** (`segmentId` → `SetNull`, the materialization block is skipped, broadcast goes to `sending` with `totalRecipients: 0`).
- **`segmentFilterSchema.parse()` (strict) on DB JSON** → one drifted segment 500s the whole list + previews + send (broadcasts use `safeParse` for variable maps but segments/sequences didn't copy the guard).
- **CSV contact import: per-row try/catch inside one open transaction poisons the batch** (one bad row can void up to 499 neighbors while the response reports them imported); phone normalization has no country-code awareness; `source: 'csv'` overwrites prior provenance.
- **Sequences:** step-0 `delayHours` is ignored (enroll sets `dueAt: now`); replace-set steps under active enrollments corrupt journeys (indices shift); audit mislabels sequence-create as `broadcast_created`; PATCH/DELETE/enroll/cancel are unaudited; cancelled enrollees can never re-enroll.
- `PATCH /contacts` tag replace-set doesn't mirror to inbox threads (desyncs the "tags in both" feature); re-creating a soft-deleted contact silently wipes its attributes.

### 6.7 Commerce — dashboard/billing/carts/bookings

- **Billing — see §6.8.**
- **`GET /billing/subscription` masks the real plan as "Unlimited (admin)" for any org containing an active ALIGNED-admin member** — if ALIGNED staff join a paying client's org for support, the client's own admins see a fake plan and lose cap enforcement.
- Carts: min-order error message hardcodes `/1000` 3-decimal formatting (USD/EUR off by 10×) while the notification uses correct per-currency logic; free-delivery threshold only applied at create (item add/remove keep frozen delivery); cart/booking **deletions emit no webhook**; line-item edits/deletes leave no audit/webhook.
- **MyFatoorah payment links have no confirmation callback.** `lib/myfatoorah.ts` mints a `SendPayment` link (or fails soft to canned copy), but there is **no MyFatoorah webhook/callback handler anywhere** — the cart is promoted on *send of the link*, not on actual payment. "Paid" status is never reconciled; the platform has no record of whether a payment-link order was actually paid.
- Bookings: appointment-"moved" detection is a fragile ISO-string compare (`toISOString()` ms-precision vs Zod second-precision) → can re-arm a sent reminder and **double-send a WhatsApp reminder**; audit + webhook fire **inside** the tenant tx (carts does it correctly after); "template not approved" returns 404 (should be 400/422).
- Dashboard widgets are real-data, but several heuristics are honest-in-comments-but-misleading: `avgFirstResponseSeconds` is a median that includes bot replies (≈0 for bot orgs); bot-performance escalation/denominator over/under-counts; resolution-rate counts any open-unassigned thread the bot ever touched as "resolved"; connections widget marks the org "failing" for any inactive endpoint.

### 6.8 Billing webhook — the critical bug

`POST /api/v1/webhooks/stripe` (`billing.routes.ts:355-400`): the route comment claims it disables Fastify's JSON parser and uses the raw body. **Neither happens.** `config: { rawBody: true }` is inert (no fastify-raw-body plugin); the global JSON parser still runs and (correctly) stashes the true bytes at `req.rawBody`. But the handler then does `const raw = JSON.stringify(req.body ?? {})` (line 381) and feeds *that* to `stripe.webhooks.constructEvent`. Stripe signs the exact pretty-printed bytes it POSTs; a compact Node re-serialization can never byte-match → **every genuine Stripe event throws "invalid signature" → 400**. Consequences: after Checkout, the subscription row never flips to `active`/links Stripe IDs; `invoice.payment_failed` never sets `past_due` (so dunning never fires off Stripe); cancellations never mirror. The fix is one line (`(req as any).rawBody ?? JSON.stringify(req.body ?? {})`) — and `whatsapp.routes.ts:1781` already does exactly that. Compounding: the handler has **no idempotency/ordering guard** (a delayed `updated` after `deleted` resurrects a cancelled sub) and `customer.subscription.deleted` uses `update` (throws P2025 if absent → 500 → Stripe retries forever).

### 6.9 Org/members/audit/notifications/status/data-export/storage/connectors

- **Inbound connector webhook HMAC verifies a re-serialized body, not the raw bytes (HIGH):** `inbound-webhook.routes.ts:78` recomputes `JSON.stringify(req.body)` and HMACs that, ignoring `req.rawBody`. Any third-party sender whose JSON serialization differs (whitespace, key order, number/unicode formatting) signs different bytes → 401 for legitimate traffic. The in-repo tests pass only because they sign `JSON.stringify(sameObject)`.
- **Audit-log pagination drops the date filter after page 1 (MEDIUM):** the `where` spreads two `createdAt` keys; the cursor key overwrites the from/to range → date-filtered "Load older" pages into arbitrarily old events. (Manifests on both the tenant and the aligned-admin audit pages.)
- Multipart CSV upload buffers the whole 50 MB file in memory despite the "streaming" header; orphan Asset row if the S3 PUT fails; data-export download URL is actually 1h-valid while the API reports 15 min; member-deactivation session revocation is non-atomic.

### 6.10 Admin / SaaS / leads

- **Cross-tenant custom-domain claim/takeover (HIGH):** `BrandingConfig.customCname` has no uniqueness constraint and PUT /branding never checks if another org claimed the domain. CNAME "verification" only proves the domain CNAMEs to the *shared* `CUSTOM_CNAME_TARGET` (no per-org TXT proof) → any tenant admin can enter another tenant's live custom domain, click Verify (it passes), and get a second `verified` row; `/caddy/ask` resolves it with `findFirst` (arbitrary winner). Also: PUT stores `customCname` un-lowercased while `/caddy/ask` does a case-sensitive match → a mixed-case domain verifies but Caddy can never issue its cert.
- **Impersonation audits as `business_info_updated`** (no impersonation enum member) → a security-critical event is indistinguishable from a catalog edit.
- **Org hard-delete is unaudited, has no interlock, and cascades away the org's own audit history.**
- `GET /analytics` loads every WhatsApp message in the window + O(messages × catalog) synchronous token-matching inside one tenant transaction (viewer-triggered P2028/event-loop-stall risk on busy orgs); fake cursor pagination on orgs/leads (always `nextCursor: null` → only 25 orgs visible in the admin table and tenant dropdowns); `drain-failed` claims to fix orphan repeatables but only clears the failed-job backlog; public lead capture has no dedupe/CAPTCHA.

### 6.11 Core libs & plugins (`A11`)

- **CF-Connecting-IP spoofing (HIGH):** when `TRUST_CF_CONNECTING_IP=true`, an `onRequest` hook overrides `req.ip` from the `CF-Connecting-IP` header of **any** client without checking the socket peer is in Cloudflare's ranges (which `trust-proxy.ts` carefully enumerates but this path never consults) → arbitrary per-request `req.ip` (rate-limit-key rotation, poisoned audit/lockout IPs) for anyone reaching the origin directly.
- **`/docs/chatbot` swagger is a no-op** (encapsulated child scope registered before the routes; the `onRoute` hook can't see parent routes; no tag filter exists) → empty spec, contradicting `CLAUDE.md` 3.17.
- **The rate limiter shares the global ioredis client with `maxRetriesPerRequest: null`** → during a Redis outage commands buffer indefinitely instead of erroring, so `skipOnError: true` never fires and Redis becomes a hard availability dependency for all traffic (opposite of the configured fail-open).
- **HTML injection in all email templates** (`firstName`/`organizationName`/`orgName`/`inviterName` interpolated unescaped; the invitation flow delivers attacker HTML to arbitrary victim addresses from the legit sending domain).
- **MyFatoorah phone parsing is greedy** (`/^\+(\d{1,4})/` always grabs 4 digits) → wrong country code + truncated mobile for essentially every real number → invoices fail or carry wrong contact data.
- **`capCheck` counts have no explicit org filter** and are correct only when passed a `withTenant` tx; the structural type also accepts raw prisma (`webhookEndpoint.count()` has no `where` at all).
- **Error handler leaks stack traces when `NODE_ENV !== 'production'`** (env.ts defaults to `development`; uses raw `process.env` not the validated `env`) — a prod box that forgets to set `NODE_ENV` leaks internals to every client. `/metrics` is unauthenticated and 404s mint unbounded prom label series. `MYFATOORAH_BASE_URL` defaults to the **sandbox** (prod foot-gun).

---

## 7. The chatbot engine internals (`A03`)

`bot-engine.ts` (1,306 lines) + `openai.ts` (621) + `embedding.ts` + `contact-memory.ts` + `cart-parser.ts`.

### 7.1 KB retrieval & packing
- **HIGH — catalog silently capped at 30 with no `orderBy`** (`gatherBotData`): for >30 products the bot sees a non-deterministic Postgres-default subset; products 31+ effectively don't exist; the bot is hard-instructed to say un-listed items "aren't in the catalog."
- **Top-K embedding packing contradicts its own comment:** comments claim unembedded products are "always included as filler"; the code `[...ranked, ...unembedded].slice(0, 10)` drops every unembedded product once ≥10 embedded ones exist (newly-created products vanish until the backfill runs).
- The embedding ranker + pinned-SKU recovery operate only on the ≤30-row window, so even a customer's own past-order SKU can be unrecoverable.

### 7.2 Provider routing & budget (`openai.ts`)
- Plans: basic = Groq Llama-3.3-70B (+gpt-4o-mini fallback on 429/5xx); middle = gpt-4o (**no fallback** — an OpenAI outage takes middle-plan bots fully down); max/ultra = Anthropic Sonnet (degrade to basic on any error). **Missing `GROQ_API_KEY` disables basic-tier chat entirely** even with a valid OpenAI key (the NO_KEY error isn't "retryable").
- **`completeJson` (booking/cart extractor fallback) is always Groq with no fallback** → during Groq rate-limit windows the safety nets silently die exactly when the primary reply is also degraded; bookings/orders whose markers were dropped are lost with no log.
- **Per-org daily token budget (200k) is estimate-only and never reconciled** (charges char/4 input + full `maxTokens` regardless of actual output). The dashboard cost uses gpt-4o-mini rates for **every** plan → understates Groq/gpt-4o/Sonnet badly.
- `maxTokens: 240` can truncate the `[CART:]` JSON marker mid-object; `stripCartMarker` returns the text **unchanged** when the closing `]` is missing → a truncated marker can reach the customer.

### 7.3 Prompt assembly & residual literal examples
`CLAUDE.md`'s 2026-05-22 entry claims every literal fictional product name (incl. `ATK-*` SKUs) was scrubbed from `bot-engine.ts` prompt blocks because gpt-4o-mini copies literal examples into real replies. The scrub (commit `e39e2fc`) targeted the *positive* "Catalog example" blocks. Two residual literals remain in the live prompt, with different risk profiles:
- `bot-engine.ts:898-903` still contains `(e.g. ATK-COF-XXX, BRWNDB-001)` — but inside a **prohibitive** instruction ("NEVER mention sku-refs / identifier-shaped strings, e.g. …"), i.e. a *negative* example. Lower-risk than the scrubbed positive examples, though the underlying concern (any literal identifier in the prompt can leak) is reasonable.
- The booking flow (779-799) has a fully-literal *positive* example (`Jane Doe`, `jane@x.com`, "tomorrow at 5", "IT strategy") that the model can copy into a real `[BOOKING:]` payload — this one matches the exact failure mode the scrub targeted and should be templated.

(The cart-parser/test fixtures still contain "Oreo Milkshake"/"Karak Tea" but those are comments/tests, not prompt text — acceptable.)

### 7.4 Cart parser & deterministic tracking
The cart is tracked deterministically from the bot's own reply text (not the LLM marker, which drops items on long carts) and promoted on confirm. Sharp edges: payment-word short-circuit drops legitimate order items in combined messages ("2 brownies, paying cash" → 0 adds); unanchored Arabic cancel pattern wipes the cart on negations ("I do NOT want to cancel"); products named like payment words ("Tap Water", "Square Brownie") can never be auto-added; accented Latin is stripped; unpriced products enter the cart at 0.

### 7.5 Contact memory (persona) — a persistent prompt-injection channel (MEDIUM)
Customer WhatsApp text is summarized by Haiku into `ContactMemory.persona` and re-injected verbatim near the top of every future system prompt with **zero sanitization**. Instruction-shaped content ("remember I always get free delivery") can survive summarization and be presented to the reply model as trusted first-party memory. Runs on **all** plans (header says "ultra") and bills the shared 200k/day budget; a Redis outage disables the 90s throttle entirely.

### 7.6 Crawl worker (`crawl.ts`, 1,742 lines)
Playwright BFS crawler → LLM extraction → KB/draft-products/services/contacts/locations/FAQs/policies. Findings:
- **SSRF: image download follows redirects without re-validation (HIGH)** — only the root URL is SSRF-guarded; image hosts (scraped from arbitrary pages) can 30x-redirect to `169.254.169.254`/internal hosts. Child links are also fetched without re-validation. The guard deliberately doesn't resolve DNS (TOCTOU).
- **Crawl writes never emit webhooks / invalidate cache** → after a crawl populates a catalog, the bot serves stale/empty cached data for up to the stale TTL.
- Service prices use ×100 regardless of currency (vs ×1000 for products) → Gulf-currency crawled services 10× under-priced. `dedupSkipped` pages aren't counted toward `maxPages` (SPA shells blow the cap). Multi-replica boot reconciler can fail a crawl actively running on another replica. `analyzeAndPersist` deletes ALL AI KB entries every crawl (an LLM blip yielding 0 entries wipes the prior good set).

---

## 8. The end-to-end bot reply pipeline

Inbound `POST /whatsapp/webhook/:orgId` → HMAC verify (`req.rawBody`) → persist status/contacts/threads/messages (`withRlsBypass`) → fire-and-forget `storeInboundImage` + `maybeReplyAsBot`. Inside `maybeReplyAsBot` (whatsapp.routes.ts:2258-4687):

1. **Gates that can silently disable the bot:** `isOpenAIConfigured()`; `botConfig.deployedAt` set; thread exists; **thread not assigned**; **thread not `escalated`** (largely defeated — the persist already flipped it to `open`, §6.1); primary channel active+credentialed; transcript present (voice with failed transcript → silently skip).
2. **2s mandatory coalesce sleep** (Redis token) on every reply.
3. Parallel voice transcription (Groq/OpenAI by Arabic-codepoint heuristic) + ctx gather.
4. Typing indicator (no timeout). Handoff-confirm short-circuit. **Fast-path** (`bot-fastpath.ts` — deterministic hours/location/contact/handoff regex, EN/AR) vs full engine.
5. Cart pre-bookkeeping; persona + recent-order memory (Ultra); Ultra intent classification.
6. **LLM call** (`buildBotResponse`) → reply validators (`reply-validators.ts`, Phase 9) → MyFatoorah `[PAYMENT_LINK]` swap → stateful cart parse → marker extraction (`[IMAGE:]`/`[HANDOFF]`/`[BOOKING:]`/`[CART:]`/`[CLEAR_CART]`) → image-gallery sends (Meta media-id cache) → TTS voice (Google/ElevenLabs → ffmpeg → Meta).
7. Text send to Meta (`!res.ok → continue`, abandoning the floating image promise).
8. **Persist + side effects** (`withRlsBypass`): outbound message, thread bump (+escalate if `[HANDOFF]`), booking creation (30-min dedupe), cart promotion (draft is source of truth), webhook emissions, notification, and finally **`recordProvenance` (awaited)**.

### 8.1 Reply validators (Phase 9)
Deterministic post-LLM pipeline strips bad image markers / voice-capability apologies / false handoffs, rewrites subunit prices, injects cart totals, neutralizes fake bookings, strips SKUs/em-dashes, dedups welcomes. Real bugs: **`stripEmDashes` corrupts ranges** ("Mon–Fri" → "Mon, Fri", "9 AM – 11 PM" → "9 AM, 11 PM") — exactly the operating-hours replies a bot sends constantly; **`dedupWelcomeText` replaces the entire reply** with hardcoded English on containment-anywhere (destroying a co-present answer); **`validateBookingFidelity` is English-only despite its "multi-language" comment** and nukes the whole reply, so Arabic fake confirmations ("تم تأكيد حجزك") sail through — the exact bug class it exists to stop, in the primary market language. Detection is multi-language but **all injection/replacement text is hardcoded English** → jarring mid-Arabic-conversation switches at the highest-stakes moments (totals, bookings).

### 8.2 Provenance scanner (Phase 8/1.2)
Pure-CPU pass producing `citations[]` + `hallucinations[]`. Findings: **hallucination detection is effectively English/Latin-only** (Arabic product names adjacent to prices can never be flagged — and the platform is Arabic-first); a **coordinate-space bug** passes a normalized-string offset into a function that slices the original reply (drifts price extraction onto the wrong line); the declared `unknown_business_info` hallucination type is **never emitted** (invented opening hours are recorded as a *citation*, never flagged); services have no price-drift check; `price_drift` is only `warning` severity while invented product names are `critical`.

### 8.6 The provenance production "bug" — RESOLVED; `CLAUDE.md` is stale

`CLAUDE.md` records an *open* prod incident (commit `335bbea`): "no provenance rows being written despite the code path looking correct." **A git-history trace shows this was fixed in the same session and the status note was never updated.** The timeline:
- **`335bbea` (2026-05-22 11:42)** — diagnostic. Body: *"Production audit shows 168 text/audio bot replies have no provenance row. Logs show neither the success nor the failure path firing — the gate must be evaluating false silently."* The diff changed **`void recordProvenance(...)` → `await recordProvenance(...)`** and moved the dynamic `import()` inside the try/catch.
- **`66530a8` (2026-05-22 12:19, 37 min later)** — body's last line downgrades the gate log to fire *only on failure*: *"The happy path no longer floods the log on every bot reply."* You only do that once you've **seen the happy path firing**.

**Root cause (confirmed): a fire-and-forget bug.** The bot is double-detached (`void (async()=>maybeReplyAsBot())()` at the webhook + the OLD `void recordProvenance()` inside it), and in the OLD code the `import('../../lib/provenance.js')` sat **outside** the recorder's internal try/catch. The floated promise's rejection surfaced as an `unhandledRejection` the process swallowed — so **neither** the success nor the WARN path logged (exactly the symptom). `await` forced the import + all three DB writes to complete inside the live `try`. The `CLAUDE.md` "Current Status" was written at the `335bbea` snapshot, before `66530a8` confirmed the fix; 115 commits separate it from HEAD with the gate logic unchanged. **Conclusion: the headline mystery is fixed; the doc is stale.**

**Two latent risks remain (OPEN), both swallowed as WARN with no metric/Sentry — invisible except by absence of rows:**
- **#2 — provenance is gated behind a throwing transaction.** The recorder runs *after* the persist tx (which creates the bot message, booking, cart promotion, and `emitWebhookEvent` calls inside it). If that tx throws anywhere after `botMessageId` is set, it rolls back (losing the bot message itself) and control jumps to the outer `catch` — so provenance is never reached for that reply.
- **#3 — racy snapshot "upsert".** `upsertSystemPromptSnapshot` is a non-atomic findUnique-then-create. Two concurrent replies sharing the same new system-prompt body both miss, both create; the loser's P2002 bubbles into the recorder's catch-all and **drops the entire provenance row** (citations, hallucinations, tokens — everything). The docblock falsely claims "concurrent inserts no-op safely." Fix: `prisma.upsert` or P2002-catch-and-refetch.

**By design, not a bug:** fast-path / handoff / noisy / empty-reply / text-send-failure replies have no `result.inputs` or `botMessageId` and **structurally never get provenance** — this understates coverage and should be documented (those reply classes look like "missing rows" but never could have had one). Test-run paths (`/bot/simulate`, `/bot/scenarios/run`) also never call `recordProvenance` — **provenance is exclusively a production-path artifact**.

---

## 9. The worker (`apps/worker`)

`index.ts` boots **7 BullMQ workers** (import, sync, webhook-delivery, crawl, data-export, broadcast-fanout, broadcast-send) + **7 ticks** (`setTimeout`/`setInterval`: sequence 30s, booking-reminder 60s, provenance-digest 24h, dunning 1h, draft-cart-ttl 1h, inbox-consistency 15min, uptime-probe 60s) + a Prometheus server on :9100. Critical findings:

- **HIGH — production worker Docker image cannot start** (`CMD node dist/index.js`, no build, no tsx) — moot in prod (systemd+tsx) but the Docker path is broken if resurrected, and `embedding-backfill.yml` targets it.
- **HIGH — worker `withTenant` has no RLS** (§5).
- **HIGH — Playwright has no Chromium in the (dead) image** on alpine.
- **MEDIUM — provenance-digest lock TTL (26h) > interval (24h)** → roughly half of all flagged-reply days are silently omitted (the lock self-blocks the next run; the run after looks back only 24h, leaving a permanent gap).
- **MEDIUM — broadcast-fanout CSV materialization isn't restart-safe** (only runs when `existing === 0`; a crash mid-batch leaves a partial send with `totalRecipients: 0`); the "streaming" CSV is fully buffered in memory.
- **MEDIUM — FAQ import/sync isn't idempotent** (`shared-upsert.ts` uses `create`) — every run duplicates FAQs (contradicts the sync header comment).
- **MEDIUM — sequence-tick retries failing sends forever** (comment promises a 3-strikes cancel that doesn't exist), has **no token bucket** (broadcasts do), and its lock TTL (~35s) can expire mid-tick (200 enrollments × 15s Meta timeout) → concurrent ticks + double-sends.
- **MEDIUM — uptime-probe default `http://127.0.0.1:4000/health` is unreachable** in multi-container prod (and `UPTIME_PROBE_URL` is wired nowhere) → the admin uptime chart reads perpetual downtime unless an operator sets the env.
- **MEDIUM — webhook-delivery give-up can be pre-empted by BullMQ's own retry count** (DB `attempts` vs `WEBHOOK_MAX_ATTEMPTS` are unlinked from the producer's BullMQ `attempts`).
- **MEDIUM — dunning grace clock relies on `subscription.updatedAt`** → any Stripe-retry write resets the 7-day clock, so a perpetually-failing sub may never auto-suspend (and the Stripe webhook is broken anyway — §6.8).
- `data-export` uses synchronous `gzipSync` (blocks the loop) and an unbounded in-memory bundle; `draft-cart-ttl` imports a second Prisma client; broadcast-send A/B winner only uses read-rate regardless of the configured strategy and runs a discarded `groupBy`; broadcast token consumed before opt-out/window checks (waste).
- **Scheduled connector syncs can silently die forever (MEDIUM).** The only repeatable-job path (BullMQ `repeat:` on `sync`) is registered **only** by the API on connector create/update — there is **no boot-time reconciliation** from `apiConnector.scheduleCron`. Prod Redis runs `--maxmemory-policy allkeys-lru` (the same Redis that backs BullMQ — which BullMQ docs forbid: it should be `noeviction`), so under memory pressure the repeat meta keys are LRU-evictable → every scheduled sync stops with no recovery path short of re-saving each connector. A DB restore that drifts `scheduleCron` from Redis can also leave an orphan repeatable firing forever (the `removeRepeatable` mismatch is swallowed). Two ticks (`draft-cart-ttl`, `inbox-consistency`) + `uptime-probe` run with **no distributed lock**, so they double-execute on 2 replicas.

---

## 10. Tests & CI — what is actually verified

- **`apps/api/test`** (Vitest, real Fastify + real Postgres/Redis, `fileParallelism: false`): auth (signup/login/refresh/reuse), **tenant-isolation (the hard gate)**, products smoke, read-API auth, whatsapp channel + webhook signature, account export/delete + last-admin, broadcasts lifecycle (stops at the queue), imports column-mapping, reply-validators (unit), provenance-scanner (unit), tts-normalizer (unit), segment-evaluator (unit), 2FA recovery, audit-chain tamper-evidence.
- **The tenant-isolation gate does direct-RLS Postgres probes on only `contacts` + `api_connectors`** — everything else relies on route-level 404s. Its title claims "broadcasts" isolation but no broadcast is exercised.
- **`setup.ts` runs `TRUNCATE … users, organizations … CASCADE` against whatever `DATABASE_URL` is in the shell, with NO environment guard (HIGH)** — one `pnpm --filter @aligned/api test` with a prod URL exported wipes the platform. The truncate list is frozen at Day-4 scope; everything since is wiped only via FK CASCADE (tables without an FK chain silently leak across tests).
- **`tsconfig` excludes `test/`** → the 18 test files are never type-checked.
- **Coverage gaps vs shipped features:** no integration tests for import/broadcast/sequence/dunning workers, Stripe billing, read-cache headers, per-key rate limit, version restore, outbound webhook delivery/backoff, TOTP verify, connector timestamp-skew. `provenance-access` covers only denial (no 200 happy path → a 500-regression for admins passes the gate).
- **CI wiring (`ci.yml`, `e2e.yml`):** `lint`/`typecheck`/`test` are all `continue-on-error`. The blocking gates are 4 focused vitest files (tenant-isolation, provenance-access, webhook-signature, read-api) + e2e tenant-isolation. **`ci.yml` never applies `rls.sql` and never creates the `aligned_app` role** (e2e.yml does both) — so the "hard" tenant-isolation gate in CI runs against a DB whose RLS state differs from prod. **Neither workflow gates the deploy** — `deploy.yml` doesn't `needs:` CI; both fire independently on push to `main`.

---

## 11. Security posture (consolidated)

**Good:** in-house JWT with `HS256` pinned + issuer/audience; RLS-as-backstop design with a non-superuser `aligned_app` role and per-tx `SET LOCAL`; HMAC + timing-safe compare on the Meta webhook over `rawBody`; refresh-token rotation + reuse detection; bcrypt-12; httpOnly+SameSite=Lax refresh cookie scoped to `/api/v1/auth`; API keys sha256-at-rest, shown once; pino redaction of auth headers/cookies/secrets; per-request nonce CSP (`middleware.ts`); SSRF guard (`util-url-guard.ts`) on connector probes/sync + crawl root.

**Findings register (by severity):**

| Sev | Finding | Where |
|---|---|---|
| HIGH | RLS not idempotent → re-apply fails; tables left unprotected on long-lived DBs | `rls.sql:233` |
| HIGH | Fresh-DB `migrate deploy` can't complete (`_aligned_apply_tenant_rls` undefined) | migrations 0427/0507 |
| HIGH | Prod RLS apply failure swallowed (`|| true`) | `deploy.yml:275`, `deploy-remote.sh:200` |
| HIGH | Worker `withTenant` has no `SET ROLE` → no RLS in any worker | `apps/worker/src/jobs/db.ts:14` |
| HIGH | Stripe webhook verifies re-serialized body → all events 400 → billing dead | `billing.routes.ts:381` |
| HIGH | Inbound connector webhook HMAC over re-serialized body → 401s legit senders | `inbound-webhook.routes.ts:78` |
| HIGH | CF-Connecting-IP spoofing (no peer-range check) | `server.ts:132` |
| HIGH | Cross-tenant custom-domain claim/takeover (no uniqueness, no per-org DNS proof) | `saas.routes.ts` |
| HIGH | SSRF: crawl image download follows redirects without re-validation | `crawl.ts:1599` |
| HIGH | Webhook tenant-replay when Meta app secrets are shared | `whatsapp.routes.ts:1772` |
| HIGH | No idempotency on inbound WhatsApp deliveries (dup messages, dup bot replies) | `whatsapp.routes.ts:2156` |
| HIGH | `setup.ts` truncates whatever DB is in env, no guard | `apps/api/test/setup.ts:36` |
| MED | Plaintext secrets at rest (Meta tokens, connector creds, signing secrets, TOTP) | schema |
| MED | HTML injection in all email templates | `lib/email.ts` |
| MED | Persona memory is a persistent prompt-injection channel | `contact-memory.ts` |
| MED | Bot/template sends bypass billing caps + rate limiter | `whatsapp.routes.ts` |
| MED | Per-row crawl-listing deny soft-deletes any org product | `bot.routes.ts:1026` |
| MED | Per-org/per-user rate limits silently degrade to per-IP (hook ordering) | auth/account/export routes |
| MED | No P2025/P2002 mapping → 404/409 surface as 500 platform-wide | all route modules |
| MED | `/billing/subscription` masks real plan if ALIGNED staff is a member | `billing.routes.ts:162` |
| MED | Impersonation + org-delete audit mislabeling / unaudited org delete | `admin.routes.ts` |
| MED | Error handler leaks stack traces when `NODE_ENV !== 'production'` | `error-handler.ts:58` |
| MED | Read-path rate limit bypassable via unique random API-key headers | `server.ts:222`, `api-key.ts` |
| LOW+ | `/metrics`, `/docs`, status page unauthenticated; `COOKIE_SECURE` default false; no CSRF token on cookie-only `/auth/refresh`; TOTP replay window; modulo bias in recovery codes; PII echoed into GitHub Actions logs (`deploy.yml`, `logs.yml`); `.env.production` not gitignored | various |

`docs/SECURITY-AUDIT-2026-05-26.md` lists 21 findings (3 critical, 5 high) and a 4-sprint remediation plan; **the repo contains no record that those fixes shipped** (the promised `docs/security/` artifacts don't exist, and `CLAUDE.md` has no post-2026-05-22 hardening entry). Some were clearly fixed (the SSE `?token=` → nonce exchange now exists; refresh TTL is 7d; `HS256` is pinned; refresh reuse-detection exists; the SSRF guard exists; a hash-chain exists) but others remain open here (CSP shipped via `middleware.ts` not helmet; webhook-create SSRF unverified; TOTP brute-force lockout still absent). Until verified, that doc doubles as an exploit guide checked into the repo.

---

## 12. UI vs. reality — the gaps an operator would hit

The web app is genuinely real-data (no fake dashboards) with **two outright fakes** and a long tail of "the UI promises a capability the backend doesn't expose, or vice versa":

**Outright fakes / dead UI:**
- **Dashboard "Sync now" button is a hardcoded mock** (`connections-sync.tsx:26` — `setTimeout(600)` + invalidate; comment admits it). Appears exactly when an org has never synced, shows a real spinner, does nothing server-side.
- **`/bot` factory-reset is dead UI with a live (unguarded-ish) server endpoint** — the button was removed, the mutation + `POST /bot/factory-reset` remain.
- Flow-editor **edges are decorative** — the bot only reads the flattened `responseTemplates` map; the card copy tells operators to "connect them with fallthrough edges" (zero runtime effect).
- "Write custom guidance below" copy with **no custom-personality input** anywhere (the `customPersonality` field is never editable/sent).

**Stale/false copy:**
- **WhatsApp page "honesty banner" + Live-toggle say the bot doesn't auto-reply** — it does, gated on `isActive`. Clicking "Set Live" starts autonomous replies to real customers.
- **Provenance panels claim "4 tabs (Sources / Hallucinations / LLM call / Raw I/O)"** — both `/inbox` and `/aligned-admin/provenance` render at most **3** (Sources / Hallucinations / Timing). `model`/`tokens`/`systemPrompt`/`history`/`candidates` are fetched but never displayed (over-fetching the full prompt to the browser per inspection).
- **Flagged-bubble rose ring is not proactive** — it derives from a per-bubble query that only fires after the admin clicks each bubble, contradicting `CLAUDE.md`.

**Capability gaps (backend supports it, UI can't reach it; or vice versa):**
- Connector create dialog **omits the `hmac` auth kind** the backend supports; the inbound-webhook **signing secret is never surfaced** anywhere (integrators get the URL but no secret to sign with); **no pause/edit/re-enable** despite rendered `paused`/`disabled` statuses.
- API-key create has **no expiry input** (all UI-issued keys are non-expiring) though the schema accepts `expiresAt`.
- **Version history exists for services + business-info but is only mounted on the product page.**
- **Members page ignores server pagination + search** → orgs with >50 members silently see only the first 50; **deactivate is one-click no-confirm with no reactivate control anywhere**.
- **Carts page truncates at 100** (ignores `nextCursor`) and has no live updates.
- Dashboard deep-links `/inbox?filter=unassigned|awaiting|escalated` and `/contacts?new=1` are **dead query params** (those pages read only `?thread`/nothing).
- `Save tiers` (service edit) **always fails on the first click after adding a tier** (stale-closure sends the `temp-` id, which fails Zod) — works on the second click.
- Availability grid **silently destroys multi-window days** (keeps only the last window per day, then replace-set saves).
- Booking-rules / escalation-rules / WhatsApp-config / bot-config forms **wipe unsaved edits on any sibling save** (re-seed-from-server effect) and **clobber unknown JSONB keys** on save.
- `Make primary` (product image) is a **non-atomic delete-then-recreate** (a failed POST detaches the image, no rollback, no toast).
- Template send dialog only parses `{{n}}` from `bodyText` (header/button variables ignored; positional mapping breaks for non-contiguous placeholders); production operator template sends route through the **`/test-send`** endpoint.
- Auth: invite-accept form **dead-ends on name validation** (errors never rendered) and can't express the existing-account path; cancelling a voice recording on the MediaRecorder fallback **can still send the note to the customer**; typed reply text is **lost on send failure**.
- Many list pages **render query errors as empty states** ("No X yet" / eternal "Loading…") — operators can't distinguish a failure from genuinely-empty.

**Cross-tab hazard (HIGH, `api.ts`):** `switchOrg` broadcasts the new org-scoped access token to all tabs via BroadcastChannel; sibling tabs adopt it but keep rendering org A → polling repopulates with org B data, and a create from the stale tab executes in **org B**. (RLS prevents cross-tenant leakage beyond the user's memberships, so it's misdirected-write, not access-control.) Also: `tryRefresh` treats **any** non-2xx from `/auth/refresh` (incl. a transient 502/429) as session death → force-logs-out all tabs during a deploy blip.

**The positive headline (verified by mapping ~150 distinct UI→API call pairs across 60 web files):** **zero UI calls hit a non-existent route** — every method/path/param contract lines up. The risk is entirely in the categories above (fakes, capability gaps, value/divisor drift, the two HMAC raw-body defects), not in broken wiring.

**`F-RAWFETCH` (raw-fetch refresh bypass, MEDIUM):** a few one-shot user actions use raw `fetch` with a Bearer header instead of the `api` client, bypassing the single-flight refresh + 401-retry — CSV upload (`broadcasts/new`, `contacts`, imports wizard), recipients CSV export (`broadcasts/[id]`), account export + import-template downloads. At access-token expiry these fail with a raw 401 instead of refreshing. Template **download links** are also real `<a target=_blank>` to a JWT-protected route whose auth only happens in `onClick` → middle-click/cmd-click bypasses it → 401 page.

### 12.1 Dead code & unreachable features

- **The knowledge base has full server-side CRUD (6 routes) and ZERO operator UI.** `GET/POST/PATCH/DELETE /bot/knowledge-base` + bulk-wipe + approve-all all exist; the bot engine reads the KB; but no component fetches it (the `/bot` page only blind-invalidates a `['bot-kb']` key that nothing consumes). The bot's **primary answer source** can be populated by the crawler but you cannot view, edit, approve, or correct a single KB entry from the portal. This is the most consequential capability gap.
- **The Segments feature is fully built but completely unreachable.** `segments-manager.tsx` (537 lines, full CRUD + live preview) has **zero importers**; `/segments` redirects to `/broadcasts?tab=segments` which has no segments tab; the broadcast wizard dropped the segment audience. All 7 `/segments*` routes are live but UI-less, and orgs with legacy segment-audience broadcasts can't view/edit those segments.
- **`POST /broadcasts/:id/audience/csv` is a phantom endpoint** — documented by `csvAudienceMetaSchema` but never implemented anywhere.
- **The `email` BullMQ queue is dead on both ends** — a `getEmailQueue` producer factory + an `EMAIL_CONCURRENCY` knob exist, but nothing produces and no worker consumes; all email is sent synchronously inline. (If anyone wires a producer assuming a consumer, those emails queue forever.)
- **Other genuinely UI-less routes:** `/whatsapp/numbers*` (multi-number — API-only), `/branding*` (the settings page is a "coming soon" stub), `GET /bot/voice-status`, `GET /dashboard/summary` (legacy monolith superseded by per-widget routes), `PATCH /members/:id/skills`, `PATCH /canned-responses/:id` (canned page has no edit), `POST /enrollments/:id/cancel`, `GET /sequences/:id/enrollments`, `POST /aligned-admin/plans/sync-stripe` (operator must curl it).

---

## 13. Docs vs. reality — what `CLAUDE.md` and `docs/` get wrong

`CLAUDE.md` is largely a snapshot of the 4-day "Data Management Platform" plan plus a status log; the product has moved far past it. Concrete drift:

- **Architecture:** Docker/GHCR deploy (real = systemd+tsx); "Email: Resend" (real = nodemailer/SES); "Node 22" (real = 20); "Mediterranean Blue / ALIGNED" (real = Hader/Oxblood); pgbouncer.ini/Caddyfile/compose-prod are dead.
- **Phase claims that are now stale-true-or-false:** "no CSRF/2FA/category-UI/member-pagination" tech-debt items were variously fixed (2FA, category UI, member pagination *API*) or are still open (CSRF, member-pagination *UI*). "Email queue plumbed but no worker" — still true (no email worker consumes the `email` queue; auth sends inline). The "fictional product names scrubbed from bot-engine" claim is **incomplete** (§7.3). The provenance "no rows in prod" bug is **open** (§8.6). `/docs/chatbot` swagger "works" — it's empty (§6.11).
- **`docs/` is internally contradictory:** systemd vs Docker (`PHASE_1_OVERVIEW` says "native systemd ~80s" while `RUNBOOK` says Docker Compose); domains (`app.aligned.com` vs `aligned-tech.com` vs `hader.ai`); `/health` returns `{"ok":true}` vs `{"status":"ok"}` (real = `{"status":"ok"}`); backup format `.sql.gz.age` (RUNBOOK) vs `.dump.age` (SESSION_3) — real `backup.sh` produces `pg_dump --format=custom` (a `.dump`); restore command `node ... apply-rls.ts` (won't run a `.ts`); the chaos-test script `tenant-chaos.ts` **doesn't exist**; `docs/security/` doesn't exist.
- **`HADER-WEB-APP-PAGES.md` overclaims:** "drag-and-connect flow editor" (edges are inert), "public status page that stays up even if the app is down" (served by the same app), "5 API-key scopes" (real = 3), `hmac` connector auth (UI can't), "change on first login" enforcement (not enforced).
- **`OPERATOR-INPUTS.md` claim "per-product currency removed":** the column still exists, the create schema still accepts `currency` (silently discarded), import templates still document it; the "single source of truth" only holds at create time (§6.4).
- **`.env.example` vs `.env.production.example` contradict each other** on whether `OPENAI_API_KEY` is chat or transcription-only; `.env.production.example` is **missing** `GROQ_API_KEY` (required for bot replies), `META_WA_*` (the core product), MyFatoorah, trust-proxy, CNAME target — an operator bootstrapping from it gets a non-functional bot.

---

## 14. Architecture-level inconsistencies (comment-vs-code, drift)

A non-exhaustive list of "the comment/name says X, the code does Y" found across the audit (each is cited in the per-chunk notes):

- `withRefreshLock`/`emitWebhookEvent`/`recordRevision` header comments vs racy/inside-tx reality.
- "Streaming" CSV (import-csv, broadcast-fanout, multipart-upload) — all fully buffer.
- "Constant-time compare" (recovery codes — `indexOf`).
- `consumeSendToken` "token bucket by default 80 mps" — fixed-window, hardcoded 80.
- `ELEVENLABS_MODEL` default has **four** sources with **two** values (`eleven_flash_v2_5` vs `eleven_multilingual_v2`).
- `apexOf` (crawl) "rightmost two labels" — only strips `www.`.
- `provenance-digest` lock "cross-replica skew protection" — self-blocks.
- `reportPostgresRlsViolation` mis-tags SQLSTATE `42710` (duplicate_object) as RLS.
- `dependabot.yml` claims actions are hash-pinned — they're mutable tags (incl. `appleboy/ssh-action@v1` which receives the prod SSH key).
- The `email` BullMQ queue has a producer factory but **no consumer worker**.
- Worker `index.ts` header says it boots 3 workers — it boots 7 + 7 ticks.

---

## 15. Appendix — topology reference

**Queues (producer → consumer):** `import`, `sync`, `webhook-delivery`, `crawl`, `data-export`, `broadcast-fanout`, `broadcast-send` (all consumed by `apps/worker`); **`email`** has a producer factory (`getEmailQueue`) but **no worker** (dead). Ticks (no queue): sequence, booking-reminder, provenance-digest, dunning, draft-cart-ttl, inbox-consistency, uptime-probe.

**Outbound webhook event kinds emitted:** `product_created/updated/deleted`, `service_*`, `business_info_updated`, `faq_changed`, `policy_changed`, `catalog_changed`, `cart_created/status_changed/item_added`, `booking_created/status_changed/reminder_sent`, `broadcast_started/completed/failed/recipient_failed`. Subscribable enum = `WebhookEventKind`. A created endpoint with `eventKinds: []` means **subscribe-to-all**.

**Read-API cache keys:** `read:{orgId}:{endpoint}:{sha1(query)[0:16]}`, 60s fresh / 300s retained, gzip ≥2KB, SCAN-based invalidation on `emitWebhookEvent` (when it's actually called — §6.4/§7.6).

**Redis key namespaces:** `aligned-rl:*` (rate limit, keyed by IP or raw API-key), `wasend:{org}:{sec}` (send token bucket), `botcoalesce:{org}:{phone}`, `aitokens:{org}:{day}`, `memthrottle:{org}:{phone}`, `plan:unlimited:{org}`, `sse-nonce:{nonce}`, `2fa:pending*:{user}`, `inbox:typing:{org}:{thread}:{user}`, `uptime:api` (ZSET), `lock:{sequence|booking-reminder|provenance-digest|dunning}-tick`.

**Env vars that are read in code but NOT in `.env.example`/schema** (violating the project's own "keep in sync" rule): `BOT_COALESCE_MS`, `FFMPEG_PATH`, `BROADCAST_MAX_RECIPIENTS`, `WORKER_METRICS_PORT`, `SENTRY_*` (worker), `UPTIME_PROBE_URL`, `WHATSAPP_SEND_TOKENS_PER_SECOND`, various `*_TICK_INTERVAL_MS`, `OPENAI_FALLBACK_ENABLED`. `.env.production.example` is missing the Groq/Meta/MyFatoorah/trust-proxy keys the product needs.

**Audit-action taxonomy is collapsed:** dozens of semantically distinct events (bot deploy, KB wipe, factory reset, impersonation, checkout, org export, org self-delete, all WhatsApp channel/template/inbox events, all 2FA events, sequence create) are written under reused enum values (`business_info_updated`, `password_changed`, `org_suspended`, `broadcast_created`) with the real event buried in `metadata.event` → action-based audit filtering is meaningless for most modern activity, and the audit-log UI dropdown only lists 13 of ~33 actual entity types.

---

## 16. Coverage note

Files covered line-by-line by the reader fleet and folded into this document: the entire `apps/api` (all 14 module groups + libs + plugins + tests + scripts), both `apps/worker` chunks, `packages/db` (schema + 45 migrations + RLS + seeds), `packages/shared` (all schemas/enums + url-guard), `packages/config`, all of `apps/web` (inbox, bot, aligned-admin, catalog, CRM, bookings/imports, dashboard/analytics, auth/shell/lib, settings/UI, business-info/categories, WhatsApp/integrations), `apps/e2e`, all infra/CI/compose/env, and all `docs/`.

The synthesis above is grounded in 35 per-chunk reader notes (stored under `C:\tmp\alignbot-audit\notes\`) **plus** a completed second-phase cross-cutting verification (7 reports under `C:\tmp\alignbot-audit\cross\`): **X1** UI↔API contract (mapped ~150 call pairs — 0 broken routes), **X2** schema↔code↔migrations↔RLS, **X3** shared-Zod drift, **X4** queue/webhook/env topology, **X5** docs↔reality, **X6** security/tenancy sweep, **X7** end-to-end bot-pipeline trace + the git-archaeology that resolved the provenance "mystery" (§8.6). Every `file:line` here came from reading the actual code, not from names or comments.

A short list of subsystems an implementer should still trace interactively before acting (the audit characterized them but they reward live verification): the inbox SSE refresh flow under load; the exact MyFatoorah invoice round-trip; whether prod Redis is actually `noeviction` (vs the committed `allkeys-lru`); and whether the `.env.production` on the host actually carries `GROQ_API_KEY` + `META_WA_*` (the deploy appends them, but the example template omits them).
