// WhatsApp Cloud API channel — Phase 1.5.
// One channel per organisation. Stores the Meta-side identifiers the
// platform needs to verify credentials, receive webhooks, and send
// templates on behalf of the tenant. Secrets are stored at rest but
// always returned masked in API responses.
import { z } from 'zod';

import { uuidSchema } from './common.js';

// Mask = "ak_live_****1234" style. Returned by GET, never the full secret.
const maskedSecretSchema = z.string().nullable();

export const whatsappChannelSchema = z.object({
  id: uuidSchema,
  wabaId: z.string().nullable(),
  phoneNumberId: z.string().nullable(),
  displayPhoneNumber: z.string().nullable(),
  appId: z.string().nullable(),
  // Booleans + masked previews — full secrets are never sent over the wire.
  hasAccessToken: z.boolean(),
  hasAppSecret: z.boolean(),
  accessTokenMasked: maskedSecretSchema,
  appSecretMasked: maskedSecretSchema,
  // The platform-generated token clients paste into Meta's webhook config.
  webhookVerifyToken: z.string(),
  // The full URL Meta should POST to — computed server-side using API_PUBLIC_URL.
  webhookCallbackUrl: z.string(),
  greetingMessage: z.string().nullable(),
  businessName: z.string().nullable(),
  businessAbout: z.string().nullable(),
  businessAddress: z.string().nullable(),
  businessEmail: z.string().nullable(),
  isActive: z.boolean(),
  lastVerifiedAt: z.string().datetime().nullable(),
  lastVerifyStatus: z.string().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type WhatsAppChannelDto = z.infer<typeof whatsappChannelSchema>;

// Upsert body — every field optional so the page can save partial progress.
// Empty strings are treated as "clear this field"; omitted = "leave alone".
export const upsertWhatsappChannelBodySchema = z.object({
  wabaId: z.string().trim().max(64).optional().nullable(),
  phoneNumberId: z.string().trim().max(64).optional().nullable(),
  displayPhoneNumber: z
    .string()
    .trim()
    .regex(/^\+?[0-9 ()-]{6,20}$/, 'Looks invalid — use E.164, e.g. +14155551234.')
    .optional()
    .nullable(),
  appId: z.string().trim().max(64).optional().nullable(),
  // Secrets: omit to leave alone, send empty string to clear, send any other
  // value to overwrite. The route reads + masks before responding.
  accessToken: z.string().trim().max(2048).optional(),
  appSecret: z.string().trim().max(512).optional(),
  greetingMessage: z.string().trim().max(2000).optional().nullable(),
  businessName: z.string().trim().max(200).optional().nullable(),
  businessAbout: z.string().trim().max(500).optional().nullable(),
  businessAddress: z.string().trim().max(500).optional().nullable(),
  businessEmail: z.string().trim().email().optional().nullable().or(z.literal('')),
  isActive: z.boolean().optional(),
});
export type UpsertWhatsAppChannelBody = z.infer<typeof upsertWhatsappChannelBodySchema>;

// Result of a verification round-trip with Meta.
export const whatsappVerifyResultSchema = z.object({
  ok: z.boolean(),
  status: z.string(), // 'success' | 'token_invalid' | 'phone_not_found' | 'network_error' | ...
  // When ok=true, Meta-confirmed details we read back.
  verifiedDisplayPhoneNumber: z.string().nullable(),
  verifiedQualityRating: z.string().nullable(),
  verifiedNameStatus: z.string().nullable(),
  errorMessage: z.string().nullable(),
  rawSample: z.string().nullable(), // ≤500 chars of upstream body for debugging
});
export type WhatsAppVerifyResult = z.infer<typeof whatsappVerifyResultSchema>;

// Test-send a `hello_world` template to a number the operator types.
export const whatsappTestSendBodySchema = z.object({
  to: z
    .string()
    .trim()
    .regex(/^\+?[0-9]{6,16}$/, 'Use E.164 digits only, e.g. +14155551234.'),
});
export const whatsappTestSendResultSchema = z.object({
  ok: z.boolean(),
  metaMessageId: z.string().nullable(),
  errorMessage: z.string().nullable(),
});
export type WhatsAppTestSendBody = z.infer<typeof whatsappTestSendBodySchema>;
export type WhatsAppTestSendResult = z.infer<typeof whatsappTestSendResultSchema>;

// Inbound message row for the audit table.
export const whatsappMessageSchema = z.object({
  id: uuidSchema,
  direction: z.enum(['inbound', 'outbound']),
  metaMessageId: z.string().nullable(),
  fromNumber: z.string().nullable(),
  toNumber: z.string().nullable(),
  messageType: z.string().nullable(),
  body: z.string().nullable(),
  receivedAt: z.string().datetime(),
});
export type WhatsAppMessageDto = z.infer<typeof whatsappMessageSchema>;
