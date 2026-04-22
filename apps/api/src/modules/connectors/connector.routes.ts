// API connector CRUD + manual sync trigger + webhook URL exposure.
//
// Inbound webhook receiver lives at POST /webhooks/inbound/:connectorId
// (registered separately so it can be unauthenticated + HMAC-verified).
//
// Scheduled jobs are registered as BullMQ "repeatable" jobs whenever a connector
// is created/updated with scheduleCron set. Removing scheduleCron removes the
// repeatable; updating it removes + re-adds.
import {
  ApiErrorCode,
  connectorSchema,
  createConnectorBodySchema,
  itemEnvelopeSchema,
  listEnvelopeSchema,
  successSchema,
  syncRunSchema,
  triggerSyncBodySchema,
  updateConnectorBodySchema,
  uuidSchema,
} from '@aligned/shared';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { recordAudit } from '../../lib/audit.js';
import { generateOpaqueToken } from '../../lib/crypto.js';
import { env } from '../../lib/env.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { getSyncQueue } from '../../lib/queues.js';

function webhookUrlFor(connectorId: string, hasSecret: boolean): string | null {
  if (!hasSecret) return null;
  const base = env.API_PUBLIC_URL.replace(/\/+$/, '');
  return `${base}/api/v1/webhooks/inbound/${connectorId}`;
}

export default async function connectorRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  // ---------- GET /connectors ---------------------------------------------
  r.get(
    '/connectors',
    {
      schema: {
        tags: ['connectors'],
        summary: 'List API connectors.',
        response: { 200: listEnvelopeSchema(connectorSchema) },
      },
      preHandler: [app.requireRole('viewer')],
    },
    async (req) =>
      app.tenant(req, async (tx) => {
        const rows = await tx.apiConnector.findMany({ orderBy: { createdAt: 'desc' } });
        return {
          data: rows.map((c) => ({
            id: c.id,
            name: c.name,
            entityKind: c.entityKind,
            endpointUrl: c.endpointUrl,
            authKind: c.authKind,
            scheduleCron: c.scheduleCron,
            status: c.status,
            webhookUrl: webhookUrlFor(c.id, !!c.webhookSecret),
            lastRunAt: c.lastRunAt?.toISOString() ?? null,
            lastSuccessAt: c.lastSuccessAt?.toISOString() ?? null,
            consecutiveFailures: c.consecutiveFailures,
            createdAt: c.createdAt.toISOString(),
            updatedAt: c.updatedAt.toISOString(),
          })),
          nextCursor: null,
        };
      }),
  );

  // ---------- POST /connectors --------------------------------------------
  r.post(
    '/connectors',
    {
      schema: {
        tags: ['connectors'],
        summary: 'Create an API connector.',
        body: createConnectorBodySchema,
        response: { 201: itemEnvelopeSchema(connectorSchema) },
      },
      preHandler: [app.requireRole('admin')],
    },
    async (req, reply) => {
      const orgId = req.auth!.organizationId;
      if (!req.body.endpointUrl && !req.body.enableInboundWebhook) {
        throw badRequest(
          ApiErrorCode.VALIDATION_ERROR,
          'A connector needs either an endpointUrl (pull) or enableInboundWebhook (push).',
        );
      }
      const webhookSecret = req.body.enableInboundWebhook
        ? `whsec_in_${generateOpaqueToken(24)}`
        : null;
      return app.tenant(req, async (tx) => {
        const created = await tx.apiConnector.create({
          data: {
            organizationId: orgId,
            name: req.body.name,
            entityKind: req.body.entityKind,
            endpointUrl: req.body.endpointUrl ?? null,
            authKind: req.body.authKind ?? 'none',
            authConfig: req.body.authConfig as never,
            scheduleCron: req.body.scheduleCron ?? null,
            columnMapping: req.body.columnMapping as never,
            webhookSecret,
            createdById: req.auth!.userId,
          },
        });
        await recordAudit({
          action: 'connector_created',
          organizationId: orgId,
          actorUserId: req.auth!.userId,
          entityType: 'api_connector',
          entityId: created.id,
        });

        if (created.scheduleCron) {
          await registerScheduledSync(orgId, created.id, created.scheduleCron);
        }

        reply.code(201);
        return {
          data: {
            id: created.id,
            name: created.name,
            entityKind: created.entityKind,
            endpointUrl: created.endpointUrl,
            authKind: created.authKind,
            scheduleCron: created.scheduleCron,
            status: created.status,
            webhookUrl: webhookUrlFor(created.id, !!created.webhookSecret),
            lastRunAt: null,
            lastSuccessAt: null,
            consecutiveFailures: 0,
            createdAt: created.createdAt.toISOString(),
            updatedAt: created.updatedAt.toISOString(),
          },
        };
      });
    },
  );

  // ---------- PATCH /connectors/:id ---------------------------------------
  r.patch(
    '/connectors/:id',
    {
      schema: {
        tags: ['connectors'],
        summary: 'Update a connector.',
        params: z.object({ id: uuidSchema }),
        body: updateConnectorBodySchema,
        response: { 200: itemEnvelopeSchema(connectorSchema) },
      },
      preHandler: [app.requireRole('admin')],
    },
    async (req) => {
      const orgId = req.auth!.organizationId;
      return app.tenant(req, async (tx) => {
        const existing = await tx.apiConnector.findUnique({ where: { id: req.params.id } });
        if (!existing) throw notFound('Connector not found.');
        const updated = await tx.apiConnector.update({
          where: { id: existing.id },
          data: {
            name: req.body.name ?? undefined,
            endpointUrl: req.body.endpointUrl === undefined ? undefined : req.body.endpointUrl,
            authKind: req.body.authKind ?? undefined,
            authConfig:
              req.body.authConfig === undefined ? undefined : (req.body.authConfig as never),
            scheduleCron: req.body.scheduleCron === undefined ? undefined : req.body.scheduleCron,
            columnMapping:
              req.body.columnMapping === undefined ? undefined : (req.body.columnMapping as never),
            status: req.body.status ?? undefined,
          },
        });
        await recordAudit({
          action: 'connector_updated',
          organizationId: orgId,
          actorUserId: req.auth!.userId,
          entityType: 'api_connector',
          entityId: existing.id,
        });

        // Re-register schedule if it changed.
        if (req.body.scheduleCron !== undefined) {
          await unregisterScheduledSync(existing.id, existing.scheduleCron);
          if (updated.scheduleCron) {
            await registerScheduledSync(orgId, updated.id, updated.scheduleCron);
          }
        }

        return {
          data: {
            id: updated.id,
            name: updated.name,
            entityKind: updated.entityKind,
            endpointUrl: updated.endpointUrl,
            authKind: updated.authKind,
            scheduleCron: updated.scheduleCron,
            status: updated.status,
            webhookUrl: webhookUrlFor(updated.id, !!updated.webhookSecret),
            lastRunAt: updated.lastRunAt?.toISOString() ?? null,
            lastSuccessAt: updated.lastSuccessAt?.toISOString() ?? null,
            consecutiveFailures: updated.consecutiveFailures,
            createdAt: updated.createdAt.toISOString(),
            updatedAt: updated.updatedAt.toISOString(),
          },
        };
      });
    },
  );

  // ---------- DELETE /connectors/:id --------------------------------------
  r.delete(
    '/connectors/:id',
    {
      schema: {
        tags: ['connectors'],
        summary: 'Delete a connector and its scheduled job.',
        params: z.object({ id: uuidSchema }),
        response: { 200: successSchema },
      },
      preHandler: [app.requireRole('admin')],
    },
    async (req) => {
      const orgId = req.auth!.organizationId;
      return app.tenant(req, async (tx) => {
        const existing = await tx.apiConnector.findUnique({ where: { id: req.params.id } });
        if (!existing) throw notFound('Connector not found.');
        await unregisterScheduledSync(existing.id, existing.scheduleCron);
        await tx.apiConnector.delete({ where: { id: existing.id } });
        await recordAudit({
          action: 'connector_deleted',
          organizationId: orgId,
          actorUserId: req.auth!.userId,
          entityType: 'api_connector',
          entityId: existing.id,
        });
        return { ok: true as const };
      });
    },
  );

  // ---------- POST /connectors/:id/test -----------------------------------
  // Quick reachability check — returns the upstream HTTP status.
  r.post(
    '/connectors/:id/test',
    {
      schema: {
        tags: ['connectors'],
        summary: 'Probe the upstream endpoint to confirm credentials work.',
        params: z.object({ id: uuidSchema }),
        response: {
          200: itemEnvelopeSchema(z.object({ ok: z.boolean(), status: z.number().nullable(), error: z.string().nullable() })),
        },
      },
      preHandler: [app.requireRole('admin')],
    },
    async (req) => {
      const connector = await app.tenant(req, async (tx) =>
        tx.apiConnector.findUnique({ where: { id: req.params.id } }),
      );
      if (!connector) throw notFound('Connector not found.');
      if (!connector.endpointUrl) {
        return { data: { ok: false, status: null, error: 'No endpointUrl configured.' } };
      }
      const cfg = (connector.authConfig ?? {}) as Record<string, string>;
      const headers: Record<string, string> = { Accept: 'application/json' };
      switch (connector.authKind) {
        case 'bearer':
          if (cfg.token) headers.Authorization = `Bearer ${cfg.token}`;
          break;
        case 'api_key':
          if (cfg.headerName && cfg.value) headers[cfg.headerName] = cfg.value;
          break;
        case 'basic':
          if (cfg.username && cfg.password) {
            headers.Authorization = `Basic ${Buffer.from(`${cfg.username}:${cfg.password}`).toString('base64')}`;
          }
          break;
        default:
          break;
      }
      try {
        const res = await fetch(connector.endpointUrl, {
          method: 'GET',
          headers,
          signal: AbortSignal.timeout(15000),
        });
        return { data: { ok: res.ok, status: res.status, error: res.ok ? null : res.statusText } };
      } catch (err) {
        return { data: { ok: false, status: null, error: err instanceof Error ? err.message : String(err) } };
      }
    },
  );

  // ---------- POST /connectors/:id/sync -----------------------------------
  r.post(
    '/connectors/:id/sync',
    {
      schema: {
        tags: ['connectors'],
        summary: 'Manually trigger a sync run.',
        params: z.object({ id: uuidSchema }),
        body: triggerSyncBodySchema,
        response: { 202: itemEnvelopeSchema(syncRunSchema) },
      },
      preHandler: [app.requireRole('editor')],
    },
    async (req, reply) => {
      const orgId = req.auth!.organizationId;
      const run = await app.tenant(req, async (tx) => {
        const connector = await tx.apiConnector.findUnique({ where: { id: req.params.id } });
        if (!connector) throw notFound('Connector not found.');
        if (connector.status === 'disabled') {
          throw conflict('Connector is disabled.');
        }
        return tx.syncRun.create({
          data: {
            organizationId: orgId,
            connectorId: connector.id,
            trigger: 'manual',
            status: 'pending',
          },
        });
      });
      await getSyncQueue().add(
        'sync',
        { organizationId: orgId, connectorId: req.params.id, syncRunId: run.id, trigger: 'manual' },
        { jobId: run.id, attempts: 1 },
      );
      await recordAudit({
        action: 'connector_sync_started',
        organizationId: orgId,
        actorUserId: req.auth!.userId,
        entityType: 'sync_run',
        entityId: run.id,
      });
      reply.code(202);
      return {
        data: {
          id: run.id,
          connectorId: run.connectorId,
          trigger: run.trigger,
          status: run.status,
          startedAt: null,
          finishedAt: null,
          recordsFetched: 0,
          recordsUpserted: 0,
          recordsFailed: 0,
          errorMessage: null,
          createdAt: run.createdAt.toISOString(),
        },
      };
    },
  );

  // ---------- GET /connectors/:id/runs ------------------------------------
  r.get(
    '/connectors/:id/runs',
    {
      schema: {
        tags: ['connectors'],
        summary: 'List recent sync runs for a connector.',
        params: z.object({ id: uuidSchema }),
        querystring: z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }),
        response: { 200: listEnvelopeSchema(syncRunSchema) },
      },
      preHandler: [app.requireRole('viewer')],
    },
    async (req) =>
      app.tenant(req, async (tx) => {
        const rows = await tx.syncRun.findMany({
          where: { connectorId: req.params.id },
          orderBy: { createdAt: 'desc' },
          take: req.query.limit,
        });
        return {
          data: rows.map((r) => ({
            id: r.id,
            connectorId: r.connectorId,
            trigger: r.trigger,
            status: r.status,
            startedAt: r.startedAt?.toISOString() ?? null,
            finishedAt: r.finishedAt?.toISOString() ?? null,
            recordsFetched: r.recordsFetched,
            recordsUpserted: r.recordsUpserted,
            recordsFailed: r.recordsFailed,
            errorMessage: r.errorMessage,
            createdAt: r.createdAt.toISOString(),
          })),
          nextCursor: null,
        };
      }),
  );
}

// ---------- BullMQ scheduling helpers ---------------------------------------
async function registerScheduledSync(organizationId: string, connectorId: string, cron: string) {
  await getSyncQueue().add(
    'sync',
    { organizationId, connectorId, syncRunId: '__pending__', trigger: 'scheduled' as const },
    {
      // BullMQ will produce a fresh syncRunId at execution time via the worker
      // wrapper (we emit a placeholder here; the worker creates the SyncRun
      // inside its job handler when it sees the placeholder).
      repeat: { pattern: cron },
      jobId: `connector:${connectorId}`,
    },
  );
}

async function unregisterScheduledSync(connectorId: string, cron: string | null) {
  if (!cron) return;
  try {
    await getSyncQueue().removeRepeatable('sync', { pattern: cron }, `connector:${connectorId}`);
  } catch {
    // ignore — repeatable might already be gone
  }
}
