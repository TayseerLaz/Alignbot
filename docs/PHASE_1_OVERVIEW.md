# ALIGNED Business Platform — Phase 1

**Status:** Live in production · **Deployed:** April 2026 · **Build time:** 4 days

> A multi-tenant SaaS where ALIGNED's clients manage their product/service
> catalogs, business information, and FAQs. ALIGNED's WhatsApp chatbots read
> from this platform via a low-latency, cached API.

---

## 1. Executive summary

| | |
|---|---|
| **What it is** | The data backbone for every ALIGNED chatbot. Clients edit their catalog here; bots read from it. |
| **Who uses it** | (a) ALIGNED's own clients (cafes, clinics, retail, services) and (b) ALIGNED super-admins. |
| **Live URLs** | Portal: [alignbot.aligned-tech.com](https://alignbot.aligned-tech.com) · API: [api.aligned-tech.com](https://api.aligned-tech.com) |
| **Tech stack** | Node.js + Fastify, Next.js 15, PostgreSQL 16 (with Row-Level Security), Redis 7, Wasabi storage, AWS SES email |
| **Tenant model** | Shared schema with hard isolation via Postgres RLS — one tenant cannot see another's data, ever |
| **Read API SLO** | p95 < 200 ms at 500 req/s on cached reads |
| **Phase 1 cost** | 4 calendar days of focused build, deployed end-to-end |

### Why this exists

Today, ALIGNED builds a custom WhatsApp chatbot for each client. The bot needs
*current* product prices, opening hours, FAQ answers, return policies — and
those things change. Without a platform like this, every change is a manual
update by ALIGNED staff, which is slow, error-prone, and doesn't scale.

**Phase 1 solves the data problem.** It gives every client a self-serve
control panel for the data their bot needs, plus a fast, cached API the bots
read from. It does *not* yet build the bots themselves — that's Phase 2.

---

## 2. What was built (Phase 1 features)

### 2.1 Multi-tenant client portal

A Next.js portal at [alignbot.aligned-tech.com](https://alignbot.aligned-tech.com)
where each client signs up, manages their team, and edits their data.

- **Self-serve signup** with email verification (via AWS SES).
- **Team management** — invite teammates by email, assign roles (Admin / Editor / Viewer), revoke access.
- **Org switcher** for users who belong to multiple clients (e.g. agency staff).
- **Mediterranean-blue brand**, IBM Plex Sans, mobile-responsive shell.

### 2.2 Catalog editor

Three first-class entity types, each with full CRUD and search:

| Entity | What it covers |
|---|---|
| **Products** | SKU, name, description, price, currency, stock, images (uploaded to Wasabi), variants (size/color/etc.), categories, availability |
| **Services** | Name, description, duration, base price, pricing unit (flat / per-hour / per-day / per-session / per-unit), pricing tiers, weekly availability grid |
| **Business info** | Legal name, tagline, opening hours by weekday, locations, contact channels (phone/email/WhatsApp), FAQs, policies (returns / shipping / privacy / etc.) |

Every change is auto-saved (800 ms debounce on text fields). Every entity tracks
a full **revision history** — clients can see who changed what and roll back to
any prior version with one click.

### 2.3 Bulk import

Clients with existing catalogs (e.g. from Shopify, a spreadsheet, or a legacy
system) don't need to type everything in.

- Download a **template** (XLSX with sample row + field-by-field help sheet).
- Upload **CSV or XLSX** (server streams the file directly to Wasabi).
- A **background worker** parses row-by-row, validates each row with Zod, and
  upserts into the right table.
- Per-row results: succeeded / failed, with the original raw data and structured
  error messages so the client can fix and retry.
- **Cancel** an in-progress import at any time.
- Live progress UI with notifications when the import finishes.

> **Verified in production:** 8 products + 6 services imported into the demo
> tenant in ~450 ms each, with the system correctly catching CSV authoring
> errors (unquoted commas) and reporting clean per-field errors.

### 2.4 API connectors (push + pull)

For clients with live source-of-truth systems:

- **Pull (scheduled sync):** Configure a REST endpoint with auth (Bearer / API
  key / Basic / HMAC). The platform polls it on a cron schedule and syncs the
  data. Manual "run now" button too.
- **Push (inbound webhook):** The platform issues a unique webhook URL per
  connector, signed with HMAC-SHA256. The client's system POSTs changes; we
  validate the signature and process them.
- Sync history visible inline (last 50 runs per connector).

### 2.5 Chatbot read API

The whole reason the platform exists. Bots read from
[api.aligned-tech.com/api/v1/read/*](https://api.aligned-tech.com/docs/chatbot)
using an `X-Aligned-Api-Key` header.

| Endpoint | Returns |
|---|---|
| `/read/products` | Paginated product list with filters |
| `/read/products/:id` | One product, full detail |
| `/read/services` | Paginated services |
| `/read/services/:id` | One service |
| `/read/business-info` | Hours, contacts, locations |
| `/read/faqs` | Public FAQs |
| `/read/policies` | Public policies (returns, etc.) |
| `/read/search?q=…` | Cross-entity search (full-text) |

- **Redis cached** with 60 s fresh + 5 min stale TTL — cache headers expose
  `x-cache: HIT | STALE | MISS` so the bot can tell.
- **Auto-invalidated** on every catalog write — bots never see stale data after
  a client edits.
- **Per-key rate limited** (default 200 req/s per key, configurable).
- **Scopes** — each API key declares which endpoints it can access.

### 2.6 Outbound webhooks

Bots that want to know *when* something changed (instead of polling) subscribe
to events:

- HMAC-SHA256 signed (`X-Aligned-Signature: sha256=…`).
- Exponential backoff with 8 retry attempts.
- Permanent-fail short-circuit on 4xx (client error, retrying won't help).
- Auto-disable after 25 consecutive failures (and notify the client).
- Manual retry from the deliveries log.

### 2.7 API keys

Clients issue keys from `/api-keys` in the portal:

- Secret shown **once** (then hashed-at-rest with SHA-256).
- Per-key scopes.
- `lastUsedAt` tracking + audit log entry on first use.
- Revocable any time.

### 2.8 ALIGNED super-admin panel

A separate panel at `/aligned-admin` (gated by an `isAlignedAdmin` flag —
clients cannot see it) that lets ALIGNED staff oversee every tenant. See §4.

### 2.9 Notifications

Bell icon in the top bar. Per-user and org-wide notifications. Used today by
the import worker to alert the client when their import finishes. Will expand
in Phase 2 to include bot deployment status, sync failures, etc.

### 2.10 Production-grade ops

| | |
|---|---|
| **Deployment** | Native systemd on Aligned Cloud Servers, automated via GitHub Actions on every push to `main` (~80s end-to-end including smoke test) |
| **TLS** | Caddy with automatic Let's Encrypt for `alignbot.*` and `api.*` |
| **Backups** | Nightly `pg_dump` → gzip → age-encrypted → Wasabi → 30-day retention |
| **Observability** | Pino structured logs, Sentry for unhandled errors, Prometheus `/metrics` on api (4000) and worker (9100) |
| **Email** | AWS SES SMTP — DKIM-verified domain `alignbot.aligned-tech.com`, out of sandbox, end-to-end tested |
| **CI** | Lint + typecheck + integration tests against ephemeral Postgres + Redis on every PR |
| **Hard deploy gate** | A **tenant-isolation test** that fails the build if any cross-tenant data leak is detectable |

---

## 3. How a client (company) uses the platform

### Day 1: get set up

1. **Sign up** at [alignbot.aligned-tech.com/signup](https://alignbot.aligned-tech.com/signup) with the company name and the founder's email.
2. **Verify the email** (one click in the inbox).
3. **Invite the rest of the team** from `/members` — pick a role per person:
   - **Admin** — can do anything, including invite/remove people and delete the org.
   - **Editor** — can edit catalog, services, business info, run imports.
   - **Viewer** — read-only (e.g. customer support reading current prices).
4. **Add basic business info** at `/business-info`:
   - Tagline, about, website, timezone, currency.
   - Opening hours by weekday (or "always open" / "closed").
   - Locations (each with address, phone, map link).
   - Contact channels (phone, email, WhatsApp number).

### Day 2: load the catalog

Three options, in order of effort:

| If you have… | Use… |
|---|---|
| Nothing yet | Manual entry at `/products` and `/services` — fastest for <50 items |
| A spreadsheet or export | **CSV/XLSX import** at `/imports` — download the template, fill it, upload, watch progress |
| A live system (Shopify, Square, custom) | **API connector** at `/connectors` — set it up once, syncs forever |

Add product/service categories as you go; they're auto-created during imports.

### Day 3: connect the bot

1. Go to `/api-keys` → "Issue new key".
2. Set scopes (which endpoints the bot can read).
3. **Copy the secret immediately** — it's never shown again.
4. Hand the secret to the bot team.
5. (Optional) Set up an outbound webhook at `/webhooks` so the bot gets pushed
   on changes instead of polling.
6. Test from the bot side:
   ```bash
   curl -H "X-Aligned-Api-Key: $KEY" \
     https://api.aligned-tech.com/api/v1/read/products
   ```

### Ongoing

| Job | Where | Frequency |
|---|---|---|
| Update prices, stock, descriptions | `/products`, `/services` | As needed (auto-saved, immediately reflected in bot) |
| Add seasonal items | `/products` (mark as `isAvailable=false` to hide) | As needed |
| Edit FAQs / policies | `/business-info` → FAQs / Policies tabs | As needed |
| Roll back a bad change | Any product page → "Version history" → restore | As needed |
| Audit who changed what | Audit log entries (visible in version history) | As needed |

### What the bot sees, end-to-end

```
Customer in WhatsApp:
  "Do you have the purple yoga mat in stock?"
       ↓
ALIGNED chatbot intent detection:
  → product lookup, query: "purple yoga mat"
       ↓
GET https://api.aligned-tech.com/api/v1/read/search?q=purple+yoga+mat
  X-Aligned-Api-Key: <key>
       ↓
Redis cache → DB query (RLS-isolated to client's org)
       ↓
Response in <100 ms (cached) or <300 ms (cold):
  { sku: "WL-MAT-PURP", name: "Premium Yoga Mat (Purple)",
    priceMinor: 4999, currency: "USD",
    isAvailable: true, stockQuantity: 40 }
       ↓
Bot replies:
  "Yes — the Premium Yoga Mat in Purple is $49.99 and we have 40 in stock."
```

---

## 4. How an ALIGNED admin uses the platform (and why)

ALIGNED super-admins are *not* clients — they're internal staff who oversee
*every* tenant. The `/aligned-admin` panel is invisible to clients (gated by
the `isAlignedAdmin` user flag).

### What they can see and do

| Feature | Use case |
|---|---|
| **All tenants list** | Search across every client. See member counts, product/service counts, status. |
| **Suspend / reactivate / delete** a tenant | Customer not paying invoices → suspend (login blocked, data preserved). Pilot ended → delete. |
| **System health** | Live queue depths (import / sync / webhook), Redis ops/s, total org status counts. Spot trouble before clients do. |
| **Notifications bell** | Org-wide alerts for ALIGNED staff (e.g. queue backing up). |
| **Bypass-RLS data access** (DB level only) | When a client raises a support ticket and asks "why isn't my product showing in the bot?", admins can investigate without needing the client's password. |

### Why a super-admin role exists

1. **Support.** When a client says "my bot isn't returning the right product",
   ALIGNED needs to look at *their* data without asking for their password.
   The super-admin role does this safely (and audit-logs every cross-tenant
   read).
2. **Billing & lifecycle.** Onboarding a new pilot, suspending an unpaid
   account, archiving a churned one — all done from the admin panel.
3. **Operational visibility.** Watching queue depth, error rates, and
   webhook delivery success across all tenants — clients can't (and shouldn't)
   see this.
4. **Disaster recovery.** When a backup needs to be restored, or a bad import
   needs reversing, only the super-admin has the cross-tenant view to do it.

### What the super-admin **cannot** do (by design)

- **Read individual API key secrets** — they're hashed at rest. The admin can
  *issue a new one* on a client's behalf, but cannot see the existing one.
- **Read user passwords** — same reason, bcrypt-hashed.
- **Bypass an audit trail** — every cross-tenant action is logged with the
  admin's user ID, the tenant ID, the action, and a timestamp.

### Day-to-day admin checklist

| Daily | Check `/aligned-admin` for queue depth + auto-disabled webhooks |
| Weekly | Review new tenant signups, check for any stuck imports |
| Monthly | Review backup integrity (run a test restore), rotate any expiring secrets |
| Quarterly | Capacity review — Redis memory, DB disk, worker concurrency |

---

## 5. What is **not** in Phase 1

These were intentionally deferred because they don't block the core value
(catalog data flowing to bots) and would each have added 1–2 days of build:

| Deferred | Why | When |
|---|---|---|
| Drag-and-drop image reordering on products | "Make primary" click is enough for now | Polish pass |
| Rich-text (Tiptap) editor for descriptions | Plain markdown-style text works fine for chatbot consumption | Polish pass |
| Column-mapping wizard in the import UI | The generated templates already use the correct headers; mapping is supported in the API | Polish pass |
| Category management UI | Categories auto-create during imports; CRUD via API works | Polish pass |
| Email queue worker | Email sends directly from the API (Resend/SES); fine for our volume | Phase 2 |
| 2FA | Out of scope for MVP | Phase 3 |
| Self-service password change | Forgot/reset works; in-app change is a polish item | Polish pass |

---

## 6. Phase 2 — what comes next (the AI bot builder)

Phase 1 gave clients control over the **data**. Phase 2 gives them control
over the **bot**.

### The vision

Today, every ALIGNED chatbot is built by hand. Phase 2 lets a client go from
zero to a working WhatsApp bot in **under 30 minutes**, with no engineering
involvement on ALIGNED's side for routine cases.

### The Phase 2 plan (4 modules, ~13–17 build-days, ~3 calendar weeks)

#### Module 1 — AI website + business analysis (~4–5 days)

Crawl the client's website with a headless browser (Puppeteer/Playwright),
extract content, run it through an LLM (GPT-4 or Claude), and **generate a
draft knowledge base automatically**.

- Detects business type, tone of voice, key services, pricing pages, FAQ-style
  content, contact info.
- Merges crawled data with what the client already entered in Phase 1.
- Surfaces gaps ("we couldn't find your return policy — please add it").
- Async via queue (crawls take minutes, can't block the UI).

#### Module 2 — Guided bot configuration (~4–5 days)

Adaptive 5–10 question wizard that fills in whatever the AI couldn't infer.

- AI-suggested **personality profile** (formal / casual / playful / clinical)
  with customization.
- **Visual conversation flow editor** — drag-and-drop for greeting, inquiry,
  booking, support, escalation.
- **Response template review** — clients edit AI-drafted templates before they
  go live.
- Multi-language support, localization settings.
- Escalation rules — when does the bot hand off to a human? Business-hours
  config.

#### Module 3 — Live bot preview (~3–4 days)

Embedded WhatsApp-style chat simulator inside the portal.

- Connects to the AI engine using *the client's* knowledge base + personality.
- Real-time editing — config changes reflect instantly without redeployment.
- Pre-built test scenarios (product question, booking flow, complaint handling)
  with **accuracy scoring**.
- **One-click deploy to WhatsApp** via Meta Cloud API.
- Versioning + rollback — revert to previous bot version if needed.

#### Module 4 — QA + launch (~2–3 days)

- End-to-end test of the full crawl → configure → preview → deploy flow.
- Benchmark accuracy: target **85%+** on test queries.
- Validate preview-to-production fidelity: target **95%+**.
- Security audit of the AI layer (prompt injection, cross-tenant data leakage).
- Pilot with select clients, gather feedback, ship.

### Phase 2 schedule risks (be honest)

| Risk | Mitigation |
|---|---|
| Hitting 85%+ KB accuracy usually needs 2–3 iteration cycles with real pilot data | Add a 1-week buffer for accuracy tuning |
| Meta WhatsApp Business API onboarding (phone verification, template approval, business verification) is gated by Meta — typically 3–10 business days | Start onboarding in parallel with development, not after |
| Crawler robustness on JavaScript-heavy sites | Choose Playwright (more mature than Puppeteer for SPAs); allow manual content paste as fallback |
| LLM cost per analysis (GPT-4 / Claude) | Use cheaper model for initial extraction, premium model only for final synthesis |

**Realistic Phase 2 timeline: 4 calendar weeks** of development + Meta approvals
running in parallel.

---

## 7. What it cost to build (Phase 1)

| Item | Cost |
|---|---|
| Build time | 4 calendar days (Claude-assisted) |
| Recurring infra | Aligned Cloud Server + Wasabi storage + AWS SES (~pennies per email) — well under $100/mo at pilot scale |
| External services | None paid — Resend was swapped for AWS SES (already in IT's account) |
| Scaling headroom | Built for 500 req/s on read API at p95 < 200 ms; horizontal scaling for api/worker is one config change |

---

## 8. Risks and trade-offs (the honest list)

### Tenant isolation is **the** load-bearing assumption
We use Postgres Row-Level Security with a hard test gate that blocks deploys
if a single isolation violation is detectable. This is industry-standard for
shared-schema multi-tenancy, but it's worth noting: a misconfigured query that
accidentally bypasses RLS would be catastrophic. Mitigations in place:

- The Prisma client connects as a **non-superuser role** (`aligned_app`), so
  RLS actually applies (superusers bypass it silently — a bug we caught in QA).
- Every authenticated request runs inside a transaction with
  `app.current_org_id` set.
- A dedicated integration test creates two orgs, attempts cross-tenant reads
  with crafted IDs, and fails the deploy if any leak is found.

### Read API cache freshness vs. cost
60 s fresh + 5 min stale is good for most use cases. A bot asking "is this
product still in stock?" might see up-to-60-second-old data. For lower-volume,
truly stock-sensitive answers, the bot should hit the canonical product
endpoint (which is also cached but invalidated on every write).

### CSV import error UX
The system correctly catches malformed CSVs (we proved this in production).
But the failed-row UI today shows raw Zod errors. A future polish item: human-
friendly translations ("the price column has text in it" instead of
"durationMinutes: Invalid input").

### No bot-builder yet
Clients can manage their data but **cannot create or deploy a bot** from this
platform yet. That's Phase 2. Until then, ALIGNED engineers still build the
bot itself; this platform replaces the data-management half of that workflow.

---

## 9. Glossary

| Term | Meaning |
|---|---|
| **Tenant / Org / Organization** | One ALIGNED client. All data is scoped to one tenant. |
| **RLS (Row-Level Security)** | A Postgres feature that enforces per-row access rules at the database. Our backstop against tenant data leaks. |
| **Membership** | The relationship between a user and an org. Holds the role. A user can belong to multiple orgs. |
| **Read API** | The cached, API-key-authenticated endpoints chatbots read from. |
| **Connector** | An external system (Shopify, custom backend) that the platform syncs with. |
| **API key** | A secret that lets a chatbot read from the platform on behalf of one tenant. |
| **Outbound webhook** | A POST the platform sends to a chatbot when data changes. |
| **Inbound webhook** | A POST a connector sends to the platform when data changes. |
| **ALIGNED super-admin** | An internal user with cross-tenant access to the `/aligned-admin` panel. |
| **Hard deploy gate** | A test that blocks the production deploy if it fails. Currently: tenant isolation. |

---

## 10. Where to look for more

| Topic | File |
|---|---|
| Day-by-day build plan + locked decisions | [CLAUDE.md](../CLAUDE.md) |
| Production operations (deploy, rollback, restore, rotate, incidents) | [docs/RUNBOOK.md](RUNBOOK.md) |
| API reference (full) | [api.aligned-tech.com/docs](https://api.aligned-tech.com/docs) |
| API reference (chatbot-facing only) | [api.aligned-tech.com/docs/chatbot](https://api.aligned-tech.com/docs/chatbot) |
| Live portal | [alignbot.aligned-tech.com](https://alignbot.aligned-tech.com) |

---

*Last updated: April 2026 · Phase 1 complete and live in production.*
