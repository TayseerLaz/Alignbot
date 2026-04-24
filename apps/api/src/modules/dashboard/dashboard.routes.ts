// Portal dashboard summary. Powers the widgets on /dashboard:
//   - counts (products, services, faqs, connectors, api keys)
//   - last sync timestamp across all connectors
//   - per-connector status breakdown (for the "API connection status" widget)
//   - recent audit events (for the "Activity log" widget)
//
// Cached in Redis for 30s per-org. Cache is flushed lazily on TTL expiry —
// this endpoint is read-heavy and the data is time-windowed status, not
// critical-path catalog, so 30s staleness is fine.
import {
  itemEnvelopeSchema,
  uuidSchema,
} from '@aligned/shared';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { getRedis } from '../../lib/redis.js';

const CACHE_TTL_SECONDS = 30;
const cacheKey = (orgId: string) => `dashboard:summary:${orgId}`;

const dashboardSummarySchema = z.object({
  counts: z.object({
    products: z.number().int(),
    services: z.number().int(),
    faqs: z.number().int(),
    connectors: z.number().int(),
    apiKeys: z.number().int(),
    webhookEndpoints: z.number().int(),
  }),
  lastSyncAt: z.string().datetime().nullable(),
  connectorStatus: z.array(
    z.object({
      id: uuidSchema,
      name: z.string(),
      status: z.string(),
      lastRunAt: z.string().datetime().nullable(),
      lastSuccessAt: z.string().datetime().nullable(),
      consecutiveFailures: z.number().int(),
    }),
  ),
  recentAudits: z.array(
    z.object({
      id: uuidSchema,
      action: z.string(),
      entityType: z.string().nullable(),
      entityId: uuidSchema.nullable(),
      actorName: z.string().nullable(),
      actorEmail: z.string().nullable(),
      createdAt: z.string().datetime(),
    }),
  ),
});

export default async function dashboardRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  // ---------- GET /dashboard/summary --------------------------------------
  r.get(
    '/dashboard/summary',
    {
      schema: {
        tags: ['dashboard'],
        summary: 'Counts + last sync + connector status + recent audit entries.',
        response: { 200: itemEnvelopeSchema(dashboardSummarySchema) },
      },
      preHandler: [app.requireRole('viewer')],
    },
    async (req) => {
      const orgId = req.auth!.organizationId;
      const redis = getRedis();

      // Cache-first.
      const cached = await redis.get(cacheKey(orgId)).catch(() => null);
      if (cached) {
        try {
          return { data: JSON.parse(cached) };
        } catch {
          // fall through — refetch.
        }
      }

      const data = await app.tenant(req, async (tx) => {
        const [
          products,
          services,
          faqs,
          connectors,
          apiKeys,
          webhookEndpoints,
          lastSync,
          connectorRows,
          auditRows,
        ] = await Promise.all([
          tx.product.count({ where: { deletedAt: null } }),
          tx.service.count({ where: { deletedAt: null } }),
          tx.fAQ.count({ where: { visibility: 'public' } }),
          tx.apiConnector.count(),
          tx.apiKey.count({ where: { revokedAt: null } }),
          tx.webhookEndpoint.count(),
          tx.syncRun.findFirst({
            where: { finishedAt: { not: null } },
            orderBy: { finishedAt: 'desc' },
            select: { finishedAt: true },
          }),
          tx.apiConnector.findMany({
            orderBy: { createdAt: 'desc' },
            take: 20,
            select: {
              id: true,
              name: true,
              status: true,
              lastRunAt: true,
              lastSuccessAt: true,
              consecutiveFailures: true,
            },
          }),
          tx.auditLog.findMany({
            orderBy: { createdAt: 'desc' },
            take: 10,
            include: {
              actor: { select: { firstName: true, lastName: true, email: true } },
            },
          }),
        ]);

        return {
          counts: {
            products,
            services,
            faqs,
            connectors,
            apiKeys,
            webhookEndpoints,
          },
          lastSyncAt: lastSync?.finishedAt?.toISOString() ?? null,
          connectorStatus: connectorRows.map((c) => ({
            id: c.id,
            name: c.name,
            status: c.status,
            lastRunAt: c.lastRunAt?.toISOString() ?? null,
            lastSuccessAt: c.lastSuccessAt?.toISOString() ?? null,
            consecutiveFailures: c.consecutiveFailures,
          })),
          recentAudits: auditRows.map((a) => {
            const actorName =
              a.actor && (a.actor.firstName || a.actor.lastName)
                ? `${a.actor.firstName ?? ''} ${a.actor.lastName ?? ''}`.trim()
                : null;
            return {
              id: a.id,
              action: a.action,
              entityType: a.entityType,
              entityId: a.entityId,
              actorName,
              actorEmail: a.actor?.email ?? null,
              createdAt: a.createdAt.toISOString(),
            };
          }),
        };
      });

      await redis.setex(cacheKey(orgId), CACHE_TTL_SECONDS, JSON.stringify(data)).catch(() => {});
      return { data };
    },
  );
}
