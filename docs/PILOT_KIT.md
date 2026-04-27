# ALIGNED Pilot Kit

> **What this is:** the operator's playbook for taking a brand-new client
> from "interested" to "their bot is replying on WhatsApp" in 5 working
> days. Hand the client-facing parts (Days 1–3) directly; keep the
> operator-only parts (T-minus, success criteria, escalation) for yourself.
>
> **Companion docs:** [SESSION_3_OPS_CHECKLIST.md](SESSION_3_OPS_CHECKLIST.md)
> for prod deploy state · [NO_CODE_CHATBOT_PLAYBOOK.md](NO_CODE_CHATBOT_PLAYBOOK.md)
> for the no-code WhatsApp pattern · [PHASE_1_2_3_STATUS](PHASE_1_2_3_STATUS_2026-04.md)
> for current spec coverage.

---

## 0. Pre-flight (operator-only — do this once before *any* pilot)

1. **Confirm prod is healthy.**
   - https://api.aligned-tech.com/health → 200
   - https://alignbot.aligned-tech.com → loads login
   - `/aligned-admin/system` shows queue depth = 0, no auto-disabled webhooks
   - Self-uptime tile shows ≥99.9% over 7 days (or wire UptimeRobot)
2. **Confirm Stripe is live** (only required if the pilot will pay).
   - `STRIPE_SECRET_KEY` + `STRIPE_WEBHOOK_SECRET` set in `/srv/aligned/.env.production`
   - Stripe webhook endpoint configured at `/api/v1/webhooks/stripe`
   - Plans synced via `/aligned-admin/plans/sync-stripe`
3. **Confirm Anthropic is live** (only required for the AI bot builder).
   - `ANTHROPIC_API_KEY` set in env
   - `/bot/simulate` doesn't 503
4. **Backups** — last cron run succeeded, restore tested in the last 30 days.

If any of the above is red, fix before onboarding. Pilots lose patience fast.

---

## 1. T-minus 1 week (operator + client)

### Send the client this email template

> Subject: Your ALIGNED pilot kicks off [DATE] — pre-flight checklist
>
> Hi [Name],
>
> Excited to get started. Two things to do before our kick-off call on [DATE]:
>
> **1. Start your Meta Business verification today.** Meta takes 3–10 business days to approve, so we need to start now. The 7-step walkthrough is in your portal under **WhatsApp → Meta verification**, but the process is:
>
> - Create a Meta Business account at business.facebook.com
> - Submit business verification (legal name, address, business document)
> - Wait. We can configure everything else while we wait.
>
> **2. Gather data we'll import.** Either:
> - A spreadsheet of your products (any format — we'll map columns), OR
> - Your Shopify / website URL (we'll pull from it), OR
> - Your existing FAQ list / opening hours / policies (paste into a doc)
>
> **3. Pick the WhatsApp phone number** you want customers to message. **It must NOT currently be on the consumer WhatsApp app.** If it is, we'll either delete the consumer account or use a different number.
>
> Talk soon,
> [You]

### Operator-side prep

- [ ] Create a draft tenant in `/aligned-admin` — slug `pilot-<client-shortname>`, name set to client's legal name.
- [ ] Issue a Client-Admin invite to the client's primary contact email.
- [ ] If the client is paying: in Stripe, create a Customer with their email + business name. (The first Checkout will reuse this if email matches.)

---

## 2. Day 1 — Kick-off call (60 min, on a video call)

**Goal:** the client logs in, has at least one product in the catalog, and has filled in their business info.

### Agenda

| Time | What |
|---|---|
| 0–5 | Intro · confirm we have what we need from the email |
| 5–15 | Walk them through the portal: dashboard, sidebar, what each section is for |
| 15–35 | Together, fill in **Business Info** — profile, hours, locations, contacts |
| 35–50 | Either manually add 5 products *or* run a CSV import together |
| 50–60 | Set expectations for Day 2–3 (Meta wait + bot config) |

### Specifically click through, in order

1. `/dashboard` — explain the widgets
2. `/business-info → Profile` — fill in legal name, tagline, currency, timezone
3. `/business-info → Hours` — set opening hours per weekday
4. `/business-info → FAQs` — add 3 starter FAQs (if they have any)
5. `/business-info → Policies` — at minimum, add a returns + privacy policy
6. `/products` — either:
   - Click **New product** and add 1–3 manually, or
   - Click **Imports → New import → Products** and walk through the CSV wizard
7. `/api-keys` — issue a key named `pilot-bot` with all three read scopes. **Save the secret to a 1Password entry the client + you can both access.**

### Don't do on Day 1

- Anything in `/whatsapp` — Meta isn't approved yet, save it for Day 3
- The AI bot builder — too much new ground in one call
- Stripe upgrade — they're on the 14-day Free trial; revisit at end of pilot

---

## 3. Day 2 — Catalog completion (async, ~2 hours of client work)

Send this to the client after Day 1:

> ## Your homework before Friday
>
> **2 hours, async — knock it out whenever.** Here's what's missing from your portal:
>
> 1. **Add the rest of your products** (or run a CSV import). Goal: ≥10 products in `/products`. Use the spreadsheet template from `/imports → Download template`.
> 2. **Add your top 10 FAQs** in `/business-info → FAQs`. Mark them all "public" (the bot only quotes public ones).
> 3. **Add your contact channels** in `/business-info → Contacts`. At minimum: phone, email. The bot uses these for "how do I reach a human" questions.
> 4. **Take a screenshot of your dashboard** and email it back when you're done — I'll check the data is bot-ready.
>
> Stuck on anything? Reply to this email.

### What you do while they're working

- [ ] Check Meta verification status — should be in progress.
- [ ] If you're using the AI bot builder: in `/bot`, click **Analyze website** with the client's URL. The crawler + LLM run while they're filling the catalog. Saves a real-time call.
- [ ] Eyeball the imported data via `/audit-log` to spot anomalies.

### Day 2 health check

By end of day Friday, the client's `/dashboard` should show:
- Products: ≥10
- FAQs: ≥10
- Last activity: <1 hour ago
- API key: 1 issued

If anything is 0 or stale, ping them before the weekend.

---

## 4. Day 3 — WhatsApp connection (30 min call)

**Pre-condition:** Meta verification is approved (you'll get the email from Meta).

### What to do together

1. **Meta side** (15 min):
   - Open developers.facebook.com, the app you created, WhatsApp → API Setup
   - Copy: WABA ID, Phone Number ID, App ID, App Secret
   - Generate a System User access token (non-expiring) per Business Settings → Users → System Users
2. **ALIGNED side** (10 min):
   - Open `/whatsapp` in the portal
   - Paste WABA ID + Phone Number ID + App ID + Access Token + App Secret
   - Click **Verify with Meta** → should turn green
   - Copy the Callback URL + Verify Token shown on the page
3. **Meta side again** (5 min):
   - Meta app → WhatsApp → Configuration → Webhooks
   - Paste Callback URL + Verify Token, click **Verify and save**
   - Subscribe to the `messages` field
   - **Subscribe the app to the WABA** (further down on the same page)

### Test from your phone

1. From a tester phone (added in Meta as a tester), message the business number
2. In the portal: `/inbox` should show the message within 2 seconds
3. Reply from the inbox → check it lands on the tester phone

If any step fails, the playbook in [NO_CODE_CHATBOT_PLAYBOOK.md Part 7](NO_CODE_CHATBOT_PLAYBOOK.md#part-7--end-to-end-test-from-your-own-phone) has the standard failure modes.

---

## 5. Day 4 — Bot configuration (60 min call)

**Goal:** the bot is in "preview" mode and the client has tested at least 5 conversations in the simulator.

### If using the in-platform AI bot builder

1. `/bot` → review the auto-generated knowledge base from Day 2's analyze. Click **Approve all** if it looks good, or edit individual entries.
2. Pick a **Personality** preset (Friendly is the default — usually right for retail).
3. Write a **Greeting** — e.g. "Hi! Welcome to [Brand]. How can I help today?"
4. Write a **Handoff fallback** — what the bot says when it needs a human.
5. Run the **Test scenarios** (`/bot → Run all`). Need ≥85% average score. If lower:
   - The KB likely has gaps. Add more entries manually.
   - Re-run the website analysis.
   - Re-run scenarios.
6. Use the **Live preview** to chat 5+ exchanges as if you were a customer. Tweak personality/greeting until replies feel right.

### If using Landbot or a client-built bot

Walk through [NO_CODE_CHATBOT_PLAYBOOK.md Parts 5 + 6](NO_CODE_CHATBOT_PLAYBOOK.md#part-5--create-a-landbot-account-and-connect-whatsapp).

---

## 6. Day 5 — Soft launch (30 min call)

1. Click **Deploy bot** in `/bot` (or flip the WhatsApp **Live** toggle).
2. Send a test message from your phone — bot should reply within 3–5 seconds.
3. Set the client's **handoff routing**: who in `/members` handles escalated chats?
4. Set up canned responses (`/inbox/canned`) for the top 5 things they'll need to send manually.
5. Tell the client to start sharing the WhatsApp number on their site / receipts / signage.

### Set the 7-day check-in

> Subject: Day 7 ALIGNED check-in — quick form
>
> Hi [Name],
>
> Hit "reply" with answers to:
>
> 1. How many real customer conversations have you had this week? (Check `/inbox`.)
> 2. What did the bot get **wrong** that you had to fix manually?
> 3. What's one thing you wish the bot could do that it can't?
> 4. Any technical glitches?
>
> If everything's smooth, we'll talk about moving you off the trial onto a paid plan.
>
> Thanks,
> [You]

---

## 7. Success criteria for the pilot (operator)

Tick all these before declaring the pilot "successful" (per amended §7.1):

- [ ] Client has populated catalog (≥10 products or services)
- [ ] Client has populated business info (hours, FAQs, policies)
- [ ] WhatsApp number is verified by Meta + connected to ALIGNED
- [ ] Bot is **deployed** AND has handled ≥1 real customer conversation autonomously
- [ ] `/audit-log` shows the client logging in and editing on at least 3 different days
- [ ] At Day-7 check-in, client gives **1+ piece of positive feedback** and **0 blocking complaints**
- [ ] Read API p95 over the pilot's traffic stays under 200 ms
- [ ] No cross-tenant test in CI has gone red

If any are red at Day 14, the pilot has not converted. Either extend by 1 week with a clear "fix this one thing" message, or close and document the learning.

---

## 8. Common things that go wrong

| Symptom | First check | Fix |
|---|---|---|
| Client says "the bot didn't reply" | `/inbox` thread for that customer — was the inbound received? Was a thread auto-assigned to a human? | If thread has `assignedToUserId`, the bot won't reply (by design). Unassign it or have the human reply. |
| Bot replies are wrong / generic | `/bot/scenarios → Run all` — average score | <60: rerun website analysis + add more KB entries. 60–85: edit specific KB entries that scored low. |
| Customer messages don't show in inbox | `/aligned-admin/system` → API traffic / Sentry | Most likely cause: Meta webhook not subscribed, or signature mismatch. Re-verify webhook in Meta. |
| "Plan cap reached" error | `/settings/billing` → usage bars | Upgrade plan via Stripe Checkout, or wait for the next month-roll. |
| Slow replies (>5 s bot latency) | Anthropic dashboard for token-budget rate limits | Either upgrade Anthropic tier or simplify the bot's KB to keep prompts smaller. |
| Inbox shows stale data | Browser console for SSE errors | EventSource auto-reconnects; if persistent, check Caddy/proxy buffering. |

---

## 9. Escalation paths

| Issue | Where it goes |
|---|---|
| Meta business verification stuck >10 business days | Operator emails Meta support with WABA ID. Sometimes fixes in 24h. |
| Stripe webhook signature failing | Check `/srv/aligned/.env.production` `STRIPE_WEBHOOK_SECRET` matches the endpoint in Stripe dashboard. |
| Bot returning hallucinated info | `/bot → Knowledge base` — find the wrong entry, edit or delete. Re-test scenarios. |
| Client wants drag-and-drop flow editor | Phase 2 polish item. Form-based editor at `/bot` covers the 5 canonical paths today. |
| Client wants media support (send images outbound) | **Live in `/inbox` reply box** as of Apr 27 2026. Click the paperclip icon. |
| Client wants white-label CNAME | `/settings/branding` accepts the CNAME; client points DNS at `alignbot.aligned-tech.com`. |
| Client wants SLA guarantee in writing | Refer to amended §7.1 and the legal contract. We do **not** currently have a paid SLA tier. |

---

## 10. After the pilot

If converted:
- Move the org to a paid Stripe plan via `/settings/billing` (client-driven) or admin push.
- Update the client's record in your CRM with: starting plan, WhatsApp volume/month, primary use case, contact preferences.
- Add to the operator log so the next pilot can reference patterns.

If not converted:
- Set the org status to `suspended` in `/aligned-admin/orgs` (data preserved for 90 days).
- After 90 days, hard-delete via `/aligned-admin/orgs/:id`.
- Write a short post-mortem: why didn't they convert? Document for product roadmap.

---

*Last updated: 2026-04-27 · Use this with `SESSION_3_OPS_CHECKLIST.md` (deploy) and `NO_CODE_CHATBOT_PLAYBOOK.md` (Landbot path).*
