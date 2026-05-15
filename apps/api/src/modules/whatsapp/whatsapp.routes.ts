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

// Sniff the actual container of an uploaded media file by its magic
// bytes. Returns a canonical MIME (without codec parameters) when
// recognised, or null when we can't tell. Used to override the
// browser-supplied content-type before forwarding to Meta — Chrome
// reports audio/ogg but actually writes WebM, etc.
function sniffMediaContainer(buf: Buffer): string | null {
  if (buf.length < 12) return null;
  // OGG container — "OggS" magic at offset 0.
  if (buf[0] === 0x4f && buf[1] === 0x67 && buf[2] === 0x67 && buf[3] === 0x53) {
    return 'audio/ogg';
  }
  // WebM / Matroska — EBML header 1A 45 DF A3 at offset 0.
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) {
    return 'audio/webm';
  }
  // ISO BMFF (MP4 / M4A) — "ftyp" at offset 4..7.
  if (buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70) {
    return 'audio/mp4';
  }
  // ID3 tag (MP3) — "ID3" at offset 0.
  if (buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) {
    return 'audio/mpeg';
  }
  // MPEG frame sync — 0xFFFx at offset 0. Covers raw MP3 streams.
  if (buf[0] === 0xff && (buf[1]! & 0xe0) === 0xe0) {
    return 'audio/mpeg';
  }
  // AMR — "#!AMR\n" at offset 0.
  if (
    buf[0] === 0x23 && buf[1] === 0x21 && buf[2] === 0x41 &&
    buf[3] === 0x4d && buf[4] === 0x52 && buf[5] === 0x0a
  ) {
    return 'audio/amr';
  }
  // Common image / pdf containers — let send-media keep working for
  // those without changing what the caller declared.
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (
    buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47
  ) {
    return 'image/png';
  }
  if (buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46) {
    return 'application/pdf';
  }
  return null;
}

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
      const parameters = (req.body.parameters ?? []).map((v) => v.trim());

      // Fetch the template's components from Meta so we can build a payload
      // that satisfies every part Meta expects:
      //   - HEADER with TEXT  → if it has {{1}}, take the first body param
      //                          (rare; templates usually have header text
      //                          static). Skipped for now.
      //   - HEADER with IMAGE/VIDEO/DOCUMENT → use the `example.header_handle`
      //                          URL Meta itself provided when the template
      //                          was created. This is what allows test-send
      //                          on media-header templates without uploading.
      //   - BODY              → bind operator-supplied parameters[] to the
      //                          {{1}}, {{2}}, … placeholders.
      //   - FOOTER + BUTTONS  → no parameters required for static / quick-
      //                          reply buttons. URL buttons with {{1}} would
      //                          need handling, deferred.
      // Without this lookup, media-header templates fail with Meta error
      // 132012 ("Parameter format does not match format in the created
      // template") even when the body has no placeholders.
      type MetaComp = {
        type?: string;
        format?: string;
        text?: string;
        example?: { header_handle?: string[] };
      };
      let metaComponents: MetaComp[] = [];
      try {
        const tplRes = await fetch(
          `https://graph.facebook.com/v20.0/${encodeURIComponent(channel.wabaId!)}/message_templates` +
            `?name=${encodeURIComponent(templateName)}&fields=id,name,language,components&limit=10`,
          {
            headers: { Authorization: `Bearer ${channel.accessToken}` },
            signal: AbortSignal.timeout(8_000),
          },
        );
        if (tplRes.ok) {
          const body = (await tplRes.json()) as {
            data?: { name?: string; language?: string; components?: MetaComp[] }[];
          };
          const match = (body.data ?? []).find(
            (t) => t.name === templateName && t.language === templateLanguage,
          ) ?? (body.data ?? [])[0];
          metaComponents = match?.components ?? [];
        }
      } catch {
        // Non-fatal — fall through with no components and let Meta tell us
        // what's wrong on the actual send call.
      }

      // Operator-supplied per-variable values for header + button URL
      // placeholders. `parameters[]` already covers the body.
      const headerTextParam = req.body.headerTextParam?.trim() ?? null;
      const buttonUrlParams = (req.body.buttonUrlParams ?? []).map((v) => v.trim());

      const sendComponents: Record<string, unknown>[] = [];
      let urlButtonCursor = 0;

      for (const rawC of metaComponents) {
        const c = rawC as MetaComp & {
          buttons?: { type?: string; url?: string }[];
        };
        const t = (c.type ?? '').toUpperCase();
        const fmt = (c.format ?? '').toUpperCase();
        if (t === 'HEADER') {
          if (fmt === 'TEXT') {
            // Header with {{1}} (Meta only supports one var in headers).
            const hasVar = /{{\s*1\s*}}/.test(c.text ?? '');
            if (hasVar && headerTextParam) {
              sendComponents.push({
                type: 'header',
                parameters: [{ type: 'text', text: headerTextParam }],
              });
            }
          } else if (fmt && fmt !== 'TEXT') {
            const handle = c.example?.header_handle?.[0];
            if (handle) {
              const kind = fmt.toLowerCase(); // image | video | document
              sendComponents.push({
                type: 'header',
                parameters: [{ type: kind, [kind]: { link: handle } }],
              });
            }
          }
        }
        if (t === 'BODY' && parameters.length > 0) {
          sendComponents.push({
            type: 'body',
            parameters: parameters.map((text) => ({ type: 'text', text })),
          });
        }
        if (t === 'BUTTONS') {
          // For each URL button with {{1}}, pull the next value from
          // buttonUrlParams[] and emit a per-button-index entry. Non-URL
          // buttons and URL buttons without placeholders are skipped
          // (Meta doesn't need a runtime parameter for them).
          const buttons = c.buttons ?? [];
          buttons.forEach((b, i) => {
            const btype = (b.type ?? '').toUpperCase();
            if (btype !== 'URL') return;
            const hasVar = /{{\s*1\s*}}/.test(b.url ?? '');
            if (!hasVar) return;
            const value = buttonUrlParams[urlButtonCursor] ?? '';
            urlButtonCursor += 1;
            if (!value) return;
            sendComponents.push({
              type: 'button',
              sub_type: 'url',
              index: String(i),
              parameters: [{ type: 'text', text: value }],
            });
          });
        }
      }

      const templateBlock: Record<string, unknown> = {
        name: templateName,
        language: { code: templateLanguage },
      };
      if (sendComponents.length > 0) {
        templateBlock.components = sendComponents;
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

      // Persist outbound to the inbox: upsert a thread keyed by the
      // recipient phone, attach the whatsAppMessage to it, and bump
      // the preview/counts so the conversation surfaces immediately
      // in /inbox.
      //
      // For the message body we render the FULL template text the
      // recipient will actually see — pulled from the BODY component
      // we just fetched from Meta — with {{1}}, {{2}}, … interpolated
      // from the operator's parameters. This way the inbox shows the
      // real customer-facing copy instead of a "[template] name"
      // placeholder, and there's no "see more" truncation: operators
      // can read the whole thing without scrolling on a phone.
      const bodyComponent = metaComponents.find((c) => (c.type ?? '').toUpperCase() === 'BODY');
      const bodyTemplate = bodyComponent?.text ?? '';
      const renderedBody = bodyTemplate
        ? bodyTemplate.replace(/{{\s*(\d+)\s*}}/g, (_match, idx: string) => {
            const i = Number(idx) - 1;
            return parameters[i] ?? `{{${idx}}}`;
          })
        : '';
      // Compose: [template tag line] + body. The leading tag makes it
      // obvious in the inbox that this was a template send, not a
      // free-form message. Fall back to a plain marker when the
      // Meta-side components fetch failed.
      const tagLine = `📨 Template · ${templateName}${templateLanguage !== 'en_US' ? ` (${templateLanguage})` : ''}`;
      const previewBody = renderedBody
        ? `${tagLine}\n\n${renderedBody}`
        : parameters.length > 0
        ? `${tagLine} · ${parameters.join(' / ')}`
        : tagLine;
      await withRlsBypass(async (tx) => {
        const thread = await tx.whatsAppThread.upsert({
          where: { organizationId_customerPhone: { organizationId: orgId, customerPhone: to } },
          create: {
            organizationId: orgId,
            customerPhone: to,
            status: 'open',
            lastMessageAt: new Date(),
            lastMessagePreview: previewBody.slice(0, 200),
            inboundCount: 0,
            outboundCount: 1,
            searchText: previewBody,
          },
          update: {
            lastMessageAt: new Date(),
            lastMessagePreview: previewBody.slice(0, 200),
            outboundCount: { increment: 1 },
            status: 'open',
          },
        });
        await tx.whatsAppMessage.create({
          data: {
            threadId: thread.id,
            organizationId: orgId,
            direction: 'outbound',
            metaMessageId,
            fromNumber: channel.displayPhoneNumber ?? null,
            toNumber: to,
            messageType: 'template',
            body: previewBody,
            rawPayload: payload as never,
          },
        });
      }).catch((err) => req.log.error({ err }, '[whatsapp] test-send persist failed'));

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
      await app.tenant(req, (tx) => capCheck(tx as never, orgId, 'monthly_message', { actorIsAlignedAdmin: req.auth!.isAlignedAdmin }));

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
        // Operator replied → if the bot had escalated this chat to a
        // human, clear the flag so the sidebar badge decrements and
        // the red row tint goes away. Don't touch other statuses
        // (resolved / pending / open) since the operator might be
        // intentionally re-opening a closed chat.
        if (thread.status === 'escalated' || thread.assignedToUserId === null) {
          await tx.whatsAppThread.update({
            where: { id: thread.id },
            data: {
              ...(thread.status === 'escalated' ? { status: 'open' as never } : {}),
              ...(thread.assignedToUserId === null
                ? { assignedToUserId: req.auth!.userId }
                : {}),
            },
          });
        }
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
      // Tag every step of the voice/media send with a distinctive
      // prefix so we can grep the journalctl output cleanly. Drop
      // these once the path is confirmed healthy in prod.
      req.log.info(
        {
          assetId: req.body.assetId,
          mediaType: req.body.mediaType,
          to: req.body.to,
          hasCaption: !!req.body.caption,
        },
        '[AL-VOICE-DEBUG] send-media route start',
      );
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
      await app.tenant(req, (tx) => capCheck(tx as never, orgId, 'monthly_message', { actorIsAlignedAdmin: req.auth!.isAlignedAdmin }));
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
      // Meta's /media rejects MIME types that include codec parameters
      // (e.g. "audio/ogg;codecs=opus") — strip everything after ';'.
      // Then if we're sending audio, also coerce to one of the MIME
      // types Meta accepts (https://developers.facebook.com/docs/whatsapp/cloud-api/reference/media):
      //   audio/aac, audio/mp4, audio/mpeg, audio/amr, audio/ogg.
      //
      // IMPORTANT: Browsers lie about what MediaRecorder is going to
      // produce. Chrome on desktop reports isTypeSupported('audio/ogg')
      // as true but actually writes a WebM/EBML container internally.
      // Meta validates the bytes, not the headers, and silently rejects
      // unsupported audio containers — the upload "succeeds" (200) but
      // the customer never sees the message. So we sniff the magic bytes
      // here, override the MIME to the truth, and degrade audio → document
      // when the container isn't actually one Meta plays back.
      const rawContentType = asset.contentType ?? 'application/octet-stream';
      let baseContentType = rawContentType.split(';')[0]!.trim();
      const sniffed = sniffMediaContainer(fileBytes);
      if (sniffed) baseContentType = sniffed;
      const META_AUDIO_OK = new Set([
        'audio/aac',
        'audio/mp4',
        'audio/mpeg',
        'audio/amr',
        'audio/ogg',
      ]);
      let effectiveMediaType = req.body.mediaType;
      if (effectiveMediaType === 'audio' && !META_AUDIO_OK.has(baseContentType)) {
        // Most common cause: Chrome recorded WebM/Opus. Meta doesn't
        // play that back as audio, but it WILL deliver it as a document
        // — the customer taps it and their phone plays it back. Keep
        // the voice-note filename so the bubble is recognisable.
        req.log.warn(
          { sniffed, raw: rawContentType },
          '[whatsapp] audio container not in Meta allowlist — falling back to document',
        );
        effectiveMediaType = 'document';
      }
      req.log.info(
        {
          assetContentType: rawContentType,
          sniffed,
          baseContentType,
          requestedMediaType: req.body.mediaType,
          effectiveMediaType,
          fileBytesLen: fileBytes.length,
        },
        '[AL-VOICE-DEBUG] after sniff',
      );
      // Filename + extension matter to Meta — it uses the extension to
      // dispatch the file to the right downstream pipeline. Sending
      // "upload.bin" makes Meta accept the upload, but WhatsApp can't
      // play it back. Derive a sensible extension from the content
      // type so audio actually reaches the customer's phone.
      const EXT_BY_MIME: Record<string, string> = {
        'audio/ogg': 'ogg',
        'audio/mpeg': 'mp3',
        'audio/mp4': 'm4a',
        'audio/aac': 'aac',
        'audio/amr': 'amr',
        'audio/webm': 'webm',
        'image/jpeg': 'jpg',
        'image/png': 'png',
        'image/webp': 'webp',
        'video/mp4': 'mp4',
        'application/pdf': 'pdf',
      };
      const ext = EXT_BY_MIME[baseContentType] ?? baseContentType.split('/')[1] ?? 'bin';
      const storedFilename =
        (asset.metadata as { filename?: string } | null)?.filename ?? `media-${asset.id}.${ext}`;
      // Always force the extension to match the MIME so a filename
      // mis-saved as "voice.webm" with content-type "audio/ogg" still
      // arrives at Meta as voice.ogg.
      const filenameWithExt = storedFilename.replace(/\.[^.]+$/, '') + `.${ext}`;
      let metaMediaId: string | null = null;
      try {
        const fd = new FormData();
        const blob = new Blob([fileBytes], { type: baseContentType });
        fd.set('file', blob, filenameWithExt);
        fd.set('messaging_product', 'whatsapp');
        fd.set('type', baseContentType);
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
        req.log.info(
          { status: upRes.status, bodySnippet: upText.slice(0, 400) },
          '[AL-VOICE-DEBUG] Meta /media response',
        );
        if (!upRes.ok) {
          return {
            data: { ok: false, metaMessageId: null, errorMessage: `Meta media upload ${upRes.status}: ${upText.slice(0, 200)}` },
          };
        }
        const upJson = JSON.parse(upText) as { id?: string };
        metaMediaId = upJson.id ?? null;
      } catch (err) {
        req.log.warn({ err }, '[AL-VOICE-DEBUG] Meta /media threw');
        return {
          data: {
            ok: false,
            metaMessageId: null,
            errorMessage: err instanceof Error ? err.message : 'Meta upload failed',
          },
        };
      }
      if (!metaMediaId) {
        req.log.warn({}, '[AL-VOICE-DEBUG] Meta returned no media id');
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

      // Audio messages don't accept a caption field at Meta's API —
      // sending one yields error (#100). Drop the caption silently
      // for audio; image / video / document keep it.
      const mediaType = effectiveMediaType;
      const allowsCaption = mediaType !== 'audio';
      // When we degraded an audio note to a document, include the
      // filename so the WhatsApp bubble shows "voice-note.webm" instead
      // of a generic "file" label. Documents need it anyway.
      const isDegradedVoice =
        req.body.mediaType === 'audio' && effectiveMediaType === 'document';
      const payload = {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to,
        type: mediaType,
        [mediaType]: {
          id: metaMediaId,
          ...(allowsCaption && req.body.caption ? { caption: req.body.caption } : {}),
          ...(mediaType === 'document'
            ? { filename: isDegradedVoice ? `voice-note.${ext}` : filenameWithExt }
            : {}),
        },
      };
      let sendBody = '';
      let sendStatus = 0;
      req.log.info(
        { payloadSnippet: JSON.stringify(payload).slice(0, 400) },
        '[AL-VOICE-DEBUG] sending Meta /messages',
      );
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
        req.log.warn({ err }, '[AL-VOICE-DEBUG] Meta /messages threw');
        return {
          data: {
            ok: false,
            metaMessageId: null,
            errorMessage: err instanceof Error ? err.message : 'send failed',
          },
        };
      }
      req.log.info(
        { status: sendStatus, bodySnippet: sendBody.slice(0, 400) },
        '[AL-VOICE-DEBUG] Meta /messages response',
      );

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
              // Parallel array with the sender's WhatsApp profile name +
              // wa_id. Use to populate Contact.whatsappName etc.
              contacts?: {
                wa_id?: string;
                profile?: { name?: string };
              }[];
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

      // Extract the operator-visible body text from any Meta inbound
      // payload shape. WhatsApp delivers replies in different fields
      // depending on the source:
      //   - type=text                → text.body
      //   - type=button              → button.text (template Quick Reply)
      //   - type=interactive         → interactive.button_reply.title  OR
      //                                interactive.list_reply.title
      //   - type=image/video/audio/  → caption (if any) or "[image]" etc.
      //     document/sticker
      //   - everything else          → "[<type>]" placeholder so the
      //                                inbox never shows a bare empty cell.
      function extractInboundBody(m: Record<string, unknown>): string {
        const type = (m.type as string | undefined) ?? '';
        if (type === 'text') {
          return (m as { text?: { body?: string } }).text?.body ?? '';
        }
        if (type === 'button') {
          return (m as { button?: { text?: string; payload?: string } }).button?.text
            ?? (m as { button?: { payload?: string } }).button?.payload
            ?? '[button]';
        }
        if (type === 'interactive') {
          const i = (m as { interactive?: { button_reply?: { title?: string }; list_reply?: { title?: string } } }).interactive;
          return i?.button_reply?.title ?? i?.list_reply?.title ?? '[interactive]';
        }
        // Media types: prefer the caption if the customer attached one,
        // otherwise placeholder so the thread preview is meaningful.
        const caption = (m as { [k: string]: { caption?: string } | undefined })[type]?.caption;
        if (caption) return caption;
        if (['image', 'video', 'audio', 'document', 'sticker', 'voice', 'location', 'contacts'].includes(type)) {
          return `[${type}]`;
        }
        return type ? `[${type}]` : '';
      }

      const persisted: { from: string; type: string; bodyText: string | null; metaId: string | null }[] = [];
      for (const entry of body.entry ?? []) {
        for (const change of entry.changes ?? []) {
          const value = change.value;
          if (!value || !value.messages) continue;
          for (const m of value.messages) {
            const bodyText = extractInboundBody(m as unknown as Record<string, unknown>);
            persisted.push({
              from: m.from ?? '',
              type: m.type ?? 'unknown',
              bodyText: bodyText || null,
              metaId: m.id ?? null,
            });

            // Every inbound creates a Contact row if we don't already
            // have one for this phone. Keeps /contacts in sync with
            // the inbox automatically so the operator never has to
            // copy/paste numbers. The contact's `profile.name` from
            // Meta (if present in the contacts[] block) is used as the
            // initial display name.
            const STOP_RE = /^\s*(stop|unsubscribe|quit|cancel|end|opt\s*out|alto|para|arr[eê]ter|stopper|اوقف|إيقاف)\s*\.?\s*$/i;
            if (m.from) {
              const phoneE164 = `+${m.from}`;
              const isStop = STOP_RE.test(bodyText);
              // Meta inbound payloads include a parallel contacts[] array
              // with profile.name and wa_id matching the message's from.
              const inboundContact = (value.contacts ?? []).find(
                (c) => c.wa_id === m.from,
              );
              const profileName = inboundContact?.profile?.name ?? null;
              req.log.info(
                {
                  from: m.from,
                  hasContactsBlock: Array.isArray(value.contacts),
                  contactsCount: (value.contacts ?? []).length,
                  matchedWaId: !!inboundContact,
                  profileName,
                },
                '[whatsapp] inbound profile extraction',
              );
              await withRlsBypass(async (tx) => {
                await tx.contact.upsert({
                  where: {
                    organizationId_phoneE164: {
                      organizationId: channel.organizationId,
                      phoneE164,
                    },
                  },
                  create: {
                    organizationId: channel.organizationId,
                    phoneE164,
                    // On first sight, seed displayName from the Meta
                    // profile too so operators see SOMETHING immediately
                    // rather than just a phone number. They can rename
                    // later; subsequent inbounds only refresh
                    // whatsappName.
                    displayName: profileName,
                    whatsappName: profileName,
                    optedOutAt: isStop ? new Date() : null,
                    lastInboundAt: new Date(),
                    source: 'inbox_auto',
                  },
                  update: {
                    // Always keep Meta's profile name fresh.
                    ...(profileName ? { whatsappName: profileName } : {}),
                    lastInboundAt: new Date(),
                    ...(isStop ? { optedOutAt: new Date() } : {}),
                  },
                });
              }).catch((err) =>
                req.log.error({ err }, '[whatsapp] contact upsert failed'),
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
                    body: bodyText || null,
                    rawPayload: m as never,
                  },
                });
                return;
              }
              // Meta's inbound webhook includes a parallel contacts[]
              // block with the sender's profile.name + wa_id. Keep our
              // local mirror fresh so the inbox shows the WhatsApp
              // display name alongside the operator's rename.
              const inboundContact = (value.contacts ?? []).find(
                (c) => c.wa_id === m.from,
              );
              const waProfileName = inboundContact?.profile?.name ?? null;
              const preview = (bodyText || `[${m.type ?? 'media'}]`).slice(0, 200);
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
                  customerWhatsappName: waProfileName,
                  status: 'open',
                  lastMessageAt: new Date(),
                  lastMessagePreview: preview,
                  inboundCount: 1,
                  outboundCount: 0,
                  searchText: bodyText || '',
                },
                update: {
                  lastMessageAt: new Date(),
                  lastMessagePreview: preview,
                  inboundCount: { increment: 1 },
                  // Reopen if previously resolved.
                  status: 'open',
                  // Always refresh the WhatsApp profile name from Meta —
                  // never overwrite customer_name (operator's rename).
                  ...(waProfileName ? { customerWhatsappName: waProfileName } : {}),
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
              if (bodyText) {
                await tx.$executeRawUnsafe(
                  `UPDATE whatsapp_threads
                     SET search_text = LEFT(COALESCE(search_text,'') || ' ' || $1, 16000)
                     WHERE id = $2::uuid`,
                  bodyText,
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
                  body: bodyText || null,
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
  log: { error: (...args: unknown[]) => void; warn: (...args: unknown[]) => void; info: (...args: unknown[]) => void };
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
      // Don't reply once the bot has escalated to a human — the thread
      // is waiting for an operator to step in. They'll un-escalate by
      // resolving or re-opening the chat from the inbox.
      if (thread.status === 'escalated') return null;

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

      return { history: history.reverse(), data, channel: ch, threadId: thread.id };
    });
    if (!ctx) continue;

    // Escalation short-circuit: if the bot's most recent reply asked
    // whether the customer wants to talk to a human, and this inbound
    // is an affirmative answer, skip the LLM call entirely. Send a
    // confirmation, flag the thread as 'pending' (escalated state),
    // post an internal "Bot escalated" note so the analytics signal
    // fires, and leave the rest to the operator.
    const lastBotReply =
      [...ctx.history].reverse().find((h) => h.direction === 'outbound')?.body ?? '';
    const HANDOFF_OFFER_RE =
      /(connect|transfer|escalat|hand[\s-]?off|speak|talk).{0,40}(human|specialist|agent|representative|teammate|operator|colleague)/i;
    const AFFIRMATIVE_RE =
      /^\s*(yes|yep|yeah|yup|sure|please|ok(ay)?|y|si|sí|oui|نعم|إيه|aywa|ايوة|na'?am|طيب|تمام|of course|please do|connect me|go ahead|do it|sounds good)[\s.!,?]*\s*$/i;
    const isHandoffConfirm =
      HANDOFF_OFFER_RE.test(lastBotReply) && AFFIRMATIVE_RE.test(m.bodyText!);

    if (isHandoffConfirm) {
      // Prefer the org's configured escalation fallback so it carries
      // their tone of voice; default to a polite generic line.
      const escalation = (ctx.data.config?.escalationRules ?? {}) as { fallback?: unknown };
      const confirmText =
        typeof escalation.fallback === 'string' && escalation.fallback.trim().length > 0
          ? escalation.fallback.trim()
          : "Thanks — we'll connect you with a human teammate shortly.";
      try {
        const payload = {
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: m.from,
          type: 'text',
          text: { preview_url: false, body: confirmText },
        };
        const res = await fetch(
          `https://graph.facebook.com/v20.0/${encodeURIComponent(ctx.channel.phoneNumberId!)}/messages`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${ctx.channel.accessToken!}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(10_000),
          },
        );
        const text = await res.text();
        let metaMessageId: string | null = null;
        try {
          metaMessageId = (JSON.parse(text) as { messages?: { id?: string }[] }).messages?.[0]?.id ?? null;
        } catch {
          /* ignore */
        }
        await withRlsBypass(async (tx) => {
          await tx.whatsAppMessage.create({
            data: {
              threadId: ctx.threadId,
              organizationId: args.organizationId,
              direction: 'outbound',
              metaMessageId,
              toNumber: m.from,
              messageType: 'text',
              body: confirmText,
              rawPayload: { sentBy: 'bot', reason: 'handoff_confirm' } as never,
            },
          });
          await tx.whatsAppThread.update({
            where: { id: ctx.threadId },
            data: {
              status: 'pending',
              lastMessageAt: new Date(),
              lastMessagePreview: confirmText.slice(0, 200),
              outboundCount: { increment: 1 },
            },
          });
          await tx.whatsAppNote.create({
            data: {
              threadId: ctx.threadId,
              organizationId: args.organizationId,
              authorUserId: null,
              body: '🤖 → 👤 Bot escalated to human (customer confirmed handoff).',
            },
          });
        });
      } catch (err) {
        args.log.warn({ err }, '[whatsapp] handoff-confirm send failed');
      }
      continue;
    }

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
    const rawReply = result?.text ?? null;
    const channel = ctx.channel;
    if (!rawReply) continue;

    // Image protocol: the LLM ends its reply with [IMAGE: <SKU>] when
    // a customer asks about a specific product that has an image in
    // the catalog. Parse + strip the marker, then look up the SKU in
    // the gathered data to find the storage key. We send the image
    // as a SEPARATE WhatsApp message AFTER the text reply.
    const imageMarkerRe = /\[IMAGE:\s*([^\]\s]+)\s*\]/i;
    const imageMatch = imageMarkerRe.exec(rawReply);

    // Handoff protocol: bare [HANDOFF] marker means the customer asked
    // for a human teammate. Strip it, flip the thread to "escalated"
    // (sidebar Inbox badge + colored row in the list), and post an
    // internal note so the operator can see why.
    const handoffMarkerRe = /\[HANDOFF\]/i;
    const wantsHandoff = handoffMarkerRe.test(rawReply);

    // Booking protocol: [BOOKING: { ... json ... }] terminates a
    // booking conversation. We parse the JSON, look up the operator's
    // configured form to label each field, persist a Booking row,
    // strip the marker from the visible reply.
    const bookingMarkerRe = /\[BOOKING:\s*(\{[\s\S]*?\})\s*\]/i;
    const bookingMatch = bookingMarkerRe.exec(rawReply);

    let reply = rawReply
      .replace(imageMarkerRe, '')
      .replace(handoffMarkerRe, '')
      .replace(bookingMarkerRe, '')
      .trim();
    const imageProduct = imageMatch
      ? ctx.data.products.find(
          (p) => p.sku.toLowerCase() === imageMatch[1]!.toLowerCase(),
        )
      : null;
    const imageStorageKey =
      imageProduct?.primaryImageStorageKey && imageProduct.primaryImageStorageKey.length > 0
        ? imageProduct.primaryImageStorageKey
        : null;
    // If the LLM emitted ONLY markers (no visible text), fall back to a
    // short acknowledgement so the customer sees something — and so the
    // handoff / booking side effects still run.
    if (!reply) {
      if (wantsHandoff) {
        reply = "Sure — connecting you with a teammate now. They'll pick up here shortly.";
      } else if (bookingMatch) {
        reply = 'All set — your request has been captured. A teammate will follow up shortly.';
      }
    }
    if (!reply && !imageStorageKey) continue;

    // Send via Meta directly (we're in the worker-equivalent path; reusing
    // the in-process token bucket from the /send route is fine — both
    // share the same Redis key).
    try {
      const payload = {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: m.from,
        type: 'text',
        text: { preview_url: false, body: reply || 'Here:' },
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

      // Follow-up: send the product's primary image as a separate
      // media message. Two-step: PUT bytes from Wasabi → POST to
      // Meta /media → POST /messages of type image with the
      // returned media_id. Failures here log but DON'T cause the
      // whole reply path to error — the text reply already landed.
      if (imageStorageKey && imageProduct) {
        try {
          const { presignGetUrl, publicUrlFor } = await import('../../lib/storage.js');
          const fileUrl =
            publicUrlFor(imageStorageKey) ?? (await presignGetUrl(imageStorageKey));
          const fr = await fetch(fileUrl, { signal: AbortSignal.timeout(15_000) });
          if (fr.ok) {
            const ab = await fr.arrayBuffer();
            const fileBytes = Buffer.from(ab);
            const fd = new FormData();
            fd.append('messaging_product', 'whatsapp');
            fd.append(
              'file',
              new Blob([new Uint8Array(fileBytes)], { type: 'image/jpeg' }),
              `${imageProduct.sku}.jpg`,
            );
            const mediaRes = await fetch(
              `https://graph.facebook.com/v20.0/${encodeURIComponent(channel.phoneNumberId!)}/media`,
              {
                method: 'POST',
                headers: { Authorization: `Bearer ${channel.accessToken!}` },
                body: fd,
                signal: AbortSignal.timeout(20_000),
              },
            );
            const mediaJson = (await mediaRes.json().catch(() => ({}))) as { id?: string };
            if (mediaRes.ok && mediaJson.id) {
              const imgPayload = {
                messaging_product: 'whatsapp',
                recipient_type: 'individual',
                to: m.from,
                type: 'image',
                image: {
                  id: mediaJson.id,
                  caption: imageProduct.name.slice(0, 1024),
                },
              };
              const imgRes = await fetch(
                `https://graph.facebook.com/v20.0/${encodeURIComponent(channel.phoneNumberId!)}/messages`,
                {
                  method: 'POST',
                  headers: {
                    Authorization: `Bearer ${channel.accessToken!}`,
                    'Content-Type': 'application/json',
                  },
                  body: JSON.stringify(imgPayload),
                  signal: AbortSignal.timeout(10_000),
                },
              );
              if (imgRes.ok) {
                const imgJson = (await imgRes.json().catch(() => ({}))) as {
                  messages?: { id?: string }[];
                };
                await withRlsBypass(async (tx) => {
                  await tx.whatsAppMessage.create({
                    data: {
                      threadId: ctx.threadId,
                      organizationId: args.organizationId,
                      direction: 'outbound',
                      metaMessageId: imgJson.messages?.[0]?.id ?? null,
                      toNumber: m.from,
                      messageType: 'image',
                      body: `[image] ${imageProduct.name}`,
                      rawPayload: { sentBy: 'bot', sku: imageProduct.sku } as never,
                    },
                  });
                  await tx.whatsAppThread.update({
                    where: { id: ctx.threadId },
                    data: {
                      lastMessageAt: new Date(),
                      lastMessagePreview: `[image] ${imageProduct.name}`.slice(0, 200),
                      outboundCount: { increment: 1 },
                    },
                  });
                });
              } else {
                args.log.warn(
                  { status: imgRes.status },
                  '[whatsapp] bot image send (final) failed',
                );
              }
            } else {
              args.log.warn(
                { status: mediaRes.status, mediaJson },
                '[whatsapp] bot image upload to Meta failed',
              );
            }
          } else {
            args.log.warn(
              { status: fr.status, key: imageStorageKey },
              '[whatsapp] bot image fetch from Wasabi failed',
            );
          }
        } catch (err) {
          args.log.warn({ err }, '[whatsapp] bot image attach failed');
        }
      }
      // Persist outbound + bump thread.
      // wantsHandoff flips the thread to 'escalated' so the inbox can
      // surface it (colored row + sidebar badge). booking marker, if
      // valid, persists a Booking row that operators see on /bookings.
      let parsedBooking: Record<string, string> | null = null;
      if (bookingMatch) {
        try {
          const obj = JSON.parse(bookingMatch[1]!) as Record<string, unknown>;
          parsedBooking = {};
          for (const [k, v] of Object.entries(obj)) {
            parsedBooking[k] = v == null ? '' : String(v);
          }
        } catch (err) {
          args.log.warn({ err, raw: bookingMatch[1]?.slice(0, 300) }, '[whatsapp] booking marker JSON invalid');
          parsedBooking = null;
        }
      }

      // Dedupe: don't create a second booking for this thread if one
      // was captured in the last 30 minutes. Both the LLM marker and
      // the fallback extractor can fire for the same conversation;
      // without this guard a follow-up "thanks" would create a
      // duplicate row from the extractor.
      const recentBooking = await withRlsBypass(async (tx) =>
        tx.booking.findFirst({
          where: {
            organizationId: args.organizationId,
            threadId: ctx.threadId,
            createdAt: { gte: new Date(Date.now() - 30 * 60 * 1000) },
          },
          select: { id: true },
        }),
      );

      // Fallback: GPT-4o-mini sometimes finishes the booking conversation
      // without ever emitting the [BOOKING:{...}] marker. Run a tiny
      // JSON-mode extraction call to recover. Gate on cheap signals so
      // we don't fire it for unrelated messages.
      if (
        !parsedBooking &&
        !recentBooking &&
        ctx.data.bookingForm?.enabled &&
        ctx.data.bookingForm.fields.length > 0
      ) {
        const recentAssistant = ctx.history
          .filter((h) => h.direction === 'outbound')
          .slice(-3)
          .map((h) => (h.body ?? '').toLowerCase())
          .join(' ');
        const ASSISTANT_BOOKING_SIGNAL = /(book|schedul|appointment|consult|reserv|confirm|set up|will (?:be|finalize)|set you up)/i;
        const USER_AFFIRMATIVE = /^\s*(yes|yep|yeah|yup|sure|please|ok(ay)?|y|confirm(ed)?|do it|go ahead|sounds good|let'?s do it|book it|that works|perfect)[\s.!,?]*\s*$/i;
        const looksLikeBookingFlow =
          ASSISTANT_BOOKING_SIGNAL.test(recentAssistant) ||
          ASSISTANT_BOOKING_SIGNAL.test(reply.toLowerCase()) ||
          USER_AFFIRMATIVE.test(m.bodyText!);

        if (looksLikeBookingFlow) {
          const { extractBooking } = await import('../../lib/bot-engine.js');
          const ex = await extractBooking({
            organizationId: args.organizationId,
            bookingForm: ctx.data.bookingForm,
            history: ctx.history.map((h) => ({
              role: h.direction === 'outbound' ? ('assistant' as const) : ('user' as const),
              content: h.body ?? '',
            })),
            latestUserMessage: m.bodyText!,
          }).catch((err) => {
            args.log.warn({ err }, '[whatsapp] booking extractor failed');
            return null;
          });
          if (ex?.complete && ex.values) {
            // Make sure every REQUIRED field has a non-empty value before
            // we persist — otherwise an over-eager extractor could
            // create half-filled bookings.
            const missing = ctx.data.bookingForm.fields.filter(
              (f) => f.required && !(ex.values[f.key] && String(ex.values[f.key]).trim()),
            );
            if (missing.length === 0) {
              parsedBooking = {};
              for (const f of ctx.data.bookingForm.fields) {
                parsedBooking[f.key] = (ex.values[f.key] ?? '').toString();
              }
              args.log.info(
                { fieldCount: ctx.data.bookingForm.fields.length },
                '[whatsapp] booking captured via fallback extractor',
              );
            } else {
              args.log.info(
                { missing: missing.map((f) => f.key) },
                '[whatsapp] booking extractor flagged complete but required fields missing',
              );
            }
          }
        }
      }

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
            ...(wantsHandoff ? { status: 'escalated' as never } : {}),
          },
        });

        if (wantsHandoff) {
          await tx.whatsAppNote.create({
            data: {
              threadId: thread.id,
              organizationId: args.organizationId,
              authorUserId: null,
              body: '🤖 → 👤 Bot flagged this chat for human support (customer asked for an agent).',
            },
          });
        }

        if (parsedBooking && ctx.data.bookingForm && !recentBooking) {
          const fields = ctx.data.bookingForm.fields.map((f) => ({
            key: f.key,
            label: f.label,
            type: f.type,
            required: f.required,
            value: parsedBooking![f.key] ?? null,
          }));
          const booking = await tx.booking.create({
            data: {
              organizationId: args.organizationId,
              threadId: thread.id,
              customerPhone: m.from,
              customerName: thread.customerName ?? thread.customerWhatsappName ?? null,
              fields: fields as never,
              status: 'new',
            },
          });
          await tx.whatsAppNote.create({
            data: {
              threadId: thread.id,
              organizationId: args.organizationId,
              authorUserId: null,
              body: `📅 Booking captured (id ${booking.id.slice(0, 8)}…). See /bookings.`,
            },
          });
          // Flag for operator review unless an explicit handoff already set it.
          if (!wantsHandoff) {
            await tx.whatsAppThread.update({
              where: { id: thread.id },
              data: { status: 'pending' as never },
            });
          }
          // Webhook for downstream automations.
          void (await import('../../lib/webhooks.js')).emitWebhookEvent({
            organizationId: args.organizationId,
            eventKind: 'booking_created',
            payload: { id: booking.id, customerPhone: m.from, fields },
          });
        }
      });
    } catch (err) {
      args.log.warn({ err }, '[whatsapp] bot send threw');
    }
  }
}
