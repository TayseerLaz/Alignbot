# Phase 1 — Gap Close Plan (3 sessions)

> **Purpose:** Phase 1 shipped 95% of the original PDF spec, but a concrete list
> of items asked for in the spec document were deferred or shallower than
> required. This file tracks every one of them and schedules the work into
> three focused sessions.
>
> **Sources of truth for this plan:**
> - Original spec: *ALIGNED Business Platform — Project Details* (PDF, v1.0, April 2026)
> - What was actually built: [CLAUDE.md](../CLAUDE.md) §4 (the 4-day plan) and §5 (Current Status)
> - What was deployed: [PHASE_1_OVERVIEW.md](PHASE_1_OVERVIEW.md)
> - Verified against the codebase on 2026-04-24.

---

## 1. Canonical gap list

### A. Features in the spec but NOT built

| # | PDF ref | Feature | Evidence of gap |
|---|---|---|---|
| A1 | §3.1.2 Manual Entry: "rich text descriptions" | Rich-text editor for product / service / policy descriptions | No `tiptap`/`RichText` import in `apps/web/src`. Everything is plain `<textarea>`. |
| A2 | §3.1.2 + task 7.5 "column mapping interface" | Column mapping wizard step in the import UI | No `columnMapping` / mapping UI in `apps/web/src`. Backend accepts `columnMapping` on `POST /imports`; UI never collects it. |
| A3 | §3.1.1 + task 3.4 | Dashboard widgets: **last sync time**, **API connection status**, **recent activity log** | `dashboard/page.tsx` has only generic count cards. None of the three widgets exist. |
| A4 | §3.1.1 Activity log (also §10 audit log) | UI page to view audit events | `AuditLog` table + `recordAudit()` calls exist. No UI reads them. |
| A5 | §3.1.2 Service Catalog + task 5.1 "booking rules" | UI for service **booking rules** (deposit, cancellation window, lead time) | `bookingRules` JSONB field exists in DB + API. Service edit page has zero references. |
| A6 | §3.1.2 Policies editor (task 6.5) "with rich text" | Rich-text input for policies | Same textarea problem as A1. |
| A7 | Task 7.7 "downloadable error CSV" | Download failed import rows as a CSV file | No `errors.csv` / `downloadErrors` code path. On-screen drilldown only. |
| A8 | Task 10.3 "system-wide analytics: **API call volume**" | API-call volume chart in admin panel | Admin shows queue depth + counts only. No historical API volume. |
| A9 | Task 10.4 "API health monitoring page — **uptime + error rate**" | Uptime / error-rate page in admin | Prometheus `/metrics` is scrapable; no admin page renders the series. |
| A10 | Task 10.5 "alerting for sync failures, API degradation" | Pushed alerts (email/Slack/in-app) on connector failure + API regression | Sentry catches exceptions. No alert rule on sync-fail or p95 regression. Sync-fail bell notification not emitted either. |
| A11 | Task 3.8 + §6 "WCAG 2.1 AA compliance" | Actual a11y audit + fixes | Nobody ran an audit. No a11y fixes applied. |

### B. Features built but shallower than spec

| # | PDF ref | Spec says | Reality |
|---|---|---|---|
| B1 | Task 8.2 "Test connection button" | Real end-to-end test | Generic HTTP GET. No response-shape parsing, no record-count feedback. |
| B2 | Task 8.7 "Sync status dashboard" | A dashboard | Per-connector inline history only. No roll-up page across connectors. |
| B3 | Task 8.8 "retry logic **and failure alerting**" | Both halves | Retry ✅. Client-facing failure alert ❌. |
| B4 | §6 Scalability "100+ clients × 10k products" | Proven at scale | k6 covers 500 rps read API. 100-tenant × 10k-product path unverified. |
| B5 | §6 Compliance "GDPR-aware" | Export + delete flows | Org-level suspend/delete only. No per-user export, no right-to-forget. |
| B6 | §6 Availability "99.9% SLA + automated health checks + alerting" | SLA instrumentation | `/health` exists. No uptime monitor, no SLA dashboard, no pager. |

### C. QA + launch items not done (§11.x)

| # | PDF ref | Status |
|---|---|---|
| C1 | 11.2 Security audit | Not run. RLS gate passes; no full `/security-review` or pen test. |
| C2 | 11.4 Onboard 3 pilot clients | Not started. Blocks on deploy. |
| C3 | 11.5 Bug fixes from pilot feedback | Can't start until C2. |
| C4 | 11.6 Production deploy + go-live | Blocked on Wasabi keys, SSH host, SES key, GitHub secrets. |

### D. Success-criteria inconsistency (§7.1)

| # | Criterion | Issue |
|---|---|---|
| D1 | "Clients see data reflected in **WhatsApp bot responses** within 5 minutes" (§7.1 #1) | Phase 1 does not build a bot. Criterion is structurally Phase 2. Reframe or accept. |
| D2 | "WhatsApp chatbot reads from platform with <200ms latency" (§7.1 #4) | Read API meets this. "WhatsApp chatbot" part is outside Phase 1. Same reframe needed. |

---

## 2. Effort estimate per item

| Item | Size |
|---|---|
| A1, A6 (rich text — one shared component, three places) | 1 day |
| A2 (column mapping wizard) | 1 day |
| A3 (three dashboard widgets) | 1 day |
| A4 (audit log viewer — client + admin) | 1–2 days |
| A5 (booking rules UI) | 1 day |
| A7 (error CSV download) | 0.5 day |
| A8, A9 (API-volume + uptime pages in admin) | 1–2 days |
| A10 (sync-failure bell notification + basic alerting) | 0.5–1 day |
| A11 (WCAG audit + fixes) | 1–3 days |
| B1 (connector test depth) | 0.5 day |
| B2 (cross-connector sync dashboard) | 0.5 day |
| B5 (GDPR export + delete-my-account) | 1–2 days |
| B6 (uptime monitor wiring — UptimeRobot or similar + dashboard tile) | 0.5 day |
| C1 (`/security-review` pass + fixes) | 1 day |
| C4 + C2 (deploy + onboard 3 pilots) | 1–2 days deploy + 2–4 weeks pilot calendar |

**Functional-gap total:** ~10–14 dev-days. Pilot calendar: 2–4 weeks, gated on Meta verification.

---

## 3. Session plan

Three sessions, each a demoable end-point. Modelled on the existing 4-day plan
structure in CLAUDE.md. Pick them up one at a time — do not interleave.

---

### Session 1 — Client-facing content gaps (1 day)

**End-of-session demo:** A pilot client can use a rich editor for
descriptions, map CSV columns during import, set booking rules on a service,
download failed rows as a CSV, and get a bell notification when a sync fails.

Why this bundle: every item is a small UI on top of existing backend. No new
DB work, no new routes (mostly). High visible-polish-per-hour ratio.

| Task | Item | Est. |
|---|---|---|
| **1.1** Install a rich-text editor (Tiptap — starter-kit + link + lists). Create a shared `<RichTextEditor>` component in `apps/web/src/components/ui/rich-text.tsx`. | A1 | 0.25 d |
| **1.2** Swap `<textarea>` for `<RichTextEditor>` on product, service, and policy description fields. Keep markdown-safe serialization so the chatbot read API payload stays parseable. | A1, A6 | 0.25 d |
| **1.3** Import wizard: add a "Map columns" step between upload and kick-off. Read the first row of the uploaded file, show a header-by-header dropdown mapping to ALIGNED fields, pass as `columnMapping` body on `POST /imports`. Skip-step when headers already match template. | A2 | 0.5 d |
| **1.4** Service edit page: add a "Booking rules" card with fields — deposit required (bool), deposit % (0–100), cancellation window hours (int), lead time hours (int), max party size (int). Save via existing `PATCH /services/:id` with `bookingRules` JSON. | A5 | 0.5 d |
| **1.5** Import detail page: add a "Download errors CSV" button. Server route emits a CSV of all `ImportJobRow` rows where `status='failed'` including original raw data + error message. | A7 | 0.25 d |
| **1.6** Sync worker: on transition to `failed` or `partial`, emit a `Notification` (user-less, org-wide) so the bell catches it — mirror the pattern the import worker already uses. | A10 (partial) | 0.25 d |
| **1.7** Update the chatbot read API to strip HTML tags from rich-text descriptions before caching, so the bot still gets plain text. One util, one place to call it. | A1 follow-on | 0.25 d |

**Deploy gate:** all integration tests still green (no behavior change on existing fields), plus a new test: POST an import with a `columnMapping` payload from the new wizard and assert it upserts the same number of rows a template-matched import would.

**What this session does NOT touch:** dashboard widgets, audit log UI, admin analytics, a11y, security audit, deployment.

---

### Session 2 — Visibility, history, and admin depth (1.5–2 days)

**End-of-session demo:** A client opens the dashboard and sees last sync
time, API connection status, and recent activity. They can open a full
activity log page and filter by entity. ALIGNED staff can see API call
volume and error rate in the admin panel, and the cross-connector sync
dashboard. A client can also export their personal data and delete their
account.

Why this bundle: every item is a whole new page or pane. Heavier than
session 1 but still CRUD on existing models.

| Task | Item | Est. |
|---|---|---|
| **2.1** `GET /api/v1/dashboard/summary` — returns org counts + `lastSyncAt` (max over `SyncRun.finishedAt`) + connector status breakdown + latest 10 audit events. Cache 30s. | A3 | 0.25 d |
| **2.2** Dashboard page: replace the static count grid with the three promised widgets — Last sync (timestamp + connector name + link), API connection status (green/amber/red per connector), Recent activity (top 10 audit entries with actor + action + timestamp). | A3 | 0.5 d |
| **2.3** New page `/audit-log` — paginated table reading from `AuditLog`, filters by entity type + actor + date range. Client-scope (RLS already handles isolation). | A4 | 0.5 d |
| **2.4** Admin panel: add a "Cross-tenant audit" tab reading all audit events with tenant name column. Uses `requireAlignedAdmin`, bypasses RLS via the read-all path already established in the admin panel. | A4 | 0.25 d |
| **2.5** Admin panel: new "API traffic" card — reads Prometheus counter via a small server-side fetch of `/metrics`, parses, renders a 24-hour sparkline of read-API req/s and error rate. | A8, A9 | 0.5 d |
| **2.6** Connectors list page: add a top roll-up panel — "14 connectors active · 1 failing · last sync 3 min ago" — summarises over all connectors in the org. | B2 | 0.25 d |
| **2.7** Connector test-connection: upgrade to parse response body. For generic REST, count records in response (`.length` or `.data.length`). Return `{ ok: true, recordCount }` so the UI can show "✓ Connected · 247 records found". | B1 | 0.25 d |
| **2.8** Settings → Account: add "Export my data" (returns a ZIP of all audit entries + memberships + sessions for the current user) and "Delete my account" (soft-deletes user, revokes sessions, refuses if last admin per the existing guard). | B5 | 0.5 d |

**Deploy gate:** a new integration test that creates a user, exports their
data, asserts the ZIP contents, then deletes the account and asserts all
sessions are revoked. Admin-panel RLS bypass on audit log must stay gated
behind `requireAlignedAdmin` — add a test asserting a non-admin 403s.

**What this session does NOT touch:** a11y audit, security audit,
deployment, pilots.

---

### Session 3 — Harden, audit, deploy, onboard (2–3 days dev + 2–4 weeks calendar)

**End-of-session demo:** `app.aligned.com` is live with TLS, `/health`
returns 200, the load test runs green from an external machine, three pilot
tenants are seeded with real data, and the ALIGNED team hands each pilot
their API key + Quickstart doc.

Why this bundle: nothing in here is code-risky on its own, but it's calendar-
heavy (Meta verification, pilot hand-holding) and must come last.

| Task | Item | Est. |
|---|---|---|
| **3.1** Run `/audit` skill across the entire `apps/web/src` — produces a scored report (a11y, performance, theming, responsive). Fix every P0 + P1 item before moving on. | A11 | 1–2 d |
| **3.2** Run `/security-review` against the current branch. Triage findings: fix Critical + High immediately, log Medium + Low as follow-up issues. | C1 | 1 d |
| **3.3** Reframe §7.1 success criteria in a short spec amendment. Replace "WhatsApp chatbot" with "chatbot built against the read API" to resolve the D1/D2 inconsistency. Commit to `docs/SPEC_AMENDMENT_2026-04.md`. | D1, D2 | 0.25 d |
| **3.4** Pre-deploy: set up Wasabi bucket + access keys, provision Aligned Cloud Server, configure DNS for `app.aligned.com` + `api.aligned.com`, set GitHub Secrets (`DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_SSH_KEY`, `GHCR_PAT`, `API_DOMAIN`, `WASABI_*`, `AWS_SES_*`). | C4 | 0.5 d |
| **3.5** Push to `main` → GitHub Actions builds + deploys → `prisma migrate deploy` runs → smoke test `/health`. If red, triage per RUNBOOK. | C4 | 0.25 d |
| **3.6** Run k6 load test from an external machine: `API_KEY=… BASE_URL=https://api.aligned.com k6 run infra/scripts/load-test.js`. Must show `p95 < 200ms, p99 < 400ms, error rate < 1%`. | §7.1 #4 | 0.25 d |
| **3.7** Set up UptimeRobot (or equivalent) pinging `/health` every 60s on both domains. Configure PagerDuty or email alert on downtime. Add a small "Uptime" tile to the admin panel reading from UptimeRobot's API. | B6 | 0.25 d |
| **3.8** Seed 3 pilots: `pnpm db:seed:pilot` on the server. Capture the printed API keys into 1Password, one vault entry per pilot. | C2 | 0.25 d |
| **3.9** Pilot onboarding calls: walk each pilot through the [Quickstart Phase 1 doc](QUICKSTART_PHASE_1.md) *(create from [NO_CODE_CHATBOT_PLAYBOOK.md](NO_CODE_CHATBOT_PLAYBOOK.md) — do not reuse the old Quickstart that over-promises)*. Collect feedback after 72 hours. | C2 | 1 d dev + 2–4 wks calendar |
| **3.10** Bug fixes from pilot feedback. Prioritise by number of pilots hit. | C3 | 1–3 d |
| **3.11** Set up the nightly backup cron per RUNBOOK `5 3 * * * /opt/aligned/infra/scripts/backup.sh`. Verify next-morning backup landed in Wasabi + is restorable in a test DB. | Prod-readiness | 0.5 d |

**Deploy gate:** `tenant-isolation.test.ts` still green. k6 still green. `/audit` P0+P1 count = 0. `/security-review` Critical+High count = 0. Last-night backup verified restorable.

**What this session does NOT touch:** Phase 2 scope (AI bot builder,
website crawler, guided flow editor, live preview, one-click WhatsApp
deploy). If pilot feedback demands this, open a Phase 2 planning doc rather
than scope-creeping Session 3.

---

## 4. Out of scope for Phase 1 (do not attempt in these sessions)

These items are asked for by your internal *Quickstart Guide PDF* but are
explicitly Phase 2 per the original spec (§4). They should NOT land inside
any of the three sessions above:

- Native Shopify-branded connector preset (fields: store URL + `shpat` token)
- WhatsApp sidebar page with phone-number connect + verify + business profile + greeting + Off/Live toggle
- Bot personality picker
- Conversation flow editor
- Live bot preview / chat simulator
- One-click WhatsApp deploy
- AI website crawler
- AI knowledge-base generator

Instead, during pilot onboarding (task 3.9) use
[NO_CODE_CHATBOT_PLAYBOOK.md](NO_CODE_CHATBOT_PLAYBOOK.md) — Landbot glues
WhatsApp ↔ ALIGNED read API in a no-code way until Phase 2 ships.

---

## 5. Ordering constraints

- **Session 1 → Session 2 → Session 3.** Do not reorder.
- Within a session, tasks can be reordered freely as long as their local
  dependencies hold.
- Session 3 cannot start without Session 1 + 2 landing on `main`, because
  the `/audit` and `/security-review` passes should cover the finished
  product, not a half-done one.

---

## 6. Definition of done (Phase 1 declared truly complete)

Phase 1 is done when **all** of the following are true:

- [ ] Every A, B, C item above is either closed or explicitly moved to a Phase 2 backlog with reason
- [ ] §7.1 criteria either hold or are amended (D1, D2) and the amendment is committed
- [ ] `app.aligned.com` has served a real pilot's traffic for at least 7 continuous days with `/health` uptime ≥ 99.9%
- [ ] 3 pilot tenants have completed at least one catalog edit that reached a real WhatsApp end-user via their chosen bot (Landbot or otherwise)
- [ ] Tenant-isolation test is green on every commit merged to `main`
- [ ] `/security-review` Critical + High count = 0
- [ ] `/audit` P0 + P1 count = 0
- [ ] Nightly backup has run successfully for 14 consecutive days
- [ ] Quickstart doc published that matches shipped functionality (no over-promising)

Until every box is ticked, status is **"feature-complete, not yet launched."**

---

## 7. Resume checklist (read this at the start of any session)

1. `git status` — confirm no stray work.
2. Scroll to §3 above. Pick the next unfinished session.
3. Read CLAUDE.md §5 "Current Status" for runtime state (deployed? migrated?).
4. Work tasks top-to-bottom in the chosen session.
5. Check off completed tasks in this file by changing `| **1.1** ...` to `| ~~**1.1** ...~~` so progress is visible.
6. At end of session, update CLAUDE.md §5 with the session completed + what's next.
7. Never re-open scope that was closed in a previous session. If a new gap
   is discovered, append it to §1 here rather than silently fixing it.

---

*Last updated: 2026-04-24 · Companion to [PHASE_1_OVERVIEW.md](PHASE_1_OVERVIEW.md) and [NO_CODE_CHATBOT_PLAYBOOK.md](NO_CODE_CHATBOT_PLAYBOOK.md).*
