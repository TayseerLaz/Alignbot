// Phase 2 §4.1.1 — website crawler + LLM analysis worker.
//
// Strategy (MVP, fetch-based, not Playwright):
//   1. BFS-walk pages within the same origin starting at root_url.
//   2. Up to maxPages, up to maxDepth links deep.
//   3. For each page: GET (5s timeout), parse with Cheerio, strip
//      script/style/nav/footer/header, extract title + body text.
//   4. Persist to crawl_pages.
//   5. Once crawl is done, fan out a single LLM analyze call that turns the
//      cleaned corpus into KnowledgeBaseEntry rows + detected_tone, which
//      we write to BotConfig.
//
// SSRF: we route every fetch through assertSafeOutboundUrl so a tenant
// can't aim the crawler at internal services.
//
// SPA limitation (documented): pages that render content via JS won't be
// covered. Add Playwright in a follow-up if pilots need it.
import { assertSafeOutboundUrl, UrlGuardError } from '@aligned/shared';
import { Worker } from 'bullmq';
import * as cheerio from 'cheerio';
import { request as undiciRequest } from 'undici';

import { isAnthropicConfigured, workerComplete } from '../lib/anthropic.js';
import { env } from '../lib/env.js';
import { getConnection } from '../lib/redis.js';

import { prisma, withRlsBypass } from './db.js';

interface CrawlPayload {
  organizationId: string;
  crawlJobId: string;
}

const MAX_BODY_BYTES = 100_000; // 100 KB per page
const FETCH_TIMEOUT_MS = 5_000;

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
  try {
    const res = await undiciRequest(url, {
      method: 'GET',
      headers: {
        'user-agent': 'AlignedBot/1.0 (+https://alignbot.aligned-tech.com/bot)',
        accept: 'text/html,application/xhtml+xml',
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    const ctype = (res.headers['content-type'] as string | undefined) ?? null;
    if (!ctype || !ctype.includes('text/html')) {
      return { status: res.statusCode, contentType: ctype, html: null };
    }
    const html = await res.body.text();
    return { status: res.statusCode, contentType: ctype, html };
  } catch (err) {
    return { status: 0, contentType: null, html: null, error: err instanceof Error ? err.message : String(err) };
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
        if (isAnthropicConfigured() && cleanCorpus.length > 0) {
          analysisOK = await analyzeAndPersist(organizationId, cleanCorpus).catch((err) => {
            console.error('[crawl] analysis failed', err);
            return false;
          });
        }

        await prisma.crawlJob.update({
          where: { id: crawlJobId },
          data: {
            status: failed > 0 && crawled === 0 ? 'failed' : analysisOK ? 'succeeded' : 'partial',
            pagesCrawled: crawled,
            pagesFailed: failed,
            finishedAt: new Date(),
            errorMessage: !isAnthropicConfigured()
              ? 'ANTHROPIC_API_KEY not configured — pages crawled but no KB generated.'
              : null,
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
