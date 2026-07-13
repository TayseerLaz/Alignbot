// "Sign in with Alinia" — verify an Alinia-issued RS256 id_token and establish
// a Hader session for the federated (Alinia-provisioned) tenant owner.
//
// Alinia is the identity provider; we verify the token against its published
// JWKS (asymmetric — never a shared secret) and link the user by
// aliniaSubject == token.sub. The token names the org it was minted for, so a
// session is bound to exactly that membership (no cross-tenant replay).
import { ApiErrorCode } from '@aligned/shared';
import type { OrgRole } from '@aligned/shared';
import { createRemoteJWKSet, jwtVerify } from 'jose';

import { recordAudit } from '../../lib/audit.js';
import { prisma } from '../../lib/db.js';
import { env } from '../../lib/env.js';
import { forbidden, unauthorized } from '../../lib/errors.js';
import { issueSession } from './auth.service.js';

interface RequestMeta {
  ip?: string | null;
  userAgent?: string | null;
}

// jose fetches + caches Alinia's JWKS and auto-refreshes on an unknown `kid`
// (key rotation), so we don't re-fetch per request.
const aliniaJwks = createRemoteJWKSet(new URL(env.ALINIA_JWKS_URL));

export async function loginWithAlinia(args: { token: string; meta: RequestMeta }) {
  let sub: string | undefined;
  let haderOrgId: string | undefined;
  try {
    const { payload } = await jwtVerify(args.token, aliniaJwks, {
      issuer: env.ALINIA_FEDERATION_ISSUER,
      audience: env.ALINIA_FEDERATION_AUDIENCE,
      algorithms: ['RS256'],
    });
    sub = payload.sub;
    haderOrgId = typeof payload.hader_org_id === 'string' ? payload.hader_org_id : undefined;
  } catch {
    throw unauthorized(ApiErrorCode.AUTH_TOKEN_INVALID, 'Invalid or expired Alinia sign-in token.');
  }
  if (!sub || !haderOrgId) {
    throw unauthorized(ApiErrorCode.AUTH_TOKEN_INVALID, 'Malformed Alinia sign-in token.');
  }

  const user = await prisma.user.findUnique({
    where: { aliniaSubject: sub },
    include: { memberships: { include: { organization: true } } },
  });
  if (!user) {
    throw unauthorized(
      ApiErrorCode.AUTH_INVALID_CREDENTIALS,
      'No Hader account is linked to this Alinia login.',
    );
  }
  // Disconnect / offboarding sets status='disabled' — blocks SSO AND any
  // break-glass password login, so cutting access is immediate.
  if (user.status === 'disabled') {
    throw unauthorized(ApiErrorCode.AUTH_USER_DISABLED, 'This account is disabled.');
  }

  const activeMemberships = user.memberships.filter(
    (m) => m.isActive && m.organization.status === 'active',
  );
  const chosen = activeMemberships.find((m) => m.organizationId === haderOrgId);
  if (!chosen) {
    throw forbidden(
      ApiErrorCode.AUTH_NO_MEMBERSHIP,
      'Your Alinia account is not linked to an active Hader tenant.',
    );
  }

  await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });

  const tokens = await issueSession({
    userId: user.id,
    organizationId: chosen.organizationId,
    role: chosen.role as OrgRole,
    isAlignedAdmin: user.isAlignedAdmin,
    meta: args.meta,
  });

  await recordAudit({
    action: 'login_succeeded',
    actorUserId: user.id,
    organizationId: chosen.organizationId,
    metadata: { via: 'alinia_sso' },
    ipAddress: args.meta.ip ?? undefined,
    userAgent: args.meta.userAgent ?? undefined,
  });

  return {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: tokens.expiresAt,
    user,
    organization: { ...chosen.organization, role: chosen.role as OrgRole },
    availableOrganizations: activeMemberships.map((m) => ({
      id: m.organizationId,
      slug: m.organization.slug,
      name: m.organization.name,
      role: m.role as OrgRole,
    })),
  };
}
