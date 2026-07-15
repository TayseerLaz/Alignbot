// Partner provisioning — Alinia → Hader.
//
// When an Alinia super-admin approves an agency's "Connect to Hader" request,
// Alinia calls this endpoint (authenticated by a shared X-Partner-Secret) to
// provision the federated Hader tenant: an org + a passwordless-in-practice
// federated admin (aliniaSubject + random break-glass password), a free
// subscription, seeded BusinessInfo, and the alinia_listings feature enabled.
//
// Idempotent: re-calling for the same aliniaSubject returns the existing org.
// This is the ONLY inbound surface that creates an org, so it is deliberately
// narrow (this one route) and NOT reachable via the aligned-admin principal.
import { ApiErrorCode, ORG_FEATURE_DEFAULT_DISABLED } from '@aligned/shared';
import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { recordAudit } from '../../lib/audit.js';
import { generateTempPassword, hashPassword } from '../../lib/crypto.js';
import { prisma, withAliniaSync, withRlsBypass } from '../../lib/db.js';
import { env } from '../../lib/env.js';
import { conflict, unauthorized } from '../../lib/errors.js';
import { slugify } from '../catalog/shared.js';

function partnerSecretOk(headerVal: string | undefined): boolean {
  const expected = env.PARTNER_PROVISION_SECRET;
  if (!expected || !headerVal) return false;
  const a = Buffer.from(headerVal);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

const provisionBody = z.object({
  aliniaSubject: z.string().min(1), // Alinia identity_id — the federation subject
  aliniaAgencyId: z.string().min(1),
  agencyName: z.string().min(1).max(120),
  email: z.string().email().optional(),
  phone: z.string().optional(),
  name: z.string().optional(),
  currency: z.string().length(3).optional(),
  timezone: z.string().optional(),
  languages: z.array(z.string()).optional(),
});

const provisionResponse = z.object({
  haderOrgId: z.string(),
  adminUserId: z.string(),
  adminEmail: z.string(),
  alreadyProvisioned: z.boolean(),
});

export default async function partnerRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.post(
    '/partner/provision',
    {
      schema: {
        tags: ['partner'],
        summary: 'Alinia → Hader: provision (or return) the federated tenant for a connected agency.',
        body: provisionBody,
        response: { 200: provisionResponse },
      },
    },
    async (req) => {
      const sig = req.headers['x-partner-secret'];
      if (!partnerSecretOk(Array.isArray(sig) ? sig[0] : sig)) {
        throw unauthorized(ApiErrorCode.AUTH_TOKEN_INVALID, 'Invalid partner credential.');
      }
      const b = req.body;

      return withRlsBypass(async (tx) => {
        // Idempotency: this Alinia subject already has a federated Hader user.
        const existing = await tx.user.findUnique({
          where: { aliniaSubject: b.aliniaSubject },
          include: { memberships: true },
        });
        if (existing) {
          const m = existing.memberships.find((mm) => mm.isActive);
          return {
            haderOrgId: m?.organizationId ?? '',
            adminUserId: existing.id,
            adminEmail: existing.email,
            alreadyProvisioned: true,
          };
        }

        // Synthesize an email for phone-only owners; never link to a pre-existing
        // native Hader user by email (that would be an account-takeover primitive).
        const email = b.email ?? `alinia+${b.aliniaSubject}@tenants.hader.ai`;
        const emailClash = await tx.user.findUnique({ where: { email } });
        if (emailClash) {
          throw conflict('A Hader user with this email already exists; cannot federate.');
        }

        const base = slugify(b.agencyName) || 'agency';
        let slug = base;
        for (let n = 2; n < 60; n++) {
          const taken = await tx.organization.findUnique({ where: { slug } });
          if (!taken) break;
          slug = `${base}-${n}`;
        }

        // Enable alinia_listings for this org (drop it from the default-disabled set).
        const disabledFeatures = ORG_FEATURE_DEFAULT_DISABLED.filter((k) => k !== 'alinia_listings');

        const org = await tx.organization.create({
          data: { slug, name: b.agencyName, status: 'active', aiPlan: 'basic', disabledFeatures },
        });

        // Random break-glass password (native login/reset stays available); login
        // is normally via "Sign in with Alinia". aliniaSubject links the two.
        const passwordHash = await hashPassword(generateTempPassword());
        const parts = (b.name ?? 'Agency Owner').trim().split(/\s+/);
        const user = await tx.user.create({
          data: {
            email,
            passwordHash,
            firstName: parts[0] || 'Agency',
            lastName: parts.slice(1).join(' ') || null,
            emailVerifiedAt: new Date(),
            status: 'active',
            aliniaSubject: b.aliniaSubject,
          },
        });
        await tx.membership.create({
          data: { userId: user.id, organizationId: org.id, role: 'admin', isActive: true },
        });

        // Free/trialing subscription so caps + billing UI render (Hader billing is
        // arranged separately by the agency).
        const plan = await tx.plan.findUnique({ where: { code: 'free' } });
        if (plan) {
          await tx.subscription.create({
            data: { organizationId: org.id, planId: plan.id, status: 'trialing' },
          });
        }

        // Seed business identity from Alinia so the bot isn't USD/UTC/blank.
        await tx.businessInfo.upsert({
          where: { organizationId: org.id },
          create: {
            organizationId: org.id,
            legalName: b.agencyName,
            currency: (b.currency ?? 'USD').toUpperCase(),
            timezone: b.timezone ?? 'Asia/Beirut',
          },
          update: {},
        });

        await recordAudit({
          action: 'org_created',
          organizationId: org.id,
          entityType: 'organization',
          entityId: org.id,
          metadata: { provisionedByAlinia: true, aliniaAgencyId: b.aliniaAgencyId },
        });

        return { haderOrgId: org.id, adminUserId: user.id, adminEmail: email, alreadyProvisioned: false };
      });
    },
  );

  // Rich read-only listing ingest — Alinia pushes its property mirror here.
  // RE content lives in Product.attributes (dodges Int32/one-currency); writes
  // run under withAliniaSync so the read-only trigger permits mirror upserts.
  const ingestBody = z.object({
    haderOrgId: z.string().uuid(),
    listings: z
      .array(
        z.object({
          aliniaPropertyId: z.string().min(1),
          name: z.string().min(1),
          shortDescription: z.string().nullish(),
          description: z.string().nullish(),
          currency: z.string().length(3).optional(),
          isAvailable: z.boolean().optional(),
          attributes: z.record(z.string(), z.unknown()).optional(),
        }),
      )
      .max(2000),
    // The property ids the agency currently publishes. Any mirror row NOT in
    // this set is delisted (isAvailable=false) — a full sync self-heals drift.
    activePropertyIds: z.array(z.string()).optional(),
  });

  r.post(
    '/partner/ingest',
    {
      schema: {
        tags: ['partner'],
        summary: 'Alinia → Hader: upsert the read-only listing mirror for an org.',
        body: ingestBody,
        response: { 200: z.object({ upserted: z.number(), delisted: z.number() }) },
      },
    },
    async (req) => {
      const sig = req.headers['x-partner-secret'];
      if (!partnerSecretOk(Array.isArray(sig) ? sig[0] : sig)) {
        throw unauthorized(ApiErrorCode.AUTH_TOKEN_INVALID, 'Invalid partner credential.');
      }
      const b = req.body;

      return withAliniaSync(b.haderOrgId, async (tx) => {
        let upserted = 0;
        for (const l of b.listings) {
          const data = {
            name: l.name,
            shortDescription: l.shortDescription ?? null,
            description: l.description ?? null,
            currency: (l.currency ?? 'USD').toUpperCase(),
            attributes: (l.attributes ?? {}) as object,
            isAvailable: l.isAvailable ?? true,
          };
          await tx.product.upsert({
            where: {
              organizationId_aliniaPropertyId: {
                organizationId: b.haderOrgId,
                aliniaPropertyId: l.aliniaPropertyId,
              },
            },
            create: {
              organizationId: b.haderOrgId,
              sku: `alinia:${l.aliniaPropertyId}`,
              slug: `alinia-${l.aliniaPropertyId}`,
              sourceSystem: 'alinia',
              aliniaPropertyId: l.aliniaPropertyId,
              ...data,
            },
            update: data,
          });
          upserted++;
        }

        let delisted = 0;
        if (b.activePropertyIds) {
          const keep = b.activePropertyIds.length ? b.activePropertyIds : ['__none__'];
          const res = await tx.product.updateMany({
            where: {
              organizationId: b.haderOrgId,
              sourceSystem: 'alinia',
              isAvailable: true,
              aliniaPropertyId: { notIn: keep },
            },
            data: { isAvailable: false },
          });
          delisted = res.count;
        }
        return { upserted, delisted };
      });
    },
  );

  // Purge an org's Alinia mirror — deletes every sourceSystem='alinia' product
  // (and any alinia images/services) for the org. Runs under withAliniaSync so
  // the read-only trigger permits the deletes. Used to reset a demo, and the
  // teardown primitive a full "disconnect from Hader" will build on.
  const resetBody = z.object({ haderOrgId: z.string().uuid() });

  r.post(
    '/partner/reset',
    {
      schema: {
        tags: ['partner'],
        summary: "Alinia → Hader: delete an org's read-only listing mirror.",
        body: resetBody,
        response: {
          200: z.object({
            deletedProducts: z.number(),
            deletedImages: z.number(),
            deletedServices: z.number(),
          }),
        },
      },
    },
    async (req) => {
      const sig = req.headers['x-partner-secret'];
      if (!partnerSecretOk(Array.isArray(sig) ? sig[0] : sig)) {
        throw unauthorized(ApiErrorCode.AUTH_TOKEN_INVALID, 'Invalid partner credential.');
      }
      const { haderOrgId } = req.body;

      return withAliniaSync(haderOrgId, async (tx) => {
        const imgs = await tx.productImage.deleteMany({
          where: { sourceSystem: 'alinia', product: { organizationId: haderOrgId } },
        });
        const svcs = await tx.service.deleteMany({
          where: { sourceSystem: 'alinia', organizationId: haderOrgId },
        });
        const prods = await tx.product.deleteMany({
          where: { sourceSystem: 'alinia', organizationId: haderOrgId },
        });
        return {
          deletedProducts: prods.count,
          deletedImages: imgs.count,
          deletedServices: svcs.count,
        };
      });
    },
  );

  // Read-only introspection of a provisioned tenant — so Alinia (and operators)
  // can see exactly what provisioning set vs left at defaults. Debug/support.
  const introspectBody = z.object({ haderOrgId: z.string().uuid() });

  r.post(
    '/partner/introspect',
    {
      schema: {
        tags: ['partner'],
        summary: 'Alinia → Hader: read the provisioned tenant state (org, business info, admin, subscription, mirror).',
        body: introspectBody,
      },
    },
    async (req) => {
      const sig = req.headers['x-partner-secret'];
      if (!partnerSecretOk(Array.isArray(sig) ? sig[0] : sig)) {
        throw unauthorized(ApiErrorCode.AUTH_TOKEN_INVALID, 'Invalid partner credential.');
      }
      const { haderOrgId } = req.body;

      return withRlsBypass(async (tx) => {
        const organization = await tx.organization.findUnique({
          where: { id: haderOrgId },
          select: { id: true, slug: true, name: true, status: true, aiPlan: true, disabledFeatures: true, createdAt: true },
        });
        if (!organization) return { found: false };

        const businessInfo = await tx.businessInfo.findUnique({
          where: { organizationId: haderOrgId },
          select: {
            legalName: true, tagline: true, about: true, websiteUrl: true,
            operatingHours: true, hoursExceptions: true, timezone: true, currency: true,
            bookingForm: true, shopForm: true,
          },
        });
        const botConfig = await tx.botConfig.findFirst({ where: { organizationId: haderOrgId }, select: { id: true } });
        const adminRow = await tx.user.findFirst({
          where: { aliniaSubject: { not: null }, memberships: { some: { organizationId: haderOrgId } } },
          select: { email: true, firstName: true, lastName: true, status: true, emailVerifiedAt: true, aliniaSubject: true, passwordHash: true },
        });
        const admin = adminRow
          ? {
              email: adminRow.email, firstName: adminRow.firstName, lastName: adminRow.lastName,
              status: adminRow.status, emailVerified: !!adminRow.emailVerifiedAt,
              aliniaSubject: adminRow.aliniaSubject, hasBreakGlassPassword: !!adminRow.passwordHash,
              emailIsSynthesized: adminRow.email.endsWith('@tenants.hader.ai'),
            }
          : null;
        const subscription = await tx.subscription.findFirst({
          where: { organizationId: haderOrgId },
          select: { status: true, plan: { select: { code: true } } },
        });
        const totalProducts = await tx.product.count({ where: { organizationId: haderOrgId } });
        const aliniaProducts = await tx.product.count({ where: { organizationId: haderOrgId, sourceSystem: 'alinia' } });
        const sample = await tx.product.findMany({
          where: { organizationId: haderOrgId, sourceSystem: 'alinia' },
          select: { name: true, isAvailable: true }, take: 5,
        });

        // Encoding diagnostic — a client_encoding != UTF8 double-encodes
        // non-ASCII (·/Arabic) on write. Non-fatal so it can't break introspect.
        let db: unknown = null;
        try {
          // length()/octet_length() return integers (decode-immune), so they
          // reveal the TRUE stored bytes even if text reads mis-decode:
          //  clean UTF8 '·' → charlen 1, bytelen 2, extra_bytes(name)=#middots
          //  double-encoded → charlen 2, bytelen 4, extra_bytes doubles
          const enc = await tx.$queryRawUnsafe<
            Array<{ server: string; client: string; roundtrip: string; chr_bytelen: number; chr_charlen: number; name_extra_bytes: number | null; name_charlen: number | null }>
          >(
            `SELECT current_setting('server_encoding') AS server,
                    current_setting('client_encoding') AS client,
                    chr(183) AS roundtrip,
                    octet_length(chr(183)) AS chr_bytelen,
                    length(chr(183)) AS chr_charlen,
                    (SELECT octet_length(name) - length(name) FROM products WHERE organization_id = '${haderOrgId}' AND source_system = 'alinia' LIMIT 1) AS name_extra_bytes,
                    (SELECT length(name) FROM products WHERE organization_id = '${haderOrgId}' AND source_system = 'alinia' LIMIT 1) AS name_charlen`,
          );
          db = enc[0] ?? null;
        } catch (e) {
          db = { error: (e as Error).message };
        }

        return {
          found: true,
          db,
          organization,
          businessInfo,
          botConfigExists: !!botConfig,
          admin,
          subscription,
          products: { total: totalProducts, alinia: aliniaProducts, sample },
        };
      });
    },
  );

  // Full deprovision — deletes the org (cascades products/members/business
  // info/bot config/etc., same as the admin delete) and TOMBSTONES the
  // federated user (null aliniaSubject + rewrite email + disable) so a later
  // re-approval provisions a brand-new tenant with no idempotency/email clash.
  // This is the hard-reset teardown; a real "disconnect" (graduate-to-native)
  // would keep the org — that's a separate future path.
  const deprovisionBody = z.object({
    haderOrgId: z.string().uuid(),
    aliniaSubject: z.string().optional(),
  });

  r.post(
    '/partner/deprovision',
    {
      schema: {
        tags: ['partner'],
        summary: 'Alinia → Hader: delete a provisioned tenant (org) and retire its federated user.',
        body: deprovisionBody,
        response: {
          200: z.object({ orgDeleted: z.boolean(), userAction: z.enum(['none', 'tombstoned']) }),
        },
      },
    },
    async (req) => {
      const sig = req.headers['x-partner-secret'];
      if (!partnerSecretOk(Array.isArray(sig) ? sig[0] : sig)) {
        throw unauthorized(ApiErrorCode.AUTH_TOKEN_INVALID, 'Invalid partner credential.');
      }
      const { haderOrgId, aliniaSubject } = req.body;

      return withRlsBypass(async (tx) => {
        const org = await tx.organization.findUnique({ where: { id: haderOrgId }, select: { id: true } });
        if (org) await tx.organization.delete({ where: { id: haderOrgId } });

        let userAction: 'none' | 'tombstoned' = 'none';
        if (aliniaSubject) {
          const u = await tx.user.findUnique({ where: { aliniaSubject }, select: { id: true } });
          if (u) {
            // Update (not delete) — never risks FK aborts inside this tx; the
            // orphaned tombstone is harmless and unblocks fresh provisioning.
            await tx.user.update({
              where: { id: u.id },
              data: { aliniaSubject: null, email: `deleted+${u.id}@tenants.hader.ai`, status: 'disabled' },
            });
            userAction = 'tombstoned';
          }
        }
        return { orgDeleted: !!org, userAction };
      });
    },
  );
}
