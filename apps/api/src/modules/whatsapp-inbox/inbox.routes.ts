// Phase 3 §5.1.1 — Conversation inbox routes.
//
// Replaces the legacy phone-keyed thread endpoints in whatsapp.routes.ts
// with id-keyed routes that support status, tags, assignment, internal
// notes, search, and bot-to-human handoff.
//
// All endpoints are tenant-scoped via app.tenant + RLS. Internal notes
// are persisted in the `whatsapp_notes` table, not `whatsapp_messages`,
// so they NEVER appear in the chatbot read API or in any outbound surface.
import { ApiErrorCode, listEnvelopeSchema, successSchema, uuidSchema } from '@aligned/shared';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { recordAudit } from '../../lib/audit.js';
import { badRequest, notFound } from '../../lib/errors.js';

const threadStatusSchema = z.enum(['open', 'pending', 'resolved', 'escalated']);

const threadDtoSchema = z.object({
  id: uuidSchema,
  customerPhone: z.string(),
  customerName: z.string().nullable(),
  status: threadStatusSchema,
  assignedToUserId: uuidSchema.nullable(),
  assignedToName: z.string().nullable(),
  lastMessageAt: z.string().datetime(),
  lastMessagePreview: z.string().nullable(),
  inboundCount: z.number().int(),
  outboundCount: z.number().int(),
  tags: z.array(z.string()),
  noteCount: z.number().int(),
  createdAt: z.string().datetime(),
});

const messageDtoSchema = z.object({
  id: uuidSchema,
  direction: z.enum(['inbound', 'outbound']),
  metaMessageId: z.string().nullable(),
  fromNumber: z.string().nullable(),
  toNumber: z.string().nullable(),
  messageType: z.string().nullable(),
  body: z.string().nullable(),
  receivedAt: z.string().datetime(),
});

const noteDtoSchema = z.object({
  id: uuidSchema,
  authorUserId: uuidSchema.nullable(),
  authorName: z.string().nullable(),
  authorEmail: z.string().nullable(),
  body: z.string(),
  createdAt: z.string().datetime(),
});

const cannedResponseDtoSchema = z.object({
  id: uuidSchema,
  shortcut: z.string(),
  body: z.string(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

// Helper — pull the joined fields the UI needs for a thread row.
function serializeThread(t: {
  id: string;
  customerPhone: string;
  customerName: string | null;
  status: string;
  assignedToUserId: string | null;
  lastMessageAt: Date;
  lastMessagePreview: string | null;
  inboundCount: number;
  outboundCount: number;
  createdAt: Date;
  assignedTo?: { firstName: string | null; lastName: string | null; email: string } | null;
  tags?: { tag: string }[];
  _count?: { notes: number };
}) {
  return {
    id: t.id,
    customerPhone: t.customerPhone,
    customerName: t.customerName,
    status: t.status as z.infer<typeof threadStatusSchema>,
    assignedToUserId: t.assignedToUserId,
    assignedToName:
      t.assignedTo
        ? [t.assignedTo.firstName, t.assignedTo.lastName].filter(Boolean).join(' ') ||
          t.assignedTo.email
        : null,
    lastMessageAt: t.lastMessageAt.toISOString(),
    lastMessagePreview: t.lastMessagePreview,
    inboundCount: t.inboundCount,
    outboundCount: t.outboundCount,
    tags: (t.tags ?? []).map((tg) => tg.tag),
    noteCount: t._count?.notes ?? 0,
    createdAt: t.createdAt.toISOString(),
  };
}

export default async function inboxRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  // ===================================================================
  // THREADS
  // ===================================================================

  // ---------- GET /inbox/threads ---------------------------------------
  r.get(
    '/inbox/threads',
    {
      schema: {
        tags: ['inbox'],
        summary: 'List conversation threads with filters.',
        querystring: z.object({
          q: z.string().trim().optional(),
          status: threadStatusSchema.optional(),
          tag: z.string().trim().optional(),
          assignee: uuidSchema.optional(),
          limit: z.coerce.number().int().min(1).max(200).default(50),
        }),
        response: { 200: listEnvelopeSchema(threadDtoSchema) },
      },
      preHandler: [app.requireRole('viewer')],
    },
    async (req) => {
      const q = req.query;
      return app.tenant(req, async (tx) => {
        const rows = await tx.whatsAppThread.findMany({
          where: {
            ...(q.status ? { status: q.status as never } : {}),
            ...(q.assignee ? { assignedToUserId: q.assignee } : {}),
            ...(q.tag ? { tags: { some: { tag: q.tag } } } : {}),
            // Search uses the rolling search_text blob OR matches the phone
            // / preview directly so users can search for `+1415` as well.
            ...(q.q
              ? {
                  OR: [
                    { customerPhone: { contains: q.q } },
                    { customerName: { contains: q.q, mode: 'insensitive' as const } },
                    { lastMessagePreview: { contains: q.q, mode: 'insensitive' as const } },
                    { searchText: { contains: q.q.toLowerCase() } },
                  ],
                }
              : {}),
          },
          orderBy: { lastMessageAt: 'desc' },
          take: q.limit,
          include: {
            assignedTo: { select: { firstName: true, lastName: true, email: true } },
            tags: { select: { tag: true } },
            _count: { select: { notes: true } },
          },
        });
        return { data: rows.map(serializeThread), nextCursor: null };
      });
    },
  );

  // ---------- GET /inbox/threads/:id -----------------------------------
  r.get(
    '/inbox/threads/:id',
    {
      schema: {
        tags: ['inbox'],
        summary: 'Get one thread by id.',
        params: z.object({ id: uuidSchema }),
      },
      preHandler: [app.requireRole('viewer')],
    },
    async (req) =>
      app.tenant(req, async (tx) => {
        const t = await tx.whatsAppThread.findUnique({
          where: { id: req.params.id },
          include: {
            assignedTo: { select: { firstName: true, lastName: true, email: true } },
            tags: { select: { tag: true } },
            _count: { select: { notes: true } },
          },
        });
        if (!t) throw notFound('Thread not found.');
        return { data: serializeThread(t) };
      }),
  );

  // ---------- GET /inbox/threads/:id/messages --------------------------
  r.get(
    '/inbox/threads/:id/messages',
    {
      schema: {
        tags: ['inbox'],
        summary: 'Full message history for a thread (chronological).',
        params: z.object({ id: uuidSchema }),
        response: { 200: listEnvelopeSchema(messageDtoSchema) },
      },
      preHandler: [app.requireRole('viewer')],
    },
    async (req) =>
      app.tenant(req, async (tx) => {
        const messages = await tx.whatsAppMessage.findMany({
          where: { threadId: req.params.id },
          orderBy: { receivedAt: 'asc' },
          take: 500,
        });
        return {
          data: messages.map((m) => ({
            id: m.id,
            direction: m.direction === 'outbound' ? ('outbound' as const) : ('inbound' as const),
            metaMessageId: m.metaMessageId,
            fromNumber: m.fromNumber,
            toNumber: m.toNumber,
            messageType: m.messageType,
            body: m.body,
            receivedAt: m.receivedAt.toISOString(),
          })),
          nextCursor: null,
        };
      }),
  );

  // ---------- PATCH /inbox/threads/:id ---------------------------------
  // Update status / customerName / assignedToUserId. Assigning to a
  // non-member of the org is rejected.
  r.patch(
    '/inbox/threads/:id',
    {
      schema: {
        tags: ['inbox'],
        summary: 'Update thread status, customer name, or assignee.',
        params: z.object({ id: uuidSchema }),
        body: z.object({
          status: threadStatusSchema.optional(),
          customerName: z.string().trim().max(120).nullable().optional(),
          assignedToUserId: uuidSchema.nullable().optional(),
        }),
      },
      preHandler: [app.requireRole('editor')],
    },
    async (req) => {
      const orgId = req.auth!.organizationId;
      return app.tenant(req, async (tx) => {
        if (req.body.assignedToUserId) {
          const m = await tx.membership.findFirst({
            where: { userId: req.body.assignedToUserId, isActive: true },
          });
          if (!m) {
            throw badRequest(
              ApiErrorCode.VALIDATION_ERROR,
              'Cannot assign to a user who is not an active member of this organization.',
            );
          }
        }
        const updated = await tx.whatsAppThread.update({
          where: { id: req.params.id },
          data: {
            status: (req.body.status as never) ?? undefined,
            customerName:
              req.body.customerName === undefined ? undefined : req.body.customerName,
            assignedToUserId:
              req.body.assignedToUserId === undefined ? undefined : req.body.assignedToUserId,
          },
          include: {
            assignedTo: { select: { firstName: true, lastName: true, email: true } },
            tags: { select: { tag: true } },
            _count: { select: { notes: true } },
          },
        });
        await recordAudit({
          action: 'business_info_updated',
          organizationId: orgId,
          actorUserId: req.auth!.userId,
          entityType: 'whatsapp_thread',
          entityId: updated.id,
          metadata: { event: 'thread_updated', fields: Object.keys(req.body) },
        });
        return { data: serializeThread(updated) };
      });
    },
  );

  // ---------- POST /inbox/threads/:id/auto-assign ----------------------
  // Round-robin pick the next active org member who has the fewest open
  // threads currently. Cheap deterministic round-robin: order members by
  // (open thread count ASC, joinedAt ASC) and take the first.
  r.post(
    '/inbox/threads/:id/auto-assign',
    {
      schema: {
        tags: ['inbox'],
        summary: 'Auto-assign this thread round-robin to the lightest-loaded member.',
        params: z.object({ id: uuidSchema }),
      },
      preHandler: [app.requireRole('editor')],
    },
    async (req) =>
      app.tenant(req, async (tx) => {
        // Active members, ordered by current open-thread load.
        const members = await tx.membership.findMany({
          where: { isActive: true },
          select: { userId: true, createdAt: true },
        });
        if (members.length === 0) {
          throw badRequest(ApiErrorCode.VALIDATION_ERROR, 'No active members to assign.');
        }
        const loads = await Promise.all(
          members.map(async (m) => ({
            userId: m.userId,
            joinedAt: m.createdAt,
            load: await tx.whatsAppThread.count({
              where: { assignedToUserId: m.userId, status: { in: ['open', 'pending'] as never } },
            }),
          })),
        );
        loads.sort((a, b) => a.load - b.load || a.joinedAt.getTime() - b.joinedAt.getTime());
        const next = loads[0]!;
        const updated = await tx.whatsAppThread.update({
          where: { id: req.params.id },
          data: { assignedToUserId: next.userId },
          include: {
            assignedTo: { select: { firstName: true, lastName: true, email: true } },
            tags: { select: { tag: true } },
            _count: { select: { notes: true } },
          },
        });
        return { data: serializeThread(updated) };
      }),
  );

  // ===================================================================
  // TAGS
  // ===================================================================

  r.post(
    '/inbox/threads/:id/tags',
    {
      schema: {
        tags: ['inbox'],
        summary: 'Add a tag to a thread.',
        params: z.object({ id: uuidSchema }),
        body: z.object({ tag: z.string().trim().min(1).max(40) }),
        response: { 200: successSchema },
      },
      preHandler: [app.requireRole('editor')],
    },
    async (req) =>
      app.tenant(req, async (tx) => {
        await tx.whatsAppThreadTag
          .create({
            data: {
              organizationId: req.auth!.organizationId,
              threadId: req.params.id,
              tag: req.body.tag.toLowerCase(),
            },
          })
          .catch(() => undefined); // duplicate is fine
        return { ok: true as const };
      }),
  );

  r.delete(
    '/inbox/threads/:id/tags/:tag',
    {
      schema: {
        tags: ['inbox'],
        summary: 'Remove a tag.',
        params: z.object({ id: uuidSchema, tag: z.string().min(1).max(40) }),
        response: { 200: successSchema },
      },
      preHandler: [app.requireRole('editor')],
    },
    async (req) =>
      app.tenant(req, async (tx) => {
        await tx.whatsAppThreadTag.deleteMany({
          where: { threadId: req.params.id, tag: decodeURIComponent(req.params.tag).toLowerCase() },
        });
        return { ok: true as const };
      }),
  );

  // ===================================================================
  // INTERNAL NOTES
  // ===================================================================

  r.get(
    '/inbox/threads/:id/notes',
    {
      schema: {
        tags: ['inbox'],
        summary: 'List internal notes (visible to org members only).',
        params: z.object({ id: uuidSchema }),
        response: { 200: listEnvelopeSchema(noteDtoSchema) },
      },
      preHandler: [app.requireRole('viewer')],
    },
    async (req) =>
      app.tenant(req, async (tx) => {
        const rows = await tx.whatsAppNote.findMany({
          where: { threadId: req.params.id },
          orderBy: { createdAt: 'asc' },
        });
        // Hydrate author display name in a second query (cheap; small N).
        const ids = [...new Set(rows.map((r) => r.authorUserId).filter((u): u is string => !!u))];
        const users = ids.length
          ? await tx.user.findMany({
              where: { id: { in: ids } },
              select: { id: true, firstName: true, lastName: true, email: true },
            })
          : [];
        const userMap = new Map(users.map((u) => [u.id, u]));
        return {
          data: rows.map((r) => {
            const u = r.authorUserId ? userMap.get(r.authorUserId) : null;
            return {
              id: r.id,
              authorUserId: r.authorUserId,
              authorName: u
                ? [u.firstName, u.lastName].filter(Boolean).join(' ') || u.email
                : null,
              authorEmail: u?.email ?? null,
              body: r.body,
              createdAt: r.createdAt.toISOString(),
            };
          }),
          nextCursor: null,
        };
      }),
  );

  r.post(
    '/inbox/threads/:id/notes',
    {
      schema: {
        tags: ['inbox'],
        summary: 'Add an internal note. Never sent to the customer via WhatsApp.',
        params: z.object({ id: uuidSchema }),
        body: z.object({ body: z.string().trim().min(1).max(4000) }),
      },
      preHandler: [app.requireRole('editor')],
    },
    async (req) =>
      app.tenant(req, async (tx) => {
        const created = await tx.whatsAppNote.create({
          data: {
            organizationId: req.auth!.organizationId,
            threadId: req.params.id,
            authorUserId: req.auth!.userId,
            body: req.body.body,
          },
        });
        return { data: { id: created.id } };
      }),
  );

  // ===================================================================
  // BOT-TO-HUMAN HANDOFF
  // ===================================================================
  // Marks a thread as `pending`, posts an internal "Bot escalated" note,
  // emits a notification. Authenticated by JWT (an authenticated agent
  // calling it) OR by API key with scope `read:catalog` (a chatbot
  // escalating). For Session 4 we accept JWT-only; chatbot-side handoff
  // can come later when Phase 2's bot runtime calls it.
  r.post(
    '/inbox/threads/:id/handoff',
    {
      schema: {
        tags: ['inbox'],
        summary: 'Hand off a thread from the bot to a human.',
        params: z.object({ id: uuidSchema }),
        body: z.object({ reason: z.string().trim().min(1).max(500).optional() }),
        response: { 200: successSchema },
      },
      preHandler: [app.requireRole('viewer')],
    },
    async (req) => {
      const orgId = req.auth!.organizationId;
      return app.tenant(req, async (tx) => {
        const thread = await tx.whatsAppThread.findUnique({ where: { id: req.params.id } });
        if (!thread) throw notFound('Thread not found.');
        await tx.whatsAppThread.update({
          where: { id: thread.id },
          data: { status: 'pending' },
        });
        await tx.whatsAppNote.create({
          data: {
            organizationId: orgId,
            threadId: thread.id,
            authorUserId: req.auth!.userId,
            body: `🤖 → 👤 Bot escalated to human${req.body.reason ? `: ${req.body.reason}` : ''}.`,
          },
        });
        await tx.notification.create({
          data: {
            organizationId: orgId,
            kind: 'generic',
            severity: 'warning',
            title: 'Conversation needs a human',
            body: `Thread with ${thread.customerPhone} was handed off${req.body.reason ? ` (${req.body.reason})` : ''}.`,
            link: '/inbox',
            entityType: 'whatsapp_thread',
            entityId: thread.id,
          },
        });
        return { ok: true as const };
      });
    },
  );

  // ===================================================================
  // SSE REALTIME
  // ===================================================================
  // Server-Sent Events stream that ticks every 2s with a tiny "you should
  // refetch" signal. Cheaper than WebSockets, avoids socket.io overhead,
  // and the React Query layer in the client treats the tick as an
  // invalidation trigger so threads + active thread auto-refresh
  // sub-1-second perceived. True bidirectional WebSockets remain a
  // future polish item if the SSE poll proves too coarse.
  r.get(
    '/inbox/sse',
    {
      schema: { tags: ['inbox'], summary: 'SSE: emits a ping every 2s for inbox refresh.' },
      preHandler: [app.requireRole('viewer')],
    },
    async (req, reply) => {
      const orgId = req.auth!.organizationId;
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      reply.raw.write(`retry: 5000\n\n`);
      reply.raw.write(`event: hello\ndata: ${JSON.stringify({ orgId })}\n\n`);
      const interval = setInterval(() => {
        try {
          reply.raw.write(`event: tick\ndata: ${JSON.stringify({ ts: Date.now() })}\n\n`);
        } catch {
          /* socket likely closed */
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
      // Fastify needs us to keep the reply alive; do not return.
      return reply;
    },
  );

  // ===================================================================
  // CANNED RESPONSES
  // ===================================================================

  r.get(
    '/canned-responses',
    {
      schema: {
        tags: ['inbox'],
        summary: 'List canned responses for the org.',
        response: { 200: listEnvelopeSchema(cannedResponseDtoSchema) },
      },
      preHandler: [app.requireRole('viewer')],
    },
    async (req) =>
      app.tenant(req, async (tx) => {
        const rows = await tx.cannedResponse.findMany({ orderBy: { shortcut: 'asc' } });
        return {
          data: rows.map((r) => ({
            id: r.id,
            shortcut: r.shortcut,
            body: r.body,
            createdAt: r.createdAt.toISOString(),
            updatedAt: r.updatedAt.toISOString(),
          })),
          nextCursor: null,
        };
      }),
  );

  r.post(
    '/canned-responses',
    {
      schema: {
        tags: ['inbox'],
        summary: 'Create a canned response. Body supports {first_name}, {phone} variables.',
        body: z.object({
          shortcut: z.string().trim().min(1).max(40),
          body: z.string().trim().min(1).max(4000),
        }),
      },
      preHandler: [app.requireRole('editor')],
    },
    async (req) =>
      app.tenant(req, async (tx) => {
        const created = await tx.cannedResponse.create({
          data: {
            organizationId: req.auth!.organizationId,
            shortcut: req.body.shortcut.toLowerCase().replace(/^\/+/, ''),
            body: req.body.body,
          },
        });
        return { data: { id: created.id } };
      }),
  );

  r.patch(
    '/canned-responses/:id',
    {
      schema: {
        tags: ['inbox'],
        summary: 'Update a canned response.',
        params: z.object({ id: uuidSchema }),
        body: z.object({
          shortcut: z.string().trim().min(1).max(40).optional(),
          body: z.string().trim().min(1).max(4000).optional(),
        }),
      },
      preHandler: [app.requireRole('editor')],
    },
    async (req) =>
      app.tenant(req, async (tx) => {
        await tx.cannedResponse.update({
          where: { id: req.params.id },
          data: {
            shortcut: req.body.shortcut?.toLowerCase().replace(/^\/+/, ''),
            body: req.body.body,
          },
        });
        return { ok: true as const };
      }),
  );

  r.delete(
    '/canned-responses/:id',
    {
      schema: {
        tags: ['inbox'],
        summary: 'Delete a canned response.',
        params: z.object({ id: uuidSchema }),
        response: { 200: successSchema },
      },
      preHandler: [app.requireRole('editor')],
    },
    async (req) =>
      app.tenant(req, async (tx) => {
        await tx.cannedResponse.deleteMany({ where: { id: req.params.id } });
        return { ok: true as const };
      }),
  );
}
