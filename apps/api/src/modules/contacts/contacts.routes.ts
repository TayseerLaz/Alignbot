// Phase 4 — Contacts CRUD.
//
// Persistent per-org address book. Used as a recipient source for broadcasts
// (manual + segment audiences) and auto-populated from the inbox when a new
// customer message arrives. All queries are tenant-scoped via app.tenant().
import type { ContactSource } from '@aligned/db';
import {
  ApiErrorCode,
  contactDtoSchema,
  createContactBodySchema,
  itemEnvelopeSchema,
  listContactsQuerySchema,
  listEnvelopeSchema,
  successSchema,
  updateContactBodySchema,
  uuidSchema,
} from '@aligned/shared';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { recordAudit } from '../../lib/audit.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';

const tagBodySchema = z.object({ tag: z.string().trim().min(1).max(40) });

interface ContactRow {
  id: string;
  phoneE164: string;
  displayName: string | null;
  whatsappName: string | null;
  locale: string | null;
  optedInAt: Date | null;
  optedOutAt: Date | null;
  timezone: string | null;
  attributes: unknown;
  source: ContactSource;
  lastInboundAt: Date | null;
  lastOutboundAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  tags?: { tag: string }[];
}

function toContactDto(row: ContactRow) {
  return {
    id: row.id,
    phoneE164: row.phoneE164,
    displayName: row.displayName,
    whatsappName: row.whatsappName,
    locale: row.locale,
    optedInAt: row.optedInAt?.toISOString() ?? null,
    optedOutAt: row.optedOutAt?.toISOString() ?? null,
    timezone: row.timezone,
    attributes:
      row.attributes && typeof row.attributes === 'object'
        ? (row.attributes as Record<string, string | number | boolean | null>)
        : {},
    source: row.source,
    tags: (row.tags ?? []).map((t) => t.tag),
    lastInboundAt: row.lastInboundAt?.toISOString() ?? null,
    lastOutboundAt: row.lastOutboundAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export default async function contactsRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  // ---------- GET /contacts -------------------------------------------------
  r.get(
    '/contacts',
    {
      schema: {
        tags: ['contacts'],
        summary: 'List contacts (tenant-scoped, soft-deleted excluded).',
        querystring: listContactsQuerySchema,
        response: { 200: listEnvelopeSchema(contactDtoSchema) },
      },
      preHandler: [app.requireRole('viewer')],
    },
    async (req) =>
      app.tenant(req, async (tx) => {
        const { search, tag, cursor, limit } = req.query;
        const where: Record<string, unknown> = { deletedAt: null };
        if (search) {
          const trimmed = search.trim();
          where.OR = [
            { phoneE164: { contains: trimmed, mode: 'insensitive' } },
            { displayName: { contains: trimmed, mode: 'insensitive' } },
          ];
        }
        if (tag) {
          where.tags = { some: { tag } };
        }
        const rows = await tx.contact.findMany({
          where,
          include: { tags: { select: { tag: true } } },
          take: limit + 1,
          ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        });
        const hasMore = rows.length > limit;
        const slice = hasMore ? rows.slice(0, limit) : rows;
        return {
          data: slice.map(toContactDto),
          nextCursor: hasMore ? (slice[slice.length - 1]?.id ?? null) : null,
        };
      }),
  );

  // ---------- POST /contacts ------------------------------------------------
  r.post(
    '/contacts',
    {
      schema: {
        tags: ['contacts'],
        summary: 'Create a contact.',
        body: createContactBodySchema,
        response: { 201: itemEnvelopeSchema(contactDtoSchema) },
      },
      preHandler: [app.requireRole('editor')],
    },
    async (req, reply) => {
      const orgId = req.auth!.organizationId;
      const body = req.body;
      const result = await app.tenant(req, async (tx) => {
        // Soft-undelete if the phone exists but is marked deleted.
        const existing = await tx.contact.findUnique({
          where: { organizationId_phoneE164: { organizationId: orgId, phoneE164: body.phoneE164 } },
        });
        if (existing && !existing.deletedAt) {
          throw conflict('A contact with this phone number already exists.');
        }
        const optedInAt = body.optedIn === true ? new Date() : body.optedIn === false ? null : undefined;
        const optedOutAt =
          body.optedOut === true ? new Date() : body.optedOut === false ? null : undefined;
        const upserted = await tx.contact.upsert({
          where: { organizationId_phoneE164: { organizationId: orgId, phoneE164: body.phoneE164 } },
          create: {
            organizationId: orgId,
            phoneE164: body.phoneE164,
            displayName: body.displayName ?? null,
            locale: body.locale ?? null,
            timezone: body.timezone ?? null,
            optedInAt: optedInAt ?? null,
            optedOutAt: optedOutAt ?? null,
            attributes: (body.attributes ?? {}) as never,
            source: 'manual',
          },
          update: {
            deletedAt: null,
            displayName: body.displayName ?? null,
            locale: body.locale ?? null,
            timezone: body.timezone ?? undefined,
            optedInAt,
            optedOutAt,
            attributes: (body.attributes ?? {}) as never,
          },
          include: { tags: { select: { tag: true } } },
        });
        if (body.tags && body.tags.length > 0) {
          await tx.contactTag.createMany({
            data: body.tags.map((tag) => ({
              organizationId: orgId,
              contactId: upserted.id,
              tag,
            })),
            skipDuplicates: true,
          });
          upserted.tags = await tx.contactTag.findMany({
            where: { contactId: upserted.id },
            select: { tag: true },
          });
        }
        return upserted;
      });
      await recordAudit({
        action: 'contact_created',
        organizationId: orgId,
        actorUserId: req.auth!.userId,
        entityType: 'contact',
        entityId: result.id,
      });
      reply.code(201);
      return { data: toContactDto(result) };
    },
  );

  // ---------- PATCH /contacts/:id ------------------------------------------
  r.patch(
    '/contacts/:id',
    {
      schema: {
        tags: ['contacts'],
        summary: 'Update a contact.',
        params: z.object({ id: uuidSchema }),
        body: updateContactBodySchema,
        response: { 200: itemEnvelopeSchema(contactDtoSchema) },
      },
      preHandler: [app.requireRole('editor')],
    },
    async (req) => {
      const orgId = req.auth!.organizationId;
      const id = req.params.id;
      const body = req.body;
      const result = await app.tenant(req, async (tx) => {
        const existing = await tx.contact.findUnique({ where: { id } });
        if (!existing || existing.deletedAt) throw notFound('Contact not found.');
        // Phone changes require uniqueness check.
        if (body.phoneE164 && body.phoneE164 !== existing.phoneE164) {
          const dup = await tx.contact.findUnique({
            where: {
              organizationId_phoneE164: { organizationId: orgId, phoneE164: body.phoneE164 },
            },
          });
          if (dup && dup.id !== id) throw conflict('That phone number belongs to another contact.');
        }
        const updated = await tx.contact.update({
          where: { id },
          data: {
            phoneE164: body.phoneE164 ?? undefined,
            displayName: body.displayName !== undefined ? body.displayName : undefined,
            locale: body.locale !== undefined ? body.locale : undefined,
            attributes: body.attributes !== undefined ? (body.attributes as never) : undefined,
          },
          include: { tags: { select: { tag: true } } },
        });
        if (body.tags) {
          // Replace-set semantics for tags.
          await tx.contactTag.deleteMany({ where: { contactId: id } });
          if (body.tags.length > 0) {
            await tx.contactTag.createMany({
              data: body.tags.map((tag) => ({
                organizationId: orgId,
                contactId: id,
                tag,
              })),
              skipDuplicates: true,
            });
          }
          updated.tags = await tx.contactTag.findMany({
            where: { contactId: id },
            select: { tag: true },
          });
        }
        return updated;
      });
      await recordAudit({
        action: 'contact_updated',
        organizationId: orgId,
        actorUserId: req.auth!.userId,
        entityType: 'contact',
        entityId: id,
      });
      return { data: toContactDto(result) };
    },
  );

  // ---------- DELETE /contacts/:id (soft) -----------------------------------
  r.delete(
    '/contacts/:id',
    {
      schema: {
        tags: ['contacts'],
        summary: 'Soft-delete a contact (recipient lookups still work for past broadcasts).',
        params: z.object({ id: uuidSchema }),
        response: { 200: successSchema },
      },
      preHandler: [app.requireRole('admin')],
    },
    async (req) => {
      const orgId = req.auth!.organizationId;
      const id = req.params.id;
      await app.tenant(req, async (tx) => {
        const existing = await tx.contact.findUnique({ where: { id } });
        if (!existing) throw notFound('Contact not found.');
        if (!existing.deletedAt) {
          await tx.contact.update({ where: { id }, data: { deletedAt: new Date() } });
        }
      });
      await recordAudit({
        action: 'contact_deleted',
        organizationId: orgId,
        actorUserId: req.auth!.userId,
        entityType: 'contact',
        entityId: id,
      });
      return { ok: true as const };
    },
  );

  // ---------- POST /contacts/:id/tags --------------------------------------
  r.post(
    '/contacts/:id/tags',
    {
      schema: {
        tags: ['contacts'],
        summary: 'Add a tag to a contact.',
        params: z.object({ id: uuidSchema }),
        body: tagBodySchema,
        response: { 200: itemEnvelopeSchema(contactDtoSchema) },
      },
      preHandler: [app.requireRole('editor')],
    },
    async (req) => {
      const orgId = req.auth!.organizationId;
      const id = req.params.id;
      const tag = req.body.tag;
      const result = await app.tenant(req, async (tx) => {
        const existing = await tx.contact.findUnique({ where: { id } });
        if (!existing || existing.deletedAt) throw notFound('Contact not found.');
        await tx.contactTag.upsert({
          where: { contactId_tag: { contactId: id, tag } },
          create: { organizationId: orgId, contactId: id, tag },
          update: {},
        });
        return tx.contact.findUniqueOrThrow({
          where: { id },
          include: { tags: { select: { tag: true } } },
        });
      });
      return { data: toContactDto(result) };
    },
  );

  // ---------- DELETE /contacts/:id/tags/:tag --------------------------------
  r.delete(
    '/contacts/:id/tags/:tag',
    {
      schema: {
        tags: ['contacts'],
        summary: 'Remove a tag from a contact.',
        params: z.object({
          id: uuidSchema,
          tag: z.string().trim().min(1).max(40),
        }),
        response: { 200: itemEnvelopeSchema(contactDtoSchema) },
      },
      preHandler: [app.requireRole('editor')],
    },
    async (req) => {
      const id = req.params.id;
      const tag = req.params.tag;
      const result = await app.tenant(req, async (tx) => {
        const existing = await tx.contact.findUnique({ where: { id } });
        if (!existing || existing.deletedAt) throw notFound('Contact not found.');
        await tx.contactTag
          .delete({ where: { contactId_tag: { contactId: id, tag } } })
          .catch(() => undefined);
        return tx.contact.findUniqueOrThrow({
          where: { id },
          include: { tags: { select: { tag: true } } },
        });
      });
      return { data: toContactDto(result) };
    },
  );

  // ---------- GET /contacts/tags --------------------------------------------
  // Returns the distinct tag list with counts. Used by the segment editor.
  r.get(
    '/contacts/tags',
    {
      schema: {
        tags: ['contacts'],
        summary: 'List distinct tags used by contacts (with counts).',
        response: {
          200: z.object({
            data: z.array(z.object({ tag: z.string(), count: z.number().int() })),
          }),
        },
      },
      preHandler: [app.requireRole('viewer')],
    },
    async (req) =>
      app.tenant(req, async (tx) => {
        const grouped = await tx.contactTag.groupBy({
          by: ['tag'],
          _count: { tag: true },
          orderBy: { _count: { tag: 'desc' } },
          take: 200,
        });
        return {
          data: grouped.map((g) => ({ tag: g.tag, count: g._count.tag })),
        };
      }),
  );

  // ---------- GET /contacts/:id ---------------------------------------------
  r.get(
    '/contacts/:id',
    {
      schema: {
        tags: ['contacts'],
        summary: 'Fetch a contact by id.',
        params: z.object({ id: uuidSchema }),
        response: { 200: itemEnvelopeSchema(contactDtoSchema) },
      },
      preHandler: [app.requireRole('viewer')],
    },
    async (req) =>
      app.tenant(req, async (tx) => {
        const row = await tx.contact.findUnique({
          where: { id: req.params.id },
          include: { tags: { select: { tag: true } } },
        });
        if (!row || row.deletedAt) throw notFound('Contact not found.');
        return { data: toContactDto(row) };
      }),
  );

  // ---------- POST /contacts/import (CSV via existing asset) ---------------
  // Streams a previously-uploaded CSV asset and upserts contacts. Synchronous
  // for v1 (good enough for ≤ 50K rows); large imports can move to the
  // existing import worker later if needed.
  r.post(
    '/contacts/import',
    {
      schema: {
        tags: ['contacts'],
        summary: 'Import contacts from a CSV asset already uploaded via /assets/upload-csv.',
        body: z.object({
          assetId: uuidSchema,
          // Optional column overrides — by default we look for "phone", "name",
          // "locale", and the rest land in attributes.
          phoneColumn: z.string().optional(),
          nameColumn: z.string().optional(),
          localeColumn: z.string().optional(),
          tagColumn: z.string().optional(), // comma-separated tags per row
        }),
        response: {
          200: z.object({
            data: z.object({
              total: z.number().int(),
              created: z.number().int(),
              updated: z.number().int(),
              skipped: z.number().int(),
              errors: z.array(z.object({ row: z.number().int(), error: z.string() })).max(100),
            }),
          }),
        },
      },
      preHandler: [app.requireRole('editor')],
    },
    async (req) => {
      // Defer the streaming logic to a small helper kept alongside the broadcast
      // module so we don't pull a heavy CSV path into routes.
      const { importContactsFromCsv } = await import('./import-csv.js');
      const result = await importContactsFromCsv({
        organizationId: req.auth!.organizationId,
        assetId: req.body.assetId,
        phoneColumn: req.body.phoneColumn,
        nameColumn: req.body.nameColumn,
        localeColumn: req.body.localeColumn,
        tagColumn: req.body.tagColumn,
      });
      if (result.total === 0) {
        throw badRequest(ApiErrorCode.VALIDATION_ERROR, 'CSV had no readable rows.');
      }
      return { data: result };
    },
  );
}
