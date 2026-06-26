// Public marketing-site lead capture. Unauthenticated (the hader.ai landing
// page has no session), rate-limited per IP, written to the GLOBAL `leads`
// table via withRlsBypass(). Surfaced for ALIGNED staff in /aligned-admin/leads.
import { leadCaptureBodySchema } from '@aligned/shared';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { withRlsBypass } from '../../lib/db.js';
import { newLeadTemplate, sendEmail } from '../../lib/email.js';
import { env } from '../../lib/env.js';

// Hader team inboxes notified on every new marketing lead.
const LEAD_NOTIFY_RECIPIENTS = ['laztayseer@gmail.com', 'mayssam.ismail@aligned-tech.com'];

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
      // Public — no preHandler. Strict per-IP cap (5/hour) to deter form spam.
      config: {
        rateLimit: {
          max: 5,
          timeWindow: '1 hour',
          keyGenerator: (req) => `lead-capture:${req.ip}`,
        },
      },
    },
    async (req, reply) => {
      // Honeypot: a hidden field bots auto-fill. If set, fake success (so the
      // bot can't detect the rejection) but never save the lead.
      if (req.body.website && req.body.website.trim().length > 0) {
        req.log.info({ ip: req.ip }, '[leads] honeypot tripped — dropping spam submission');
        reply.code(201);
        return { data: { ok: true as const, id: '00000000-0000-0000-0000-000000000000' } };
      }
      const { name, phone } = req.body;
      const resolvedSource = req.body.source?.trim() || 'hader_landing';
      const lead = await withRlsBypass((tx) =>
        tx.lead.create({
          data: { name, phone, source: resolvedSource },
          select: { id: true, createdAt: true },
        }),
      );

      // Notify the Hader team — fire-and-forget so a mail hiccup never fails
      // the public capture (the lead is already saved).
      void (async () => {
        try {
          const tpl = newLeadTemplate({
            name,
            phone,
            source: resolvedSource,
            capturedAt: lead.createdAt,
            leadsUrl: `${env.WEB_PUBLIC_URL}/aligned-admin/leads`,
          });
          await sendEmail({ to: LEAD_NOTIFY_RECIPIENTS.join(', '), ...tpl });
        } catch (err) {
          req.log.error({ err, leadId: lead.id }, '[leads] new-lead notification email failed');
        }
      })();

      reply.code(201);
      return { data: { ok: true as const, id: lead.id } };
    },
  );
}
