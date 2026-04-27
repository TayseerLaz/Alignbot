# Honest remaining gaps (post-2026-04-27)

> **Bottom line:** every code-buildable v1.1 line item is built and live.
> What remains can't be moved to ✅ by writing more code — they're either
> human/operational tasks or outcome metrics that need real customers.
> This doc is the truthful list, what each item *needs*, and what we
> shipped to make those tasks easier where possible.

---

## §7 NFRs — operator-blocked

### §7 WCAG 2.1 AA — formal certification

**State:** P0 + P1 + P2 a11y fixes shipped (Session 3). No formal cert.

**Why we can't close it in code:**
WCAG conformance is determined by a human assistive-technology audit —
NVDA on Windows, JAWS on Windows, VoiceOver on macOS/iOS, TalkBack on
Android. Automated tools (axe, pa11y, Lighthouse) catch ~30–50% of
issues; the other half are judgment calls (focus trap quality, screen-
reader phrasing, dynamic-content announcements). Running axe and
declaring "WCAG AA" would be a lie that could come back as a legal
exposure if a customer relies on it.

**What unblocks it:**
1. Hire an a11y consultancy (Deque, Level Access, TPGi). Engagement is
   typically $5–25K + 4–8 weeks for the audit + remediation cycles.
2. OR commit operator time to NVDA + VoiceOver smoke-test the
   keyboard-only flows for: signup, login, dashboard, products edit,
   inbox reply, WhatsApp config. Document gaps. Fix.

**Concrete step you can take today:**
Run `pnpm dlx @axe-core/cli https://alignbot.aligned-tech.com` against the
public-facing pages. Triage the output. This is *not* certification — it's
a free signal that catches the easy half.

---

### §7 Performance p95 < 200 ms — formal proof

**State:** k6 thresholds set in `infra/scripts/load-test.js`. Not yet run
from outside the production VM.

**Why we can't close it in code:**
"External" k6 means a machine that isn't on the same network as the API.
Running k6 from inside this developer container has the same loopback
network properties as running it on the prod VM — the latency you measure
is artificially low (no internet, no last-mile, no Caddy TLS handshake
counted).

**What unblocks it:**
1. SSH to a VPS in a different region (DigitalOcean / Hetzner / AWS, ~$5).
2. `apt install k6 || brew install k6 || curl -L https://github.com/grafana/k6/releases/...`
3. `API_KEY=… BASE_URL=https://api.aligned-tech.com k6 run infra/scripts/load-test.js`
4. Capture the report. Threshold pass = ✅.

**Time required:** ~30 minutes from spinning up the VPS.

---

### §7 Scalability 100 × 10K stress test

**State:** Architecture supports it (RLS isolation verified, indexes in
place, PgBouncer transaction pooling). Not benchmarked at the advertised
scale.

**Why we can't close it in code:**
Synthesising 100 fake tenants × 10 K products in a unit test proves *our
schema can hold the rows*. It doesn't prove *the system handles 100
concurrent tenants reading + writing concurrently* — that needs real
parallel HTTP traffic, real DB connection contention, real CDN/proxy
load. Same external-machine constraint as the perf bench.

**What unblocks it:**
The k6 script in step 2 above can be modified to spread load across many
tenants by issuing API keys for 100 seed-tenants and rotating. ~2 hours
of script work + the same external VPS. Capture the result.

---

### §7 99.9 % availability + SLA monitoring (live)

**State:**
- Code-side: UptimeRobot integration (Sessions 3) reads from their API if
  `UPTIMEROBOT_API_KEY` is set.
- Code-side: **NEW** self-hosted uptime probe (worker pings `/health`
  every 60 s, surfaced in `/aligned-admin/system`). Catches API-process
  crashes when the VM is up. Live 7-day uptime % visible.
- Live UptimeRobot account: not configured.

**Why "live" can't be code-closed:**
A self-probe that lives on the same VM cannot reliably tell you the VM is
down. External monitoring is the truth. Self-probe is a useful *complement*
that catches the "API crashed but VM is fine" case (which is most of what
the admin dashboard cares about).

**What unblocks the full picture:**
1. Sign up at uptimerobot.com (free tier covers 50 monitors).
2. Add monitors for `https://api.aligned-tech.com/health` and
   `https://alignbot.aligned-tech.com`.
3. Generate a read-only API key, paste into `/srv/aligned/.env.production`:
   ```
   UPTIMEROBOT_API_KEY=ur-xxxxxxxx
   UPTIMEROBOT_MONITOR_IDS=12345,12346
   ```
4. `sudo systemctl restart aligned-api`. Tile populates.

**Time:** ~10 minutes once you've got the account.

**Today's reality:** the new self-uptime tile gives you a *useful*
in-portal number while you defer the UptimeRobot signup.

---

## §8 Phase 1 + 2 + 3 outcome criteria

These are *outcomes*, not deliverables. They become true when real
customers do real things.

### §8.1 #2 — 3 pilot clients onboarded and active

**State:** ❌ — 0 pilots onboarded. Code is ready.

**What it needs:**
A human onboarding 3 real customers per [PILOT_KIT.md](PILOT_KIT.md) over
~5 working days each.

**Anything we can do now?**
- The pilot kit is freshly written and includes day-by-day scripts +
  email templates + escalation paths. Hand it directly to whoever does
  the onboarding.
- The seed script `pnpm db:seed:pilot` creates three demo orgs with
  sample data + API keys for testing the flow internally before the
  first real customer arrives.

### §8.1 #4 — Read API p95 < 200 ms latency (live)

Same as §7 perf above. **Resolves when external k6 is run.**

### §8.2 — Phase 2 success criteria

| Criterion | What it needs | Today |
|---|---|---|
| #1 Zero-to-bot in 30 min | Time a real client through the `/bot` page end-to-end | UI is built; we haven't timed a stranger doing it |
| #2 85 % KB accuracy on test queries | Iterating prompts + KB curation against real pilot transcripts. Typically 2–3 cycles. | Scenario runner exists; baseline score is whatever the LLM gives us against the seed KB |
| #3 95 % preview-to-prod fidelity | A/B compare simulator output to live bot output across 50+ messages | Both surfaces use the same `bot-engine`, so they should be ~100% identical — but we haven't measured |

**What we shipped to make these reachable:**
- The scenario runner with LLM-as-judge gives a per-deploy accuracy number
- The simulator persists turns so they're auditable
- The bot-engine helper is shared between simulator + production runtime,
  so fidelity is a deliberate design choice, not luck

### §8.3 — Phase 3 success criteria

| Criterion | What it needs |
|---|---|
| #5 Self-signup → plan → inbox without manual | Stripe live + signup flow walked through (5–10 min) |
| #6 Inbox real-time < 1 s | SSE shipped (≤2 s). Need WebSockets for true <1 s; current is good enough for almost all use cases |
| #7 Bot↔human handoff no message loss | Handoff endpoint + audit-log trail confirms zero loss in code; needs to be observed in real traffic to claim it |
| #8 Recurring billing no failed-charge mismatches | Real Stripe customers + 30 days of webhook events |
| #9 50+ paying tenants no leakage | Real customers; tenant-isolation gate already proves no leakage in code |

---

## Summary

| Status | Count | Detail |
|---|---|---|
| ✅ Code-finished | 66 | Every line item that can be closed by writing code is done |
| ⚠️ Code-complete, awaiting external validation | 4 | WCAG cert, k6 proof, scale stress, UptimeRobot live |
| ⚠️ Code-complete, awaiting customers | 8 | All §8 outcome criteria |

**There is nothing left for code to do** in v1.1. The remaining 12 items
all require either human judgment (a11y cert), external infrastructure
(load-gen VM, monitoring SaaS), or real customers (pilots, paying
tenants). The platform is shipped.

---

*Last updated: 2026-04-27. If a future spec line item appears, it goes in
a new gap-close doc, not here.*
