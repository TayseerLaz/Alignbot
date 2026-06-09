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

  // ---------- GET /contacts/overview ---------------------------------------
  // Everything we know about ONE customer, keyed by phone (E.164). Powers the
  // "User info" slide-over in both the inbox and the contacts page: profile +
  // tags + the AI's per-contact memory + recent orders + recent bookings +
  // message activity. All reads are tenant-scoped via app.tenant().
  const overviewResponse = itemEnvelopeSchema(
    z.object({
      contact: z
        .object({
          id: uuidSchema,
          phoneE164: z.string(),
          displayName: z.string().nullable(),
          whatsappName: z.string().nullable(),
          optedInAt: z.string().nullable(),
          optedOutAt: z.string().nullable(),
          timezone: z.string().nullable(),
          source: z.string(),
          tags: z.array(z.string()),
          lastInboundAt: z.string().nullable(),
          lastOutboundAt: z.string().nullable(),
          createdAt: z.string().nullable(),
        })
        .nullable(),
      memory: z
        .object({
          persona: z.string().nullable(),
          language: z.string().nullable(),
          facts: z.record(z.string(), z.unknown()),
          lastSummaryAt: z.string().nullable(),
        })
        .nullable(),
      orders: z.array(
        z.object({
          id: uuidSchema,
          createdAt: z.string(),
          status: z.string(),
          totalMinor: z.number(),
          currency: z.string(),
          itemsCount: z.number(),
          items: z.array(z.object({ name: z.string(), quantity: z.number() })),
        }),
      ),
      bookings: z.array(
        z.object({
          id: uuidSchema,
          status: z.string(),
          appointmentAt: z.string().nullable(),
          notes: z.string().nullable(),
          createdAt: z.string(),
          // The actual form answers (Full name, Preferred date, …) — this is
          // the real content; appointmentAt is often null for free-text dates.
          fields: z.array(z.object({ label: z.string(), value: z.string() })),
        }),
      ),
      stats: z.object({
        inboundCount: z.number(),
        outboundCount: z.number(),
        threadId: uuidSchema.nullable(),
      }),
    }),
  );

  r.get(
    '/contacts/overview',
    {
      schema: {
        tags: ['contacts'],
        summary: 'Full profile for one customer (by phone): info, memory, orders, bookings.',
        querystring: z.object({ phone: z.string().trim().min(3).max(32) }),
        response: { 200: overviewResponse },
      },
      preHandler: [app.requireRole('viewer')],
    },
    async (req) =>
      app.tenant(req, async (tx) => {
        // Phone formats are inconsistent across tables: the bot stores
        // threads / carts / bookings / contact_memory WITHOUT a leading "+"
        // (raw Meta wa_id), while contacts are stored WITH it (E.164). So we
        // match against BOTH forms — otherwise the inbox (no "+") would miss
        // the contact/tags and the contacts page ("+") would miss memory +
        // orders + bookings. Querying all variants makes both surfaces show
        // the identical, complete profile.
        const rawPhone = req.query.phone.trim();
        const digits = rawPhone.replace(/[^0-9]/g, '');
        const phones = Array.from(new Set([rawPhone, digits, `+${digits}`].filter(Boolean)));
        // RLS scopes every query to the caller's org.
        const [contact, memory, carts, bookings, thread] = await Promise.all([
          tx.contact.findFirst({
            where: { phoneE164: { in: phones }, deletedAt: null },
            include: { tags: { select: { tag: true } } },
          }),
          tx.contactMemory.findFirst({ where: { phoneE164: { in: phones } } }),
          tx.cart.findMany({
            where: { customerPhone: { in: phones }, itemsCount: { gt: 0 } },
            orderBy: { createdAt: 'desc' },
            take: 10,
            include: { items: { select: { name: true, quantity: true } } },
          }),
          tx.booking.findMany({
            where: { customerPhone: { in: phones } },
            orderBy: { createdAt: 'desc' },
            take: 10,
          }),
          tx.whatsAppThread.findFirst({
            where: { customerPhone: { in: phones } },
            select: { id: true, inboundCount: true, outboundCount: true },
          }),
        ]);

        const facts =
          memory?.facts && typeof memory.facts === 'object' && !Array.isArray(memory.facts)
            ? (memory.facts as Record<string, unknown>)
            : {};

        return {
          data: {
            contact: contact
              ? {
                  id: contact.id,
                  phoneE164: contact.phoneE164,
                  displayName: contact.displayName,
                  whatsappName: contact.whatsappName,
                  optedInAt: contact.optedInAt?.toISOString() ?? null,
                  optedOutAt: contact.optedOutAt?.toISOString() ?? null,
                  timezone: contact.timezone,
                  source: contact.source,
                  tags: contact.tags.map((t) => t.tag),
                  lastInboundAt: contact.lastInboundAt?.toISOString() ?? null,
                  lastOutboundAt: contact.lastOutboundAt?.toISOString() ?? null,
                  createdAt: contact.createdAt.toISOString(),
                }
              : null,
            memory: memory
              ? {
                  persona: memory.persona,
                  language: memory.language,
                  facts,
                  lastSummaryAt: memory.lastSummaryAt?.toISOString() ?? null,
                }
              : null,
            orders: carts.map((c) => ({
              id: c.id,
              createdAt: c.createdAt.toISOString(),
              status: c.status,
              totalMinor: c.totalMinor,
              currency: c.currency,
              itemsCount: c.itemsCount,
              items: c.items.map((i) => ({ name: i.name, quantity: i.quantity })),
            })),
            bookings: bookings.map((b) => ({
              id: b.id,
              status: b.status,
              appointmentAt: b.appointmentAt?.toISOString() ?? null,
              notes: b.notes,
              createdAt: b.createdAt.toISOString(),
              fields: Array.isArray(b.fields)
                ? (b.fields as { label?: unknown; key?: unknown; value?: unknown }[])
                    .filter((f) => f && f.value != null && String(f.value).trim() !== '')
                    .map((f) => ({
                      label: String(f.label ?? f.key ?? ''),
                      value: String(f.value),
                    }))
                : [],
            })),
            stats: {
              inboundCount: thread?.inboundCount ?? 0,
              outboundCount: thread?.outboundCount ?? 0,
              threadId: thread?.id ?? null,
            },
          },
        };
      }),
  );

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
        // Bidirectional name sync: when /contacts updates displayName,
        // mirror it onto any matching WhatsApp thread's customerName so
        // the inbox header reflects the rename. Thread → contact is
        // already wired in the /inbox patch route. Match by the raw
        // phone (threads strip the leading "+") as well as the E.164
        // form, since older rows might have either.
        if (body.displayName !== undefined) {
          const stripped = updated.phoneE164.replace(/^\+/, '');
          await tx.whatsAppThread.updateMany({
            where: {
              organizationId: orgId,
              OR: [
                { customerPhone: updated.phoneE164 },
                { customerPhone: stripped },
              ],
            },
            data: { customerName: body.displayName },
          });
        }
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
