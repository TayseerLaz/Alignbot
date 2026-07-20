# AI Engineering Upgrade Plan

> Goal: close the gap to the AI-native leaders (Sierra / Fin / Ada) on retrieval quality,
> grounding, and evaluation — while keeping the moats we already have (Arabic, provenance,
> native commerce, voice). This is the roadmap; implementation follows.
>
> **Author:** planning pass 2026-07-20. **Status:** not started.
> **Canary tenant for every rollout:** `aseer-time` (max plan, 477-item Arabic F&B catalog, voice + WhatsApp) — the hardest real case we have.

---

## 0. Principles that apply to every workstream

1. **Fail-open, always.** Every new AI stage must degrade to today's behaviour on error / missing key / timeout. Never brick a reply. (Matches the existing doctrine in `openai.ts` / `ai-messages.ts`.)
2. **Three-mode feature flags.** Each behaviour ships as `off | shadow | enforce`. Shadow logs what it *would* do without changing output, so we tune thresholds on real traffic before enforcing. Per-env first, then per-tenant.
3. **Eval-gated.** No retrieval / prompt / model change ships to prod without passing the eval harness (Workstream 3). So a **minimal** eval scaffold is built first, as the safety net for everything else.
4. **Canary on Aseer, then widen.** Aseer is max-plan, Arabic, big-catalog, voice — if a change is safe there it's safe anywhere.
5. **Buy the ML, build the glue.** Reranker = Cohere API. NLI = hosted / Groq-hosted model. Prompt Guard = Groq-hosted. We write orchestration, not models.

### Recommended phasing

| Phase | Contains | Why this order |
|---|---|---|
| **Phase 0** (quick wins + safety net) | WS4b opted-out gate · **minimal** eval scaffold (WS3 slice: golden sets + binary judge + retrieval hit-rate) | 4b is a 30-min compliance fix; the eval slice is the prerequisite that makes the P0s safe to ship |
| **Phase 1** (the P0s, behind the eval) | WS1 retrieval · WS2 grounding gate · WS4a messenger provenance+validators | The two highest-impact quality levers + the channel that currently has none of it |
| **Phase 2** (the big P1) | WS3 full CI/simulation · WS5 Foodics (own track) | Foodics is the largest; it parallels the eval build-out |
| **Phase 3** (P2s) | WS6 model-layer hardening · WS7 Arabic exemplars + voice + cascaded spike | Polish + the voice re-architecture spike |

### Rough effort (Claude-assisted dev-days)

| WS | Item | Days |
|---|---|---|
| 1 | Two-stage retrieval | 3–5 |
| 2 | Grounding gate | 3–4 |
| 3 | Eval + CI (phased) | 6–10 |
| 4a / 4b | Messenger provenance / opted-out gate | 1–2 / 0.5 |
| 5 | Foodics POS (phased) | 10–15 |
| 6 | Model-layer hardening | 3–5 |
| 7 | Arabic exemplars + voice + cascaded spike | 2 + 5–8 |

---

## Workstream 1 — Two-stage retrieval (P0)

**Objective:** replace single-stage embedding top-K with `hybrid retrieve → metadata pre-filter → cross-encoder rerank → top slice`. Kills the "didn't see the right item" bug class on large catalogs.

### Current state
- `apps/api/src/lib/bot-engine.ts` `buildBotResponse` selects products via embedding top-K only: constants `TOP_K=40`, `SMALL_CATALOG=60`, `BROWSE_CAP=150`, plus deterministic safety nets (keyword-name augmentation, size-sibling inclusion, cart/pinned keep-set).
- `apps/api/src/lib/embedding.ts`: `text-embedding-3-small` (1536-dim), `embed`, `embedBatch`, `topKByEmbedding` (cosine).
- **Already available for the sparse half:** `Product.searchText` (denormalised name+desc) + `pg_trgm` extension + GIN trigram indexes (initial migration). We do **not** need to build BM25 — trigram similarity on `search_text` is the sparse retriever.
- Metadata filter fields already on `Product`: `categoryId`, `priceMinor`, `isAvailable`. **Gap:** no per-branch/location scoping on products (branch filter deferred — note below).

### Target design
```
allProducts (embedded, from gatherBotData)
        │
        ├── dense:  topKByEmbedding(query)              → ranked list D
        ├── sparse: trigram similarity on search_text   → ranked list S   (new)
        │
   RRF fuse(D, S, k=60)                                 → ~60 candidates   (new)
        │
   metadata pre-filter (isAvailable, category, price)   → filtered set     (new, conservative)
        │
   Cohere Rerank v3.5 (multilingual, Arabic-ok)         → top 15–20        (new, flagged)
        │
   + deterministic safety nets (keyword aug, siblings, cart/pinned keep)   (keep, run AFTER rerank)
```

### Steps
1. **New module `apps/api/src/lib/retrieval.ts`** with:
   - `sparseSearchProducts(tx, orgId, query, limit)` → raw SQL: `SELECT id, similarity(search_text, $q) AS s FROM products WHERE organization_id=$org AND deleted_at IS NULL AND is_available AND search_text % $q ORDER BY s DESC LIMIT $n`. Returns `[{id, score}]`.
   - `rrfFuse(denseRanked, sparseRanked, k=60)` → fused `[{id, rrf}]` (pure, unit-testable).
   - `rerank(query, docs, topK)` → Cohere Rerank call over `docs=[{id, text: name+" · "+desc}]`; returns reordered ids. Timeout ~1.5s; on error/no-key → return input order unchanged.
2. **Metadata pre-filter** (`applyStructuredFilters`): parse only **high-confidence** structured signals from the message — price ceiling ("under 5", "أقل من"), explicit category tokens matched to real category names. Filter the fused candidate set. **Conservative by design** — when unsure, don't filter (over-filtering = over-refusal). `isAvailable` already enforced in gatherBotData.
3. **Wire into `buildBotResponse`** — wrap the product-selection block in `selectProducts(args, allProducts)`:
   - Small catalog (≤ `SMALL_CATALOG`) → unchanged (send whole menu).
   - Browse intent → unchanged (`BROWSE_CAP` slice; rerank a browse is low-value).
   - Search intent → `hybrid → filter → rerank`, then apply the existing safety nets **after** rerank.
   - Voice path → **skip rerank** (latency budget) OR use it only when the candidate set is large; measure.
4. **Redis cache** rerank results by `rerank:{org}:{hash(query+candidateIds)}` short TTL (60s) to dedupe repeated turns.
5. **Extend to services + FAQs** in a second pass (start products-only).

### Data model / deps / env
- No migration (reuses `search_text` + indexes). *(Optional later: a `tsvector` column for true BM25 — not needed for v1.)*
- New deps: none required (call Cohere via `undici` fetch). Env:
  - `RERANK_ENABLED` (bool), `RERANK_MODE=off|shadow|enforce`
  - `COHERE_API_KEY`, `COHERE_RERANK_MODEL=rerank-v3.5`
  - `RERANK_CANDIDATE_N=60`, `RERANK_TOP_K=18`
- Keep `.env.example` in sync.

### Testing / verification
- Unit: `rrfFuse` ordering; `applyStructuredFilters` doesn't drop the target on ambiguous queries.
- **Retrieval eval (ties to WS3):** a labelled set `query → expected product SKU` on Aseer's catalog; measure **hit-rate@k before vs after**. Target: the "شي ثاني sizes / عادل الأسطورة" class always in top-K.
- Latency probe: p50/p95 added by rerank on text vs voice.

### Rollout
`shadow` (log the reranked order + whether it would've changed the packed set, don't use it) → tune `RERANK_TOP_K` / candidate N against hit-rate → `enforce` on Aseer → widen.

### Risks
- **Latency on voice** → skip rerank on voice or cap candidate N.
- **Arabic rerank quality** → verify `rerank-v3.5` on Arabic/Arabizi queries in shadow before enforce; keep embedding order as fallback.
- **Over-filtering** → conservative filters + safety nets after rerank.
- **Branch scoping** deferred until products carry a location link (revisit with WS5 Foodics, which brings per-branch menus).

---

## Workstream 2 — Grounding gate (P0)

**Objective:** stop sending replies that assert products/prices not in the catalog. Turn the existing post-hoc hallucination scanner into a **pre-send gate** that refuses/escalates instead of guessing.

### Current state
- `apps/api/src/lib/provenance-scanner.ts` `scanReply(reply, candidates, suppressed)` → `{citations, hallucinations[]}` where each hallucination has `type` (`unknown_product`/`price_drift`/`unknown_business_info`), `severity` (`critical`|`warning`), `matchedText`, `reason`. **Pure function.**
- It runs **after send** in `apps/api/src/modules/whatsapp/whatsapp.routes.ts` (`recordProvenance` ~L5990, well after `sendOk`/the Meta send at ~L5276–5325). Audit only.
- `completeFast` (Haiku) available for a cheap verifier.

### Target design — layered, no Python sidecar for v1
- **Layer A (deterministic, free, already computed):** run `scanReply` **before send** on the validated reply, using the same `kb` we already assemble for `validateReply` (~L4115). If it returns any **`critical`** hallucination → **BLOCK**.
- **Layer B (cheap LLM verifier, borderline only):** when the reply contains price/product-shaped content and Layer A is clean, a `completeFast` (Haiku) groundedness check: given `reply` + the packed catalog facts, return `{grounded: bool, unsupported: string[]}`. Below threshold → BLOCK. Skipped on plain/non-catalog replies to save latency.
- **Layer C (future, higher fidelity):** self-host **LettuceDetect** (ModernBERT, token-level NLI span-flagging) or **Vectara HHEM** as a small Python FastAPI sidecar. Document; not v1.

**On BLOCK:** don't send the ungrounded text. Instead send a safe fallback ("Let me confirm that with the team, one moment 🙏"), flip the thread to `pending`, notify the operator (reuse the handoff path), and record `blocked=true, blockReason` on provenance. This is the sellable behaviour: **"won't guess — escalates."**

### Steps
1. New `apps/api/src/lib/grounding-gate.ts` → `groundingGate(reply, kb, {mode, tenant})` returning `{ok: bool, reason?, layer?}`.
2. Call it in `whatsapp.routes` **after** `validateReply` (~L4181) and **before** the send block (~L4923). If `!ok && mode==='enforce'` → swap reply for the safe fallback + escalate.
3. Also call it in `messenger.routes` (pairs with WS4a).
4. Also call on the voice reply path.
5. Extend `recordProvenance` inputs with `blocked`/`blockReason`.

### Data model / deps / env
- Migration (additive): `MessageProvenance.blocked BOOLEAN DEFAULT false`, `block_reason TEXT NULL`. (Optional new `NotificationKind` value `grounding_block`.)
- Env: `GROUNDING_GATE_MODE=off|shadow|enforce`, `GROUNDING_GATE_LAYERB=bool`, `GROUNDING_CONFIDENCE_MIN` (Layer B threshold).
- Deps: none new (Haiku already wired).

### Testing / verification
- Golden set: known-hallucination replies (must BLOCK) + known-good replies incl. valid price quotes and cart totals (must **NOT** block — the over-refusal guard).
- Shadow metrics: block-rate per tenant per day; inspect every shadow-block to confirm it *should* have blocked before enforcing.

### Rollout
`shadow` (log would-block, don't block) → inspect + tune threshold → `enforce` on Aseer → widen. **Do not enforce before shadow data shows a low false-block rate.**

### Risks
- **Over-refusal** — the #1 risk; mitigate with shadow-first + Layer-A-only initially (deterministic, high-precision) + tuning against the false-block golden set.
- **Latency** — Layer B only on price/product replies.
- **Order receipts / cart totals** — ensure the scanner's stoplist (Subtotal/Total/KWD…) already excludes these (it does) so confirmations don't false-block.

---

## Workstream 3 — Eval + CI regression gate (P1)

**Objective:** a harness that proves a change doesn't regress any tenant (esp. an Arabic one) before it ships. Enables every other workstream to move safely. **Build a minimal slice in Phase 0**, flesh out in Phase 2.

### Current state
- `BotTestScenario` (per-org: `key`, `prompt`, `expectation`, `source`, `sortOrder`) + an LLM-judge already power the "Test & ship" UI (13 manual rows on hader-support).
- `apps/e2e/` Playwright harness + 7 QA subagents. `buildBotResponse({compileOnly})` runs the engine without spending tokens.

### Target design
1. **Golden sets** — extend `BotTestScenario` with `channel`, `dialect`, `expectedCitations` (which product/FAQ SKUs the answer should cite). Seed **per-tenant** sets of real dialectal phrasings by mining `MessageProvenance` (sampled + flagged rows). Script: `packages/db/scripts/build-golden-from-provenance.ts`.
2. **Runner** (`apps/eval/` — mirror `apps/e2e/`): for each scenario, run the real engine (`buildBotResponse` + `complete`) against a staging DB snapshot, capture reply + provenance, then score:
   - **Deterministic (required gate):** no `critical` hallucination; cites the expected source; language matches; no markdown leak; grounding-gate would pass.
   - **Binary LLM-judge (advisory→gate):** strong judge model (Sonnet/Opus, even though prod uses cheaper) given the `expectation` → pass/fail + critique. **Binary, not 1–5.**
3. **Judge alignment** — `calibrate-judge.ts`: a human labels ~50 scenarios pass/fail; few-shot the judge from them; measure precision/recall + **Cohen's κ (target >0.7)** on a held-out split. Commit the aligned judge prompt.
4. **Multi-turn simulation** — an LLM user-simulator drives a goal ("order 2 juices to Riyadh, pay cash") against the real cart flow; assert the order captured correctly (right items, fields, total). Mirrors DeepEval `ConversationSimulator`. Covers cart + voice flows where single-turn evals miss drift.
5. **Retrieval eval** — hit-rate@k on the labelled `query→SKU` set (feeds WS1 tuning).
6. **CI gate** — extend `.github/workflows/ci.yml`: on changes touching `bot-engine.ts` / prompts / `retrieval.ts` / model config, spin an ephemeral Postgres+Redis, seed fixture tenants (**include an Arabic F&B tenant**), run the deterministic gate (required) + judge (threshold), **fail if pass-rate drops or any single tenant regresses**. Consider `promptfoo` for the diff-report, or the custom runner.
7. **Pre-deploy shadow-run** — a script that runs each live tenant's golden set against **staging** before a prod deploy; block deploy on regression.
8. **Surface** results in `/aligned-admin` (eval dashboard) + the existing Test & ship UI.

### Deps / env
- Dev deps: `promptfoo` (optional) / a strong judge model key. Fixture tenant seeds under `packages/db/scripts/`. Staging DB.

### Phasing
- **Phase 0 slice:** golden sets + binary judge + retrieval hit-rate (enough to gate WS1/WS2).
- **Phase 2:** CI wiring + multi-turn simulation + per-tenant shadow-run + dashboard.

### Risks
- **Judge misalignment** → calibrate + measure κ; keep the deterministic checks as the *required* gate and the judge advisory until κ>0.7.
- **Flaky/expensive evals** → cache; run the cheap deterministic set on every PR, the LLM-judge set on a schedule/pre-deploy.
- **Staleness** → mine sets from provenance so they track real traffic.

---

## Workstream 4 — Close the two channel gaps (P1)

### 4a. Messenger / Instagram → validators + provenance + grounding gate
**Current:** `messenger.routes.ts` `maybeReplyOnMessenger` builds `customerText`, runs `normalizeMarkdownForChannel(...,'plain')`, sends — but **never calls `validateReply` and never `recordProvenance`**. It *does* call `buildBotResponse`, so `result.inputs` (needed for provenance) is available.
**Steps:**
1. Before send (~L1016–1096): call `validateReply` with a kb built from `data` (same shape as whatsapp ~L4115), `voiceMode:'text'`, channel-aware. Apply the WS2 grounding gate here too.
2. After send + `botMessageId` persisted (~L1099–1127): call `recordProvenance({inputs: result.inputs, ...})`.
**Effort:** 1–2 d. **Risk:** minimal (additive). Some validators are WhatsApp-flavoured but harmless on Messenger; markdown mode already `plain`.

### 4b. WhatsApp opted-out skip-gate
**Current:** `maybeReplyAsBot` gates (whatsapp.routes ~L3224–3323) check `blockedAt` but **not `optedOutAt`**. Messenger already gates it (`messenger.routes` ~L651–660).
**Steps:** in the block-contact gate (~L3276, contact already loaded), add `if (contact?.optedOutAt) → skip (leave for human)`.
**Effort:** 0.5 d. **Risk:** none — it's a compliance bugfix. **Do this first (Phase 0).**
**Test:** extend `multi-number-whatsapp.test.ts` — an opted-out contact gets no bot reply; a Messenger test asserting a provenance row is written + validators fired.

---

## Workstream 5 — Foodics POS integration (P1)

**Objective:** live menu/price/stock/86 sync from Foodics + order push-back. The F&B moat none of the messaging rivals have; also solves variants/modifiers structurally.

### Template
Mirror the **Shopify** module end-to-end:
- API: `apps/api/src/modules/shopify/{shopify.routes.ts, shopify-webhook.routes.ts}`
- Worker: `apps/worker/src/jobs/shopify.ts` (+ `shopify-client.ts`)
- DB: `ShopifyConnection` / `ShopifyScrapeRun` / `ShopifyStagedItem` (staged-review-then-commit pattern)
- Feature flag: `shopify` org feature (`defaultDisabled`)

### Target
1. **Feature flag** `foodics` in `packages/shared/src/constants/org-features.ts` (`defaultDisabled`), backfill migration disables it for all orgs (mirror the shopify backfill).
2. **DB migration** `foodics_pos`: `foodics_connections` (encrypted `apiToken`/`businessReference`, base URL, `branchMapping` JSON, `autoSync`, `webhookSecret`), `foodics_sync_runs`, `foodics_staged_items` + enums. RLS inline **and** in `rls.sql` (rls-drift gate covers them).
3. **API module `apps/api/src/modules/foodics/`:**
   - `foodics.routes.ts`: connect / verify (creds via `encryptJsonSecret`, masked) / sync / staged list+approve+reject / import / DELETE — every route gated by `disabledFeatures.includes('foodics')`.
   - `foodics-webhook.routes.ts`: HMAC-verified receiver for menu-update / item-availability(86) / order-status webhooks.
4. **Worker `apps/worker/src/jobs/foodics.ts` + `foodics-client.ts`:**
   - Client: Foodics API — categories, products, **modifier-groups + modifiers**, branches, inventory/availability, orders. Paginated, `safeFetch`, rate-limit aware.
   - `phase:'scrape'`: normalise Foodics menu → products (+ variants) + **modifier groups** → `foodics_staged_items` (per-branch menus preserved).
   - `phase:'commit'`: `upsertOne` → then `emitWebhookEvent('catalog_changed')` + read-cache invalidate. Scheduled auto-sync (BullMQ repeatable) + webhook-triggered live update re-commits imported rows (no re-approval).
5. **Modifier tree (the structural payoff):** map Foodics modifier-groups → a structured modifier model the cart flow validates against (existence / cardinality / dependency / exclusion / upcharge — the stableKernel five rules). May need new `ProductModifierGroup` / `ProductModifier` tables (or extend `ProductVariant`). **This is the biggest sub-piece** — it's what turns "size variants as separate products" from a prompt patch into a real data model.
6. **Order push-back:** on `[CART:]` promote (whatsapp.routes ~L5619), if a Foodics connection exists, push the order to Foodics (branch-routed) via the orders API. Target Deliverect's ~99.6% injection reliability as the bar.
7. **86 sync:** Foodics availability webhook → `product.isAvailable=false` → cache invalidate → bot stops offering instantly (mechanism already exists).

### Phasing
(1) read-only menu import (scrape→review→commit) → (2) live 86/price webhooks → (3) order push-back → (4) modifier-tree structural mapping + cart validation.

### Deps / risks
- Foodics API creds per tenant; **sandbox test before live**. Per-branch menu routing; modifier model specifics; order-injection reliability. BullMQ jobIds use `-` not `:` (known gotcha). Staged rows cache normalised JSON → a normaliser fix needs a re-scrape or `jsonb_set` (shopify lesson).

---

## Workstream 6 — Model-layer hardening (P2)

### 6a. Input-side injection/jailbreak classifier
Add a pre-`buildBotResponse` check in `maybeReplyAsBot`. Use **Groq-hosted Llama Prompt Guard 2 (86M)** (we already have a Groq client). New `lib/input-guard.ts`; on high injection score → skip the LLM, log, send a safe reply / handoff. Flag `INPUT_GUARD_MODE=off|shadow|enforce`. **Shadow first** (false positives on Arabic/Arabizi are the risk).

### 6b. Fallback alerting (silent `max`→basic degrade)
`completeMax`/`completeUltra` currently `console.warn` on degrade. Add `degraded:true` to `CompleteResult` (record it on provenance — model field already recorded), increment a metric, and notify ALIGNED admins when a tenant's fallback rate crosses a threshold (dedupe/day). Cheap, closes a known blind spot — **do first in this WS.**

### 6c. Trace aux Haiku calls
`completeFast` (intent, contact-memory) writes no provenance → cost blind spot. At minimum record its tokens to the daily counter + a per-tenant aux tally (new small `AuxAiUsage` table or extend the usage aggregation). **Do second.**

### 6d. Per-turn routing (optional, last)
Route trivial turns (greetings, acks, yes/no) to a cheaper model using existing fastpath/intent signals. Lower value since the deterministic fastpath already short-circuits many; eval-gate any change.

**Risks:** Prompt Guard false positives (shadow); routing regressions (eval-gate).

---

## Workstream 7 — Arabic & voice (P2)

### 7a. Few-shot dialectal exemplars (beats MSA-drift better than a rule)
Add per-tenant example pairs (`customer msg → ideal dialectal reply`) injected into the prompt after the language lock in `bot-engine.ts`. Storage: new `BotConfig.dialectExemplars` (JSON) — additive migration. Seed from real good replies (mine provenance). Research (AL-QASIDA) shows few-shot dialectal examples reliably overcome the model's MSA default.

### 7b. Per-tenant TTS voice
`BotConfig.ttsVoiceName` exists but is often empty (voice tenants fall back to the env default). Set a **dialect-appropriate ElevenLabs voice per voice tenant** + expose the field in the bot-builder UI. Mostly data/ops + one UI field; the send path already honours it.

### 7c. Cascaded voice pipeline spike (evaluate vs native S2S)
The Aseer voicebot (separate repo) runs native **gpt-realtime S2S over 8 kHz PSTN**. Research favours **cascaded STT→LLM→TTS** for telephony (8 kHz, dialect-specific Arabic ASR/TTS, reliable transcripts, cost, no long-call context drift). **Spike:** build a cascaded variant (gpt-4o-transcribe / Deepgram → `voice-prompt` engine → ElevenLabs) and A/B **latency + Arabic accuracy + cost** vs current S2S. Gate the decision behind measured results. Bigger effort; keep as a scoped spike with a go/no-go.

---

## Dependency graph (what blocks what)

```
WS4b (opted-out)            ── standalone, do first
WS3-slice (golden+judge)    ── enables safe rollout of ▼
   ├── WS1 (retrieval)      ── independent; ship behind flag+eval
   ├── WS2 (grounding gate) ── uses scanReply (exists); independent of WS1
   └── WS4a (messenger)     ── pairs with WS2 (same reply path)
WS3-full (CI+sim)           ── Phase 2
WS5 (Foodics)               ── independent, own track, largest
WS6, WS7                    ── Phase 3; 6b/6c/7a/7b cheap, 7c a spike
```

## Cross-cutting deliverables
- Feature-flag registry + `off|shadow|enforce` helper.
- `.env.example` kept in sync per commit.
- Every new stage: fail-open + a shadow mode + an eval fixture.
- Update `CLAUDE.md` Current Status after each workstream ships.

---

*End of plan. Next step: pick Phase 0 (WS4b + eval slice) to start the engineering.*
