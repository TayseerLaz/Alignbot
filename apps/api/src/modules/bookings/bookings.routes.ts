import {
  BOOKING_STATUSES,
  bookingSchema,
  bookingListQuerySchema,
  createBookingBodySchema,
  itemEnvelopeSchema,
  listEnvelopeSchema,
  successSchema,
  updateBookingBodySchema,
  uuidSchema,
} from '@aligned/shared';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { recordAudit } from '../../lib/audit.js';
import type { Prisma } from '../../lib/db.js';
import { notFound } from '../../lib/errors.js';
import { emitWebhookEvent } from '../../lib/webhooks.js';
import { decodeCursor, encodeCursor } from '../catalog/shared.js';

type BookingRow = Awaited<
  ReturnType<NonNullable<Prisma.TransactionClient['booking']['findFirst']>>
>;

function serialize(b: NonNullable<BookingRow>) {
  return {
    id: b.id,
    threadId: b.threadId,
    customerPhone: b.customerPhone,
    customerName: b.customerName,
    fields: (Array.isArray(b.fields) ? b.fields : []) as never,
    status: b.status as (typeof BOOKING_STATUSES)[number],
    notes: b.notes,
    createdAt: b.createdAt.toISOString(),
    updatedAt: b.updatedAt.toISOString(),
  };
}

export default async function bookingsRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  // ---------- GET /bookings -----------------------------------------------
  r.get(
    '/bookings',
    {
      schema: {
        tags: ['bookings'],
        summary: 'List bookings with optional status filter and cursor pagination.',
        querystring: bookingListQuerySchema,
        response: { 200: listEnvelopeSchema(bookingSchema) },
      },
      preHandler: [app.requireRole('viewer')],
    },
    async (req) => {
      const q = req.query;
      return app.tenant(req, async (tx) => {
        const where: Prisma.BookingWhereInput = {
          ...(q.status ? { status: q.status } : {}),
          ...(q.q
            ? {
                OR: [
                  { customerPhone: { contains: q.q, mode: 'insensitive' } },
                  { customerName: { contains: q.q, mode: 'insensitive' } },
                  { notes: { contains: q.q, mode: 'insensitive' } },
                ],
              }
            : {}),
        };
        const cursor = decodeCursor<{ id: string }>(q.cursor);
        const rows = await tx.booking.findMany({
          where,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: q.limit + 1,
          ...(cursor ? { cursor: { id: cursor.id }, skip: 1 } : {}),
        });
        const hasMore = rows.length > q.limit;
        const page = hasMore ? rows.slice(0, q.limit) : rows;
        return {
          data: page.map(serialize),
          nextCursor: hasMore ? encodeCursor({ id: page[page.length - 1]!.id }) : null,
        };
      });
    },
  );

  // ---------- GET /bookings/:id -------------------------------------------
  r.get(
    '/bookings/:id',
    {
      schema: {
        tags: ['bookings'],
        summary: 'Get a single booking.',
        params: z.object({ id: uuidSchema }),
        response: { 200: itemEnvelopeSchema(bookingSchema) },
      },
      preHandler: [app.requireRole('viewer')],
    },
    async (req) => {
      return app.tenant(req, async (tx) => {
        const b = await tx.booking.findUnique({ where: { id: req.params.id } });
        if (!b) throw notFound('Booking not found.');
        return { data: serialize(b) };
      });
    },
  );

  // ---------- POST /bookings ----------------------------------------------
  r.post(
    '/bookings',
    {
      schema: {
        tags: ['bookings'],
        summary: 'Create a booking (manual entry from the dashboard).',
        body: createBookingBodySchema,
        response: { 201: itemEnvelopeSchema(bookingSchema) },
      },
      preHandler: [app.requireRole('editor')],
    },
    async (req, reply) => {
      const orgId = req.auth!.organizationId;
      return app.tenant(req, async (tx) => {
        const b = await tx.booking.create({
          data: {
            organizationId: orgId,
            threadId: req.body.threadId ?? null,
            customerPhone: req.body.customerPhone,
            customerName: req.body.customerName ?? null,
            fields: req.body.fields as unknown as Prisma.InputJsonValue,
            status: req.body.status ?? 'new',
            notes: req.body.notes ?? null,
          },
        });
        await recordAudit({
          action: 'booking_created',
          organizationId: orgId,
          actorUserId: req.auth!.userId,
          entityType: 'booking',
          entityId: b.id,
        });
        void emitWebhookEvent({
          organizationId: orgId,
          eventKind: 'booking_created',
          payload: { id: b.id, customerPhone: b.customerPhone },
        });
        reply.code(201);
        return { data: serialize(b) };
      });
    },
  );

  // ---------- PATCH /bookings/:id -----------------------------------------
  r.patch(
    '/bookings/:id',
    {
      schema: {
        tags: ['bookings'],
        summary: 'Update a booking (status, notes, edit answers).',
        params: z.object({ id: uuidSchema }),
        body: updateBookingBodySchema,
        response: { 200: itemEnvelopeSchema(bookingSchema) },
      },
      preHandler: [app.requireRole('editor')],
    },
    async (req) => {
      const orgId = req.auth!.organizationId;
      return app.tenant(req, async (tx) => {
        const existing = await tx.booking.findUnique({ where: { id: req.params.id } });
        if (!existing) throw notFound('Booking not found.');
        const updated = await tx.booking.update({
          where: { id: existing.id },
          data: {
            customerName: req.body.customerName === undefined ? undefined : req.body.customerName,
            fields:
              req.body.fields === undefined
                ? undefined
                : (req.body.fields as unknown as Prisma.InputJsonValue),
            status: req.body.status === undefined ? undefined : req.body.status,
            notes: req.body.notes === undefined ? undefined : req.body.notes,
          },
        });
        await recordAudit({
          action: 'booking_updated',
          organizationId: orgId,
          actorUserId: req.auth!.userId,
          entityType: 'booking',
          entityId: updated.id,
        });
        if (req.body.status && req.body.status !== existing.status) {
          void emitWebhookEvent({
            organizationId: orgId,
            eventKind: 'booking_status_changed',
            payload: { id: updated.id, from: existing.status, to: req.body.status },
          });
        }
        return { data: serialize(updated) };
      });
    },
  );

  // ---------- DELETE /bookings/:id ----------------------------------------
  r.delete(
    '/bookings/:id',
    {
      schema: {
        tags: ['bookings'],
        summary: 'Delete a booking.',
        params: z.object({ id: uuidSchema }),
        response: { 200: successSchema },
      },
      preHandler: [app.requireRole('admin')],
    },
    async (req) => {
      const orgId = req.auth!.organizationId;
      return app.tenant(req, async (tx) => {
        const existing = await tx.booking.findUnique({ where: { id: req.params.id } });
        if (!existing) throw notFound('Booking not found.');
        await tx.booking.delete({ where: { id: existing.id } });
        await recordAudit({
          action: 'booking_deleted',
          organizationId: orgId,
          actorUserId: req.auth!.userId,
          entityType: 'booking',
          entityId: existing.id,
        });
        return { ok: true as const };
      });
    },
  );
}
