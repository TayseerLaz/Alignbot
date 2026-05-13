// WhatsApp Cloud API channel routes — Phase 1.5.
//
// Two distinct surfaces in this file:
//
// 1) Tenant-authenticated config endpoints (require an authenticated org
//    member): GET / PUT / DELETE the channel config, run a verify probe
//    against Meta, send a test template message, list inbound messages.
//
// 2) Public webhook endpoints used by Meta itself:
//    - GET  /whatsapp/webhook/:orgId  → handshake (returns hub.challenge
//      when hub.verify_token matches the per-org webhookVerifyToken)
//    - POST /whatsapp/webhook/:orgId  → inbound message events. Verifies
//      the X-Hub-Signature-256 header against the org's appSecret before
//      persisting the payload.
//
// Webhook routes deliberately use `withRlsBypass` (no JWT, no app.tenant)
// because Meta cannot authenticate as a tenant. Tenant scoping is enforced
// by (a) reading the channel by orgId param + (b) requiring a valid HMAC
// signature using THAT channel's appSecret.

import {
  ApiErrorCode,
  itemEnvelopeSchema,
  listEnvelopeSchema,
  successSchema,
  upsertWhatsappChannelBodySchema,
  uuidSchema,
  whatsappChannelSchema,
  whatsappMessageSchema,
  whatsappTestSendBodySchema,
  whatsappTestSendResultSchema,
  whatsappSendTextBodySchema,
  whatsappSendMediaBodySchema,
  whatsappVerifyResultSchema,
} from '@aligned/shared';
import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { recordAudit } from '../../lib/audit.js';
import { generateOpaqueToken } from '../../lib/crypto.js';
import { withRlsBypass } from '../../lib/db.js';
import { env } from '../../lib/env.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { getRedis } from '../../lib/redis.js';

// Outbound token-bucket rate limiter — 80 messages per second per org by
// default (Meta's default is 80 mps for tier 1 numbers; clients tier up
// over time). Backed by Redis INCR + EXPIRE so it survives restarts.
async function consumeSendToken(orgId: string): Promise<{ ok: boolean; retryAfterMs: number }> {
  const redis = getRedis();
  const key = `wasend:${orgId}:${Math.floor(Date.now() / 1000)}`;
  const limit = 80;
  const count = await redis.incr(key);
  if (count === 1) {
    await redis.expire(key, 2);
  }
  if (count > limit) {
    return { ok: false, retryAfterMs: 1000 };
  }
  return { ok: true, retryAfterMs: 0 };
}

// ---- helpers --------------------------------------------------------------

function maskSecret(s: string | null | undefined): string | null {
  if (!s) return null;
  if (s.length <= 8) return '••••';
  return `${s.slice(0, 4)}••••${s.slice(-4)}`;
}

function webhookCallbackUrl(orgId: string): string {
  // Meta posts here; the URL must be public + HTTPS in prod.
  return `${env.API_PUBLIC_URL.replace(/\/$/, '')}/api/v1/whatsapp/webhook/${orgId}`;
}

function serializeChannel(c: {
  id: string;
  wabaId: string | null;
  phoneNumberId: string | null;
  displayPhoneNumber: string | null;
  appId: string | null;
  accessToken: string | null;
  appSecret: string | null;
  webhookVerifyToken: string;
  greetingMessage: string | null;
  businessName: string | null;
  businessAbout: string | null;
  businessAddress: string | null;
  businessEmail: string | null;
  isActive: boolean;
  lastVerifiedAt: Date | null;
  lastVerifyStatus: string | null;
  createdAt: Date;
  updatedAt: Date;
  organizationId: string;
}) {
  return {
    id: c.id,
    wabaId: c.wabaId,
    phoneNumberId: c.phoneNumberId,
    displayPhoneNumber: c.displayPhoneNumber,
    appId: c.appId,
    hasAccessToken: !!c.accessToken,
    hasAppSecret: !!c.appSecret,
    accessTokenMasked: maskSecret(c.accessToken),
    appSecretMasked: maskSecret(c.appSecret),
    webhookVerifyToken: c.webhookVerifyToken,
    webhookCallbackUrl: webhookCallbackUrl(c.organizationId),
    greetingMessage: c.greetingMessage,
    businessName: c.businessName,
    businessAbout: c.businessAbout,
    businessAddress: c.businessAddress,
    businessEmail: c.businessEmail,
    isActive: c.isActive,
    lastVerifiedAt: c.lastVerifiedAt?.toISOString() ?? null,
    lastVerifyStatus: c.lastVerifyStatus,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  };
}

// Defaults applied when an org touches /whatsapp for the first time.
function newDefaults(orgId: string) {
  return {
    organizationId: orgId,
    webhookVerifyToken: `vrf_${generateOpaqueToken(20)}`,
  };
}

// ---- routes ---------------------------------------------------------------

export default async function whatsappRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  // ---------- GET /whatsapp ---------------------------------------------
  r.get(
    '/whatsapp',
    {
      schema: {
        tags: ['whatsapp'],
        summary: 'Get the current org’s WhatsApp channel config (creates a stub on first call).',
        response: { 200: itemEnvelopeSchema(whatsappChannelSchema) },
      },
      preHandler: [app.requireRole('viewer')],
    },
    async (req) => {
      const orgId = req.auth!.organizationId;
      return app.tenant(req, async (tx) => {
        let row = await tx.whatsAppChannel.findFirst({ where: { organizationId: orgId, isPrimary: true } });
        if (!row) {
          row = await tx.whatsAppChannel.create({ data: { ...newDefaults(orgId), isPrimary: true } });
        }
        return { data: serializeChannel(row) };
      });
    },
  );

  // ---------- PUT /whatsapp ---------------------------------------------
  r.put(
    '/whatsapp',
    {
      schema: {
        tags: ['whatsapp'],
        summary: 'Upsert the WhatsApp channel config. Send empty string to clear a secret.',
        body: upsertWhatsappChannelBodySchema,
        response: { 200: itemEnvelopeSchema(whatsappChannelSchema) },
      },
      preHandler: [app.requireRole('admin')],
    },
    async (req) => {
      const orgId = req.auth!.organizationId;
      const b = req.body;
      return app.tenant(req, async (tx) => {
        const existing =
          (await tx.whatsAppChannel.findFirst({ where: { organizationId: orgId, isPrimary: true } })) ??
          (await tx.whatsAppChannel.create({ data: { ...newDefaults(orgId), isPrimary: true } }));

        // Helper: undefined = leave alone, '' = clear, else set.
        const update = <T>(v: T | undefined): T | null | undefined =>
          v === undefined ? undefined : v === '' ? null : v;

        const updated = await tx.whatsAppChannel.update({
          where: { id: existing.id },
          data: {
            wabaId: update(b.wabaId ?? undefined),
            phoneNumberId: update(b.phoneNumberId ?? undefined),
            displayPhoneNumber: update(b.displayPhoneNumber ?? undefined),
            appId: update(b.appId ?? undefined),
            accessToken: update(b.accessToken),
            appSecret: update(b.appSecret),
            greetingMessage: update(b.greetingMessage ?? undefined),
            businessName: update(b.businessName ?? undefined),
            businessAbout: update(b.businessAbout ?? undefined),
            businessAddress: update(b.businessAddress ?? undefined),
            businessEmail: update(b.businessEmail ?? undefined),
            isActive: b.isActive ?? undefined,
          },
        });

        await recordAudit({
          action: 'business_info_updated',
          organizationId: orgId,
          actorUserId: req.auth!.userId,
          entityType: 'whatsapp_channel',
          entityId: updated.id,
          metadata: {
            event: 'whatsapp_channel_updated',
            isActive: updated.isActive,
            // Don't echo any secret values into the audit log.
            fieldsTouched: Object.keys(b).filter((k) => b[k as keyof typeof b] !== undefined),
          },
        });

        return { data: serializeChannel(updated) };
      });
    },
  );

  // ---------- DELETE /whatsapp ------------------------------------------
  r.delete(
    '/whatsapp',
    {
      schema: {
        tags: ['whatsapp'],
        summary: 'Disconnect the WhatsApp channel (clears credentials, marks inactive).',
        response: { 200: successSchema },
      },
      preHandler: [app.requireRole('admin')],
    },
    async (req) => {
      const orgId = req.auth!.organizationId;
      return app.tenant(req, async (tx) => {
        await tx.whatsAppChannel.updateMany({
          where: { organizationId: orgId },
          data: {
            accessToken: null,
            appSecret: null,
            wabaId: null,
            phoneNumberId: null,
            appId: null,
            isActive: false,
            lastVerifyStatus: null,
            lastVerifiedAt: null,
          },
        });
        await recordAudit({
          action: 'business_info_updated',
          organizationId: orgId,
          actorUserId: req.auth!.userId,
          entityType: 'whatsapp_channel',
          metadata: { event: 'whatsapp_channel_disconnected' },
        });
        return { ok: true as const };
      });
    },
  );

  // ---------- POST /whatsapp/verify -------------------------------------
  // Round-trips with Meta's Graph API to confirm the access token + phone
  // number ID are valid. Doesn't store secrets in the response. Persists
  // the verification status so the page can show "last verified at X".
  r.post(
    '/whatsapp/verify',
    {
      schema: {
        tags: ['whatsapp'],
        summary: 'Probe Meta to confirm the configured token + phone number id work.',
        response: { 200: itemEnvelopeSchema(whatsappVerifyResultSchema) },
      },
      preHandler: [app.requireRole('admin')],
    },
    async (req) => {
      const orgId = req.auth!.organizationId;
      const channel = await app.tenant(req, (tx) =>
        tx.whatsAppChannel.findFirst({ where: { organizationId: orgId, isPrimary: true } }),
      );
      if (!channel) throw notFound('WhatsApp channel not configured.');
      if (!channel.accessToken || !channel.phoneNumberId) {
        return {
          data: {
            ok: false,
            status: 'missing_credentials',
            verifiedDisplayPhoneNumber: null,
            verifiedQualityRating: null,
            verifiedNameStatus: null,
            errorMessage: 'Set the access token and phone number ID first.',
            rawSample: null,
          },
        };
      }

      const url = `https://graph.facebook.com/v20.0/${encodeURIComponent(channel.phoneNumberId)}?fields=display_phone_number,verified_name,quality_rating,name_status`;
      let body = '';
      let httpStatus = 0;
      try {
        const res = await fetch(url, {
          headers: { Authorization: `Bearer ${channel.accessToken}` },
          signal: AbortSignal.timeout(10_000),
        });
        httpStatus = res.status;
        body = await res.text();
      } catch (err) {
        const status = 'network_error';
        await app.tenant(req, (tx) =>
          tx.whatsAppChannel.update({
            where: { id: channel.id },
            data: { lastVerifyStatus: status, lastVerifiedAt: new Date() },
          }),
        );
        return {
          data: {
            ok: false,
            status,
            verifiedDisplayPhoneNumber: null,
            verifiedQualityRating: null,
            verifiedNameStatus: null,
            errorMessage: err instanceof Error ? err.message : 'fetch failed',
            rawSample: null,
          },
        };
      }

      let parsed: Record<string, unknown> | null = null;
      try {
        parsed = JSON.parse(body) as Record<string, unknown>;
      } catch {
        parsed = null;
      }

      if (httpStatus < 200 || httpStatus >= 300 || !parsed) {
        // Meta returns { error: { code, message, type, fbtrace_id } }.
        const errObj = (parsed?.error ?? {}) as Record<string, unknown>;
        const code = typeof errObj.code === 'number' ? errObj.code : null;
        const status =
          code === 190 ? 'token_invalid' : httpStatus === 404 ? 'phone_not_found' : `http_${httpStatus}`;
        await app.tenant(req, (tx) =>
          tx.whatsAppChannel.update({
            where: { id: channel.id },
            data: { lastVerifyStatus: status, lastVerifiedAt: new Date() },
          }),
        );
        return {
          data: {
            ok: false,
            status,
            verifiedDisplayPhoneNumber: null,
            verifiedQualityRating: null,
            verifiedNameStatus: null,
            errorMessage: typeof errObj.message === 'string' ? errObj.message : `HTTP ${httpStatus}`,
            rawSample: body.slice(0, 500),
          },
        };
      }

      const display = typeof parsed.display_phone_number === 'string' ? parsed.display_phone_number : null;
      const quality = typeof parsed.quality_rating === 'string' ? parsed.quality_rating : null;
      const nameStatus = typeof parsed.name_status === 'string' ? parsed.name_status : null;

      // Success: capture display number + status, mark verified.
      await app.tenant(req, (tx) =>
        tx.whatsAppChannel.update({
          where: { id: channel.id },
          data: {
            lastVerifyStatus: 'success',
            lastVerifiedAt: new Date(),
            displayPhoneNumber: display ?? channel.displayPhoneNumber,
          },
        }),
      );

      return {
        data: {
          ok: true,
          status: 'success',
          verifiedDisplayPhoneNumber: display,
          verifiedQualityRating: quality,
          verifiedNameStatus: nameStatus,
          errorMessage: null,
          rawSample: null,
        },
      };
    },
  );

  // ---------- POST /whatsapp/test-send ----------------------------------
  // Sends the `hello_world` template — the only message Meta lets us send
  // outside an active 24-hour customer window. Useful for proving the
  // token works end-to-end. Recipient must be a tester registered in Meta.
  r.post(
    '/whatsapp/test-send',
    {
      schema: {
        tags: ['whatsapp'],
        summary: 'Send the hello_world template to a recipient (must be a Meta tester).',
        body: whatsappTestSendBodySchema,
        response: { 200: itemEnvelopeSchema(whatsappTestSendResultSchema) },
      },
      preHandler: [app.requireRole('admin')],
    },
    async (req) => {
      const orgId = req.auth!.organizationId;
      const channel = await app.tenant(req, (tx) =>
        tx.whatsAppChannel.findFirst({ where: { organizationId: orgId, isPrimary: true } }),
      );
      if (!channel) throw notFound('WhatsApp channel not configured.');
      if (!channel.accessToken || !channel.phoneNumberId) {
        throw badRequest(
          ApiErrorCode.VALIDATION_ERROR,
          'Set the access token and phone number ID before sending.',
        );
      }
      const to = req.body.to.replace(/[^\d+]/g, '').replace(/^\+/, '');

      // Template name + language come from the request body (or fall back
      // to the well-known Meta sandbox 'hello_world / en_US'). Most accounts
      // don't actually have hello_world in their library, so we let callers
      // pass any template they've already approved.
      const templateName = req.body.templateName?.trim() || 'hello_world';
      const templateLanguage = req.body.templateLanguage?.trim() || 'en_US';
      // If the template has body placeholders ({{1}}, {{2}}, …) Meta
      // requires a matching `components` array; otherwise it rejects
      // with error 132012 "Parameter format does not match format in the
      // created template." Build it from the optional parameters[] body
      // field; skip when empty so static templates still work.
      const parameters = (req.body.parameters ?? []).map((v) => v.trim());
      const templateBlock: Record<string, unknown> = {
        name: templateName,
        language: { code: templateLanguage },
      };
      if (parameters.length > 0) {
        templateBlock.components = [
          {
            type: 'body',
            parameters: parameters.map((text) => ({ type: 'text', text })),
          },
        ];
      }

      const payload = {
        messaging_product: 'whatsapp',
        to,
        type: 'template',
        template: templateBlock,
      };

      let resBody = '';
      let resStatus = 0;
      try {
        const res = await fetch(
          `https://graph.facebook.com/v20.0/${encodeURIComponent(channel.phoneNumberId)}/messages`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${channel.accessToken}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(10_000),
          },
        );
        resStatus = res.status;
        resBody = await res.text();
      } catch (err) {
        return {
          data: {
            ok: false,
            metaMessageId: null,
            errorMessage: err instanceof Error ? err.message : 'fetch failed',
          },
        };
      }

      let parsed: Record<string, unknown> | null = null;
      try {
        parsed = JSON.parse(resBody) as Record<string, unknown>;
      } catch {
        parsed = null;
      }

      if (resStatus < 200 || resStatus >= 300 || !parsed) {
        const errObj = (parsed?.error ?? {}) as Record<string, unknown>;
        return {
          data: {
            ok: false,
            metaMessageId: null,
            errorMessage:
              typeof errObj.message === 'string'
                ? errObj.message
                : `HTTP ${resStatus} — ${resBody.slice(0, 200)}`,
          },
        };
      }

      const messages = (parsed.messages ?? []) as { id?: string }[];
      const metaMessageId = messages[0]?.id ?? null;

      // Persist outbound for the audit log.
      await withRlsBypass((tx) =>
        tx.whatsAppMessage.create({
          data: {
            organizationId: orgId,
            direction: 'outbound',
            metaMessageId,
            toNumber: to,
            messageType: 'template',
            body: 'hello_world',
            rawPayload: payload as never,
          },
        }),
      ).catch(() => undefined);

      return { data: { ok: true, metaMessageId, errorMessage: null } };
    },
  );

  // ---------- POST /whatsapp/send ---------------------------------------
  // Send a free-form text reply to a customer. Meta only accepts non-template
  // messages within a 24-hour session window after the customer's last
  // inbound message. We don't enforce that here — Meta will return an error
  // and we surface it. Persists outbound to the audit log.
  r.post(
    '/whatsapp/send',
    {
      schema: {
        tags: ['whatsapp'],
        summary: 'Send a free-form text reply (must be inside the 24h customer-session window).',
        body: whatsappSendTextBodySchema,
        response: { 200: itemEnvelopeSchema(whatsappTestSendResultSchema) },
      },
      preHandler: [app.requireRole('editor')],
    },
    async (req) => {
      const orgId = req.auth!.organizationId;
      const channel = await app.tenant(req, (tx) =>
        tx.whatsAppChannel.findFirst({ where: { organizationId: orgId, isPrimary: true } }),
      );
      if (!channel) throw notFound('WhatsApp channel not configured.');
      if (!channel.accessToken || !channel.phoneNumberId) {
        throw badRequest(
          ApiErrorCode.VALIDATION_ERROR,
          'Set the access token and phone number ID before sending.',
        );
      }
      if (!channel.isActive) {
        throw badRequest(
          ApiErrorCode.VALIDATION_ERROR,
          'Channel is not active — flip the Live toggle first.',
        );
      }
      // Phase 3 cap check — block sends when the monthly message cap is hit.
      const { capCheck } = await import('../../lib/billing.js');
      await app.tenant(req, (tx) => capCheck(tx as never, orgId, 'monthly_message'));

      const bucket = await consumeSendToken(orgId);
      if (!bucket.ok) {
        throw badRequest(
          ApiErrorCode.RATE_LIMITED,
          `Outbound rate limit hit — retry in ${bucket.retryAfterMs}ms.`,
        );
      }
      const to = req.body.to.replace(/[^\d+]/g, '').replace(/^\+/, '');

      // §5.1.2 24-hour session window. Meta only allows free-form text
      // when the customer messaged in the last 24h; otherwise the agent
      // must use an approved template. Enforce client-side so the user
      // gets a clear error before we burn a Meta API call (and to surface
      // the requirement in the UI rather than buried in a raw Meta error).
      const lastInbound = await app.tenant(req, (tx) =>
        tx.whatsAppMessage.findFirst({
          where: { direction: 'inbound', fromNumber: to },
          orderBy: { receivedAt: 'desc' },
          select: { receivedAt: true },
        }),
      );
      const ageMs = lastInbound ? Date.now() - lastInbound.receivedAt.getTime() : Infinity;
      if (ageMs > 24 * 60 * 60 * 1000) {
        throw badRequest(
          ApiErrorCode.VALIDATION_ERROR,
          'Outside the 24-hour session window. Send an approved template message instead — free-form replies require an inbound message from this customer in the last 24 hours.',
        );
      }
      const payload = {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to,
        type: 'text',
        text: { preview_url: true, body: req.body.body },
      };

      let resBody = '';
      let resStatus = 0;
      try {
        const res = await fetch(
          `https://graph.facebook.com/v20.0/${encodeURIComponent(channel.phoneNumberId)}/messages`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${channel.accessToken}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(10_000),
          },
        );
        resStatus = res.status;
        resBody = await res.text();
      } catch (err) {
        return {
          data: {
            ok: false,
            metaMessageId: null,
            errorMessage: err instanceof Error ? err.message : 'fetch failed',
          },
        };
      }

      let parsed: Record<string, unknown> | null = null;
      try {
        parsed = JSON.parse(resBody) as Record<string, unknown>;
      } catch {
        parsed = null;
      }

      if (resStatus < 200 || resStatus >= 300 || !parsed) {
        const errObj = (parsed?.error ?? {}) as Record<string, unknown>;
        return {
          data: {
            ok: false,
            metaMessageId: null,
            errorMessage:
              typeof errObj.message === 'string'
                ? errObj.message
                : `HTTP ${resStatus} — ${resBody.slice(0, 200)}`,
          },
        };
      }

      const messages = (parsed.messages ?? []) as { id?: string }[];
      const metaMessageId = messages[0]?.id ?? null;

      await withRlsBypass(async (tx) => {
        const thread = await tx.whatsAppThread.upsert({
          where: { organizationId_customerPhone: { organizationId: orgId, customerPhone: to } },
          create: {
            organizationId: orgId,
            customerPhone: to,
            status: 'open',
            lastMessageAt: new Date(),
            lastMessagePreview: req.body.body.slice(0, 200),
            inboundCount: 0,
            outboundCount: 1,
            searchText: req.body.body,
          },
          update: {
            lastMessageAt: new Date(),
            lastMessagePreview: req.body.body.slice(0, 200),
            outboundCount: { increment: 1 },
          },
        });
        await tx.whatsAppMessage.create({
          data: {
            threadId: thread.id,
            organizationId: orgId,
            direction: 'outbound',
            metaMessageId,
            toNumber: to,
            messageType: 'text',
            body: req.body.body,
            rawPayload: payload as never,
          },
        });
      }).catch(() => undefined);

      // Phase 3 — count this send against the monthly message cap.
      const { bumpUsage } = await import('../../lib/billing.js');
      const { prisma } = await import('../../lib/db.js');
      void bumpUsage(prisma as never, orgId, 'message_outbound');

      await recordAudit({
        action: 'business_info_updated',
        organizationId: orgId,
        actorUserId: req.auth!.userId,
        entityType: 'whatsapp_message',
        entityId: metaMessageId ?? undefined,
        metadata: { event: 'whatsapp_send_text', to },
      });

      return { data: { ok: true, metaMessageId, errorMessage: null } };
    },
  );

  // Thread routes moved to apps/api/src/modules/whatsapp-inbox/inbox.routes.ts
  // (Session 4 — Phase 3 §5.1.1). The new endpoints are id-keyed and
  // support status, tags, assignment, internal notes, and search.

  // ---------- GET /whatsapp/messages ------------------------------------
  // Audit log of inbound + test-outbound messages.
  r.get(
    '/whatsapp/messages',
    {
      schema: {
        tags: ['whatsapp'],
        summary: 'Recent WhatsApp messages (inbound + test-outbound).',
        querystring: z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }),
        response: { 200: listEnvelopeSchema(whatsappMessageSchema) },
      },
      preHandler: [app.requireRole('viewer')],
    },
    async (req) =>
      app.tenant(req, async (tx) => {
        const rows = await tx.whatsAppMessage.findMany({
          orderBy: { receivedAt: 'desc' },
          take: req.query.limit,
        });
        return {
          data: rows.map((m) => ({
            id: m.id,
            direction: m.direction === 'outbound' ? ('outbound' as const) : ('inbound' as const),
            metaMessageId: m.metaMessageId,
            fromNumber: m.fromNumber,
            toNumber: m.toNumber,
            messageType: m.messageType,
            body: m.body,
            receivedAt: m.receivedAt.toISOString(),
          })),
          nextCursor: null,
        };
      }),
  );

  // ---------- POST /whatsapp/send-media -------------------------------
  // Two-step send: download the asset bytes from Wasabi → POST to Meta's
  // /media endpoint to obtain a media_id → POST /messages with that id.
  // Persists the outbound message in the audit log + thread.
  r.post(
    '/whatsapp/send-media',
    {
      schema: {
        tags: ['whatsapp'],
        summary: 'Send a media message (image/document) using an uploaded Asset id.',
        body: whatsappSendMediaBodySchema,
        response: { 200: itemEnvelopeSchema(whatsappTestSendResultSchema) },
      },
      preHandler: [app.requireRole('editor')],
    },
    async (req) => {
      const orgId = req.auth!.organizationId;
      const channel = await app.tenant(req, (tx) =>
        tx.whatsAppChannel.findFirst({ where: { organizationId: orgId, isPrimary: true } }),
      );
      if (!channel) throw notFound('WhatsApp channel not configured.');
      if (!channel.accessToken || !channel.phoneNumberId) {
        throw badRequest(
          ApiErrorCode.VALIDATION_ERROR,
          'Set the access token and phone number ID before sending.',
        );
      }
      if (!channel.isActive) {
        throw badRequest(
          ApiErrorCode.VALIDATION_ERROR,
          'Channel is not active — flip the Live toggle first.',
        );
      }

      // Look up the asset (RLS will enforce tenant isolation).
      const asset = await app.tenant(req, (tx) =>
        tx.asset.findUnique({ where: { id: req.body.assetId } }),
      );
      if (!asset) throw notFound('Asset not found.');

      // Rate limit + cap.
      const { capCheck, bumpUsage } = await import('../../lib/billing.js');
      const { prisma } = await import('../../lib/db.js');
      await app.tenant(req, (tx) => capCheck(tx as never, orgId, 'monthly_message'));
      const bucket = await consumeSendToken(orgId);
      if (!bucket.ok) {
        throw badRequest(
          ApiErrorCode.RATE_LIMITED,
          `Outbound rate limit hit — retry in ${bucket.retryAfterMs}ms.`,
        );
      }

      // Step 1: fetch the asset bytes from object storage.
      const { presignGetUrl, publicUrlFor } = await import('../../lib/storage.js');
      const fileUrl = publicUrlFor(asset.storageKey) ?? (await presignGetUrl(asset.storageKey));
      let fileBytes: Buffer;
      try {
        const r = await fetch(fileUrl, { signal: AbortSignal.timeout(15_000) });
        if (!r.ok) throw new Error(`asset fetch ${r.status}`);
        const ab = await r.arrayBuffer();
        fileBytes = Buffer.from(ab);
      } catch (err) {
        return {
          data: {
            ok: false,
            metaMessageId: null,
            errorMessage: err instanceof Error ? err.message : 'asset fetch failed',
          },
        };
      }

      // Step 2: upload to Meta as multipart/form-data → media_id.
      let metaMediaId: string | null = null;
      try {
        const fd = new FormData();
        const blob = new Blob([fileBytes], { type: asset.contentType ?? 'application/octet-stream' });
        fd.set('file', blob, asset.metadata && (asset.metadata as { filename?: string }).filename ? (asset.metadata as { filename: string }).filename : 'upload.bin');
        fd.set('messaging_product', 'whatsapp');
        fd.set('type', asset.contentType ?? 'application/octet-stream');
        const upRes = await fetch(
          `https://graph.facebook.com/v20.0/${encodeURIComponent(channel.phoneNumberId)}/media`,
          {
            method: 'POST',
            headers: { Authorization: `Bearer ${channel.accessToken}` },
            body: fd,
            signal: AbortSignal.timeout(20_000),
          },
        );
        const upText = await upRes.text();
        if (!upRes.ok) {
          return {
            data: { ok: false, metaMessageId: null, errorMessage: `Meta media upload ${upRes.status}: ${upText.slice(0, 200)}` },
          };
        }
        const upJson = JSON.parse(upText) as { id?: string };
        metaMediaId = upJson.id ?? null;
      } catch (err) {
        return {
          data: {
            ok: false,
            metaMessageId: null,
            errorMessage: err instanceof Error ? err.message : 'Meta upload failed',
          },
        };
      }
      if (!metaMediaId) {
        return { data: { ok: false, metaMessageId: null, errorMessage: 'Meta returned no media id' } };
      }

      // Step 3: send the message.
      const to = req.body.to.replace(/[^\d+]/g, '').replace(/^\+/, '');

      // §5.1.2 24-hour session window — same rule as /whatsapp/send. Media
      // messages also count as free-form for Meta's purposes; outside the
      // window an agent has to use a template.
      const lastInboundMedia = await app.tenant(req, (tx) =>
        tx.whatsAppMessage.findFirst({
          where: { direction: 'inbound', fromNumber: to },
          orderBy: { receivedAt: 'desc' },
          select: { receivedAt: true },
        }),
      );
      const ageMsMedia = lastInboundMedia
        ? Date.now() - lastInboundMedia.receivedAt.getTime()
        : Infinity;
      if (ageMsMedia > 24 * 60 * 60 * 1000) {
        throw badRequest(
          ApiErrorCode.VALIDATION_ERROR,
          'Outside the 24-hour session window. Send an approved template message instead — media replies require an inbound message from this customer in the last 24 hours.',
        );
      }

      const payload = {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to,
        type: req.body.mediaType,
        [req.body.mediaType]: {
          id: metaMediaId,
          ...(req.body.caption ? { caption: req.body.caption } : {}),
        },
      };
      let sendBody = '';
      let sendStatus = 0;
      try {
        const res = await fetch(
          `https://graph.facebook.com/v20.0/${encodeURIComponent(channel.phoneNumberId)}/messages`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${channel.accessToken}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(10_000),
          },
        );
        sendStatus = res.status;
        sendBody = await res.text();
      } catch (err) {
        return {
          data: {
            ok: false,
            metaMessageId: null,
            errorMessage: err instanceof Error ? err.message : 'send failed',
          },
        };
      }

      let parsedSend: Record<string, unknown> | null = null;
      try {
        parsedSend = JSON.parse(sendBody) as Record<string, unknown>;
      } catch {
        parsedSend = null;
      }
      if (sendStatus < 200 || sendStatus >= 300 || !parsedSend) {
        const err = (parsedSend?.error ?? {}) as { message?: string };
        return {
          data: { ok: false, metaMessageId: null, errorMessage: err.message ?? `HTTP ${sendStatus}` },
        };
      }
      const messages = (parsedSend.messages ?? []) as { id?: string }[];
      const metaMessageId = messages[0]?.id ?? null;

      await withRlsBypass(async (tx) => {
        const thread = await tx.whatsAppThread.upsert({
          where: { organizationId_customerPhone: { organizationId: orgId, customerPhone: to } },
          create: {
            organizationId: orgId,
            customerPhone: to,
            status: 'open',
            lastMessageAt: new Date(),
            lastMessagePreview: `[${req.body.mediaType}] ${req.body.caption ?? ''}`.slice(0, 200),
            inboundCount: 0,
            outboundCount: 1,
          },
          update: {
            lastMessageAt: new Date(),
            lastMessagePreview: `[${req.body.mediaType}] ${req.body.caption ?? ''}`.slice(0, 200),
            outboundCount: { increment: 1 },
          },
        });
        await tx.whatsAppMessage.create({
          data: {
            threadId: thread.id,
            organizationId: orgId,
            direction: 'outbound',
            metaMessageId,
            toNumber: to,
            messageType: req.body.mediaType,
            body: req.body.caption ?? null,
            mediaAssetId: asset.id,
            rawPayload: payload as never,
          },
        });
      }).catch(() => undefined);

      void bumpUsage(prisma as never, orgId, 'message_outbound');

      return { data: { ok: true, metaMessageId, errorMessage: null } };
    },
  );

  // ---------- GET /whatsapp/numbers ------------------------------------
  // Lists every channel for the org. Used by the "Numbers" section of the
  // /whatsapp page when a client has more than one Meta phone number.
  r.get(
    '/whatsapp/numbers',
    {
      schema: {
        tags: ['whatsapp'],
        summary: 'List every WhatsApp channel (number) configured for the org.',
      },
      preHandler: [app.requireRole('viewer')],
    },
    async (req) =>
      app.tenant(req, async (tx) => {
        const rows = await tx.whatsAppChannel.findMany({
          orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
        });
        return {
          data: rows.map((c) => ({
            ...serializeChannel(c),
            isPrimary: c.isPrimary,
            label: c.label,
          })),
        };
      }),
  );

  // ---------- POST /whatsapp/numbers -----------------------------------
  // Create a *secondary* number. The first channel an org gets is created
  // implicitly via GET /whatsapp; this endpoint is for additional ones.
  r.post(
    '/whatsapp/numbers',
    {
      schema: {
        tags: ['whatsapp'],
        summary: 'Add an additional (non-primary) WhatsApp number to the org.',
        body: z.object({ label: z.string().trim().min(1).max(80).optional() }),
      },
      preHandler: [app.requireRole('admin')],
    },
    async (req) => {
      const orgId = req.auth!.organizationId;
      return app.tenant(req, async (tx) => {
        // Ensure a primary already exists; if not, the first call should be
        // GET /whatsapp not this one.
        const primary = await tx.whatsAppChannel.findFirst({
          where: { organizationId: orgId, isPrimary: true },
        });
        if (!primary) {
          throw badRequest(
            ApiErrorCode.VALIDATION_ERROR,
            'Configure the primary number first by visiting /whatsapp.',
          );
        }
        const created = await tx.whatsAppChannel.create({
          data: {
            ...newDefaults(orgId),
            isPrimary: false,
            label: req.body.label ?? null,
          },
        });
        return { data: { ...serializeChannel(created), isPrimary: false, label: created.label } };
      });
    },
  );

  // ---------- POST /whatsapp/numbers/:id/promote ------------------------
  // Switch which channel is the org's primary. Wrapped in a transaction so
  // the partial unique index never sees two primaries momentarily.
  r.post(
    '/whatsapp/numbers/:id/promote',
    {
      schema: {
        tags: ['whatsapp'],
        summary: 'Mark a channel as the org\'s primary number.',
        params: z.object({ id: uuidSchema }),
        response: { 200: successSchema },
      },
      preHandler: [app.requireRole('admin')],
    },
    async (req) => {
      const orgId = req.auth!.organizationId;
      return app.tenant(req, async (tx) => {
        const target = await tx.whatsAppChannel.findFirst({
          where: { id: req.params.id, organizationId: orgId },
        });
        if (!target) throw notFound('Channel not found.');
        if (target.isPrimary) return { ok: true as const };
        // Demote the existing primary first.
        await tx.whatsAppChannel.updateMany({
          where: { organizationId: orgId, isPrimary: true },
          data: { isPrimary: false },
        });
        await tx.whatsAppChannel.update({
          where: { id: target.id },
          data: { isPrimary: true },
        });
        return { ok: true as const };
      });
    },
  );

  // ---------- DELETE /whatsapp/numbers/:id -----------------------------
  // Remove a non-primary channel. Removing the primary is refused — promote
  // another number first.
  r.delete(
    '/whatsapp/numbers/:id',
    {
      schema: {
        tags: ['whatsapp'],
        summary: 'Remove a non-primary WhatsApp channel.',
        params: z.object({ id: uuidSchema }),
        response: { 200: successSchema },
      },
      preHandler: [app.requireRole('admin')],
    },
    async (req) => {
      const orgId = req.auth!.organizationId;
      return app.tenant(req, async (tx) => {
        const target = await tx.whatsAppChannel.findFirst({
          where: { id: req.params.id, organizationId: orgId },
        });
        if (!target) throw notFound('Channel not found.');
        if (target.isPrimary) {
          throw badRequest(
            ApiErrorCode.CONFLICT,
            'Cannot remove the primary channel — promote another number first.',
          );
        }
        await tx.whatsAppChannel.delete({ where: { id: target.id } });
        return { ok: true as const };
      });
    },
  );

  // -----------------------------------------------------------------
  // Public webhook surfaces — no JWT, signature-verified.
  // -----------------------------------------------------------------

  // ---------- GET /whatsapp/webhook/:orgId  (Meta verification) ---------
  // Meta sends GET ?hub.mode=subscribe&hub.verify_token=…&hub.challenge=…
  // We echo the challenge if (a) the org has a channel and (b) the verify
  // token matches what we stored.
  r.get(
    '/whatsapp/webhook/:orgId',
    {
      schema: {
        tags: ['whatsapp'],
        summary: 'Meta webhook verification handshake.',
        params: z.object({ orgId: uuidSchema }),
        querystring: z.object({
          'hub.mode': z.string().optional(),
          'hub.verify_token': z.string().optional(),
          'hub.challenge': z.string().optional(),
        }),
      },
      // Public endpoint — no preHandler.
      logLevel: 'warn', // these are noisy in dev
    },
    async (req, reply) => {
      // Use the org's primary channel's verify token. Meta verifies the
      // webhook URL once per WABA, so the primary number's token is the
      // canonical one for the whole org's subscription.
      const channel = await withRlsBypass((tx) =>
        tx.whatsAppChannel.findFirst({
          where: { organizationId: req.params.orgId, isPrimary: true },
        }),
      );
      const mode = req.query['hub.mode'];
      const token = req.query['hub.verify_token'];
      const challenge = req.query['hub.challenge'];
      if (
        !channel ||
        mode !== 'subscribe' ||
        !token ||
        !crypto.timingSafeEqual(
          Buffer.from(token.padEnd(64).slice(0, 64)),
          Buffer.from(channel.webhookVerifyToken.padEnd(64).slice(0, 64)),
        )
      ) {
        reply.code(403);
        return 'forbidden';
      }
      reply.code(200).header('content-type', 'text/plain');
      return challenge ?? '';
    },
  );

  // ---------- POST /whatsapp/webhook/:orgId  (inbound events) -----------
  // Meta posts message events here. We:
  //   1. Read the raw body (so HMAC matches byte-for-byte).
  //   2. Verify X-Hub-Signature-256 against the org's appSecret.
  //   3. Persist every message in `whatsapp_messages` for the audit log.
  //   4. Always reply 200 fast (Meta retries on non-2xx + 5s timeout).
  // We do NOT auto-respond to messages — that's the bot's job, not the
  // platform's. Phase 2 wires this to a flow runtime.
  r.post(
    '/whatsapp/webhook/:orgId',
    {
      schema: {
        tags: ['whatsapp'],
        summary: 'Meta webhook delivery (signature-verified).',
        params: z.object({ orgId: uuidSchema }),
      },
      // Public endpoint — no preHandler.
      // Capture raw body so signature verification works.
      // Fastify exposes request.rawBody when this option is set on the schema.
    },
    async (req, reply) => {
      // For multi-number orgs we resolve the channel by the inbound
      // payload's `metadata.phone_number_id`, falling back to the primary.
      // The HMAC must validate against THAT channel's appSecret because
      // Meta uses the app-level secret (which is the same across all
      // numbers under one app, but we keep it per-channel for flexibility).
      const inferredPhoneId = ((req.body ?? {}) as {
        entry?: { changes?: { value?: { metadata?: { phone_number_id?: string } } }[] }[];
      }).entry?.[0]?.changes?.[0]?.value?.metadata?.phone_number_id;

      const channel = await withRlsBypass(async (tx) => {
        if (inferredPhoneId) {
          const byPhone = await tx.whatsAppChannel.findFirst({
            where: { organizationId: req.params.orgId, phoneNumberId: inferredPhoneId },
          });
          if (byPhone) return byPhone;
        }
        return tx.whatsAppChannel.findFirst({
          where: { organizationId: req.params.orgId, isPrimary: true },
        });
      });
      if (!channel || !channel.appSecret) {
        // Without an app secret we can't authenticate the request — refuse
        // rather than persist a potentially-spoofed message.
        req.log.warn(
          { orgId: req.params.orgId, inferredPhoneId, hasChannel: !!channel, hasSecret: !!channel?.appSecret },
          '[whatsapp] webhook rejected — channel or app secret missing',
        );
        reply.code(403);
        return 'forbidden';
      }

      const sig = req.headers['x-hub-signature-256'];
      const sigStr = Array.isArray(sig) ? sig[0] : sig;
      // HMAC must be computed over Meta's ORIGINAL request bytes — not a
      // re-stringification of the parsed body. server.ts's custom
      // application/json parser stashes the raw UTF-8 body at
      // req.rawBody for exactly this. If for any reason it's missing
      // (e.g. someone calls this route with no Content-Type) we fall
      // back to JSON.stringify, which is the legacy behaviour and at
      // least matches Meta's bytes most of the time.
      const rawBody =
        (req as unknown as { rawBody?: string }).rawBody ?? JSON.stringify(req.body ?? {});
      const expected =
        'sha256=' +
        crypto.createHmac('sha256', channel.appSecret).update(rawBody).digest('hex');
      const ok =
        typeof sigStr === 'string' &&
        sigStr.length === expected.length &&
        crypto.timingSafeEqual(Buffer.from(sigStr), Buffer.from(expected));
      if (!ok) {
        // Log enough to debug app-secret mismatches without leaking the
        // secret itself: show the first/last chars of received sig vs the
        // expected one so an operator can eyeball the diff.
        const previewSig = (s: string | undefined): string =>
          !s ? '<missing>' : s.length < 16 ? s : `${s.slice(0, 12)}…${s.slice(-4)} (len=${s.length})`;
        req.log.warn(
          {
            orgId: req.params.orgId,
            inferredPhoneId,
            received: previewSig(sigStr),
            expected: previewSig(expected),
            bodyLen: rawBody.length,
          },
          '[whatsapp] webhook signature mismatch — check app secret in /whatsapp',
        );
        reply.code(401);
        return 'invalid signature';
      }
      req.log.info(
        { orgId: req.params.orgId, inferredPhoneId, bodyLen: rawBody.length },
        '[whatsapp] webhook signature ok',
      );

      // Walk Meta's payload structure: entry[].changes[].value.messages[]
      // for inbound, entry[].changes[].value.statuses[] for delivery /
      // read receipts on outbound messages we previously sent.
      const body = (req.body ?? {}) as {
        entry?: {
          changes?: {
            value?: {
              messaging_product?: string;
              metadata?: { display_phone_number?: string; phone_number_id?: string };
              messages?: {
                id?: string;
                from?: string;
                type?: string;
                text?: { body?: string };
                timestamp?: string;
              }[];
              statuses?: {
                id?: string; // wamid of the outbound message
                status?: 'sent' | 'delivered' | 'read' | 'failed';
                timestamp?: string;
                recipient_id?: string;
              }[];
            };
          }[];
        }[];
      };

      // Read-receipt path — process status events first so the inbound
      // path's transaction work doesn't block them.
      for (const entry of body.entry ?? []) {
        for (const change of entry.changes ?? []) {
          for (const s of change.value?.statuses ?? []) {
            if (!s.id || !s.status) continue;
            const ts = s.timestamp ? new Date(Number(s.timestamp) * 1000) : new Date();
            await withRlsBypass(async (tx) => {
              await tx.whatsAppMessage.updateMany({
                where: {
                  organizationId: channel.organizationId,
                  metaMessageId: s.id!,
                },
                data: {
                  metaStatus: s.status!,
                  metaStatusAt: ts,
                },
              });

              // Phase 4 — also propagate to BroadcastRecipient (lookup by wamid).
              const recipient = await tx.broadcastRecipient.findFirst({
                where: {
                  organizationId: channel.organizationId,
                  metaMessageId: s.id!,
                },
              });
              if (!recipient) return;
              const updates: Record<string, unknown> = {};
              const counterDelta: Record<string, number> = {};
              if (s.status === 'delivered' && recipient.status !== 'read') {
                updates.status = 'delivered';
                updates.deliveredAt = ts;
                counterDelta.deliveredCount = 1;
              } else if (s.status === 'read') {
                updates.status = 'read';
                updates.readAt = ts;
                if (!recipient.deliveredAt) {
                  updates.deliveredAt = ts;
                  counterDelta.deliveredCount = 1;
                }
                counterDelta.readCount = 1;
              } else if (s.status === 'failed' && recipient.status !== 'failed') {
                updates.status = 'failed';
                updates.failedAt = ts;
                counterDelta.failedCount = 1;
              }
              if (Object.keys(updates).length > 0) {
                await tx.broadcastRecipient.update({
                  where: { id: recipient.id },
                  data: updates,
                });
              }
              if (Object.keys(counterDelta).length > 0) {
                await tx.broadcast.update({
                  where: { id: recipient.broadcastId },
                  data: Object.fromEntries(
                    Object.entries(counterDelta).map(([k, v]) => [k, { increment: v }]),
                  ),
                });
              }
            }).catch((err) => req.log.error({ err }, '[whatsapp] status update failed'));
          }
        }
      }

      const persisted: { from: string; type: string; bodyText: string | null; metaId: string | null }[] = [];
      for (const entry of body.entry ?? []) {
        for (const change of entry.changes ?? []) {
          const value = change.value;
          if (!value || !value.messages) continue;
          for (const m of value.messages) {
            persisted.push({
              from: m.from ?? '',
              type: m.type ?? 'unknown',
              bodyText: m.text?.body ?? null,
              metaId: m.id ?? null,
            });

            // Phase 5.3 — STOP-keyword opt-out. Match common unsubscribe
            // verbs (locale-agnostic). On match, set the contact's
            // opted_out_at so future broadcasts skip them.
            const STOP_RE = /^\s*(stop|unsubscribe|quit|cancel|end|opt\s*out|alto|para|arr[eê]ter|stopper|اوقف|إيقاف)\s*\.?\s*$/i;
            const bodyText = m.text?.body ?? '';
            if (m.from && STOP_RE.test(bodyText)) {
              await withRlsBypass(async (tx) => {
                const e164 = `+${m.from}`;
                await tx.contact.upsert({
                  where: {
                    organizationId_phoneE164: {
                      organizationId: channel.organizationId,
                      phoneE164: e164,
                    },
                  },
                  create: {
                    organizationId: channel.organizationId,
                    phoneE164: e164,
                    optedOutAt: new Date(),
                    source: 'inbox_auto',
                  },
                  update: { optedOutAt: new Date() },
                });
              }).catch((err) =>
                req.log.error({ err }, '[whatsapp] STOP opt-out failed'),
              );
            }
            // Upsert the thread + persist the message + bump the
            // thread's preview/counts in one transaction. RLS bypassed
            // because the public webhook can't carry tenant context —
            // we write into channel.organizationId derived from the URL.
            await withRlsBypass(async (tx) => {
              const phone = m.from ?? null;
              if (!phone) {
                await tx.whatsAppMessage.create({
                  data: {
                    organizationId: channel.organizationId,
                    direction: 'inbound',
                    metaMessageId: m.id ?? null,
                    fromNumber: null,
                    toNumber: value.metadata?.display_phone_number ?? null,
                    messageType: m.type ?? null,
                    body: m.text?.body ?? null,
                    rawPayload: m as never,
                  },
                });
                return;
              }
              const preview = (m.text?.body ?? `[${m.type ?? 'media'}]`).slice(0, 200);
              const thread = await tx.whatsAppThread.upsert({
                where: {
                  organizationId_customerPhone: {
                    organizationId: channel.organizationId,
                    customerPhone: phone,
                  },
                },
                create: {
                  organizationId: channel.organizationId,
                  customerPhone: phone,
                  status: 'open',
                  lastMessageAt: new Date(),
                  lastMessagePreview: preview,
                  inboundCount: 1,
                  outboundCount: 0,
                  searchText: m.text?.body ?? '',
                },
                update: {
                  lastMessageAt: new Date(),
                  lastMessagePreview: preview,
                  inboundCount: { increment: 1 },
                  // Reopen if previously resolved.
                  status: 'open',
                  // Append to the rolling search blob, capped at ~16 KB.
                  searchText: { set: '' }, // see post-update below
                },
              });
              // Two-step search-text update so we keep the existing blob
              // bounded without a stored procedure. The `$2::uuid` cast is
              // required because Prisma's $executeRawUnsafe passes JS
              // strings as `text` and Postgres won't compare `uuid = text`
              // implicitly (error 42883). The id column on
              // whatsapp_threads is uuid.
              if (m.text?.body) {
                await tx.$executeRawUnsafe(
                  `UPDATE whatsapp_threads
                     SET search_text = LEFT(COALESCE(search_text,'') || ' ' || $1, 16000)
                     WHERE id = $2::uuid`,
                  m.text.body,
                  thread.id,
                );
              }
              await tx.whatsAppMessage.create({
                data: {
                  threadId: thread.id,
                  organizationId: channel.organizationId,
                  direction: 'inbound',
                  metaMessageId: m.id ?? null,
                  fromNumber: phone,
                  toNumber: value.metadata?.display_phone_number ?? null,
                  messageType: m.type ?? null,
                  body: m.text?.body ?? null,
                  rawPayload: m as never,
                },
              });
              // Notify on first inbound from this customer (thread.inboundCount
              // == 1 means this insert just created it). Cheap to over-notify;
              // bell collapses dups by entityId.
              if (thread.inboundCount === 0) {
                await tx.notification.create({
                  data: {
                    organizationId: channel.organizationId,
                    kind: 'generic',
                    severity: 'info',
                    title: 'New conversation',
                    body: `New WhatsApp message from ${phone}`,
                    link: '/inbox',
                    entityType: 'whatsapp_thread',
                    entityId: thread.id,
                  },
                });
              }
            }).catch((err) => req.log.error({ err }, '[whatsapp] persist failed'));
          }
        }
      }

      // Bot runtime — fire-and-forget. Conditions: bot is deployed, the
      // org has an OpenAI key, the thread isn't already assigned to a
      // human, and the message has body text. Reply latency is paid by
      // Meta's reply window so we don't block the webhook 200 on this.
      void (async () => {
        try {
          await maybeReplyAsBot({
            organizationId: channel.organizationId,
            messages: persisted,
            log: req.log,
          });
        } catch (err) {
          req.log.error({ err }, '[whatsapp] bot reply failed');
        }
      })();

      reply.code(200);
      return { received: persisted.length };
    },
  );
}

// Phase 2 — auto-reply hook called from the inbound webhook. Looks up the
// bot config + thread, asks the LLM via bot-engine, sends through the
// existing /whatsapp/send token-bucket. No-ops cleanly when:
//   - OPENAI_API_KEY is not configured
//   - BotConfig.deployedAt is null
//   - the thread has been assigned to a human (operator owns it now)
//   - the inbound message has no text (image/template/system event)
async function maybeReplyAsBot(args: {
  organizationId: string;
  messages: { from: string; type: string; bodyText: string | null; metaId: string | null }[];
  log: { error: (...args: unknown[]) => void; warn: (...args: unknown[]) => void };
}): Promise<void> {
  const { isOpenAIConfigured } = await import('../../lib/openai.js');
  if (!isOpenAIConfigured()) return;

  const { withRlsBypass } = await import('../../lib/db.js');
  const { buildBotResponse, gatherBotData } = await import('../../lib/bot-engine.js');

  for (const m of args.messages) {
    if (!m.bodyText || !m.from) continue;

    // tx1: read everything we need to decide whether to reply + the prompt
    // data. No LLM call inside.
    const ctx = await withRlsBypass(async (tx) => {
      const config = await tx.botConfig.findUnique({
        where: { organizationId: args.organizationId },
      });
      if (!config?.deployedAt) return null;

      const thread = await tx.whatsAppThread.findFirst({
        where: { organizationId: args.organizationId, customerPhone: m.from },
      });
      if (!thread) return null;
      // Don't reply if a human owns it.
      if (thread.assignedToUserId) return null;

      const ch = await tx.whatsAppChannel.findFirst({
        where: { organizationId: args.organizationId, isPrimary: true },
      });
      if (!ch || !ch.accessToken || !ch.phoneNumberId || !ch.isActive) return null;

      // Pull recent thread history (last 10 msgs) for short-term memory.
      const history = await tx.whatsAppMessage.findMany({
        where: { threadId: thread.id, body: { not: null } },
        orderBy: { receivedAt: 'desc' },
        take: 10,
      });
      const data = await gatherBotData(tx as never, args.organizationId);

      return { history: history.reverse(), data, channel: ch };
    });
    if (!ctx) continue;

    // OpenAI call — outside the tx. Safe to be slow.
    const result = await buildBotResponse({
      organizationId: args.organizationId,
      userMessage: m.bodyText!,
      history: ctx.history.map((h) => ({
        role: h.direction === 'outbound' ? ('assistant' as const) : ('user' as const),
        content: h.body ?? '',
      })),
      data: ctx.data,
    }).catch((err) => {
      args.log.warn({ err }, '[whatsapp] bot-engine failed');
      return null;
    });
    const reply = result?.text ?? null;
    const channel = ctx.channel;
    if (!reply) continue;

    // Send via Meta directly (we're in the worker-equivalent path; reusing
    // the in-process token bucket from the /send route is fine — both
    // share the same Redis key).
    try {
      const payload = {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: m.from,
        type: 'text',
        text: { preview_url: false, body: reply },
      };
      const res = await fetch(
        `https://graph.facebook.com/v20.0/${encodeURIComponent(channel.phoneNumberId!)}/messages`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${channel.accessToken!}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(10_000),
        },
      );
      const text = await res.text();
      if (!res.ok) {
        args.log.warn({ status: res.status, text: text.slice(0, 200) }, '[whatsapp] bot send failed');
        continue;
      }
      let metaMessageId: string | null = null;
      try {
        const parsed = JSON.parse(text) as { messages?: { id?: string }[] };
        metaMessageId = parsed.messages?.[0]?.id ?? null;
      } catch {
        /* ignore */
      }
      // Persist outbound + bump thread.
      await withRlsBypass(async (tx) => {
        const thread = await tx.whatsAppThread.findFirst({
          where: { organizationId: args.organizationId, customerPhone: m.from },
        });
        if (!thread) return;
        await tx.whatsAppMessage.create({
          data: {
            threadId: thread.id,
            organizationId: args.organizationId,
            direction: 'outbound',
            metaMessageId,
            toNumber: m.from,
            messageType: 'text',
            body: reply,
            rawPayload: { sentBy: 'bot' } as never,
          },
        });
        await tx.whatsAppThread.update({
          where: { id: thread.id },
          data: {
            lastMessageAt: new Date(),
            lastMessagePreview: reply.slice(0, 200),
            outboundCount: { increment: 1 },
          },
        });
      });
    } catch (err) {
      args.log.warn({ err }, '[whatsapp] bot send threw');
    }
  }
}
