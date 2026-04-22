import {
  itemEnvelopeSchema,
  listEnvelopeSchema,
  notificationListQuerySchema,
  notificationSchema,
  successSchema,
  uuidSchema,
} from '@aligned/shared';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { recordAudit } from '../../lib/audit.js';
import { notFound } from '../../lib/errors.js';

function isReadFor(notification: { readAt: Date | null; readByUserIds: string[]; targetUserId: string | null }, userId: string) {
  if (notification.targetUserId) return notification.readAt !== null;
  return notification.readByUserIds.includes(userId);
}

export default async function notificationRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  // ---------- GET /notifications ------------------------------------------
  r.get(
    '/notifications',
    {
      schema: {
        tags: ['notifications'],
        summary: 'List notifications visible to the current user.',
        querystring: notificationListQuerySchema,
        response: { 200: listEnvelopeSchema(notificationSchema).extend({ unreadCount: z.number().int() }) },
      },
      preHandler: [app.requireAuth],
    },
    async (req) => {
      const userId = req.auth!.userId;
      return app.tenant(req, async (tx) => {
        const rows = await tx.notification.findMany({
          where: {
            OR: [{ targetUserId: null }, { targetUserId: userId }],
          },
          orderBy: { createdAt: 'desc' },
          take: req.query.limit,
        });
        const data = rows
          .map((n) => ({
            id: n.id,
            kind: n.kind,
            severity: n.severity,
            title: n.title,
            body: n.body,
            link: n.link,
            entityType: n.entityType,
            entityId: n.entityId,
            isRead: isReadFor(n, userId),
            createdAt: n.createdAt.toISOString(),
          }))
          .filter((n) => (req.query.unreadOnly ? !n.isRead : true));
        const unreadCount = rows.reduce(
          (acc, n) => acc + (isReadFor(n, userId) ? 0 : 1),
          0,
        );
        return { data, nextCursor: null, unreadCount };
      });
    },
  );

  // ---------- POST /notifications/:id/read --------------------------------
  r.post(
    '/notifications/:id/read',
    {
      schema: {
        tags: ['notifications'],
        summary: 'Mark a notification as read for the current user.',
        params: z.object({ id: uuidSchema }),
        response: { 200: successSchema },
      },
      preHandler: [app.requireAuth],
    },
    async (req) => {
      const userId = req.auth!.userId;
      return app.tenant(req, async (tx) => {
        const n = await tx.notification.findUnique({ where: { id: req.params.id } });
        if (!n) throw notFound('Notification not found.');

        if (n.targetUserId) {
          await tx.notification.update({ where: { id: n.id }, data: { readAt: new Date() } });
        } else if (!n.readByUserIds.includes(userId)) {
          await tx.notification.update({
            where: { id: n.id },
            data: { readByUserIds: { push: userId } },
          });
        }
        await recordAudit({
          action: 'notification_marked_read',
          organizationId: req.auth!.organizationId,
          actorUserId: userId,
          entityType: 'notification',
          entityId: n.id,
        });
        return { ok: true as const };
      });
    },
  );

  // ---------- POST /notifications/read-all --------------------------------
  r.post(
    '/notifications/read-all',
    {
      schema: {
        tags: ['notifications'],
        summary: 'Mark all current notifications as read.',
        response: { 200: itemEnvelopeSchema(z.object({ marked: z.number().int() })) },
      },
      preHandler: [app.requireAuth],
    },
    async (req) => {
      const userId = req.auth!.userId;
      return app.tenant(req, async (tx) => {
        const targeted = await tx.notification.updateMany({
          where: { targetUserId: userId, readAt: null },
          data: { readAt: new Date() },
        });
        const orgWide = await tx.notification.findMany({
          where: { targetUserId: null, NOT: { readByUserIds: { has: userId } } },
          select: { id: true },
        });
        for (const n of orgWide) {
          await tx.notification.update({
            where: { id: n.id },
            data: { readByUserIds: { push: userId } },
          });
        }
        return { data: { marked: targeted.count + orgWide.length } };
      });
    },
  );
}
