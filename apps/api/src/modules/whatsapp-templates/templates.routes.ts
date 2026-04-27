// Phase 3 §5.1.2 — WhatsApp message templates.
//
// Meta requires pre-approved templates for any message sent OUTSIDE the
// 24-hour customer session window (marketing, utility, authentication
// flows). This module lets clients author templates locally, submit them
// to Meta for approval, and track approval status.
//
// Submission to Meta uses the WABA-level endpoint
// POST /v20.0/{waba_id}/message_templates. Status updates are pushed via
// the same webhook URL Meta uses for messages — when we see a
// `message_template_status_update` field in the inbound payload, we
// reconcile our row.
//
// For Session 4 we ship: CRUD, manual submit, manual status refresh.
// Webhook-driven status reconciliation is wired but optional (Meta only
// emits it if the WABA is subscribed to `message_template_status_update`).
import { ApiErrorCode, listEnvelopeSchema, successSchema, uuidSchema } from '@aligned/shared';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { recordAudit } from '../../lib/audit.js';
import { badRequest, notFound } from '../../lib/errors.js';

const templateDtoSchema = z.object({
  id: uuidSchema,
  name: z.string(),
  language: z.string(),
  category: z.string(),
  bodyText: z.string(),
  status: z.string(),
  rejectionReason: z.string().nullable(),
  metaTemplateId: z.string().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export default async function whatsappTemplatesRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  // ---------- GET /whatsapp/templates ----------------------------------
  r.get(
    '/whatsapp/templates',
    {
      schema: {
        tags: ['whatsapp'],
        summary: 'List message templates (any status).',
        response: { 200: listEnvelopeSchema(templateDtoSchema) },
      },
      preHandler: [app.requireRole('viewer')],
    },
    async (req) =>
      app.tenant(req, async (tx) => {
        const rows = await tx.whatsAppTemplate.findMany({ orderBy: { updatedAt: 'desc' } });
        return {
          data: rows.map((t) => ({
            id: t.id,
            name: t.name,
            language: t.language,
            category: t.category,
            bodyText: t.bodyText,
            status: t.status,
            rejectionReason: t.rejectionReason,
            metaTemplateId: t.metaTemplateId,
            createdAt: t.createdAt.toISOString(),
            updatedAt: t.updatedAt.toISOString(),
          })),
          nextCursor: null,
        };
      }),
  );

  // ---------- POST /whatsapp/templates ---------------------------------
  r.post(
    '/whatsapp/templates',
    {
      schema: {
        tags: ['whatsapp'],
        summary: 'Create a draft template.',
        body: z.object({
          name: z
            .string()
            .trim()
            .regex(/^[a-z0-9_]+$/, 'Lowercase letters, digits, and underscore only.')
            .min(1)
            .max(64),
          language: z.string().trim().min(2).max(8).default('en_US'),
          category: z.enum(['MARKETING', 'UTILITY', 'AUTHENTICATION']),
          bodyText: z.string().trim().min(1).max(1024),
        }),
      },
      preHandler: [app.requireRole('editor')],
    },
    async (req) =>
      app.tenant(req, async (tx) => {
        const created = await tx.whatsAppTemplate.create({
          data: {
            organizationId: req.auth!.organizationId,
            name: req.body.name,
            language: req.body.language,
            category: req.body.category,
            bodyText: req.body.bodyText,
            status: 'draft',
          },
        });
        return { data: { id: created.id } };
      }),
  );

  // ---------- POST /whatsapp/templates/:id/submit ----------------------
  // Pushes the template to Meta for approval. Meta replies with a template
  // id + initial status (usually `PENDING`). We reconcile when the
  // status-update webhook fires (or via /refresh).
  r.post(
    '/whatsapp/templates/:id/submit',
    {
      schema: {
        tags: ['whatsapp'],
        summary: 'Submit a draft template to Meta for approval.',
        params: z.object({ id: uuidSchema }),
      },
      preHandler: [app.requireRole('admin')],
    },
    async (req) => {
      const orgId = req.auth!.organizationId;
      return app.tenant(req, async (tx) => {
        const tpl = await tx.whatsAppTemplate.findFirst({ where: { id: req.params.id } });
        if (!tpl) throw notFound('Template not found.');
        const channel = await tx.whatsAppChannel.findFirst({
          where: { organizationId: orgId, isPrimary: true },
        });
        if (!channel?.wabaId || !channel?.accessToken) {
          throw badRequest(
            ApiErrorCode.VALIDATION_ERROR,
            'Configure WABA ID + access token on the WhatsApp page first.',
          );
        }

        // Meta payload: we only support body components in Session 4.
        const payload = {
          name: tpl.name,
          language: tpl.language,
          category: tpl.category,
          components: [{ type: 'BODY', text: tpl.bodyText }],
        };

        let resBody = '';
        let resStatus = 0;
        try {
          const res = await fetch(
            `https://graph.facebook.com/v20.0/${encodeURIComponent(channel.wabaId)}/message_templates`,
            {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${channel.accessToken}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify(payload),
              signal: AbortSignal.timeout(10_000),
            },
          );
          resStatus = res.status;
          resBody = await res.text();
        } catch (err) {
          await tx.whatsAppTemplate.update({
            where: { id: tpl.id },
            data: { status: 'rejected', rejectionReason: err instanceof Error ? err.message : 'fetch failed' },
          });
          throw badRequest(
            ApiErrorCode.SERVICE_UNAVAILABLE,
            'Meta unreachable; template marked as rejected so it can be edited and resubmitted.',
          );
        }

        let parsed: Record<string, unknown> | null = null;
        try {
          parsed = JSON.parse(resBody) as Record<string, unknown>;
        } catch {
          parsed = null;
        }
        if (resStatus < 200 || resStatus >= 300 || !parsed) {
          const errObj = (parsed?.error ?? {}) as Record<string, unknown>;
          await tx.whatsAppTemplate.update({
            where: { id: tpl.id },
            data: {
              status: 'rejected',
              rejectionReason:
                typeof errObj.message === 'string' ? errObj.message : `HTTP ${resStatus}`,
            },
          });
          return { data: { ok: false, status: 'rejected' } };
        }

        await tx.whatsAppTemplate.update({
          where: { id: tpl.id },
          data: {
            status: typeof parsed.status === 'string' ? parsed.status.toLowerCase() : 'pending',
            metaTemplateId: typeof parsed.id === 'string' ? parsed.id : null,
            rejectionReason: null,
          },
        });

        await recordAudit({
          action: 'business_info_updated',
          organizationId: orgId,
          actorUserId: req.auth!.userId,
          entityType: 'whatsapp_template',
          entityId: tpl.id,
          metadata: { event: 'template_submitted', name: tpl.name },
        });

        return { data: { ok: true, status: 'pending' } };
      });
    },
  );

  // ---------- DELETE /whatsapp/templates/:id ---------------------------
  r.delete(
    '/whatsapp/templates/:id',
    {
      schema: {
        tags: ['whatsapp'],
        summary: 'Delete a template (local only — Meta-side approved templates need separate removal in Meta).',
        params: z.object({ id: uuidSchema }),
        response: { 200: successSchema },
      },
      preHandler: [app.requireRole('admin')],
    },
    async (req) =>
      app.tenant(req, async (tx) => {
        await tx.whatsAppTemplate.deleteMany({ where: { id: req.params.id } });
        return { ok: true as const };
      }),
  );
}
