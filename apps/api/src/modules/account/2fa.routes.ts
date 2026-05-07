// Phase 5.5 — TOTP 2FA self-service endpoints.
//
// Flow:
//   1. POST /account/2fa/setup → server generates a secret, stores it in
//      Redis under a short-lived key tied to userId, returns the
//      `otpauth://` URI for QR display in the UI. NOT persisted to the
//      user row yet — that happens on enable, after the user has
//      successfully scanned + entered a code.
//   2. POST /account/2fa/enable {code} → verify the code against the
//      pending secret. On success: persist secret to user.totpSecret,
//      set totpEnabled=true, generate 10 recovery codes, return the
//      plaintext codes ONCE so the user can save them.
//   3. POST /account/2fa/disable {password|code} → either path-of-truth
//      works. Clears all 2FA fields.
//   4. POST /account/2fa/regenerate-recovery → must supply a current
//      TOTP code; returns 10 new codes (old ones invalidated).
import { ApiErrorCode, itemEnvelopeSchema, successSchema } from '@aligned/shared';
import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { recordAudit } from '../../lib/audit.js';
import { verifyPassword } from '../../lib/crypto.js';
import { withRlsBypass } from '../../lib/db.js';
import { badRequest, notFound, unauthorized } from '../../lib/errors.js';
import { getRedis } from '../../lib/redis.js';
import {
  buildOtpAuthUri,
  generateRecoveryCodes,
  generateTotpSecret,
  verifyTotpCode,
} from '../../lib/totp.js';

const PENDING_KEY = (userId: string) => `2fa:pending:${userId}`;
const PENDING_TTL = 600; // 10 minutes to scan + verify

function hashRecovery(code: string): string {
  return createHash('sha256').update(code.toUpperCase()).digest('hex');
}

export default async function twoFactorRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  // ---------- GET /account/2fa/status --------------------------------------
  r.get(
    '/account/2fa/status',
    {
      schema: {
        tags: ['account'],
        summary: 'Whether 2FA is enabled + recovery codes remaining.',
        response: {
          200: itemEnvelopeSchema(
            z.object({
              enabled: z.boolean(),
              enrolledAt: z.string().datetime().nullable(),
              recoveryCodesRemaining: z.number().int().nonnegative(),
            }),
          ),
        },
      },
      preHandler: [app.requireAuth],
    },
    async (req) => {
      const userId = req.auth!.userId;
      const user = await withRlsBypass((tx) =>
        tx.user.findUnique({
          where: { id: userId },
          select: { totpEnabled: true, totpEnrolledAt: true, recoveryCodesHashed: true },
        }),
      );
      if (!user) throw notFound('User not found.');
      return {
        data: {
          enabled: user.totpEnabled,
          enrolledAt: user.totpEnrolledAt?.toISOString() ?? null,
          recoveryCodesRemaining: user.recoveryCodesHashed.length,
        },
      };
    },
  );

  // ---------- POST /account/2fa/setup --------------------------------------
  r.post(
    '/account/2fa/setup',
    {
      schema: {
        tags: ['account'],
        summary: 'Begin 2FA enrolment — returns an otpauth URI for QR display.',
        response: {
          200: itemEnvelopeSchema(
            z.object({
              secret: z.string(),
              otpauthUri: z.string(),
            }),
          ),
        },
      },
      preHandler: [app.requireAuth],
    },
    async (req) => {
      const userId = req.auth!.userId;
      const user = await withRlsBypass((tx) =>
        tx.user.findUnique({ where: { id: userId }, select: { email: true, totpEnabled: true } }),
      );
      if (!user) throw notFound('User not found.');
      if (user.totpEnabled) {
        throw badRequest(ApiErrorCode.VALIDATION_ERROR, '2FA is already enabled. Disable first to re-enrol.');
      }
      const secret = generateTotpSecret();
      const redis = getRedis();
      await redis.set(PENDING_KEY(userId), secret, 'EX', PENDING_TTL);
      const otpauthUri = buildOtpAuthUri({
        secretBase32: secret,
        accountName: user.email,
        issuer: 'ALIGNED',
      });
      return { data: { secret, otpauthUri } };
    },
  );

  // ---------- POST /account/2fa/enable -------------------------------------
  r.post(
    '/account/2fa/enable',
    {
      schema: {
        tags: ['account'],
        summary: 'Confirm the TOTP code to enable 2FA. Returns 10 recovery codes ONCE.',
        body: z.object({ code: z.string().trim().regex(/^\d{6}$/) }),
        response: {
          200: itemEnvelopeSchema(
            z.object({
              recoveryCodes: z.array(z.string()),
            }),
          ),
        },
      },
      preHandler: [app.requireAuth],
    },
    async (req) => {
      const userId = req.auth!.userId;
      const redis = getRedis();
      const pending = await redis.get(PENDING_KEY(userId));
      if (!pending) {
        throw badRequest(
          ApiErrorCode.VALIDATION_ERROR,
          'Setup expired or never started. Call /account/2fa/setup again.',
        );
      }
      if (!verifyTotpCode(pending, req.body.code)) {
        throw unauthorized(ApiErrorCode.TOTP_INVALID, 'Invalid code. Try again.');
      }
      const recoveryCodes = generateRecoveryCodes();
      const recoveryCodesHashed = recoveryCodes.map(hashRecovery);
      await withRlsBypass((tx) =>
        tx.user.update({
          where: { id: userId },
          data: {
            totpEnabled: true,
            totpSecret: pending,
            totpEnrolledAt: new Date(),
            recoveryCodesHashed,
          },
        }),
      );
      await redis.del(PENDING_KEY(userId));
      await recordAudit({
        action: 'password_changed', // closest existing action; new enum value would need migration
        actorUserId: userId,
        metadata: { event: '2fa_enabled' },
      });
      return { data: { recoveryCodes } };
    },
  );

  // ---------- POST /account/2fa/disable ------------------------------------
  r.post(
    '/account/2fa/disable',
    {
      schema: {
        tags: ['account'],
        summary: 'Disable 2FA. Requires either a current TOTP code or the account password.',
        body: z.object({
          code: z.string().trim().optional(),
          password: z.string().optional(),
        }),
        response: { 200: successSchema },
      },
      preHandler: [app.requireAuth],
    },
    async (req) => {
      const userId = req.auth!.userId;
      const user = await withRlsBypass((tx) =>
        tx.user.findUnique({ where: { id: userId } }),
      );
      if (!user || !user.totpEnabled || !user.totpSecret) {
        throw badRequest(ApiErrorCode.VALIDATION_ERROR, '2FA is not enabled.');
      }
      let ok = false;
      if (req.body.code && verifyTotpCode(user.totpSecret, req.body.code)) {
        ok = true;
      } else if (req.body.password && (await verifyPassword(req.body.password, user.passwordHash))) {
        ok = true;
      }
      if (!ok) {
        throw unauthorized(
          ApiErrorCode.TOTP_INVALID,
          'Provide a current 6-digit code or the account password.',
        );
      }
      await withRlsBypass((tx) =>
        tx.user.update({
          where: { id: userId },
          data: {
            totpEnabled: false,
            totpSecret: null,
            totpEnrolledAt: null,
            recoveryCodesHashed: [],
          },
        }),
      );
      await recordAudit({
        action: 'password_changed',
        actorUserId: userId,
        metadata: { event: '2fa_disabled' },
      });
      return { ok: true as const };
    },
  );

  // ---------- POST /account/2fa/regenerate-recovery ------------------------
  r.post(
    '/account/2fa/regenerate-recovery',
    {
      schema: {
        tags: ['account'],
        summary: 'Regenerate 10 recovery codes (old ones become invalid). Requires current code.',
        body: z.object({ code: z.string().trim().regex(/^\d{6}$/) }),
        response: { 200: itemEnvelopeSchema(z.object({ recoveryCodes: z.array(z.string()) })) },
      },
      preHandler: [app.requireAuth],
    },
    async (req) => {
      const userId = req.auth!.userId;
      const user = await withRlsBypass((tx) =>
        tx.user.findUnique({ where: { id: userId } }),
      );
      if (!user?.totpEnabled || !user.totpSecret) {
        throw badRequest(ApiErrorCode.VALIDATION_ERROR, '2FA is not enabled.');
      }
      if (!verifyTotpCode(user.totpSecret, req.body.code)) {
        throw unauthorized(ApiErrorCode.TOTP_INVALID, 'Invalid code.');
      }
      const recoveryCodes = generateRecoveryCodes();
      await withRlsBypass((tx) =>
        tx.user.update({
          where: { id: userId },
          data: { recoveryCodesHashed: recoveryCodes.map(hashRecovery) },
        }),
      );
      return { data: { recoveryCodes } };
    },
  );
}
