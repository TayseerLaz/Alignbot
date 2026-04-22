import {
  ApiErrorCode,
  categorySchema,
  createCategoryBodySchema,
  itemEnvelopeSchema,
  listEnvelopeSchema,
  reorderCategoriesBodySchema,
  successSchema,
  updateCategoryBodySchema,
  uuidSchema,
} from '@aligned/shared';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { recordAudit } from '../../lib/audit.js';
import { conflict, notFound } from '../../lib/errors.js';
import { slugify } from './shared.js';

export default async function categoryRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  // ---------- GET /categories ---------------------------------------------
  r.get(
    '/categories',
    {
      schema: {
        tags: ['catalog'],
        summary: 'List categories (flat, ordered by parent + sortOrder).',
        response: { 200: listEnvelopeSchema(categorySchema) },
      },
      preHandler: [app.requireRole('viewer')],
    },
    async (req) => {
      return app.tenant(req, async (tx) => {
        const rows = await tx.category.findMany({
          orderBy: [{ parentId: 'asc' }, { sortOrder: 'asc' }, { name: 'asc' }],
        });
        return {
          data: rows.map((c) => ({
            id: c.id,
            parentId: c.parentId,
            name: c.name,
            slug: c.slug,
            description: c.description,
            sortOrder: c.sortOrder,
            isActive: c.isActive,
            createdAt: c.createdAt.toISOString(),
            updatedAt: c.updatedAt.toISOString(),
          })),
          nextCursor: null,
        };
      });
    },
  );

  // ---------- POST /categories --------------------------------------------
  r.post(
    '/categories',
    {
      schema: {
        tags: ['catalog'],
        summary: 'Create a category.',
        body: createCategoryBodySchema,
        response: { 201: itemEnvelopeSchema(categorySchema) },
      },
      preHandler: [app.requireRole('editor')],
    },
    async (req, reply) => {
      return app.tenant(req, async (tx) => {
        const slug = req.body.slug ?? slugify(req.body.name);
        const existing = await tx.category.findUnique({
          where: { organizationId_slug: { organizationId: req.auth!.organizationId, slug } },
        });
        if (existing) throw conflict('A category with that slug already exists.');

        const c = await tx.category.create({
          data: {
            organizationId: req.auth!.organizationId,
            name: req.body.name,
            slug,
            parentId: req.body.parentId ?? null,
            description: req.body.description ?? null,
            sortOrder: req.body.sortOrder ?? 0,
          },
        });
        await recordAudit({
          action: 'category_created',
          organizationId: req.auth!.organizationId,
          actorUserId: req.auth!.userId,
          entityType: 'category',
          entityId: c.id,
        });
        reply.code(201);
        return {
          data: {
            id: c.id,
            parentId: c.parentId,
            name: c.name,
            slug: c.slug,
            description: c.description,
            sortOrder: c.sortOrder,
            isActive: c.isActive,
            createdAt: c.createdAt.toISOString(),
            updatedAt: c.updatedAt.toISOString(),
          },
        };
      });
    },
  );

  // ---------- PATCH /categories/:id ---------------------------------------
  r.patch(
    '/categories/:id',
    {
      schema: {
        tags: ['catalog'],
        summary: 'Update a category.',
        params: z.object({ id: uuidSchema }),
        body: updateCategoryBodySchema,
        response: { 200: itemEnvelopeSchema(categorySchema) },
      },
      preHandler: [app.requireRole('editor')],
    },
    async (req) => {
      return app.tenant(req, async (tx) => {
        const existing = await tx.category.findUnique({ where: { id: req.params.id } });
        if (!existing) throw notFound('Category not found.');
        if (req.body.parentId === existing.id) {
          throw conflict('A category cannot be its own parent.');
        }
        const c = await tx.category.update({
          where: { id: req.params.id },
          data: {
            name: req.body.name ?? undefined,
            slug: req.body.slug ?? undefined,
            parentId: req.body.parentId === undefined ? undefined : req.body.parentId,
            description: req.body.description === undefined ? undefined : req.body.description,
            sortOrder: req.body.sortOrder ?? undefined,
            isActive: req.body.isActive ?? undefined,
          },
        });
        await recordAudit({
          action: 'category_updated',
          organizationId: req.auth!.organizationId,
          actorUserId: req.auth!.userId,
          entityType: 'category',
          entityId: c.id,
        });
        return {
          data: {
            id: c.id,
            parentId: c.parentId,
            name: c.name,
            slug: c.slug,
            description: c.description,
            sortOrder: c.sortOrder,
            isActive: c.isActive,
            createdAt: c.createdAt.toISOString(),
            updatedAt: c.updatedAt.toISOString(),
          },
        };
      });
    },
  );

  // ---------- DELETE /categories/:id --------------------------------------
  r.delete(
    '/categories/:id',
    {
      schema: {
        tags: ['catalog'],
        summary: 'Delete a category. Products/services keep their data; categoryId is cleared.',
        params: z.object({ id: uuidSchema }),
        response: { 200: successSchema },
      },
      preHandler: [app.requireRole('admin')],
    },
    async (req) => {
      return app.tenant(req, async (tx) => {
        const existing = await tx.category.findUnique({ where: { id: req.params.id } });
        if (!existing) throw notFound('Category not found.');
        await tx.category.delete({ where: { id: existing.id } });
        await recordAudit({
          action: 'category_deleted',
          organizationId: req.auth!.organizationId,
          actorUserId: req.auth!.userId,
          entityType: 'category',
          entityId: existing.id,
        });
        return { ok: true as const };
      });
    },
  );

  // ---------- POST /categories/reorder ------------------------------------
  r.post(
    '/categories/reorder',
    {
      schema: {
        tags: ['catalog'],
        summary: 'Bulk update sortOrder on a list of categories.',
        body: reorderCategoriesBodySchema,
        response: { 200: successSchema },
      },
      preHandler: [app.requireRole('editor')],
    },
    async (req) => {
      return app.tenant(req, async (tx) => {
        await Promise.all(
          req.body.order.map((o) =>
            tx.category.updateMany({
              where: { id: o.id, organizationId: req.auth!.organizationId },
              data: { sortOrder: o.sortOrder },
            }),
          ),
        );
        return { ok: true as const };
      });
    },
  );
}
