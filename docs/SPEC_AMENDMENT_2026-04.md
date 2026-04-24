# Spec amendment — ALIGNED Business Platform v1.0 → v1.1

> **Status:** accepted 2026-04-24
> **Supersedes:** §7.1 "Phase 1 Success Criteria" in *ALIGNED Business Platform — Project Details* (Version 1.0, April 2026)
> **Scope of change:** wording only — no change to delivered functionality.

## Why

The original §7.1 commits Phase 1 to success criteria that reference a
"WhatsApp chatbot" that Phase 1 never scoped for build. The spec itself
acknowledges this in §4 (Phase 2 — AI-Powered Bot Builder) where the bot
is explicitly deferred. The two sections are internally inconsistent —
Phase 1 delivers a **data platform with a chatbot-facing read API**; the
chatbot itself is built by a separate integration (client-hosted tool like
Landbot, an ALIGNED-built bridge, or — when shipped — Phase 2). Shipping
Phase 1 "done" without amending §7.1 would misrepresent scope.

## The amendment

The bullet list in §7.1 is replaced with the following. Everything else in
the document is unchanged.

### 7.1 Phase 1 — Success criteria (amended)

1. **Self-serve onboarding in 5 minutes.** A new client can sign up,
   verify their email, log in, and see the dashboard with a populated
   getting-started checklist — no ALIGNED staff intervention.

2. **Catalog round-trip in 5 minutes.** From the dashboard, the client
   can create or import at least one product, one service, their opening
   hours, and three FAQs. Changes appear in the **chatbot read API**
   (`/api/v1/read/*`) within 60 seconds (Redis cache invalidation) or
   immediately on a cold point-read.

3. **Read API performance.** Under a k6 load test at **500 req/s** across
   the five chatbot-facing endpoints, measurements must meet:
   - p95 latency **< 200 ms**
   - p99 latency **< 400 ms**
   - error rate **< 1 %**

4. **Tenant isolation hard gate.** A dedicated integration test creates
   two organisations, attempts every cross-tenant read path we can name,
   and fails the deploy if any leak is detectable. This test must be green
   on every merge to `main`.

5. **3 pilot tenants using the platform.** Three paying (or pilot-signed)
   clients have (a) a populated catalog, (b) at least one API key issued,
   and (c) a bot integration reading via that key — regardless of whether
   the bot is Landbot-hosted, ALIGNED-bridge-hosted, or a client-owned
   implementation. Phase 1's scope is the data platform; the bot itself is
   out of scope.

6. **Zero data loss during import/sync.** Re-running an import of the
   same file is idempotent (SKU / slug / singleton upserts); malformed
   rows are rejected with structured errors and downloadable as CSV; the
   tenant's existing data is never silently mutated by a sync failure.

7. **Operational readiness.** Daily backups run on a cron; a test restore
   has been completed at least once before pilots onboard; `/health`
   returns 200 over any 24-hour window with ≥99.9 % uptime.

### Retired criteria (archived — do not re-enable without re-scoping)

The original v1.0 bullets are retained here for audit clarity. They are
**no longer binding** as of this amendment.

- *v1.0 §7.1 #1:* "Clients can independently log in, import data (manual
  or API), and see it reflected in **WhatsApp bot responses** within 5
  minutes."
  **Why retired:** references a bot that Phase 1 does not build. The
  *data-side* of this criterion (edit → visible to a bot via the read
  API in <60 s) is preserved in the amended #2.

- *v1.0 §7.1 #4:* "WhatsApp chatbot successfully reads from the platform
  with **<200 ms latency**."
  **Why retired:** the latency part is preserved under #3 against the
  read API; the "WhatsApp chatbot" noun is removed because no bot ships
  in Phase 1.

## Effect on other documents

- [CLAUDE.md §5 Current Status](../CLAUDE.md) — no change.
- [PHASE_1_OVERVIEW.md](PHASE_1_OVERVIEW.md) — already aligned; this
  amendment is the upstream source.
- [PHASE_1_GAP_CLOSE.md §6 Definition of Done](PHASE_1_GAP_CLOSE.md) —
  the "chosen bot (Landbot or otherwise)" framing there matches amended
  criterion #5.
- [NO_CODE_CHATBOT_PLAYBOOK.md](NO_CODE_CHATBOT_PLAYBOOK.md) — documents
  the Landbot path by which a pilot satisfies amended criterion #5.

## Phase 2 scope unchanged

Everything in the original §4 (AI bot builder, website crawler, guided
configuration, live preview, one-click deploy) remains Phase 2 scope. When
Phase 2 ships, §7.2 criteria already cover the bot-specific success bars
(30-minute zero-to-bot, 85 % KB accuracy, 95 % preview-to-prod fidelity).

*Authored: 2026-04-24 · Applies to every build on or after this date.*
