// Public Shopify webhook receiver (no portal auth). Shopify signs every webhook
// with the app's API secret key (the `shpss_…` we collect on connect):
//   X-Shopify-Hmac-Sha256: base64( HMAC-SHA256(rawBody, apiSecret) )
// On a verified product/customer change we enqueue a re-scrape so already-
// imported items auto-update and brand-new items land in the review queue.
import { createHmac, timingSafeEqual } from 'node:crypto';

import { decryptJsonSecret } from '@aligned/db';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { withRlsBypass } from '../../lib/db.js';
import { getShopifyQueue } from '../../lib/queues.js';

function rawBodyOf(req: FastifyRequest): string {
  return (req as unknown as { rawBody?: string }).rawBody ?? JSON.stringify(req.body ?? {});
}

function verify(apiSecret: string, rawBody: string, header: string): boolean {
  const expected = createHmac('sha256', apiSecret).update(rawBody, 'utf8').digest();
  let received: Buffer;
  try {
    received = Buffer.from(header, 'base64');
  } catch {
    return false;
  }
  if (received.length !== expected.length) return false;
  return timingSafeEqual(expected, received);
}

export default async function shopifyWebhookRoutes(app: FastifyInstance) {
  app.post(
    '/webhooks/shopify/:connectionId',
    {
      schema: {
        tags: ['shopify'],
        summary: 'Shopify webhook (HMAC-verified with the connection API secret).',
        params: z.object({ connectionId: z.string().uuid() }),
      },
      // Public — HMAC-verified, no JWT. Light rate-limit to blunt forged floods.
      config: { rateLimit: { max: 60, timeWindow: '1 second' } },
    },
    async (req, reply) => {
      const { connectionId } = req.params as { connectionId: string };
      const sigHeader = (req.headers['x-shopify-hmac-sha256'] as string | undefined) ?? '';
      const topic = (req.headers['x-shopify-topic'] as string | undefined) ?? 'unknown';
      if (!sigHeader) return reply.code(401).send({ ok: false });

      // Look up the connection across tenants (public route → bypass RLS).
      const conn = await withRlsBypass((tx) =>
        tx.shopifyConnection.findUnique({
          where: { id: connectionId },
          select: { id: true, organizationId: true, credentials: true },
        }),
      );
      if (!conn) return reply.code(404).send({ ok: false });

      const creds = decryptJsonSecret<{ apiSecret?: string }>(conn.credentials) ?? {};
      if (!creds.apiSecret || !verify(creds.apiSecret, rawBodyOf(req), sigHeader)) {
        return reply.code(401).send({ ok: false });
      }

      // Respect the per-tenant feature toggle — silently 200 if disabled so
      // Shopify doesn't keep retrying.
      const org = await withRlsBypass((tx) =>
        tx.organization.findUnique({
          where: { id: conn.organizationId },
          select: { disabledFeatures: true },
        }),
      );
      if (org?.disabledFeatures?.includes('shopify')) return reply.code(200).send({ ok: true });

      // Enqueue a re-scrape (debounced by a stable jobId per connection so a
      // burst of webhooks collapses into one run). Already-imported items
      // auto-update on commit; new ones land as pending for review.
      const run = await withRlsBypass((tx) =>
        tx.shopifyScrapeRun.create({
          data: {
            organizationId: conn.organizationId,
            connectionId: conn.id,
            phase: 'scrape',
            trigger: 'webhook',
            status: 'pending',
          },
          select: { id: true },
        }),
      );
      await getShopifyQueue().add(
        'scrape',
        {
          organizationId: conn.organizationId,
          connectionId: conn.id,
          scrapeRunId: run.id,
          phase: 'scrape',
          trigger: 'webhook',
        },
        {
          // Collapse bursts: one queued scrape per connection at a time.
          jobId: `shopify-webhook-${conn.id}`,
          attempts: 1,
          removeOnComplete: { count: 100 },
          removeOnFail: { count: 100 },
        },
      );
      req.log.info({ connectionId, topic }, '[shopify] webhook accepted → scrape enqueued');
      return reply.code(200).send({ ok: true });
    },
  );
}
