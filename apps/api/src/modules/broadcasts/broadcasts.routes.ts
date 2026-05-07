// Phase 4 — Broadcasts CRUD + lifecycle.
//
// A broadcast is a campaign that sends a Meta-approved template to a list of
// recipients. The list comes from a CSV asset, a saved Segment, or an inline
// `manualPhones[]` array. Recipients are materialized into BroadcastRecipient
// rows when the broadcast is sent (or scheduled), and the broadcast-fanout
// worker takes it from there.
import {
  ApiErrorCode,
  broadcastDtoSchema,
  broadcastEventDtoSchema,
  createBroadcastBodySchema,
  itemEnvelopeSchema,
  listEnvelopeSchema,
  listRecipientsQuerySchema,
  recipientDtoSchema,
  RECIPIENT_STATUSES,
  segmentFilterSchema,
  sendBroadcastBodySchema,
  successSchema,
  updateBroadcastBodySchema,
  uuidSchema,
  variableMappingSchema,
  type BroadcastAudienceKind,
  type BroadcastStatus,
  type BroadcastVariant,
} from '@aligned/shared';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { recordAudit } from '../../lib/audit.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import {
  getBroadcastFanoutQueue,
  type BroadcastFanoutPayload,
} from '../../lib/queues.js';
import { buildContactWhereForSegment } from '../segments/segment-evaluator.js';

interface BroadcastRow {
  id: string;
  name: string;
  status: BroadcastStatus;
  channelId: string;
  audienceKind: BroadcastAudienceKind;
  csvAssetId: string | null;
  segmentId: string | null;
  abTest: boolean;
  variantATemplateId: string;
  variantBTemplateId: string | null;
  variantAVariables: unknown;
  variantBVariables: unknown;
  scheduledFor: Date | null;
  startedAt: Date | null;
  completedAt: Date | null;
  totalRecipients: number;
  queuedCount: number;
  sentCount: number;
  deliveredCount: number;
  readCount: number;
  failedCount: number;
  createdByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

function toDto(row: BroadcastRow) {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    channelId: row.channelId,
    audienceKind: row.audienceKind,
    csvAssetId: row.csvAssetId,
    segmentId: row.segmentId,
    abTest: row.abTest,
    variantATemplateId: row.variantATemplateId,
    variantBTemplateId: row.variantBTemplateId,
    variantAVariables: variableMappingSchema.parse(row.variantAVariables ?? {}),
    variantBVariables: row.variantBVariables
      ? variableMappingSchema.parse(row.variantBVariables)
      : null,
    scheduledFor: row.scheduledFor?.toISOString() ?? null,
    startedAt: row.startedAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
    totalRecipients: row.totalRecipients,
    queuedCount: row.queuedCount,
    sentCount: row.sentCount,
    deliveredCount: row.deliveredCount,
    readCount: row.readCount,
    failedCount: row.failedCount,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export default async function broadcastsRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  // ---------- GET /broadcasts -----------------------------------------------
  r.get(
    '/broadcasts',
    {
      schema: {
        tags: ['broadcasts'],
        summary: 'List broadcasts (newest first).',
        querystring: z.object({
          status: z
            .enum([
              'draft',
              'scheduled',
              'sending',
              'paused',
              'completed',
              'cancelled',
              'failed',
            ])
            .optional(),
          cursor: z.string().optional(),
          limit: z.coerce.number().int().min(1).max(100).default(25),
        }),
        response: { 200: listEnvelopeSchema(broadcastDtoSchema) },
      },
      preHandler: [app.requireRole('viewer')],
    },
    async (req) =>
      app.tenant(req, async (tx) => {
        const { status, cursor, limit } = req.query;
        const where: Record<string, unknown> = {};
        if (status) where.status = status;
        const rows = await tx.broadcast.findMany({
          where,
          take: limit + 1,
          ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        });
        const hasMore = rows.length > limit;
        const slice = hasMore ? rows.slice(0, limit) : rows;
        return {
          data: slice.map(toDto),
          nextCursor: hasMore ? (slice[slice.length - 1]?.id ?? null) : null,
        };
      }),
  );

  // ---------- GET /broadcasts/:id -------------------------------------------
  r.get(
    '/broadcasts/:id',
    {
      schema: {
        tags: ['broadcasts'],
        summary: 'Fetch a broadcast.',
        params: z.object({ id: uuidSchema }),
        response: { 200: itemEnvelopeSchema(broadcastDtoSchema) },
      },
      preHandler: [app.requireRole('viewer')],
    },
    async (req) =>
      app.tenant(req, async (tx) => {
        const row = await tx.broadcast.findUnique({ where: { id: req.params.id } });
        if (!row) throw notFound('Broadcast not found.');
        return { data: toDto(row) };
      }),
  );

  // ---------- POST /broadcasts ---------------------------------------------
  r.post(
    '/broadcasts',
    {
      schema: {
        tags: ['broadcasts'],
        summary: 'Create a draft broadcast.',
        body: createBroadcastBodySchema,
        response: { 201: itemEnvelopeSchema(broadcastDtoSchema) },
      },
      preHandler: [app.requireRole('editor')],
    },
    async (req, reply) => {
      const orgId = req.auth!.organizationId;
      const body = req.body;
      // Validate audience matches the kind.
      if (body.audienceKind === 'csv' && !body.csvAssetId) {
        throw badRequest(
          ApiErrorCode.VALIDATION_ERROR,
          'CSV audience requires csvAssetId.',
        );
      }
      if (body.audienceKind === 'segment' && !body.segmentId) {
        throw badRequest(
          ApiErrorCode.VALIDATION_ERROR,
          'Segment audience requires segmentId.',
        );
      }
      if (body.audienceKind === 'manual' && (!body.manualPhones || body.manualPhones.length === 0)) {
        throw badRequest(
          ApiErrorCode.VALIDATION_ERROR,
          'Manual audience requires at least one phone number.',
        );
      }
      if (body.abTest && !body.variantBTemplateId) {
        throw badRequest(
          ApiErrorCode.VALIDATION_ERROR,
          'A/B test requires variantBTemplateId.',
        );
      }

      const result = await app.tenant(req, async (tx) => {
        // Verify channel + templates belong to the org (RLS already enforces).
        const channel = await tx.whatsAppChannel.findUnique({ where: { id: body.channelId } });
        if (!channel) throw notFound('WhatsApp channel not found.');
        const tplA = await tx.whatsAppTemplate.findUnique({
          where: { id: body.variantATemplateId },
        });
        if (!tplA) throw notFound('Template A not found.');
        if (tplA.status !== 'approved') {
          throw badRequest(
            ApiErrorCode.VALIDATION_ERROR,
            `Template A is "${tplA.status}". Only approved templates can be sent.`,
          );
        }
        if (body.variantBTemplateId) {
          const tplB = await tx.whatsAppTemplate.findUnique({
            where: { id: body.variantBTemplateId },
          });
          if (!tplB) throw notFound('Template B not found.');
          if (tplB.status !== 'approved') {
            throw badRequest(
              ApiErrorCode.VALIDATION_ERROR,
              `Template B is "${tplB.status}". Only approved templates can be sent.`,
            );
          }
        }
        if (body.segmentId) {
          const seg = await tx.segment.findUnique({ where: { id: body.segmentId } });
          if (!seg) throw notFound('Segment not found.');
        }
        if (body.csvAssetId) {
          const asset = await tx.asset.findUnique({ where: { id: body.csvAssetId } });
          if (!asset) throw notFound('CSV asset not found.');
        }

        const created = await tx.broadcast.create({
          data: {
            organizationId: orgId,
            name: body.name,
            channelId: body.channelId,
            audienceKind: body.audienceKind,
            csvAssetId: body.csvAssetId ?? null,
            segmentId: body.segmentId ?? null,
            abTest: body.abTest,
            variantATemplateId: body.variantATemplateId,
            variantBTemplateId: body.variantBTemplateId ?? null,
            variantAVariables: (body.variantAVariables ?? {}) as never,
            variantBVariables: body.variantBVariables
              ? (body.variantBVariables as never)
              : undefined,
            createdByUserId: req.auth!.userId,
          },
        });

        // For manual audiences we materialize recipients up front so the user
        // can see the count immediately. CSV/segment recipients land at send
        // time inside the fanout worker.
        if (body.audienceKind === 'manual' && body.manualPhones) {
          const dedup = Array.from(new Set(body.manualPhones));
          await tx.broadcastRecipient.createMany({
            data: dedup.map((phone) => ({
              organizationId: orgId,
              broadcastId: created.id,
              phoneE164: phone,
              variant: assignVariant(phone, body.abTest),
            })),
            skipDuplicates: true,
          });
          await tx.broadcast.update({
            where: { id: created.id },
            data: { totalRecipients: dedup.length },
          });
          created.totalRecipients = dedup.length;
        }

        await tx.broadcastEvent.create({
          data: {
            organizationId: orgId,
            broadcastId: created.id,
            kind: 'created',
          },
        });
        return created;
      });

      await recordAudit({
        action: 'broadcast_created',
        organizationId: orgId,
        actorUserId: req.auth!.userId,
        entityType: 'broadcast',
        entityId: result.id,
      });
      reply.code(201);
      return { data: toDto(result) };
    },
  );

  // ---------- PATCH /broadcasts/:id ----------------------------------------
  r.patch(
    '/broadcasts/:id',
    {
      schema: {
        tags: ['broadcasts'],
        summary: 'Update a draft or scheduled broadcast.',
        params: z.object({ id: uuidSchema }),
        body: updateBroadcastBodySchema,
        response: { 200: itemEnvelopeSchema(broadcastDtoSchema) },
      },
      preHandler: [app.requireRole('editor')],
    },
    async (req) => {
      const orgId = req.auth!.organizationId;
      const id = req.params.id;
      const body = req.body;
      const result = await app.tenant(req, async (tx) => {
        const existing = await tx.broadcast.findUnique({ where: { id } });
        if (!existing) throw notFound('Broadcast not found.');
        if (existing.status !== 'draft' && existing.status !== 'scheduled') {
          throw conflict('Only draft or scheduled broadcasts can be edited.');
        }
        return tx.broadcast.update({
          where: { id },
          data: {
            name: body.name ?? undefined,
            channelId: body.channelId ?? undefined,
            audienceKind: body.audienceKind ?? undefined,
            csvAssetId: body.csvAssetId !== undefined ? body.csvAssetId : undefined,
            segmentId: body.segmentId !== undefined ? body.segmentId : undefined,
            abTest: body.abTest ?? undefined,
            variantATemplateId: body.variantATemplateId ?? undefined,
            variantBTemplateId:
              body.variantBTemplateId !== undefined ? body.variantBTemplateId : undefined,
            variantAVariables:
              body.variantAVariables !== undefined ? (body.variantAVariables as never) : undefined,
            variantBVariables:
              body.variantBVariables !== undefined
                ? (body.variantBVariables as never)
                : undefined,
          },
        });
      });
      await recordAudit({
        action: 'broadcast_updated',
        organizationId: orgId,
        actorUserId: req.auth!.userId,
        entityType: 'broadcast',
        entityId: id,
      });
      return { data: toDto(result) };
    },
  );

  // ---------- DELETE /broadcasts/:id ---------------------------------------
  r.delete(
    '/broadcasts/:id',
    {
      schema: {
        tags: ['broadcasts'],
        summary: 'Delete a draft broadcast (only drafts can be deleted).',
        params: z.object({ id: uuidSchema }),
        response: { 200: successSchema },
      },
      preHandler: [app.requireRole('admin')],
    },
    async (req) => {
      const id = req.params.id;
      await app.tenant(req, async (tx) => {
        const existing = await tx.broadcast.findUnique({ where: { id } });
        if (!existing) throw notFound('Broadcast not found.');
        if (existing.status !== 'draft') {
          throw conflict('Only drafts can be deleted. Cancel a sending broadcast instead.');
        }
        await tx.broadcast.delete({ where: { id } });
      });
      return { ok: true as const };
    },
  );

  // ---------- POST /broadcasts/:id/send ------------------------------------
  // Move from draft → scheduled (with delay) or sending (immediate).
  // Materializes recipients for segment/manual audiences synchronously.
  // CSV materialization happens inside the fanout worker (streaming).
  r.post(
    '/broadcasts/:id/send',
    {
      schema: {
        tags: ['broadcasts'],
        summary: 'Send the broadcast now or schedule it.',
        params: z.object({ id: uuidSchema }),
        body: sendBroadcastBodySchema,
        response: { 200: itemEnvelopeSchema(broadcastDtoSchema) },
      },
      preHandler: [app.requireRole('editor')],
    },
    async (req) => {
      const orgId = req.auth!.organizationId;
      const id = req.params.id;
      const scheduledForIso = req.body.scheduledFor ?? null;
      const scheduledFor = scheduledForIso ? new Date(scheduledForIso) : null;
      const isScheduled = scheduledFor !== null && scheduledFor.getTime() > Date.now() + 5_000;

      const result = await app.tenant(req, async (tx) => {
        const existing = await tx.broadcast.findUnique({ where: { id } });
        if (!existing) throw notFound('Broadcast not found.');
        if (existing.status !== 'draft' && existing.status !== 'scheduled') {
          throw conflict(`Cannot send a broadcast in status "${existing.status}".`);
        }

        // Materialize recipients for segment/manual now. CSV is deferred to
        // the fanout worker because the file may be large.
        if (existing.audienceKind === 'segment' && existing.segmentId) {
          const seg = await tx.segment.findUnique({ where: { id: existing.segmentId } });
          if (!seg) throw notFound('Segment no longer exists.');
          const where = buildContactWhereForSegment(segmentFilterSchema.parse(seg.filter));
          const contacts = await tx.contact.findMany({
            where,
            select: { id: true, phoneE164: true },
            take: 100_000,
          });
          if (contacts.length === 0) {
            throw badRequest(ApiErrorCode.VALIDATION_ERROR, 'Segment has no matching contacts.');
          }
          // Replace any existing pending recipients (e.g. previous schedule).
          await tx.broadcastRecipient.deleteMany({
            where: { broadcastId: id, status: 'pending' },
          });
          await tx.broadcastRecipient.createMany({
            data: contacts.map((c) => ({
              organizationId: orgId,
              broadcastId: id,
              contactId: c.id,
              phoneE164: c.phoneE164,
              variant: assignVariant(c.phoneE164, existing.abTest),
            })),
            skipDuplicates: true,
          });
          await tx.broadcast.update({
            where: { id },
            data: { totalRecipients: contacts.length },
          });
        } else if (existing.audienceKind === 'manual') {
          const count = await tx.broadcastRecipient.count({ where: { broadcastId: id } });
          if (count === 0) {
            throw badRequest(ApiErrorCode.VALIDATION_ERROR, 'No recipients on this broadcast.');
          }
          await tx.broadcast.update({
            where: { id },
            data: { totalRecipients: count },
          });
        }
        // CSV recipients land at fanout time.

        return tx.broadcast.update({
          where: { id },
          data: {
            status: isScheduled ? 'scheduled' : 'sending',
            scheduledFor: isScheduled ? scheduledFor : null,
            startedAt: isScheduled ? null : new Date(),
          },
        });
      });

      // Enqueue fanout. For scheduled, BullMQ delay handles the wait.
      const payload: BroadcastFanoutPayload = { organizationId: orgId, broadcastId: id };
      const delay = isScheduled && scheduledFor ? Math.max(0, scheduledFor.getTime() - Date.now()) : 0;
      await getBroadcastFanoutQueue().add('fanout', payload, {
        jobId: `broadcast:${id}`,
        delay,
        removeOnComplete: { age: 24 * 60 * 60 },
        removeOnFail: { age: 7 * 24 * 60 * 60 },
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
      });

      await app.tenant(req, (tx) =>
        tx.broadcastEvent.create({
          data: {
            organizationId: orgId,
            broadcastId: id,
            kind: isScheduled ? 'scheduled' : 'started',
            detail: scheduledForIso ? { scheduledFor: scheduledForIso } : undefined,
          },
        }),
      );

      await recordAudit({
        action: 'broadcast_sent',
        organizationId: orgId,
        actorUserId: req.auth!.userId,
        entityType: 'broadcast',
        entityId: id,
        metadata: { scheduledFor: scheduledForIso, isScheduled },
      });

      return { data: toDto(result) };
    },
  );

  // ---------- POST /broadcasts/:id/pause -----------------------------------
  r.post(
    '/broadcasts/:id/pause',
    {
      schema: {
        tags: ['broadcasts'],
        summary: 'Pause a sending broadcast (no new sends; in-flight finish).',
        params: z.object({ id: uuidSchema }),
        response: { 200: itemEnvelopeSchema(broadcastDtoSchema) },
      },
      preHandler: [app.requireRole('editor')],
    },
    async (req) => {
      const orgId = req.auth!.organizationId;
      const id = req.params.id;
      const result = await app.tenant(req, async (tx) => {
        const existing = await tx.broadcast.findUnique({ where: { id } });
        if (!existing) throw notFound('Broadcast not found.');
        if (existing.status !== 'sending' && existing.status !== 'scheduled') {
          throw conflict(`Cannot pause a broadcast in status "${existing.status}".`);
        }
        const updated = await tx.broadcast.update({
          where: { id },
          data: { status: 'paused' },
        });
        await tx.broadcastEvent.create({
          data: { organizationId: orgId, broadcastId: id, kind: 'paused' },
        });
        return updated;
      });
      await recordAudit({
        action: 'broadcast_paused',
        organizationId: orgId,
        actorUserId: req.auth!.userId,
        entityType: 'broadcast',
        entityId: id,
      });
      return { data: toDto(result) };
    },
  );

  // ---------- POST /broadcasts/:id/resume ----------------------------------
  r.post(
    '/broadcasts/:id/resume',
    {
      schema: {
        tags: ['broadcasts'],
        summary: 'Resume a paused broadcast.',
        params: z.object({ id: uuidSchema }),
        response: { 200: itemEnvelopeSchema(broadcastDtoSchema) },
      },
      preHandler: [app.requireRole('editor')],
    },
    async (req) => {
      const orgId = req.auth!.organizationId;
      const id = req.params.id;
      const result = await app.tenant(req, async (tx) => {
        const existing = await tx.broadcast.findUnique({ where: { id } });
        if (!existing) throw notFound('Broadcast not found.');
        if (existing.status !== 'paused') {
          throw conflict('Only paused broadcasts can be resumed.');
        }
        const updated = await tx.broadcast.update({
          where: { id },
          data: { status: 'sending' },
        });
        await tx.broadcastEvent.create({
          data: { organizationId: orgId, broadcastId: id, kind: 'resumed' },
        });
        return updated;
      });
      // Re-enqueue fanout (idempotent — it skips already-queued recipients).
      await getBroadcastFanoutQueue().add(
        'fanout',
        { organizationId: orgId, broadcastId: id },
        { jobId: `broadcast:${id}:resume:${Date.now()}` },
      );
      await recordAudit({
        action: 'broadcast_resumed',
        organizationId: orgId,
        actorUserId: req.auth!.userId,
        entityType: 'broadcast',
        entityId: id,
      });
      return { data: toDto(result) };
    },
  );

  // ---------- POST /broadcasts/:id/cancel ----------------------------------
  r.post(
    '/broadcasts/:id/cancel',
    {
      schema: {
        tags: ['broadcasts'],
        summary: 'Cancel a broadcast permanently. Pending recipients are skipped.',
        params: z.object({ id: uuidSchema }),
        response: { 200: itemEnvelopeSchema(broadcastDtoSchema) },
      },
      preHandler: [app.requireRole('editor')],
    },
    async (req) => {
      const orgId = req.auth!.organizationId;
      const id = req.params.id;
      const result = await app.tenant(req, async (tx) => {
        const existing = await tx.broadcast.findUnique({ where: { id } });
        if (!existing) throw notFound('Broadcast not found.');
        if (existing.status === 'completed' || existing.status === 'cancelled') {
          throw conflict(`Already ${existing.status}.`);
        }
        await tx.broadcastRecipient.updateMany({
          where: { broadcastId: id, status: 'pending' },
          data: { status: 'skipped' },
        });
        const updated = await tx.broadcast.update({
          where: { id },
          data: { status: 'cancelled', completedAt: new Date() },
        });
        await tx.broadcastEvent.create({
          data: { organizationId: orgId, broadcastId: id, kind: 'cancelled' },
        });
        return updated;
      });
      await recordAudit({
        action: 'broadcast_cancelled',
        organizationId: orgId,
        actorUserId: req.auth!.userId,
        entityType: 'broadcast',
        entityId: id,
      });
      return { data: toDto(result) };
    },
  );

  // ---------- GET /broadcasts/:id/recipients --------------------------------
  r.get(
    '/broadcasts/:id/recipients',
    {
      schema: {
        tags: ['broadcasts'],
        summary: 'List recipients for a broadcast.',
        params: z.object({ id: uuidSchema }),
        querystring: listRecipientsQuerySchema,
        response: { 200: listEnvelopeSchema(recipientDtoSchema) },
      },
      preHandler: [app.requireRole('viewer')],
    },
    async (req) =>
      app.tenant(req, async (tx) => {
        const id = req.params.id;
        const broadcast = await tx.broadcast.findUnique({ where: { id } });
        if (!broadcast) throw notFound('Broadcast not found.');
        const { status, cursor, limit } = req.query;
        const where: Record<string, unknown> = { broadcastId: id };
        if (status) where.status = status;
        const rows = await tx.broadcastRecipient.findMany({
          where,
          take: limit + 1,
          ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        });
        const hasMore = rows.length > limit;
        const slice = hasMore ? rows.slice(0, limit) : rows;
        return {
          data: slice.map((row) => ({
            id: row.id,
            phoneE164: row.phoneE164,
            contactId: row.contactId,
            variant: row.variant as BroadcastVariant,
            status: row.status,
            metaMessageId: row.metaMessageId,
            metaErrorCode: row.metaErrorCode,
            metaErrorMessage: row.metaErrorMessage,
            queuedAt: row.queuedAt?.toISOString() ?? null,
            sentAt: row.sentAt?.toISOString() ?? null,
            deliveredAt: row.deliveredAt?.toISOString() ?? null,
            readAt: row.readAt?.toISOString() ?? null,
            failedAt: row.failedAt?.toISOString() ?? null,
            attemptCount: row.attemptCount,
          })),
          nextCursor: hasMore ? (slice[slice.length - 1]?.id ?? null) : null,
        };
      }),
  );

  // ---------- GET /broadcasts/:id/timeline ----------------------------------
  r.get(
    '/broadcasts/:id/timeline',
    {
      schema: {
        tags: ['broadcasts'],
        summary: 'Get the campaign event timeline.',
        params: z.object({ id: uuidSchema }),
        response: { 200: listEnvelopeSchema(broadcastEventDtoSchema) },
      },
      preHandler: [app.requireRole('viewer')],
    },
    async (req) =>
      app.tenant(req, async (tx) => {
        const id = req.params.id;
        const broadcast = await tx.broadcast.findUnique({ where: { id } });
        if (!broadcast) throw notFound('Broadcast not found.');
        const events = await tx.broadcastEvent.findMany({
          where: { broadcastId: id },
          orderBy: { createdAt: 'asc' },
          take: 200,
        });
        return {
          data: events.map((e) => ({
            id: e.id,
            kind: e.kind,
            detail: e.detail ?? null,
            createdAt: e.createdAt.toISOString(),
          })),
          nextCursor: null,
        };
      }),
  );
}

// Deterministic A/B split (50/50 by phone hash). Returns 'A' if no A/B test.
function assignVariant(phone: string, abTest: boolean): BroadcastVariant {
  if (!abTest) return 'A';
  let h = 0;
  for (let i = 0; i < phone.length; i++) {
    h = (h * 31 + phone.charCodeAt(i)) | 0;
  }
  return Math.abs(h) % 2 === 0 ? 'A' : 'B';
}

// Re-export so the worker can import the same helper without duplicating logic.
export { assignVariant };

// Acknowledge unused imports (RECIPIENT_STATUSES used only for type narrowing).
void RECIPIENT_STATUSES;
