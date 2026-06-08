// Public marketing-site lead capture. Unauthenticated (the hader.ai landing
// page has no session), rate-limited per IP, written to the GLOBAL `leads`
// table via withRlsBypass(). Surfaced for ALIGNED staff in /aligned-admin/leads.
import { leadCaptureBodySchema } from '@aligned/shared';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { withRlsBypass } from '../../lib/db.js';

export default async function leadsRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.post(
    '/public/leads',
    {
      schema: {
        tags: ['leads'],
        summary: 'Capture a marketing lead (name + WhatsApp number). Public, no auth.',
        body: leadCaptureBodySchema,
        response: {
          201: z.object({ data: z.object({ ok: z.literal(true), id: z.string().uuid() }) }),
        },
      },
      // Public — no preHandler. Tight per-IP cap to deter form spam.
      config: {
        rateLimit: {
          max: 5,
          timeWindow: '1 minute',
          keyGenerator: (req) => `lead-capture:${req.ip}`,
        },
      },
    },
    async (req, reply) => {
      const { name, phone, source } = req.body;
      const lead = await withRlsBypass((tx) =>
        tx.lead.create({
          data: { name, phone, source: source?.trim() || 'hader_landing' },
          select: { id: true },
        }),
      );
      reply.code(201);
      return { data: { ok: true as const, id: lead.id } };
    },
  );
}
