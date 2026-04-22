// Outbound webhook delivery worker.
//
// For each WebhookDelivery row, POST the payload to the endpoint URL with:
//   X-Aligned-Event:    <eventKind>
//   X-Aligned-Delivery: <deliveryId>
//   X-Aligned-Timestamp: <unix-seconds>
//   X-Aligned-Signature: sha256=<hex(hmac(secret, timestamp + "." + body))>
//
// Considered delivered on 2xx. 4xx (except 408/429) are NOT retried — the caller
// is unlikely to start accepting; 5xx and network errors are retried with the
// queue's exponential backoff. After WEBHOOK_MAX_ATTEMPTS we mark `giving_up`
// and disable the endpoint after a configurable threshold of consecutive failures.
import { createHmac } from 'node:crypto';

import { Worker } from 'bullmq';
import { request as undiciRequest } from 'undici';

import { env } from '../lib/env.js';
import { getConnection } from '../lib/redis.js';

import { prisma } from './db.js';

const FAIL_THRESHOLD_TO_DISABLE = 25;
const PERMANENT_FAIL_STATUSES = new Set([400, 401, 403, 404, 410, 422]);

interface DeliveryJobData {
  organizationId: string;
  deliveryId: string;
}

function sign(secret: string, body: string, timestamp: number): string {
  const data = `${timestamp}.${body}`;
  const sig = createHmac('sha256', secret).update(data).digest('hex');
  return `sha256=${sig}`;
}

export function startWebhookDeliveryWorker() {
  const worker = new Worker<DeliveryJobData>(
    'webhook-delivery',
    async (job) => {
      const delivery = await prisma.webhookDelivery.findUnique({
        where: { id: job.data.deliveryId },
        include: { endpoint: true },
      });
      if (!delivery) return; // Manually deleted; nothing to do.
      if (delivery.status === 'delivered') return;

      const endpoint = delivery.endpoint;
      if (!endpoint || !endpoint.isActive) {
        await prisma.webhookDelivery.update({
          where: { id: delivery.id },
          data: { status: 'giving_up', errorMessage: 'Endpoint inactive or removed.' },
        });
        return;
      }

      const body = JSON.stringify({
        id: delivery.id,
        event: delivery.eventKind,
        organizationId: delivery.organizationId,
        createdAt: delivery.createdAt.toISOString(),
        data: delivery.payload,
      });
      const timestamp = Math.floor(Date.now() / 1000);
      const signature = sign(endpoint.signingSecret, body, timestamp);

      await prisma.webhookDelivery.update({
        where: { id: delivery.id },
        data: { status: 'in_flight', attempts: delivery.attempts + 1, attemptedAt: new Date() },
      });

      let responseStatus: number | null = null;
      let responseBody = '';
      let errorMessage: string | null = null;
      let delivered = false;
      let permanentlyFailed = false;

      try {
        const res = await undiciRequest(endpoint.url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'user-agent': 'Aligned-Webhooks/1.0',
            'x-aligned-event': delivery.eventKind,
            'x-aligned-delivery': delivery.id,
            'x-aligned-timestamp': String(timestamp),
            'x-aligned-signature': signature,
          },
          body,
          signal: AbortSignal.timeout(env.WEBHOOK_DELIVERY_TIMEOUT_MS),
        });
        responseStatus = res.statusCode;
        responseBody = (await res.body.text()).slice(0, 4000);

        if (responseStatus >= 200 && responseStatus < 300) {
          delivered = true;
        } else if (PERMANENT_FAIL_STATUSES.has(responseStatus)) {
          permanentlyFailed = true;
        }
      } catch (err) {
        errorMessage = err instanceof Error ? err.message : String(err);
      }

      const attempts = delivery.attempts + 1;
      const exhausted = attempts >= env.WEBHOOK_MAX_ATTEMPTS;

      if (delivered) {
        await prisma.$transaction([
          prisma.webhookDelivery.update({
            where: { id: delivery.id },
            data: {
              status: 'delivered',
              responseStatus,
              responseBody,
              deliveredAt: new Date(),
              errorMessage: null,
            },
          }),
          prisma.webhookEndpoint.update({
            where: { id: endpoint.id },
            data: { consecutiveFailures: 0, lastDeliveryAt: new Date() },
          }),
        ]);
        return;
      }

      if (permanentlyFailed) {
        await prisma.webhookDelivery.update({
          where: { id: delivery.id },
          data: { status: 'giving_up', responseStatus, responseBody, errorMessage },
        });
        await bumpFailureCount(endpoint.id);
        return;
      }

      if (exhausted) {
        await prisma.webhookDelivery.update({
          where: { id: delivery.id },
          data: { status: 'giving_up', responseStatus, responseBody, errorMessage },
        });
        await bumpFailureCount(endpoint.id);
        return;
      }

      // Stay pending and let BullMQ retry.
      await prisma.webhookDelivery.update({
        where: { id: delivery.id },
        data: { status: 'pending', responseStatus, responseBody, errorMessage },
      });
      throw new Error(errorMessage ?? `HTTP ${responseStatus} from webhook target`);
    },
    {
      connection: getConnection(),
      concurrency: env.WEBHOOK_CONCURRENCY,
    },
  );

  return worker;
}

async function bumpFailureCount(endpointId: string) {
  const ep = await prisma.webhookEndpoint.update({
    where: { id: endpointId },
    data: { consecutiveFailures: { increment: 1 }, lastDeliveryAt: new Date() },
  });
  if (ep.consecutiveFailures >= FAIL_THRESHOLD_TO_DISABLE && ep.isActive) {
    await prisma.webhookEndpoint.update({
      where: { id: endpointId },
      data: { isActive: false },
    });
  }
}
