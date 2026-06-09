# Hader — What's Inside the Web App

*A complete, plain-language map of every screen in the Hader dashboard and what it does. Organized the same way the app's menu is, so it doubles as a demo script.*

> **Scale at a glance:** ~40 distinct screens across **8 areas** — Engagement, Catalog, Operations, Marketing, Knowledge & Setup, Integrations, Account & Billing, and a separate ALIGNED (Hader) super-admin console.

---

## The menu, at a glance

**For a business (tenant) user, the sidebar is grouped into:**

| Group | Pages |
|---|---|
| **Overview** | Dashboard |
| **Engagement** | Contacts · Inbox · Canned replies · Templates & Broadcasts |
| **Catalog** | Products · Services · Categories |
| **Operations** | Bookings · Orders · Analytics |
| **Workspace** | Business info · Imports · AI bot builder · Members · Activity log · Settings |

**Plus integrations & account screens** reached from Settings: WhatsApp · API keys · Connectors · Webhooks · Billing · Profile · Branding · Data export.

**For ALIGNED staff only**, a separate **Hader Admin** console: Tenants · System health · Cross-tenant audit · AI provenance · Suppression list · Revenue · New tenant.

---

## 1. Overview

### Dashboard *(home screen)*
The customizable landing page each user sees on login.
- Personalized greeting by first name.
- **Edit mode** to add, remove, and arrange **widgets** (KPI tiles, status cards, onboarding banners) — layout is saved per user.
- A widget "bank" to pick which metrics and status cards to show.
- Clean empty state that guides a new user to add their first widget.

---

## 2. Engagement *(the conversations)*

### Inbox *(the heart of the product)*
A unified hub where the business sees and manages every WhatsApp conversation.
- **Thread list** with search (by phone, name, or message text) and filters (Open / Pending / Resolved / Escalated, plus custom tags).
- **Full conversation view**: complete message history, image/voice/document badges, button-press indicators, and internal staff-only notes mixed into the timeline.
- **Take over from the AI** in one tap (assigning a chat to a human pauses the bot); hand it back to the AI just as easily; **escalate** with a handoff button.
- **Reply box** with one-click **canned responses** and variable substitution (e.g. auto-insert the customer's number).
- Per-thread controls: rename the customer, change status, add/remove tags, reset the chat history, delete the conversation, and set how the bot should reply (text / voice / match the customer).
- **AI status banner** showing whether the bot is live, paused, or actively handling the chat.
- **(For ALIGNED admins)** every bot reply can be opened to show its **Sources, detected Hallucinations, and timing** — flagged replies get a visible marker. *(This is the trust/accuracy system.)*

### Canned replies
A library of saved quick-reply templates for the inbox.
- Create reusable messages with a shortcut name and body text.
- Supports placeholders (e.g. `{phone}`) that auto-fill with the customer's details.
- Edit and delete templates.

### Contacts
The customer phone directory that powers marketing audiences.
- Table of contacts: phone number, WhatsApp nickname (auto-filled), an editable display name, tags, source (manual / CSV / inbox), and last message date.
- Search by phone or name; filter by tag (with live counts per tag).
- **Import contacts from CSV**, add contacts manually, inline-edit, and delete.

### Templates & Broadcasts
*(Covered in detail under "Marketing" below — this menu item opens the broadcasts area, which also hosts Segments and Sequences as tabs.)*

---

## 3. Catalog *(what the bot knows it can sell)*

### Products
List and manage the product catalogue.
- Create products; search by name or SKU; filter by category and availability.
- List shows thumbnail, SKU, category, price, status, and last-updated.
- **Bulk-select** to mark available/unavailable or delete; paginated.

### Product editor *(per product)*
- Edit name, SKU, category, price, compare-at price, and descriptions — **auto-saves as you type**.
- **Image gallery**: upload, reorder, set a primary image.
- **Variants** (size, colour, etc.) each with their own SKU, price, and stock.
- Toggle whether the product is visible to the chatbot.
- **Version history**: a timeline of every change with a one-click **restore** to any earlier version.

### Services
List and manage services (for appointment/quote-based businesses).
- Create services; search; filter by category and availability.
- Shows duration, base price with unit (flat / per-hour / per-day / per-session), status.

### Service editor *(per service)*
- Edit details with auto-save.
- **Pricing tiers** (e.g. Basic / Premium) each with price, description, and a feature list.
- **Weekly availability grid** (open/close times per day).
- **Booking rules**: deposit %, cancellation window, minimum lead time, party-size limits, customer notes.

### Categories
Organize products and services into a tidy tree.
- Create, search, and filter categories.
- Expand a category to see the products and services inside it.
- Bulk-delete, or "delete empty only" to auto-tidy.

---

## 4. Operations *(what the bot captures)*

### Bookings
Every appointment request the bot captured, in one place.
- List with appointment date/time (understands "tomorrow", "next Monday", "5pm", etc.), customer details, the answers they gave, and status.
- Change status (New / Confirmed / Completed / Cancelled); set an automatic **WhatsApp reminder** (fires 2 hours before).
- **Calendar view** of all bookings; jump straight to the related conversation.

### Orders *(cart)*
Every order placed through the chat.
- List with customer, item count + summary, total, and status.
- Expand to see the full itemized order (variants, quantities, line totals, delivery fee, subtotal) and the answers collected at checkout.
- Move orders through a status workflow (Draft → New → Confirmed → Completed / Cancelled).

### Analytics
A dashboard of conversation volume and bot performance.
- Time window selector (24h / 7d / 30d).
- Headline cards: inbound count, outbound count, number of conversations, and **bot resolution rate** (how much the AI handled without a human).
- **Daily volume chart**, **average response time**, **top keywords**, most-repeated questions (reveals missing FAQs), and most-mentioned products/services.

---

## 5. Marketing *(Templates & Broadcasts)*

### Broadcasts *(list)*
Send a WhatsApp message to many customers at once.
- Table of campaigns with status and live **sent / delivered / read / failed** counts.
- Re-send, delete, or open any campaign; counters update live.

### New broadcast *(4-step wizard)*
- **Step 1 – Basics:** name, pick an approved WhatsApp template, optional **A/B test** (two template variants).
- **Step 2 – Audience:** paste numbers manually, upload a CSV, or target **tags/segments** (with AND/OR matching).
- **Step 3 – Personalization:** fill template placeholders from static text, a CSV column, or a contact attribute.
- **Step 4 – Review & send:** summary, **send now or schedule** for later.

### Broadcast detail
- Five live counter cards (queued / sent / delivered / read / failed).
- **Recipients tab** (filter by status, see per-person delivery state and any error), **Timeline tab** (every event), **Overview tab**.
- Controls: **pause, resume, cancel, re-run failed recipients, export to CSV**. Updates live.

### Segments *(tab)*
Build reusable customer groups from filter rules (e.g. "ordered in the last 90 days") to target with broadcasts.

### Sequences *(tab)*
Automated **drip campaigns** — a series of messages that go out over days on their own (welcome series, win-back nudges), with enrollment management.

---

## 6. Knowledge & Setup *(teach the bot, connect WhatsApp)*

### Business info
A tabbed editor for everything about the business the bot needs to know.
- **Profile & Hours** — legal name, tagline, about, website, timezone, currency, and weekly opening hours.
- **Locations** — multiple branches with address and contact details; mark a primary.
- **Contacts** — WhatsApp, phone, email, social handles.
- **FAQs** — question/answer pairs with a public/private visibility toggle.
- **Policies** — returns, shipping, privacy, refunds, etc.
- **Booking form** — design the questions the bot asks to capture an appointment (field types, required toggles, trigger keywords).
- **Shop form** — design the in-chat ordering flow (minimum order, delivery fee, free-delivery threshold, confirmation message, menu link).

### AI bot builder
The no-code studio to build, tune, test, and deploy the AI assistant.
- **One-click deploy** toggle to take the bot live (or pause it), with a version badge.
- **Analyze website**: crawl the business's existing site to auto-extract products, FAQs, hours, and contacts — review and approve what it found.
- **Personality & greeting**: preset tones (Friendly / Casual / Formal / Clinical / Professional), custom greeting, greet-by-name, optional greeting image, **language selector** (English, Arabic, French, Spanish, German, Portuguese, Italian, Turkish), and an escalation fallback message.
- **Voice replies**: text, "match the customer", or always-voice, with a choice of voice provider.
- **Conversation flows**: AI-suggested conversation paths plus a visual **drag-and-connect flow editor**.
- **Live simulator**: chat with the bot exactly as a customer would, before going live.
- **Test scenarios**: auto-generated test cases scored 0–100 by an AI judge, with human override — a quality gate before deployment.
- **Setup questionnaire**: a checklist that flags missing config and links straight to fix it.

### WhatsApp
Connect the official Meta WhatsApp number.
- Guided fields for the WhatsApp credentials, **Save & Verify** against Meta, and a copy-ready webhook URL.
- **Live toggle** (only enabled once verified), recent-message log, **test-send** a template, and a disconnect button.
- **Onboarding sub-page**: a 7-step Meta business-verification checklist with progress tracking.
- **Templates sub-page**: build and submit WhatsApp message templates to Meta for approval, sync their approval status, and manage the library.

### Imports
Bulk-load catalogue data from spreadsheets.
- Download ready-made templates (products, services, FAQs, business info).
- A 3-step wizard: pick file → optionally map columns → review & submit.
- Live job list with progress bars and row counts; per-row results.

### Import detail *(per job)*
- Stat cards (total / succeeded / failed / progress) and a live progress bar.
- Per-row results with the exact validation error, an inline **"edit & retry"** for failed rows, **download-errors-CSV**, and cancel.

---

## 7. Integrations *(for connecting other systems)*

### Connectors
Sync data automatically from external systems (REST APIs, webhooks, Shopify, WooCommerce).
- Create a connector with an endpoint, an auth method (none / bearer / API key / basic), and an optional schedule.
- **Test**, **run now**, an inbound webhook URL to copy, and a full **run history** with record counts.

### API keys
Issue secure keys so an external chatbot or system can read the catalogue.
- Create keys with specific **scopes** (catalogue, business info, FAQs, policies, search).
- Secret shown once on creation (copy/reveal), with created/last-used/expiry tracking and revoke.

### Webhooks
Notify external systems automatically when catalogue data changes.
- Subscribe an endpoint to specific events (product created/updated/deleted, etc.).
- Signed deliveries, a delivery history with response codes and retries, pause/resume, and manual retry.

---

## 8. Account, Team & Billing

### Members
Manage the team.
- Team table with role (Admin / Editor / Viewer), status, and last login.
- Invite by email with a role; change roles live; deactivate (with last-admin protection); revoke pending invites.

### Settings *(hub)*
A central hub linking to organization settings, account settings, and integrations, plus an admin-only **delete organization**.

### Profile & security
- Edit name and **change password**.
- **Two-factor authentication (2FA)**: QR-code setup for an authenticator app, recovery codes, enable/disable.
- **Export your personal data** (JSON) and delete your account.

### Billing & plan
- Current plan and status, next billing date, and a self-serve billing portal.
- **Usage meters** for products, services, members, messages, broadcasts, imports, API keys, and webhooks — each against its plan cap.
- A plans grid with monthly/yearly toggle and upgrade buttons.

### Data export
- Request a full **organization-wide data export** (data portability / GDPR), with status tracking and a time-limited download link.

### Branding
- White-label customization (logo, accent color, custom domain) — *marked "coming soon".*

### Activity log
- A searchable, filterable audit trail of every meaningful change in the workspace (by type, person, and date), with expandable detail.

---

## 9. Hader Admin *(ALIGNED internal — not visible to customers)*

A separate super-admin console for running the whole platform across every tenant.

### Tenants
- List every business on the platform with search, member/product/service counts, and status.
- **Suspend / reactivate / delete** organizations; **impersonate** a tenant for support; live system-health tiles; generate one-time password-reset links for locked-out customers.

### System health
- Queue depths, Redis throughput, failure counts, **uptime self-probe** (24h/7d + p95 latency), optional external uptime monitoring, and API traffic by route — with a "drain failed jobs" control.

### Revenue
- **Monthly Recurring Revenue (MRR)**, tenant counts by subscription status, 30-day churn, and a per-plan revenue breakdown.

### Cross-tenant audit
- Browse the audit trail across all tenants with filters (type, tenant, person, date) for compliance and support.

### AI provenance
- The cross-tenant **AI accountability browser**: every bot reply with its cited sources and any hallucination flags, filterable, with a flagged-only toggle and a deep link into the conversation. *(This is the safety/trust system that proves the AI stays grounded.)*

### Suppression list
- Manage phrases that should be ignored by the hallucination detector (per-tenant or global), tuned over time as admins mark false alarms.

### New tenant
- Provision a brand-new business in one form: org name, plan, primary admin user, optional auto-generated password, and a welcome email — used to onboard a customer in minutes.

---

## 10. Sign-in & public pages

- **Login** — with optional 2FA step (authenticator code or recovery code).
- **Sign up** — create an organization and admin account.
- **Forgot / reset password**, **verify email**, **accept invitation** — the standard secure account flows.
- **Status page** — a public, always-available system-status page (operational/degraded/down, uptime %, latency) that stays up even if the app is down.

---

*Every screen is responsive (works on phone and desktop), brand-themed, and — for the business user — operated entirely by filling in forms and reading dashboards. No technical skill is required anywhere in the customer-facing app.*
