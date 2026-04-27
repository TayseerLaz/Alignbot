# Phase 2 + Phase 3 — Build plan (3 sessions)

> **Companion to:** [PHASE_1_GAP_CLOSE.md](PHASE_1_GAP_CLOSE.md). Phase 1 is
> shipped + live. The 7 codeable partials closed in the 2026-04-27 batch.
> This doc plans the remaining 31 codeable ❌ items across three sessions.
>
> **Manual / external items (out of scope here):** the 9 ⚠️ partials that
> need ops actions (UptimeRobot account, external k6, paying tenants,
> WCAG cert) are picked up by the operator separately.

---

## 1. What's left to build (31 items)

| Bucket | Spec ref | Item count |
|---|---|---|
| **Phase 3 inbox rest** | §5.1.1 #29–35 | 7 |
| **Phase 3 Meta deep features** | §5.1.2 #36, #38, #41, #42 | 4 |
| **Phase 3 billing** | §5.1.3 #43–48 | 6 |
| **Phase 3 SaaS polish** | §5.1.4 #51, #53 | 2 |
| **Phase 2 AI bot builder** | §4.1.1–§4.1.3 #16–26 | 11 + #27 already partial |
| **Total** | | **31** |

---

## 2. Session 4 — Inbox completion + Meta upgrades (~2 days)

**End-of-session demo:** A client agent uses `/inbox` like a real
customer-engagement tool. They open a conversation, see status / tags /
assignment, leave an internal note, paste a canned response, and reply
with media. The bot can hand off cleanly, search works across all chats,
and the Meta side now supports message templates + media.

**Why this first:** highest customer-visible value per dev-day. Builds
directly on the inbox MVP that's already live. Unblocks ALIGNED selling
the platform as a "customer engagement hub" instead of just a data layer.

| Task | Spec # | What lands |
|---|---|---|
| **4.1** Per-conversation status field (Open / Pending / Resolved / Escalated) on a new `WhatsAppThread` table keyed by (org, customer phone). Migration + Prisma. | §5.1.1 #31 | DB + status filter on inbox |
| **4.2** Tag system: `WhatsAppThreadTag` join table, freeform tag names, tags shown as chips on inbox cards. | §5.1.1 #31 | Tag chip filter |
| **4.3** Assignment: `assignedToUserId` on threads + auto-round-robin endpoint that picks the next active member. UI: "Assign to" dropdown in thread header. | §5.1.1 #30 | Assignment dropdown + activity row in thread |
| **4.4** Internal notes: `WhatsAppNote` table, `noteVisibility='internal'`. Note bubbles render in the thread view but are never sent to Meta. | §5.1.1 #29 | Note UI toggle on the reply box |
| **4.5** Canned responses: per-org library at `/whatsapp/canned-responses` (CRUD), insert button in the reply box, `{first_name}` `{order_id}` style template variables. | §5.1.1 #32 | Canned-response menu |
| **4.6** Bot-to-human handoff: `POST /whatsapp/threads/:phone/handoff` (auth: API key OR user). Sets thread status to `Pending`, posts an internal note "Bot escalated: <reason>", emits a notification. | §5.1.1 #33 | Endpoint + bell notif |
| **4.7** Conversation search: full-text on `whatsapp_messages.body` via pg_trgm GIN index. `GET /whatsapp/threads?q=…&status=…&tag=…&assignee=…`. | §5.1.1 #34 | Search bar in inbox |
| **4.8** Media support — upload images/docs to Wasabi (existing storage) → send via Meta `messages` API with `media_id` from a Meta upload step. Inbound media URLs proxied through a signed-URL GET so they don't leak Meta's tokens. | §5.1.2 #41 | Image/doc bubbles + attach button |
| **4.9** Message templates module: `WhatsAppTemplate` table, list / create / submit-for-approval, status (`pending` / `approved` / `rejected`). Submission calls Meta's `/templates` endpoint. | §5.1.2 #38 | Templates page; Send-template flow |
| **4.10** Outbound rate-limit queue: BullMQ `whatsapp-send` queue with token-bucket per WABA. Replaces direct fetch in `/whatsapp/send`. | §5.1.2 #42 | Queue tab in admin panel |
| **4.11** Real-time inbox via short-poll (8 s default, 2 s when a thread is open). WebSockets deferred to Session 7. Document the trade-off in the page. | §5.1.1 #35 (partial) | Already ships in current MVP — extend with thread-level poll |
| **4.12** Org-wide notification bell triggers on (a) new inbound from unassigned thread, (b) handoff event. | (cross-cut) | Notification kinds added |

**Items NOT closed by Session 4:**
- §5.1.1 #35 *real-time* read receipts + typing indicators (needs WebSockets — defer to a separate Session 7 if needed)
- §5.1.2 #36 Meta business verification *guided workflow* — moved to Session 6 alongside other Meta polish
- All Phase 2 (#16–#26)
- All billing (#43–#48)

**Deploy gate:** Existing tenant-isolation test stays green. New integration
test: assignment is RLS-isolated; an internal note never appears in the
read API or in `/whatsapp/messages` outbound view; canned-response
template variables substitute correctly.

---

## 3. Session 5 — Billing + revenue dashboards (~2 days)

**End-of-session demo:** A new client signs up → starts a 14-day trial →
chooses a plan → gets charged via Stripe → sees usage metering hit caps
→ admin sees MRR + churn in the ALIGNED revenue dashboard. Hard caps
prevent runaway usage on the wrong plan.

**Why second:** unlocks "we can sell this." Without billing, every Phase
3 pilot stays free. Billing is well-trodden territory (Stripe), so risk
is implementation discipline, not novelty.

| Task | Spec # | What lands |
|---|---|---|
| **5.1** `Plan` table seeded with Starter / Growth / Enterprise (configurable via env or admin UI). Each plan has caps: products, services, members, monthly messages, monthly imports, API keys, webhook endpoints. | §5.1.3 #43 | Plan model + admin CRUD |
| **5.2** `Subscription` table per org: `planId`, `status` (`trialing` / `active` / `past_due` / `cancelled`), `stripeSubscriptionId`, `trialEndsAt`. | §5.1.3 #43 | Org auto-assigned to free trial on signup |
| **5.3** Stripe integration: server-side SDK init, **Checkout Session** for plan selection, **Customer Portal** link for self-serve management, webhook receiver for `customer.subscription.updated/deleted`, `invoice.payment_succeeded/failed`. | §5.1.3 #44 | `/billing/checkout`, `/billing/portal`, signed inbound `/webhooks/stripe` |
| **5.4** **Usage metering**: `UsageEvent` table (org, kind, count, occurredAt). Increments on every product write, service write, message send, API call. Daily roll-up job into `UsageMonthly`. Caps enforced via middleware that 402s once a hard cap is breached. | §5.1.3 #45 | Cap middleware + daily roll-up cron |
| **5.5** Trial flow: 14-day trial begins on signup; banner counts down; auto-converts to selected plan or auto-downgrades to "Free" tier (read-only) at expiry. Email reminders at T-3 and T-0. | §5.1.3 #46 | Trial banner + reminder cron |
| **5.6** Client billing dashboard at `/settings/billing`: current plan, usage bars vs caps, next invoice date, "Change plan" button → Stripe Checkout. | §5.1.3 #47 | New tab in settings |
| **5.7** ALIGNED revenue dashboard at `/aligned-admin/revenue`: MRR, plan distribution, churn last 30 d, revenue per tenant, growth trends. Reads from `Subscription` + Stripe API. | §5.1.3 #48 | Admin dashboard panel |
| **5.8** Lock the org from new signups when org status is `suspended` for non-payment. Admins can still log in (read-only) to update payment method. | (cross-cut) | Soft-suspend hook |

**Items NOT closed by Session 5:**
- White-label (#51) — moved to Session 6
- Client analytics (#53) — partially overlaps with usage metering, but full implementation in Session 6
- All Phase 2

**Deploy gate:** Stripe webhook signature verified; trial expiry job
runs idempotently; cap middleware test (write product when at cap →
402); revenue dashboard returns correct MRR for a seeded multi-plan
fixture.

---

## 4. Session 6 — Phase 2 AI bot builder MVP + Phase 3 polish (~3 days)

**End-of-session demo:** A client clicks "Build my bot" → enters their
website URL → AI crawls + extracts → client reviews the auto-generated
KB + bot personality → tests in the embedded chat simulator → clicks
deploy. White-label settings (logo + accent colour) flow through the
portal. A client analytics dashboard shows real engagement metrics.

**Why last:** highest novelty + cost (LLM API), highest ambiguity
(crawler robustness, KB accuracy targets), and benefits from the inbox +
billing being done first (so the AI bot has a place to escalate to).

**Honest scoping:** a full 4-module Phase 2 (per the original PDF) is
~13–17 dev-days. This session ships the **MVP** — modules 1, 2, and 3,
with module 4 (full QA + 85% accuracy benchmark) deferred to a follow-up
hardening pass.

| Task | Spec # | What lands |
|---|---|---|
| **6.1** Website crawler: BullMQ `crawl` queue, headless Playwright (or Puppeteer-via-undici for simpler HTML pages), depth-limited (max 30 pages), respects robots.txt + sitemap.xml. | §4.1.1 #16 | New worker module |
| **6.2** Content extraction: strips boilerplate (nav/footer), extracts product/FAQ candidates, dumps clean text + page metadata to a `CrawlPage` table. | §4.1.1 #17 | Extraction lib |
| **6.3** LLM-driven analysis: a single `analyzeWebsite` job that fans out (a) tone-detection prompt, (b) FAQ-extraction prompt, (c) product-extraction prompt against the crawled corpus. Uses Anthropic Claude Sonnet 4.6 (per CLAUDE.md "default to latest"). | §4.1.1 #18, #19 | KB rows persisted |
| **6.4** Smart questionnaire: dynamic — 5–10 questions chosen based on what the LLM couldn't infer. Stored on `BotConfig` (per-org). | §4.1.2 #20 | Questionnaire UI |
| **6.5** Bot personality picker: 4 AI-suggested presets (Formal / Casual / Friendly / Clinical) + customise. Renders as cards. | §4.1.2 #21 | Personality picker |
| **6.6** Conversation flow editor — **MVP:** form-based (not drag-and-drop) for the 5 canonical paths (greeting / product inquiry / booking / support / escalation). Drag-and-drop is a later polish. | §4.1.2 #22 | Editor UI |
| **6.7** Response templates: AI-drafted, client edits inline before publish. | §4.1.2 #23 | Template review pane |
| **6.8** Chat simulator: embedded `<iframe>`-style preview that POSTs to a server-side `/bot/simulate` endpoint. The endpoint runs the same LLM stack with the org's KB + personality + flow as system prompt. | §4.1.3 #24, #25 | Live preview |
| **6.9** Test scenarios: 5 pre-written transcripts run automatically; LLM-as-judge scores response accuracy, displays a per-scenario score. | §4.1.3 #26 | Scenario runner |
| **6.10** One-click deploy *(real this time)*: writes a `BotDeployment` row + flips the WhatsApp channel's `isActive`. Inbound messages now route to a `bot-runtime` worker that loads the org's BotConfig + KB and replies via the existing `/whatsapp/send` queue from Session 4. | §4.1.3 #27, §5.1.1 #33 | Bot actually replies |
| **6.11** Meta business verification guided workflow: in-portal stepper that tells the client what to do in Meta Business Manager, with a "I've completed step N" button that records progress. Doesn't *do* the verification — Meta gates that. | §5.1.2 #36 | New page |
| **6.12** White-label: logo upload (Wasabi), accent colour picker, custom CNAME field (just stored — DNS is the user's job, validated by hitting `/health` on the CNAME). | §5.1.4 #51 | Branding tab in settings |
| **6.13** Client-facing analytics: `/analytics` page — message volume (24 h / 7 d / 30 d), bot resolution rate (handoff count vs total inbound), avg response time, top customer queries (LLM-clustered from `whatsapp_messages.body`). | §5.1.4 #53 | Analytics dashboard |

**Items NOT closed by Session 6:**
- 4.1.3 conversation flow editor as **drag-and-drop** (form MVP only)
- WebSocket real-time read receipts (Session 7 if needed)
- Phase 2 §15 launch QA (separate testing pass)

**Deploy gate:** Crawler runs against the demo `pilot-cafe` site →
generates a non-empty KB → simulator answers a "what are your hours"
question correctly. Tests assert KB is org-scoped (RLS) and that the
crawler refuses non-public URLs (SSRF guard already in place).

---

## 5. After Session 6 — what remains

| Status | Items | Notes |
|---|---|---|
| ⚠️ Partial only because of external action | #54 UptimeRobot live, #61 + #70 external k6 run, #63 100×10K stress test, #64 99.9% monitor live, #78 50+ paying tenants no leakage, #66 formal WCAG cert, #9 markdown vs HTML decision | Operator picks these up per `SESSION_3_OPS_CHECKLIST.md` |
| ❌ Deferred polish | drag-and-drop flow editor, WebSocket realtime, Phase 2 module-4 accuracy benchmarking to 85% | Tier 5 — after live pilot feedback |

Phase 1: 100% code-done.
Phase 3: 100% code-done after Session 5.
Phase 2: MVP code-done after Session 6; benchmark hardening still TBD.

---

## 6. Effort + risk

| Session | Effort | Risk | Mitigation |
|---|---|---|---|
| Session 4 | ~2 dev-days | Low — extends existing inbox + Meta surfaces | Most code is CRUD + UI; new dependency: Wasabi → Meta media upload chain has Meta-specific quirks (see Meta upload-id flow) |
| Session 5 | ~2 dev-days | Medium — Stripe webhooks + idempotent cap enforcement need care | Use Stripe's webhook signature library; cap-write tests run inside the same transaction as the write |
| Session 6 | ~3 dev-days | High — LLM costs, crawler reliability on JS-heavy sites, KB-accuracy variance | Cap LLM tokens per org per day; allow client to paste content as fallback when crawl is thin; defer the 85% accuracy bar to a follow-up tuning pass |

---

## 7. Resume checklist

1. Pick the next session from §2 / §3 / §4 above.
2. Cross-check against [PHASE_1_2_3_STATUS_2026-04.md](PHASE_1_2_3_STATUS_2026-04.md) — confirm an item still ❌ before building it.
3. Each session ends with: typecheck green, deploy-gate test green, push to `main`, GitHub Actions deploy succeeds, smoke-test the new endpoints.
4. After deploy, update the status doc: ❌ → ✅ for each closed line item.
5. Append a one-liner to `CLAUDE.md §5 Current Status`.

---

*Last updated: 2026-04-27 · Companion to [PHASE_1_GAP_CLOSE.md](PHASE_1_GAP_CLOSE.md) and [SESSION_3_OPS_CHECKLIST.md](SESSION_3_OPS_CHECKLIST.md).*
