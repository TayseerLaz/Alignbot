// ALIGNED super-admin endpoints. Always run with RLS bypass since they
// inspect / manage data across tenants. Gated by `requireAlignedAdmin`.
import {
  adminCreateTenantBodySchema,
  adminCreateTenantResponseSchema,
  adminListOrgsQuerySchema,
  adminUpdateOrgBodySchema,
  ApiErrorCode,
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
import { REFRESH_COOKIE_NAME, refreshCookieOptions } from '../../lib/cookies.js';
import { generateTempPassword, hashPassword } from '../../lib/crypto.js';
import { withRlsBypass } from '../../lib/db.js';
import { sendEmail, tenantProvisionedTemplate } from '../../lib/email.js';
import { env } from '../../lib/env.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { getImportQueue, getSyncQueue, getWebhookQueue } from '../../lib/queues.js';
import { getRedis } from '../../lib/redis.js';
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
          data: { slug, name: body.organizationName, status: 'active' },
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

  // ---------- POST /aligned-admin/users/:id/reset-link ---------------------
  // ALIGNED-admin convenience: generate a one-time, hour-long password
  // reset link for any tenant member and return the URL. The admin then
  // DMs it to the customer (Slack / WhatsApp / email).
  //
  // We use the EXACT same token shape as /auth/forgot-password — the
  // /reset-password page on the portal already validates these. Token
  // is hashed at rest; only the plaintext URL returned here can
  // actually reset the password.
  //
  // We do NOT show the customer's current password. Passwords are
  // bcrypt-hashed; the platform never has the plaintext.
  r.post(
    '/aligned-admin/users/:id/reset-link',
    {
      schema: {
        tags: ['admin'],
        summary: 'Generate a one-hour password-reset URL for any user (admin convenience).',
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
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
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
}
