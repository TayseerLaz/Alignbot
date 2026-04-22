import {
  ApiErrorCode,
  attachImageBodySchema,
  bulkUpdateProductsBodySchema,
  createProductBodySchema,
  itemEnvelopeSchema,
  listEnvelopeSchema,
  productListItemSchema,
  productListQuerySchema,
  productSchema,
  reorderImagesBodySchema,
  setVariantsBodySchema,
  successSchema,
  updateProductBodySchema,
  uuidSchema,
} from '@aligned/shared';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import type { Prisma } from '../../lib/db.js';
import { recordAudit } from '../../lib/audit.js';
import { conflict, notFound } from '../../lib/errors.js';
import { recordRevision } from '../../lib/versioning.js';
import { emitWebhookEvent } from '../../lib/webhooks.js';
import { decodeCursor, encodeCursor, resolveAssetUrl, slugify } from './shared.js';

const SORT_ORDERS: Record<string, Prisma.ProductOrderByWithRelationInput[]> = {
  created_desc: [{ createdAt: 'desc' }, { id: 'desc' }],
  created_asc: [{ createdAt: 'asc' }, { id: 'asc' }],
  name_asc: [{ name: 'asc' }, { id: 'asc' }],
  name_desc: [{ name: 'desc' }, { id: 'desc' }],
  price_asc: [{ priceMinor: 'asc' }, { id: 'asc' }],
  price_desc: [{ priceMinor: 'desc' }, { id: 'desc' }],
};

export default async function productRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  // ---------- GET /products -----------------------------------------------
  r.get(
    '/products',
    {
      schema: {
        tags: ['catalog'],
        summary: 'List products with search, filter, and cursor pagination.',
        querystring: productListQuerySchema,
        response: { 200: listEnvelopeSchema(productListItemSchema) },
      },
      preHandler: [app.requireRole('viewer')],
    },
    async (req) => {
      const q = req.query;
      return app.tenant(req, async (tx) => {
        const where: Prisma.ProductWhereInput = {
          deletedAt: null,
          ...(q.categoryId ? { categoryId: q.categoryId } : {}),
          ...(q.isAvailable !== undefined ? { isAvailable: q.isAvailable } : {}),
          ...(q.minPriceMinor !== undefined || q.maxPriceMinor !== undefined
            ? {
                priceMinor: {
                  ...(q.minPriceMinor !== undefined ? { gte: q.minPriceMinor } : {}),
                  ...(q.maxPriceMinor !== undefined ? { lte: q.maxPriceMinor } : {}),
                },
              }
            : {}),
          ...(q.q
            ? {
                OR: [
                  { name: { contains: q.q, mode: 'insensitive' } },
                  { sku: { contains: q.q, mode: 'insensitive' } },
                  { searchText: { contains: q.q.toLowerCase() } },
                ],
              }
            : {}),
        };
        const cursor = decodeCursor<{ id: string }>(q.cursor);
        const products = await tx.product.findMany({
          where,
          orderBy: SORT_ORDERS[q.sort],
          include: {
            category: { select: { id: true, name: true } },
            images: { orderBy: { sortOrder: 'asc' }, take: 1, include: { asset: true } },
            _count: { select: { variants: true } },
          },
          take: q.limit + 1,
          ...(cursor ? { cursor: { id: cursor.id }, skip: 1 } : {}),
        });
        const hasMore = products.length > q.limit;
        const page = hasMore ? products.slice(0, q.limit) : products;
        const data = await Promise.all(
          page.map(async (p) => ({
            id: p.id,
            sku: p.sku,
            name: p.name,
            slug: p.slug,
            shortDescription: p.shortDescription,
            priceMinor: p.priceMinor,
            currency: p.currency,
            isAvailable: p.isAvailable,
            stockQuantity: p.stockQuantity,
            primaryImageUrl: p.images[0] ? await resolveAssetUrl(p.images[0].asset.storageKey) : null,
            categoryId: p.categoryId,
            categoryName: p.category?.name ?? null,
            variantCount: p._count.variants,
            createdAt: p.createdAt.toISOString(),
            updatedAt: p.updatedAt.toISOString(),
          })),
        );
        return {
          data,
          nextCursor: hasMore ? encodeCursor({ id: page[page.length - 1]!.id }) : null,
        };
      });
    },
  );

  // ---------- POST /products ----------------------------------------------
  r.post(
    '/products',
    {
      schema: {
        tags: ['catalog'],
        summary: 'Create a product.',
        body: createProductBodySchema,
        response: { 201: itemEnvelopeSchema(productSchema) },
      },
      preHandler: [app.requireRole('editor')],
    },
    async (req, reply) => {
      const orgId = req.auth!.organizationId;
      return app.tenant(req, async (tx) => {
        const slug = req.body.slug ?? slugify(req.body.name);
        const dupes = await tx.product.findFirst({
          where: { OR: [{ sku: req.body.sku }, { slug }], deletedAt: null },
        });
        if (dupes) throw conflict('A product with that SKU or slug already exists.');

        const created = await tx.product.create({
          data: {
            organizationId: orgId,
            sku: req.body.sku,
            name: req.body.name,
            slug,
            description: req.body.description ?? null,
            shortDescription: req.body.shortDescription ?? null,
            priceMinor: req.body.priceMinor ?? null,
            compareAtMinor: req.body.compareAtMinor ?? null,
            currency: req.body.currency ?? 'USD',
            isAvailable: req.body.isAvailable ?? true,
            stockQuantity: req.body.stockQuantity ?? null,
            trackInventory: req.body.trackInventory ?? false,
            attributes: req.body.attributes ?? undefined,
            categoryId: req.body.categoryId ?? null,
          },
        });
        await recordAudit({
          action: 'product_created',
          organizationId: orgId,
          actorUserId: req.auth!.userId,
          entityType: 'product',
          entityId: created.id,
        });
        void emitWebhookEvent({
          organizationId: orgId,
          eventKind: 'product_created',
          payload: { id: created.id, sku: created.sku, name: created.name },
        });
        void recordRevision({
          organizationId: orgId,
          entityType: 'product',
          entityId: created.id,
          action: 'created',
          snapshot: created as unknown as Record<string, unknown>,
          actorUserId: req.auth!.userId,
          summary: `Created "${created.name}"`,
        });
        reply.code(201);
        return { data: await loadProduct(tx, created.id) };
      });
    },
  );

  // ---------- GET /products/:id -------------------------------------------
  r.get(
    '/products/:id',
    {
      schema: {
        tags: ['catalog'],
        summary: 'Get one product.',
        params: z.object({ id: uuidSchema }),
        response: { 200: itemEnvelopeSchema(productSchema) },
      },
      preHandler: [app.requireRole('viewer')],
    },
    async (req) => {
      return app.tenant(req, async (tx) => {
        const product = await loadProduct(tx, req.params.id);
        return { data: product };
      });
    },
  );

  // ---------- PATCH /products/:id -----------------------------------------
  r.patch(
    '/products/:id',
    {
      schema: {
        tags: ['catalog'],
        summary: 'Update a product.',
        params: z.object({ id: uuidSchema }),
        body: updateProductBodySchema,
        response: { 200: itemEnvelopeSchema(productSchema) },
      },
      preHandler: [app.requireRole('editor')],
    },
    async (req) => {
      const orgId = req.auth!.organizationId;
      return app.tenant(req, async (tx) => {
        const existing = await tx.product.findUnique({ where: { id: req.params.id } });
        if (!existing || existing.deletedAt) throw notFound('Product not found.');

        const updates: Prisma.ProductUpdateInput = {
          name: req.body.name ?? undefined,
          slug: req.body.slug ?? undefined,
          sku: req.body.sku ?? undefined,
          description: req.body.description === undefined ? undefined : req.body.description,
          shortDescription: req.body.shortDescription === undefined ? undefined : req.body.shortDescription,
          priceMinor: req.body.priceMinor === undefined ? undefined : req.body.priceMinor,
          compareAtMinor: req.body.compareAtMinor === undefined ? undefined : req.body.compareAtMinor,
          currency: req.body.currency ?? undefined,
          isAvailable: req.body.isAvailable ?? undefined,
          stockQuantity: req.body.stockQuantity === undefined ? undefined : req.body.stockQuantity,
          trackInventory: req.body.trackInventory ?? undefined,
          attributes: req.body.attributes === undefined ? undefined : (req.body.attributes as Prisma.InputJsonValue),
          ...(req.body.categoryId === undefined
            ? {}
            : req.body.categoryId === null
              ? { category: { disconnect: true } }
              : { category: { connect: { id: req.body.categoryId } } }),
        };

        const updated = await tx.product.update({ where: { id: existing.id }, data: updates });
        await recordAudit({
          action: 'product_updated',
          organizationId: orgId,
          actorUserId: req.auth!.userId,
          entityType: 'product',
          entityId: existing.id,
        });
        void emitWebhookEvent({
          organizationId: orgId,
          eventKind: 'product_updated',
          payload: { id: existing.id, sku: existing.sku },
        });
        void recordRevision({
          organizationId: orgId,
          entityType: 'product',
          entityId: existing.id,
          action: 'updated',
          snapshot: updated as unknown as Record<string, unknown>,
          actorUserId: req.auth!.userId,
        });
        return { data: await loadProduct(tx, existing.id) };
      });
    },
  );

  // ---------- DELETE /products/:id ----------------------------------------
  r.delete(
    '/products/:id',
    {
      schema: {
        tags: ['catalog'],
        summary: 'Soft-delete a product.',
        params: z.object({ id: uuidSchema }),
        response: { 200: successSchema },
      },
      preHandler: [app.requireRole('editor')],
    },
    async (req) => {
      const orgId = req.auth!.organizationId;
      return app.tenant(req, async (tx) => {
        const existing = await tx.product.findUnique({ where: { id: req.params.id } });
        if (!existing || existing.deletedAt) throw notFound('Product not found.');
        // Append a tombstone marker to sku/slug so the user can recreate a
        // product with the original identifiers — the unique constraint
        // covers soft-deleted rows too.
        const tombstone = `__deleted-${Date.now().toString(36)}`;
        await tx.product.update({
          where: { id: existing.id },
          data: {
            deletedAt: new Date(),
            sku: `${existing.sku}${tombstone}`,
            slug: `${existing.slug}${tombstone}`,
          },
        });
        await recordAudit({
          action: 'product_deleted',
          organizationId: orgId,
          actorUserId: req.auth!.userId,
          entityType: 'product',
          entityId: existing.id,
        });
        void emitWebhookEvent({
          organizationId: orgId,
          eventKind: 'product_deleted',
          payload: { id: existing.id, sku: existing.sku },
        });
        void recordRevision({
          organizationId: orgId,
          entityType: 'product',
          entityId: existing.id,
          action: 'deleted',
          snapshot: existing as unknown as Record<string, unknown>,
          actorUserId: req.auth!.userId,
          summary: `Deleted "${existing.name}"`,
        });
        return { ok: true as const };
      });
    },
  );

  // ---------- PUT /products/:id/variants ----------------------------------
  r.put(
    '/products/:id/variants',
    {
      schema: {
        tags: ['catalog'],
        summary: 'Replace the variant set for a product (idempotent upsert).',
        params: z.object({ id: uuidSchema }),
        body: setVariantsBodySchema,
        response: { 200: itemEnvelopeSchema(productSchema) },
      },
      preHandler: [app.requireRole('editor')],
    },
    async (req) => {
      const orgId = req.auth!.organizationId;
      return app.tenant(req, async (tx) => {
        const product = await tx.product.findUnique({ where: { id: req.params.id } });
        if (!product || product.deletedAt) throw notFound('Product not found.');

        const incomingIds = new Set(
          req.body.variants.filter((v) => v.id).map((v) => v.id as string),
        );
        // Delete variants not in the incoming set.
        await tx.productVariant.deleteMany({
          where: { productId: product.id, id: { notIn: Array.from(incomingIds) } },
        });
        // Upsert each incoming variant.
        for (const [idx, v] of req.body.variants.entries()) {
          if (v.id) {
            await tx.productVariant.update({
              where: { id: v.id },
              data: {
                sku: v.sku,
                name: v.name,
                options: v.options as Prisma.InputJsonValue,
                priceMinor: v.priceMinor ?? null,
                stockQuantity: v.stockQuantity ?? null,
                isAvailable: v.isAvailable ?? true,
                sortOrder: v.sortOrder ?? idx,
              },
            });
          } else {
            await tx.productVariant.create({
              data: {
                organizationId: orgId,
                productId: product.id,
                sku: v.sku,
                name: v.name,
                options: v.options as Prisma.InputJsonValue,
                priceMinor: v.priceMinor ?? null,
                stockQuantity: v.stockQuantity ?? null,
                isAvailable: v.isAvailable ?? true,
                sortOrder: v.sortOrder ?? idx,
              },
            });
          }
        }
        return { data: await loadProduct(tx, product.id) };
      });
    },
  );

  // ---------- POST /products/:id/images -----------------------------------
  r.post(
    '/products/:id/images',
    {
      schema: {
        tags: ['catalog'],
        summary: 'Attach an uploaded asset to a product as an image.',
        params: z.object({ id: uuidSchema }),
        body: attachImageBodySchema,
        response: { 200: itemEnvelopeSchema(productSchema) },
      },
      preHandler: [app.requireRole('editor')],
    },
    async (req) => {
      const orgId = req.auth!.organizationId;
      return app.tenant(req, async (tx) => {
        const product = await tx.product.findUnique({ where: { id: req.params.id } });
        if (!product || product.deletedAt) throw notFound('Product not found.');
        const asset = await tx.asset.findUnique({ where: { id: req.body.assetId } });
        if (!asset) throw notFound('Asset not found.');
        if (asset.kind !== 'image') throw conflict('Asset is not an image.');

        if (req.body.isPrimary) {
          await tx.productImage.updateMany({ where: { productId: product.id }, data: { isPrimary: false } });
        }
        await tx.productImage.create({
          data: {
            organizationId: orgId,
            productId: product.id,
            assetId: asset.id,
            altText: req.body.altText ?? null,
            sortOrder: req.body.sortOrder ?? 0,
            isPrimary: req.body.isPrimary ?? false,
          },
        });
        return { data: await loadProduct(tx, product.id) };
      });
    },
  );

  // ---------- DELETE /products/:id/images/:imageId ------------------------
  r.delete(
    '/products/:id/images/:imageId',
    {
      schema: {
        tags: ['catalog'],
        summary: 'Detach an image from a product (asset is kept).',
        params: z.object({ id: uuidSchema, imageId: uuidSchema }),
        response: { 200: itemEnvelopeSchema(productSchema) },
      },
      preHandler: [app.requireRole('editor')],
    },
    async (req) => {
      return app.tenant(req, async (tx) => {
        await tx.productImage.deleteMany({
          where: { id: req.params.imageId, productId: req.params.id },
        });
        return { data: await loadProduct(tx, req.params.id) };
      });
    },
  );

  // ---------- POST /products/:id/images/reorder ---------------------------
  r.post(
    '/products/:id/images/reorder',
    {
      schema: {
        tags: ['catalog'],
        summary: 'Reorder a product\'s images.',
        params: z.object({ id: uuidSchema }),
        body: reorderImagesBodySchema,
        response: { 200: successSchema },
      },
      preHandler: [app.requireRole('editor')],
    },
    async (req) => {
      return app.tenant(req, async (tx) => {
        await Promise.all(
          req.body.order.map((o) =>
            tx.productImage.updateMany({
              where: { id: o.id, productId: req.params.id },
              data: { sortOrder: o.sortOrder },
            }),
          ),
        );
        return { ok: true as const };
      });
    },
  );

  // ---------- POST /products/bulk-update ----------------------------------
  r.post(
    '/products/bulk-update',
    {
      schema: {
        tags: ['catalog'],
        summary: 'Update fields on many products at once (availability / category).',
        body: bulkUpdateProductsBodySchema,
        response: { 200: itemEnvelopeSchema(z.object({ updated: z.number().int() })) },
      },
      preHandler: [app.requireRole('editor')],
    },
    async (req) => {
      return app.tenant(req, async (tx) => {
        const result = await tx.product.updateMany({
          where: { id: { in: req.body.ids }, deletedAt: null },
          data: {
            ...(req.body.isAvailable !== undefined ? { isAvailable: req.body.isAvailable } : {}),
            ...(req.body.categoryId !== undefined ? { categoryId: req.body.categoryId } : {}),
          },
        });
        return { data: { updated: result.count } };
      });
    },
  );
}

// ---------- helpers ---------------------------------------------------------
async function loadProduct(tx: Prisma.TransactionClient, id: string) {
  const p = await tx.product.findUnique({
    where: { id },
    include: {
      category: { select: { id: true, name: true } },
      images: { orderBy: { sortOrder: 'asc' }, include: { asset: true } },
      variants: { orderBy: { sortOrder: 'asc' } },
    },
  });
  if (!p) throw notFound('Product not found.');
  return {
    id: p.id,
    sku: p.sku,
    name: p.name,
    slug: p.slug,
    description: p.description,
    shortDescription: p.shortDescription,
    priceMinor: p.priceMinor,
    compareAtMinor: p.compareAtMinor,
    currency: p.currency,
    isAvailable: p.isAvailable,
    stockQuantity: p.stockQuantity,
    trackInventory: p.trackInventory,
    attributes: (p.attributes ?? null) as Record<string, unknown> | null,
    categoryId: p.categoryId,
    categoryName: p.category?.name ?? null,
    images: await Promise.all(
      p.images.map(async (img) => ({
        id: img.id,
        assetId: img.assetId,
        url: await resolveAssetUrl(img.asset.storageKey),
        altText: img.altText,
        sortOrder: img.sortOrder,
        isPrimary: img.isPrimary,
      })),
    ),
    variants: p.variants.map((v) => ({
      id: v.id,
      sku: v.sku,
      name: v.name,
      options: (v.options as Record<string, string | number | boolean>) ?? {},
      priceMinor: v.priceMinor,
      stockQuantity: v.stockQuantity,
      isAvailable: v.isAvailable,
      sortOrder: v.sortOrder,
    })),
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  };
}
