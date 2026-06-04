// Portal dashboard endpoints. The page's per-widget hooks each call a
// dedicated route below so widgets can be polled independently at the
// cadence each one needs (10s for live campaigns, 30-60s for counts).
//
// /dashboard/summary kept for back-compat with the older monolithic
// dashboard query (now used only by a couple of widgets). New widgets
// added since 2026-06 each have their own /dashboard/widgets/* route.
import {
  itemEnvelopeSchema,
  uuidSchema,
} from '@aligned/shared';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { withRlsBypass } from '../../lib/db.js';
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

  // ---------- GET /dashboard/ai-usage -------------------------------------
  // Today's AI token usage for the active org. Powers the small "AI
  // budget remaining" widget on /dashboard. Returns 0% used + unlimited
  // = true for ALIGNED-admin-operated orgs so the bar reads "Unlimited".
  r.get(
    '/dashboard/ai-usage',
    {
      schema: {
        tags: ['dashboard'],
        summary: "Today's AI token usage for the current org.",
        response: {
          200: itemEnvelopeSchema(
            z.object({
              used: z.number().int().nonnegative(),
              limit: z.number().int().nonnegative(),
              unlimited: z.boolean(),
              percentUsed: z.number().int().min(0).max(100),
              estCostUsd: z.number().nonnegative(),
            }),
          ),
        },
      },
      preHandler: [app.requireRole('viewer')],
    },
    async (req) => {
      const orgId = req.auth!.organizationId;
      const { readDailyTokenUsage } = await import('../../lib/openai.js');
      const data = await readDailyTokenUsage(orgId);
      // Force unlimited when the JWT says admin — covers the case where
      // the org's membership-based check missed for any reason.
      if (req.auth!.isAlignedAdmin && !data.unlimited) {
        return { data: { ...data, unlimited: true, percentUsed: 0 } };
      }
      return { data };
    },
  );

  // ============================================================
  //   Per-widget endpoints (one per dashboard widget, real data)
  // ============================================================

  // ---------- GET /dashboard/widgets/kpi ----------------------------------
  // KPI strip — products / services / FAQs / contacts with derived
  // subtext (missing-data counts, weekly-new contacts, etc).
  r.get(
    '/dashboard/widgets/kpi',
    {
      schema: {
        tags: ['dashboard'],
        summary: 'Counts + derived subtext for the dashboard KPI strip.',
        response: {
          200: itemEnvelopeSchema(
            z.object({
              products: z.object({ total: z.number().int(), incomplete: z.number().int() }),
              services: z.object({ total: z.number().int(), incomplete: z.number().int() }),
              faqs: z.object({ total: z.number().int() }),
              contacts: z.object({ total: z.number().int(), newThisWeek: z.number().int() }),
            }),
          ),
        },
      },
      preHandler: [app.requireRole('viewer')],
    },
    async (req) => {
      const data = await app.tenant(req, async (tx) => {
        const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        const [
          productsTotal,
          productsIncomplete,
          servicesTotal,
          servicesIncomplete,
          faqsTotal,
          contactsTotal,
          contactsNewThisWeek,
        ] = await Promise.all([
          tx.product.count({ where: { deletedAt: null } }),
          // "Incomplete" = missing a price OR no images.
          tx.product.count({
            where: {
              deletedAt: null,
              OR: [{ priceMinor: null }, { images: { none: {} } }],
            },
          }),
          tx.service.count({ where: { deletedAt: null } }),
          tx.service.count({
            where: { deletedAt: null, OR: [{ description: null }, { basePriceMinor: null }] },
          }),
          tx.fAQ.count({ where: { visibility: 'public' } }),
          tx.contact.count(),
          tx.contact.count({ where: { createdAt: { gte: oneWeekAgo } } }),
        ]);
        return {
          products: { total: productsTotal, incomplete: productsIncomplete },
          services: { total: servicesTotal, incomplete: servicesIncomplete },
          faqs: { total: faqsTotal },
          contacts: { total: contactsTotal, newThisWeek: contactsNewThisWeek },
        };
      });
      return { data };
    },
  );

  // ---------- GET /dashboard/widgets/inbox-snapshot ------------------------
  // Open / unassigned / awaiting-reply counts + a rough avg first-response.
  // Avg first-response is approximated as the median over the last 50
  // resolved threads — close enough for an at-a-glance widget without
  // needing a separate aggregation table.
  r.get(
    '/dashboard/widgets/inbox-snapshot',
    {
      schema: {
        tags: ['dashboard'],
        summary: 'Live inbox snapshot for the dashboard widget.',
        response: {
          200: itemEnvelopeSchema(
            z.object({
              openThreads: z.number().int(),
              unassigned: z.number().int(),
              awaitingReply: z.number().int(),
              avgFirstResponseSeconds: z.number().int().nullable(),
            }),
          ),
        },
      },
      preHandler: [app.requireRole('viewer')],
    },
    async (req) => {
      const data = await app.tenant(req, async (tx) => {
        const [openThreads, unassigned] = await Promise.all([
          tx.whatsAppThread.count({ where: { status: 'open' } }),
          tx.whatsAppThread.count({ where: { status: 'open', assignedToUserId: null } }),
        ]);

        // "Awaiting reply" = open threads whose most-recent message is
        // inbound (customer talked last). Hard to express in Prisma
        // count without an N+1, so a single raw query.
        const awaiting = (await tx.$queryRawUnsafe(`
          SELECT COUNT(*)::int AS count FROM whatsapp_threads t
          WHERE t.status = 'open'
            AND t.organization_id = current_setting('app.current_org_id')::uuid
            AND EXISTS (
              SELECT 1 FROM whatsapp_messages m
              WHERE m.thread_id = t.id
                AND m.direction = 'inbound'
                AND m.received_at = (
                  SELECT MAX(received_at) FROM whatsapp_messages m2 WHERE m2.thread_id = t.id
                )
            )
        `)) as { count: number }[];
        const awaitingReply = awaiting[0]?.count ?? 0;

        // First-response time per thread, sampled over the last 50
        // threads with at least one outbound. Median is robust to a
        // single sleepy night-shift skewing the mean.
        const samples = (await tx.$queryRawUnsafe(`
          WITH first_msgs AS (
            SELECT
              t.id AS thread_id,
              (SELECT MIN(m.received_at) FROM whatsapp_messages m WHERE m.thread_id = t.id AND m.direction = 'inbound') AS first_in,
              (SELECT MIN(m.received_at) FROM whatsapp_messages m WHERE m.thread_id = t.id AND m.direction = 'outbound') AS first_out
            FROM whatsapp_threads t
            WHERE t.organization_id = current_setting('app.current_org_id')::uuid
            ORDER BY t.last_message_at DESC
            LIMIT 50
          )
          SELECT EXTRACT(EPOCH FROM (first_out - first_in))::int AS seconds
          FROM first_msgs
          WHERE first_in IS NOT NULL AND first_out IS NOT NULL AND first_out > first_in
        `)) as { seconds: number }[];
        const sorted = samples.map((s) => s.seconds).sort((a, b) => a - b);
        const avgFirstResponseSeconds = sorted.length === 0
          ? null
          : sorted[Math.floor(sorted.length / 2)] ?? null;

        return { openThreads, unassigned, awaitingReply, avgFirstResponseSeconds };
      });
      return { data };
    },
  );

  // ---------- GET /dashboard/widgets/bot-performance ----------------------
  // Today (in account timezone — UTC for v1; revisit when we add
  // per-org TZ to BotConfig). Auto-resolved = bot outbound messages
  // that did NOT end in an escalation in the same thread today.
  r.get(
    '/dashboard/widgets/bot-performance',
    {
      schema: {
        tags: ['dashboard'],
        summary: "Today's bot KPIs for the dashboard widget.",
        response: {
          200: itemEnvelopeSchema(
            z.object({
              autoResolvedPercent: z.number().int().min(0).max(100),
              botHandledMessages: z.number().int(),
              handedToHuman: z.number().int(),
              topFaq: z.string().nullable(),
            }),
          ),
        },
      },
      preHandler: [app.requireRole('viewer')],
    },
    async (req) => {
      const data = await app.tenant(req, async (tx) => {
        const startOfDay = new Date();
        startOfDay.setUTCHours(0, 0, 0, 0);

        // Bot-handled = outbound messages today where rawPayload.sentBy='bot'.
        // Escalated = threads whose status flipped to 'escalated' today
        // (proxied by counting threads currently 'escalated' whose
        // updatedAt is today — close enough; a thread can only escalate
        // once per active session).
        const [botHandled, escalatedToday, allBotThreads] = await Promise.all([
          tx.whatsAppMessage.count({
            where: {
              direction: 'outbound',
              receivedAt: { gte: startOfDay },
              rawPayload: { path: ['sentBy'], equals: 'bot' },
            },
          }),
          tx.whatsAppThread.count({
            where: { status: 'escalated', updatedAt: { gte: startOfDay } },
          }),
          // Threads the bot replied in today. Used as the denominator
          // for auto-resolved %.
          tx.whatsAppThread.count({
            where: {
              messages: {
                some: {
                  direction: 'outbound',
                  receivedAt: { gte: startOfDay },
                  rawPayload: { path: ['sentBy'], equals: 'bot' },
                },
              },
            },
          }),
        ]);

        const autoResolvedPercent =
          allBotThreads === 0
            ? 0
            : Math.max(
                0,
                Math.min(100, Math.round(((allBotThreads - escalatedToday) / allBotThreads) * 100)),
              );

        // Top FAQ today — derived heuristically: pick the FAQ whose
        // question text most commonly substring-matches inbound message
        // bodies today. Cheap for the small FAQ counts each tenant has
        // (1-50). Returns NULL when no inbound matched any FAQ.
        const faqs = await tx.fAQ.findMany({
          where: { visibility: 'public' },
          select: { id: true, question: true },
        });
        let topFaq: string | null = null;
        if (faqs.length > 0) {
          const inbound = await tx.whatsAppMessage.findMany({
            where: { direction: 'inbound', receivedAt: { gte: startOfDay }, body: { not: null } },
            select: { body: true },
            take: 500,
          });
          const counts = new Map<string, number>();
          for (const m of inbound) {
            const body = (m.body ?? '').toLowerCase();
            for (const f of faqs) {
              const q = f.question.toLowerCase();
              if (q.length < 4) continue;
              if (body.includes(q.slice(0, Math.min(20, q.length)))) {
                counts.set(f.question, (counts.get(f.question) ?? 0) + 1);
              }
            }
          }
          let best = 0;
          for (const [q, c] of counts) {
            if (c > best) {
              best = c;
              topFaq = q;
            }
          }
        }

        return {
          autoResolvedPercent,
          botHandledMessages: botHandled,
          handedToHuman: escalatedToday,
          topFaq,
        };
      });
      return { data };
    },
  );

  // ---------- GET /dashboard/widgets/outreach -----------------------------
  // Most-recent live (sending/paused) broadcast — or null when nothing
  // is in flight. Counters come from the broadcast row directly: the
  // send worker and webhook handler keep them in sync.
  r.get(
    '/dashboard/widgets/outreach',
    {
      schema: {
        tags: ['dashboard'],
        summary: 'Active broadcast campaign for the dashboard widget.',
        response: {
          200: itemEnvelopeSchema(
            z.object({
              active: z
                .object({
                  id: uuidSchema,
                  name: z.string(),
                  status: z.string(),
                  sent: z.number().int(),
                  delivered: z.number().int(),
                  read: z.number().int(),
                })
                .nullable(),
            }),
          ),
        },
      },
      preHandler: [app.requireRole('viewer')],
    },
    async (req) => {
      const data = await app.tenant(req, async (tx) => {
        const live = await tx.broadcast.findFirst({
          where: { status: { in: ['sending', 'paused'] } },
          orderBy: { startedAt: 'desc' },
          select: {
            id: true,
            name: true,
            status: true,
            sentCount: true,
            deliveredCount: true,
            readCount: true,
          },
        });
        if (!live) return { active: null };
        return {
          active: {
            id: live.id,
            name: live.name,
            status: live.status,
            sent: live.sentCount,
            delivered: live.deliveredCount,
            read: live.readCount,
          },
        };
      });
      return { data };
    },
  );

  // ---------- GET /dashboard/widgets/connections-sync ---------------------
  // Last sync + WhatsApp template approval counts + webhook health.
  // Health is derived: any endpoint with >0 consecutive failures
  // counts as degraded; >=5 consecutive failures = failing.
  r.get(
    '/dashboard/widgets/connections-sync',
    {
      schema: {
        tags: ['dashboard'],
        summary: 'Connections / sync health for the dashboard widget.',
        response: {
          200: itemEnvelopeSchema(
            z.object({
              lastSyncIso: z.string().datetime().nullable(),
              templates: z.object({ approved: z.number().int(), pending: z.number().int() }),
              webhooks: z.enum(['healthy', 'degraded', 'failing']),
            }),
          ),
        },
      },
      preHandler: [app.requireRole('viewer')],
    },
    async (req) => {
      const data = await app.tenant(req, async (tx) => {
        const [lastSync, approved, pending, endpoints] = await Promise.all([
          tx.syncRun.findFirst({
            where: { finishedAt: { not: null } },
            orderBy: { finishedAt: 'desc' },
            select: { finishedAt: true },
          }),
          tx.whatsAppTemplate.count({ where: { status: 'approved' } }),
          tx.whatsAppTemplate.count({ where: { status: 'pending' } }),
          tx.webhookEndpoint.findMany({
            select: { consecutiveFailures: true, isActive: true },
          }),
        ]);
        let webhooks: 'healthy' | 'degraded' | 'failing' = 'healthy';
        const failing = endpoints.some((e) => e.consecutiveFailures >= 5 || !e.isActive);
        const degraded = endpoints.some((e) => e.consecutiveFailures > 0);
        if (failing) webhooks = 'failing';
        else if (degraded) webhooks = 'degraded';
        return {
          lastSyncIso: lastSync?.finishedAt?.toISOString() ?? null,
          templates: { approved, pending },
          webhooks,
        };
      });
      return { data };
    },
  );

  // ---------- GET /dashboard/widgets/onboarding ---------------------------
  // Checklist progress. Each step is "done" when the underlying
  // condition holds — there's no explicit per-step completed flag, so
  // we derive from the actual config.
  r.get(
    '/dashboard/widgets/onboarding',
    {
      schema: {
        tags: ['dashboard'],
        summary: 'Onboarding checklist progress for the dashboard widget.',
        response: {
          200: itemEnvelopeSchema(
            z.object({
              steps: z.array(
                z.object({
                  id: z.string(),
                  label: z.string(),
                  href: z.string(),
                  completed: z.boolean(),
                }),
              ),
              complete: z.boolean(),
            }),
          ),
        },
      },
      preHandler: [app.requireRole('viewer')],
    },
    async (req) => {
      const data = await app.tenant(req, async (tx) => {
        const [channel, products, services, botConfig] = await Promise.all([
          tx.whatsAppChannel.findFirst({
            where: { isPrimary: true },
            select: { isActive: true, accessToken: true, phoneNumberId: true },
          }),
          tx.product.count({ where: { deletedAt: null } }),
          tx.service.count({ where: { deletedAt: null } }),
          tx.botConfig.findFirst({
            select: { deployedAt: true, updatedAt: true, createdAt: true },
          }),
        ]);

        const connectWaDone =
          !!channel && channel.isActive && !!channel.accessToken && !!channel.phoneNumberId;
        const addCatalogDone = products > 0 || services > 0;
        // "Train bot" = bot config has been edited at least once
        // (operator opened /bot and saved). updatedAt > createdAt + 5s
        // is a good-enough proxy that the seed row wasn't merely
        // auto-created.
        const trainBotDone =
          !!botConfig &&
          botConfig.updatedAt.getTime() - botConfig.createdAt.getTime() > 5_000;
        const goLiveDone = !!botConfig?.deployedAt;

        const steps = [
          { id: 'connect-wa', label: 'Connect WhatsApp', href: '/whatsapp', completed: connectWaDone },
          { id: 'add-catalog', label: 'Add catalog', href: '/products', completed: addCatalogDone },
          { id: 'train-bot', label: 'Train bot', href: '/bot', completed: trainBotDone },
          { id: 'go-live', label: 'Go live', href: '/bot', completed: goLiveDone },
        ];
        return { steps, complete: steps.every((s) => s.completed) };
      });
      return { data };
    },
  );

  // ---------- GET /dashboard/widgets/recent-activity ----------------------
  // Latest 5 audit log entries. Mirrors what dashboard/summary's
  // recentAudits returns; broken out so the widget can poll its own
  // cadence (and so we can later add per-event icons / actor avatar
  // without touching the summary contract).
  r.get(
    '/dashboard/widgets/recent-activity',
    {
      schema: {
        tags: ['dashboard'],
        summary: 'Last 5 audit-log events for the dashboard widget.',
        response: {
          200: itemEnvelopeSchema(
            z.object({
              events: z.array(
                z.object({
                  id: uuidSchema,
                  kind: z.string(),
                  description: z.string(),
                  at: z.string().datetime(),
                }),
              ),
            }),
          ),
        },
      },
      preHandler: [app.requireRole('viewer')],
    },
    async (req) => {
      const data = await app.tenant(req, async (tx) => {
        const rows = await tx.auditLog.findMany({
          orderBy: { createdAt: 'desc' },
          take: 5,
          select: { id: true, action: true, entityType: true, createdAt: true },
        });
        return {
          events: rows.map((a) => ({
            id: a.id,
            kind: a.action,
            description: humaniseAction(a.action, a.entityType),
            at: a.createdAt.toISOString(),
          })),
        };
      });
      return { data };
    },
  );

  // ============================================================
  //   /me/dashboard-layout — per-user, cross-device layout persist
  // ============================================================

  const layoutSchema = z.object({
    widgets: z.array(z.string().min(1).max(64)).max(50),
  });

  // ---------- GET /me/dashboard-layout ------------------------------------
  r.get(
    '/me/dashboard-layout',
    {
      schema: {
        tags: ['dashboard'],
        summary: 'Current user’s saved dashboard widget layout.',
        response: { 200: itemEnvelopeSchema(layoutSchema.nullable()) },
      },
      preHandler: [app.requireAuth],
    },
    async (req) => {
      const userId = req.auth!.userId;
      const row = await withRlsBypass((tx) =>
        tx.user.findUnique({ where: { id: userId }, select: { dashboardLayout: true } }),
      );
      const stored = row?.dashboardLayout as { widgets?: unknown } | null;
      if (!stored || !Array.isArray(stored.widgets)) return { data: null };
      const widgets = stored.widgets.filter((w): w is string => typeof w === 'string');
      return { data: { widgets } };
    },
  );

  // ---------- PUT /me/dashboard-layout ------------------------------------
  r.put(
    '/me/dashboard-layout',
    {
      schema: {
        tags: ['dashboard'],
        summary: 'Persist the current user’s dashboard widget layout.',
        body: layoutSchema,
        response: { 200: itemEnvelopeSchema(layoutSchema) },
      },
      preHandler: [app.requireAuth],
    },
    async (req) => {
      const userId = req.auth!.userId;
      // Body is already validated + narrowed by the Zod type provider.
      const body = req.body as { widgets: string[] };
      await withRlsBypass((tx) =>
        tx.user.update({
          where: { id: userId },
          data: { dashboardLayout: { widgets: body.widgets } },
        }),
      );
      return { data: { widgets: body.widgets } };
    },
  );
}

// Map raw audit_log.action strings to human-readable phrases for the
// Recent activity widget. Falls back to a "Title-Case the action" so
// new event types still render OK without code changes.
function humaniseAction(action: string, entityType: string | null): string {
  const map: Record<string, string> = {
    product_updated: 'Product updated',
    product_created: 'Product added',
    service_updated: 'Service updated',
    service_created: 'Service added',
    login_succeeded: 'Login succeeded',
    business_info_updated: 'Business info updated',
    broadcast_sent: 'Broadcast sent',
    bot_deployed: 'Bot deployed',
    bot_undeployed: 'Bot rolled back',
    faq_updated: 'FAQ updated',
    faq_created: 'FAQ added',
    policy_updated: 'Policy updated',
  };
  if (map[action]) return map[action];
  const phrase = action.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  return entityType ? `${phrase} (${entityType})` : phrase;
}
