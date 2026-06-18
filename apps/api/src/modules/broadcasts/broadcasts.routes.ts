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
import { bumpUsage, capCheck } from '../../lib/billing.js';
import { env } from '../../lib/env.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';

// Same CORS workaround used by the inbox SSE — raw.writeHead bypasses
// @fastify/cors so we have to echo the allow-origin header manually.
function corsHeadersForSse(req: { headers: Record<string, string | string[] | undefined> }): Record<string, string> {
  const origin = (req.headers.origin as string | undefined) ?? '';
  const allowed = env.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean);
  const allowOrigin = allowed.includes(origin) ? origin : allowed[0] ?? '*';
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Credentials': 'true',
    Vary: 'Origin',
  };
}
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
  audienceTags: string[];
  audienceTagsMode: string;
  abTest: boolean;
  variantATemplateId: string;
  variantBTemplateId: string | null;
  variantAVariables: unknown;
  variantBVariables: unknown;
  scheduledFor: Date | null;
  startedAt: Date | null;
  completedAt: Date | null;
  sendWindowStartHour: number | null;
  sendWindowEndHour: number | null;
  sendWindowTimezone: string | null;
  abWinnerStrategy: string | null;
  abWinnerVariant: BroadcastVariant | null;
  abWinnerDecidedAt: Date | null;
  totalRecipients: number;
  queuedCount: number;
  sentCount: number;
  deliveredCount: number;
  readCount: number;
  failedCount: number;
  respondedCount: number;
  createdByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

// Variable maps stored in the DB are JSON. They CAN drift from the current
// Zod schema (older drafts, partial migrations, hand-edits). Strict
// .parse() would throw a 500 and block the whole detail page. safeParse
// + fallback to {} keeps the response valid and lets the broadcast load.
type VariableMap = ReturnType<(typeof variableMappingSchema)['parse']>;
function safeVariableMap(raw: unknown): VariableMap {
  const parsed = variableMappingSchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : ({} as VariableMap);
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
    audienceTags: row.audienceTags ?? [],
    audienceTagsMode: ((row.audienceTagsMode ?? 'any') as 'any' | 'all'),
    abTest: row.abTest,
    variantATemplateId: row.variantATemplateId,
    variantBTemplateId: row.variantBTemplateId,
    variantAVariables: safeVariableMap(row.variantAVariables),
    variantBVariables: row.variantBVariables ? safeVariableMap(row.variantBVariables) : null,
    scheduledFor: row.scheduledFor?.toISOString() ?? null,
    startedAt: row.startedAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
    sendWindowStartHour: row.sendWindowStartHour,
    sendWindowEndHour: row.sendWindowEndHour,
    sendWindowTimezone: row.sendWindowTimezone,
    abWinnerStrategy: row.abWinnerStrategy,
    abWinnerVariant: row.abWinnerVariant,
    abWinnerDecidedAt: row.abWinnerDecidedAt?.toISOString() ?? null,
    totalRecipients: row.totalRecipients,
    queuedCount: row.queuedCount,
    sentCount: row.sentCount,
    deliveredCount: row.deliveredCount,
    readCount: row.readCount,
    failedCount: row.failedCount,
    respondedCount: row.respondedCount,
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
      if (body.audienceKind === 'tags' && (!body.audienceTags || body.audienceTags.length === 0)) {
        throw badRequest(
          ApiErrorCode.VALIDATION_ERROR,
          'Tag audience requires at least one tag.',
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

        const normalizedTags =
          body.audienceKind === 'tags' && body.audienceTags
            ? Array.from(new Set(body.audienceTags.map((t) => t.trim().toLowerCase()))).filter((t) => t.length > 0)
            : [];
        const created = await tx.broadcast.create({
          data: {
            organizationId: orgId,
            name: body.name,
            channelId: body.channelId,
            audienceKind: body.audienceKind,
            csvAssetId: body.csvAssetId ?? null,
            segmentId: body.segmentId ?? null,
            audienceTags: normalizedTags,
            audienceTagsMode: body.audienceTagsMode ?? 'any',
            abTest: body.abTest,
            variantATemplateId: body.variantATemplateId,
            variantBTemplateId: body.variantBTemplateId ?? null,
            variantAVariables: (body.variantAVariables ?? {}) as never,
            variantBVariables: body.variantBVariables
              ? (body.variantBVariables as never)
              : undefined,
            sendWindowStartHour: body.sendWindowStartHour ?? null,
            sendWindowEndHour: body.sendWindowEndHour ?? null,
            sendWindowTimezone: body.sendWindowTimezone ?? null,
            abWinnerStrategy: body.abWinnerStrategy ?? null,
            createdByUserId: req.auth!.userId,
          },
        });

        // For manual audiences we materialize recipients up front so the user
        // can see the count immediately. CSV/segment recipients land at send
        // time inside the fanout worker.
        if (body.audienceKind === 'manual' && body.manualPhones) {
          const dedup = Array.from(new Set(body.manualPhones));
          // Soft cap — refuse manual audiences over the per-org limit
          // (default 50K). CSV / segment audiences go through fanout where
          // the limit is enforced by Meta-side rate caps in practice.
          const SOFT_CAP = Number(process.env.BROADCAST_MAX_RECIPIENTS ?? 50_000);
          if (dedup.length > SOFT_CAP) {
            throw badRequest(
              ApiErrorCode.VALIDATION_ERROR,
              `Manual audience exceeds the per-broadcast cap of ${SOFT_CAP.toLocaleString()} recipients. Use a CSV or segment for larger sends.`,
            );
          }
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
  // Deletes a broadcast in any status. If the broadcast is currently
  // sending or scheduled, the BullMQ fanout job is also removed so it
  // doesn't wake up to a deleted row. Cascade on broadcastRecipients +
  // broadcastEvents drops every child row in one go.
  r.delete(
    '/broadcasts/:id',
    {
      schema: {
        tags: ['broadcasts'],
        summary: 'Delete a broadcast and all its recipients + timeline events.',
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
        await tx.broadcast.delete({ where: { id } });
      });
      // Best-effort: remove any still-pending fanout job for this broadcast.
      // If it has already fired or doesn't exist, BullMQ returns 0 — harmless.
      try {
        const job = await getBroadcastFanoutQueue().getJob(`broadcast-${id}`);
        if (job) await job.remove();
      } catch (err) {
        req.log.warn({ err, id }, '[broadcasts] failed to remove fanout job on delete');
      }
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

      // Top-level log line for every send attempt. Pairs with the
      // pino-prettied error below if anything throws — makes it
      // possible to grep the systemd journal for /send 500s without
      // hunting for the cause across multiple log entries.
      req.log.info({ id, orgId, isScheduled, scheduledForIso }, '[broadcasts] /send begin');

      try {
      const result = await app.tenant(req, async (tx) => {
        const existing = await tx.broadcast.findUnique({ where: { id } });
        if (!existing) throw notFound('Broadcast not found.');
        if (existing.status !== 'draft' && existing.status !== 'scheduled') {
          throw conflict(`Cannot send a broadcast in status "${existing.status}".`);
        }

        // Plan cap: starting (or scheduling) a campaign consumes one
        // unit of the org's monthly broadcast quota. Sending a draft
        // that was already scheduled doesn't re-consume — the bumpUsage
        // call below is gated on the previous status being `draft`.
        if (existing.status === 'draft') {
          await capCheck(tx as never, orgId, 'monthly_broadcast', {
            actorIsAlignedAdmin: req.auth!.isAlignedAdmin,
          });
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
        } else if (existing.audienceKind === 'tags' && existing.audienceTags && existing.audienceTags.length > 0) {
          // Resolve tagged contacts. 'any' = OR (contact has at least one of
          // the chosen tags); 'all' = AND (contact has every chosen tag).
          // The contact_tags table stores one (contactId, tag) row per
          // assignment, so AND is just a count(distinct tag) match.
          const tagList = existing.audienceTags;
          const isAll = existing.audienceTagsMode === 'all';
          let contactIds: string[];
          if (isAll) {
            const rows = await tx.contactTag.groupBy({
              by: ['contactId'],
              where: { tag: { in: tagList } },
              _count: { tag: true },
              having: { tag: { _count: { equals: tagList.length } } },
            });
            contactIds = rows.map((r) => r.contactId);
          } else {
            const rows = await tx.contactTag.findMany({
              where: { tag: { in: tagList } },
              select: { contactId: true },
              distinct: ['contactId'],
            });
            contactIds = rows.map((r) => r.contactId);
          }
          if (contactIds.length === 0) {
            throw badRequest(
              ApiErrorCode.VALIDATION_ERROR,
              isAll
                ? 'No contacts carry every selected tag.'
                : 'No contacts carry any of the selected tags.',
            );
          }
          const contacts = await tx.contact.findMany({
            where: { id: { in: contactIds }, deletedAt: null },
            select: { id: true, phoneE164: true },
            take: 100_000,
          });
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
        }
        // CSV recipients land at fanout time.

        const updated = await tx.broadcast.update({
          where: { id },
          data: {
            status: isScheduled ? 'scheduled' : 'sending',
            scheduledFor: isScheduled ? scheduledFor : null,
            startedAt: isScheduled ? null : new Date(),
          },
        });
        // First-time send (draft → scheduled/sending) counts against the
        // monthly broadcast cap. Returning a flag so the caller can
        // bumpUsage outside the tenant transaction.
        return { broadcast: updated, fromDraft: existing.status === 'draft' };
      });

      // Enqueue fanout. For scheduled, BullMQ delay handles the wait.
      // Re-send semantics: if a job already exists for this broadcast
      // (e.g. user clicked Send twice, or re-scheduled), remove the
      // existing job before adding the new one. BullMQ throws on a
      // duplicate jobId otherwise, which previously surfaced as a 500.
      const fanoutQueue = getBroadcastFanoutQueue();
      const jobId = `broadcast-${id}`;
      const existingJob = await fanoutQueue.getJob(jobId).catch(() => null);
      if (existingJob) {
        await existingJob.remove().catch((err) =>
          req.log.warn({ err, jobId }, '[broadcasts] failed to remove stale fanout job'),
        );
      }
      const payload: BroadcastFanoutPayload = { organizationId: orgId, broadcastId: id };
      const delay = isScheduled && scheduledFor ? Math.max(0, scheduledFor.getTime() - Date.now()) : 0;
      await fanoutQueue.add('fanout', payload, {
        jobId,
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

      if (result.fromDraft) {
        const { prisma } = await import('../../lib/db.js');
        void bumpUsage(prisma as never, orgId, 'broadcast_started');
      }

      return { data: toDto(result.broadcast) };
      } catch (err) {
        // Surface the real cause in logs so future 500s on /send aren't
        // a black box. HttpErrors (4xx) re-throw as-is — Fastify's
        // errorHandler already serialises those. Anything else gets a
        // detailed log line so a future 500 is grep-able by request id.
        const isHttpError =
          !!err &&
          typeof err === 'object' &&
          'statusCode' in err &&
          typeof (err as { statusCode?: unknown }).statusCode === 'number';
        if (isHttpError) throw err;
        req.log.error(
          {
            id,
            orgId,
            err: err instanceof Error ? { message: err.message, stack: err.stack } : err,
          },
          '[broadcasts] /send 500 — unexpected error',
        );
        throw err;
      }
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
      req.log.info({ id, orgId }, '[broadcasts] /pause begin');
      try {
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
      } catch (err) {
        req.log.error(
          {
            id,
            orgId,
            err: err instanceof Error ? { name: err.name, message: err.message, stack: err.stack } : err,
          },
          '[broadcasts] /pause failed',
        );
        throw err;
      }
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
      req.log.info({ id, orgId }, '[broadcasts] /resume begin');
      try {
        const result = await app.tenant(req, async (tx) => {
          const existing = await tx.broadcast.findUnique({ where: { id } });
          if (!existing) throw notFound('Broadcast not found.');
          if (existing.status !== 'paused') {
            throw conflict(
              `Only paused broadcasts can be resumed. This one is "${existing.status}".`,
            );
          }
          // Phase 5.1 left old paused broadcasts with recipients flipped to
          // 'skipped' (the obsolete behaviour). Resume should bring those
          // back so the fanout has something to do.
          await tx.broadcastRecipient.updateMany({
            where: { broadcastId: id, status: 'skipped' },
            data: { status: 'pending', failedAt: null },
          });
          const updated = await tx.broadcast.update({
            where: { id },
            data: { status: 'sending' },
          });
          await tx.broadcastEvent.create({
            data: { organizationId: orgId, broadcastId: id, kind: 'resumed' },
          });
          return updated;
        });
        // Re-enqueue fanout with a unique jobId so we never collide with
        // a still-locked job. The fanout worker is idempotent — it
        // re-scans pending/queued recipients and adds send jobs for them,
        // so running it twice is safe.
        await getBroadcastFanoutQueue().add(
          'fanout',
          { organizationId: orgId, broadcastId: id },
          { jobId: `broadcast-${id}-resume-${Date.now()}` },
        );
        await recordAudit({
          action: 'broadcast_resumed',
          organizationId: orgId,
          actorUserId: req.auth!.userId,
          entityType: 'broadcast',
          entityId: id,
        });
        req.log.info({ id, orgId }, '[broadcasts] /resume ok');
        return { data: toDto(result) };
      } catch (err) {
        // Surface the actual cause in logs (with broadcast id + stack)
        // so any future 500 here is diagnosable from journalctl alone.
        req.log.error(
          {
            id,
            orgId,
            err: err instanceof Error ? { name: err.name, message: err.message, stack: err.stack } : err,
          },
          '[broadcasts] /resume failed',
        );
        throw err;
      }
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
      req.log.info({ id, orgId }, '[broadcasts] /cancel begin');
      try {
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
        // Best-effort: remove any still-delayed fanout job. If it has already
        // fired or doesn't exist, BullMQ returns 0 — harmless.
        try {
          const job = await getBroadcastFanoutQueue().getJob(`broadcast-${id}`);
          if (job) await job.remove();
        } catch (err) {
          req.log.warn({ err, id }, '[broadcasts] failed to remove delayed fanout job');
        }
        await recordAudit({
          action: 'broadcast_cancelled',
          organizationId: orgId,
          actorUserId: req.auth!.userId,
          entityType: 'broadcast',
          entityId: id,
        });
        return { data: toDto(result) };
      } catch (err) {
        req.log.error(
          {
            id,
            orgId,
            err: err instanceof Error ? { name: err.name, message: err.message, stack: err.stack } : err,
          },
          '[broadcasts] /cancel failed',
        );
        throw err;
      }
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

  // ---------- GET /broadcasts/:id/analytics ---------------------------------
  // Campaign analytics: the delivery funnel + rates, how many recipients
  // REPLIED (computed from inbound messages after their send), opt-outs, a
  // failure-reason breakdown, and an A/B variant comparison.
  r.get(
    '/broadcasts/:id/analytics',
    {
      schema: {
        tags: ['broadcasts'],
        summary: 'Campaign analytics: funnel, rates, responses, failures, A/B.',
        params: z.object({ id: uuidSchema }),
        response: {
          200: z.object({
            data: z.object({
              funnel: z.object({
                total: z.number(),
                sent: z.number(),
                delivered: z.number(),
                read: z.number(),
                failed: z.number(),
                skipped: z.number(),
                pending: z.number(),
                responded: z.number(),
              }),
              rates: z.object({
                deliveryRate: z.number(),
                readRate: z.number(),
                responseRate: z.number(),
                failureRate: z.number(),
              }),
              optedOut: z.number(),
              failureBreakdown: z.array(
                z.object({ code: z.string(), message: z.string().nullable(), count: z.number() }),
              ),
              variants: z.array(
                z.object({
                  variant: z.string(),
                  recipients: z.number(),
                  delivered: z.number(),
                  read: z.number(),
                  responded: z.number(),
                }),
              ),
              timing: z.object({
                startedAt: z.string().nullable(),
                completedAt: z.string().nullable(),
                durationMs: z.number().nullable(),
              }),
            }),
          }),
        },
      },
      preHandler: [app.requireRole('viewer')],
    },
    async (req) =>
      app.tenant(req, async (tx) => {
        const id = req.params.id;
        const broadcast = await tx.broadcast.findUnique({ where: { id } });
        if (!broadcast) throw notFound('Broadcast not found.');
        const since = broadcast.startedAt ?? broadcast.createdAt;

        // Recipients (phone + send time + variant) drive both the funnel and the
        // reply match. Capped at the send ceiling so this stays bounded.
        const recipients = await tx.broadcastRecipient.findMany({
          where: { broadcastId: id },
          select: {
            phoneE164: true,
            sentAt: true,
            status: true,
            variant: true,
            contactId: true,
            respondedAt: true,
          },
          take: 50000,
        });

        // Funnel — cumulative: a 'read' recipient also reached delivered + sent.
        const reached = { sent: 0, delivered: 0, read: 0, failed: 0, skipped: 0, pending: 0 };
        for (const r of recipients) {
          if (r.status === 'read') {
            reached.read++;
            reached.delivered++;
            reached.sent++;
          } else if (r.status === 'delivered') {
            reached.delivered++;
            reached.sent++;
          } else if (r.status === 'sent') {
            reached.sent++;
          } else if (r.status === 'failed') reached.failed++;
          else if (r.status === 'skipped') reached.skipped++;
          else reached.pending++; // pending | queued
        }

        // Replies are attributed at inbound time (lib/broadcast-response.ts),
        // stored on the recipient row — just count them here.
        const responded = recipients.filter((r) => r.respondedAt != null).length;

        // Opt-outs among recipients after the send started.
        const contactIds = recipients.map((r) => r.contactId).filter((x): x is string => !!x);
        const optedOut = contactIds.length
          ? await tx.contact.count({
              where: { id: { in: contactIds }, optedOutAt: { gte: since } },
            })
          : 0;

        // Failure reasons.
        const failGroups = await tx.broadcastRecipient.groupBy({
          by: ['metaErrorCode'],
          where: { broadcastId: id, status: 'failed' },
          _count: { _all: true },
        });
        const failureBreakdown = await Promise.all(
          failGroups
            .sort((a, b) => b._count._all - a._count._all)
            .slice(0, 10)
            .map(async (g) => {
              const sample = await tx.broadcastRecipient.findFirst({
                where: { broadcastId: id, status: 'failed', metaErrorCode: g.metaErrorCode },
                select: { metaErrorMessage: true },
              });
              return {
                code: g.metaErrorCode ?? 'unknown',
                message: sample?.metaErrorMessage ?? null,
                count: g._count._all,
              };
            }),
        );

        // A/B variant comparison.
        const variantList = broadcast.abTest ? (['A', 'B'] as const) : (['A'] as const);
        const variants = variantList.map((v) => {
          const rs = recipients.filter((r) => r.variant === v);
          const delivered = rs.filter((r) => r.status === 'delivered' || r.status === 'read').length;
          const read = rs.filter((r) => r.status === 'read').length;
          return {
            variant: v,
            recipients: rs.length,
            delivered,
            read,
            responded: rs.filter((r) => r.respondedAt != null).length,
          };
        });

        const total = recipients.length;
        const pct = (num: number, den: number) => (den > 0 ? Math.round((num / den) * 1000) / 1000 : 0);
        return {
          data: {
            funnel: {
              total,
              sent: reached.sent,
              delivered: reached.delivered,
              read: reached.read,
              failed: reached.failed,
              skipped: reached.skipped,
              pending: reached.pending,
              responded,
            },
            rates: {
              deliveryRate: pct(reached.delivered, reached.sent),
              readRate: pct(reached.read, reached.delivered),
              responseRate: pct(responded, reached.delivered),
              failureRate: pct(reached.failed, total),
            },
            optedOut,
            failureBreakdown,
            variants,
            timing: {
              startedAt: broadcast.startedAt?.toISOString() ?? null,
              completedAt: broadcast.completedAt?.toISOString() ?? null,
              durationMs:
                broadcast.startedAt && broadcast.completedAt
                  ? broadcast.completedAt.getTime() - broadcast.startedAt.getTime()
                  : null,
            },
          },
        };
      }),
  );

  // ---------- GET /broadcasts/:id/recipients.csv ----------------------------
  // Streams a CSV of every recipient with status + Meta error codes for
  // operator triage. No pagination — even 100K rows is small enough to ship
  // in one request, and the worker is the bottleneck not this download.
  r.get(
    '/broadcasts/:id/recipients.csv',
    {
      schema: {
        tags: ['broadcasts'],
        summary: 'Export all recipients with status + error codes as CSV.',
        params: z.object({ id: uuidSchema }),
      },
      preHandler: [app.requireRole('viewer')],
    },
    async (req, reply) => {
      const id = req.params.id;
      const orgId = req.auth!.organizationId;
      const broadcast = await app.tenant(req, (tx) =>
        tx.broadcast.findUnique({ where: { id } }),
      );
      if (!broadcast) throw notFound('Broadcast not found.');

      reply.header('Content-Type', 'text/csv; charset=utf-8');
      reply.header(
        'Content-Disposition',
        `attachment; filename="broadcast-${id.slice(0, 8)}-recipients.csv"`,
      );
      const escape = (v: string | null | undefined) => {
        if (v == null) return '';
        const s = String(v);
        if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
        return s;
      };
      const lines: string[] = [
        'phone_e164,variant,status,meta_message_id,meta_error_code,meta_error_message,sent_at,delivered_at,read_at,failed_at,attempt_count',
      ];
      // Page through to avoid loading 100K+ rows in one go.
      let cursor: string | undefined;
      while (true) {
        const batch = await app.tenant(req, (tx) =>
          tx.broadcastRecipient.findMany({
            where: { broadcastId: id, organizationId: orgId },
            take: 1000,
            ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
            orderBy: { id: 'asc' },
          }),
        );
        if (batch.length === 0) break;
        for (const r of batch) {
          lines.push(
            [
              escape(r.phoneE164),
              escape(r.variant),
              escape(r.status),
              escape(r.metaMessageId),
              escape(r.metaErrorCode),
              escape(r.metaErrorMessage),
              escape(r.sentAt?.toISOString() ?? null),
              escape(r.deliveredAt?.toISOString() ?? null),
              escape(r.readAt?.toISOString() ?? null),
              escape(r.failedAt?.toISOString() ?? null),
              String(r.attemptCount),
            ].join(','),
          );
        }
        if (batch.length < 1000) break;
        cursor = batch[batch.length - 1]!.id;
      }
      return reply.send(lines.join('\n'));
    },
  );

  // ---------- POST /broadcasts/:id/rerun-failed ------------------------------
  // Re-queue all `failed` recipients of a completed (or paused) broadcast.
  // Resets their state to `pending`, clears error fields, re-enqueues fanout.
  // Useful after fixing a template / token issue.
  r.post(
    '/broadcasts/:id/rerun-failed',
    {
      schema: {
        tags: ['broadcasts'],
        summary: 'Re-queue all failed recipients of this broadcast.',
        params: z.object({ id: uuidSchema }),
        response: {
          200: z.object({ data: z.object({ requeued: z.number().int().nonnegative() }) }),
        },
      },
      preHandler: [app.requireRole('editor')],
    },
    async (req) => {
      const orgId = req.auth!.organizationId;
      const id = req.params.id;
      const requeued = await app.tenant(req, async (tx) => {
        const existing = await tx.broadcast.findUnique({ where: { id } });
        if (!existing) throw notFound('Broadcast not found.');
        if (existing.status === 'cancelled') {
          throw conflict('Cannot re-run a cancelled broadcast. Clone it instead.');
        }
        const updated = await tx.broadcastRecipient.updateMany({
          where: { broadcastId: id, status: 'failed' },
          data: {
            status: 'pending',
            metaErrorCode: null,
            metaErrorMessage: null,
            failedAt: null,
            attemptCount: 0,
          },
        });
        if (updated.count > 0) {
          await tx.broadcast.update({
            where: { id },
            data: {
              status: 'sending',
              failedCount: { decrement: updated.count },
              completedAt: null,
            },
          });
          await tx.broadcastEvent.create({
            data: {
              organizationId: orgId,
              broadcastId: id,
              kind: 'resumed',
              detail: { reason: 'rerun-failed', requeued: updated.count },
            },
          });
        }
        return updated.count;
      });
      if (requeued > 0) {
        await getBroadcastFanoutQueue().add(
          'fanout',
          { organizationId: orgId, broadcastId: id },
          { jobId: `broadcast-${id}-rerun-${Date.now()}` },
        );
      }
      return { data: { requeued } };
    },
  );

  // ---------- POST /broadcasts/:id/resend ----------------------------------
  // Clone a broadcast and immediately send it to the same recipients.
  // Used from the detail page to fire the exact same template + audience
  // again as a fresh campaign — keeps the original's history intact so
  // the resend shows up as its own row.
  r.post(
    '/broadcasts/:id/resend',
    {
      schema: {
        tags: ['broadcasts'],
        summary: 'Clone this broadcast + immediately send to the same recipients.',
        params: z.object({ id: uuidSchema }),
        response: { 201: itemEnvelopeSchema(broadcastDtoSchema) },
      },
      preHandler: [app.requireRole('editor')],
    },
    async (req, reply) => {
      const orgId = req.auth!.organizationId;
      const id = req.params.id;
      req.log.info({ id, orgId }, '[broadcasts] /resend begin');
      try {
        const created = await app.tenant(req, async (tx) => {
          const source = await tx.broadcast.findUnique({ where: { id } });
          if (!source) throw notFound('Broadcast not found.');

          // A resend is a brand-new campaign — counts against the
          // monthly broadcast quota just like /send does for drafts.
          await capCheck(tx as never, orgId, 'monthly_broadcast', {
            actorIsAlignedAdmin: req.auth!.isAlignedAdmin,
          });
          // Collect every recipient phone except the ones we deliberately
          // suppressed (opted-out, deleted, skipped). Failed recipients are
          // included — the underlying issue may have been transient.
          const recipients = await tx.broadcastRecipient.findMany({
            where: { broadcastId: id, NOT: { status: 'skipped' } },
            select: { phoneE164: true, contactId: true, variables: true, variant: true },
          });
          if (recipients.length === 0) {
            throw badRequest(
              ApiErrorCode.VALIDATION_ERROR,
              'Original broadcast has no recipients to resend to.',
            );
          }
          // Verify channel + template are still usable.
          const template = await tx.whatsAppTemplate.findUnique({
            where: { id: source.variantATemplateId },
          });
          if (!template || template.status !== 'approved') {
            throw badRequest(
              ApiErrorCode.VALIDATION_ERROR,
              'Template is no longer approved — submit/approve before resending.',
            );
          }
          // Build a unique name. "<original> (resend)" or with a counter
          // suffix if the name is already taken (unique within org).
          let name = `${source.name} (resend)`;
          let dup = await tx.broadcast
            .findFirst({ where: { organizationId: orgId, name } })
            .catch(() => null);
          let suffix = 2;
          while (dup) {
            name = `${source.name} (resend ${suffix})`;
            dup = await tx.broadcast
              .findFirst({ where: { organizationId: orgId, name } })
              .catch(() => null);
            suffix += 1;
            if (suffix > 50) break; // guard
          }

          const fresh = await tx.broadcast.create({
            data: {
              organizationId: orgId,
              name,
              status: 'sending',
              channelId: source.channelId,
              audienceKind: 'manual',
              abTest: source.abTest,
              variantATemplateId: source.variantATemplateId,
              variantBTemplateId: source.variantBTemplateId,
              variantAVariables: source.variantAVariables as never,
              variantBVariables: source.variantBVariables as never,
              sendWindowStartHour: source.sendWindowStartHour,
              sendWindowEndHour: source.sendWindowEndHour,
              sendWindowTimezone: source.sendWindowTimezone,
              abWinnerStrategy: source.abWinnerStrategy,
              createdByUserId: req.auth!.userId,
              startedAt: new Date(),
              totalRecipients: recipients.length,
            },
          });
          // Carry the resolved variables + variant over so the worker
          // doesn't have to re-derive them from contact attributes.
          await tx.broadcastRecipient.createMany({
            data: recipients.map((r) => ({
              organizationId: orgId,
              broadcastId: fresh.id,
              contactId: r.contactId,
              phoneE164: r.phoneE164,
              variant: r.variant,
              variables: r.variables as never,
            })),
            skipDuplicates: true,
          });
          await tx.broadcastEvent.create({
            data: {
              organizationId: orgId,
              broadcastId: fresh.id,
              kind: 'created',
              detail: { resendOf: source.id },
            },
          });
          return fresh;
        });

        // Enqueue fanout (unique jobId so we never collide).
        await getBroadcastFanoutQueue().add(
          'fanout',
          { organizationId: orgId, broadcastId: created.id },
          { jobId: `broadcast-${created.id}-resend-${Date.now()}` },
        );

        await recordAudit({
          action: 'broadcast_sent',
          organizationId: orgId,
          actorUserId: req.auth!.userId,
          entityType: 'broadcast',
          entityId: created.id,
          metadata: { resendOf: id },
        });

        const { prisma } = await import('../../lib/db.js');
        void bumpUsage(prisma as never, orgId, 'broadcast_started');

        reply.code(201);
        return { data: toDto(created) };
      } catch (err) {
        req.log.error(
          {
            id,
            orgId,
            err: err instanceof Error ? { name: err.name, message: err.message, stack: err.stack } : err,
          },
          '[broadcasts] /resend failed',
        );
        throw err;
      }
    },
  );

  // ---------- GET /broadcasts/:id/sse --------------------------------------
  // Tick every 2 seconds with a "refetch" signal. The detail page in the web
  // app turns this into React Query invalidation so counters/recipients/timeline
  // refresh sub-second. Cheap; no real-time payload — just a poke.
  r.get(
    '/broadcasts/:id/sse',
    {
      schema: {
        tags: ['broadcasts'],
        summary: 'SSE: emits a tick every 2s telling the UI to refetch.',
        params: z.object({ id: uuidSchema }),
      },
      preHandler: [app.requireRole('viewer')],
    },
    async (req, reply) => {
      const id = req.params.id;
      // Confirm access (RLS would block; this gives a clean 404).
      const exists = await app.tenant(req, (tx) =>
        tx.broadcast.findUnique({ where: { id }, select: { id: true } }),
      );
      if (!exists) throw notFound('Broadcast not found.');
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
        ...corsHeadersForSse(req),
      });
      reply.raw.write(`retry: 5000\n\n`);
      reply.raw.write(`event: hello\ndata: ${JSON.stringify({ id })}\n\n`);
      const interval = setInterval(() => {
        try {
          reply.raw.write(`event: tick\ndata: ${JSON.stringify({ ts: Date.now() })}\n\n`);
        } catch {
          /* socket closed */
        }
      }, 2000);
      const cleanup = () => {
        clearInterval(interval);
        try {
          reply.raw.end();
        } catch {
          /* noop */
        }
      };
      req.raw.on('close', cleanup);
      req.raw.on('error', cleanup);
      return reply;
    },
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
