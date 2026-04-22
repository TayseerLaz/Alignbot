// Inbound webhook receiver: POST /api/v1/webhooks/inbound/:connectorId
//
// Public (no portal auth). Verifies HMAC-SHA256 over the raw body using the
// connector's webhookSecret. On success, creates a SyncRun and enqueues a sync
// job that fetches the connector's endpointUrl OR processes the inline body.
//
// Header: X-Aligned-Signature: sha256=<hex(hmac(secret, timestamp + "." + body))>
//         X-Aligned-Timestamp: <unix-seconds>
import { ApiErrorCode } from '@aligned/shared';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { withRlsBypass } from '../../lib/db.js';
import { badRequest, notFound, unauthorized } from '../../lib/errors.js';
import { getSyncQueue } from '../../lib/queues.js';

const MAX_TIMESTAMP_SKEW_SECONDS = 5 * 60;

function verifySignature(secret: string, body: string, timestamp: string, signature: string): boolean {
  if (!signature.startsWith('sha256=')) return false;
  const expected = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest();
  let received: Buffer;
  try {
    received = Buffer.from(signature.slice('sha256='.length), 'hex');
  } catch {
    return false;
  }
  if (received.length !== expected.length) return false;
  return timingSafeEqual(expected, received);
}

export default async function inboundWebhookRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.post(
    '/webhooks/inbound/:connectorId',
    {
      schema: {
        tags: ['connectors'],
        summary: 'Inbound webhook from a connected external system. HMAC required.',
        params: z.object({ connectorId: z.string().uuid() }),
      },
      // No preHandler — this is public (HMAC-verified).
      // No auth, no tenant context — we look the connector up directly.
    },
    async (req, reply) => {
      const sigHeader = req.headers['x-aligned-signature'];
      const tsHeader = req.headers['x-aligned-timestamp'];
      const signature = Array.isArray(sigHeader) ? sigHeader[0] : sigHeader;
      const timestamp = Array.isArray(tsHeader) ? tsHeader[0] : tsHeader;
      if (!signature || !timestamp) {
        throw unauthorized(ApiErrorCode.AUTH_REQUIRED, 'Missing X-Aligned-Signature or X-Aligned-Timestamp.');
      }

      const tsNum = Number(timestamp);
      if (!Number.isFinite(tsNum) || Math.abs(Date.now() / 1000 - tsNum) > MAX_TIMESTAMP_SKEW_SECONDS) {
        throw badRequest(ApiErrorCode.VALIDATION_ERROR, 'Timestamp out of acceptable window.');
      }

      const connector = await withRlsBypass((tx) =>
        tx.apiConnector.findUnique({ where: { id: req.params.connectorId } }),
      );
      if (!connector || !connector.webhookSecret) throw notFound('Connector not found or webhook disabled.');

      const rawBody = JSON.stringify(req.body ?? {});
      if (!verifySignature(connector.webhookSecret, rawBody, timestamp, signature)) {
        throw unauthorized(ApiErrorCode.AUTH_TOKEN_INVALID, 'Invalid signature.');
      }

      const run = await withRlsBypass((tx) =>
        tx.syncRun.create({
          data: {
            organizationId: connector.organizationId,
            connectorId: connector.id,
            trigger: 'webhook',
            status: 'pending',
            metadata: { inboundPayloadHash: createHmac('sha256', 'aligned').update(rawBody).digest('hex').slice(0, 16) } as never,
          },
        }),
      );

      await getSyncQueue().add(
        'sync',
        {
          organizationId: connector.organizationId,
          connectorId: connector.id,
          syncRunId: run.id,
          trigger: 'webhook',
        },
        { jobId: run.id, attempts: 1 },
      );

      reply.code(202).send({ accepted: true, syncRunId: run.id });
    },
  );
}
