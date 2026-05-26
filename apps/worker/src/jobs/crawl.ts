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
const PAGE_TIMEOUT_MS = 30_000; // SPAs need time for JS + network idle
const NETWORK_IDLE_MS = 1_500;   // shortened — many SPAs poll continuously

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

    const response = await page.goto(url, {
      waitUntil: 'networkidle',
      timeout: PAGE_TIMEOUT_MS,
    });

    // Some SPAs (alinia is one) keep a long-poll / websocket open, so
    // 'networkidle' never fires within the timeout. Fall back to
    // 'domcontentloaded' + a fixed wait — typically catches the
    // post-mount render that we actually care about.
    if (!response) {
      await page.waitForLoadState('domcontentloaded', { timeout: PAGE_TIMEOUT_MS });
      await page.waitForTimeout(NETWORK_IDLE_MS);
    }

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
        const cleanCorpus: { url: string; title: string | null; text: string }[] = [];

        while (queue.length > 0 && crawled + failed < meta.maxPages) {
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
          const text = cleanText($);
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
          // Enqueue children if we still have budget + depth.
          if (next.depth < meta.maxDepth) {
            for (const link of extractLinks($, next.url)) {
              const key = link.toString().split('#')[0]!;
              if (!seen.has(key)) {
                seen.add(key);
                queue.push({ url: new URL(key), depth: next.depth + 1 });
              }
            }
          }
        }

        // Run LLM analysis if configured. Otherwise mark partial.
        let analysisOK = false;
        if (isOpenAIConfigured() && cleanCorpus.length > 0) {
          analysisOK = await analyzeAndPersist(organizationId, cleanCorpus).catch((err) => {
            console.error('[crawl] analysis failed', err);
            return false;
          });
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
    });
  } catch (err) {
    console.error('[crawl] LLM call failed', err);
    return false;
  }

  // Try to parse JSON — strip any leading/trailing crap the model might
  // produce despite the instruction.
  const trimmed = llm.text.trim().replace(/^```json/i, '').replace(/```$/i, '').trim();
  type Parsed = {
    tone?: string;
    summary?: string;
    entries?: { kind: string; question: string; answer: string; sourceUrl?: string }[];
  };
  let parsed: Parsed | null = null;
  try {
    parsed = JSON.parse(trimmed) as Parsed;
  } catch {
    parsed = null;
  }
  if (!parsed) {
    console.warn('[crawl] could not parse LLM output as JSON');
    return false;
  }

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
