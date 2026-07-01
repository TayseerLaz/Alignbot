# Tenant Wallet & Metered WhatsApp Billing — Implementation Plan

> Status: APPROVED DESIGN — ready to implement. Last updated: 2026-07-01.
> Owner decisions captured from the 2026-06-25 planning session.
>
> **Update 2026-07-01:** (1) default per-message price is now **$0.08**, HQ-changeable per tenant
> (§1.2, §4.1); (2) added a dedicated tenant-facing **"Billing & Overview"** page spec — plan, wallet,
> monthly cost, spent vs. remaining, ≈ messages remaining, AI messages remaining, and every other plan
> limit (§16); (3) rollout now **backfills all already-onboarded tenants** (lexy, ziid, …) to the
> $0.08 default and **refreshes the cost figure they already see** to the new price (§14.8, §10).

## 0. Goal (one sentence)
Give each tenant a **prepaid wallet** (topped up manually by ALIGNED HQ) and charge an
**admin-set, per-tenant price per WhatsApp template message** (broadcasts, sequences, manual/test
template sends) — with a hard balance guard, exact margin tracking (your price vs Meta's cost), and
full visibility for both the tenant and HQ.

## 1. Locked decisions
1. **Wallet carries over** month to month (no reset). Top-ups are manual HQ actions reflecting an
   offline payment. Balance **never goes negative**.
2. **Price per message is per-tenant, admin-set, default $0.08, floor $0.0375** (= the Meta reference
   cost; can't be lower). Margin = price − Meta cost. Every metered tenant — new or backfilled — starts
   at **$0.08** until HQ changes it; HQ can raise or lower it (never below the floor) per tenant at any
   time, and the tenant's displayed cost + "messages remaining" recompute from the new price.
3. **Billable = business-initiated templates only**: broadcasts, sequences/drips, manual + test
   template sends. **AI bot replies are NOT charged** to this wallet (separate AI budget; those are
   free 24h-window service messages).
4. **Charge only successful sends.** Failed / opted-out / skipped recipients are never charged.
5. **Money model = hold → settle → release** (see §3).
   - **Immediate broadcast**: hold full cost at accept-time (enables the "remove N contacts" guard).
   - **Scheduled broadcast + sequences**: check/charge **at send-time** (no upfront hold). At fire
     time, send only what the balance affords; notify if some were skipped for balance.
6. **Both the monthly cap AND the wallet apply.** If a `monthly_message_cap` / `monthly_broadcast_cap`
   is set it still limits volume; the wallet limits spend. Effective limit = min(cap-remaining,
   money/price). Money-only tenants get unlimited caps.
7. **Opt-in rollout**: a tenant with **no wallet row / no price set** behaves exactly as today
   (unmetered, no balance gate). Metering turns on only once HQ sets a price + balance.
8. **Money stored as integer micro-dollars** in `BIGINT` columns (1 USD = 1,000,000 micros;
   $0.0375 = 37,500). All mutations via atomic conditional SQL. Never floats.
9. **Full ledger** of every wallet movement (top-up / hold / settle / release / adjust).

## 2. Money & precision
- Unit: **micro-USD** (`µ$`), `1 USD = 1_000_000 µ$`. Min price = `37_500 µ$`.
- Columns: `BIGINT` (Prisma `BigInt`). Max ≈ 9.2e18 µ$ ≈ $9.2 trillion — safe.
- Display: format `µ$ / 1e6` to 2–4 dp. Round **only at display**, never in math.
- Rounding rule for charges: each message is charged the exact `pricePerMessageMicros` (an integer),
  so totals are always exact integers; no rounding drift.

## 3. Wallet accounting model (double-entry-ish)
Wallet has two integer buckets. Total tenant money = `available + held`.

| Operation | Effect | Invariant |
|---|---|---|
| **Top-up** `amt` | `available += amt` | total += amt |
| **Adjust** `±amt` (admin) | `available ±= amt` (never < 0) | total ±= amt |
| **Hold** `H = N×P` (immediate broadcast accept) | `available -= H; held += H` (only if `available ≥ H`) | total unchanged |
| **Settle** `P` (one successful send) | `held -= P` | total -= P (real charge) |
| **Release** `r` (terminal: unspent remainder) | `held -= r; available += r` | total unchanged |
| **Charge-at-send** `P` (scheduled/sequence successful send) | `available -= P` (only if `available ≥ P`) | total -= P |

Per immediate broadcast: `H == Σ settles + release` → `held` returns to 0 after completion.
`available` can never go below 0 because both `hold` and `charge-at-send` are conditional on
sufficient funds.

"Spent" (lifetime / monthly) = Σ settles + Σ charge-at-send = Σ ledger debits.

## 4. Data model (Prisma + migration)

### 4.1 `TenantWallet` (one per org; opt-in — absence = unmetered)
```
model TenantWallet {
  id                        String   @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  organizationId            String   @unique @map("organization_id") @db.Uuid
  availableMicros           BigInt   @default(0) @map("available_micros")
  heldMicros                BigInt   @default(0) @map("held_micros")
  pricePerMessageMicros     BigInt   @default(80000) @map("price_per_message_micros")  // default $0.08; ≥ metaCostMicros
  lowBalanceThresholdMicros BigInt   @default(0) @map("low_balance_threshold_micros")
  // Snapshot of the Meta reference cost when the price was set (for margin).
  metaCostMicros            BigInt   @default(37500) @map("meta_cost_micros")
  // Lifetime counters (denormalized for cheap dashboards; ledger is source of truth).
  lifetimeToppedUpMicros    BigInt   @default(0) @map("lifetime_topped_up_micros")
  lifetimeSpentMicros       BigInt   @default(0) @map("lifetime_spent_micros")
  lifetimeMessages          Int      @default(0) @map("lifetime_messages")
  createdAt                 DateTime @default(now()) @map("created_at")
  updatedAt                 DateTime @updatedAt @map("updated_at")
  organization Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  @@map("tenant_wallets")
}
```

### 4.2 `WalletLedger` (immutable audit trail)
```
enum WalletLedgerKind { topup adjust hold settle release }   // Prisma enum
model WalletLedger {
  id                String           @id @default(...) @db.Uuid
  organizationId    String           @map("organization_id") @db.Uuid
  kind              WalletLedgerKind
  amountMicros      BigInt           @map("amount_micros")        // signed: +credit / -debit
  availableAfter    BigInt           @map("available_after_micros")
  heldAfter         BigInt           @map("held_after_micros")
  broadcastId       String?          @map("broadcast_id") @db.Uuid
  recipientId       String?          @map("recipient_id") @db.Uuid
  unitPriceMicros   BigInt?          @map("unit_price_micros")
  metaCostMicros    BigInt?          @map("meta_cost_micros")     // snapshot for margin per event
  note              String?
  actorUserId       String?          @map("actor_user_id") @db.Uuid
  createdAt         DateTime         @default(now()) @map("created_at")
  @@index([organizationId, createdAt(sort: Desc)])
  @@index([organizationId, kind, createdAt])
  @@map("wallet_ledger")
}
```

### 4.3 Broadcast billing snapshot (add to `Broadcast`)
```
billingUnitPriceMicros BigInt?  @map("billing_unit_price_micros")   // snapshot at start
billingMetaCostMicros  BigInt?  @map("billing_meta_cost_micros")
billingHeldMicros      BigInt   @default(0) @map("billing_held_micros")
billingSettledMicros   BigInt   @default(0) @map("billing_settled_micros")
billingReleased        Boolean  @default(false) @map("billing_released")
```

### 4.4 Recipient idempotency (add to `BroadcastRecipient`)
```
billedAt DateTime? @map("billed_at")   // set when this recipient's send is settled — settle once
```
(Sequence-enrollment step sends get the same idempotency via a `billedAt` on the relevant step/send
row, or a ledger uniqueness check on `(organizationId, recipientId)`.)

### 4.5 RLS
`tenant_wallets` + `wallet_ledger` are tenant-scoped → standard `_aligned_apply_tenant_rls` policy
in the migration **and** `rls.sql` (rls-drift gate covers them). Wallet writes from workers use the
bypass-aware tenant wrapper, scoped by `organizationId`.

## 5. Wallet engine — `apps/api/src/lib/wallet.ts`
All amount math in micros. Every mutation is one **atomic conditional SQL** + a ledger row in the
same transaction.

- `getWallet(orgId): Wallet | null` — null = unmetered (opt-in not enabled).
- `isMetered(orgId): boolean` — wallet exists AND price set.
- `setPrice(orgId, priceMicros, actor)` — enforce `priceMicros ≥ metaCostMicros`; upsert wallet.
- `topUp(orgId, amountMicros, actor, note)` — `available += amt`; ledger `topup`.
- `adjust(orgId, deltaMicros, actor, note)` — clamp so `available ≥ 0`; ledger `adjust`.
- `quote(orgId, count): { metered, unitPriceMicros, totalMicros, available, maxAffordable, removeCount, ok }`
  — pure read for the pre-send guard + UI cost line. `maxAffordable = floor(available / price)`,
  `removeCount = max(0, count − maxAffordable)`.
- `hold(orgId, broadcastId, count, actor): { ok, heldMicros, unitPriceMicros } | { ok:false, ... }`
  — atomic: `UPDATE tenant_wallets SET available_micros = available_micros - :H,
    held_micros = held_micros + :H WHERE organization_id = :org AND available_micros >= :H`;
    if `rowCount = 0` → insufficient. Snapshot price+metaCost onto the broadcast. Ledger `hold`.
- `settle(orgId, broadcastId, recipientId, unitPriceMicros)` — **idempotent**: only if
  `BroadcastRecipient.billedAt IS NULL` (atomic `UPDATE ... SET billed_at = now() WHERE id = :r AND
  billed_at IS NULL` → proceed only on rowCount=1). Then `held -= P`, bump
  `billingSettledMicros`, wallet lifetime counters; ledger `settle`.
- `chargeAtSend(orgId, recipientKey, unitPriceMicros, meta): { ok }` — for scheduled/sequence:
  atomic `available -= P WHERE available >= P`; idempotent per `recipientKey`; ledger `settle`
  (with broadcastId/recipientId where applicable). Returns `ok:false` if unaffordable (caller skips).
- `releaseRemainder(orgId, broadcastId)` — terminal + idempotent: if `!billingReleased`,
  `r = billingHeldMicros − billingSettledMicros`; `held -= r; available += r`; set
  `billingReleased = true`; ledger `release`.
- `maybeLowBalanceNotice(orgId)` — fire a `quota_warning`-style notification once when `available`
  crosses below `lowBalanceThresholdMicros` (track "notified" so it pings once per drop, re-arms on
  top-up).

## 6. Billing flows (step by step)

### 6.1 Immediate broadcast (`POST /broadcasts/:id/send`, not scheduled)
1. Resolve recipient **count** (manual/contacts: known; segment/CSV/tags: count query / CSV row
   count). For audiences whose size can't be known cheaply, count first.
2. `quote(orgId, count)`. If metered and `!ok` → **400** with `{ totalMicros, available, removeCount,
   maxAffordable }`; UI shows "remove N contacts". No send.
3. If metered → `hold(orgId, id, count)`. (If unmetered → skip wallet entirely.)
4. Enqueue fanout as today.
5. Fanout caps sends to `min(count, maxAffordable-at-hold)` — never more than held.
6. Send worker: on each **successful** Meta send → `settle(...)`. On fail/skip → nothing.
7. On broadcast terminal (completed/cancelled) → `releaseRemainder(...)`.

### 6.2 Scheduled broadcast (send later) + batched
1. At accept: **advisory** check only (warn in UI if current balance won't cover; allow scheduling —
   balance may be topped up before the run). No hold.
2. At fire time (scheduled fanout runs): resolve count, compute `maxAffordable` from **current**
   balance, send only the first `maxAffordable`, `chargeAtSend` per successful send (idempotent),
   and if `count > maxAffordable` → notify the tenant "X recipients not sent — insufficient balance."
3. Batched waves: each wave's recipients are charged at their send time; if balance runs out mid-run,
   remaining waves' recipients are skipped + a single summary notification.

### 6.3 Sequences / drips
1. Sequence tick fires a due step for an enrollment.
2. `chargeAtSend(orgId, enrollment/step key, price)`. If `ok` → send template. If `!ok` →
   **skip this step, pause the enrollment** (`status = paused_no_balance`), notify the tenant once.
   On top-up, paused enrollments can resume (a resume sweep, or manual).

### 6.4 Single / manual / test template send (inbox template, `/whatsapp/test-send`)
- `chargeAtSend(orgId, 1×P)`. If `!ok` → block with "insufficient balance." On success → already
  charged. (1-message hold/settle collapses to a single atomic debit.)

### 6.5 Re-run failed recipients
- Treated as a fresh send of M recipients → new `quote` + `hold` (immediate) or `chargeAtSend`
  (scheduled-style), same guards.

## 7. Pre-send affordability guard (UX contract)
- API (`/broadcasts/:id/send`, and a new `/broadcasts/:id/quote?count=` or reuse the create preview):
  returns `{ metered, unitPriceMicros, totalMicros, availableMicros, maxAffordable, removeCount }`.
- Wizard cost line (Schedule step + Review): e.g.
  `1,000 × $0.05 = $50.00 — balance $42.30 → you can send 846, remove 154 contacts.`
  The **Send** button is disabled when `removeCount > 0` for a non-trimmable audience, with a clear
  message. We **tell the number**, we do **not** auto-trim (per decision).
- Sub-case: `available < price` (can't afford even one) → "Top up your balance to send." 

## 8. Integration points (files to touch)
- DB: `packages/db/prisma/schema.prisma` + migration `*_tenant_wallet_billing` + `rls.sql`.
- Shared: `packages/shared` — wallet DTOs, `walletQuoteSchema`, micros↔USD helpers, ledger kinds.
- API:
  - `apps/api/src/lib/wallet.ts` (engine, new).
  - `apps/api/src/modules/broadcasts/broadcasts.routes.ts` — accept-time guard + hold; advisory check
    for scheduled; expose quote.
  - `apps/api/src/modules/whatsapp/whatsapp.routes.ts` — test-send guard.
  - `apps/api/src/modules/whatsapp-inbox/inbox.routes.ts` — manual template send guard (if templates
    can be sent from the inbox).
  - `apps/api/src/modules/admin/admin.routes.ts` — admin wallet endpoints (get/set price/top-up/
    adjust/ledger/summary) on the tenant detail page.
  - Tenant-facing: `apps/api/src/modules/billing/*` or a new `wallet.routes.ts` — GET wallet + ledger
    (viewer) for the tenant dashboard/analytics.
- Worker:
  - `apps/worker/src/jobs/broadcast-fanout.ts` — cap to held count; scheduled charge-at-send path.
  - `apps/worker/src/jobs/broadcast-send.ts` — `settle` on success; respect billedAt idempotency.
  - sequence tick worker — `chargeAtSend` + pause-on-empty.
  - new **reconciliation reaper** (hourly): release holds for terminal broadcasts where
    `!billingReleased`; flag stuck broadcasts.
- Web:
  - Tenant: `dashboard` widget + `/analytics` + broadcast wizard cost line + low-balance banner.
  - Admin: tenant detail page Wallet card (price, top-up, adjust, balance/held, totals incl. **Meta
    cost + your price + margin**) + ledger table.

## 9. Notifications
- New (or reuse `quota_warning`) **low-balance** notice when `available` crosses
  `lowBalanceThresholdMicros` (default e.g. price × 200, or admin-set). One ping per drop; re-arms on
  top-up. Severity escalates near $0.
- "X recipients skipped for insufficient balance" after a scheduled/batched run.
- Sequence "enrollment paused — out of balance."

## 10. Reporting / margin
- Per tenant (admin): `Σ topup`, `Σ spent`, current `available`/`held`, `messages sent`,
  `Σ Meta cost` (= messages × metaCostSnapshot), `Σ charged`, **margin = charged − Meta cost**, all
  for "this month" + "lifetime". Source = `wallet_ledger` (settles) + wallet counters.
- Tenant (self): balance (available/held), spent this month + lifetime, messages sent. **No Meta cost
  / margin shown to tenant** (that's HQ-only).
- Reuse/replace the existing admin `broadcastCostUsd` / `billableConversations` columns where they
  overlap.

## 11. Concurrency, consistency, idempotency
- **Atomic holds/charges**: single conditional `UPDATE ... WHERE available >= :amt`; rowCount decides.
  Prevents two sends spending the same funds.
- **Idempotent settles**: `billedAt` flag flips atomically; a retried send job can't double-charge.
- **Release idempotency**: `billingReleased` flag; reaper + terminal hook both safe to call twice.
- **Reaper**: hourly job releases orphaned holds (worker crash, missed terminal hook) and logs drift
  (`held` for a terminal broadcast should be 0).
- **Ledger is the source of truth**; wallet counters are a cache. A nightly check can assert
  `available + held == Σ ledger` per org (alert on mismatch).

## 12. Edge-case matrix (theoretical QA)
| # | Scenario | Expected |
|---|---|---|
| 1 | Two immediate broadcasts race for last $50 | One holds, other gets 400 insufficient. No oversell. |
| 2 | Segment/CSV size unknown | Count resolved at accept; hold on count; fanout caps to held. |
| 3 | Segment grows between count and fanout | Extra recipients beyond held count are skipped + flagged. |
| 4 | Scheduled broadcast, balance dropped by fire time | Sends only what's affordable now; notifies skipped count. |
| 5 | Recipients fail / opted-out | Held but not settled → released at terminal. Not charged. |
| 6 | Price changed mid-broadcast | Settlement uses snapshot price; in-flight cost stable. |
| 7 | Cancel mid-send | Remainder released to available. |
| 8 | Worker crash mid-broadcast | Reaper releases the orphaned hold; settle idempotent. |
| 9 | Re-run failed recipients | New quote + hold/charge. |
| 10 | Single inbox/test send, balance < price | Blocked: insufficient balance. |
| 11 | Sequence step, balance hits 0 | Step skipped, enrollment paused, tenant notified; resumes on top-up. |
| 12 | Price exactly $0.0375 | Allowed (0 margin). Below floor → rejected on setPrice. |
| 13 | Unmetered tenant (no wallet/price) | Behaves exactly as today — no guard, no charge. |
| 14 | Admin adjust below 0 | Clamped to 0; can't force negative. |
| 15 | Monthly cap reached but money available | Cap blocks (volume). Money available is irrelevant. |
| 16 | Money exhausted but cap remaining | Wallet blocks. |
| 17 | Top-up during a paused-for-balance sequence | Low-balance notice re-arms; enrollments resumable. |
| 18 | Batched broadcast runs out mid-waves | Funded waves send; later waves skipped + summary notice. |
| 19 | Double-clicked Send | Idempotent hold per broadcast (one hold per broadcast id); second is a no-op. |
| 20 | Currency rounding | Integer micros; no drift; totals exact. |

## 13. QA / test plan
**Unit (vitest, wallet.ts):** hold success/insufficient; settle idempotency; release math
(`H = Σsettle + release`); chargeAtSend insufficient; adjust clamp; quote/maxAffordable/removeCount;
price floor enforcement; micros↔USD formatting.

**Integration (api `test/wallet.test.ts`, real PG+Redis):** immediate broadcast happy path (hold →
settle per recipient → release on complete); insufficient → 400 with removeCount; concurrent holds
(spawn 2, assert one fails, `available + held == start`); failed recipients refunded; cancel releases;
re-run holds again; tenant-isolation (org A can't see/spend org B's wallet — extend the hard gate);
RLS-drift covers the 2 new tables.

**Manual smoke (staging):** set a tenant price + top up; send broadcast under/over balance; watch
balance + ledger; scheduled broadcast with mid-window top-up; sequence pause/resume; test-send block;
admin margin numbers vs hand calc; low-balance notification fires once.

**Money invariants (assert in tests):** never `available < 0`; never `held < 0`;
`available + held` conserved across hold/release; spent == Σ settles.

## 14. Rollout
1. Migration + engine + tests (no behavior change; opt-in).
2. Admin wallet card (set price + top-up) — enable for **one pilot tenant**.
3. Wire the broadcast guard + settle + release behind `isMetered(org)`.
4. Tenant dashboard/analytics + low-balance notice.
5. Sequences + scheduled charge-at-send.
6. Reaper + nightly invariant check.
7. Expand to more tenants by setting their price + balance.
8. **Backfill already-onboarded tenants to the $0.08 default.** For every existing tenant (lexy, ziid,
   aseer-time, full-volume, sandwich-wnos, le-gabarit, the-booty-republic, …): create a `TenantWallet`
   row with `pricePerMessageMicros = 80000` ($0.08) and balance $0, and **refresh any cost figure they
   already see** (the admin `broadcastCostUsd` / tenant spend numbers) to the new $0.08-based math.
   Metering stays inert (no send gate) until HQ tops up a balance — so nothing breaks — but the price and
   the tenant's **"≈ messages remaining"** show immediately. HQ then tops up each tenant per their real
   payment. Migration can seed these rows in one pass (idempotent on `organization_id`).

## 15. Open risks / future
- **Per-country / per-category Meta pricing** — today one flat reference cost; real Meta rates vary
  (Lebanon vs UAE, marketing vs utility). Future: a rate table keyed by country/category for exact
  margin. Snapshotting `metaCostMicros` per event makes this a non-breaking upgrade.
- **Self-serve top-up** via a payment gateway (Stripe/MyFatoorah) — currently HQ-manual only.
- **Refund policy** beyond auto-release (e.g. Meta-side delivery failures discovered later via status
  webhooks → post-hoc credit).
- **Tax/VAT** on top-ups if invoicing is added later.

## 16. Tenant "Billing & Overview" page (self-service)

A dedicated tenant-facing page — **Billing & overview** (sidebar entry + route `/billing`) — that gives
every tenant one honest, at-a-glance view of their plan, wallet, spend, and everything they have left.
**Tenant-only figures** — Meta cost and margin are never shown here (HQ-only, §10). It reuses the
already-shipped pieces: the wallet engine (`wallet.ts`), the per-tenant **monthly AI-message allowance**
(`Organization.monthlyAiMessageCap` + Redis `aimsgs:{org}:{YYYY-MM}`), and the **Usage & limits** quota
list (`getOrgQuotas`).

### 16.1 What the page shows

**A. Plan & price (summary strip)**
- **Plan** name / tier (the tenant's subscription + AI plan label).
- **Price per message** — the tenant's current per-message price (default **$0.08**), read-only for the
  tenant (only HQ can change it, §1.2).
- **Monthly cost** — what they're spending this month = **Spent this month** (below); if a fixed monthly
  subscription fee exists it's shown alongside the metered spend.

**B. Wallet (the top-up balance)**
- **Balance available** — spendable now, in USD (from `availableMicros`).
- **On hold** — reserved by in-flight broadcasts (`heldMicros`), shown if > 0.
- **Topped up (lifetime)** — Σ top-ups (what HQ has loaded for them).

**C. Spent vs. remaining (explicit, per the ask)**
- **Spent this month** and **Spent (lifetime)** — Σ ledger debits (settles + charge-at-send). The
  tenant always sees *how much they've spent*.
- **Balance remaining** — restated prominently next to spent, so "spent vs. remaining" is one glance.

**D. "How much your wallet can still send" (approx. messages remaining)**
- **≈ messages remaining = floor(availableMicros / pricePerMessageMicros)** — e.g. *"With your $37.60
  balance you can send about 470 more WhatsApp messages."* Recomputes live from balance ÷ price, so when
  HQ changes the price it updates immediately.
- If a monthly message/broadcast cap is also set, show the **effective** remaining =
  `min(cap-remaining, floor(available / price))` and label which limit binds first.

**E. Messages sent**
- **This month** and **lifetime** billable message counts (broadcasts + sequences + manual/test template
  sends), from the wallet counters / ledger.

**F. AI messages remaining (separate allowance — reuse the shipped feature)**
- **AI messages left this month = `monthlyAiMessageCap − used`** with the same green → amber (80%) → red
  (100%, paused) states already built. Clearly labelled **separate from the wallet**: AI bot replies are
  metered by the monthly AI-message allowance and are **not** charged to the wallet (§1.3).

**G. Everything else from their plan (reuse Usage & limits)**
- The full **quota list** already surfaced by the Usage & limits widget — monthly messages, broadcasts,
  imports, and product / service / member / API-key / webhook caps — each as `used / cap / %` with the
  green→amber→red status, so **all remaining plan capacity** lives on this one page.

**H. Activity (ledger)**
- A compact table of the tenant's own wallet movements: top-ups and charges (date, kind, amount, balance
  after, and what it was for — e.g. *"Broadcast 'Eid sale' · 940 msgs"*). Tenant view hides Meta cost /
  margin.

**I. Low-balance state**
- The low-balance banner (§9) pins to the top of this page (and the dashboard) when `available` is near 0.

### 16.2 Data source (new tenant endpoints, viewer role)
- `GET /billing/overview` →
  `{ plan{name, aiPlanLabel}, wallet{availableMicros, heldMicros, pricePerMessageMicros, messagesRemaining},
     spent{monthMicros, lifetimeMicros}, toppedUpLifetimeMicros, messagesSent{month, lifetime},
     aiMessages{used, cap, remaining, percentUsed, unlimited}, quotas[] }`.
  Composes `wallet.ts` + `readAiMessageUsage(orgId)` + `getOrgQuotas(tx, orgId)`. `messagesRemaining` and
  `messagesSent`/`spent` come from the wallet; **never returns Meta cost or margin**.
- `GET /billing/ledger?cursor=&limit=` → the tenant's own `wallet_ledger` rows (RLS-scoped), paginated.
- Unmetered tenants (no wallet row) → the wallet/price/spent blocks show a friendly "not on metered
  billing" empty state; the AI-messages + plan-quota blocks still render (those always apply).

### 16.3 Web
- New page `apps/web/src/app/(dashboard)/billing/page.tsx` + a **Billing** sidebar entry (gated so it's
  hidden if the `billing`/`exports` feature is disabled for the tenant, consistent with the feature-toggle
  system). The dashboard keeps its compact wallet + AI-messages + Usage&limits widgets; this page is the
  full breakdown. Money formatted via the shared micros↔USD helper (2 dp), messages as whole numbers.
