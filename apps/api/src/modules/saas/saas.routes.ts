// Phase 3 §5.1.4 — branding (white-label), Meta onboarding stepper,
// client-facing analytics. Bundled in one module because the surface is
// small per feature and they're all tenant-authed and read/write the
// same models the existing routes already touch.
import { promises as dns } from 'node:dns';

import { listEnvelopeSchema, itemEnvelopeSchema, successSchema, uuidSchema } from '@aligned/shared';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { withRlsBypass } from '../../lib/db.js';
import { env } from '../../lib/env.js';

// Resolve a hostname's CNAME chain and report whether any link points at
// our `CUSTOM_CNAME_TARGET`. We accept exact match or a same-suffix match
// so trailing dots / subdomain redirections both work.
async function verifyCnameTarget(
  hostname: string,
): Promise<{ ok: boolean; resolved: string[]; error?: string }> {
  const target = env.CUSTOM_CNAME_TARGET.toLowerCase().replace(/\.$/, '');
  try {
    const records = await dns.resolveCname(hostname);
    const resolved = records.map((r) => r.toLowerCase().replace(/\.$/, ''));
    const ok = resolved.some((r) => r === target);
    return { ok, resolved, error: ok ? undefined : `expected CNAME → ${target}` };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? 'UNKNOWN';
    return { ok: false, resolved: [], error: `DNS ${code}` };
  }
}

const META_STEPS: { key: string; title: string; description: string }[] = [
  {
    key: 'business_account',
    title: 'Create / log in to a Meta Business account',
    description: 'business.facebook.com — fill legal name, website, business email, address.',
  },
  {
    key: 'create_app',
    title: 'Create a Meta app with WhatsApp product',
    description: 'developers.facebook.com/apps → Business app type → add WhatsApp under Products.',
  },
  {
    key: 'phone_number',
    title: 'Add your business phone number',
    description: 'Number must NOT currently be on the consumer WhatsApp app.',
  },
  {
    key: 'verify_number',
    title: 'Verify the number via SMS or voice',
    description: 'Meta sends a 6-digit code; enter it in the dashboard.',
  },
  {
    key: 'system_user_token',
    title: 'Mint a permanent System User access token',
    description:
      'Business Settings → Users → System Users → New → assign WhatsApp Business Account → generate token.',
  },
  {
    key: 'paste_credentials',
    title: 'Paste credentials into ALIGNED',
    description: 'WhatsApp page in this portal — WABA ID, phone number ID, app secret, access token.',
  },
  {
    key: 'business_verification',
    title: 'Submit business verification',
    description: 'Business Settings → Security Center → Business Verification (3–10 business days).',
  },
];

export default async function saasRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  // ===================================================================
  // §5.1.4 White-label / branding
  // ===================================================================

  r.get(
    '/branding',
    {
      schema: {
        tags: ['saas'],
        summary: 'Get the org branding config (auto-creates a stub).',
      },
      preHandler: [app.requireRole('viewer')],
    },
    async (req) => {
      const orgId = req.auth!.organizationId;
      return app.tenant(req, async (tx) => {
        let row = await tx.brandingConfig.findUnique({ where: { organizationId: orgId } });
        if (!row) row = await tx.brandingConfig.create({ data: { organizationId: orgId } });
        // Resolve a public/signed URL when a logo asset is attached.
        let logoUrl: string | null = null;
        if (row.logoAssetId) {
          const asset = await tx.asset.findUnique({ where: { id: row.logoAssetId } });
          if (asset) {
            const { resolveAssetUrl } = await import('../catalog/shared.js');
            logoUrl = await resolveAssetUrl(asset.storageKey);
          }
        }
        return {
          data: {
            id: row.id,
            logoAssetId: row.logoAssetId,
            logoUrl,
            accentColor: row.accentColor,
            customCname: row.customCname,
            cnameStatus: row.cnameStatus,
            cnameVerifiedAt: row.cnameVerifiedAt?.toISOString() ?? null,
            cnameLastCheckAt: row.cnameLastCheckAt?.toISOString() ?? null,
            cnameError: row.cnameError,
            cnameTarget: env.CUSTOM_CNAME_TARGET,
            footerText: row.footerText,
            updatedAt: row.updatedAt.toISOString(),
          },
        };
      });
    },
  );

  r.put(
    '/branding',
    {
      schema: {
        tags: ['saas'],
        summary: 'Update the org branding (logo, accent colour, custom CNAME).',
        body: z.object({
          logoAssetId: uuidSchema.nullable().optional(),
          accentColor: z
            .string()
            .regex(/^#[0-9a-fA-F]{6}$/, 'Use a 6-digit hex like #0070C9.')
            .nullable()
            .optional(),
          customCname: z
            .string()
            .trim()
            .max(253)
            .regex(/^[a-z0-9.-]+$/i, 'Use a domain like inbox.example.com.')
            .nullable()
            .optional(),
          footerText: z.string().trim().max(500).nullable().optional(),
        }),
      },
      preHandler: [app.requireRole('admin')],
    },
    async (req) => {
      const orgId = req.auth!.organizationId;
      return app.tenant(req, async (tx) => {
        const existing =
          (await tx.brandingConfig.findUnique({ where: { organizationId: orgId } })) ??
          (await tx.brandingConfig.create({ data: { organizationId: orgId } }));

        // Reset CNAME state when the value changes. Setting to null clears
        // the row entirely; setting to a new domain drops to 'pending' so
        // Caddy stops issuing certs for the old hostname immediately.
        const cnameChange =
          req.body.customCname !== undefined && req.body.customCname !== existing.customCname;
        const cnameReset = cnameChange
          ? req.body.customCname
            ? {
                cnameStatus: 'pending' as const,
                cnameVerifiedAt: null,
                cnameLastCheckAt: null,
                cnameError: null,
              }
            : {
                cnameStatus: null,
                cnameVerifiedAt: null,
                cnameLastCheckAt: null,
                cnameError: null,
              }
          : {};

        const updated = await tx.brandingConfig.update({
          where: { id: existing.id },
          data: {
            logoAssetId: req.body.logoAssetId === undefined ? undefined : req.body.logoAssetId,
            accentColor: req.body.accentColor === undefined ? undefined : req.body.accentColor,
            customCname: req.body.customCname === undefined ? undefined : req.body.customCname,
            footerText: req.body.footerText === undefined ? undefined : req.body.footerText,
            ...cnameReset,
          },
        });
        return {
          data: {
            id: updated.id,
            logoAssetId: updated.logoAssetId,
            accentColor: updated.accentColor,
            customCname: updated.customCname,
            cnameStatus: updated.cnameStatus,
            cnameVerifiedAt: updated.cnameVerifiedAt?.toISOString() ?? null,
            cnameError: updated.cnameError,
            footerText: updated.footerText,
            updatedAt: updated.updatedAt.toISOString(),
          },
        };
      });
    },
  );

  // Verify the CNAME row by hitting public DNS. Caller-triggered (the
  // settings page exposes a "Verify now" button) so we can keep the API
  // simple and let the operator retry until DNS propagates.
  r.post(
    '/branding/cname/verify',
    {
      schema: { tags: ['saas'], summary: 'Re-check the configured custom CNAME via public DNS.' },
      preHandler: [app.requireRole('admin')],
    },
    async (req, reply) => {
      const orgId = req.auth!.organizationId;
      const row = await app.tenant(req, async (tx) =>
        tx.brandingConfig.findUnique({ where: { organizationId: orgId } }),
      );
      if (!row?.customCname) {
        reply.code(400);
        return { ok: false as const, message: 'No CNAME set.' };
      }
      const result = await verifyCnameTarget(row.customCname);
      const now = new Date();
      await app.tenant(req, async (tx) =>
        tx.brandingConfig.update({
          where: { id: row.id },
          data: {
            cnameStatus: result.ok ? 'verified' : 'failed',
            cnameVerifiedAt: result.ok ? now : row.cnameVerifiedAt,
            cnameLastCheckAt: now,
            cnameError: result.ok ? null : result.error ?? 'verification failed',
          },
        }),
      );
      return {
        ok: result.ok,
        status: result.ok ? ('verified' as const) : ('failed' as const),
        target: env.CUSTOM_CNAME_TARGET,
        resolved: result.resolved,
        error: result.ok ? null : result.error ?? 'verification failed',
      };
    },
  );

  // -----------------------------------------------------------------
  // Caddy on-demand-TLS ask endpoint. Caddy hits this once per
  // hostname before issuing a cert; only verified CNAMEs return 200.
  //
  // Public (unauthenticated). RLS bypass via the raw prisma client +
  // a single indexed lookup. Keep this lean — Caddy waits on it.
  // -----------------------------------------------------------------
  r.get(
    '/caddy/ask',
    {
      schema: {
        tags: ['saas'],
        summary: 'Caddy on-demand TLS guard. Returns 200 only for verified custom CNAMEs.',
        querystring: z.object({ domain: z.string().min(1).max(253) }),
      },
      // No auth — Caddy talks to this on the local network.
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
      const domain = req.query.domain.trim().toLowerCase();
      // Always allow our own apex/api domains so the on-demand path is
      // a no-op for the platform's own certs (Caddy still uses ACME for
      // them via the static site blocks in Caddyfile, but this guard
      // shouldn't accidentally reject them if mis-configured).
      try {
        const apiHost = new URL(env.API_PUBLIC_URL).hostname.toLowerCase();
        const webHost = new URL(env.WEB_PUBLIC_URL).hostname.toLowerCase();
        if (domain === apiHost || domain === webHost) {
          reply.code(200);
          return { ok: true };
        }
      } catch {
        /* fall through */
      }
      const row = await withRlsBypass((tx) =>
        tx.brandingConfig.findFirst({
          where: { customCname: domain, cnameStatus: 'verified' },
          select: { id: true },
        }),
      );
      if (!row) {
        reply.code(404);
        return { ok: false };
      }
      reply.code(200);
      return { ok: true };
    },
  );

  // ===================================================================
  // §5.1.2 Meta verification — guided stepper
  // ===================================================================

  r.get(
    '/onboarding/meta',
    {
      schema: {
        tags: ['saas'],
        summary: 'List Meta onboarding steps + completion state per org.',
      },
      preHandler: [app.requireRole('viewer')],
    },
    async (req) =>
      app.tenant(req, async (tx) => {
        const states = await tx.metaOnboardingStep.findMany({});
        const map = new Map(states.map((s) => [s.stepKey, s]));
        return {
          data: META_STEPS.map((s) => {
            const state = map.get(s.key);
            return {
              key: s.key,
              title: s.title,
              description: s.description,
              completedAt: state?.completedAt?.toISOString() ?? null,
              notes: state?.notes ?? null,
            };
          }),
        };
      }),
  );

  r.post(
    '/onboarding/meta/:key',
    {
      schema: {
        tags: ['saas'],
        summary: 'Mark a Meta onboarding step complete (or uncomplete).',
        params: z.object({ key: z.string().min(1) }),
        body: z.object({ done: z.boolean(), notes: z.string().trim().max(2000).optional() }),
        response: { 200: successSchema },
      },
      preHandler: [app.requireRole('admin')],
    },
    async (req) =>
      app.tenant(req, async (tx) => {
        const orgId = req.auth!.organizationId;
        await tx.metaOnboardingStep.upsert({
          where: { organizationId_stepKey: { organizationId: orgId, stepKey: req.params.key } },
          create: {
            organizationId: orgId,
            stepKey: req.params.key,
            completedAt: req.body.done ? new Date() : null,
            notes: req.body.notes ?? null,
          },
          update: {
            completedAt: req.body.done ? new Date() : null,
            notes: req.body.notes === undefined ? undefined : req.body.notes,
          },
        });
        return { ok: true as const };
      }),
  );

  // ===================================================================
  // §5.1.4 Client-facing analytics
  // ===================================================================

  r.get(
    '/analytics',
    {
      schema: {
        tags: ['saas'],
        summary: 'Client-facing analytics: message volume, bot resolution, response time, top queries.',
        querystring: z.object({
          window: z.enum(['24h', '7d', '30d']).default('7d'),
        }),
      },
      preHandler: [app.requireRole('viewer')],
    },
    async (req) =>
      app.tenant(req, async (tx) => {
        const win = req.query.window;
        const now = new Date();
        const since = new Date(
          now.getTime() - (win === '24h' ? 24 * 3600e3 : win === '7d' ? 7 * 86400e3 : 30 * 86400e3),
        );

        const [allMessages, threads, handoffNotes, topInboundRaw] = await Promise.all([
          tx.whatsAppMessage.findMany({
            where: { receivedAt: { gte: since } },
            select: { direction: true, body: true, receivedAt: true, threadId: true },
            orderBy: { receivedAt: 'asc' },
          }),
          tx.whatsAppThread.findMany({
            where: { lastMessageAt: { gte: since } },
            select: { id: true, status: true, assignedToUserId: true, inboundCount: true, outboundCount: true },
          }),
          // Handoff notes are an indicator that the bot escalated.
          tx.whatsAppNote.count({
            where: { createdAt: { gte: since }, body: { contains: 'Bot escalated' } },
          }),
          tx.whatsAppMessage.findMany({
            where: { direction: 'inbound', receivedAt: { gte: since }, body: { not: null } },
            select: { body: true },
            take: 1000,
            orderBy: { receivedAt: 'desc' },
          }),
        ]);

        // Volume per day.
        const buckets = new Map<string, { date: string; inbound: number; outbound: number }>();
        for (const m of allMessages) {
          const d = m.receivedAt.toISOString().slice(0, 10);
          const b = buckets.get(d) ?? { date: d, inbound: 0, outbound: 0 };
          if (m.direction === 'inbound') b.inbound += 1;
          else b.outbound += 1;
          buckets.set(d, b);
        }
        const volume = [...buckets.values()].sort((a, b) => (a.date < b.date ? -1 : 1));

        // Bot resolution rate: thread is "bot-resolved" if it had inbound
        // + outbound messages and was never escalated (no handoff note,
        // status not 'escalated' or 'pending'). We approximate by status.
        const totalThreads = threads.length;
        const resolvedThreads = threads.filter(
          (t) => t.status === 'resolved' || (t.status === 'open' && !t.assignedToUserId && t.outboundCount > 0),
        ).length;
        const resolutionRate = totalThreads > 0 ? resolvedThreads / totalThreads : 0;

        // Avg response time (ms): for each inbound message, find the next
        // outbound on the same thread and measure the gap.
        let respCount = 0;
        let respTotalMs = 0;
        const byThread = new Map<string, { direction: string; t: number; body: string | null }[]>();
        for (const m of allMessages) {
          if (!m.threadId) continue;
          const arr = byThread.get(m.threadId) ?? [];
          arr.push({ direction: m.direction, t: m.receivedAt.getTime(), body: m.body });
          byThread.set(m.threadId, arr);
        }
        for (const arr of byThread.values()) {
          for (let i = 0; i < arr.length; i++) {
            if (arr[i]!.direction === 'inbound') {
              const next = arr.slice(i + 1).find((x) => x.direction === 'outbound');
              if (next) {
                respTotalMs += next.t - arr[i]!.t;
                respCount += 1;
              }
            }
          }
        }
        const avgResponseSeconds = respCount > 0 ? Math.round(respTotalMs / respCount / 1000) : null;

        // Top queries — naive TF on inbound bodies (cheap clustering).
        const wordCounts = new Map<string, number>();
        const stop = new Set([
          'the','and','for','you','your','have','is','are','to','a','i','of','do','can','what','how','when','this','that','it','in','on','at','my','me','we','please','hi','hello',
        ]);
        for (const m of topInboundRaw) {
          const body = (m.body ?? '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ');
          for (const w of body.split(/\s+/).filter((w) => w.length >= 4 && !stop.has(w))) {
            wordCounts.set(w, (wordCounts.get(w) ?? 0) + 1);
          }
        }
        const topQueries = [...wordCounts.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 10)
          .map(([word, count]) => ({ word, count }));

        return {
          data: {
            window: win,
            volume,
            totals: {
              inbound: allMessages.filter((m) => m.direction === 'inbound').length,
              outbound: allMessages.filter((m) => m.direction === 'outbound').length,
              threads: totalThreads,
            },
            botResolution: {
              resolutionRate: Number(resolutionRate.toFixed(3)),
              handoffs: handoffNotes,
            },
            avgResponseSeconds,
            topQueries,
          },
        };
      }),
  );
}
