// Audit log reader routes. Tenant-scoped view powers /audit-log in the
// portal; admin-scoped view powers the cross-tenant tab in /aligned-admin.
//
// Filters supported on both endpoints: entityType, action, actorEmail,
// from/to date range. Results are paginated with an opaque cursor (ISO
// timestamp of the last-seen row) — no counts (would be expensive on a
// table that grows per write).
import {
  listEnvelopeSchema,
  uuidSchema,
} from '@aligned/shared';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { withRlsBypass } from '../../lib/db.js';

const auditEntrySchema = z.object({
  id: uuidSchema,
  action: z.string(),
  entityType: z.string().nullable(),
  entityId: uuidSchema.nullable(),
  actorName: z.string().nullable(),
  actorEmail: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()).nullable(),
  createdAt: z.string().datetime(),
});

const adminAuditEntrySchema = auditEntrySchema.extend({
  organizationId: uuidSchema.nullable(),
  organizationName: z.string().nullable(),
  organizationSlug: z.string().nullable(),
});

const listQuerySchema = z.object({
  entityType: z.string().trim().min(1).optional(),
  action: z.string().trim().min(1).optional(),
  actorEmail: z.string().trim().min(1).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().optional(), // ISO timestamp from previous page's last row
});

export default async function auditRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  // ---------- GET /audit-log ---------------------------------------------
  // Client-scoped: returns only the current org's events (RLS enforced via
  // app.tenant). Any authenticated member may read.
  r.get(
    '/audit-log',
    {
      schema: {
        tags: ['audit'],
        summary: 'List audit log entries for the current organization.',
        querystring: listQuerySchema,
        response: { 200: listEnvelopeSchema(auditEntrySchema) },
      },
      preHandler: [app.requireRole('viewer')],
    },
    async (req) => {
      const q = req.query;
      return app.tenant(req, async (tx) => {
        const rows = await tx.auditLog.findMany({
          where: {
            ...(q.entityType ? { entityType: q.entityType } : {}),
            ...(q.action ? { action: q.action as never } : {}),
            ...(q.actorEmail
              ? { actor: { email: { contains: q.actorEmail, mode: 'insensitive' as const } } }
              : {}),
            ...(q.from || q.to
              ? {
                  createdAt: {
                    ...(q.from ? { gte: new Date(q.from) } : {}),
                    ...(q.to ? { lte: new Date(q.to) } : {}),
                  },
                }
              : {}),
            ...(q.cursor ? { createdAt: { lt: new Date(q.cursor) } } : {}),
          },
          orderBy: { createdAt: 'desc' },
          take: q.limit + 1, // fetch one extra to detect next-cursor
          include: { actor: { select: { firstName: true, lastName: true, email: true } } },
        });

        const hasMore = rows.length > q.limit;
        const page = hasMore ? rows.slice(0, q.limit) : rows;
        const nextCursor = hasMore ? page[page.length - 1]?.createdAt.toISOString() ?? null : null;

        return {
          data: page.map((a) => ({
            id: a.id,
            action: a.action,
            entityType: a.entityType,
            entityId: a.entityId,
            actorName:
              a.actor && (a.actor.firstName || a.actor.lastName)
                ? `${a.actor.firstName ?? ''} ${a.actor.lastName ?? ''}`.trim()
                : null,
            actorEmail: a.actor?.email ?? null,
            metadata: (a.metadata ?? null) as Record<string, unknown> | null,
            createdAt: a.createdAt.toISOString(),
          })),
          nextCursor,
        };
      });
    },
  );

  // ---------- GET /aligned-admin/audit-log -------------------------------
  // Cross-tenant: ALIGNED staff only. Same filters + an extra org_id / name
  // column for triage across many tenants.
  r.get(
    '/aligned-admin/audit-log',
    {
      schema: {
        tags: ['admin'],
        summary: 'Cross-tenant audit log (ALIGNED super-admins only).',
        querystring: listQuerySchema.extend({
          organizationId: uuidSchema.optional(),
        }),
        response: { 200: listEnvelopeSchema(adminAuditEntrySchema) },
      },
      preHandler: [app.requireAlignedAdmin],
    },
    async (req) => {
      const q = req.query;
      return withRlsBypass(async (tx) => {
        const rows = await tx.auditLog.findMany({
          where: {
            ...(q.organizationId ? { organizationId: q.organizationId } : {}),
            ...(q.entityType ? { entityType: q.entityType } : {}),
            ...(q.action ? { action: q.action as never } : {}),
            ...(q.actorEmail
              ? { actor: { email: { contains: q.actorEmail, mode: 'insensitive' as const } } }
              : {}),
            ...(q.from || q.to
              ? {
                  createdAt: {
                    ...(q.from ? { gte: new Date(q.from) } : {}),
                    ...(q.to ? { lte: new Date(q.to) } : {}),
                  },
                }
              : {}),
            ...(q.cursor ? { createdAt: { lt: new Date(q.cursor) } } : {}),
          },
          orderBy: { createdAt: 'desc' },
          take: q.limit + 1,
          include: {
            actor: { select: { firstName: true, lastName: true, email: true } },
            organization: { select: { name: true, slug: true } },
          },
        });

        const hasMore = rows.length > q.limit;
        const page = hasMore ? rows.slice(0, q.limit) : rows;
        const nextCursor = hasMore ? page[page.length - 1]?.createdAt.toISOString() ?? null : null;

        return {
          data: page.map((a) => ({
            id: a.id,
            organizationId: a.organizationId,
            organizationName: a.organization?.name ?? null,
            organizationSlug: a.organization?.slug ?? null,
            action: a.action,
            entityType: a.entityType,
            entityId: a.entityId,
            actorName:
              a.actor && (a.actor.firstName || a.actor.lastName)
                ? `${a.actor.firstName ?? ''} ${a.actor.lastName ?? ''}`.trim()
                : null,
            actorEmail: a.actor?.email ?? null,
            metadata: (a.metadata ?? null) as Record<string, unknown> | null,
            createdAt: a.createdAt.toISOString(),
          })),
          nextCursor,
        };
      });
    },
  );
}
