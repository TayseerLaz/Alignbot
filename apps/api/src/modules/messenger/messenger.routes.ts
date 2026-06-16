// Facebook Messenger channel — config + inbound webhook + AI reply.
//
// Reuses the channel-agnostic bot engine (gatherBotData + buildBotResponse);
// only the transport (Meta Send API) and identity (PSID) are Messenger-
// specific. WhatsApp is untouched. Inert until a tenant configures a Page +
// token, so deploying this is zero-risk. Instagram DMs (Phase C) ride the same
// Send API and slot in here later.
//
// v1 scope: text replies (markers stripped). Product images, cart/booking
// markers, and the per-PSID blocked-contact gate are follow-ups.
import crypto from 'node:crypto';

import { decryptSecret, encryptSecret } from '@aligned/db';
import {
  ApiErrorCode,
  itemEnvelopeSchema,
  messengerChannelSchema,
  uuidSchema,
  upsertMessengerChannelBodySchema,
} from '@aligned/shared';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { recordAudit } from '../../lib/audit.js';
import { withRlsBypass } from '../../lib/db.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { env } from '../../lib/env.js';
import { generateOpaqueToken } from '../../lib/crypto.js';

function webhookCallbackUrl(orgId: string): string {
  return `${env.API_PUBLIC_URL.replace(/\/$/, '')}/api/v1/messenger/webhook/${orgId}`;
}

// Strip the bot engine's internal markers from a reply before sending — the
// Messenger transport doesn't (yet) act on them; the customer must never see
// the literal tokens.
function stripMarkers(text: string): string {
  return text
    .replace(/\[IMAGE:[^\]]*\]/gi, '')
    .replace(/\[CART:[\s\S]*?\]/gi, '')
    .replace(/\[BOOKING:[\s\S]*?\]/gi, '')
    .replace(/\[(HANDOFF|PAYMENT_LINK|CLEAR_CART)\]/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function serialize(row: {
  pageId: string | null;
  pageName: string | null;
  igAccountId: string | null;
  pageAccessToken: string | null;
  appSecret: string | null;
  isActive: boolean;
  webhookVerifyToken: string;
  lastVerifyStatus: string | null;
  updatedAt: Date;
  organizationId: string;
}) {
  const hasToken = !!row.pageAccessToken;
  const hasSecret = !!row.appSecret;
  return {
    pageId: row.pageId,
    pageName: row.pageName,
    igAccountId: row.igAccountId,
    hasPageAccessToken: hasToken,
    hasAppSecret: hasSecret,
    isActive: row.isActive,
    webhookVerifyToken: row.webhookVerifyToken,
    webhookCallbackUrl: webhookCallbackUrl(row.organizationId),
    ready: !!(row.pageId && hasToken && hasSecret),
    lastVerifyStatus: row.lastVerifyStatus,
    updatedAt: row.updatedAt ? row.updatedAt.toISOString() : null,
  };
}

export default async function messengerRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  // ---------- GET /messenger ----------------------------------------------
  r.get(
    '/messenger',
    {
      schema: {
        tags: ['messenger'],
        summary: 'Get the org Messenger/Instagram channel config (secrets masked).',
        response: { 200: itemEnvelopeSchema(messengerChannelSchema) },
      },
      preHandler: [app.requireRole('viewer')],
    },
    async (req) => {
      const orgId = req.auth!.organizationId;
      return app.tenant(req, async (tx) => {
        let row = await tx.messengerChannel.findUnique({ where: { organizationId: orgId } });
        if (!row) {
          row = await tx.messengerChannel.create({
            data: { organizationId: orgId, webhookVerifyToken: `vrf_${generateOpaqueToken(20)}` },
          });
        }
        return { data: serialize(row) };
      });
    },
  );

  // ---------- PUT /messenger ----------------------------------------------
  r.put(
    '/messenger',
    {
      schema: {
        tags: ['messenger'],
        summary: 'Upsert the Messenger channel config. Credentials are write-only.',
        body: upsertMessengerChannelBodySchema,
        response: { 200: itemEnvelopeSchema(messengerChannelSchema) },
      },
      preHandler: [app.requireRole('admin')],
    },
    async (req) => {
      const orgId = req.auth!.organizationId;
      const b = req.body;
      return app.tenant(req, async (tx) => {
        const existing = await tx.messengerChannel.findUnique({ where: { organizationId: orgId } });
        // undefined = leave, '' = clear, else encrypt + set.
        const encField = (v: string | undefined, current: string | null | undefined) =>
          v === undefined ? (current ?? null) : v === '' ? null : (encryptSecret(v) ?? null);
        const data = {
          pageId: b.pageId === undefined ? existing?.pageId ?? null : b.pageId || null,
          pageName: b.pageName === undefined ? existing?.pageName ?? null : b.pageName || null,
          igAccountId: b.igAccountId === undefined ? existing?.igAccountId ?? null : b.igAccountId || null,
          pageAccessToken: encField(b.pageAccessToken, existing?.pageAccessToken),
          appSecret: encField(b.appSecret, existing?.appSecret),
          isActive: b.isActive ?? existing?.isActive ?? false,
        };
        const row = await tx.messengerChannel.upsert({
          where: { organizationId: orgId },
          create: { organizationId: orgId, webhookVerifyToken: `vrf_${generateOpaqueToken(20)}`, ...data },
          update: data,
        });
        await recordAudit({
          action: 'business_info_updated',
          organizationId: orgId,
          actorUserId: req.auth!.userId,
          entityType: 'messenger_channel',
          entityId: row.id,
          metadata: { event: 'messenger_channel_updated', isActive: row.isActive },
        });
        return { data: serialize(row) };
      });
    },
  );

  // ---------- POST /messenger/subscribe -----------------------------------
  // One-click connect: validate the Page token, capture the page name, subscribe
  // the Page to this app's `messages` webhook field so Meta delivers DMs here,
  // and activate the channel. Mirrors the WhatsApp subscribe flow.
  r.post(
    '/messenger/subscribe',
    {
      schema: {
        tags: ['messenger'],
        summary: 'Validate + subscribe the Page to the app webhook, then activate.',
        response: { 200: itemEnvelopeSchema(messengerChannelSchema) },
      },
      preHandler: [app.requireRole('admin')],
    },
    async (req) => {
      const orgId = req.auth!.organizationId;
      const channel = await app.tenant(req, (tx) =>
        tx.messengerChannel.findUnique({ where: { organizationId: orgId } }),
      );
      if (!channel) throw notFound('Messenger channel not configured.');
      if (!channel.pageAccessToken) {
        throw badRequest(ApiErrorCode.VALIDATION_ERROR, 'Add the Page access token first.');
      }
      const pageToken = decryptSecret(channel.pageAccessToken) ?? '';
      const GRAPH = 'https://graph.facebook.com/v20.0';

      // 1. Validate token + read the page id/name.
      let pageId = channel.pageId;
      let pageName = channel.pageName;
      let status = 'subscribed';
      try {
        const meRes = await fetch(
          `${GRAPH}/me?fields=id,name&access_token=${encodeURIComponent(pageToken)}`,
          { signal: AbortSignal.timeout(10_000) },
        );
        const me = (await meRes.json()) as { id?: string; name?: string; error?: { message?: string } };
        if (!meRes.ok || !me.id) {
          return {
            data: serialize({ ...channel, lastVerifyStatus: 'token_invalid', isActive: false }),
          };
        }
        pageId = me.id;
        pageName = me.name ?? pageName;

        // 2. Subscribe the Page to the messaging webhook fields.
        const subRes = await fetch(
          `${GRAPH}/${encodeURIComponent(pageId)}/subscribed_apps`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              subscribed_fields: 'messages,messaging_postbacks,message_reads',
              access_token: pageToken,
            }),
            signal: AbortSignal.timeout(10_000),
          },
        );
        const sub = (await subRes.json()) as { success?: boolean; error?: { message?: string } };
        if (!subRes.ok || sub.success !== true) {
          status = 'subscribe_failed';
        }
      } catch (err) {
        req.log.warn({ err }, '[messenger] subscribe failed');
        status = 'network_error';
      }

      const activate = status === 'subscribed' && !!channel.appSecret;
      const row = await app.tenant(req, (tx) =>
        tx.messengerChannel.update({
          where: { id: channel.id },
          data: {
            pageId,
            pageName,
            isActive: activate,
            lastVerifyStatus: status,
            lastVerifiedAt: new Date(),
          },
        }),
      );
      return { data: serialize(row) };
    },
  );

  // ---------- GET /messenger/webhook/:orgId  (Meta verify handshake) ------
  r.get(
    '/messenger/webhook/:orgId',
    { schema: { tags: ['messenger'], params: z.object({ orgId: uuidSchema }) } },
    async (req, reply) => {
      const q = req.query as Record<string, string>;
      const mode = q['hub.mode'];
      const token = q['hub.verify_token'];
      const challenge = q['hub.challenge'];
      const channel = await withRlsBypass((tx) =>
        tx.messengerChannel.findUnique({ where: { organizationId: req.params.orgId } }),
      );
      if (mode === 'subscribe' && channel && token && token === channel.webhookVerifyToken) {
        reply.header('content-type', 'text/plain');
        return challenge ?? '';
      }
      reply.code(403);
      return 'forbidden';
    },
  );

  // ---------- POST /messenger/webhook/:orgId  (inbound) -------------------
  r.post(
    '/messenger/webhook/:orgId',
    { schema: { tags: ['messenger'], params: z.object({ orgId: uuidSchema }) } },
    async (req, reply) => {
      const orgId = req.params.orgId;
      const channel = await withRlsBypass((tx) =>
        tx.messengerChannel.findUnique({ where: { organizationId: orgId } }),
      );
      if (!channel || !channel.appSecret) {
        reply.code(403);
        return 'forbidden';
      }
      // Verify X-Hub-Signature-256 over the raw body with the app secret.
      const appSecret = decryptSecret(channel.appSecret) ?? '';
      const sig = req.headers['x-hub-signature-256'];
      const sigStr = Array.isArray(sig) ? sig[0] : sig;
      const rawBody = (req as unknown as { rawBody?: string }).rawBody ?? JSON.stringify(req.body ?? {});
      const expected = 'sha256=' + crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');
      const ok =
        typeof sigStr === 'string' &&
        sigStr.length === expected.length &&
        crypto.timingSafeEqual(Buffer.from(sigStr), Buffer.from(expected));
      if (!ok) {
        req.log.warn({ orgId }, '[messenger] webhook signature mismatch');
        reply.code(401);
        return 'invalid signature';
      }

      // Always 200 fast; process replies fire-and-forget (Meta retries on non-2xx).
      const body = req.body as {
        object?: string;
        entry?: { messaging?: MessengerEvent[] }[];
      };
      // Instagram + Messenger both arrive here (same Send API); the top-level
      // `object` distinguishes them so threads carry the right channel.
      const channelKind = body.object === 'instagram' ? 'instagram' : 'messenger';
      const events: MessengerEvent[] = (body.entry ?? []).flatMap((e) => e.messaging ?? []);
      void handleMessengerEvents(orgId, channel.id, channelKind, events, req.log).catch((err) =>
        req.log.error({ err }, '[messenger] event handling failed'),
      );
      reply.code(200);
      return 'ok';
    },
  );
}

interface MessengerEvent {
  sender?: { id?: string };
  recipient?: { id?: string };
  message?: { mid?: string; text?: string; is_echo?: boolean };
}

type Logger = { info: (...a: unknown[]) => void; warn: (...a: unknown[]) => void; error: (...a: unknown[]) => void };

async function handleMessengerEvents(
  orgId: string,
  channelId: string,
  channelKind: 'messenger' | 'instagram',
  events: MessengerEvent[],
  log: Logger,
): Promise<void> {
  for (const ev of events) {
    const psid = ev.sender?.id;
    const text = ev.message?.text;
    // Skip echoes (our own outbound) + non-text events.
    if (!psid || ev.message?.is_echo || !text) continue;
    const mid = ev.message?.mid ?? null;

    // Idempotency: skip a mid we already stored (Meta retries).
    if (mid) {
      const dup = await withRlsBypass((tx) =>
        tx.whatsAppMessage.findFirst({
          where: { organizationId: orgId, metaMessageId: mid, direction: 'inbound' },
          select: { id: true },
        }),
      );
      if (dup) continue;
    }

    // Upsert the thread (channel='messenger', keyed by PSID stored in
    // customer_phone — reuses the (org, customer_phone) unique).
    const thread = await withRlsBypass(async (tx) => {
      const existing = await tx.whatsAppThread.findFirst({
        where: { organizationId: orgId, channel: channelKind, channelUserId: psid },
      });
      const preview = text.slice(0, 200);
      if (existing) {
        return tx.whatsAppThread.update({
          where: { id: existing.id },
          data: {
            status: 'open',
            lastMessageAt: new Date(),
            lastMessagePreview: preview,
            inboundCount: { increment: 1 },
            searchText: `${existing.searchText} ${text}`.slice(0, 16000),
          },
        });
      }
      return tx.whatsAppThread.create({
        data: {
          organizationId: orgId,
          channel: channelKind,
          channelUserId: psid,
          customerPhone: psid, // generic id slot for non-WhatsApp channels
          status: 'open',
          lastMessageAt: new Date(),
          lastMessagePreview: preview,
          inboundCount: 1,
          searchText: text,
        },
      });
    });

    await withRlsBypass((tx) =>
      tx.whatsAppMessage.create({
        data: {
          threadId: thread.id,
          organizationId: orgId,
          channel: channelKind,
          direction: 'inbound',
          metaMessageId: mid,
          fromNumber: psid,
          messageType: 'text',
          body: text,
          rawPayload: ev as never,
        },
      }),
    );

    await maybeReplyOnMessenger(orgId, channelId, channelKind, thread.id, psid, text, log);
  }
}

async function maybeReplyOnMessenger(
  orgId: string,
  channelId: string,
  channelKind: 'messenger' | 'instagram',
  threadId: string,
  psid: string,
  userMessage: string,
  log: Logger,
): Promise<void> {
  const { gatherBotData, buildBotResponse } = await import('../../lib/bot-engine.js');

  // Gate: bot must be deployed + the thread not human-owned / escalated.
  const thread = await withRlsBypass((tx) =>
    tx.whatsAppThread.findUnique({
      where: { id: threadId },
      select: { status: true, assignedToUserId: true },
    }),
  );
  if (!thread || thread.assignedToUserId || thread.status === 'escalated') return;

  const channel = await withRlsBypass((tx) =>
    tx.messengerChannel.findUnique({ where: { id: channelId } }),
  );
  if (!channel || !channel.isActive || !channel.pageAccessToken) return;

  // Gather tenant data + run the channel-agnostic engine (org-scoped tx).
  const { withTenant } = await import('../../lib/db.js');
  const data = await withTenant(orgId, (tx) => gatherBotData(tx, orgId));
  const config = (data as { config?: { deployedAt?: Date | null } }).config;
  if (!config?.deployedAt) return; // bot not deployed

  // Last 8 turns for context.
  const history = await withRlsBypass(async (tx) => {
    const rows = await tx.whatsAppMessage.findMany({
      where: { threadId },
      orderBy: { receivedAt: 'desc' },
      take: 9,
      select: { direction: true, body: true },
    });
    return rows
      .reverse()
      .slice(0, -1) // drop the current inbound (it's passed as userMessage)
      .filter((m) => m.body)
      .map((m) => ({
        role: (m.direction === 'inbound' ? 'user' : 'assistant') as 'user' | 'assistant',
        content: (m.body ?? '').slice(0, 400),
      }));
  });

  let rawText: string;
  try {
    const result = await buildBotResponse({
      organizationId: orgId,
      userMessage,
      history,
      data,
      replyMode: 'text',
    });
    rawText = result.text;
  } catch (err) {
    log.warn({ err }, '[messenger] buildBotResponse failed');
    return;
  }
  const replyText = stripMarkers(rawText);
  if (!replyText) return;

  const { sendMessengerText, sendMessengerImage } = await import('../../lib/messenger-send.js');

  // Send product images for any [IMAGE: <sku>] markers the bot emitted, first.
  const imageSkus = Array.from(rawText.matchAll(/\[IMAGE:\s*([^\]\s]+)\s*\]/gi))
    .map((m) => m[1]!.trim())
    .slice(0, 3);
  if (imageSkus.length > 0) {
    const { presignGetUrl } = await import('../../lib/storage.js');
    const products = (data as { products?: { sku: string; images?: { storageKey: string }[] }[] })
      .products ?? [];
    for (const sku of imageSkus) {
      const p = products.find((x) => x.sku.toLowerCase() === sku.toLowerCase());
      const key = p?.images?.[0]?.storageKey;
      if (!key) continue;
      try {
        const url = await presignGetUrl(key, 3600);
        await sendMessengerImage(orgId, psid, url, log);
      } catch (err) {
        log.warn({ err, sku }, '[messenger] product image send failed');
      }
    }
  }

  const metaMessageId = await sendMessengerText(orgId, psid, replyText, log);
  if (metaMessageId === null) return; // send failed — don't persist a phantom outbound

  await withRlsBypass((tx) =>
    tx.whatsAppMessage.create({
      data: {
        threadId,
        organizationId: orgId,
        channel: channelKind,
        direction: 'outbound',
        metaMessageId,
        toNumber: psid,
        messageType: 'text',
        body: replyText,
        rawPayload: { sentBy: 'bot' } as never,
      },
    }),
  );
  await withRlsBypass((tx) =>
    tx.whatsAppThread.update({
      where: { id: threadId },
      data: {
        lastMessageAt: new Date(),
        lastMessagePreview: replyText.slice(0, 200),
        outboundCount: { increment: 1 },
      },
    }),
  );
}
