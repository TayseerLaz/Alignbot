import {
  ApiErrorCode,
  IMPORT_ENTITY_KINDS,
  type ImportEntityKind,
  importJobRowSchema,
  importJobSchema,
  itemEnvelopeSchema,
  listEnvelopeSchema,
  startImportBodySchema,
  successSchema,
  uuidSchema,
} from '@aligned/shared';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { recordAudit } from '../../lib/audit.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { getImportQueue } from '../../lib/queues.js';
import { isStorageConfigured } from '../../lib/storage.js';

import { buildTemplateXlsx, TEMPLATES } from './template.js';

export default async function importRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  // ---------- GET /imports/templates/:kind --------------------------------
  r.get(
    '/imports/templates/:kind',
    {
      schema: {
        tags: ['imports'],
        summary: 'Download an XLSX import template for the given entity kind.',
        params: z.object({
          kind: z.enum(IMPORT_ENTITY_KINDS as [ImportEntityKind, ...ImportEntityKind[]]),
        }),
      },
      preHandler: [app.requireRole('viewer')],
    },
    async (req, reply) => {
      const buf = await buildTemplateXlsx(req.params.kind);
      reply
        .header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
        .header('Content-Disposition', `attachment; filename="aligned-${req.params.kind}-template.xlsx"`);
      return reply.send(buf);
    },
  );

  // ---------- GET /imports/templates/:kind/fields -------------------------
  // Returns the target field hints — used to drive the column mapping UI.
  r.get(
    '/imports/templates/:kind/fields',
    {
      schema: {
        tags: ['imports'],
        summary: 'List target fields for an entity kind (drives the column mapping UI).',
        params: z.object({
          kind: z.enum(IMPORT_ENTITY_KINDS as [ImportEntityKind, ...ImportEntityKind[]]),
        }),
      },
      preHandler: [app.requireRole('viewer')],
    },
    async (req) => ({ data: TEMPLATES[req.params.kind].fields }),
  );

  // ---------- POST /imports -----------------------------------------------
  r.post(
    '/imports',
    {
      schema: {
        tags: ['imports'],
        summary: 'Start an import from a previously uploaded CSV/XLSX asset.',
        body: startImportBodySchema,
        response: { 202: itemEnvelopeSchema(importJobSchema) },
      },
      preHandler: [app.requireRole('editor')],
    },
    async (req, reply) => {
      if (!isStorageConfigured()) {
        throw badRequest(
          ApiErrorCode.SERVICE_UNAVAILABLE,
          'Object storage not configured — uploads (and therefore imports) are unavailable in this environment.',
        );
      }
      if (!req.body.sourceAssetId) {
        throw badRequest(ApiErrorCode.VALIDATION_ERROR, 'sourceAssetId is required.');
      }
      const orgId = req.auth!.organizationId;
      const job = await app.tenant(req, async (tx) => {
        const asset = await tx.asset.findUnique({ where: { id: req.body.sourceAssetId! } });
        if (!asset) throw notFound('Source asset not found.');
        if (asset.kind !== 'csv_upload')
          throw badRequest(ApiErrorCode.VALIDATION_ERROR, 'Asset must be of kind "csv_upload".');

        return tx.importJob.create({
          data: {
            organizationId: orgId,
            entityKind: req.body.entityKind,
            sourceAssetId: asset.id,
            sourceFilename: (asset.metadata as { filename?: string } | null)?.filename ?? null,
            columnMapping: req.body.columnMapping ?? undefined,
            createdById: req.auth!.userId,
          },
        });
      });

      await getImportQueue().add(
        'import',
        { organizationId: orgId, importJobId: job.id },
        {
          jobId: job.id,
          attempts: 1,
          removeOnComplete: { age: 7 * 24 * 60 * 60, count: 500 },
          removeOnFail: { age: 30 * 24 * 60 * 60 },
        },
      );

      await recordAudit({
        action: 'import_started',
        organizationId: orgId,
        actorUserId: req.auth!.userId,
        entityType: 'import_job',
        entityId: job.id,
        metadata: { entityKind: req.body.entityKind },
      });

      reply.code(202);
      return { data: serializeJob(job) };
    },
  );

  // ---------- GET /imports ------------------------------------------------
  r.get(
    '/imports',
    {
      schema: {
        tags: ['imports'],
        summary: 'List recent import jobs.',
        querystring: z.object({ limit: z.coerce.number().int().min(1).max(100).default(25) }),
        response: { 200: listEnvelopeSchema(importJobSchema) },
      },
      preHandler: [app.requireRole('viewer')],
    },
    async (req) =>
      app.tenant(req, async (tx) => {
        const rows = await tx.importJob.findMany({
          orderBy: { createdAt: 'desc' },
          take: req.query.limit,
        });
        return { data: rows.map(serializeJob), nextCursor: null };
      }),
  );

  // ---------- GET /imports/:id --------------------------------------------
  r.get(
    '/imports/:id',
    {
      schema: {
        tags: ['imports'],
        summary: 'Get an import job by id.',
        params: z.object({ id: uuidSchema }),
        response: { 200: itemEnvelopeSchema(importJobSchema) },
      },
      preHandler: [app.requireRole('viewer')],
    },
    async (req) =>
      app.tenant(req, async (tx) => {
        const job = await tx.importJob.findUnique({ where: { id: req.params.id } });
        if (!job) throw notFound('Import job not found.');
        return { data: serializeJob(job) };
      }),
  );

  // ---------- GET /imports/:id/rows ---------------------------------------
  r.get(
    '/imports/:id/rows',
    {
      schema: {
        tags: ['imports'],
        summary: 'List per-row results for an import job.',
        params: z.object({ id: uuidSchema }),
        querystring: z.object({
          status: z.enum(['succeeded', 'failed', 'skipped']).optional(),
          limit: z.coerce.number().int().min(1).max(500).default(100),
        }),
        response: { 200: listEnvelopeSchema(importJobRowSchema) },
      },
      preHandler: [app.requireRole('viewer')],
    },
    async (req) =>
      app.tenant(req, async (tx) => {
        const rows = await tx.importJobRow.findMany({
          where: { importJobId: req.params.id, ...(req.query.status ? { status: req.query.status } : {}) },
          orderBy: { rowNumber: 'asc' },
          take: req.query.limit,
        });
        return {
          data: rows.map((r) => ({
            id: r.id,
            rowNumber: r.rowNumber,
            status: r.status,
            resultEntityId: r.resultEntityId,
            rawData: (r.rawData ?? null) as Record<string, unknown> | null,
            errors:
              (r.errors as { path: string; message: string }[] | null | undefined) ?? null,
          })),
          nextCursor: null,
        };
      }),
  );

  // ---------- POST /imports/:id/cancel ------------------------------------
  r.post(
    '/imports/:id/cancel',
    {
      schema: {
        tags: ['imports'],
        summary: 'Cancel an in-progress import (best-effort; worker checks between rows).',
        params: z.object({ id: uuidSchema }),
        response: { 200: successSchema },
      },
      preHandler: [app.requireRole('editor')],
    },
    async (req) =>
      app.tenant(req, async (tx) => {
        const job = await tx.importJob.findUnique({ where: { id: req.params.id } });
        if (!job) throw notFound('Import job not found.');
        if (['succeeded', 'failed', 'cancelled', 'partial'].includes(job.status)) {
          return { ok: true as const };
        }
        await tx.importJob.update({ where: { id: job.id }, data: { status: 'cancelled' } });
        return { ok: true as const };
      }),
  );
}

function serializeJob(job: {
  id: string;
  entityKind: ImportEntityKind;
  status:
    | 'pending'
    | 'validating'
    | 'processing'
    | 'succeeded'
    | 'partial'
    | 'failed'
    | 'cancelled';
  sourceFilename: string | null;
  totalRows: number;
  processedRows: number;
  succeededRows: number;
  failedRows: number;
  skippedRows: number;
  startedAt: Date | null;
  finishedAt: Date | null;
  errorMessage: string | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: job.id,
    entityKind: job.entityKind,
    status: job.status,
    sourceFilename: job.sourceFilename,
    totalRows: job.totalRows,
    processedRows: job.processedRows,
    succeededRows: job.succeededRows,
    failedRows: job.failedRows,
    skippedRows: job.skippedRows,
    startedAt: job.startedAt?.toISOString() ?? null,
    finishedAt: job.finishedAt?.toISOString() ?? null,
    errorMessage: job.errorMessage,
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
  };
}
