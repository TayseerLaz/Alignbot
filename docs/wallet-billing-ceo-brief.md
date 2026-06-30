# Prepaid Wallet & Per-Message Billing — Executive Brief

*One-page summary for leadership. A detailed technical plan exists separately.*

## What it is
- A **prepaid balance (wallet)** for each tenant, topped up by us (HQ) when they pay.
- We charge the tenant a **price per WhatsApp message** that **we set, per tenant**.
- Every broadcast, drip campaign, or template message **draws down their balance**.
- A tenant **cannot send** if they don't have enough balance — it's blocked before any cost hits us.

## Why it matters (the business case)
- **No more eating Meta's costs.** WhatsApp charges us per message; today that's an uncontrolled cost. This makes every paid message **pre-funded by the tenant** before it's sent.
- **Built-in margin.** We pay Meta ~**$0.0375/message**; we can charge each tenant **whatever we want above that** (e.g. $0.05). The difference is **profit on every message**.
- **Fully flexible per client.** Big client gets one price, small client another — we control each independently.
- **Cash up front.** Tenants pay us first (balance), then spend it. We're never out of pocket.
- **Zero bad debt risk.** Balance can **never go negative**; a tenant can only spend what they've already paid.

## How it works (plain version)
- HQ sets a **per-message price** for each tenant (minimum = our Meta cost, so we never lose money).
- HQ **tops up** the tenant's balance when they pay us (manual, reflects a real payment).
- The tenant sends messages → the cost is **deducted from their balance**.
- The tenant **sees** their balance, what they've spent, and how many messages they sent (dashboard).
- HQ **sees** per tenant: balance, total spent, **our real Meta cost, our price, and the margin** — plus a full history of every top-up and charge.

## What each side sees
- **Tenant:** balance left · spent this month · messages sent · low-balance warning. *(They never see our cost or margin.)*
- **HQ (us):** everything above **plus** Meta cost, our price, margin, and a complete ledger.

## Key scenarios (cases)
- **Normal send:** Tenant has $500, sends a broadcast to 1,000 people at $0.05 → $50 deducted, $450 left.
- **Not enough balance:** Tenant has $50, tries to broadcast to 1,000 ($50 needed is $50… say it's $80) → **blocked**, told *"remove 400 contacts so it fits, or top up."* Nothing is sent until it's affordable.
- **Out of balance:** Tenant at $0 → **cannot send** a single broadcast or template. Period.
- **Only charged for what's delivered:** If 50 of 1,000 numbers fail, the tenant is charged for the **950 that actually sent** — the rest is refunded to their balance automatically.
- **Scheduled / drip campaigns:** Messages are charged **as they go out**; if the balance runs out mid-campaign, the rest **pause** and the tenant is notified to top up.
- **Low balance:** Tenant gets an automatic **warning** before they run out.
- **Different price per client:** Premium client charged $0.06, budget client $0.04 — set individually.
- **Free / unmetered clients:** Any tenant we don't put on the wallet keeps working exactly as today (no balance, no charge) — **safe, gradual rollout**.

## What we control as HQ
- Each tenant's **price per message** (never below our cost).
- **Top up** or **adjust** any tenant's balance at any time.
- Full visibility of **revenue vs. cost vs. margin** per tenant.

## Bottom line
- Turns WhatsApp from a **cost center into a profit line**, per message, per tenant.
- **Prepaid + hard limits** = no overspending, no bad debt, no surprise Meta bills.
- **Opt-in** = we roll it out client by client with zero disruption to the rest.

## Open future options (not in v1)
- Tenants topping up themselves online (card / local payment) instead of us doing it manually.
- Exact Meta pricing per country (rates differ Lebanon vs. UAE, etc.) for even tighter margins.
