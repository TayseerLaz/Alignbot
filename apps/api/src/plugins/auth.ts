import { ApiErrorCode, type OrgRole } from '@aligned/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';

import { forbidden, unauthorized } from '../lib/errors.js';
import { verifyAccessToken } from '../lib/jwt.js';
import { consumeSseNonce } from '../lib/sse-nonce.js';

const ROLE_RANK: Record<OrgRole, number> = { viewer: 1, editor: 2, admin: 3 };

declare module 'fastify' {
  interface FastifyInstance {
    /** Resolves req.auth from the bearer token; throws 401 if missing/invalid. */
    requireAuth: (req: FastifyRequest) => Promise<void>;
    /** Higher-order guard: ensure caller has at least the specified role in their active org. */
    requireRole: (minRole: OrgRole) => (req: FastifyRequest) => Promise<void>;
    /** Restrict to ALIGNED super-admins only. */
    requireAlignedAdmin: (req: FastifyRequest) => Promise<void>;
  }
}

function bearerFrom(req: FastifyRequest): string | null {
  const header = req.headers.authorization;
  if (header) {
    const [scheme, token] = header.split(' ');
    if (scheme?.toLowerCase() === 'bearer' && token) return token;
  }
  return null;
}

function sseNonceFrom(req: FastifyRequest): string | null {
  const q = req.query as { nonce?: string } | undefined;
  if (q?.nonce && typeof q.nonce === 'string') return q.nonce;
  return null;
}

export default fp(async function authPlugin(app: FastifyInstance) {
  app.decorate('requireAuth', async (req: FastifyRequest) => {
    if (req.auth) return;
    const token = bearerFrom(req);
    if (token) {
      const claims = await verifyAccessToken(token);
      req.auth = {
        userId: claims.sub,
        organizationId: claims.org,
        role: claims.role,
        isAlignedAdmin: claims.aa,
        sessionId: claims.sid,
      };
      return;
    }
    // EventSource (SSE) can't set Authorization headers, so it presents a
    // short-lived single-use nonce (issued via POST /auth/sse-nonce) on the
    // query string. The nonce is GETDEL'd from Redis so even a leaked URL
    // is worthless after the connection is established.
    const nonce = sseNonceFrom(req);
    if (nonce) {
      const claims = await consumeSseNonce(nonce);
      if (!claims) throw unauthorized(ApiErrorCode.AUTH_REQUIRED);
      req.auth = claims;
      return;
    }
    throw unauthorized(ApiErrorCode.AUTH_REQUIRED);
  });

  app.decorate('requireRole', (minRole: OrgRole) => async (req: FastifyRequest) => {
    await app.requireAuth(req);
    const have = ROLE_RANK[req.auth!.role];
    const need = ROLE_RANK[minRole];
    if (have < need) {
      throw forbidden(ApiErrorCode.ROLE_INSUFFICIENT, `Requires ${minRole} role or higher.`);
    }
  });

  app.decorate('requireAlignedAdmin', async (req: FastifyRequest) => {
    await app.requireAuth(req);
    if (!req.auth!.isAlignedAdmin) {
      throw forbidden(ApiErrorCode.FORBIDDEN, 'ALIGNED admin role required.');
    }
  });
});
