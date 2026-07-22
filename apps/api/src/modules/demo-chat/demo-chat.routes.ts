// Public "try Hader" demo chat for the hader.ai industry section. Unauthenticated,
// rate-limited per IP. Routes a typed message to a WHITELISTED tenant's bot via
// buildBotResponse — which has NO side effects: it never writes to the tenant's
// inbox, never consumes their monthly AI-message quota, never records provenance
// (all of that lives in the real WhatsApp/Messenger reply paths, not here). So
// public demo traffic can never touch a real tenant's panel; the only cost is the
// LLM call itself, which the per-IP rate limit bounds.
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { buildBotResponse, gatherBotData } from '../../lib/bot-engine.js';
import { withRlsBypass } from '../../lib/db.js';
import { notFound, serviceUnavailable } from '../../lib/errors.js';
import { isOpenAIConfigured } from '../../lib/openai.js';

// Each industry demos a tenant whose live catalog + bot actually serves that
// category. Real tenants where we have them; dedicated demo tenants for the rest.
const CATEGORY_ORG: Record<string, string> = {
  ecom: 'le-gabarit',
  fnb: 'aseer-time',
  realestate: 'yazbek-real-estate',
  clinics: 'demo-clinic',
  education: 'demo-school',
  b2b: 'demo-b2b',
};

// The engine emits internal control markers for the real reply pipeline to
// process (image sends, cart capture, payment links, handoff, bookings). In a
// plain web-chat bubble those must not show, so strip them to clean text.
function stripMarkers(text: string): string {
  return text
    .replace(/\[IMAGE:[^\]]*\]/gi, '')
    .replace(/\[CART:[\s\S]*?\]/gi, '')
    .replace(/\[PAYMENT_LINK\]/gi, '')
    .replace(/\[HANDOFF\]/gi, '')
    .replace(/\[BOOKING:[\s\S]*?\]/gi, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export default async function demoChatRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.post(
    '/public/demo-chat',
    {
      schema: {
        tags: ['demo'],
        summary: 'Public "try Hader" demo chat — routes a message to a whitelisted tenant bot. No auth.',
        body: z.object({
          category: z.enum(['ecom', 'fnb', 'realestate', 'clinics', 'education', 'b2b']),
          message: z.string().trim().min(1).max(1000),
          history: z
            .array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().max(4000) }))
            .max(16)
            .optional(),
        }),
        response: {
          200: z.object({ data: z.object({ reply: z.string(), tenant: z.string() }) }),
        },
      },
      // Public — no preHandler. Per-IP cap bounds LLM cost from demo traffic.
      config: {
        rateLimit: { max: 30, timeWindow: '1 minute', keyGenerator: (req) => `demo-chat:${req.ip}` },
      },
    },
    async (req) => {
      if (!isOpenAIConfigured()) {
        throw serviceUnavailable('The demo is temporarily unavailable.');
      }
      const slug = CATEGORY_ORG[req.body.category];
      const resolved = await withRlsBypass(async (tx) => {
        const org = await tx.organization.findUnique({ where: { slug }, select: { id: true, name: true } });
        if (!org) return null;
        const [biz, data] = await Promise.all([
          tx.businessInfo.findUnique({ where: { organizationId: org.id }, select: { legalName: true } }),
          gatherBotData(tx, org.id),
        ]);
        return { orgId: org.id, name: biz?.legalName || org.name, data };
      });
      // A tenant is demo-ready only once it has a BotConfig (persona) to run.
      if (!resolved || !resolved.data?.config) {
        throw notFound('This industry demo is not available yet.');
      }

      const history = (req.body.history ?? []).slice(-10);
      const reply = await buildBotResponse({
        organizationId: resolved.orgId,
        userMessage: req.body.message,
        history,
        data: resolved.data,
      });

      return { data: { reply: stripMarkers(reply.text) || '…', tenant: resolved.name } };
    },
  );
}
