// Phase 3 §5.1.4 — branding (white-label), Meta onboarding stepper,
// client-facing analytics. Bundled in one module because the surface is
// small per feature and they're all tenant-authed and read/write the
// same models the existing routes already touch.
import { listEnvelopeSchema, itemEnvelopeSchema, successSchema, uuidSchema } from '@aligned/shared';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

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
        const updated = await tx.brandingConfig.update({
          where: { id: existing.id },
          data: {
            logoAssetId: req.body.logoAssetId === undefined ? undefined : req.body.logoAssetId,
            accentColor: req.body.accentColor === undefined ? undefined : req.body.accentColor,
            customCname: req.body.customCname === undefined ? undefined : req.body.customCname,
            footerText: req.body.footerText === undefined ? undefined : req.body.footerText,
          },
        });
        return {
          data: {
            id: updated.id,
            logoAssetId: updated.logoAssetId,
            accentColor: updated.accentColor,
            customCname: updated.customCname,
            footerText: updated.footerText,
            updatedAt: updated.updatedAt.toISOString(),
          },
        };
      });
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
