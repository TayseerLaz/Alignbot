// Phase 4 — Broadcast send worker.
//
// One job per BroadcastRecipient. Calls Meta /messages with a template payload
// (resolved variables become `body` component parameters), updates the recipient
// row, and increments campaign counters. Honors a per-org Redis token bucket so
// the global send rate stays under Meta's tier limit.
//
// Auto-pause: after RECIPIENT_FAIL_BURST consecutive recipient failures inside
// a short window, the broadcast is paused and a `recipient_failed_burst` event
// is emitted.
import { Worker } from 'bullmq';

import { getConnection } from '../lib/redis.js';

import { prisma } from './db.js';

const QUEUE_SEND = 'broadcast-send';
const SEND_CONCURRENCY = Number(process.env.BROADCAST_SEND_CONCURRENCY ?? 10);
const TOKEN_LIMIT = Number(process.env.WHATSAPP_SEND_TOKENS_PER_SECOND ?? 80);
const RECIPIENT_FAIL_BURST = 25;

interface SendJobData {
  organizationId: string;
  broadcastId: string;
  recipientId: string;
}

// Permanent Meta error codes — don't retry these. See Meta's WhatsApp errors:
// https://developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes
const PERMANENT_META_CODES = new Set([
  '131005', // re-engagement-message
  '131008', // required parameter missing
  '131009', // parameter value invalid
  '131021', // recipient cannot receive (e.g. blocked)
  '131026', // unable to deliver — maybe not WA user
  '131047', // re-engagement-message
  '131048', // spam rate limit
  '132000', // template name not found
  '132001', // template translation not found
  '132005', // template hydrated text exceeds limit
  '132007', // template format character policy violated
  '132012', // template parameter format mismatch
  '132015', // template paused
  '132016', // template disabled
  '132068', // flow blocked
]);

async function consumeSendToken(orgId: string): Promise<{ ok: boolean; retryAfterMs: number }> {
  const redis = getConnection();
  const key = `wasend:${orgId}:${Math.floor(Date.now() / 1000)}`;
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, 2);
  if (count > TOKEN_LIMIT) return { ok: false, retryAfterMs: 1000 };
  return { ok: true, retryAfterMs: 0 };
}

async function bumpFailureBurst(orgId: string, broadcastId: string): Promise<number> {
  const redis = getConnection();
  const key = `bcburst:${broadcastId}`;
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, 60);
  return count;
}

async function clearFailureBurst(broadcastId: string): Promise<void> {
  await getConnection().del(`bcburst:${broadcastId}`);
}

interface MetaResponse {
  messages?: { id?: string }[];
  error?: { code?: number | string; message?: string };
}

async function callMeta(args: {
  token: string;
  phoneNumberId: string;
  to: string;
  templateName: string;
  language: string;
  variables: Record<string, string>;
}): Promise<{
  ok: boolean;
  metaMessageId: string | null;
  metaErrorCode: string | null;
  metaErrorMessage: string | null;
  status: number;
  permanent: boolean;
}> {
  // Meta expects `components: [{ type: "body", parameters: [{ type: "text", text }, ...] }]`
  // with parameters in the order matching {{1}}, {{2}}, ... in the template body.
  const indices = Object.keys(args.variables)
    .filter((k) => /^\d+$/.test(k))
    .map((k) => Number(k))
    .sort((a, b) => a - b);
  const parameters = indices.map((idx) => ({
    type: 'text' as const,
    text: args.variables[String(idx)] ?? '',
  }));

  const components = parameters.length > 0 ? [{ type: 'body', parameters }] : [];

  const payload = {
    messaging_product: 'whatsapp',
    to: args.to.replace(/^\+/, ''),
    type: 'template',
    template: {
      name: args.templateName,
      language: { code: args.language },
      ...(components.length > 0 ? { components } : {}),
    },
  };

  let res: Response;
  try {
    res = await fetch(
      `https://graph.facebook.com/v20.0/${encodeURIComponent(args.phoneNumberId)}/messages`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${args.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(15_000),
      },
    );
  } catch (err) {
    return {
      ok: false,
      metaMessageId: null,
      metaErrorCode: null,
      metaErrorMessage: err instanceof Error ? err.message : 'fetch failed',
      status: 0,
      permanent: false,
    };
  }

  const text = await res.text();
  let parsed: MetaResponse | null = null;
  try {
    parsed = JSON.parse(text) as MetaResponse;
  } catch {
    parsed = null;
  }

  if (res.status >= 200 && res.status < 300 && parsed?.messages?.[0]?.id) {
    return {
      ok: true,
      metaMessageId: parsed.messages[0].id ?? null,
      metaErrorCode: null,
      metaErrorMessage: null,
      status: res.status,
      permanent: false,
    };
  }

  const code = parsed?.error?.code != null ? String(parsed.error.code) : null;
  const message = parsed?.error?.message ?? text.slice(0, 500);
  const permanent =
    (code != null && PERMANENT_META_CODES.has(code)) ||
    (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429);
  return {
    ok: false,
    metaMessageId: null,
    metaErrorCode: code,
    metaErrorMessage: message,
    status: res.status,
    permanent,
  };
}

export function startBroadcastSendWorker() {
  const worker = new Worker<SendJobData>(
    QUEUE_SEND,
    async (job) => {
      const { organizationId, broadcastId, recipientId } = job.data;

      // Re-check broadcast status. If paused/cancelled, mark recipient skipped.
      const broadcast = await prisma.broadcast.findUnique({ where: { id: broadcastId } });
      if (!broadcast) return;
      if (broadcast.status === 'paused' || broadcast.status === 'cancelled') {
        await prisma.broadcastRecipient.updateMany({
          where: { id: recipientId, status: { in: ['queued', 'pending'] } },
          data: { status: 'skipped' },
        });
        return;
      }

      // Token bucket — if exhausted, throw to let BullMQ retry with backoff.
      const tok = await consumeSendToken(organizationId);
      if (!tok.ok) {
        throw new Error(`token-bucket: retry in ${tok.retryAfterMs}ms`);
      }

      const recipient = await prisma.broadcastRecipient.findUnique({
        where: { id: recipientId },
      });
      if (!recipient) return;
      if (recipient.status === 'sent' || recipient.status === 'delivered' || recipient.status === 'read') {
        return; // Already handled.
      }

      const channel = await prisma.whatsAppChannel.findUnique({
        where: { id: broadcast.channelId },
      });
      if (!channel || !channel.accessToken || !channel.phoneNumberId) {
        await prisma.broadcastRecipient.update({
          where: { id: recipientId },
          data: {
            status: 'failed',
            failedAt: new Date(),
            metaErrorCode: 'channel_unconfigured',
            metaErrorMessage: 'WhatsApp channel missing access token or phone number ID.',
          },
        });
        await prisma.broadcast.update({
          where: { id: broadcastId },
          data: { failedCount: { increment: 1 } },
        });
        return;
      }

      const templateId = recipient.variant === 'B' && broadcast.variantBTemplateId
        ? broadcast.variantBTemplateId
        : broadcast.variantATemplateId;
      const template = await prisma.whatsAppTemplate.findUnique({ where: { id: templateId } });
      if (!template) {
        await prisma.broadcastRecipient.update({
          where: { id: recipientId },
          data: {
            status: 'failed',
            failedAt: new Date(),
            metaErrorCode: 'template_missing',
            metaErrorMessage: 'Template no longer exists.',
          },
        });
        await prisma.broadcast.update({
          where: { id: broadcastId },
          data: { failedCount: { increment: 1 } },
        });
        return;
      }

      await prisma.broadcastRecipient.update({
        where: { id: recipientId },
        data: { attemptCount: { increment: 1 } },
      });

      const variables =
        (recipient.variables as Record<string, string> | null) ?? {};
      const out = await callMeta({
        token: channel.accessToken,
        phoneNumberId: channel.phoneNumberId,
        to: recipient.phoneE164,
        templateName: template.name,
        language: template.language,
        variables,
      });

      if (out.ok) {
        await prisma.broadcastRecipient.update({
          where: { id: recipientId },
          data: {
            status: 'sent',
            sentAt: new Date(),
            metaMessageId: out.metaMessageId,
            metaErrorCode: null,
            metaErrorMessage: null,
          },
        });
        await prisma.broadcast.update({
          where: { id: broadcastId },
          data: { sentCount: { increment: 1 } },
        });
        // Record an outbound WhatsAppMessage row so the inbox sees it.
        await prisma.whatsAppMessage.create({
          data: {
            organizationId,
            direction: 'outbound',
            metaMessageId: out.metaMessageId,
            toNumber: recipient.phoneE164.replace(/^\+/, ''),
            messageType: 'template',
            body: template.name,
            metaStatus: 'sent',
            metaStatusAt: new Date(),
          },
        }).catch(() => undefined);
        await clearFailureBurst(broadcastId);
        return;
      }

      // Permanent failure — don't retry.
      if (out.permanent) {
        await prisma.broadcastRecipient.update({
          where: { id: recipientId },
          data: {
            status: 'failed',
            failedAt: new Date(),
            metaErrorCode: out.metaErrorCode,
            metaErrorMessage: out.metaErrorMessage,
          },
        });
        await prisma.broadcast.update({
          where: { id: broadcastId },
          data: { failedCount: { increment: 1 } },
        });
        const burst = await bumpFailureBurst(organizationId, broadcastId);
        if (burst >= RECIPIENT_FAIL_BURST) {
          await prisma.broadcast.update({
            where: { id: broadcastId },
            data: { status: 'paused' },
          });
          await prisma.broadcastEvent.create({
            data: {
              organizationId,
              broadcastId,
              kind: 'recipient_failed_burst',
              detail: { count: burst },
            },
          });
          await clearFailureBurst(broadcastId);
        }
        return;
      }

      // Transient — let BullMQ retry. We bumped attemptCount above; if attempts
      // are exhausted the queue will surface it as a 'failed' job and the
      // recipient is left in `queued` (operator can manual-retry).
      throw new Error(
        `meta send failed (status=${out.status}, code=${out.metaErrorCode}): ${out.metaErrorMessage}`,
      );
    },
    {
      connection: getConnection(),
      concurrency: SEND_CONCURRENCY,
    },
  );

  worker.on('failed', async (job, err) => {
    if (!job) return;
    // After max attempts BullMQ marks the job failed; capture that as a
    // permanent recipient failure so the campaign-level state is consistent.
    if (job.attemptsMade >= (job.opts.attempts ?? 1)) {
      const data = job.data;
      await prisma.broadcastRecipient
        .update({
          where: { id: data.recipientId },
          data: {
            status: 'failed',
            failedAt: new Date(),
            metaErrorMessage: err.message?.slice(0, 500) ?? 'send failed after retries',
          },
        })
        .catch(() => undefined);
      await prisma.broadcast
        .update({
          where: { id: data.broadcastId },
          data: { failedCount: { increment: 1 } },
        })
        .catch(() => undefined);
    }
  });

  // After every send, if all recipients are terminal, mark the broadcast
  // completed. Done lazily after a short debounce.
  worker.on('completed', async (job) => {
    const data = job.data;
    const remaining = await prisma.broadcastRecipient.count({
      where: { broadcastId: data.broadcastId, status: { in: ['pending', 'queued'] } },
    });
    if (remaining > 0) return;
    const b = await prisma.broadcast.findUnique({ where: { id: data.broadcastId } });
    if (!b) return;
    if (b.status === 'sending') {
      await prisma.broadcast.update({
        where: { id: b.id },
        data: { status: 'completed', completedAt: new Date() },
      });
      await prisma.broadcastEvent.create({
        data: {
          organizationId: data.organizationId,
          broadcastId: b.id,
          kind: 'completed',
        },
      });
    }
  });

  return worker;
}
