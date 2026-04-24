# No-Code WhatsApp Chatbot on ALIGNED (Phase 1) — Step-by-Step Playbook

> **Who this is for:** A pilot client (or ALIGNED staff onboarding one) who wants
> a working WhatsApp chatbot **today**, using the Phase 1 data platform and
> zero custom code.
>
> **What you'll have at the end:** Customers WhatsApp your business number,
> the bot answers product questions, hours, FAQs, and policies — reading
> live data from the ALIGNED portal. No engineer needed.

---

## 0. Reality check (read this first)

Phase 1 of ALIGNED gives you the **data layer** — your catalog, business info,
FAQs, and an API chatbots can read from. It does **not** yet include a bot
builder; that's Phase 2.

So "zero-code bot" needs **four** tools, not three:

| Tool | Role | Cost |
|---|---|---|
| **ALIGNED portal** (alignbot.aligned-tech.com) | Holds data, serves read API | Already yours |
| **Shopify or Airtable** (optional) | Your product source of truth | What you already pay |
| **Meta WhatsApp Business** | Phone number + message gateway | Free for the first 1,000 user-initiated chats/month, then ~$0.005–0.08 each depending on country |
| **Landbot** | No-code "bot brain" — receives WhatsApp, calls ALIGNED, replies | Free tier: 100 chats/month. Starter ~$40/mo |

If you don't want a 4th tool, **you can still ship Phase 1 without a bot** —
the read API works today, and any developer (yours or ALIGNED's) can wire a
bot in a day. This playbook is the pure no-code route.

**Bot limits on this path:** Landbot flows are keyword/button driven, not
free-form AI conversation. The bot will match phrases like "hours",
"price", product names — not free paragraphs. For true conversational AI,
Phase 2's bot builder (or a paid Landbot add-on that plugs in OpenAI) is
what you want.

---

## Part 1 — Load your products into ALIGNED

Pick one path. You can change paths later.

### Path A — Manual entry (best for < 30 items)

1. In ALIGNED portal → **Products** → **New product**.
2. Fill in: SKU, name, description, price, currency, stock, availability, category.
3. Upload images (drag-and-drop).
4. Save. Repeat.

Done. Skip to Part 2.

### Path B — Shopify → ALIGNED via CSV (best for any size, manual refresh)

1. **In Shopify admin** → **Products** → **Export**.
   - Select: **All products**.
   - Format: **Plain CSV file**.
   - Click **Export products**. Wait for the email with the download link.
2. **In the ALIGNED portal** → **Imports** → **Download template** → pick **Products (XLSX)**.
   Open both files side by side (Excel or Google Sheets).
3. Copy your Shopify data into the ALIGNED template. Map columns like this:

   | ALIGNED template column | Copy from Shopify column | Notes |
   |---|---|---|
   | `sku` | `Variant SKU` | If blank, invent one (e.g. `SH-<ID>`). Must be unique. |
   | `name` | `Title` | |
   | `description` | `Body (HTML)` | Strip HTML tags in Excel with `=SUBSTITUTE(...)` or just paste and clean by hand |
   | `priceMinor` | `Variant Price` × **100** | $29.99 → **2999**. Use a formula. |
   | `currency` | (your shop's currency, e.g. `USD`) | |
   | `isAvailable` | `Status` | `active` → `true`, else `false` |
   | `stockQuantity` | `Variant Inventory Qty` | |
   | `categorySlug` | `Type` or `Tags` | lowercase-with-dashes, e.g. `yoga-mats` |

4. Save the filled-in template.
5. **In ALIGNED** → **Imports** → **New import** → **Products** → upload the file.
6. Watch the progress bar. Any failed rows show the reason; fix and re-upload.
7. Open **Products** — your catalog is there.

**To refresh when Shopify changes:** re-export, re-paste the changed rows,
re-upload. The import is idempotent on SKU (updates existing, creates new).
For live/automatic sync, see "Going further" at the end.

### Path C — Airtable → ALIGNED via CSV

Same idea as Path B. In Airtable → **View** → **Download CSV** → rename
columns to match ALIGNED's template (use the XLSX template from ALIGNED's
Imports page as the reference) → upload via **Imports**.

---

## Part 2 — Fill in the rest of your data in ALIGNED

The bot will quote this directly. Do it properly.

1. **Business Info** → **Profile tab**: legal name, tagline, about, currency, timezone.
2. **Business Info** → **Hours tab**: set opening hours for every weekday (or mark closed/24-7).
3. **Business Info** → **Locations**: address, phone, map link per location.
4. **Business Info** → **Contacts**: phone, email, WhatsApp number you want customers to reach.
5. **Business Info** → **FAQs tab**: add the 10–20 questions you get asked every week. Mark them **public** (private ones are staff-only).
6. **Business Info** → **Policies tab**: returns, shipping, privacy, booking, etc. One entry per kind.
7. **Services** (if you sell services): add each service with duration, base price, weekly availability grid.

**Rule of thumb for FAQs:** if customers ask it in WhatsApp more than twice a
month, it belongs in FAQs. The bot answers FAQ-style questions much better
than product questions, so this is high-leverage.

---

## Part 3 — Issue an ALIGNED API key for the bot

1. In ALIGNED portal → **API Keys** → **Issue new key**.
2. **Name:** `whatsapp-bot`.
3. **Scopes:** tick all three:
   - `read:catalog`
   - `read:business-info`
   - `read:faqs`
4. **Expires at:** leave blank.
5. **Create.**
6. **COPY THE SECRET NOW.** It looks like `ak_live_xxxxxxxxxxxxxxxxxxxxxxxx`.
   It will **never be shown again**. Paste it into a password manager
   (1Password, Bitwarden). You'll paste it into Landbot in Part 6.

---

## Part 4 — Create your Meta WhatsApp Business account

This is the part that takes the most calendar time (Meta's verification can
take 3–10 business days). Start here on day 1.

### 4.1 Set up the Meta Business account

1. Go to **business.facebook.com** → **Create account** (or log in).
2. **Business Settings** → **Business Info**:
   - Legal business name (exactly as on your registration documents)
   - Website
   - Business email (on your company domain, not gmail if possible)
   - Address, phone
3. Save.

### 4.2 Create a Meta app for WhatsApp

1. Go to **developers.facebook.com/apps** → **Create app**.
2. App type: **Business**.
3. Name: `<yourbusiness>-whatsapp`. Attach it to the Business account from 4.1.
4. On the new app dashboard → **Add products** → find **WhatsApp** → click **Set up**.
5. Meta auto-provides a **test phone number** (you can send from it immediately)
   and a temporary 24-hour token (you won't use this — Landbot will manage tokens for you).

### 4.3 (Later, when ready for real traffic) Add your real business phone number

1. **WhatsApp → Phone Numbers → Add phone number.**
2. Enter a number that is **not currently on the consumer WhatsApp app**.
   If it is: open consumer WhatsApp → Settings → Account → Delete my account
   first, or pick a different number. There's no way around this.
3. Verify by SMS or voice call.
4. Back in **Business Settings → Security Center → Business Verification** → submit.
   Meta will ask for a business registration document. Verification takes
   **3–10 business days**. Until then you're limited to the test number +
   up to 5 manually added recipient numbers.

### 4.4 Note these IDs (you'll paste them into Landbot)

On the app's **WhatsApp → API Setup** page, copy down:
- **Phone number ID** (looks like `109876543210987`)
- **WhatsApp Business Account ID**
- **App ID** (top of the app dashboard)

You don't need to copy the token — Landbot handles that.

---

## Part 5 — Create a Landbot account and connect WhatsApp

1. Go to **landbot.io** → **Sign up free**.
2. In Landbot dashboard → **Build a chatbot** → pick **WhatsApp** channel.
3. Landbot asks: "How do you want to connect WhatsApp?" → pick **Meta Cloud API (Bring your own)**.
4. Landbot walks you through a connect screen. Paste:
   - **Phone number ID** (from 4.4)
   - **WhatsApp Business Account ID** (from 4.4)
   - **Meta App ID** (from 4.4)
5. Landbot opens a Meta login popup → log in with the account that owns the
   Business Account → grant permission. This generates a long-lived token
   that Landbot stores for you. **No token copy-paste needed.**
6. Back in Landbot you should see the green "WhatsApp connected" state and
   your phone number listed.

### Set the webhook on Meta's side (one time)

Landbot will tell you the exact callback URL and verify token on screen. On
the **Meta app → WhatsApp → Configuration** page:

1. **Callback URL**: paste the URL Landbot gave you.
2. **Verify token**: paste the token Landbot gave you.
3. Click **Verify and save** — goes green.
4. **Webhook fields** → subscribe to **messages** (that's all you need).
5. Further down the Configuration page → **Subscribe** the app to the WhatsApp Business Account.

---

## Part 6 — Build the bot flow in Landbot (the heart of this guide)

You're now in Landbot's visual flow builder. Blocks are dragged onto a
canvas and connected with arrows. No code.

### 6.1 The overall shape of the flow

```
[Start] → [Ask: What can I help with?]
             │
             ├── "hours"    → [HTTP: get business hours]   → [Send hours] → [End]
             │
             ├── "products" → [Ask: which product?] → [HTTP: search] → [Send top 3] → [End]
             │
             ├── "faq"      → [HTTP: get faqs] → [Send top FAQs]       → [End]
             │
             └── anything else → [HTTP: search all] → [Send results]    → [End]
```

We'll build it block by block.

### 6.2 Welcome message

1. Drag a **Send message** block right after the green **Start** block.
2. Content: something like
   > Hi! I'm the <yourbusiness> assistant. I can help with:
   > • Products — try "yoga mat" or "shoes"
   > • Hours — type "hours"
   > • FAQs — type "faq"
   > • Anything else — just ask!

### 6.3 Capture the customer's question

1. Drag an **Ask a question** block.
2. **Save answer to variable**: `@user_query`.
3. No validation, accept free text.

### 6.4 Branch on keywords

1. Drag a **Conditional logic** block.
2. Add rules, in order:
   - If `@user_query` contains "hour" OR "open" OR "close" → go to the Hours branch.
   - If `@user_query` contains "faq" OR "help" OR "how do" → go to the FAQ branch.
   - Otherwise → go to the Search branch.

### 6.5 The Hours branch

1. Drag a **Set variable** block: set `@aligned_key` to your API key (`ak_live_...`).
   **Why as a variable:** if you ever rotate the key, you change it in one place.
2. Drag an **API request** block. Configure:
   - **Method:** GET
   - **URL:** `https://api.aligned-tech.com/api/v1/read/business-info`
   - **Headers:** add `X-Aligned-Api-Key` with value `@aligned_key`
   - **Save response to:** `@biz`
3. Drag a **Send message** block:
   > Our hours are:
   > Monday: @biz.data.openingHours.monday
   > Tuesday: @biz.data.openingHours.tuesday
   > … (and so on for each day)
   >
   > Need something else? Type "menu".

   (Landbot's variable picker handles the `@biz.data.openingHours.monday`
   path — you click through the response JSON visually.)

### 6.6 The FAQ branch

1. Drag an **API request** block.
   - **GET** `https://api.aligned-tech.com/api/v1/read/faqs`
   - Header: `X-Aligned-Api-Key`: `@aligned_key`
   - Save to `@faqs`.
2. Drag a **Send message** block:
   > Here are some common questions:
   > 1. @faqs.data[0].question
   >    → @faqs.data[0].answer
   > 2. @faqs.data[1].question
   >    → @faqs.data[1].answer
   > 3. @faqs.data[2].question
   >    → @faqs.data[2].answer
   >
   > Still can't find it? Type your question and I'll search.

### 6.7 The Search branch (the main one)

1. Drag an **API request** block.
   - **GET** `https://api.aligned-tech.com/api/v1/read/search?q=@user_query`
     (Landbot URL-encodes the variable automatically.)
   - Header: `X-Aligned-Api-Key`: `@aligned_key`
   - Save to `@results`.
2. Drag a **Conditional logic** block: if `@results.data.length` equals 0
   → go to the "no results" branch. Otherwise → go to the "show results" branch.
3. **No-results branch** → Send message:
   > Sorry, I couldn't find anything matching "@user_query".
   > Try different words, or call us at @biz.data.phone.
4. **Show-results branch** → Send message:
   > Here's what I found:
   >
   > *@results.data[0].name* — @results.data[0].priceMinor cents
   > @results.data[0].description
   >
   > *@results.data[1].name* — @results.data[1].priceMinor cents
   > …
   >
   > Want more details? Tell me the product name.

   (Dealing with `priceMinor` → dollars: Landbot has a **formula** block.
   Use `Divide(@results.data[0].priceMinor, 100)` then format with a $ sign
   in the message template.)

### 6.8 Fallback / "menu" loop

Add a **Keyword jump** rule that matches "menu" or "start" and sends the
conversation back to the welcome message. This way the user can always
restart by typing "menu".

### 6.9 Preview and test inside Landbot

1. Landbot top-right → **Preview**.
2. Type messages in the preview panel: "hours", "faq", "yoga mat".
3. Verify each branch returns the right data.
4. If a branch fails: Landbot shows the exact API response. 99% of problems
   are:
   - Wrong API key (401) — recopy from ALIGNED → API Keys.
   - Missing scope (403) — re-issue the key with all three scopes.
   - Wrong variable path (`@results.data[0].name` when the response actually
     nests it somewhere else) — click through the response viewer in
     Landbot to get the correct path.

### 6.10 Publish

1. Click **Publish** (top right) → **WhatsApp** channel.
2. Your bot is live on the Meta test number immediately, and on your real
   business number as soon as Meta verification completes (Part 4.3).

---

## Part 7 — End-to-end test from your own phone

1. On your phone, open WhatsApp → message the test number (or your real
   number if verified). Meta requires the *user* to message first, 24-hour
   window rules apply.
2. Type "hi" → should get the welcome message.
3. Type "hours" → should get opening hours from ALIGNED.
4. Type "faq" → should get top FAQs from ALIGNED.
5. Type a product name → should get search results with prices.

If none of the above arrives:
| Symptom | Likely fix |
|---|---|
| No reply at all | Meta Configuration webhook not verified, or app not subscribed to the WhatsApp Business Account. Re-check Part 5 last two steps. |
| Welcome arrives, branches don't | Flow arrows in Landbot aren't connected — open the canvas and look for orphan blocks. |
| "Something went wrong" | Usually the API request block. Click it → **Test** → read the error. |
| Right data but ugly prices | Add a Formula block: `Divide(@results.data[0].priceMinor, 100)`, save to `@p0`, then use `@p0` in the message. |

---

## Part 8 — Day-to-day operation (for the client)

**When you add/edit a product in ALIGNED:** it shows up in the bot
immediately (the read API cache is 60 seconds). No Landbot changes.

**When you edit FAQs or hours:** same — instant.

**When you want to change what the bot *says*:** edit the Landbot message
blocks. No ALIGNED changes needed.

**When you want to change what the bot *knows*:** edit in ALIGNED. No
Landbot changes needed.

**If the bot goes weird:** check Landbot → Analytics → conversation log.
You'll see which block each user reached.

---

## Part 9 — Going further (when the basic bot isn't enough)

These are no longer pure no-code, listed in increasing effort:

1. **Live Shopify sync (still no-code, adds Make.com):** Make.com has an
   Airtable, Shopify, and HTTP module. Build a scenario: "Shopify product
   updated → HTTP POST to ALIGNED's inbound webhook URL with the translated
   shape". Covered in Part 3 of the connector walkthrough.
2. **AI-style free-form replies (no-code, adds OpenAI to Landbot):**
   Landbot has a native **AI agent** block (paid add-on). Drop it in the
   fallback branch, feed it the top search results as context, and it'll
   answer conversationally instead of showing a list. ~$20–50/mo added.
3. **Waiting for Phase 2:** the in-platform bot builder will replace
   Landbot entirely with a first-party experience that knows about ALIGNED
   data natively. ETA: see the Phase 2 plan in [PHASE_1_OVERVIEW.md](PHASE_1_OVERVIEW.md) §6.

---

## Part 10 — Pilot onboarding checklist (print this)

Give this to a pilot client:

- [ ] ALIGNED portal account created + email verified
- [ ] Products loaded (Path A, B, or C)
- [ ] Services loaded (if applicable)
- [ ] Business Info → Profile filled
- [ ] Business Info → Hours filled for every weekday
- [ ] Business Info → Locations filled
- [ ] Business Info → FAQs: at least 10 entries, all public
- [ ] Business Info → Policies: returns + shipping + privacy at minimum
- [ ] API key issued with all three read scopes, secret stored in password manager
- [ ] Meta Business Account created + business info submitted
- [ ] Meta app created with WhatsApp product
- [ ] Test phone number working (sent `hello_world` template to self)
- [ ] Real business phone number submitted (if ready)
- [ ] Business verification submitted to Meta
- [ ] Landbot account created (free tier or paid)
- [ ] Landbot WhatsApp channel connected to Meta (green check)
- [ ] Landbot webhook URL + verify token pasted into Meta Configuration
- [ ] Bot flow built: welcome, hours, FAQ, search branches
- [ ] Landbot API blocks all green in Preview
- [ ] Bot published to WhatsApp
- [ ] Tested end-to-end from your own phone: hi, hours, faq, product-name
- [ ] Pilot users added to the Meta test number (up to 5 until verification)

---

*Last updated: 2026-04-24 · Maintained alongside [PHASE_1_OVERVIEW.md](PHASE_1_OVERVIEW.md).*
