// Phase 2 §4.1.1 — website crawler + LLM analysis worker.
//
// Strategy (Playwright-rendered):
//   1. BFS-walk pages within the same origin starting at root_url.
//   2. Up to maxPages, up to maxDepth links deep.
//   3. For each page: launch a headless Chromium context, navigate with
//      `waitUntil: 'networkidle'` so React / Vue / Next-rendered SPA
//      content has time to mount, then extract page.content() and feed
//      it to cheerio for prose extraction.
//   4. Persist to crawl_pages.
//   5. Once crawl is done, fan out a single LLM analyze call that turns the
//      cleaned corpus into KnowledgeBaseEntry rows + detected_tone, which
//      we write to BotConfig.
//
// SSRF: we route every fetch through assertSafeOutboundUrl so a tenant
// can't aim the crawler at internal services.
//
// Why Playwright vs the old plain HTTP fetcher: SPAs (alinia, most modern
// estate / e-commerce / SaaS marketing sites) return only a minimal HTML
// shell over HTTP — the actual property cards / product cards / FAQs
// don't exist until JavaScript runs in the browser and renders them. The
// HTTP-only crawler captured the shell on every URL (same 277-char skeleton
// across the entire site), which made the KB extraction nearly empty.
import { assertSafeOutboundUrl, UrlGuardError } from '@aligned/shared';
import { Worker } from 'bullmq';
import * as cheerio from 'cheerio';
import type { Browser, BrowserContext, Page } from 'playwright';

import { isOpenAIConfigured, workerComplete } from '../lib/openai.js';
import { env } from '../lib/env.js';
import { getConnection } from '../lib/redis.js';

import { prisma, withRlsBypass } from './db.js';

interface CrawlPayload {
  organizationId: string;
  crawlJobId: string;
}

const MAX_BODY_BYTES = 100_000; // 100 KB per page
const NAV_TIMEOUT_MS = 15_000;  // DOMContentLoaded should fire well within this
const RENDER_DELAY_MS = 3_000;  // post-DCL wait so React/Vue can mount + render
// Why not 'networkidle': many real sites keep a persistent connection open
// (analytics beacons, chat widgets, live-data poll). networkidle never fires,
// the timeout trips, and the navigation throws BEFORE we can extract anything.
// DOMContentLoaded + a generous render delay is reliable across SPA frameworks
// without depending on quiescent network behaviour that the site may never
// actually reach.

// Lazy-initialised, lifecycle-managed Chromium. ONE browser process per
// worker (cold start ~1s; subsequent pages share it). Each page gets its
// own incognito-style context so cookies / localStorage don't bleed
// between sites. The browser is never explicitly closed during the
// worker's lifetime — the process restart on each deploy bounds the
// memory footprint.
let _browser: Browser | null = null;
async function getBrowser(): Promise<Browser> {
  if (_browser && _browser.isConnected()) return _browser;
  const { chromium } = await import('playwright');
  _browser = await chromium.launch({
    headless: true,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
    ],
  });
  return _browser;
}

function sameOrigin(a: URL, b: URL): boolean {
  return a.origin === b.origin;
}

function cleanText($: cheerio.CheerioAPI): string {
  // Strip noise.
  $('script, style, noscript, iframe, svg, header nav, footer, [aria-hidden="true"]').remove();
  // Inline all-text approach — collapse whitespace.
  const raw = $('body').text() || $('html').text();
  return raw.replace(/[\t\r\n]+/g, '\n').replace(/[ ]{2,}/g, ' ').trim().slice(0, MAX_BODY_BYTES);
}

async function fetchOnePage(url: string): Promise<{
  status: number;
  contentType: string | null;
  html: string | null;
  error?: string;
}> {
  let context: BrowserContext | null = null;
  let page: Page | null = null;
  try {
    const browser = await getBrowser();
    // Fresh context per page: isolated cookies / storage so cross-site
    // tracking + previous-page side effects can't influence this fetch.
    context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko)' +
        ' Chrome/120.0.0.0 Safari/537.36 HaderBot/1.0 (+https://hader.ai/bot)',
      viewport: { width: 1280, height: 800 },
      javaScriptEnabled: true,
      // Most public marketing sites don't gate on locale; defaulting to
      // en-US is the safest baseline. The bot itself handles whatever
      // language the rendered content arrives in.
      locale: 'en-US',
    });
    page = await context.newPage();

    // Block images / media / fonts so the crawler isn't pulling MBs of
    // assets it'll never use. Stylesheets stay enabled because some
    // sites render content only when CSS resolves (rare but real).
    // Documents / scripts / xhr / fetch all proceed normally — the
    // whole point of using Playwright is to let the JS run.
    await page.route('**/*', (route) => {
      const t = route.request().resourceType();
      if (t === 'image' || t === 'media' || t === 'font') return route.abort();
      return route.continue();
    });

    // Wait for the document to parse — fires quickly + reliably even
    // when the page keeps long-running network connections open.
    const response = await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: NAV_TIMEOUT_MS,
    });

    // Give React / Vue / Next-app-router time to mount + render after
    // DCL. Most SPAs render their main content within 1-3s of DCL once
    // their hydration script runs. We pay this delay per page (~3s),
    // which is the dominant per-page cost.
    await page.waitForTimeout(RENDER_DELAY_MS);

    const status = response?.status() ?? 0;
    const ctypeHeader = response?.headers()['content-type'] ?? null;
    // Always grab page.content() — that's the FULLY RENDERED HTML, not
    // the original document.
    const html = await page.content();
    return { status, contentType: ctypeHeader, html };
  } catch (err) {
    return {
      status: 0,
      contentType: null,
      html: null,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    try {
      if (page) await page.close({ runBeforeUnload: false });
    } catch { /* noop */ }
    try {
      if (context) await context.close();
    } catch { /* noop */ }
  }
}

function extractLinks($: cheerio.CheerioAPI, base: URL): URL[] {
  const out: URL[] = [];
  $('a[href]').each((_i, el) => {
    const href = ($(el).attr('href') ?? '').trim();
    if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:')) return;
    try {
      const u = new URL(href, base);
      if (sameOrigin(u, base)) out.push(u);
    } catch {
      /* ignore */
    }
  });
  return out;
}

export function startCrawlWorker() {
  return new Worker<CrawlPayload>(
    'crawl',
    async (job) => {
      const { organizationId, crawlJobId } = job.data;
      const meta = await prisma.crawlJob.findUnique({ where: { id: crawlJobId } });
      if (!meta) return;

      try {
        await prisma.crawlJob.update({
          where: { id: crawlJobId },
          data: { status: 'running', startedAt: new Date() },
        });

        // SSRF guard.
        let rootUrl: URL;
        try {
          rootUrl = assertSafeOutboundUrl(meta.rootUrl);
        } catch (err) {
          await prisma.crawlJob.update({
            where: { id: crawlJobId },
            data: {
              status: 'failed',
              errorMessage: err instanceof UrlGuardError ? err.message : 'Refused outbound URL.',
              finishedAt: new Date(),
            },
          });
          return;
        }

        const seen = new Set<string>([rootUrl.toString()]);
        const queue: { url: URL; depth: number }[] = [{ url: rootUrl, depth: 0 }];
        let crawled = 0;
        let failed = 0;
        let dedupSkipped = 0;
        const cleanCorpus: { url: string; title: string | null; text: string }[] = [];
        // Body-hash dedup. SPAs typically render the same shell for any
        // URL whose JS reads ?param=… and filters client-side — alinia's
        // /properties?location=beirut etc. all return the identical
        // 22,904-char body. Without this, the crawl wastes ~3s per dupe
        // page AND ships duplicate content to the LLM analyse step,
        // both bloating tokens and skewing the KB toward whatever the
        // SPA happens to dump on every URL. We hash the cleaned body
        // text after extraction; if a hash collides with one we've
        // already stored, we drop the row + don't enqueue any links
        // from it (its links are by definition the same as the dupe).
        const { createHash } = await import('node:crypto');
        const seenBodyHashes = new Set<string>();

        while (queue.length > 0 && crawled + failed < meta.maxPages) {
          // Cancellation check. The operator can flip the job's status to
          // 'cancelled' from /bot at any time; the worker picks it up at
          // each page boundary and exits cleanly. We don't re-read the
          // row on every loop — once every 3 pages is plenty (~9s at the
          // new ~3s/page pace) and keeps DB chatter bounded.
          if ((crawled + failed) % 3 === 0) {
            const current = await prisma.crawlJob.findUnique({
              where: { id: crawlJobId },
              select: { status: true },
            });
            if (current?.status === 'cancelled') {
              await prisma.crawlJob.update({
                where: { id: crawlJobId },
                data: {
                  pagesCrawled: crawled,
                  pagesFailed: failed,
                  finishedAt: new Date(),
                  errorMessage: 'Crawl stopped by operator.',
                },
              });
              return; // exit the worker handler — BullMQ marks the job done
            }
          }
          const next = queue.shift()!;
          const r = await fetchOnePage(next.url.toString());
          if (r.error || !r.html) {
            failed += 1;
            await prisma.crawlPage.create({
              data: {
                organizationId,
                crawlJobId,
                url: next.url.toString(),
                fetchStatus: r.status,
                errorMessage: r.error ?? `Non-HTML (${r.contentType ?? 'unknown'})`,
              },
            });
            continue;
          }
          const $ = cheerio.load(r.html);
          const title = $('title').first().text().trim() || null;
          // Order matters here. extractLinks reads <a href> across the
          // whole document; cleanText calls .remove() on header/nav/
          // footer/script/style which would DESTROY the navigation
          // anchors that extractLinks needs to walk. Pre-2026-05-27
          // these ran in the wrong order and the crawler queued zero
          // children on any site whose nav was wrapped in proper
          // <header><nav>...</nav></header> (most modern frameworks).
          const childLinks = next.depth < meta.maxDepth
            ? extractLinks($, next.url)
            : [];
          const text = cleanText($);

          // Body-hash dedup. Skip pages whose extracted prose matches a
          // page we've already crawled — typically client-side filter
          // variants (e.g. /properties?location=beirut returning the
          // identical shell as /properties). We DON'T enqueue children
          // from a dupe page either: they'd be the same children as
          // the page we already have.
          const bodyHash = createHash('sha256').update(text).digest('hex');
          if (text.length > 0 && seenBodyHashes.has(bodyHash)) {
            dedupSkipped += 1;
            // Continue without persisting / enqueuing. Don't count as
            // a failure either — it's a deliberate skip.
            continue;
          }
          seenBodyHashes.add(bodyHash);

          await prisma.crawlPage.create({
            data: {
              organizationId,
              crawlJobId,
              url: next.url.toString(),
              fetchStatus: r.status,
              title,
              bodyText: text || null,
            },
          });
          cleanCorpus.push({ url: next.url.toString(), title, text });
          crawled += 1;
          await prisma.crawlJob.update({
            where: { id: crawlJobId },
            data: { pagesCrawled: crawled, pagesFailed: failed },
          });
          // Enqueue children we just collected (before cleanText nuked
          // the source elements).
          if (next.depth < meta.maxDepth) {
            for (const link of childLinks) {
              const key = link.toString().split('#')[0]!;
              if (!seen.has(key)) {
                seen.add(key);
                queue.push({ url: new URL(key), depth: next.depth + 1 });
              }
            }
          }
        }

        console.info(
          `[crawl] BFS finished: crawled=${crawled} failed=${failed} ` +
            `dedup_skipped=${dedupSkipped} unique_bodies=${seenBodyHashes.size} ` +
            `corpus_chars=${cleanCorpus.reduce((s, p) => s + p.text.length, 0)}`,
        );

        // Run LLM analysis if configured. Otherwise mark partial.
        let analysisOK = false;
        let listingsCreated = 0;
        if (isOpenAIConfigured() && cleanCorpus.length > 0) {
          analysisOK = await analyzeAndPersist(organizationId, cleanCorpus).catch((err) => {
            console.error('[crawl] analysis failed', err);
            return false;
          });
          // Second pass: extract per-listing structured products from any
          // listing-shaped page (multiple price patterns + repeating card
          // structure). Lands as DRAFT products (isAvailable=false) so
          // the operator reviews before they go live in the bot.
          listingsCreated = await extractAndPersistListings(
            organizationId,
            crawlJobId,
            cleanCorpus,
          ).catch((err) => {
            console.error('[crawl] listings extract failed', err);
            return 0;
          });
          if (listingsCreated > 0) {
            console.info(`[crawl] extracted ${listingsCreated} draft Product rows from listing pages`);
          }
        }

        const status = failed > 0 && crawled === 0 ? 'failed' : analysisOK ? 'succeeded' : 'partial';
        // Only surface the AI-key notice when the crawl part actually
        // worked. Otherwise the per-page fetch error is the useful signal
        // and we'd rather not mask it.
        let errorMessage: string | null = null;
        if (status === 'failed') {
          const firstFailure = await prisma.crawlPage.findFirst({
            where: { crawlJobId, errorMessage: { not: null } },
            select: { url: true, errorMessage: true, fetchStatus: true },
          });
          errorMessage = firstFailure
            ? `Fetch failed: ${firstFailure.errorMessage} (${firstFailure.url}, status ${firstFailure.fetchStatus})`
            : 'Crawl failed before any page was fetched.';
        } else if (!isOpenAIConfigured()) {
          errorMessage = 'OPENAI_API_KEY not configured — pages crawled but no KB generated.';
        }

        await prisma.crawlJob.update({
          where: { id: crawlJobId },
          data: {
            status,
            pagesCrawled: crawled,
            pagesFailed: failed,
            finishedAt: new Date(),
            errorMessage,
          },
        });
      } catch (err) {
        await prisma.crawlJob.update({
          where: { id: crawlJobId },
          data: {
            status: 'failed',
            errorMessage: err instanceof Error ? err.message : String(err),
            finishedAt: new Date(),
          },
        });
        throw err;
      }
    },
    {
      connection: getConnection(),
      concurrency: env.CRAWL_CONCURRENCY,
    },
  );
}

// ----- LLM step ------------------------------------------------------------
async function analyzeAndPersist(
  organizationId: string,
  corpus: { url: string; title: string | null; text: string }[],
): Promise<boolean> {
  // Compose a compact corpus string. Trim each page's body to keep total
  // under ~30 KB so we don't blow the model context unnecessarily.
  const PAGE_BUDGET = 4_000;
  const joined = corpus
    .slice(0, 12)
    .map((p) => `## ${p.title ?? p.url}\n[url: ${p.url}]\n\n${p.text.slice(0, PAGE_BUDGET)}`)
    .join('\n\n---\n\n');

  const systemPrompt = `You are a business analyst extracting a knowledge base from a company's website.

You will receive concatenated text from up to 12 pages of one company's website. Produce STRICT JSON with three fields:
- "tone": one of "formal", "casual", "friendly", "clinical", or "professional" (best fit)
- "summary": a one-sentence description of the business
- "entries": an array of up to 25 FAQ-shaped knowledge-base entries:
    - "kind": one of "faq", "product", "service", "policy", "business_info"
    - "question": the question a customer would ask
    - "answer": a concise answer (max 600 characters)
    - "sourceUrl": the URL on the site that supports this entry, when known

Rules:
- ONLY emit JSON. No markdown fences, no explanation.
- Skip entries you can't ground in the source text. Better fewer accurate than many speculative.
- Prefer concrete factual claims (hours, prices, return policy, contact channels) over generic marketing copy.
- Phrase answers in the company's detected tone.`;

  const userPrompt = `# Source pages\n\n${joined.slice(0, 60_000)}`;

  let llm: Awaited<ReturnType<typeof workerComplete>>;
  try {
    llm = await workerComplete({
      systemPrompt,
      userPrompt,
      maxTokens: 4_000,
      temperature: 0.2,
      // JSON mode — Groq returns only a valid JSON object, no preamble,
      // no code fences. Eliminates the entire class of "model wrapped
      // its output in ```json or added 'Here you go:' before it" parse
      // failures that the regex-strip below used to swallow silently.
      jsonMode: true,
    });
  } catch (err) {
    console.error('[crawl] LLM call failed', err instanceof Error ? err.message : err);
    return false;
  }

  type Parsed = {
    tone?: string;
    summary?: string;
    entries?: { kind: string; question: string; answer: string; sourceUrl?: string }[];
  };
  // Robust JSON extraction: prefer the whole text (jsonMode should make
  // it pure JSON), but fall back to a `{ ... }` slice if the model snuck
  // in any wrapping prose anyway.
  function extractJsonBlock(s: string): string {
    const trimmed = s.trim().replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
    if (trimmed.startsWith('{')) return trimmed;
    const first = trimmed.indexOf('{');
    const last = trimmed.lastIndexOf('}');
    if (first >= 0 && last > first) return trimmed.slice(first, last + 1);
    return trimmed;
  }

  let parsed: Parsed | null = null;
  try {
    parsed = JSON.parse(extractJsonBlock(llm.text)) as Parsed;
  } catch (err) {
    parsed = null;
    console.warn(
      '[crawl] could not parse LLM output as JSON',
      err instanceof Error ? err.message : err,
      '— first 400 chars of output:',
      llm.text.slice(0, 400),
    );
  }
  if (!parsed) return false;

  await withRlsBypass(async (tx) => {
    // Upsert detected tone onto the bot config (create the row if missing).
    await tx.botConfig.upsert({
      where: { organizationId },
      create: {
        organizationId,
        detectedTone: parsed?.tone ?? null,
        personality: parsed?.tone ?? null,
        version: 1,
      },
      update: {
        detectedTone: parsed?.tone ?? undefined,
        version: { increment: 1 },
      },
    });

    // Replace any existing AI-generated KB rows. Keeps re-runs idempotent
    // without nuking manual rows the client added.
    await tx.knowledgeBaseEntry.deleteMany({
      where: { organizationId, sourceType: 'ai' },
    });

    const entries = (parsed.entries ?? []).slice(0, 50);
    for (const e of entries) {
      if (!e.question || !e.answer) continue;
      const kind = ['faq', 'product', 'service', 'policy', 'business_info'].includes(e.kind)
        ? e.kind
        : 'faq';
      await tx.knowledgeBaseEntry.create({
        data: {
          organizationId,
          kind,
          question: e.question.slice(0, 500),
          answer: e.answer.slice(0, 2000),
          sourceUrl: e.sourceUrl?.slice(0, 1000) ?? null,
          sourceType: 'ai',
          approved: false,
          searchText: `${e.question} ${e.answer}`.toLowerCase().slice(0, 4000),
        },
      });
    }
  });

  return true;
}

// ----------------------------------------------------------------------------
// Listings → Products extractor
// ----------------------------------------------------------------------------
// Many tenant sites are catalogues at heart — real-estate listing pages,
// restaurant menus, dealership inventories, service directories. The
// crawler captures the listing PAGE (one URL, many cards inside) but
// individual detail pages are usually behind JS onClick handlers with
// no <a href> the BFS can follow.
//
// This extractor takes the rendered prose of each listing-shaped page
// and asks the LLM to return STRUCTURED products. Each product becomes
// a Product row in the tenant's catalog as a DRAFT (isAvailable=false)
// — the operator reviews + publishes via /products.
//
// Idempotency: SKU is a deterministic hash of name+location, so a
// re-crawl picking up the same listings upserts rather than duplicates.
// We only update existing rows that are STILL drafts; operator-edited
// or operator-published rows are left alone so manual fixes survive.

const PRICE_LIKE_RE = /(?:\$|€|£|USD|EUR|GBP|KWD|AED|SAR|BHD|OMR|JOD|LBP|EGP)[\s\d.,/-]{1,30}|[\d.,]{1,12}\s*(?:USD|EUR|GBP|KWD|AED|SAR|BHD|OMR|JOD|LBP|EGP|\$|€|£)/gi;

function looksLikeListingPage(text: string): boolean {
  if (!text) return false;
  // 8+ price-shaped tokens = "this page has a list of things with prices".
  const prices = text.match(PRICE_LIKE_RE);
  return (prices?.length ?? 0) >= 8;
}

function slugifyName(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
}

async function extractAndPersistListings(
  organizationId: string,
  crawlJobId: string,
  corpus: { url: string; title: string | null; text: string }[],
): Promise<number> {
  // Filter to listing-shaped pages only. For most tenants this will be
  // 1-3 pages out of a 10-30 page crawl.
  const listingPages = corpus.filter((p) => looksLikeListingPage(p.text));
  if (listingPages.length === 0) return 0;

  const systemPrompt = `You extract individual product listings from a category / inventory / directory page.
Return STRICT JSON in this shape, nothing else:

{
  "products": [
    {
      "name": "<exact name from the page>",
      "shortDescription": "<one or two sentences summarizing key features, max 200 chars>",
      "priceMajor": <number, the price as a normal decimal e.g. 550000 or 1.250 or null if unclear>,
      "currency": "<ISO 4217 code e.g. USD, KWD, EUR>",
      "location": "<location/region string from the listing, or empty string>",
      "category": "<best one-word category: 'Apartment', 'Villa', 'Land', 'Office', 'Commercial', 'Service', 'Product', etc.>",
      "attributes": {"bedrooms": <int or null>, "bathrooms": <int or null>, "sqm": <int or null>}
    }
  ]
}

Rules:
- Extract every distinct listing you can confidently identify. Cap at 60 per response.
- name + currency are required. Skip cards missing either.
- Use the EXACT name and price text as shown — do not paraphrase or round.
- priceMajor is the human-readable number (not minor units): 550000 for $550,000; 1.250 for 1.250 KWD.
- attributes keys may be empty when the listing doesn't say. Don't invent values.
- Skip duplicates within the same response.`;

  let totalCreated = 0;
  for (const page of listingPages) {
    // Cap each page's text at ~40 KB so the LLM call stays well under
    // any context-window or rate-limit edge case.
    const userPrompt = `# Source URL\n${page.url}\n\n# Page content\n\n${page.text.slice(0, 40_000)}`;

    let llm: Awaited<ReturnType<typeof workerComplete>>;
    try {
      llm = await workerComplete({
        systemPrompt,
        userPrompt,
        maxTokens: 4_000,
        temperature: 0.2,
        jsonMode: true,
      });
    } catch (err) {
      console.error('[crawl] listings LLM call failed for', page.url, err instanceof Error ? err.message : err);
      continue;
    }

    type ExtractedProduct = {
      name?: string;
      shortDescription?: string;
      priceMajor?: number | string | null;
      currency?: string;
      location?: string;
      category?: string;
      attributes?: Record<string, unknown>;
    };
    type ExtractedShape = { products?: ExtractedProduct[] };

    function extractJsonBlock(s: string): string {
      const trimmed = s.trim().replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
      if (trimmed.startsWith('{')) return trimmed;
      const f = trimmed.indexOf('{');
      const l = trimmed.lastIndexOf('}');
      return f >= 0 && l > f ? trimmed.slice(f, l + 1) : trimmed;
    }
    let extracted: ExtractedShape | null = null;
    try {
      extracted = JSON.parse(extractJsonBlock(llm.text)) as ExtractedShape;
    } catch (err) {
      console.warn(
        '[crawl] listings JSON parse failed for', page.url,
        err instanceof Error ? err.message : err,
        '— first 400 chars:', llm.text.slice(0, 400),
      );
      continue;
    }
    const products = (extracted?.products ?? []).slice(0, 60);
    if (products.length === 0) continue;

    const { createHash } = await import('node:crypto');
    await withRlsBypass(async (tx) => {
      // Look up the org's default currency once for fallback / price
      // conversion (KWD/BHD/OMR/JOD use 1000, others use 100).
      const biz = await tx.businessInfo.findFirst({
        where: { organizationId },
        select: { currency: true },
      });
      const orgCurrency = (biz?.currency ?? 'USD').toUpperCase();

      for (const p of products) {
        if (!p.name || p.name.trim().length === 0) continue;
        const name = p.name.trim().slice(0, 200);
        const currency = (p.currency ?? orgCurrency).toUpperCase().slice(0, 3);
        // Convert priceMajor to minor units. Handle string + number inputs.
        let priceMinor: number | null = null;
        if (p.priceMajor != null && p.priceMajor !== '') {
          const major = typeof p.priceMajor === 'string'
            ? Number(p.priceMajor.replace(/[^0-9.]/g, ''))
            : Number(p.priceMajor);
          if (Number.isFinite(major) && major > 0) {
            const multiplier = ['KWD', 'BHD', 'OMR', 'JOD'].includes(currency) ? 1000 : 100;
            priceMinor = Math.round(major * multiplier);
          }
        }

        // Deterministic SKU per (name, location) — same listing across
        // re-crawls produces the same SKU so upsert is idempotent.
        const skuBase = createHash('sha256')
          .update(`${name}|${p.location ?? ''}`.toLowerCase())
          .digest('hex')
          .slice(0, 10)
          .toUpperCase();
        const sku = `CRAWL-${skuBase}`;
        const slug = `crawl-${skuBase.toLowerCase()}-${slugifyName(name).slice(0, 40)}` || `crawl-${skuBase.toLowerCase()}`;

        const attributes: Record<string, unknown> = {
          ...(p.attributes ?? {}),
          source: 'crawl',
          crawlJobId,
          sourceUrl: page.url,
        };
        if (p.location) attributes.location = String(p.location).slice(0, 200);
        if (p.category) attributes.category = String(p.category).slice(0, 60);

        // Only touch existing rows that are STILL drafts. If the operator
        // has published or edited a row, the re-crawl leaves it alone so
        // manual fixes survive.
        const existing = await tx.product.findUnique({
          where: { organizationId_sku: { organizationId, sku } },
          select: { id: true, isAvailable: true, attributes: true },
        });
        const stillDraft =
          existing && !existing.isAvailable &&
          (existing.attributes as Record<string, unknown> | null)?.source === 'crawl';

        if (existing && !stillDraft) {
          // Operator-managed row — skip silently.
          continue;
        }

        if (existing && stillDraft) {
          await tx.product.update({
            where: { id: existing.id },
            data: {
              name,
              shortDescription: p.shortDescription?.slice(0, 200) ?? null,
              priceMinor,
              currency,
              attributes: attributes as never,
            },
          });
          totalCreated += 1; // count as touched
        } else {
          try {
            await tx.product.create({
              data: {
                organizationId,
                sku,
                name,
                slug,
                shortDescription: p.shortDescription?.slice(0, 200) ?? null,
                priceMinor,
                currency,
                isAvailable: false, // DRAFT — operator must publish via /products
                attributes: attributes as never,
              },
            });
            totalCreated += 1;
          } catch (err) {
            // Slug collision is the most likely cause — another draft
            // with a near-identical name. Skip and move on.
            console.warn('[crawl] product create failed for', name, err instanceof Error ? err.message : err);
          }
        }
      }
    });
  }

  return totalCreated;
}
