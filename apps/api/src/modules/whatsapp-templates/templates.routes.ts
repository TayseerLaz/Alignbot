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
  // Full Meta-shaped components array when present (header / body /
  // footer / buttons). Synced from Meta + populated by the builder UI.
  components: z.array(z.record(z.string(), z.unknown())).nullable(),
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
            components: Array.isArray(t.components)
              ? (t.components as unknown as Record<string, unknown>[])
              : null,
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
  // The optional `components` field accepts the full Meta-shaped JSON
  // (header / body / footer / buttons). When provided, it's the source
  // of truth at submit time. When omitted, we fall back to a single
  // BODY component built from bodyText so the simple flow still works.
  const componentsSchema = z.array(
    z.discriminatedUnion('type', [
      z.object({
        type: z.literal('HEADER'),
        format: z.enum(['TEXT', 'IMAGE', 'VIDEO', 'DOCUMENT']),
        text: z.string().max(60).optional(),
        example: z
          .object({
            header_text: z.array(z.string()).optional(),
            header_handle: z.array(z.string().url()).optional(),
          })
          .optional(),
      }),
      z.object({
        type: z.literal('BODY'),
        text: z.string().trim().min(1).max(1024),
        example: z
          .object({ body_text: z.array(z.array(z.string())) })
          .optional(),
      }),
      z.object({
        type: z.literal('FOOTER'),
        text: z.string().trim().min(1).max(60),
      }),
      z.object({
        type: z.literal('BUTTONS'),
        buttons: z
          .array(
            z.discriminatedUnion('type', [
              z.object({
                type: z.literal('QUICK_REPLY'),
                text: z.string().trim().min(1).max(25),
              }),
              z.object({
                type: z.literal('URL'),
                text: z.string().trim().min(1).max(25),
                url: z.string().url().max(2000),
                example: z.array(z.string()).optional(),
              }),
              z.object({
                type: z.literal('PHONE_NUMBER'),
                text: z.string().trim().min(1).max(25),
                phone_number: z
                  .string()
                  .trim()
                  .regex(/^\+?[0-9]{6,16}$/, 'E.164 phone number'),
              }),
              z.object({
                type: z.literal('COPY_CODE'),
                example: z.string().trim().min(1).max(15),
              }),
            ]),
          )
          .min(1)
          .max(10),
      }),
    ]),
  );

  r.post(
    '/whatsapp/templates',
    {
      schema: {
        tags: ['whatsapp'],
        summary: 'Create a draft template (full Meta components supported).',
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
          components: componentsSchema.optional(),
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
            components: (req.body.components ?? null) as never,
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

        // Use the full components array when the operator built one;
        // otherwise fall back to a single BODY built from bodyText so
        // the simple "just type the body" flow still works.
        const storedComponents = Array.isArray(tpl.components)
          ? (tpl.components as unknown as Record<string, unknown>[])
          : null;
        const payload = {
          name: tpl.name,
          language: tpl.language,
          category: tpl.category,
          components: storedComponents && storedComponents.length > 0
            ? storedComponents
            : [{ type: 'BODY', text: tpl.bodyText }],
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

  // ---------- POST /whatsapp/templates/sync -----------------------------
  // Pulls every template from Meta (the WABA-level message_templates
  // endpoint) and upserts them into our DB. Covers two gaps:
  //   1. Templates the operator created directly in Meta's WhatsApp
  //      Manager UI never landed here — sync imports them.
  //   2. Templates submitted through our portal still showed as
  //      `pending` after Meta approved them, because we don't yet
  //      process the `message_template_status_update` webhook field.
  //      Sync re-reads the authoritative status from Meta.
  // Auth: admin-only; uses the org's stored WABA id + access token.
  r.post(
    '/whatsapp/templates/sync',
    {
      schema: {
        tags: ['whatsapp'],
        summary: 'Sync templates from Meta (import new + refresh status).',
        response: {
          200: z.object({
            data: z.object({
              imported: z.number().int(),
              updated: z.number().int(),
              total: z.number().int(),
            }),
          }),
        },
      },
      preHandler: [app.requireRole('admin')],
    },
    async (req) => {
      const orgId = req.auth!.organizationId;
      return app.tenant(req, async (tx) => {
        const channel = await tx.whatsAppChannel.findFirst({
          where: { organizationId: orgId, isPrimary: true },
        });
        if (!channel?.wabaId || !channel?.accessToken) {
          throw badRequest(
            ApiErrorCode.VALIDATION_ERROR,
            'Configure WABA ID + access token on the WhatsApp page first.',
          );
        }

        // Page through Meta's templates list. Defaults to 100 per page
        // and follows paging.next links until exhausted or we hit 500
        // templates (generous upper bound — most accounts have <50).
        type MetaTemplate = {
          id?: string;
          name?: string;
          language?: string;
          category?: string;
          status?: string;
          rejected_reason?: string;
          components?: { type?: string; text?: string }[];
        };

        const remote: MetaTemplate[] = [];
        let next: string | null =
          `https://graph.facebook.com/v20.0/${encodeURIComponent(channel.wabaId)}/message_templates` +
          `?fields=id,name,language,category,status,rejected_reason,components&limit=100`;
        let hops = 0;
        while (next && hops < 10 && remote.length < 500) {
          hops += 1;
          let payload: { data?: MetaTemplate[]; paging?: { next?: string } } = {};
          try {
            const res = await fetch(next, {
              headers: { Authorization: `Bearer ${channel.accessToken}` },
              signal: AbortSignal.timeout(10_000),
            });
            const text = await res.text();
            if (!res.ok) {
              throw badRequest(
                ApiErrorCode.SERVICE_UNAVAILABLE,
                `Meta returned HTTP ${res.status} from message_templates: ${text.slice(0, 200)}`,
              );
            }
            payload = JSON.parse(text) as typeof payload;
          } catch (err) {
            if (err instanceof Error && err.name === 'AbortError') {
              throw badRequest(
                ApiErrorCode.SERVICE_UNAVAILABLE,
                'Meta /message_templates timed out (10s).',
              );
            }
            throw err;
          }
          for (const t of payload.data ?? []) remote.push(t);
          next = payload.paging?.next ?? null;
        }

        // Upsert by (organizationId, metaTemplateId) when we have a
        // Meta id; fall back to (organizationId, name, language) so
        // templates submitted through our portal get reconciled too.
        let imported = 0;
        let updated = 0;
        for (const t of remote) {
          if (!t.name || !t.language) continue;
          const bodyText =
            (t.components ?? []).find((c) => (c.type ?? '').toUpperCase() === 'BODY')?.text ?? '';
          const status = (t.status ?? 'pending').toLowerCase();
          const category = (t.category ?? 'UTILITY').toUpperCase();

          // Find by Meta id first; then by name+language.
          const existing = t.id
            ? await tx.whatsAppTemplate.findFirst({
                where: { organizationId: orgId, metaTemplateId: t.id },
              })
            : await tx.whatsAppTemplate.findFirst({
                where: { organizationId: orgId, name: t.name, language: t.language },
              });

          // Store the full components array Meta sent us. Makes the
          // builder UI editable (operator can read/edit existing
          // headers/footers/buttons) and lets future submits include
          // every component without us having to remodel each one.
          const components = Array.isArray(t.components) ? (t.components as unknown) : null;
          if (existing) {
            await tx.whatsAppTemplate.update({
              where: { id: existing.id },
              data: {
                metaTemplateId: t.id ?? existing.metaTemplateId,
                status,
                category,
                bodyText: bodyText || existing.bodyText,
                components: components as never,
                // Meta returns "NONE" for approved templates that have no
                // rejection reason — treat that as null at ingest time so
                // the UI never has to guess.
                rejectionReason:
                  t.rejected_reason && t.rejected_reason.toUpperCase() !== 'NONE'
                    ? t.rejected_reason
                    : null,
              },
            });
            updated += 1;
          } else {
            await tx.whatsAppTemplate.create({
              data: {
                organizationId: orgId,
                name: t.name,
                language: t.language,
                category,
                bodyText: bodyText || '(imported from Meta — no body component)',
                components: components as never,
                status,
                metaTemplateId: t.id ?? null,
                // Meta returns "NONE" for approved templates that have no
                // rejection reason — treat that as null at ingest time so
                // the UI never has to guess.
                rejectionReason:
                  t.rejected_reason && t.rejected_reason.toUpperCase() !== 'NONE'
                    ? t.rejected_reason
                    : null,
              },
            });
            imported += 1;
          }
        }

        await recordAudit({
          action: 'business_info_updated',
          organizationId: orgId,
          actorUserId: req.auth!.userId,
          entityType: 'whatsapp_template',
          // The sync touches the whole template set, not a single row.
          // recordAudit's entityId is string | undefined; pass undefined
          // (no entity) rather than null (typing mismatch).
          entityId: undefined,
          metadata: { event: 'templates_synced', imported, updated, total: remote.length },
        });

        return { data: { imported, updated, total: remote.length } };
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
