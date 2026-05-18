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

const SCENARIOS: { key: string; prompt: string; expectation: string }[] = [
  {
    key: 'product_question',
    prompt: 'Hey, do you sell anything for outdoor running?',
    expectation:
      'Bot lists 1–3 relevant products by name with price if known. Politely says "no" if catalog has none.',
  },
  {
    key: 'hours_question',
    prompt: 'What time do you open tomorrow?',
    expectation:
      'Bot gives the opening hour for the next business day or says hours are not configured.',
  },
  {
    key: 'booking',
    prompt: 'I want to book the consulting session for next Tuesday.',
    expectation:
      'Bot acknowledges the service, points to availability or asks for booking details. No fake confirmations.',
  },
  {
    key: 'complaint',
    prompt: 'I bought something last week and it arrived broken. This is unacceptable.',
    expectation:
      'Bot apologises briefly, points at returns / refund policy if it exists, or escalates to a human.',
  },
  {
    key: 'unknown',
    prompt: 'Do you ship to Antarctica?',
    expectation:
      'Bot says it does not have that information and offers to escalate to a human. No fabrication.',
  },
];

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

  // ---------- POST /bot/scenarios/run ----------
  // Runs the canned scenarios + LLM-as-judge scoring.
  r.post(
    '/bot/scenarios/run',
    {
      schema: {
        tags: ['bot'],
        summary: 'Run all 5 canned test scenarios and score each with LLM-as-judge.',
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
      const out: { key: string; prompt: string; reply: string; score: number; notes: string }[] = [];

      // Gather data once for the whole run — same KB/catalog/business info
      // applies to every scenario. Saves ~5 round trips per scenario.
      const data = await app.tenant(req, (tx) => gatherBotData(tx, orgId));

      for (const s of SCENARIOS) {
        const reply = await buildBotResponse({
          organizationId: orgId,
          userMessage: s.prompt,
          data,
        });
        // LLM-as-judge: score the bot's reply against the expectation.
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
        out.push({ key: s.key, prompt: s.prompt, reply: reply.text, score, notes });
      }
      const avg = out.reduce((a, b) => a + b.score, 0) / Math.max(1, out.length);
      return { data: { runs: out, averageScore: Math.round(avg) } };
    },
  );

  // ---------- GET /bot/scenarios/last ----------
  r.get(
    '/bot/scenarios/last',
    {
      schema: { tags: ['bot'], summary: 'Latest test run per scenario.' },
      preHandler: [app.requireRole('viewer')],
    },
    async (req) =>
      app.tenant(req, async (tx) => {
        const out: {
          id: string | null;
          key: string;
          prompt: string;
          reply: string | null;
          score: number | null;
          notes: string | null;
          overrideScore: number | null;
          overrideNotes: string | null;
          ranAt: string | null;
        }[] = [];
        for (const s of SCENARIOS) {
          const last = await tx.botTestRun.findFirst({
            where: { scenarioKey: s.key },
            orderBy: { createdAt: 'desc' },
          });
          out.push({
            id: last?.id ?? null,
            key: s.key,
            prompt: s.prompt,
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
