// ALIGNED super-admin endpoints. Always run with RLS bypass since they
// inspect / manage data across tenants. Gated by `requireAlignedAdmin`.
import {
  adminListOrgsQuerySchema,
  adminUpdateOrgBodySchema,
  itemEnvelopeSchema,
  listEnvelopeSchema,
  organizationSchema,
  successSchema,
  uuidSchema,
} from '@aligned/shared';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { recordAudit } from '../../lib/audit.js';
import { withRlsBypass } from '../../lib/db.js';
import { notFound } from '../../lib/errors.js';
import { getImportQueue, getSyncQueue, getWebhookQueue } from '../../lib/queues.js';
import { getRedis } from '../../lib/redis.js';

export default async function adminRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  // ---------- GET /aligned-admin/orgs -------------------------------------
  r.get(
    '/aligned-admin/orgs',
    {
      schema: {
        tags: ['admin'],
        summary: 'List all organisations across the platform.',
        querystring: adminListOrgsQuerySchema,
        response: {
          200: listEnvelopeSchema(
            organizationSchema.extend({
              memberCount: z.number().int(),
              productCount: z.number().int(),
              serviceCount: z.number().int(),
              lastActivityAt: z.string().datetime().nullable(),
            }),
          ),
        },
      },
      preHandler: [app.requireAlignedAdmin],
    },
    async (req) => {
      const orgs = await withRlsBypass(async (tx) => {
        const where = {
          ...(req.query.status ? { status: req.query.status } : {}),
          ...(req.query.q
            ? {
                OR: [
                  { name: { contains: req.query.q, mode: 'insensitive' as const } },
                  { slug: { contains: req.query.q, mode: 'insensitive' as const } },
                ],
              }
            : {}),
        };
        const rows = await tx.organization.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          take: req.query.limit,
        });
        return Promise.all(
          rows.map(async (o) => {
            const [memberCount, productCount, serviceCount, lastAudit] = await Promise.all([
              tx.membership.count({ where: { organizationId: o.id, isActive: true } }),
              tx.product.count({ where: { organizationId: o.id, deletedAt: null } }),
              tx.service.count({ where: { organizationId: o.id, deletedAt: null } }),
              tx.auditLog.findFirst({
                where: { organizationId: o.id },
                orderBy: { createdAt: 'desc' },
                select: { createdAt: true },
              }),
            ]);
            return {
              id: o.id,
              slug: o.slug,
              name: o.name,
              status: o.status,
              createdAt: o.createdAt.toISOString(),
              updatedAt: o.updatedAt.toISOString(),
              memberCount,
              productCount,
              serviceCount,
              lastActivityAt: lastAudit?.createdAt.toISOString() ?? null,
            };
          }),
        );
      });
      return { data: orgs, nextCursor: null };
    },
  );

  // ---------- PATCH /aligned-admin/orgs/:id -------------------------------
  r.patch(
    '/aligned-admin/orgs/:id',
    {
      schema: {
        tags: ['admin'],
        summary: 'Suspend / re-activate / rename an organisation.',
        params: z.object({ id: uuidSchema }),
        body: adminUpdateOrgBodySchema,
        response: { 200: itemEnvelopeSchema(organizationSchema) },
      },
      preHandler: [app.requireAlignedAdmin],
    },
    async (req) => {
      const updated = await withRlsBypass((tx) =>
        tx.organization.update({
          where: { id: req.params.id },
          data: {
            status: req.body.status ?? undefined,
            name: req.body.name ?? undefined,
          },
        }),
      );
      if (req.body.status === 'suspended') {
        await recordAudit({
          action: 'org_suspended',
          organizationId: updated.id,
          actorUserId: req.auth!.userId,
        });
      }
      return {
        data: {
          id: updated.id,
          slug: updated.slug,
          name: updated.name,
          status: updated.status,
          createdAt: updated.createdAt.toISOString(),
          updatedAt: updated.updatedAt.toISOString(),
        },
      };
    },
  );

  // ---------- DELETE /aligned-admin/orgs/:id ------------------------------
  r.delete(
    '/aligned-admin/orgs/:id',
    {
      schema: {
        tags: ['admin'],
        summary: 'Hard-delete an organisation and all its data.',
        params: z.object({ id: uuidSchema }),
        response: { 200: successSchema },
      },
      preHandler: [app.requireAlignedAdmin],
    },
    async (req) => {
      const target = await withRlsBypass((tx) => tx.organization.findUnique({ where: { id: req.params.id } }));
      if (!target) throw notFound('Organisation not found.');
      await withRlsBypass((tx) => tx.organization.delete({ where: { id: target.id } }));
      return { ok: true as const };
    },
  );

  // ---------- GET /aligned-admin/system -----------------------------------
  // System health snapshot. Exact numbers (queue depth, redis info) are pulled live.
  r.get(
    '/aligned-admin/system',
    {
      schema: {
        tags: ['admin'],
        summary: 'Live system health snapshot for ALIGNED operators.',
        response: {
          200: itemEnvelopeSchema(
            z.object({
              orgs: z.object({ active: z.number(), suspended: z.number(), deleted: z.number() }),
              users: z.object({ total: z.number(), pending: z.number(), disabled: z.number() }),
              queues: z.object({
                import: z.object({ waiting: z.number(), active: z.number(), failed: z.number() }),
                sync: z.object({ waiting: z.number(), active: z.number(), failed: z.number() }),
                webhook: z.object({ waiting: z.number(), active: z.number(), failed: z.number() }),
              }),
              redis: z.object({ connected: z.boolean(), opsPerSec: z.number().nullable() }),
            }),
          ),
        },
      },
      preHandler: [app.requireAlignedAdmin],
    },
    async () => {
      const [orgsActive, orgsSuspended, orgsDeleted, usersTotal, usersPending, usersDisabled] = await withRlsBypass(
        (tx) =>
          Promise.all([
            tx.organization.count({ where: { status: 'active' } }),
            tx.organization.count({ where: { status: 'suspended' } }),
            tx.organization.count({ where: { status: 'deleted' } }),
            tx.user.count(),
            tx.user.count({ where: { status: 'pending' } }),
            tx.user.count({ where: { status: 'disabled' } }),
          ]),
      );

      const [importCounts, syncCounts, webhookCounts] = await Promise.all([
        getImportQueue().getJobCounts(),
        getSyncQueue().getJobCounts(),
        getWebhookQueue().getJobCounts(),
      ]);

      const redis = getRedis();
      let connected = true;
      let opsPerSec: number | null = null;
      try {
        const info = await redis.info('stats');
        const m = info.match(/instantaneous_ops_per_sec:(\d+)/);
        opsPerSec = m && m[1] ? Number(m[1]) : null;
      } catch {
        connected = false;
      }

      return {
        data: {
          orgs: { active: orgsActive, suspended: orgsSuspended, deleted: orgsDeleted },
          users: { total: usersTotal, pending: usersPending, disabled: usersDisabled },
          queues: {
            import: { waiting: importCounts.waiting, active: importCounts.active, failed: importCounts.failed },
            sync: { waiting: syncCounts.waiting, active: syncCounts.active, failed: syncCounts.failed },
            webhook: { waiting: webhookCounts.waiting, active: webhookCounts.active, failed: webhookCounts.failed },
          },
          redis: { connected, opsPerSec },
        },
      };
    },
  );

  // ---------- POST /aligned-admin/queues/:queue/drain-failed ---------------
  // Clears all failed jobs on a queue. Useful for wiping out orphan repeatable
  // jobs that reference deleted orgs (they re-fire forever otherwise).
  r.post(
    '/aligned-admin/queues/:queue/drain-failed',
    {
      schema: {
        tags: ['admin'],
        summary: 'Remove all failed jobs from a BullMQ queue.',
        params: z.object({ queue: z.enum(['import', 'sync', 'webhook']) }),
        response: { 200: itemEnvelopeSchema(z.object({ removed: z.number() })) },
      },
      preHandler: [app.requireAlignedAdmin],
    },
    async (req) => {
      const q =
        req.params.queue === 'import'
          ? getImportQueue()
          : req.params.queue === 'sync'
            ? getSyncQueue()
            : getWebhookQueue();
      // BullMQ `clean(grace, limit, status)` — grace 0 = clear everything.
      const removedIds = await q.clean(0, 10_000, 'failed');
      return { data: { removed: removedIds.length } };
    },
  );
}
