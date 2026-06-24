// ALIGNED super-admin endpoints. Always run with RLS bypass since they
// inspect / manage data across tenants. Gated by `requireAlignedAdmin`.
import {
  adminCreateTenantBodySchema,
  adminCreateTenantResponseSchema,
  adminListLeadsQuerySchema,
  adminListOrgsQuerySchema,
  adminUpdateLeadBodySchema,
  adminUpdateOrgBodySchema,
  ApiErrorCode,
  ORG_FEATURE_KEYS,
  itemEnvelopeSchema,
  leadSchema,
  listEnvelopeSchema,
  organizationSchema,
  successSchema,
  uuidSchema,
} from '@aligned/shared';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { recordAudit } from '../../lib/audit.js';
import { REFRESH_COOKIE_NAME, refreshCookieOptions } from '../../lib/cookies.js';
import { generateTempPassword, hashPassword } from '../../lib/crypto.js';
import { withRlsBypass } from '../../lib/db.js';
import { sendEmail, tenantProvisionedTemplate } from '../../lib/email.js';
import { env } from '../../lib/env.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import {
  getDataExportQueue,
  getImportQueue,
  getSyncQueue,
  getWebhookQueue,
} from '../../lib/queues.js';
import { getRedis } from '../../lib/redis.js';
import { presignGetUrl } from '../../lib/storage.js';
import { issueSession } from '../auth/auth.service.js';

// Derives a URL-safe slug from a human org name. Strips diacritics,
// non-ASCII letters, collapses whitespace + punctuation into hyphens,
// trims trailing hyphens, lowercases. Caller must still de-dupe against
// existing slugs.
function slugifyName(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

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
              // Per-tenant AI tier surfaced on the admin list so the
              // tenants table at /aligned-admin can render a colored
              // badge per row + sort by plan.
              aiPlan: z.enum(['basic', 'middle', 'max', 'ultra']),
              // ALIGNED-admin per-tenant access control: disabled feature keys.
              disabledFeatures: z.array(z.string()),
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
              aiPlan: (o as { aiPlan?: 'basic' | 'middle' | 'max' | 'ultra' }).aiPlan ?? 'basic',
              disabledFeatures:
                (o as { disabledFeatures?: string[] }).disabledFeatures ?? [],
            };
          }),
        );
      });
      return { data: orgs, nextCursor: null };
    },
  );

  // ---------- POST /aligned-admin/orgs ------------------------------------
  // Provision a tenant on the customer's behalf. Skips email verification
  // (we're vouching for them) and optionally emails the new admin their
  // login + temporary password.
  r.post(
    '/aligned-admin/orgs',
    {
      schema: {
        tags: ['admin'],
        summary: 'Create a new tenant + admin user (skips email verify).',
        body: adminCreateTenantBodySchema,
        response: { 201: adminCreateTenantResponseSchema },
      },
      preHandler: [app.requireAlignedAdmin],
    },
    async (req, reply) => {
      const body = req.body;
      // Resolve slug: explicit value takes priority, else derived from name.
      // Append a numeric suffix if the candidate collides with an existing org.
      let candidate = body.organizationSlug?.trim().toLowerCase() || slugifyName(body.organizationName);
      if (!candidate) throw conflict('Organization name produces an empty slug.');

      const result = await withRlsBypass(async (tx) => {
        const existingUser = await tx.user.findUnique({ where: { email: body.adminEmail } });
        if (existingUser) throw conflict('A user with this email already exists.');

        // Ensure slug is unique. Loop with `-2`, `-3`, ... suffixes until
        // we find an open one. Bounded at 50 to avoid infinite loops on a
        // pathologically common name.
        let slug = candidate;
        for (let n = 2; n < 50; n++) {
          const taken = await tx.organization.findUnique({ where: { slug } });
          if (!taken) break;
          slug = `${candidate}-${n}`;
        }

        const password = body.adminPassword ?? generateTempPassword();
        const passwordHash = await hashPassword(password);

        const organization = await tx.organization.create({
          data: {
            slug,
            name: body.organizationName,
            status: 'active',
            disabledFeatures: Array.from(new Set(body.disabledFeatures ?? [])),
          },
        });
        const admin = await tx.user.create({
          data: {
            email: body.adminEmail,
            passwordHash,
            firstName: body.adminFirstName,
            lastName: body.adminLastName || null,
            // Operator-provisioned ⇒ skip the verify-email flow.
            emailVerifiedAt: new Date(),
            status: 'active',
          },
        });
        await tx.membership.create({
          data: {
            userId: admin.id,
            organizationId: organization.id,
            role: 'admin',
            isActive: true,
          },
        });

        // Bootstrap a subscription on the requested plan (default `free`)
        // so usage caps + the billing UI render correctly from the get-go.
        const planCode = body.planCode ?? 'free';
        const plan = await tx.plan.findUnique({ where: { code: planCode } });
        if (plan) {
          await tx.subscription.create({
            data: {
              organizationId: organization.id,
              planId: plan.id,
              status: 'trialing',
            },
          });
        }

        await recordAudit({
          action: 'org_created',
          organizationId: organization.id,
          actorUserId: req.auth!.userId,
          metadata: { provisionedByAdmin: true, planCode },
        });
        await recordAudit({
          action: 'user_created',
          organizationId: organization.id,
          actorUserId: req.auth!.userId,
          entityType: 'user',
          entityId: admin.id,
          metadata: { provisionedByAdmin: true },
        });

        return { organization, admin, generatedPassword: body.adminPassword ? null : password };
      });

      // Email — outside the tx. Failure logs but doesn't roll back the
      // provision; operator can resend or reset password from the UI.
      let welcomeEmailSent = false;
      if (body.sendWelcomeEmail) {
        const tpl = tenantProvisionedTemplate({
          firstName: body.adminFirstName,
          organizationName: result.organization.name,
          email: result.admin.email,
          password: result.generatedPassword ?? body.adminPassword ?? '',
          loginUrl: `${env.WEB_PUBLIC_URL.replace(/\/$/, '')}/login`,
        });
        try {
          await sendEmail({ to: result.admin.email, ...tpl });
          welcomeEmailSent = true;
        } catch (err) {
          req.log.warn({ err }, '[admin] tenant welcome email failed');
        }
      }

      reply.code(201);
      return {
        data: {
          organization: {
            id: result.organization.id,
            slug: result.organization.slug,
            name: result.organization.name,
            status: result.organization.status,
            createdAt: result.organization.createdAt.toISOString(),
            updatedAt: result.organization.updatedAt.toISOString(),
          },
          admin: {
            id: result.admin.id,
            email: result.admin.email,
            firstName: result.admin.firstName,
            lastName: result.admin.lastName,
          },
          generatedPassword: result.generatedPassword,
          welcomeEmailSent,
        },
      };
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

  // ---------- GET /aligned-admin/orgs/:id/details -------------------------
  // Drill-down for a single tenant. Returns the metadata an ALIGNED
  // admin needs to understand or troubleshoot the account — members
  // with email + role + last-login + 2FA status, WhatsApp channel
  // health, custom-domain status, recent audit log. Passwords are
  // bcrypt-hashed at rest by design — they are NOT recoverable here
  // (or anywhere). For lockouts, use /users/:id/reset-link below.
  r.get(
    '/aligned-admin/orgs/:id/details',
    {
      schema: {
        tags: ['admin'],
        summary: 'Full details for one organisation: members + channel + recent activity.',
        params: z.object({ id: uuidSchema }),
        response: {
          200: itemEnvelopeSchema(
            z.object({
              id: uuidSchema,
              name: z.string(),
              slug: z.string(),
              status: z.string(),
              createdAt: z.string().datetime(),
              members: z.array(
                z.object({
                  userId: uuidSchema,
                  email: z.string(),
                  firstName: z.string().nullable(),
                  lastName: z.string().nullable(),
                  role: z.string(),
                  isActive: z.boolean(),
                  status: z.string(),
                  emailVerified: z.boolean(),
                  totpEnabled: z.boolean(),
                  lastLoginAt: z.string().datetime().nullable(),
                  failedLoginAttempts: z.number().int(),
                  lockedUntil: z.string().datetime().nullable(),
                  joinedAt: z.string().datetime(),
                }),
              ),
              whatsappChannel: z
                .object({
                  displayPhoneNumber: z.string().nullable(),
                  phoneNumberId: z.string().nullable(),
                  isActive: z.boolean(),
                  isPrimary: z.boolean(),
                })
                .nullable(),
              counts: z.object({
                products: z.number().int(),
                services: z.number().int(),
                faqs: z.number().int(),
                apiKeys: z.number().int(),
                webhooks: z.number().int(),
              }),
              recentAuditLog: z.array(
                z.object({
                  action: z.string(),
                  actorEmail: z.string().nullable(),
                  ipAddress: z.string().nullable(),
                  createdAt: z.string().datetime(),
                }),
              ),
            }),
          ),
        },
      },
      preHandler: [app.requireAlignedAdmin],
    },
    async (req) =>
      withRlsBypass(async (tx) => {
        const org = await tx.organization.findUnique({ where: { id: req.params.id } });
        if (!org) throw notFound('Organisation not found.');

        const memberships = await tx.membership.findMany({
          where: { organizationId: org.id },
          orderBy: [{ role: 'asc' }, { createdAt: 'asc' }],
          include: {
            user: {
              select: {
                id: true,
                email: true,
                firstName: true,
                lastName: true,
                status: true,
                emailVerifiedAt: true,
                totpEnabled: true,
                lastLoginAt: true,
                failedLoginAttempts: true,
                lockedUntil: true,
              },
            },
          },
        });

        const channel = await tx.whatsAppChannel.findFirst({
          where: { organizationId: org.id, isPrimary: true },
          select: {
            displayPhoneNumber: true,
            phoneNumberId: true,
            isActive: true,
            isPrimary: true,
          },
        });

        const [productCount, serviceCount, faqCount, apiKeyCount, webhookCount] = await Promise.all([
          tx.product.count({ where: { organizationId: org.id, deletedAt: null } }),
          tx.service.count({ where: { organizationId: org.id, deletedAt: null } }),
          tx.fAQ.count({ where: { organizationId: org.id } }),
          tx.apiKey.count({ where: { organizationId: org.id, revokedAt: null } }),
          tx.webhookEndpoint.count({ where: { organizationId: org.id } }),
        ]);

        const audit = await tx.auditLog.findMany({
          where: { organizationId: org.id },
          orderBy: { createdAt: 'desc' },
          take: 20,
          include: {
            actor: { select: { email: true } },
          },
        });

        return {
          data: {
            id: org.id,
            name: org.name,
            slug: org.slug,
            status: org.status,
            createdAt: org.createdAt.toISOString(),
            members: memberships.map((m) => ({
              userId: m.user.id,
              email: m.user.email,
              firstName: m.user.firstName,
              lastName: m.user.lastName,
              role: m.role,
              isActive: m.isActive,
              status: m.user.status,
              emailVerified: !!m.user.emailVerifiedAt,
              totpEnabled: m.user.totpEnabled,
              lastLoginAt: m.user.lastLoginAt?.toISOString() ?? null,
              failedLoginAttempts: m.user.failedLoginAttempts,
              lockedUntil: m.user.lockedUntil?.toISOString() ?? null,
              joinedAt: m.createdAt.toISOString(),
            })),
            whatsappChannel: channel,
            counts: {
              products: productCount,
              services: serviceCount,
              faqs: faqCount,
              apiKeys: apiKeyCount,
              webhooks: webhookCount,
            },
            recentAuditLog: audit.map((a) => ({
              action: String(a.action),
              actorEmail: a.actor?.email ?? null,
              ipAddress: a.ipAddress ? String(a.ipAddress) : null,
              createdAt: a.createdAt.toISOString(),
            })),
          },
        };
      }),
  );

  // ---------- PATCH /aligned-admin/users/:id ------------------------------
  // ALIGNED-admin can update a tenant member's email after the fact —
  // common ask when a customer changes jobs / email providers / asks for
  // a typo to be fixed. Constraints:
  //   • new email must be a syntactically valid address
  //   • email is globally unique (citext) → 409 if it's already in use
  //   • change forces re-verification: emailVerifiedAt is cleared and the
  //     standard verify-email flow can fire from the portal. This stops
  //     a typo'd email becoming a working login without the new mailbox
  //     ever being proven.
  //   • all sessions revoked so the OLD email stops working immediately
  //   • audited on both the user and the org so the action is traceable
  r.patch(
    '/aligned-admin/users/:id',
    {
      schema: {
        tags: ['admin'],
        summary: "Update a tenant member's email (admin convenience). Forces re-verification.",
        params: z.object({ id: uuidSchema }),
        body: z.object({
          email: z.string().email().max(254),
        }),
        response: {
          200: itemEnvelopeSchema(
            z.object({
              userId: uuidSchema,
              email: z.string(),
              emailVerifiedAt: z.string().datetime().nullable(),
              sessionsRevoked: z.number().int(),
            }),
          ),
        },
      },
      preHandler: [app.requireAlignedAdmin],
    },
    async (req) => {
      const newEmail = req.body.email.trim().toLowerCase();
      const result = await withRlsBypass(async (tx) => {
        const user = await tx.user.findUnique({ where: { id: req.params.id } });
        if (!user) throw notFound('User not found.');
        if (user.email.toLowerCase() === newEmail) {
          return {
            userId: user.id,
            email: user.email,
            emailVerifiedAt: user.emailVerifiedAt?.toISOString() ?? null,
            sessionsRevoked: 0,
            unchanged: true,
            previousEmail: user.email,
          };
        }
        const taken = await tx.user.findUnique({ where: { email: newEmail } });
        if (taken) throw conflict('That email is already in use by another account.');
        const previousEmail = user.email;
        const updated = await tx.user.update({
          where: { id: user.id },
          data: {
            email: newEmail,
            // Force re-verification of the new mailbox. The user can
            // request a fresh verify-email link from the portal, or the
            // ALIGNED admin can issue a reset-link (which lets them in
            // without email verification per the existing login gate
            // logic — reset implies control of the new email).
            emailVerifiedAt: null,
            emailVerificationTokenHash: null,
            emailVerificationExpiresAt: null,
          },
        });
        // Revoke every live session so the OLD-email login stops working
        // and any open browser tab gets bounced to /login on next refresh.
        const sessions = await tx.session.updateMany({
          where: { userId: user.id, revokedAt: null },
          data: { revokedAt: new Date() },
        });
        return {
          userId: updated.id,
          email: updated.email,
          emailVerifiedAt: updated.emailVerifiedAt?.toISOString() ?? null,
          sessionsRevoked: sessions.count,
          unchanged: false,
          previousEmail,
        };
      });

      if (!result.unchanged) {
        // Audit on the user. Find the user's primary org for the
        // organizationId field (best-effort — if the user has no
        // memberships, leave it null and the entry still lands).
        const primaryMembership = await withRlsBypass((tx) =>
          tx.membership.findFirst({
            where: { userId: result.userId, isActive: true },
            orderBy: { createdAt: 'asc' },
            select: { organizationId: true },
          }),
        );
        await recordAudit({
          action: 'user_updated',
          actorUserId: req.auth!.userId,
          organizationId: primaryMembership?.organizationId,
          entityType: 'user',
          entityId: result.userId,
          metadata: {
            event: 'aligned_admin_email_change',
            previousEmail: result.previousEmail,
            newEmail: result.email,
            sessionsRevoked: result.sessionsRevoked,
          },
        });
      }

      return {
        data: {
          userId: result.userId,
          email: result.email,
          emailVerifiedAt: result.emailVerifiedAt,
          sessionsRevoked: result.sessionsRevoked,
        },
      };
    },
  );

  // ---------- POST /aligned-admin/users/:id/reset-link ---------------------
  // ALIGNED-admin convenience: generate a one-time, short-TTL password
  // reset link for any tenant member and return the URL. The admin then
  // DMs it to the customer (Slack / WhatsApp / email).
  //
  // 10-minute TTL because the admin-issued path is high-touch — the
  // operator generates the URL, sends it to a known customer over a
  // synchronous channel, and the customer acts on it immediately. A
  // longer window would just sit around as a credential to be leaked.
  //
  // We use the EXACT same token shape as /auth/forgot-password — the
  // /reset-password page on the portal already validates these. Token
  // is hashed at rest; only the plaintext URL returned here can
  // actually reset the password.
  //
  // We do NOT show the customer's current password. Passwords are
  // bcrypt-hashed; the platform never has the plaintext.
  const ADMIN_RESET_TTL_MS = 10 * 60 * 1000;
  r.post(
    '/aligned-admin/users/:id/reset-link',
    {
      schema: {
        tags: ['admin'],
        summary: 'Generate a 10-minute password-reset URL for any user (admin convenience).',
        params: z.object({ id: uuidSchema }),
        response: {
          200: itemEnvelopeSchema(
            z.object({
              userEmail: z.string(),
              resetUrl: z.string().url(),
              expiresAt: z.string().datetime(),
            }),
          ),
        },
      },
      preHandler: [app.requireAlignedAdmin],
    },
    async (req) => {
      const { generateOpaqueToken, hashToken } = await import('../../lib/crypto.js');
      const expiresAt = new Date(Date.now() + ADMIN_RESET_TTL_MS);
      const result = await withRlsBypass(async (tx) => {
        const user = await tx.user.findUnique({ where: { id: req.params.id } });
        if (!user) throw notFound('User not found.');
        const token = generateOpaqueToken();
        await tx.user.update({
          where: { id: user.id },
          data: {
            passwordResetTokenHash: hashToken(token),
            passwordResetExpiresAt: expiresAt,
          },
        });
        return { email: user.email, token };
      });
      await recordAudit({
        action: 'password_reset_requested',
        actorUserId: req.auth!.userId,
        entityType: 'user',
        entityId: req.params.id,
        metadata: { event: 'aligned_admin_issued_reset_link', userEmail: result.email },
      });
      return {
        data: {
          userEmail: result.email,
          resetUrl: `${env.WEB_PUBLIC_URL}/reset-password?token=${result.token}`,
          expiresAt: expiresAt.toISOString(),
        },
      };
    },
  );

  // ---------- POST /aligned-admin/orgs/:id/impersonate --------------------
  // ALIGNED-admin "Control" action: issue a brand-new session bound to
  // the target org so the admin can browse + edit the tenant's data
  // exactly as one of its own admins would. The previous session is
  // revoked so navigation is unambiguous, and the action is recorded in
  // the audit log on the target org.
  //
  // Membership is NOT required — that's the whole point. getSessionContext
  // synthesises a virtual 'admin' role for ALIGNED admins that don't have
  // a membership row, so the rest of the app behaves normally.
  r.post(
    '/aligned-admin/orgs/:id/impersonate',
    {
      schema: {
        tags: ['admin'],
        summary: 'Mint a session for the target org so the admin can control it.',
        params: z.object({ id: uuidSchema }),
        response: {
          200: itemEnvelopeSchema(
            z.object({
              accessToken: z.string(),
              expiresAt: z.string().datetime(),
              organizationId: uuidSchema,
              organizationSlug: z.string(),
              organizationName: z.string(),
            }),
          ),
        },
      },
      preHandler: [app.requireAlignedAdmin],
    },
    async (req, reply) => {
      const target = await withRlsBypass((tx) =>
        tx.organization.findUnique({ where: { id: req.params.id } }),
      );
      if (!target) throw notFound('Organisation not found.');
      if (target.status !== 'active') {
        throw badRequest(
          ApiErrorCode.VALIDATION_ERROR,
          'This organisation is not active. Reactivate it first, then try Control again.',
        );
      }

      // Revoke the current session so the admin never has two open at
      // once (the new one is for the target org, so the old is stale).
      if (req.auth?.sessionId) {
        await withRlsBypass((tx) =>
          tx.session.update({
            where: { id: req.auth!.sessionId },
            data: { revokedAt: new Date() },
          }),
        );
      }

      const meta = {
        ip: req.ip ?? null,
        userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
      };
      const tokens = await issueSession({
        userId: req.auth!.userId,
        organizationId: target.id,
        role: 'admin',
        isAlignedAdmin: true,
        meta,
        // Sprint 1 H-3 — mark the session as impersonation so refreshSession
        // allows the no-membership admin-role synthesis to continue working.
        isImpersonation: true,
      });

      reply.setCookie(REFRESH_COOKIE_NAME, tokens.refreshToken, refreshCookieOptions());

      await recordAudit({
        action: 'business_info_updated',
        organizationId: target.id,
        actorUserId: req.auth!.userId,
        entityType: 'organization',
        entityId: target.id,
        metadata: {
          event: 'aligned_admin_impersonate',
          target_org_slug: target.slug,
          target_org_name: target.name,
        },
      });

      return {
        data: {
          accessToken: tokens.accessToken,
          // issueSession returns a Date; the Zod schema expects ISO string.
          expiresAt:
            tokens.expiresAt instanceof Date
              ? tokens.expiresAt.toISOString()
              : (tokens.expiresAt as unknown as string),
          organizationId: target.id,
          organizationSlug: target.slug,
          organizationName: target.name,
        },
      };
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
            // BullMQ's getJobCounts() types each bucket as `number | undefined`
            // even though it always returns 0 when the bucket has no jobs.
            // Coerce to 0 to satisfy the strict z.number() response schema.
            import: {
              waiting: importCounts.waiting ?? 0,
              active: importCounts.active ?? 0,
              failed: importCounts.failed ?? 0,
            },
            sync: {
              waiting: syncCounts.waiting ?? 0,
              active: syncCounts.active ?? 0,
              failed: syncCounts.failed ?? 0,
            },
            webhook: {
              waiting: webhookCounts.waiting ?? 0,
              active: webhookCounts.active ?? 0,
              failed: webhookCounts.failed ?? 0,
            },
          },
          redis: { connected, opsPerSec },
        },
      };
    },
  );

  // ---------- GET /aligned-admin/traffic ----------------------------------
  // Live traffic snapshot parsed from the API's own /metrics endpoint.
  // Returns cumulative counters since the process started — for a real
  // historical chart, scrape /metrics into Prometheus externally.
  r.get(
    '/aligned-admin/traffic',
    {
      schema: {
        tags: ['admin'],
        summary: 'Parsed snapshot of the API process’s Prometheus counters.',
        response: {
          200: itemEnvelopeSchema(
            z.object({
              totalRequests: z.number(),
              byStatusClass: z.object({
                '2xx': z.number(),
                '3xx': z.number(),
                '4xx': z.number(),
                '5xx': z.number(),
                other: z.number(),
              }),
              errorRate: z.number(),
              uptimeSeconds: z.number(),
              processStartTime: z.string().datetime().nullable(),
              topRoutes: z.array(
                z.object({ route: z.string(), method: z.string(), count: z.number() }),
              ),
            }),
          ),
        },
      },
      preHandler: [app.requireAlignedAdmin],
    },
    async () => {
      // Fetch our own /metrics. The metrics endpoint runs in-process so
      // localhost is always safe here. Use the validated `env.API_PORT`
      // rather than raw process.env so a runtime mutation cannot redirect.
      let text = '';
      try {
        const r = await fetch(`http://127.0.0.1:${env.API_PORT}/metrics`, {
          signal: AbortSignal.timeout(2000),
        });
        text = await r.text();
      } catch {
        // Fall through with empty text — zeros will be returned.
      }

      const buckets = { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0, other: 0 };
      const byRoute = new Map<string, { method: string; count: number }>();
      let totalRequests = 0;
      let processStartTimeSec: number | null = null;

      for (const line of text.split('\n')) {
        if (line.startsWith('#') || !line.trim()) continue;
        if (line.startsWith('process_start_time_seconds')) {
          const m = line.match(/\s([\d.e+-]+)$/);
          if (m) processStartTimeSec = Number(m[1]);
          continue;
        }
        if (line.startsWith('http_requests_total{')) {
          const labelMatch = line.match(/\{([^}]+)\}\s+([\d.e+-]+)/);
          if (!labelMatch) continue;
          const labelStr = labelMatch[1] ?? '';
          const value = Number(labelMatch[2]);
          if (!Number.isFinite(value)) continue;

          const labels: Record<string, string> = {};
          for (const pair of labelStr.split(',')) {
            const [k, v] = pair.split('=');
            if (k && v) labels[k.trim()] = v.replace(/^"|"$/g, '');
          }
          const status = labels.status ?? '';
          const method = labels.method ?? 'GET';
          const route = labels.route ?? '?';
          const statusDigit = status.charAt(0);
          const bucket =
            statusDigit === '2'
              ? '2xx'
              : statusDigit === '3'
                ? '3xx'
                : statusDigit === '4'
                  ? '4xx'
                  : statusDigit === '5'
                    ? '5xx'
                    : 'other';
          buckets[bucket as keyof typeof buckets] += value;
          totalRequests += value;

          const key = `${method} ${route}`;
          const existing = byRoute.get(key);
          if (existing) existing.count += value;
          else byRoute.set(key, { method, count: value });
        }
      }

      const topRoutes = [...byRoute.entries()]
        .map(([key, v]) => ({ route: key.split(' ').slice(1).join(' '), method: v.method, count: v.count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 10);

      const errorRate = totalRequests > 0 ? buckets['5xx'] / totalRequests : 0;
      const uptimeSeconds = processStartTimeSec
        ? Math.max(0, Math.floor(Date.now() / 1000 - processStartTimeSec))
        : 0;

      return {
        data: {
          totalRequests,
          byStatusClass: buckets,
          errorRate,
          uptimeSeconds,
          processStartTime: processStartTimeSec ? new Date(processStartTimeSec * 1000).toISOString() : null,
          topRoutes,
        },
      };
    },
  );

  // ---------- GET /aligned-admin/uptime -----------------------------------
  // Proxies a read-only snapshot from UptimeRobot. Returns `{ configured:
  // false }` when the env keys are missing — UI hides the tile in that
  // case. We proxy (rather than calling UptimeRobot from the browser) so
  // the API key never leaves the server.
  r.get(
    '/aligned-admin/uptime',
    {
      schema: {
        tags: ['admin'],
        summary: 'Uptime snapshot proxied from UptimeRobot (if configured).',
        response: {
          200: itemEnvelopeSchema(
            z.object({
              configured: z.boolean(),
              monitors: z.array(
                z.object({
                  id: z.number(),
                  name: z.string(),
                  url: z.string(),
                  status: z.string(),
                  uptimeRatio: z.number().nullable(),
                }),
              ),
            }),
          ),
        },
      },
      preHandler: [app.requireAlignedAdmin],
    },
    async () => {
      if (!env.UPTIMEROBOT_API_KEY) {
        return { data: { configured: false, monitors: [] } };
      }
      const params = new URLSearchParams({
        api_key: env.UPTIMEROBOT_API_KEY,
        format: 'json',
        custom_uptime_ratios: '1-7-30', // 24h / 7d / 30d
        logs: '0',
      });
      if (env.UPTIMEROBOT_MONITOR_IDS) {
        params.set('monitors', env.UPTIMEROBOT_MONITOR_IDS);
      }
      try {
        const res = await fetch('https://api.uptimerobot.com/v2/getMonitors', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Cache-Control': 'no-cache',
          },
          body: params.toString(),
          signal: AbortSignal.timeout(5000),
        });
        if (!res.ok) {
          return { data: { configured: true, monitors: [] } };
        }
        const body = (await res.json()) as {
          stat?: string;
          monitors?: {
            id: number;
            friendly_name?: string;
            url?: string;
            status?: number;
            custom_uptime_ratio?: string;
          }[];
        };
        // UptimeRobot status code mapping → human labels.
        const statusLabel = (n: number | undefined) =>
          n === 2 ? 'up' : n === 8 ? 'seems_down' : n === 9 ? 'down' : n === 0 ? 'paused' : 'unknown';
        const monitors = (body.monitors ?? []).map((m) => {
          const firstRatio = m.custom_uptime_ratio?.split('-')[0];
          const ratio = firstRatio ? Number(firstRatio) : null;
          return {
            id: m.id,
            name: m.friendly_name ?? `Monitor ${m.id}`,
            url: m.url ?? '',
            status: statusLabel(m.status),
            uptimeRatio: ratio != null && Number.isFinite(ratio) ? ratio : null,
          };
        });
        return { data: { configured: true, monitors } };
      } catch {
        return { data: { configured: true, monitors: [] } };
      }
    },
  );

  // ---------- GET /aligned-admin/self-uptime ----------------------------
  // Reads the worker's self-uptime probe ZSET and computes 24h / 7d
  // availability + p95 latency. NOT a substitute for external monitoring
  // — the worker can't observe the VM being entirely down. Surfaced
  // alongside (or in absence of) the UptimeRobot tile.
  r.get(
    '/aligned-admin/self-uptime',
    {
      schema: {
        tags: ['admin'],
        summary: 'Worker-process self-probe of the API /health endpoint.',
      },
      preHandler: [app.requireAlignedAdmin],
    },
    async () => {
      const redis = getRedis();
      const now = Date.now();
      const day = 24 * 60 * 60 * 1000;
      const cutoff7d = now - 7 * day;
      const cutoff24h = now - day;

      // ZSET members are formatted "<ts>:<ok>:<status>:<latency>".
      let raw: string[] = [];
      try {
        raw = await redis.zrangebyscore('uptime:api', cutoff7d, now);
      } catch {
        raw = [];
      }
      const samples = raw
        .map((m) => {
          const [tsStr, okStr, statusStr, latencyStr] = m.split(':');
          return {
            ts: Number(tsStr),
            ok: okStr === '1',
            status: Number(statusStr),
            latency: Number(latencyStr),
          };
        })
        .filter((s) => Number.isFinite(s.ts));

      function uptimePct(since: number) {
        const slice = samples.filter((s) => s.ts >= since);
        if (slice.length === 0) return null;
        const ok = slice.filter((s) => s.ok).length;
        return Number(((ok / slice.length) * 100).toFixed(3));
      }
      function p95Latency(since: number) {
        const slice = samples.filter((s) => s.ts >= since && Number.isFinite(s.latency));
        if (slice.length === 0) return null;
        const sorted = [...slice].sort((a, b) => a.latency - b.latency);
        return sorted[Math.floor(sorted.length * 0.95)]?.latency ?? null;
      }

      return {
        data: {
          configured: samples.length > 0,
          window7dPct: uptimePct(cutoff7d),
          window24hPct: uptimePct(cutoff24h),
          p95Latency24h: p95Latency(cutoff24h),
          totalSamples: samples.length,
          oldestSample: samples[0]?.ts ?? null,
          newestSample: samples[samples.length - 1]?.ts ?? null,
        },
      };
    },
  );

  // ---------- GET /aligned-admin/debug/thread/:id --------------------------
  // One-shot diagnostic for "the thread shows X in / Y out but /messages
  // returns nothing". Compares thread.customerPhone against the actual
  // message rows + orphan rows in the same org, so we can see whether
  // messages are landing under a different threadId, with NULL threadId,
  // or in a different organizationId entirely.
  r.get(
    '/aligned-admin/debug/thread/:id',
    {
      schema: {
        tags: ['admin'],
        summary: 'Cross-tenant diagnostic for one whatsapp_thread row.',
        params: z.object({ id: uuidSchema }),
      },
      preHandler: [app.requireAlignedAdmin],
    },
    async (req) => {
      return withRlsBypass(async (tx) => {
        const thread = await tx.whatsAppThread.findUnique({
          where: { id: req.params.id },
          select: {
            id: true,
            organizationId: true,
            customerPhone: true,
            customerName: true,
            customerWhatsappName: true,
            inboundCount: true,
            outboundCount: true,
            lastMessageAt: true,
            createdAt: true,
            status: true,
          },
        });
        if (!thread) throw notFound('Thread not found.');
        const phone = thread.customerPhone;
        const phoneNoPlus = phone.replace(/^\+/, '');
        const phonePlus = phone.startsWith('+') ? phone : `+${phone}`;

        const [
          linkedToThis,
          sameOrgSamePhoneFrom,
          sameOrgSamePhoneTo,
          orphans,
          siblingThreads,
          sampleMessagesByPhone,
        ] = await Promise.all([
          tx.whatsAppMessage.count({ where: { threadId: thread.id } }),
          tx.whatsAppMessage.count({
            where: {
              organizationId: thread.organizationId,
              OR: [{ fromNumber: phone }, { fromNumber: phoneNoPlus }, { fromNumber: phonePlus }],
            },
          }),
          tx.whatsAppMessage.count({
            where: {
              organizationId: thread.organizationId,
              OR: [{ toNumber: phone }, { toNumber: phoneNoPlus }, { toNumber: phonePlus }],
            },
          }),
          tx.whatsAppMessage.count({
            where: {
              organizationId: thread.organizationId,
              threadId: null,
              OR: [
                { fromNumber: phone },
                { fromNumber: phoneNoPlus },
                { fromNumber: phonePlus },
                { toNumber: phone },
                { toNumber: phoneNoPlus },
                { toNumber: phonePlus },
              ],
            },
          }),
          tx.whatsAppThread.findMany({
            where: {
              organizationId: thread.organizationId,
              id: { not: thread.id },
              OR: [
                { customerPhone: phone },
                { customerPhone: phoneNoPlus },
                { customerPhone: phonePlus },
              ],
            },
            select: { id: true, customerPhone: true, inboundCount: true, outboundCount: true },
          }),
          tx.whatsAppMessage.findMany({
            where: {
              organizationId: thread.organizationId,
              OR: [
                { fromNumber: phone },
                { fromNumber: phoneNoPlus },
                { fromNumber: phonePlus },
                { toNumber: phone },
                { toNumber: phoneNoPlus },
                { toNumber: phonePlus },
              ],
            },
            orderBy: { receivedAt: 'desc' },
            take: 10,
            select: {
              id: true,
              direction: true,
              threadId: true,
              fromNumber: true,
              toNumber: true,
              receivedAt: true,
              messageType: true,
              body: true,
            },
          }),
        ]);

        return {
          data: {
            thread,
            counts: {
              linkedToThis,
              sameOrgSamePhoneFrom,
              sameOrgSamePhoneTo,
              orphans,
            },
            siblingThreads,
            sampleMessagesByPhone: sampleMessagesByPhone.map((m) => ({
              ...m,
              body: m.body ? m.body.slice(0, 80) : null,
            })),
          },
        };
      });
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

  // ---------- GET /aligned-admin/provenance --------------------------------
  // Phase 8 / 1.4 — cross-tenant browser of every persisted bot reply
  // provenance row. Filters: organizationId, flagged (boolean), since/until
  // (ISO), cursor pagination. Returns lightweight summary rows; click into
  // one to hit /inbox/messages/:id/provenance for the full body.
  r.get(
    '/aligned-admin/provenance',
    {
      schema: {
        tags: ['admin'],
        summary: 'ALIGNED-admin only — list of every bot-reply provenance row across all tenants.',
        querystring: z.object({
          organizationId: z.string().uuid().optional(),
          flagged: z.enum(['true', 'false']).optional(),
          since: z.string().datetime().optional(),
          until: z.string().datetime().optional(),
          cursor: z.string().uuid().optional(),
          take: z.coerce.number().int().min(1).max(200).default(50),
        }),
      },
      preHandler: [app.requireAlignedAdmin],
    },
    async (req) => {
      const { organizationId, flagged, since, until, cursor, take } = req.query;
      const rows = await withRlsBypass(async (tx) => {
        // Build raw WHERE clauses — Prisma's query API can't easily
        // express jsonb_array_length, and we need it for the flagged
        // filter anyway. Safe because every input is type-checked by Zod.
        const wheres: string[] = ['1=1'];
        const vals: unknown[] = [];
        let i = 1;
        if (organizationId) {
          wheres.push(`p.organization_id = $${i++}::uuid`);
          vals.push(organizationId);
        }
        if (since) {
          wheres.push(`p.created_at >= $${i++}::timestamptz`);
          vals.push(since);
        }
        if (until) {
          wheres.push(`p.created_at <= $${i++}::timestamptz`);
          vals.push(until);
        }
        if (flagged === 'true') {
          wheres.push(`jsonb_array_length(COALESCE(p.hallucinations, '[]'::jsonb)) > 0`);
        } else if (flagged === 'false') {
          wheres.push(`jsonb_array_length(COALESCE(p.hallucinations, '[]'::jsonb)) = 0`);
        }
        if (cursor) {
          // Cursor = the id of the LAST row from previous page. Combined
          // with created_at DESC ordering this gives a stable forward
          // pagination as long as no row's created_at changes (it never does).
          wheres.push(
            `(p.created_at, p.id) < (SELECT created_at, id FROM message_provenances WHERE id = $${i++}::uuid)`,
          );
          vals.push(cursor);
        }
        const sql = `
          SELECT
            p.id, p.message_id, p.organization_id, p.created_at,
            p.model, p.latency_ms, p.prompt_tokens, p.completion_tokens,
            jsonb_array_length(COALESCE(p.hallucinations, '[]'::jsonb)) AS halluc_count,
            jsonb_array_length(COALESCE(p.citations, '[]'::jsonb))      AS cit_count,
            m.body, m.message_type, m.thread_id,
            o.name AS org_name, o.slug AS org_slug
          FROM message_provenances p
          JOIN organizations o ON o.id = p.organization_id
          LEFT JOIN whatsapp_messages m ON m.id = p.message_id
          WHERE ${wheres.join(' AND ')}
          ORDER BY p.created_at DESC, p.id DESC
          LIMIT $${i}
        `;
        vals.push(take + 1);
        return tx.$queryRawUnsafe<
          {
            id: string;
            message_id: string;
            organization_id: string;
            created_at: Date;
            model: string;
            latency_ms: number;
            prompt_tokens: number;
            completion_tokens: number;
            halluc_count: number;
            cit_count: number;
            body: string | null;
            message_type: string | null;
            thread_id: string | null;
            org_name: string;
            org_slug: string;
          }[]
        >(sql, ...vals);
      });
      const hasMore = rows.length > take;
      const trimmed = hasMore ? rows.slice(0, take) : rows;
      return {
        data: trimmed.map((r) => ({
          provenanceId: r.id,
          messageId: r.message_id,
          organizationId: r.organization_id,
          organizationName: r.org_name,
          organizationSlug: r.org_slug,
          messageBody: r.body ? r.body.slice(0, 200) : null,
          messageType: r.message_type,
          threadId: r.thread_id,
          createdAt: r.created_at.toISOString(),
          hallucinationCount: Number(r.halluc_count),
          citationCount: Number(r.cit_count),
          model: r.model,
          promptTokens: r.prompt_tokens,
          completionTokens: r.completion_tokens,
          latencyMs: r.latency_ms,
        })),
        nextCursor: hasMore ? trimmed[trimmed.length - 1]!.id : null,
      };
    },
  );

  // ---------- GET /aligned-admin/provenance/suppressions ------------------
  // Phase 8 / 1.7 — list every suppression row visible to an ALIGNED
  // admin: GLOBAL rows + every tenant's per-org rows. The UI groups
  // them by scope.
  r.get(
    '/aligned-admin/provenance/suppressions',
    {
      schema: {
        tags: ['admin'],
        summary: 'ALIGNED-admin only — list all provenance suppression rows (global + per-org).',
        querystring: z.object({
          scope: z.enum(['all', 'global', 'org']).default('all'),
          organizationId: z.string().uuid().optional(),
        }),
      },
      preHandler: [app.requireAlignedAdmin],
    },
    async (req) => {
      const rows = await withRlsBypass(async (tx) => {
        return tx.provenanceSuppression.findMany({
          where: {
            ...(req.query.scope === 'global' ? { organizationId: null } : {}),
            ...(req.query.scope === 'org' ? { NOT: { organizationId: null } } : {}),
            ...(req.query.organizationId ? { organizationId: req.query.organizationId } : {}),
          },
          orderBy: [{ organizationId: 'asc' }, { createdAt: 'desc' }],
          include: {
            organization: { select: { id: true, name: true, slug: true } },
            createdBy: { select: { email: true, firstName: true, lastName: true } },
          },
          take: 500,
        });
      });
      return {
        data: rows.map((r) => ({
          id: r.id,
          phrase: r.phrase,
          note: r.note,
          scope: r.organizationId === null ? ('global' as const) : ('org' as const),
          organizationId: r.organizationId,
          organizationName: r.organization?.name ?? null,
          organizationSlug: r.organization?.slug ?? null,
          createdByEmail: r.createdBy?.email ?? null,
          createdByName: r.createdBy
            ? [r.createdBy.firstName, r.createdBy.lastName].filter(Boolean).join(' ') ||
              null
            : null,
          createdAt: r.createdAt.toISOString(),
          matchesCount: r.matchesCount,
          lastMatchedAt: r.lastMatchedAt?.toISOString() ?? null,
        })),
      };
    },
  );

  // ---------- POST /aligned-admin/provenance/suppressions ----------------
  // Manually add a suppression — global or for a specific org.
  r.post(
    '/aligned-admin/provenance/suppressions',
    {
      schema: {
        tags: ['admin'],
        summary: 'ALIGNED-admin only — manually add a suppression row.',
        body: z.object({
          phrase: z.string().trim().min(1).max(200),
          note: z.string().trim().max(500).optional(),
          scope: z.enum(['global', 'org']),
          organizationId: z.string().uuid().optional(),
        }),
      },
      preHandler: [app.requireAlignedAdmin],
    },
    async (req, reply) => {
      if (req.body.scope === 'org' && !req.body.organizationId) {
        reply.code(400);
        return {
          error: {
            code: ApiErrorCode.VALIDATION_ERROR,
            message: 'organizationId required when scope=org',
          },
        };
      }
      const { normalisePhraseForSuppression } = await import(
        '../../lib/provenance-scanner.js'
      );
      const phrase = normalisePhraseForSuppression(req.body.phrase);
      if (phrase.length === 0) {
        reply.code(400);
        return {
          error: {
            code: ApiErrorCode.VALIDATION_ERROR,
            message: 'Phrase normalises to empty',
          },
        };
      }
      const orgId = req.body.scope === 'global' ? null : req.body.organizationId!;
      const created = await withRlsBypass(async (tx) => {
        const existing = await tx.provenanceSuppression.findFirst({
          where: { organizationId: orgId, phrase },
          select: { id: true },
        });
        if (existing) return { id: existing.id, alreadyExists: true };
        const row = await tx.provenanceSuppression.create({
          data: {
            organizationId: orgId,
            phrase,
            note: req.body.note ?? null,
            createdByUserId: req.auth!.userId,
          },
          select: { id: true },
        });
        return { id: row.id, alreadyExists: false };
      });
      return { data: created };
    },
  );

  // ---------- DELETE /aligned-admin/provenance/suppressions/:id ----------
  r.delete(
    '/aligned-admin/provenance/suppressions/:id',
    {
      schema: {
        tags: ['admin'],
        summary: 'ALIGNED-admin only — remove a suppression row.',
        params: z.object({ id: uuidSchema }),
      },
      preHandler: [app.requireAlignedAdmin],
    },
    async (req) => {
      await withRlsBypass((tx) =>
        tx.provenanceSuppression.delete({ where: { id: req.params.id } }),
      );
      return { ok: true as const };
    },
  );

  // ---------- POST /aligned-admin/provenance/suppressions/:id/promote ----
  // Promote a per-org row to global by clearing organization_id. If a
  // global row with the same phrase already exists, the per-org row is
  // just deleted (the global one already covers everyone).
  r.post(
    '/aligned-admin/provenance/suppressions/:id/promote-global',
    {
      schema: {
        tags: ['admin'],
        summary: 'ALIGNED-admin only — promote a per-org suppression to global.',
        params: z.object({ id: uuidSchema }),
      },
      preHandler: [app.requireAlignedAdmin],
    },
    async (req, reply) => {
      const result = await withRlsBypass(async (tx) => {
        const row = await tx.provenanceSuppression.findUnique({
          where: { id: req.params.id },
          select: { id: true, phrase: true, organizationId: true },
        });
        if (!row) return { error: 'not_found' as const };
        if (row.organizationId === null) {
          return { error: 'already_global' as const };
        }
        const existingGlobal = await tx.provenanceSuppression.findFirst({
          where: { organizationId: null, phrase: row.phrase },
          select: { id: true },
        });
        if (existingGlobal) {
          // Already covered globally — just delete the per-org duplicate.
          await tx.provenanceSuppression.delete({ where: { id: row.id } });
          return { ok: true, promotedId: existingGlobal.id, alreadyExisted: true };
        }
        const promoted = await tx.provenanceSuppression.update({
          where: { id: row.id },
          data: { organizationId: null },
          select: { id: true },
        });
        return { ok: true, promotedId: promoted.id, alreadyExisted: false };
      });
      if ('error' in result) {
        reply.code(result.error === 'not_found' ? 404 : 400);
        return {
          error: {
            code:
              result.error === 'not_found'
                ? ApiErrorCode.NOT_FOUND
                : ApiErrorCode.VALIDATION_ERROR,
            message: result.error,
          },
        };
      }
      return { data: { promotedId: result.promotedId, alreadyExisted: result.alreadyExisted } };
    },
  );

  // ============================================================
  //   AI plan + usage — per-tenant tier + cost roll-up
  // ============================================================

  // ---------- GET /aligned-admin/orgs/:id/ai-usage ----------------------
  // Token + USD usage rolled up per day/week/month. Reads
  // MessageProvenance rows (one per bot reply) for the org, groups by
  // day, costs each row at the rate of the model that actually ran
  // (via CHAT_PRICING in lib/ai-pricing.ts). Heavy-ish query for orgs
  // with millions of bot replies; bounded by `since` so the typical
  // 30-day window stays cheap.
  r.get(
    '/aligned-admin/orgs/:id/ai-usage',
    {
      schema: {
        tags: ['admin'],
        summary: 'Per-tenant AI token + USD usage rolled up per day / week / month.',
        params: z.object({ id: uuidSchema }),
        response: {
          200: itemEnvelopeSchema(
            z.object({
              aiPlan: z.enum(['basic', 'middle', 'max', 'ultra']),
              today: z.object({
                tokens: z.number().int(),
                inputTokens: z.number().int(),
                outputTokens: z.number().int(),
                usd: z.number(),
                replies: z.number().int(),
              }),
              thisWeek: z.object({
                tokens: z.number().int(),
                inputTokens: z.number().int(),
                outputTokens: z.number().int(),
                usd: z.number(),
                replies: z.number().int(),
              }),
              thisMonth: z.object({
                tokens: z.number().int(),
                inputTokens: z.number().int(),
                outputTokens: z.number().int(),
                usd: z.number(),
                replies: z.number().int(),
              }),
              // Last 30 days broken out per day, oldest first. Lets the
              // admin UI render a sparkline / bar chart cheaply.
              dailySeries: z.array(
                z.object({
                  date: z.string(), // YYYY-MM-DD UTC
                  tokens: z.number().int(),
                  usd: z.number(),
                  replies: z.number().int(),
                }),
              ),
              // Per-model breakdown over the last 30 days — surfaces
              // when an org is split across the basic-tier fallback
              // chain (groq + gpt-4o-mini) vs the plan they're actually
              // on. Useful for diagnosing "why did my bill spike?".
              byModel: z.array(
                z.object({
                  model: z.string(),
                  tokens: z.number().int(),
                  usd: z.number(),
                  replies: z.number().int(),
                }),
              ),
              // Subscription plan + per-quota usage/caps/percentage so the
              // admin sees BOTH money (USD above) and quota % in one place.
              planCode: z.string(),
              quotas: z.array(
                z.object({
                  key: z.string(),
                  label: z.string(),
                  monthly: z.boolean(),
                  used: z.number().int(),
                  cap: z.number().int().nullable(),
                  pct: z.number().int().nullable(),
                }),
              ),
            }),
          ),
        },
      },
      preHandler: [app.requireAlignedAdmin],
    },
    async (req) => {
      const { tokensToUsd } = await import('../../lib/ai-pricing.js');
      const { getOrgQuotas } = await import('../../lib/billing.js');
      const orgId = req.params.id;
      const now = new Date();
      const startOfTodayUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
      const sevenDaysAgo = new Date(startOfTodayUtc.getTime() - 6 * 24 * 60 * 60 * 1000);
      const thirtyDaysAgo = new Date(startOfTodayUtc.getTime() - 29 * 24 * 60 * 60 * 1000);
      const startOfMonthUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

      const org = await withRlsBypass((tx) =>
        tx.organization.findUnique({ where: { id: orgId }, select: { id: true, aiPlan: true } }),
      );
      if (!org) throw notFound('Organization not found');

      // Pull every provenance row inside the 30-day window in one
      // query — small payload (just model + token counts + createdAt),
      // big enough window that we can derive today / this-week / this-
      // month + per-day series from a single fetch.
      const rows = await withRlsBypass((tx) =>
        tx.messageProvenance.findMany({
          where: { organizationId: orgId, createdAt: { gte: thirtyDaysAgo } },
          select: {
            model: true,
            promptTokens: true,
            completionTokens: true,
            createdAt: true,
          },
        }),
      );

      type Bucket = {
        tokens: number;
        inputTokens: number;
        outputTokens: number;
        usd: number;
        replies: number;
      };
      const empty = (): Bucket => ({
        tokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        usd: 0,
        replies: 0,
      });
      const today = empty();
      const thisWeek = empty();
      const thisMonth = empty();
      const byDay = new Map<string, Bucket>();
      const byModel = new Map<string, Bucket>();

      for (let i = 0; i < 30; i += 1) {
        const d = new Date(startOfTodayUtc.getTime() - (29 - i) * 24 * 60 * 60 * 1000);
        byDay.set(d.toISOString().slice(0, 10), empty());
      }

      for (const row of rows) {
        const usd = tokensToUsd(row.model, row.promptTokens, row.completionTokens);
        const total = row.promptTokens + row.completionTokens;
        const day = row.createdAt.toISOString().slice(0, 10);

        const bumpInto = (b: Bucket) => {
          b.tokens += total;
          b.inputTokens += row.promptTokens;
          b.outputTokens += row.completionTokens;
          b.usd += usd;
          b.replies += 1;
        };

        if (row.createdAt >= startOfTodayUtc) bumpInto(today);
        if (row.createdAt >= sevenDaysAgo) bumpInto(thisWeek);
        if (row.createdAt >= startOfMonthUtc) bumpInto(thisMonth);

        const dayBucket = byDay.get(day);
        if (dayBucket) bumpInto(dayBucket);

        const modelBucket = byModel.get(row.model) ?? empty();
        bumpInto(modelBucket);
        byModel.set(row.model, modelBucket);
      }

      const dailySeries = Array.from(byDay.entries()).map(([date, b]) => ({
        date,
        tokens: b.tokens,
        usd: Number(b.usd.toFixed(4)),
        replies: b.replies,
      }));

      const byModelArr = Array.from(byModel.entries())
        .map(([model, b]) => ({
          model,
          tokens: b.tokens,
          usd: Number(b.usd.toFixed(4)),
          replies: b.replies,
        }))
        .sort((a, b) => b.usd - a.usd);

      const round = (b: Bucket) => ({
        tokens: b.tokens,
        inputTokens: b.inputTokens,
        outputTokens: b.outputTokens,
        usd: Number(b.usd.toFixed(4)),
        replies: b.replies,
      });

      const { planCode, quotas } = await withRlsBypass((tx) => getOrgQuotas(tx as never, orgId));

      return {
        data: {
          aiPlan: (org as { aiPlan?: 'basic' | 'middle' | 'max' | 'ultra' }).aiPlan ?? 'basic',
          today: round(today),
          thisWeek: round(thisWeek),
          thisMonth: round(thisMonth),
          dailySeries,
          byModel: byModelArr,
          planCode,
          quotas,
        },
      };
    },
  );

  // ---------- PUT /aligned-admin/orgs/:id/ai-plan -----------------------
  // Admin changes a tenant's AI tier. Persisted on Organization.aiPlan;
  // the chat dispatch reads it on next reply (within ~30s — the
  // in-process plan cache expires that quickly, see lib/openai.ts).
  r.put(
    '/aligned-admin/orgs/:id/ai-plan',
    {
      schema: {
        tags: ['admin'],
        summary: 'Change a tenant\'s AI plan (basic / middle / max).',
        params: z.object({ id: uuidSchema }),
        body: z.object({ aiPlan: z.enum(['basic', 'middle', 'max', 'ultra']) }),
        response: {
          200: itemEnvelopeSchema(
            z.object({
              id: uuidSchema,
              aiPlan: z.enum(['basic', 'middle', 'max', 'ultra']),
            }),
          ),
        },
      },
      preHandler: [app.requireAlignedAdmin],
    },
    async (req) => {
      const orgId = req.params.id;
      const next = req.body.aiPlan;
      const updated = await withRlsBypass(async (tx) => {
        const existing = await tx.organization.findUnique({
          where: { id: orgId },
          select: { id: true, aiPlan: true },
        });
        if (!existing) return null;
        const prev = (existing as { aiPlan?: 'basic' | 'middle' | 'max' | 'ultra' }).aiPlan ?? 'basic';
        if (prev === next) {
          return { id: existing.id, aiPlan: prev, prev, changed: false };
        }
        const row = await tx.organization.update({
          where: { id: orgId },
          data: { aiPlan: next },
          select: { id: true, aiPlan: true },
        });
        const newPlan = (row as { aiPlan?: 'basic' | 'middle' | 'max' | 'ultra' }).aiPlan ?? next;
        return { id: row.id, aiPlan: newPlan, prev, changed: true };
      });
      if (!updated) throw notFound('Organization not found');
      if (updated.changed) {
        // recordAudit opens its own tx (with RLS bypass) — call it
        // after the org update commits so audit + state stay aligned.
        await recordAudit({
          organizationId: orgId,
          actorUserId: req.auth!.userId,
          action: 'ai_plan_changed',
          entityType: 'organization',
          entityId: orgId,
          metadata: { from: updated.prev, to: next },
        });
      }
      return { data: { id: updated.id, aiPlan: updated.aiPlan } };
    },
  );

  // ---------- PUT /aligned-admin/orgs/:id/features ----------------------
  // ALIGNED-admin sets which features a tenant can access. The keys here are
  // DISABLED: their portal pages are hidden + route-guarded, and 'ai' turns off
  // the bot's auto-reply (manual social-media handler). Validated against the
  // shared ORG_FEATURES registry so unknown keys are rejected.
  r.put(
    '/aligned-admin/orgs/:id/features',
    {
      schema: {
        tags: ['admin'],
        summary: 'Set a tenant\'s disabled features (page/AI access control).',
        params: z.object({ id: uuidSchema }),
        body: z.object({
          disabledFeatures: z.array(z.enum(ORG_FEATURE_KEYS as [string, ...string[]])).max(20),
        }),
        response: {
          200: itemEnvelopeSchema(
            z.object({ id: uuidSchema, disabledFeatures: z.array(z.string()) }),
          ),
        },
      },
      preHandler: [app.requireAlignedAdmin],
    },
    async (req) => {
      const orgId = req.params.id;
      const next = Array.from(new Set(req.body.disabledFeatures));
      // Self-lockout guard: an admin can't change access on an org they belong
      // to (their own admin account stays fixed — can't disable their own pages
      // or hand themselves a restricted view).
      const ownMembership = await withRlsBypass((tx) =>
        tx.membership.findFirst({
          where: { organizationId: orgId, userId: req.auth!.userId },
          select: { id: true },
        }),
      );
      if (ownMembership) {
        throw badRequest(
          ApiErrorCode.VALIDATION_ERROR,
          'You cannot change access on an organisation you belong to (e.g. your own admin account).',
        );
      }
      const row = await withRlsBypass(async (tx) => {
        const existing = await tx.organization.findUnique({
          where: { id: orgId },
          select: { id: true, disabledFeatures: true },
        });
        if (!existing) return null;
        return tx.organization.update({
          where: { id: orgId },
          data: { disabledFeatures: next },
          select: { id: true, disabledFeatures: true },
        });
      });
      if (!row) throw notFound('Organization not found');
      await recordAudit({
        organizationId: orgId,
        actorUserId: req.auth!.userId,
        action: 'org_suspended', // reuse: closest existing admin audit action
        entityType: 'organization',
        entityId: orgId,
        metadata: { event: 'features_changed', disabledFeatures: next },
      });
      return { data: { id: row.id, disabledFeatures: row.disabledFeatures } };
    },
  );

  // ---------- ALIGNED-admin: export ANY org's data -----------------------
  // ALIGNED admins can export a tenant's full data bundle at any time, even
  // when the tenant's own self-service 'exports' feature is turned off. Reuses
  // the same BullMQ worker + DataExport rows as the self-service flow; the
  // admin downloads from this panel (the worker's email link is tenant-only).
  const adminExportSchema = z.object({
    id: uuidSchema,
    status: z.enum(['pending', 'running', 'succeeded', 'failed']),
    fileSizeBytes: z.number().int().nullable(),
    errorMessage: z.string().nullable(),
    startedAt: z.string().datetime().nullable(),
    finishedAt: z.string().datetime().nullable(),
    createdAt: z.string().datetime(),
  });

  r.get(
    '/aligned-admin/orgs/:id/exports',
    {
      schema: {
        tags: ['admin'],
        summary: "List a tenant's recent data exports.",
        params: z.object({ id: uuidSchema }),
        response: { 200: listEnvelopeSchema(adminExportSchema) },
      },
      preHandler: [app.requireAlignedAdmin],
    },
    async (req) => {
      const rows = await withRlsBypass((tx) =>
        tx.dataExport.findMany({
          where: { organizationId: req.params.id },
          orderBy: { createdAt: 'desc' },
          take: 25,
        }),
      );
      return {
        data: rows.map((e) => ({
          id: e.id,
          status: e.status as 'pending' | 'running' | 'succeeded' | 'failed',
          fileSizeBytes: e.fileSizeBytes,
          errorMessage: e.errorMessage,
          startedAt: e.startedAt?.toISOString() ?? null,
          finishedAt: e.finishedAt?.toISOString() ?? null,
          createdAt: e.createdAt.toISOString(),
        })),
        nextCursor: null,
      };
    },
  );

  r.post(
    '/aligned-admin/orgs/:id/export',
    {
      schema: {
        tags: ['admin'],
        summary: "Trigger a full data export for any tenant (bypasses the tenant's feature toggle).",
        params: z.object({ id: uuidSchema }),
        response: { 201: itemEnvelopeSchema(adminExportSchema) },
      },
      preHandler: [app.requireAlignedAdmin],
    },
    async (req, reply) => {
      const orgId = req.params.id;
      const org = await withRlsBypass((tx) =>
        tx.organization.findUnique({ where: { id: orgId }, select: { id: true } }),
      );
      if (!org) throw notFound('Organization not found');

      // Don't pile up exports — refuse if one is already in flight.
      const inflight = await withRlsBypass((tx) =>
        tx.dataExport.findFirst({
          where: { organizationId: orgId, status: { in: ['pending', 'running'] } },
        }),
      );
      if (inflight) {
        throw badRequest(
          ApiErrorCode.CONFLICT,
          'An export is already in progress for this organisation.',
        );
      }

      const admin = await withRlsBypass((tx) =>
        tx.user.findUnique({ where: { id: req.auth!.userId }, select: { email: true } }),
      );

      const created = await withRlsBypass((tx) =>
        tx.dataExport.create({
          data: { organizationId: orgId, requestedByUserId: req.auth!.userId, status: 'pending' },
        }),
      );

      await getDataExportQueue().add(
        'data-export',
        {
          organizationId: orgId,
          requestedByUserId: req.auth!.userId,
          requestedByEmail: admin?.email ?? env.EMAIL_FROM,
          exportId: created.id,
        },
        {
          attempts: 1,
          removeOnComplete: { age: 24 * 60 * 60 },
          removeOnFail: { age: 7 * 24 * 60 * 60 },
        },
      );

      await recordAudit({
        organizationId: orgId,
        actorUserId: req.auth!.userId,
        action: 'org_suspended', // reuse: closest existing admin audit action
        entityType: 'organization',
        entityId: orgId,
        metadata: { event: 'admin_data_export_requested', exportId: created.id },
      });

      reply.code(201);
      return {
        data: {
          id: created.id,
          status: 'pending' as const,
          fileSizeBytes: null,
          errorMessage: null,
          startedAt: null,
          finishedAt: null,
          createdAt: created.createdAt.toISOString(),
        },
      };
    },
  );

  r.get(
    '/aligned-admin/orgs/:id/exports/:exportId/download',
    {
      schema: {
        tags: ['admin'],
        summary: 'Get a short-lived signed download URL for a tenant export.',
        params: z.object({ id: uuidSchema, exportId: uuidSchema }),
        response: {
          200: itemEnvelopeSchema(z.object({ url: z.string().url(), expiresInSeconds: z.number() })),
        },
      },
      preHandler: [app.requireAlignedAdmin],
    },
    async (req) => {
      const row = await withRlsBypass((tx) =>
        tx.dataExport.findFirst({
          where: { id: req.params.exportId, organizationId: req.params.id },
        }),
      );
      if (!row) throw notFound('Export not found.');
      if (row.status !== 'succeeded' || !row.storageKey) {
        throw badRequest(ApiErrorCode.VALIDATION_ERROR, 'Export is not ready for download.');
      }
      const url = await presignGetUrl(row.storageKey);
      return { data: { url, expiresInSeconds: 900 } };
    },
  );

  // ---------- Leads (public marketing-site captures) ----------------------
  const toLeadDto = (l: {
    id: string;
    name: string;
    phone: string;
    source: string;
    status: 'new' | 'contacted' | 'converted' | 'archived';
    note: string | null;
    createdAt: Date;
  }) => ({
    id: l.id,
    name: l.name,
    phone: l.phone,
    source: l.source,
    status: l.status,
    note: l.note,
    createdAt: l.createdAt.toISOString(),
  });

  r.get(
    '/aligned-admin/leads',
    {
      schema: {
        tags: ['admin'],
        summary: 'List marketing leads captured from the public landing page.',
        querystring: adminListLeadsQuerySchema,
        response: { 200: listEnvelopeSchema(leadSchema) },
      },
      preHandler: [app.requireAlignedAdmin],
    },
    async (req) => {
      const leads = await withRlsBypass((tx) =>
        tx.lead.findMany({
          where: {
            ...(req.query.status ? { status: req.query.status } : {}),
            ...(req.query.q
              ? {
                  OR: [
                    { name: { contains: req.query.q, mode: 'insensitive' as const } },
                    { phone: { contains: req.query.q } },
                  ],
                }
              : {}),
          },
          orderBy: { createdAt: 'desc' },
          take: req.query.limit,
        }),
      );
      return { data: leads.map(toLeadDto), nextCursor: null };
    },
  );

  r.get(
    '/aligned-admin/leads/count',
    {
      schema: {
        tags: ['admin'],
        summary: 'Count of new (unhandled) leads — drives the sidebar badge.',
        response: {
          200: z.object({
            data: z.object({ new: z.number().int(), total: z.number().int() }),
          }),
        },
      },
      preHandler: [app.requireAlignedAdmin],
    },
    async () => {
      const [newCount, total] = await withRlsBypass((tx) =>
        Promise.all([tx.lead.count({ where: { status: 'new' } }), tx.lead.count()]),
      );
      return { data: { new: newCount, total } };
    },
  );

  r.patch(
    '/aligned-admin/leads/:id',
    {
      schema: {
        tags: ['admin'],
        summary: 'Update a lead (status / note).',
        params: z.object({ id: uuidSchema }),
        body: adminUpdateLeadBodySchema,
        response: { 200: itemEnvelopeSchema(leadSchema) },
      },
      preHandler: [app.requireAlignedAdmin],
    },
    async (req) => {
      const lead = await withRlsBypass((tx) =>
        tx.lead.update({
          where: { id: req.params.id },
          data: {
            ...(req.body.status ? { status: req.body.status } : {}),
            ...(req.body.note !== undefined ? { note: req.body.note } : {}),
          },
        }),
      );
      return { data: toLeadDto(lead) };
    },
  );

  r.delete(
    '/aligned-admin/leads/:id',
    {
      schema: {
        tags: ['admin'],
        summary: 'Delete a lead.',
        params: z.object({ id: uuidSchema }),
        response: { 200: successSchema },
      },
      preHandler: [app.requireAlignedAdmin],
    },
    async (req) => {
      await withRlsBypass((tx) => tx.lead.delete({ where: { id: req.params.id } }));
      return { ok: true as const };
    },
  );
}
