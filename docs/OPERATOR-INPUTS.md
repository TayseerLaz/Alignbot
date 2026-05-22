# Operator inputs the AI bot uses

> **Phase 10** — duplicate fields consolidated. Each concept now has **one** canonical home. Edit the canonical field and the bot picks it up on the next reply.

This is the complete list of everything an operator can configure on the platform that affects how the AI bot answers customers. Each row tells you:

- **Where you edit it** — the canonical page + field.
- **What the bot does with it** — exactly how it shows up in customer-facing replies.
- **Required vs optional** — the bot still works without optional fields, but the reply quality drops.

> **Rule of thumb:** the more you fill in here, the less the bot has to improvise. Every field you leave blank widens the surface for hallucinations.

---

## 1. Bot personality & behaviour

Edit at **`/bot`**. These shape how every reply sounds.

| Field | Required? | What the bot does with it |
|---|---|---|
| **Greeting** | ✅ Required | Opens conversations with this exact text. *Single source of truth* — drops the deprecated "greeting" intent in conversation-flow. |
| **Personality preset** (formal / casual / friendly / clinical) | ✅ Required | Sets the tone for every reply. |
| **Custom personality** (free text) | Optional | Overrides the preset if filled. Use sparingly — preset is usually enough. |
| **Languages** (en, ar, fr, …) | ✅ Required | The bot replies in the customer's language if it's in this list; falls back to the first language listed when the customer's language isn't supported. |
| **Reply mode** (text / voice / match customer) | ✅ Required | Whether replies come back as text, TTS voice notes, or matched to whatever the customer sent. |
| **TTS provider** (Google / ElevenLabs) | Required if reply mode is voice | Which engine synthesises voice replies. |
| **TTS voice** (specific voice name) | Optional | The exact voice ID — picks a default by language if blank. |
| **Greet by name** (toggle) | Optional | When on, the bot opens greetings with the customer's WhatsApp first name. |
| **Greeting image** (image upload) | Optional | Attached as the FIRST reply on a new conversation (only fires once per 2 minutes). |
| **Escalation rules** (fallback line) | Optional | What the bot says when it has to hand off to a human. |
| **Conversation flow intents** (intent → response template) | Optional | Operator-authored preferred wording for specific intents (e.g. "pricing", "delivery", "warranty"). **`greeting`, `welcome`, `about`, `who_we_are`, `company` intent keys are now SKIPPED** — their canonical homes are the Greeting field above and the About field on /business-info. |

---

## 2. Business identity & contact

Edit at **`/business-info`** → **Profile** tab. The bot quotes from these when customers ask "what is this?" / "where are you?" / "how do I contact you?".

| Field | Required? | What the bot does with it |
|---|---|---|
| **Business name** (Organization name) | ✅ Required | Source of truth for the business name. The bot cites it in greetings + answers. |
| **Tagline** | Optional | One-line description quoted when relevant. |
| **About** (long description) | ✅ Required | Answer to "tell me about you / what do you do / who are you?" *Single source of truth.* |
| **Website URL** | Optional | Sent when customers ask for the website. |
| **Timezone** | ✅ Required | Used for time-related answers + booking reminders. |
| **Operating hours** (per day) | ✅ Required | The bot reads these day-by-day when customers ask "are you open?" / "what are your hours?". Days you leave blank are reported as "Closed". |
| **Currency** (3-letter code) | ✅ Required | **Single source of truth** for prices. All products + services + cart totals inherit this. Per-product currency was removed. |

---

## 3. Locations (multi-branch businesses)

Edit at **`/business-info`** → **Locations** tab. Optional for single-location businesses.

| Field | Required? | What the bot does with it |
|---|---|---|
| **Name** (branch label) | ✅ Required per location | Quoted when customers ask "where are you?" / "which branch is closest?". |
| **Address line 1 / 2 / city / region / postcode** | ✅ Required | Full address the bot can share. |
| **Phone** | Optional | Quoted when asked. |
| **Maps URL** | Optional | Sent as a link when customers ask for directions. |
| **Default branch** (toggle) | Optional | The branch the bot defaults to when location isn't disambiguated. |

---

## 4. Contact channels

Edit at **`/business-info`** → **Contact** tab.

| Field | Required? | What the bot does with it |
|---|---|---|
| **Channel kind** (phone / email / whatsapp / instagram / facebook / …) | ✅ Required per row | Tells the bot which contact method this is. |
| **Value** (the actual phone / email / handle) | ✅ Required per row | The contact info itself. |
| **Public** (toggle) | ✅ Required | Only "public" channels are shared with customers; "internal" channels are operator-only. |

---

## 5. FAQs — the bot's primary Q&A source

Edit at **`/business-info`** → **FAQs** tab. **Single source of truth for Q&A.** The deprecated Knowledge Base section under /bot has been migrated here.

| Field | Required? | What the bot does with it |
|---|---|---|
| **Question** | ✅ Required | What the customer typically asks. |
| **Answer** | ✅ Required | Exact wording the bot will quote when the customer's message matches this question. Markdown supported. |
| **Visibility** (public / internal) | ✅ Required | "public" — bot can share. "internal" — bot reads for context but doesn't quote verbatim. |
| **Tags** | Optional | Free-form labels for filtering in admin. |
| **Sort order** | Optional | Higher-priority FAQs appear earlier in the prompt. |

> **Tip:** prefer one FAQ per distinct question. Duplicate FAQs cause the bot to pick one at random. Use the `/business-info` UI to merge dupes after the KB migration.

---

## 6. Policies

Edit at **`/business-info`** → **Policies** tab. The bot quotes these verbatim when relevant.

| Field | Required? | What the bot does with it |
|---|---|---|
| **Kind** (refund / shipping / privacy / terms / warranty / custom) | ✅ Required | Categorises the policy. |
| **Title** | ✅ Required | Short label. |
| **Content** | ✅ Required | Full policy text. Quoted in answers to "what's your refund policy?" / "do you ship to X?". |
| **Effective from / Version** | Optional | For your records. The bot only uses the latest published version. |
| **Published** (toggle) | ✅ Required | Only published policies appear in bot replies. |

---

## 7. Booking form (appointments / consultations)

Edit at **`/business-info`** → **Booking form** tab. Configure once; the bot collects these fields whenever the customer wants to book.

| Field | Required? | What the bot does with it |
|---|---|---|
| **Enabled** (toggle) | ✅ Required to use booking | Master switch. When off, the bot won't offer booking. |
| **Title** | ✅ Required | What you call this form (e.g. "Consultation booking"). |
| **Intent keywords** | ✅ Required | Words/phrases that trigger the booking flow ("book", "appointment", "consultation"). Multi-language supported. |
| **Fields** (custom collection) | ✅ Required | Each field has: `key` (machine), `label` (what bot asks), `type` (text / phone / email / date / select), `required` (toggle), `options` (for select fields). The bot collects these in order. |

> **Note:** the bot now **only confirms a booking when a `[BOOKING:]` marker is emitted**. If the LLM ever says "your booking is confirmed" without a marker, the validator replaces it with a re-confirm question — never a fake confirmation.

---

## 8. Shop form (orders / cart)

Edit at **`/business-info`** → **Shop form** tab. Configure once; the bot uses it for every order.

| Field | Required? | What the bot does with it |
|---|---|---|
| **Enabled** (toggle) | ✅ Required to use ordering | Master switch. |
| **Title** | ✅ Required | What you call this form (e.g. "Order details"). |
| **Currency** | ✅ Required | The currency for prices + cart totals. Inherits from Business info currency if blank. |
| **Intent keywords** | ✅ Required | Words that trigger the order flow ("order", "buy", "menu", "delivery"). Multi-language. |
| **Fields** (custom collection) | ✅ Required | Same shape as Booking — key/label/type/required/options. **Payment-method choices live here**, not in FAQs. |
| **Menu link** (URL) | Optional | Sent verbatim when customer asks "do you have a menu?". *Single source* — drop any FAQ-level menu link. |
| **Minimum order** (minor units) | Optional | Bot tells customer when they're below; won't emit the cart marker until they hit it. |
| **Delivery fee** (minor units) | Optional | Added to cart total. |
| **Free delivery above** (minor units) | Optional | Threshold above which delivery is waived. |
| **Confirmation message** | ✅ Required | The exact text the bot sends after a successful order. |

---

## 9. Products

Edit at **`/products`**. Each row is a physical thing the customer can buy.

| Field | Required? | What the bot does with it |
|---|---|---|
| **Name** | ✅ Required | The product name the bot uses verbatim. |
| **SKU** | ✅ Required | Unique identifier; the bot quotes it in `[IMAGE: <SKU>]` markers to attach images. **If the SKU doesn't match a real product, the image-marker validator drops it server-side.** |
| **Short description** | ✅ Required | The one-sentence description the bot quotes when describing the product. Quote the operator's wording exactly. |
| **Price (minor units)** | ✅ Required | The catalog price. Quoted directly. The scanner flags any drift (>2%) between this and what the bot actually says. |
| **Currency** | (Auto) | Inherits from Business info currency. Read-only. |
| **Images** | Recommended | Attached automatically when the bot mentions the product or the customer asks to see it. |
| **Category** | Optional | Used for grouping in admin; not surfaced to customers directly. |
| **Variants** (size / colour / option-set) | Optional | When set, the bot asks "which variant?" before confirming. |
| **Available** (toggle) | ✅ Required | Only available products appear in the bot's catalog. |

---

## 10. Services

Edit at **`/services`**. Each row is something the customer can book or buy time for.

| Field | Required? | What the bot does with it |
|---|---|---|
| **Name** | ✅ Required | The service name the bot uses verbatim. |
| **Short description** | ✅ Required | Quoted when describing the service. |
| **Base price (minor units)** | ✅ Required | The default price. |
| **Currency** | (Auto) | Inherits from Business info currency. Read-only. |
| **Duration (minutes)** | Optional | Quoted when relevant. |
| **Pricing tiers** | Optional | Multiple price points (e.g. "30 min: 50 USD, 60 min: 90 USD"). |
| **Availability windows** | Optional | When the service is bookable (weekly grid). |
| **Category** | Optional | Internal grouping. |
| **Available** (toggle) | ✅ Required | Only available services appear in the bot's catalog. |

---

## 11. Things that are now SINGLE SOURCE (no duplicates)

After Phase 10 the following concepts each have exactly one editable home:

| Concept | Edit at | Note |
|---|---|---|
| Q&A | `/business-info` → FAQs | The deprecated `/bot` → Knowledge base section is read-only; data was migrated. |
| Greeting | `/bot` → Greeting | Conversation-flow "greeting" / "welcome" intents are SKIPPED in the prompt. |
| About / who we are | `/business-info` → About | Conversation-flow "about" / "who_we_are" / "company" intents are SKIPPED. |
| Currency | `/business-info` → Currency | Per-product / per-service / per-shopForm currency overrides removed. |
| Payment methods | `/business-info` → Shop form → payment_method.options | Don't restate in FAQs; the bot uses the shopForm choices verbatim. |
| Menu link | `/business-info` → Shop form → Menu link | Don't put the URL in an FAQ; it lives here. |

---

## 12. What the AI does NOT control (operator-only)

For completeness, these are operator-side configs the bot doesn't read:

- WhatsApp channel credentials (`/whatsapp` page) — auth only.
- API keys + webhooks (`/api-keys`, `/webhooks`) — integrations only.
- Member roles + invitations (`/members`) — auth only.
- Billing + plan (`/billing`) — feature gating only.
- Categories (`/products` admin) — internal grouping; not surfaced to customers.

---

## 13. The simplest "bare minimum" to make the bot reply correctly

For a brand-new tenant, here's the smallest set of fields that produce useful replies:

1. **`/bot`** — Greeting, Personality preset, at least one Language, Reply mode.
2. **`/business-info` → Profile** — Business name, About, Timezone, Operating hours, Currency.
3. **`/business-info` → FAQs** — at least 3-5 FAQs covering your most common questions.
4. **`/products` OR `/services`** — at least one product/service with name, SKU, description, and price.
5. **`/business-info` → Shop form** (if you take orders) — Enabled, Currency, Intent keywords, payment_method field, Confirmation message.

Everything else is incremental — the more fields you fill in, the fewer chances the bot has to improvise.

---

## 14. How to verify a tenant is configured properly

- Send "hello" to the bot via WhatsApp — verify it greets correctly with the configured Greeting (+ by-name if toggled).
- Send "what do you sell?" — verify the bot lists products from your `/products` page, not anything else.
- Send "what are your hours?" — verify it quotes the operating hours you set on `/business-info`.
- Send a question covered by one of your FAQs — verify the bot quotes the answer verbatim.
- Send a price-mention scenario — verify the bot quotes the price in your configured currency.
- For an ALIGNED admin: open the bot reply in `/inbox` → click "AI source" → verify every claim has a citation pointing back to one of these canonical sources. Nothing in the answer should be uncited.

---

**Last updated:** 2026-05-22 (Phase 10 consolidation).
