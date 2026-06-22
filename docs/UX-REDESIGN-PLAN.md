# Hader / ALIGNED — UX Recreation Plan

> Recreate the platform's experience for **every role** (operator, editor, viewer,
> tenant admin, ALIGNED HQ) into a **neutral-minimal, Linear-class, compact**
> product that is clear, fast, dense, and feels like the best SaaS in its category.
> Direction + principles live in [.impeccable.md](../.impeccable.md). This doc is
> the build plan.

## 0. Diagnosis (why it doesn't feel right today)
Grounded in the code, not vibes:
- **Soft/spacious tokens.** Radii 14–28px, generous padding, cream warmth →
  reads "friendly admin template," not "professional instrument." *This is the
  literal source of the "big spaces" complaint.*
- **Single font.** Everything is Plus Jakarta Sans; numbers/IDs/prices don't feel
  precise. The brand book's mono was dropped.
- **No first-run.** New tenants hit a blank widget board; the core loop
  (Catalog → Bot → Connect) is invisible.
- **Two giant screens.** Inbox (3,030 lines) and bot builder (~2,245) show
  everything at once — no progressive disclosure, no "start here."
- **Bloated, flat nav.** 22 items / 6 groups, no search, no breadcrumbs, no
  "you are here," advanced features hidden.
- **List-shaped thinking.** Tables everywhere, "Loading…" text not skeletons,
  filters lost on refresh, no keyboard nav, no command palette.
- **No state-at-a-glance, no delight.** Nothing tells you the system is working;
  nothing celebrates a deployed bot / first order.

## 1. The Design System (foundation — cascades to all 54 pages)

### 1.1 Tokens (`apps/web/src/styles/globals.css`)
- **Palette → neutral-minimal (OKLCH).** ~90% neutral grays, *subtly* oxblood-
  tinted for cohesion (chroma ~0.005–0.01). **Oxblood `#360516`** = primary
  action + active nav only. **Signal red `#e53e34`** = escalation/destructive
  only. Semantic success/warning/info kept, warmth-matched. No pure black/white.
- **Radii → tight:** xs 6 / sm 8 / md 10 / lg 14 / pill. (from 8/14/20/28.)
- **Spacing scale (4pt, semantic):** `--space-1..` = 2,4,6,8,12,16,24,32,48.
  Add `--density-row` (compact 36px), `--control-h` (32px), `--field-h` (34px).
- **Borders over shadows:** hairline 1px `--color-border`; shadows reserved for
  true overlays (popover/dialog/command), much lighter than today.
- **Motion tokens:** `--ease-out` (cubic-bezier(.22,1,.36,1)), durations
  `--dur-fast 120ms / --dur 180ms`; transform+opacity only.
- **Type:** `--font-sans` Plus Jakarta Sans; `--font-mono` **JetBrains Mono**
  (wire via next/font). Base UI text 13–14px, line-height 1.45; one 1.25-ratio
  scale: 12 / 13 / 14 / 16 / 20 / 26.

### 1.2 Primitive library (`apps/web/src/components/ui`)
Keep the names (button/badge/card/dialog/input/select/tabs/…); **add the missing
load-bearing ones** and make all compact by default:
- `Skeleton` (shared; matches real layout) — replaces every "Loading…".
- `DataTable` (sortable headers, sticky header, compact rows, row-select,
  keyboard nav, empty/loading built in, **mobile→card** fallback).
- `Command` (⌘K palette), `Tooltip`, `Breadcrumbs`, `Toast` (if not global),
  `StatCard` (flat, no gradient/sparkline-as-decoration), `PageHeader`
  (title + breadcrumb + primary action slot), `Kbd`, `StatusDot`, `SegmentedControl`.
- Audit every primitive against the AI-slop bans (no left-stripe accents, no
  gradient text, no card-in-card).

### 1.3 Density & layout law
- Page = `PageHeader` + content; **content max-width only for forms/reading**;
  tables/inbox go full-bleed. Kill the centered narrow column on data screens.
- Tables, not card-grids, for collections. Cards only for genuinely card-shaped
  things (a product tile with image).
- Consistent 16px page padding (was 24–32), 12px intra-group gaps.

## 2. Information Architecture & Navigation (cascades everywhere)

### 2.1 Role-aware sidebar (rebuild `components/shell/sidebar.tsx`)
- Collapse 6 groups → **3**: **Operate** (Inbox, Contacts, Broadcasts),
  **Catalog** (Products, Services, Business info, Orders, Bookings),
  **Configure** (Bot, Channels, Integrations, API/Webhooks, Settings). HQ gets a
  4th **ALIGNED HQ** group, only for `isAlignedAdmin`.
- **Filter by role** (already have `org-features.ts` + RBAC) so viewers/editors
  see only what they can use; advanced (connectors/webhooks/API keys) live under
  a single **Integrations** hub, not top-level clutter.
- Collapsible, "you are here" active state, per-item keyboard hint, escalation/
  leads badges retained. Pin Inbox to top for operators.

### 2.2 Global chrome (rebuild `components/shell/app-shell.tsx`)
- **⌘K command palette** — go to any page, run any action (deploy bot, new
  product, search threads/contacts/orders), switch org. Operators never hunt.
- **Status strip** in the top bar: `Bot ● Live · WhatsApp ● Connected · 7 orders
  today · AI budget 62%` — the system reports its own state. Pulls existing
  `/inbox/counts`, bot `deployedAt`, channel status, dashboard KPIs.
- **Breadcrumbs** on every detail route.
- Org switcher + notifications bell retained, restyled compact.

## 3. Per-role experience

| Role | Lands on | Optimized for |
|---|---|---|
| **Operator** (editor/viewer in inbox) | **Inbox** (already routed) | speed: ⌘K, arrow-key thread nav, compact threads, channel filters in URL, one-key AI on/off, mobile-first |
| **Editor** | Dashboard → quick actions | catalog editing flow, autosave clarity, bulk ops |
| **Viewer** | Dashboard (read-only) | scannable analytics/orders/audit; write affordances hidden, not just disabled |
| **Tenant admin** | Dashboard / first-run | setup golden path, channels, billing, members, integrations hub |
| **ALIGNED HQ** | HQ platform overview | cross-tenant density: orgs table, control/impersonate, provenance, revenue, system health — power-dense, keyboard-driven |

## 4. Per-surface redesign

- **First-run (NEW, highest leverage).** Replace the blank dashboard for
  un-set-up tenants with a **3-step golden path**: ① add catalog (import or 1
  product) ② shape the bot persona ③ connect a channel — persistent progress,
  dismissable once live. Drives the core loop.
- **Dashboard.** Flat KPI row (mono numerics), today's activity, onboarding
  checklist until done, bot/outreach/AI-budget cards — no gradient hero-metric
  template; edit-mode kept but secondary.
- **Inbox (decompose `inbox-screen.tsx`).** 3-pane (threads · conversation ·
  context) with progressive disclosure: context pane collapses; provenance is a
  drawer not always-on; arrow-key nav; URL-persisted filters
  ([inbox-screen.tsx:254] already builds the params — persist them); compact
  bubbles; mobile = single pane with back. AI on/off is a clear, primary toggle.
- **Bot builder (decompose).** First time = **guided wizard** (persona →
  knowledge/crawl → simulate → deploy); afterwards = **editor** with sections.
  Inline Deploy at the end, not only the header. Live simulator as a docked panel.
- **Catalog (products/services/business-info/categories).** DataTable lists
  (compact, sortable, bulk), editor with clear autosave state, currency symbol on
  price inputs, mono + lock-icon + tooltip on immutable SKU, image uploader
  inline. Inline on-blur validation, explicit required markers.
- **Commerce (orders/bookings).** DataTables with status as a compact select;
  payment status now surfaced (from the F-04 work); "View chat" → inbox.
- **Growth (broadcasts/contacts/segments/sequences).** Wizard stays but compact;
  contacts as DataTable with channel chips; live SSE counters as flat stats.
- **Integrations hub.** One page tabbing Connectors / Webhooks / API keys / Sync
  — pulls the three "hidden" features into a discoverable home.
- **Settings.** Compact two-column (nav + panel); finish `/settings/branding`
  (currently the one placeholder) or hide it until built.
- **ALIGNED HQ.** Dense orgs DataTable, command-palette-driven actions, provenance
  browser as a focused triage view, system health as flat real-time tiles.

## 5. Cross-cutting patterns
- **Loading:** Skeleton everywhere (matches layout), never "Loading…".
- **Empty states:** teach the next action, not "nothing here."
- **Errors:** consistent inline + toast; helpful messages.
- **Forms:** on-blur validation, required markers, disabled+spinner pending,
  success toast; optimistic where safe.
- **Mobile:** tables → cards, inbox → single-pane, real touch targets (operators
  are on phones). Adapt, don't amputate.
- **Delight (restrained):** one staggered load per page; milestone moments
  ("Bot is live", first order) — subtle, not confetti everywhere.
- **A11y/RTL:** AA contrast, focus rings, full keyboard paths, Arabic/RTL aware.

## 6. Implementation roadmap (incremental, each phase shippable + build-verified)

| Phase | Scope | Cascade | Status |
|---|---|---|---|
| **1 — Foundation** | tokens (neutral-minimal palette, tight radii, spacing/motion), JetBrains Mono wiring | every page's *feel* | ◐ in progress |
| **2 — Primitives** | Skeleton, DataTable, Command, Tooltip, Breadcrumbs, PageHeader, StatCard, compact variants | every list/detail | ☐ |
| **3 — Shell & nav** | role-aware 3-group sidebar, ⌘K palette, status strip, breadcrumbs | every screen | ☐ |
| **4 — First-run + Dashboard** | golden path + dashboard redesign | new-tenant felt quality | ☐ |
| **5 — Inbox** | decompose + 3-pane + URL filters + keyboard nav + mobile | operators (highest freq) | ☐ |
| **6 — Catalog & Commerce** | DataTable lists + editor polish + form UX | editors/admins | ☐ |
| **7 — Bot builder** | wizard-then-editor decomposition | setup conversion | ☐ |
| **8 — Growth + Integrations hub** | compact + discoverability | admins | ☐ |
| **9 — HQ + Settings + branding** | dense HQ, settings, finish branding | HQ + admins | ☐ |
| **10 — Delight + mobile + a11y pass** | motion, milestones, mobile cards, RTL/contrast audit | all | ☐ |

Phases 1–3 deliver ~70% of the felt transformation (they touch every screen).
4–10 go surface-by-surface. Every phase ends with `pnpm --filter @aligned/web build`
green and is independently shippable.

## 7. Success criteria
- New tenant reaches a deployed bot in **<10 min** via the golden path.
- ~**40% more** content visible per screen at compact density (the "big spaces" fix).
- Inbox fully **keyboard-drivable**; ⌘K reaches any page/action.
- Every list has skeletons + empty states; filters survive refresh.
- The "AI slop test": no one would guess this was AI-generated.
- Mobile-usable inbox + tables for phone-based operators.
