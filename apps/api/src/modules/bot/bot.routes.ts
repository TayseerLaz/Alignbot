// Phase 2 — AI bot builder routes.
//
// Surfaces:
//   - POST /bot/analyze         start website crawl + LLM analysis (queues a CrawlJob)
//   - GET  /bot/analyze/:id     status of a crawl job + page count
//   - GET  /bot/knowledge-base  list KB entries (manual + AI, all kinds)
//   - PATCH/DELETE/POST on /bot/knowledge-base/:id/...
//   - GET  /bot/config          current BotConfig (creates a stub on first call)
//   - PUT  /bot/config          update personality / greeting / flow / templates
//   - GET  /bot/questionnaire   AI-generated 5–10 questions to fill the gaps
//   - POST /bot/simulate        live preview turn — uses bot-engine
//   - POST /bot/scenarios/run   runs the 5 canonical test scenarios + LLM-as-judge
//   - GET  /bot/scenarios/last  last results
//   - POST /bot/deploy          flips deployedAt on BotConfig
//   - POST /bot/undeploy        clears deployedAt (rollback)
import {
  ApiErrorCode,
  itemEnvelopeSchema,
  listEnvelopeSchema,
  successSchema,
  uuidSchema,
} from '@aligned/shared';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { complete, isOpenAIConfigured } from '../../lib/openai.js';
import { recordAudit } from '../../lib/audit.js';
import { buildBotResponse, gatherBotData } from '../../lib/bot-engine.js';
import { withTenant } from '../../lib/db.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { getCrawlQueue } from '../../lib/queues.js';

// ----- DTO schemas (registered for Swagger; keep flat) -----

const botConfigDto = z.object({
  id: uuidSchema,
  personality: z.string().nullable(),
  customPersonality: z.string().nullable(),
  detectedTone: z.string().nullable(),
  greeting: z.string().nullable(),
  languages: z.string(),
  escalationRules: z.record(z.string(), z.unknown()).nullable(),
  conversationFlow: z.record(z.string(), z.unknown()).nullable(),
  responseTemplates: z.record(z.string(), z.unknown()).nullable(),
  deployedAt: z.string().datetime().nullable(),
  // Phase 6 — voice replies. ttsProvider picks Google or ElevenLabs;
  // ttsVoiceName carries the provider-appropriate identifier (voice
  // NAME for Google, voice ID for ElevenLabs).
  replyMode: z.enum(['text', 'voice', 'match_customer']),
  ttsProvider: z.enum(['google', 'elevenlabs']),
  ttsVoiceName: z.string().nullable(),
  version: z.number().int(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

const crawlJobDto = z.object({
  id: uuidSchema,
  rootUrl: z.string(),
  status: z.string(),
  pagesCrawled: z.number().int(),
  pagesFailed: z.number().int(),
  errorMessage: z.string().nullable(),
  startedAt: z.string().datetime().nullable(),
  finishedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
});

const kbEntryDto = z.object({
  id: uuidSchema,
  kind: z.string(),
  question: z.string(),
  answer: z.string(),
  sourceUrl: z.string().nullable(),
  sourceType: z.string(),
  approved: z.boolean(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

// Fallback scenarios — used only when LLM generation fails AND the org has
// no manual scenarios saved. Kept tiny + generic so an admin sees SOMETHING
// when they click "Run all" on a fresh org.
const FALLBACK_SCENARIOS: { key: string; prompt: string; expectation: string }[] = [
  {
    key: 'unknown_question',
    prompt: 'Do you ship to Antarctica?',
    expectation:
      'Bot says it does not have that information and offers to escalate to a human. No fabrication.',
  },
];

// Generate fresh test scenarios from the org's CURRENT knowledge base + catalog.
// Returns 5–8 scenarios as `{ key, prompt, expectation }`. Each scenario tests
// a specific KB topic the operator should care about — menu lookups, hours,
// allergens, delivery, refunds, etc.
async function generateScenariosFromKb(
  orgId: string,
  data: Awaited<ReturnType<typeof gatherBotData>>,
): Promise<{ key: string; prompt: string; expectation: string }[]> {
  // Compress the KB / catalog / business info into a tight prompt context.
  const kbSnippets = data.kb.slice(0, 30).map((k) => `Q: ${k.question}\nA: ${k.answer}`).join('\n\n');
  const productSnippets = data.products
    .slice(0, 20)
    .map((p) => `- ${p.name}${p.shortDescription ? ` (${p.shortDescription})` : ''}`)
    .join('\n');
  const serviceSnippets = data.services
    .slice(0, 10)
    .map((s) => `- ${s.name}${s.shortDescription ? ` (${s.shortDescription})` : ''}`)
    .join('\n');
  const bizContext = data.biz
    ? `Business: ${data.biz.legalName ?? ''}\nTagline: ${data.biz.tagline ?? ''}\nAbout: ${(data.biz.about ?? '').slice(0, 400)}`
    : '';

  const sys =
    'You are a QA test designer for customer-support chatbots. Generate REALISTIC test scenarios a customer of THIS specific business might ask. Cover a spread: product/service lookups, hours, delivery, allergens or policies, edge cases the bot might get wrong, and at least one out-of-scope question. Return STRICT JSON only (no prose, no markdown): {"scenarios": [{"key": "<slug>", "prompt": "<customer message>", "expectation": "<one-sentence pass criterion for an LLM judge>"}]}. 6–8 scenarios, keys are short snake_case slugs, prompts are colloquial first-person customer messages.';
  const user = `${bizContext}\n\nKnowledge base:\n${kbSnippets || '(empty)'}\n\nProducts:\n${productSnippets || '(none)'}\n\nServices:\n${serviceSnippets || '(none)'}`;

  try {
    const out = await complete({
      organizationId: orgId,
      systemPrompt: sys,
      messages: [{ role: 'user', content: user }],
      maxTokens: 1400,
      temperature: 0.4,
    });
    const trimmed = out.text.trim().replace(/^```json/i, '').replace(/```$/i, '').trim();
    const parsed = JSON.parse(trimmed) as {
      scenarios?: { key?: unknown; prompt?: unknown; expectation?: unknown }[];
    };
    if (!Array.isArray(parsed.scenarios)) return FALLBACK_SCENARIOS;
    const seen = new Set<string>();
    const cleaned: { key: string; prompt: string; expectation: string }[] = [];
    for (const s of parsed.scenarios) {
      const key = typeof s.key === 'string'
        ? s.key.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60)
        : '';
      const prompt = typeof s.prompt === 'string' ? s.prompt.trim() : '';
      const expectation = typeof s.expectation === 'string' ? s.expectation.trim() : '';
      if (!key || !prompt || !expectation || seen.has(key)) continue;
      seen.add(key);
      cleaned.push({ key, prompt, expectation });
      if (cleaned.length >= 10) break;
    }
    return cleaned.length > 0 ? cleaned : FALLBACK_SCENARIOS;
  } catch {
    return FALLBACK_SCENARIOS;
  }
}

// Generate 3–5 conversation-flow CANDIDATES tailored to the business.
// Each candidate is a complete `{ nodes: [{ intent, label, response }] }`
// shape the bot-engine already consumes. The LLM picks ONE as
// `isRecommended = true` and justifies why with `recommendReason`.
async function generateFlowCandidates(
  orgId: string,
  data: Awaited<ReturnType<typeof gatherBotData>>,
): Promise<
  {
    name: string;
    description: string;
    flow: { nodes: { intent: string; label: string; response: string }[] };
    isRecommended: boolean;
    recommendReason: string | null;
  }[]
> {
  const kbSnippets = data.kb.slice(0, 25).map((k) => `Q: ${k.question}\nA: ${k.answer}`).join('\n\n');
  const productNames = data.products.slice(0, 25).map((p) => p.name).join(', ');
  const serviceNames = data.services.slice(0, 15).map((s) => s.name).join(', ');
  const bizContext = data.biz
    ? `Business: ${data.biz.legalName ?? ''}\nTagline: ${data.biz.tagline ?? ''}\nAbout: ${(data.biz.about ?? '').slice(0, 400)}`
    : '';
  const policiesContext = data.policies
    .slice(0, 8)
    .map((p) => `- ${p.title} (${p.kind})`)
    .join('\n');

  const sys =
    'You are a senior conversation designer. Look at the business and produce 3–5 DIFFERENT conversation-flow CANDIDATES the operator can pick from. Each candidate represents a strategically different way of talking to customers (e.g. "Quick Order First", "Hospitality Concierge", "Support-First", "Concierge Sales", "Self-Serve Menu"). For EACH candidate, also produce 6–10 intent nodes — each intent has a slug like "menu_lookup", a human label, and a SHORT response template (1–3 sentences, in English, that the LLM-driven bot would adapt at runtime). Mark exactly ONE candidate as "isRecommended" with a one-sentence "recommendReason" explaining why it fits this business best. Return STRICT JSON only: {"candidates": [{"name": "...", "description": "...", "isRecommended": true|false, "recommendReason": "..." | null, "nodes": [{"intent": "...", "label": "...", "response": "..."}]}]}. No prose, no markdown.';
  const user = `${bizContext}\n\nProducts: ${productNames || '(none)'}\nServices: ${serviceNames || '(none)'}\n\nKnowledge base highlights:\n${kbSnippets || '(empty)'}\n\nPolicies:\n${policiesContext || '(none)'}`;

  try {
    const out = await complete({
      organizationId: orgId,
      systemPrompt: sys,
      messages: [{ role: 'user', content: user }],
      maxTokens: 4000,
      temperature: 0.6,
    });
    const trimmed = out.text.trim().replace(/^```json/i, '').replace(/```$/i, '').trim();
    const parsed = JSON.parse(trimmed) as {
      candidates?: {
        name?: unknown;
        description?: unknown;
        isRecommended?: unknown;
        recommendReason?: unknown;
        nodes?: { intent?: unknown; label?: unknown; response?: unknown }[];
      }[];
    };
    if (!Array.isArray(parsed.candidates)) return [];
    const cleaned = parsed.candidates
      .map((c) => {
        const name = typeof c.name === 'string' ? c.name.trim().slice(0, 80) : '';
        const description = typeof c.description === 'string' ? c.description.trim().slice(0, 400) : '';
        const recommendReason =
          typeof c.recommendReason === 'string' ? c.recommendReason.trim().slice(0, 300) : null;
        const isRecommended = c.isRecommended === true;
        const nodes = (Array.isArray(c.nodes) ? c.nodes : [])
          .map((n) => ({
            intent:
              typeof n.intent === 'string'
                ? n.intent.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40)
                : '',
            label: typeof n.label === 'string' ? n.label.trim().slice(0, 80) : '',
            response: typeof n.response === 'string' ? n.response.trim().slice(0, 600) : '',
          }))
          .filter((n) => n.intent && n.label && n.response);
        return { name, description, recommendReason, isRecommended, flow: { nodes } };
      })
      .filter((c) => c.name && c.description && c.flow.nodes.length > 0)
      .slice(0, 5);

    // Ensure exactly one candidate is recommended. If LLM didn't mark any,
    // pick the first; if it marked several, keep only the first one's flag.
    let recommendedSeen = false;
    for (const c of cleaned) {
      if (c.isRecommended && !recommendedSeen) {
        recommendedSeen = true;
      } else if (c.isRecommended) {
        c.isRecommended = false;
      }
    }
    if (!recommendedSeen && cleaned.length > 0) cleaned[0]!.isRecommended = true;
    return cleaned;
  } catch {
    return [];
  }
}

function serializeConfig(c: {
  id: string;
  personality: string | null;
  customPersonality: string | null;
  detectedTone: string | null;
  greeting: string | null;
  languages: string;
  escalationRules: unknown;
  conversationFlow: unknown;
  responseTemplates: unknown;
  deployedAt: Date | null;
  replyMode?: string;
  ttsProvider?: string | null;
  ttsVoiceName?: string | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}) {
  // Coerce replyMode to the enum the DTO promises — defaults to 'text'
  // if anything else slipped in (no-op on fresh rows).
  const mode = (c.replyMode ?? 'text') as 'text' | 'voice' | 'match_customer';
  return {
    id: c.id,
    personality: c.personality,
    customPersonality: c.customPersonality,
    detectedTone: c.detectedTone,
    greeting: c.greeting,
    languages: c.languages,
    escalationRules: (c.escalationRules ?? null) as Record<string, unknown> | null,
    conversationFlow: (c.conversationFlow ?? null) as Record<string, unknown> | null,
    responseTemplates: (c.responseTemplates ?? null) as Record<string, unknown> | null,
    deployedAt: c.deployedAt?.toISOString() ?? null,
    replyMode: ['text', 'voice', 'match_customer'].includes(mode) ? mode : 'text',
    ttsProvider: ((c.ttsProvider ?? 'google') === 'elevenlabs' ? 'elevenlabs' : 'google') as
      | 'google'
      | 'elevenlabs',
    ttsVoiceName: c.ttsVoiceName ?? null,
    version: c.version,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  };
}

export default async function botRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  // ---------- GET /bot/config ----------
  r.get(
    '/bot/config',
    {
      schema: { tags: ['bot'], summary: 'Get the org bot config (auto-creates a stub).', response: { 200: itemEnvelopeSchema(botConfigDto) } },
      preHandler: [app.requireRole('viewer')],
    },
    async (req) => {
      const orgId = req.auth!.organizationId;
      return app.tenant(req, async (tx) => {
        let row = await tx.botConfig.findUnique({ where: { organizationId: orgId } });
        if (!row) row = await tx.botConfig.create({ data: { organizationId: orgId } });
        return { data: serializeConfig(row) };
      });
    },
  );

  // ---------- PUT /bot/config ----------
  r.put(
    '/bot/config',
    {
      schema: {
        tags: ['bot'],
        summary: 'Update the bot config. Bumps version on every save.',
        body: z.object({
          personality: z.string().trim().max(40).nullable().optional(),
          customPersonality: z.string().trim().max(2000).nullable().optional(),
          greeting: z.string().trim().max(2000).nullable().optional(),
          languages: z.string().trim().max(120).optional(),
          escalationRules: z.record(z.string(), z.unknown()).nullable().optional(),
          conversationFlow: z.record(z.string(), z.unknown()).nullable().optional(),
          responseTemplates: z.record(z.string(), z.unknown()).nullable().optional(),
          // Phase 6 — voice replies.
          replyMode: z.enum(['text', 'voice', 'match_customer']).optional(),
          ttsProvider: z.enum(['google', 'elevenlabs']).optional(),
          ttsVoiceName: z.string().trim().max(100).nullable().optional(),
        }),
        response: { 200: itemEnvelopeSchema(botConfigDto) },
      },
      preHandler: [app.requireRole('admin')],
    },
    async (req) => {
      const orgId = req.auth!.organizationId;
      return app.tenant(req, async (tx) => {
        const existing =
          (await tx.botConfig.findUnique({ where: { organizationId: orgId } })) ??
          (await tx.botConfig.create({ data: { organizationId: orgId } }));
        const updated = await tx.botConfig.update({
          where: { id: existing.id },
          data: {
            personality: req.body.personality ?? undefined,
            customPersonality:
              req.body.customPersonality === undefined ? undefined : req.body.customPersonality,
            greeting: req.body.greeting === undefined ? undefined : req.body.greeting,
            languages: req.body.languages ?? undefined,
            escalationRules: (req.body.escalationRules ?? undefined) as never,
            conversationFlow: (req.body.conversationFlow ?? undefined) as never,
            responseTemplates: (req.body.responseTemplates ?? undefined) as never,
            replyMode: req.body.replyMode ?? undefined,
            ttsProvider: req.body.ttsProvider ?? undefined,
            ttsVoiceName:
              req.body.ttsVoiceName === undefined ? undefined : req.body.ttsVoiceName,
            version: { increment: 1 },
          },
        });
        await recordAudit({
          action: 'business_info_updated',
          organizationId: orgId,
          actorUserId: req.auth!.userId,
          entityType: 'bot_config',
          entityId: updated.id,
          metadata: { event: 'bot_config_updated', version: updated.version },
        });
        return { data: serializeConfig(updated) };
      });
    },
  );

  // ---------- POST /bot/analyze ----------
  r.post(
    '/bot/analyze',
    {
      schema: {
        tags: ['bot'],
        summary: 'Start a website crawl + LLM analysis.',
        body: z.object({
          rootUrl: z.string().url(),
          // Deliberately generous caps so the crawler can cover an
          // entire mid-sized marketing site (root + nested sub-pages)
          // rather than just the home. 500 pages × 5 s timeout each
          // ≈ 40 min wall-clock worst case, which is acceptable for a
          // one-off setup task.
          maxPages: z.number().int().min(1).max(500).default(200),
          maxDepth: z.number().int().min(0).max(8).default(6),
        }),
        response: { 201: itemEnvelopeSchema(crawlJobDto) },
      },
      preHandler: [app.requireRole('admin')],
    },
    async (req, reply) => {
      const orgId = req.auth!.organizationId;
      const job = await app.tenant(req, (tx) =>
        tx.crawlJob.create({
          data: {
            organizationId: orgId,
            rootUrl: req.body.rootUrl,
            maxPages: req.body.maxPages,
            maxDepth: req.body.maxDepth,
            status: 'pending',
          },
        }),
      );
      await getCrawlQueue().add(
        'crawl',
        { organizationId: orgId, crawlJobId: job.id },
        { jobId: job.id, attempts: 1, removeOnComplete: { age: 7 * 24 * 60 * 60, count: 100 } },
      );
      reply.code(201);
      return {
        data: {
          id: job.id,
          rootUrl: job.rootUrl,
          status: job.status,
          pagesCrawled: 0,
          pagesFailed: 0,
          errorMessage: null,
          startedAt: null,
          finishedAt: null,
          createdAt: job.createdAt.toISOString(),
        },
      };
    },
  );

  // ---------- GET /bot/analyze/:id ----------
  r.get(
    '/bot/analyze/:id',
    {
      schema: {
        tags: ['bot'],
        summary: 'Crawl job status.',
        params: z.object({ id: uuidSchema }),
        response: { 200: itemEnvelopeSchema(crawlJobDto) },
      },
      preHandler: [app.requireRole('viewer')],
    },
    async (req) =>
      app.tenant(req, async (tx) => {
        const job = await tx.crawlJob.findUnique({ where: { id: req.params.id } });
        if (!job) throw notFound('Crawl job not found.');
        return {
          data: {
            id: job.id,
            rootUrl: job.rootUrl,
            status: job.status,
            pagesCrawled: job.pagesCrawled,
            pagesFailed: job.pagesFailed,
            errorMessage: job.errorMessage,
            startedAt: job.startedAt?.toISOString() ?? null,
            finishedAt: job.finishedAt?.toISOString() ?? null,
            createdAt: job.createdAt.toISOString(),
          },
        };
      }),
  );

  // ---------- GET /bot/knowledge-base ----------
  r.get(
    '/bot/knowledge-base',
    {
      schema: {
        tags: ['bot'],
        summary: 'List KB entries (any source).',
        querystring: z.object({
          q: z.string().trim().optional(),
          kind: z.string().optional(),
          approved: z.enum(['true', 'false']).optional(),
        }),
        response: { 200: listEnvelopeSchema(kbEntryDto) },
      },
      preHandler: [app.requireRole('viewer')],
    },
    async (req) =>
      app.tenant(req, async (tx) => {
        const q = req.query;
        const rows = await tx.knowledgeBaseEntry.findMany({
          where: {
            ...(q.kind ? { kind: q.kind } : {}),
            ...(q.approved ? { approved: q.approved === 'true' } : {}),
            ...(q.q
              ? { searchText: { contains: q.q.toLowerCase() } }
              : {}),
          },
          orderBy: [{ approved: 'asc' }, { updatedAt: 'desc' }],
          take: 200,
        });
        return {
          data: rows.map((e) => ({
            id: e.id,
            kind: e.kind,
            question: e.question,
            answer: e.answer,
            sourceUrl: e.sourceUrl,
            sourceType: e.sourceType,
            approved: e.approved,
            createdAt: e.createdAt.toISOString(),
            updatedAt: e.updatedAt.toISOString(),
          })),
          nextCursor: null,
        };
      }),
  );

  // ---------- POST /bot/knowledge-base ----------
  r.post(
    '/bot/knowledge-base',
    {
      schema: {
        tags: ['bot'],
        summary: 'Add a manual KB entry.',
        body: z.object({
          kind: z.enum(['faq', 'product', 'service', 'policy', 'business_info', 'custom']),
          question: z.string().trim().min(1).max(500),
          answer: z.string().trim().min(1).max(2000),
        }),
        response: { 201: itemEnvelopeSchema(kbEntryDto) },
      },
      preHandler: [app.requireRole('editor')],
    },
    async (req, reply) =>
      app.tenant(req, async (tx) => {
        const e = await tx.knowledgeBaseEntry.create({
          data: {
            organizationId: req.auth!.organizationId,
            kind: req.body.kind,
            question: req.body.question,
            answer: req.body.answer,
            sourceType: 'manual',
            approved: true,
            searchText: `${req.body.question} ${req.body.answer}`.toLowerCase(),
          },
        });
        reply.code(201);
        return {
          data: {
            id: e.id,
            kind: e.kind,
            question: e.question,
            answer: e.answer,
            sourceUrl: e.sourceUrl,
            sourceType: e.sourceType,
            approved: e.approved,
            createdAt: e.createdAt.toISOString(),
            updatedAt: e.updatedAt.toISOString(),
          },
        };
      }),
  );

  // ---------- PATCH /bot/knowledge-base/:id ----------
  r.patch(
    '/bot/knowledge-base/:id',
    {
      schema: {
        tags: ['bot'],
        summary: 'Edit / approve a KB entry.',
        params: z.object({ id: uuidSchema }),
        body: z.object({
          question: z.string().trim().min(1).max(500).optional(),
          answer: z.string().trim().min(1).max(2000).optional(),
          kind: z.enum(['faq', 'product', 'service', 'policy', 'business_info', 'custom']).optional(),
          approved: z.boolean().optional(),
        }),
        response: { 200: successSchema },
      },
      preHandler: [app.requireRole('editor')],
    },
    async (req) =>
      app.tenant(req, async (tx) => {
        const existing = await tx.knowledgeBaseEntry.findUnique({ where: { id: req.params.id } });
        if (!existing) throw notFound('Entry not found.');
        const q = req.body.question ?? existing.question;
        const a = req.body.answer ?? existing.answer;
        await tx.knowledgeBaseEntry.update({
          where: { id: existing.id },
          data: {
            question: req.body.question,
            answer: req.body.answer,
            kind: req.body.kind,
            approved: req.body.approved,
            searchText: `${q} ${a}`.toLowerCase().slice(0, 4000),
          },
        });
        return { ok: true as const };
      }),
  );

  // ---------- DELETE /bot/knowledge-base/:id ----------
  r.delete(
    '/bot/knowledge-base/:id',
    {
      schema: {
        tags: ['bot'],
        summary: 'Delete a KB entry.',
        params: z.object({ id: uuidSchema }),
        response: { 200: successSchema },
      },
      preHandler: [app.requireRole('editor')],
    },
    async (req) =>
      app.tenant(req, async (tx) => {
        await tx.knowledgeBaseEntry.deleteMany({ where: { id: req.params.id } });
        return { ok: true as const };
      }),
  );

  // ---------- DELETE /bot/knowledge-base ----------
  // Bulk wipe every KB entry for the org. Useful when a previous crawl /
  // import left stale facts that the bot keeps citing (e.g. "yoga mats"
  // on a juice-bar account). Admin-only — destructive + non-reversible.
  r.delete(
    '/bot/knowledge-base',
    {
      schema: {
        tags: ['bot'],
        summary: 'Delete every KB entry for this org (irreversible).',
        response: { 200: itemEnvelopeSchema(z.object({ deleted: z.number() })) },
      },
      preHandler: [app.requireRole('admin')],
    },
    async (req) => {
      const orgId = req.auth!.organizationId;
      const result = await app.tenant(req, async (tx) => {
        const r = await tx.knowledgeBaseEntry.deleteMany({});
        return r.count;
      });
      await recordAudit({
        action: 'business_info_updated',
        organizationId: orgId,
        actorUserId: req.auth!.userId,
        entityType: 'knowledge_base_entry',
        metadata: { event: 'kb_wiped_all', count: result },
      });
      return { data: { deleted: result } };
    },
  );

  // ---------- POST /bot/knowledge-base/approve-all ----------
  r.post(
    '/bot/knowledge-base/approve-all',
    {
      schema: {
        tags: ['bot'],
        summary: 'One-click approve every AI-generated KB entry that is still in review.',
        response: { 200: itemEnvelopeSchema(z.object({ approved: z.number() })) },
      },
      preHandler: [app.requireRole('admin')],
    },
    async (req) =>
      app.tenant(req, async (tx) => {
        const result = await tx.knowledgeBaseEntry.updateMany({
          where: { sourceType: 'ai', approved: false },
          data: { approved: true },
        });
        return { data: { approved: result.count } };
      }),
  );

  // ---------- GET /bot/questionnaire ----------
  // Returns 5–10 questions targeted at gaps in the current config + KB.
  // For now this is rule-based (cheap, deterministic). LLM-driven adaptive
  // questions are a polish item.
  r.get(
    '/bot/questionnaire',
    {
      schema: {
        tags: ['bot'],
        summary: 'Adaptive 5–10 question fill-the-gap questionnaire.',
      },
      preHandler: [app.requireRole('viewer')],
    },
    async (req) =>
      app.tenant(req, async (tx) => {
        const [config, biz, faqsCount, policiesCount] = await Promise.all([
          tx.botConfig.findUnique({ where: { organizationId: req.auth!.organizationId } }),
          tx.businessInfo.findFirst({ where: { organizationId: req.auth!.organizationId } }),
          tx.fAQ.count({ where: { isPublished: true, visibility: 'public' } }),
          tx.policy.count({ where: { isPublished: true } }),
        ]);
        const questions: { key: string; question: string; suggested?: string }[] = [];
        if (!config?.greeting)
          questions.push({
            key: 'greeting',
            question: 'How would you like the bot to say hello?',
            suggested: `Hi! Welcome to ${biz?.legalName ?? 'us'}. How can I help today?`,
          });
        if (!config?.personality && !config?.detectedTone)
          questions.push({
            key: 'personality',
            question: 'Which personality fits your brand best?',
            suggested: 'friendly',
          });
        if (!config?.escalationRules)
          questions.push({
            key: 'escalation_fallback',
            question: 'What should the bot say when it needs to hand off to a human?',
            suggested: "I'll connect you with a teammate — they'll be with you shortly.",
          });
        if (!biz?.operatingHours)
          questions.push({
            key: 'operating_hours',
            question: 'What are your opening hours? (Add them under Business Info.)',
          });
        if (faqsCount < 3)
          questions.push({
            key: 'add_faqs',
            question: 'Add at least 3 FAQs your customers ask weekly. (Business Info → FAQs.)',
          });
        if (policiesCount === 0)
          questions.push({
            key: 'add_policies',
            question: 'Add a returns + privacy policy so the bot can quote them.',
          });
        if (!config?.languages || config?.languages === 'en')
          questions.push({
            key: 'languages',
            question: 'Which languages should the bot reply in?',
            suggested: 'en',
          });
        return { data: questions };
      }),
  );

  // ---------- POST /bot/simulate ----------
  r.post(
    '/bot/simulate',
    {
      schema: {
        tags: ['bot'],
        summary: 'Live preview turn — runs the bot engine for one user message.',
        body: z.object({
          sessionId: z.string().min(1).max(120),
          message: z.string().trim().min(1).max(4000),
        }),
        response: {
          200: itemEnvelopeSchema(z.object({ reply: z.string(), usedKbCount: z.number().int() })),
        },
      },
      preHandler: [app.requireRole('viewer')],
    },
    async (req) => {
      if (!isOpenAIConfigured()) {
        throw badRequest(
          ApiErrorCode.SERVICE_UNAVAILABLE,
          'AI bot is unavailable: OPENAI_API_KEY is not configured on this deployment.',
        );
      }
      const orgId = req.auth!.organizationId;
      // tx1: gather all data (history + KB + catalog) and persist the user
      // turn. Read-heavy, no network — closes well under the 5s tx timeout.
      const { data, history } = await app.tenant(req, async (tx) => {
        const [data, history] = await Promise.all([
          gatherBotData(tx, orgId),
          tx.botSimulationTurn.findMany({
            where: { organizationId: orgId, sessionId: req.body.sessionId },
            orderBy: { createdAt: 'desc' },
            take: 10,
          }),
        ]);
        await tx.botSimulationTurn.create({
          data: { organizationId: orgId, sessionId: req.body.sessionId, role: 'user', body: req.body.message },
        });
        return { data, history: history.reverse() };
      });

      // OpenAI call — outside any tx, can take 5–15s without breaking
      // anything.
      const reply = await buildBotResponse({
        organizationId: orgId,
        userMessage: req.body.message,
        history: history.map((h) => ({ role: h.role as 'user' | 'assistant', content: h.body })),
        data,
      });

      // tx2: persist the assistant turn. Fire-and-forget'ish — if this
      // fails the user still got their reply, but we log + propagate so
      // the route returns 500 instead of a phantom-success.
      await app.tenant(req, async (tx) => {
        await tx.botSimulationTurn.create({
          data: { organizationId: orgId, sessionId: req.body.sessionId, role: 'assistant', body: reply.text },
        });
      });

      return { data: { reply: reply.text, usedKbCount: reply.usedKbCount } };
    },
  );

  // ---------- POST /bot/scenarios/generate ----------
  // Build a fresh set of scenarios from the CURRENT knowledge base + catalog.
  // Wipes existing ai_generated scenarios + their runs; preserves any manual
  // ones the operator authored.
  r.post(
    '/bot/scenarios/generate',
    {
      schema: {
        tags: ['bot'],
        summary: 'Regenerate test scenarios from the current KB (wipes prior AI ones).',
      },
      preHandler: [app.requireRole('admin')],
    },
    async (req) => {
      if (!isOpenAIConfigured()) {
        throw badRequest(
          ApiErrorCode.SERVICE_UNAVAILABLE,
          'AI bot is unavailable: OPENAI_API_KEY is not configured.',
        );
      }
      const orgId = req.auth!.organizationId;
      const data = await app.tenant(req, (tx) => gatherBotData(tx, orgId));
      const generated = await generateScenariosFromKb(orgId, data);

      const written = await app.tenant(req, async (tx) => {
        // Wipe AI-generated scenarios + their runs. Manual ones are kept.
        const stale = await tx.botTestScenario.findMany({
          where: { source: 'ai_generated' },
          select: { key: true },
        });
        const staleKeys = stale.map((s) => s.key);
        if (staleKeys.length > 0) {
          await tx.botTestRun.deleteMany({ where: { scenarioKey: { in: staleKeys } } });
          await tx.botTestScenario.deleteMany({
            where: { source: 'ai_generated' },
          });
        }
        const rows = [];
        for (let i = 0; i < generated.length; i++) {
          const g = generated[i]!;
          const row = await tx.botTestScenario.upsert({
            where: { organizationId_key: { organizationId: orgId, key: g.key } },
            update: { prompt: g.prompt, expectation: g.expectation, source: 'ai_generated', sortOrder: i },
            create: {
              organizationId: orgId,
              key: g.key,
              prompt: g.prompt,
              expectation: g.expectation,
              source: 'ai_generated',
              sortOrder: i,
            },
          });
          rows.push(row);
        }
        return rows;
      });

      await recordAudit({
        action: 'business_info_updated',
        organizationId: orgId,
        actorUserId: req.auth!.userId,
        entityType: 'bot_test_scenario',
        metadata: { event: 'scenarios_generated', count: written.length },
      });
      return {
        data: {
          scenarios: written.map((s) => ({
            id: s.id,
            key: s.key,
            prompt: s.prompt,
            expectation: s.expectation,
            source: s.source,
          })),
        },
      };
    },
  );

  // ---------- DELETE /bot/scenarios ----------
  // Wipe ALL scenarios (manual + AI) and their runs. Used when the operator
  // wants a clean slate before a regenerate.
  r.delete(
    '/bot/scenarios',
    {
      schema: { tags: ['bot'], summary: 'Delete every test scenario + its run history.', response: { 200: successSchema } },
      preHandler: [app.requireRole('admin')],
    },
    async (req) => {
      const orgId = req.auth!.organizationId;
      const result = await app.tenant(req, async (tx) => {
        const before = await tx.botTestScenario.count();
        await tx.botTestRun.deleteMany({});
        await tx.botTestScenario.deleteMany({});
        return before;
      });
      await recordAudit({
        action: 'business_info_updated',
        organizationId: orgId,
        actorUserId: req.auth!.userId,
        entityType: 'bot_test_scenario',
        metadata: { event: 'scenarios_deleted_all', count: result },
      });
      return { ok: true as const };
    },
  );

  // ---------- DELETE /bot/scenarios/:id ----------
  r.delete(
    '/bot/scenarios/:id',
    {
      schema: {
        tags: ['bot'],
        summary: 'Delete one scenario + its run history.',
        params: z.object({ id: uuidSchema }),
        response: { 200: successSchema },
      },
      preHandler: [app.requireRole('admin')],
    },
    async (req) => {
      const orgId = req.auth!.organizationId;
      await app.tenant(req, async (tx) => {
        const row = await tx.botTestScenario.findUnique({ where: { id: req.params.id } });
        if (!row) throw notFound('Scenario not found.');
        await tx.botTestRun.deleteMany({ where: { scenarioKey: row.key } });
        await tx.botTestScenario.delete({ where: { id: row.id } });
      });
      await recordAudit({
        action: 'business_info_updated',
        organizationId: orgId,
        actorUserId: req.auth!.userId,
        entityType: 'bot_test_scenario',
        entityId: req.params.id,
        metadata: { event: 'scenario_deleted' },
      });
      return { ok: true as const };
    },
  );

  // ---------- POST /bot/scenarios/run ----------
  // Runs every scenario the org has in the DB + LLM-judges each. If the org
  // has NO scenarios yet (fresh install or operator just deleted them all),
  // we auto-generate a fresh batch from the current KB first — so the
  // operator's "Run all" click after a KB refresh always produces a NEW set.
  r.post(
    '/bot/scenarios/run',
    {
      schema: {
        tags: ['bot'],
        summary: 'Run every saved scenario + LLM-judge. Auto-generates from KB if none saved.',
      },
      preHandler: [app.requireRole('admin')],
    },
    async (req) => {
      if (!isOpenAIConfigured()) {
        throw badRequest(
          ApiErrorCode.SERVICE_UNAVAILABLE,
          'AI bot is unavailable: OPENAI_API_KEY is not configured.',
        );
      }
      const orgId = req.auth!.organizationId;
      const data = await app.tenant(req, (tx) => gatherBotData(tx, orgId));

      // Auto-generate when empty so the button is never a no-op.
      let scenarios = await app.tenant(req, (tx) =>
        tx.botTestScenario.findMany({ orderBy: { sortOrder: 'asc' } }),
      );
      if (scenarios.length === 0) {
        const fresh = await generateScenariosFromKb(orgId, data);
        scenarios = await app.tenant(req, async (tx) => {
          const rows = [];
          for (let i = 0; i < fresh.length; i++) {
            const g = fresh[i]!;
            const row = await tx.botTestScenario.upsert({
              where: { organizationId_key: { organizationId: orgId, key: g.key } },
              update: { prompt: g.prompt, expectation: g.expectation, source: 'ai_generated', sortOrder: i },
              create: {
                organizationId: orgId,
                key: g.key,
                prompt: g.prompt,
                expectation: g.expectation,
                source: 'ai_generated',
                sortOrder: i,
              },
            });
            rows.push(row);
          }
          return rows;
        });
      }

      const out: {
        id: string;
        key: string;
        prompt: string;
        reply: string;
        score: number;
        notes: string;
      }[] = [];

      for (const s of scenarios) {
        const reply = await buildBotResponse({
          organizationId: orgId,
          userMessage: s.prompt,
          data,
        });
        // LLM-as-judge.
        const judgeSys =
          'You are a strict QA judge. Score the bot reply 0–100 against the expectation. Return STRICT JSON: {"score": <int>, "notes": "<one short sentence>"}. No prose, no markdown.';
        const judgeUser = `Expectation:\n${s.expectation}\n\nBot reply:\n${reply.text}`;
        let score = 0;
        let notes = 'judge failed';
        try {
          const judge = await complete({
            organizationId: orgId,
            systemPrompt: judgeSys,
            messages: [{ role: 'user', content: judgeUser }],
            maxTokens: 200,
            temperature: 0.0,
          });
          const trimmed = judge.text.trim().replace(/^```json/i, '').replace(/```$/i, '').trim();
          const parsed = JSON.parse(trimmed) as { score?: number; notes?: string };
          if (typeof parsed.score === 'number') score = Math.max(0, Math.min(100, Math.round(parsed.score)));
          if (typeof parsed.notes === 'string') notes = parsed.notes;
        } catch {
          /* keep defaults */
        }
        await withTenant(orgId, (tx) =>
          tx.botTestRun.create({
            data: {
              organizationId: orgId,
              scenarioKey: s.key,
              scenarioPrompt: s.prompt,
              botResponse: reply.text,
              score,
              judgeNotes: notes,
            },
          }),
        );
        out.push({ id: s.id, key: s.key, prompt: s.prompt, reply: reply.text, score, notes });
      }
      const avg = out.reduce((a, b) => a + b.score, 0) / Math.max(1, out.length);
      return { data: { runs: out, averageScore: Math.round(avg) } };
    },
  );

  // ---------- GET /bot/scenarios/last ----------
  // Latest run for every scenario the org has saved. Falls back to the
  // scenario row itself (no run yet) so the UI can render a "not run yet"
  // state alongside the scored ones.
  r.get(
    '/bot/scenarios/last',
    {
      schema: { tags: ['bot'], summary: 'Latest test run per saved scenario.' },
      preHandler: [app.requireRole('viewer')],
    },
    async (req) =>
      app.tenant(req, async (tx) => {
        const scenarios = await tx.botTestScenario.findMany({
          orderBy: { sortOrder: 'asc' },
        });
        const out = [];
        for (const s of scenarios) {
          const last = await tx.botTestRun.findFirst({
            where: { scenarioKey: s.key },
            orderBy: { createdAt: 'desc' },
          });
          out.push({
            id: s.id,
            key: s.key,
            prompt: s.prompt,
            expectation: s.expectation,
            source: s.source,
            runId: last?.id ?? null,
            reply: last?.botResponse ?? null,
            score: last?.score ?? null,
            notes: last?.judgeNotes ?? null,
            overrideScore: last?.overrideScore ?? null,
            overrideNotes: last?.overrideNotes ?? null,
            ranAt: last?.createdAt.toISOString() ?? null,
          });
        }
        return { data: out };
      }),
  );

  // ---------- POST /bot/conversation-flows/recommend ----------
  // Generate 3–5 conversation-flow CANDIDATES tailored to the business.
  // Replaces any prior unselected candidates so the operator sees a fresh
  // set. The previously-selected one (if any) is preserved + un-flagged
  // as recommended; the LLM picks a new recommended candidate.
  r.post(
    '/bot/conversation-flows/recommend',
    {
      schema: {
        tags: ['bot'],
        summary: 'Generate 3–5 conversation-flow candidates tailored to the business.',
      },
      preHandler: [app.requireRole('admin')],
    },
    async (req) => {
      if (!isOpenAIConfigured()) {
        throw badRequest(
          ApiErrorCode.SERVICE_UNAVAILABLE,
          'AI bot is unavailable: OPENAI_API_KEY is not configured.',
        );
      }
      const orgId = req.auth!.organizationId;
      const data = await app.tenant(req, (tx) => gatherBotData(tx, orgId));
      const candidates = await generateFlowCandidates(orgId, data);
      if (candidates.length === 0) {
        throw badRequest(
          ApiErrorCode.VALIDATION_ERROR,
          'Could not generate flow candidates. Add some KB / products / services first.',
        );
      }

      const saved = await app.tenant(req, async (tx) => {
        // Wipe unselected candidates so the operator only sees the freshest
        // set. Keep the active one — switching mid-deploy would be jarring.
        await tx.botConversationFlowOption.deleteMany({ where: { isSelected: false } });
        // Clear any stale recommended flags on the surviving (selected) one.
        await tx.botConversationFlowOption.updateMany({
          where: { isSelected: true },
          data: { isRecommended: false },
        });
        const rows = [];
        for (const c of candidates) {
          const row = await tx.botConversationFlowOption.create({
            data: {
              organizationId: orgId,
              name: c.name,
              description: c.description,
              flow: c.flow as never,
              isRecommended: c.isRecommended,
              recommendReason: c.recommendReason,
              isSelected: false,
            },
          });
          rows.push(row);
        }
        return rows;
      });

      await recordAudit({
        action: 'business_info_updated',
        organizationId: orgId,
        actorUserId: req.auth!.userId,
        entityType: 'bot_conversation_flow_option',
        metadata: { event: 'flow_candidates_generated', count: saved.length },
      });
      return {
        data: {
          candidates: saved.map((c) => ({
            id: c.id,
            name: c.name,
            description: c.description,
            isRecommended: c.isRecommended,
            recommendReason: c.recommendReason,
            isSelected: c.isSelected,
            flow: c.flow as Record<string, unknown>,
          })),
        },
      };
    },
  );

  // ---------- GET /bot/conversation-flows ----------
  r.get(
    '/bot/conversation-flows',
    {
      schema: { tags: ['bot'], summary: 'List conversation-flow candidates for this org.' },
      preHandler: [app.requireRole('viewer')],
    },
    async (req) =>
      app.tenant(req, async (tx) => {
        const rows = await tx.botConversationFlowOption.findMany({
          orderBy: [{ isSelected: 'desc' }, { isRecommended: 'desc' }, { createdAt: 'asc' }],
        });
        return {
          data: rows.map((c) => ({
            id: c.id,
            name: c.name,
            description: c.description,
            isRecommended: c.isRecommended,
            recommendReason: c.recommendReason,
            isSelected: c.isSelected,
            flow: c.flow as Record<string, unknown>,
            createdAt: c.createdAt.toISOString(),
          })),
        };
      }),
  );

  // ---------- POST /bot/conversation-flows/:id/select ----------
  // Mark a candidate as the active flow and mirror its JSON onto the
  // BotConfig so the runtime keeps a single source of truth.
  r.post(
    '/bot/conversation-flows/:id/select',
    {
      schema: {
        tags: ['bot'],
        summary: 'Select a candidate as the active conversation flow.',
        params: z.object({ id: uuidSchema }),
      },
      preHandler: [app.requireRole('admin')],
    },
    async (req) => {
      const orgId = req.auth!.organizationId;
      const updated = await app.tenant(req, async (tx) => {
        const row = await tx.botConversationFlowOption.findUnique({ where: { id: req.params.id } });
        if (!row) throw notFound('Flow candidate not found.');
        await tx.botConversationFlowOption.updateMany({ data: { isSelected: false } });
        const selected = await tx.botConversationFlowOption.update({
          where: { id: row.id },
          data: { isSelected: true },
        });
        // Mirror onto BotConfig so the runtime keeps reading one source.
        await tx.botConfig.upsert({
          where: { organizationId: orgId },
          create: { organizationId: orgId, conversationFlow: selected.flow as never },
          update: { conversationFlow: selected.flow as never },
        });
        return selected;
      });
      await recordAudit({
        action: 'business_info_updated',
        organizationId: orgId,
        actorUserId: req.auth!.userId,
        entityType: 'bot_conversation_flow_option',
        entityId: updated.id,
        metadata: { event: 'flow_selected', name: updated.name },
      });
      return {
        data: {
          id: updated.id,
          name: updated.name,
          isSelected: updated.isSelected,
        },
      };
    },
  );

  // ---------- PATCH /bot/conversation-flows/:id ----------
  // Edit a candidate's name, description, or flow JSON. Edits to the
  // currently-selected candidate are mirrored onto BotConfig.
  r.patch(
    '/bot/conversation-flows/:id',
    {
      schema: {
        tags: ['bot'],
        summary: 'Edit a conversation-flow candidate.',
        params: z.object({ id: uuidSchema }),
        body: z.object({
          name: z.string().trim().min(1).max(80).optional(),
          description: z.string().trim().min(1).max(400).optional(),
          flow: z
            .object({
              nodes: z.array(
                z.object({
                  intent: z.string().trim().min(1).max(40),
                  label: z.string().trim().min(1).max(80),
                  response: z.string().trim().min(1).max(600),
                }),
              ),
            })
            .optional(),
        }),
      },
      preHandler: [app.requireRole('admin')],
    },
    async (req) => {
      const orgId = req.auth!.organizationId;
      const updated = await app.tenant(req, async (tx) => {
        const row = await tx.botConversationFlowOption.findUnique({ where: { id: req.params.id } });
        if (!row) throw notFound('Flow candidate not found.');
        const next = await tx.botConversationFlowOption.update({
          where: { id: row.id },
          data: {
            name: req.body.name ?? undefined,
            description: req.body.description ?? undefined,
            flow: req.body.flow === undefined ? undefined : (req.body.flow as never),
          },
        });
        if (next.isSelected && req.body.flow !== undefined) {
          await tx.botConfig.update({
            where: { organizationId: orgId },
            data: { conversationFlow: next.flow as never },
          });
        }
        return next;
      });
      return {
        data: {
          id: updated.id,
          name: updated.name,
          description: updated.description,
          flow: updated.flow as Record<string, unknown>,
        },
      };
    },
  );

  // ---------- DELETE /bot/conversation-flows/:id ----------
  // Remove a candidate. Refuses to delete the currently-selected one — the
  // operator must pick another candidate first so the bot never has no
  // active flow.
  r.delete(
    '/bot/conversation-flows/:id',
    {
      schema: {
        tags: ['bot'],
        summary: 'Delete a conversation-flow candidate (must not be selected).',
        params: z.object({ id: uuidSchema }),
        response: { 200: successSchema },
      },
      preHandler: [app.requireRole('admin')],
    },
    async (req) => {
      const orgId = req.auth!.organizationId;
      await app.tenant(req, async (tx) => {
        const row = await tx.botConversationFlowOption.findUnique({ where: { id: req.params.id } });
        if (!row) throw notFound('Flow candidate not found.');
        if (row.isSelected) {
          throw badRequest(
            ApiErrorCode.VALIDATION_ERROR,
            'Cannot delete the currently-selected flow. Select a different one first.',
          );
        }
        await tx.botConversationFlowOption.delete({ where: { id: row.id } });
      });
      await recordAudit({
        action: 'business_info_updated',
        organizationId: orgId,
        actorUserId: req.auth!.userId,
        entityType: 'bot_conversation_flow_option',
        entityId: req.params.id,
        metadata: { event: 'flow_candidate_deleted' },
      });
      return { ok: true as const };
    },
  );

  // ---------- PATCH /bot/scenarios/runs/:id ----------
  // Operator override on a specific test-run's score. Lets the team
  // disagree with the LLM judge when the judge prompt is overly strict
  // or misses nuance. The original LLM `score` + `judgeNotes` are kept
  // verbatim; the human signal lives in overrideScore / overrideNotes.
  r.patch(
    '/bot/scenarios/runs/:id',
    {
      schema: {
        tags: ['bot'],
        summary: 'Operator override of an LLM judge score (0..100) + notes.',
        params: z.object({ id: uuidSchema }),
        body: z.object({
          overrideScore: z.number().int().min(0).max(100).nullable(),
          overrideNotes: z.string().trim().max(2000).optional().nullable(),
        }),
      },
      preHandler: [app.requireRole('admin')],
    },
    async (req) => {
      const orgId = req.auth!.organizationId;
      return app.tenant(req, async (tx) => {
        const row = await tx.botTestRun.findFirst({ where: { id: req.params.id } });
        if (!row) throw notFound('Test run not found.');
        const updated = await tx.botTestRun.update({
          where: { id: row.id },
          data: {
            overrideScore: req.body.overrideScore,
            overrideNotes: req.body.overrideNotes ?? null,
            overrideByUserId: req.body.overrideScore === null ? null : req.auth!.userId,
            overrideAt: req.body.overrideScore === null ? null : new Date(),
          },
        });
        await recordAudit({
          action: 'business_info_updated',
          organizationId: orgId,
          actorUserId: req.auth!.userId,
          entityType: 'bot_test_run',
          entityId: updated.id,
          metadata: {
            event: req.body.overrideScore === null ? 'judge_override_cleared' : 'judge_override_set',
            scenarioKey: updated.scenarioKey,
            overrideScore: req.body.overrideScore,
          },
        });
        return {
          data: {
            id: updated.id,
            overrideScore: updated.overrideScore,
            overrideNotes: updated.overrideNotes,
          },
        };
      });
    },
  );

  // ---------- POST /bot/deploy ----------
  r.post(
    '/bot/deploy',
    {
      schema: {
        tags: ['bot'],
        summary: 'Deploy the bot — flips deployedAt + auto-replies start in inbound webhook.',
        response: { 200: itemEnvelopeSchema(botConfigDto) },
      },
      preHandler: [app.requireRole('admin')],
    },
    async (req) => {
      const orgId = req.auth!.organizationId;
      return app.tenant(req, async (tx) => {
        const cfg = await tx.botConfig.findUnique({ where: { organizationId: orgId } });
        if (!cfg) throw notFound('Bot config not found.');
        const updated = await tx.botConfig.update({
          where: { id: cfg.id },
          data: { deployedAt: new Date() },
        });
        await recordAudit({
          action: 'business_info_updated',
          organizationId: orgId,
          actorUserId: req.auth!.userId,
          entityType: 'bot_config',
          entityId: updated.id,
          metadata: { event: 'bot_deployed', version: updated.version },
        });
        return { data: serializeConfig(updated) };
      });
    },
  );

  // ---------- POST /bot/undeploy ----------
  r.post(
    '/bot/undeploy',
    {
      schema: {
        tags: ['bot'],
        summary: 'Roll back deployment — bot stops auto-replying.',
        response: { 200: itemEnvelopeSchema(botConfigDto) },
      },
      preHandler: [app.requireRole('admin')],
    },
    async (req) => {
      const orgId = req.auth!.organizationId;
      return app.tenant(req, async (tx) => {
        const cfg = await tx.botConfig.findUnique({ where: { organizationId: orgId } });
        if (!cfg) throw notFound('Bot config not found.');
        const updated = await tx.botConfig.update({
          where: { id: cfg.id },
          data: { deployedAt: null },
        });
        return { data: serializeConfig(updated) };
      });
    },
  );
}
