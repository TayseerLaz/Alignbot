import { ApiErrorCode } from '@aligned/shared';
import type { OrgRole } from '@aligned/shared';

import { recordAudit } from '../../lib/audit.js';
import { generateOpaqueToken, hashPassword, hashToken, verifyPassword } from '../../lib/crypto.js';
import { prisma, withRlsBypass } from '../../lib/db.js';
import {
  emailVerifyTemplate,
  welcomeTemplate,
  invitationTemplate,
  passwordResetTemplate,
  sendEmail,
} from '../../lib/email.js';
import { env } from '../../lib/env.js';
import { badRequest, conflict, forbidden, notFound, unauthorized } from '../../lib/errors.js';
import { signAccessToken, signRefreshToken } from '../../lib/jwt.js';

const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MINUTES = 15;
const EMAIL_VERIFY_TTL_HOURS = 24;
const PASSWORD_RESET_TTL_HOURS = 1;
const INVITATION_TTL_DAYS = 7;

const minutesFromNow = (m: number) => new Date(Date.now() + m * 60_000);
const hoursFromNow = (h: number) => new Date(Date.now() + h * 3_600_000);
const daysFromNow = (d: number) => new Date(Date.now() + d * 86_400_000);

interface RequestMeta {
  ip?: string | null;
  userAgent?: string | null;
}

// ---------- signup ----------------------------------------------------------
export interface SignupArgs {
  email: string;
  password: string;
  firstName: string;
  lastName: string;
  organizationName: string;
  organizationSlug: string;
  meta: RequestMeta;
}

export async function signup(args: SignupArgs) {
  return withRlsBypass(async (tx) => {
    const existingUser = await tx.user.findUnique({ where: { email: args.email } });
    if (existingUser) throw conflict('An account with this email already exists.');

    const existingOrg = await tx.organization.findUnique({ where: { slug: args.organizationSlug } });
    if (existingOrg) throw conflict('That organization slug is taken.');

    const passwordHash = await hashPassword(args.password);
    const verifyToken = generateOpaqueToken();
    const verifyTokenHash = hashToken(verifyToken);

    const user = await tx.user.create({
      data: {
        email: args.email,
        passwordHash,
        firstName: args.firstName,
        lastName: args.lastName,
        emailVerificationTokenHash: verifyTokenHash,
        emailVerificationExpiresAt: hoursFromNow(EMAIL_VERIFY_TTL_HOURS),
      },
    });

    const organization = await tx.organization.create({
      data: { slug: args.organizationSlug, name: args.organizationName },
    });

    await tx.membership.create({
      data: { userId: user.id, organizationId: organization.id, role: 'admin' },
    });

    const verifyUrl = `${env.WEB_PUBLIC_URL}/verify-email?token=${verifyToken}`;
    const tpl = emailVerifyTemplate({ firstName: user.firstName, url: verifyUrl });
    await sendEmail({ to: user.email, ...tpl }).catch((err) =>
      console.error('[auth] verify email send failed', err),
    );

    // Welcome email — separate from verify so the inbox feels populated +
    // the user has a checklist of next steps. Send unconditionally; failure
    // is non-fatal.
    const welcomeTpl = welcomeTemplate({
      firstName: user.firstName,
      organizationName: organization.name,
      portalUrl: env.WEB_PUBLIC_URL,
    });
    await sendEmail({ to: user.email, ...welcomeTpl }).catch((err) =>
      console.error('[auth] welcome email send failed', err),
    );

    await recordAudit({
      action: 'org_created',
      organizationId: organization.id,
      actorUserId: user.id,
      ipAddress: args.meta.ip,
      userAgent: args.meta.userAgent,
    });
    await recordAudit({
      action: 'user_created',
      organizationId: organization.id,
      actorUserId: user.id,
      ipAddress: args.meta.ip,
      userAgent: args.meta.userAgent,
    });

    return { user, organization };
  });
}

// ---------- login -----------------------------------------------------------
export interface LoginArgs {
  email: string;
  password: string;
  organizationSlug?: string;
  /** Phase 5.5 — TOTP 6-digit code or 8-char recovery code, when 2FA is on. */
  totpCode?: string;
  meta: RequestMeta;
}

export async function login(args: LoginArgs) {
  const user = await prisma.user.findUnique({
    where: { email: args.email },
    include: { memberships: { include: { organization: true } } },
  });

  if (!user) {
    await recordAudit({
      action: 'login_failed',
      metadata: { reason: 'user_not_found', email: args.email },
      ipAddress: args.meta.ip,
      userAgent: args.meta.userAgent,
    });
    throw unauthorized(ApiErrorCode.AUTH_INVALID_CREDENTIALS, 'Invalid email or password.');
  }

  if (user.lockedUntil && user.lockedUntil > new Date()) {
    throw unauthorized(
      ApiErrorCode.AUTH_ACCOUNT_LOCKED,
      `Account locked. Try again after ${user.lockedUntil.toISOString()}.`,
    );
  }

  if (user.status === 'disabled') {
    throw unauthorized(ApiErrorCode.AUTH_USER_DISABLED, 'This account is disabled.');
  }

  const valid = await verifyPassword(args.password, user.passwordHash);
  if (!valid) {
    const failedAttempts = user.failedLoginAttempts + 1;
    const shouldLock = failedAttempts >= MAX_FAILED_ATTEMPTS;
    await prisma.user.update({
      where: { id: user.id },
      data: {
        failedLoginAttempts: failedAttempts,
        lockedUntil: shouldLock ? minutesFromNow(LOCKOUT_MINUTES) : user.lockedUntil,
      },
    });
    await recordAudit({
      action: 'login_failed',
      actorUserId: user.id,
      metadata: { reason: 'bad_password', attempts: failedAttempts },
      ipAddress: args.meta.ip,
      userAgent: args.meta.userAgent,
    });
    throw unauthorized(ApiErrorCode.AUTH_INVALID_CREDENTIALS, 'Invalid email or password.');
  }

  if (user.status === 'pending' || !user.emailVerifiedAt) {
    throw unauthorized(
      ApiErrorCode.AUTH_EMAIL_NOT_VERIFIED,
      'Please verify your email before signing in.',
    );
  }

  // Phase 5.5 — TOTP 2FA gate. If enabled, require a valid totpCode (or one of
  // the user's recovery codes). On recovery-code use, that single code is
  // consumed (removed from the array).
  //
  // Brute-force protection: TOTP failures hit the same `failedLoginAttempts`
  // counter as bad-password failures, so after MAX_FAILED_ATTEMPTS combined
  // bad-password + bad-TOTP entries the account locks for LOCKOUT_MINUTES.
  // Without this, an attacker who steals the password can still try all 10⁶
  // TOTP codes at the global API rate limit.
  if (user.totpEnabled && user.totpSecret) {
    const supplied = args.totpCode?.trim();
    if (!supplied) {
      throw unauthorized(
        ApiErrorCode.TOTP_REQUIRED,
        'Two-factor authentication is enabled on this account. Provide your 6-digit code.',
      );
    }
    let ok = false;
    if (/^\d{6}$/.test(supplied)) {
      const { verifyTotpCode } = await import('../../lib/totp.js');
      ok = verifyTotpCode(user.totpSecret, supplied);
    } else if (user.recoveryCodesHashed.length > 0) {
      // Recovery code path: SHA-256 hash + constant-time compare.
      const { createHash } = await import('node:crypto');
      const hashed = createHash('sha256').update(supplied.toUpperCase()).digest('hex');
      const idx = user.recoveryCodesHashed.indexOf(hashed);
      if (idx >= 0) {
        ok = true;
        const remaining = user.recoveryCodesHashed.filter((_, i) => i !== idx);
        await prisma.user.update({
          where: { id: user.id },
          data: { recoveryCodesHashed: remaining },
        });
      }
    }
    if (!ok) {
      const failedAttempts = user.failedLoginAttempts + 1;
      const shouldLock = failedAttempts >= MAX_FAILED_ATTEMPTS;
      await prisma.user.update({
        where: { id: user.id },
        data: {
          failedLoginAttempts: failedAttempts,
          lockedUntil: shouldLock ? minutesFromNow(LOCKOUT_MINUTES) : user.lockedUntil,
        },
      });
      await recordAudit({
        action: 'login_failed',
        actorUserId: user.id,
        metadata: { reason: 'bad_totp', attempts: failedAttempts },
        ipAddress: args.meta.ip,
        userAgent: args.meta.userAgent,
      });
      throw unauthorized(
        ApiErrorCode.TOTP_INVALID,
        'Invalid two-factor code.',
      );
    }
  }

  const activeMemberships = user.memberships.filter((m) => m.isActive && m.organization.status === 'active');
  if (activeMemberships.length === 0) {
    throw unauthorized(
      ApiErrorCode.AUTH_NO_MEMBERSHIP,
      'Your account is not a member of any active organization.',
    );
  }

  let chosen = activeMemberships[0]!;
  if (args.organizationSlug) {
    const match = activeMemberships.find((m) => m.organization.slug === args.organizationSlug);
    if (!match) throw forbidden(ApiErrorCode.AUTH_NO_MEMBERSHIP, 'You do not belong to that organization.');
    chosen = match;
  }

  // Reset failed counters on successful login. Also invalidate any pending
  // password-reset token — a stolen reset link should not remain usable after
  // the legitimate user has already authenticated.
  await prisma.user.update({
    where: { id: user.id },
    data: {
      failedLoginAttempts: 0,
      lockedUntil: null,
      lastLoginAt: new Date(),
      passwordResetTokenHash: null,
      passwordResetExpiresAt: null,
    },
  });

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
    ipAddress: args.meta.ip,
    userAgent: args.meta.userAgent,
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

// ---------- session issue / refresh / logout -------------------------------
export async function issueSession(args: {
  userId: string;
  organizationId: string;
  role: OrgRole;
  isAlignedAdmin: boolean;
  meta: RequestMeta;
  /** Sprint 1 H-3 — set true only for /aligned-admin/.../impersonate. */
  isImpersonation?: boolean;
}) {
  const session = await prisma.session.create({
    data: {
      userId: args.userId,
      organizationId: args.organizationId,
      refreshTokenHash: 'pending', // overwritten below
      expiresAt: new Date(Date.now() + env.JWT_REFRESH_TTL_SECONDS * 1000),
      userAgent: args.meta.userAgent ?? undefined,
      ipAddress: args.meta.ip ?? undefined,
      isImpersonation: args.isImpersonation ?? false,
    },
  });

  const access = await signAccessToken({
    sub: args.userId,
    org: args.organizationId,
    role: args.role,
    aa: args.isAlignedAdmin,
    sid: session.id,
  });
  const refresh = await signRefreshToken({ sub: args.userId, sid: session.id });

  await prisma.session.update({
    where: { id: session.id },
    data: { refreshTokenHash: hashToken(refresh.token) },
  });

  return {
    accessToken: access.token,
    refreshToken: refresh.token,
    expiresAt: access.expiresAt,
    sessionId: session.id,
  };
}

// 2026-06-01 — replay-grace window for the reuse-detection branch. A
// legitimate concurrent same-tab refresh race (SessionProvider bootstrap
// + a useQuery 401-retry firing on a hard reload before the new cookie
// has been committed by the browser) will arrive carrying the
// just-rotated token. Treating that as malicious replay revokes the
// session and bounces the user to /login mid-session — the symptom the
// user reported. Within this window we return success without rotating
// again; the client gets a fresh access token and the family stays
// intact. Outside the window: real replay → keep the strict behaviour.
// Widened 10s → 60s on 2026-06-09. With the full-screen inbox opening a
// second tab, a backgrounded/throttled tab's refresh can legitimately land
// later than 10s after the foreground tab rotated. The client now also
// serializes refreshes across tabs (Web Locks) + shares tokens, so this is
// a belt-and-suspenders margin for slow networks — not the primary guard.
// Widened 60s → 10 min on 2026-06-18. Tenants were still getting logged out:
// a slept laptop/phone or a backgrounded tab fires a refresh carrying the
// just-rotated token minutes later, and the 60s cutoff treated that as theft
// and revoked the session. 10 min covers real-world tab/device wake-ups while
// still catching a token replayed long after the fact.
const REUSE_GRACE_WINDOW_MS = 10 * 60_000;

export async function refreshSession(refreshToken: string, meta: RequestMeta) {
  const tokenHash = hashToken(refreshToken);

  // Sprint 1 M-2 — reuse detection. First check whether this hash matches the
  // *previously-rotated* hash of any session. If so, the caller is presenting
  // a token that has already been exchanged once. Inside the grace window
  // this is a concurrent same-tab refresh; outside it's an attacker replay.
  const reusedSession = await prisma.session.findUnique({
    where: { previousTokenHash: tokenHash },
    include: { user: true, organization: true },
  });
  if (reusedSession && !reusedSession.revokedAt) {
    const rotatedAt = reusedSession.previousTokenRotatedAt;
    const withinGrace =
      rotatedAt && Date.now() - rotatedAt.getTime() < REUSE_GRACE_WINDOW_MS;
    if (withinGrace) {
      // Re-issue a fresh access token against the SAME session row
      // without rotating the refresh family again. The first refresh
      // already moved hash(T1) → previous, hash(T2) → current; this
      // second refresh just hands the client a new access token so
      // the in-flight request can succeed. Crucially, do NOT rotate
      // again — if we did, the legitimate first refresh's cookie
      // (still in flight) would land third and trip reuse-detection.
      let effectiveRole: OrgRole;
      const membership = await prisma.membership.findUnique({
        where: {
          organizationId_userId: {
            organizationId: reusedSession.organizationId!,
            userId: reusedSession.userId,
          },
        },
      });
      if (membership && membership.isActive) {
        effectiveRole = membership.role as OrgRole;
      } else if (reusedSession.isImpersonation && reusedSession.user.isAlignedAdmin) {
        effectiveRole = 'admin' as OrgRole;
      } else {
        throw forbidden(ApiErrorCode.AUTH_NO_MEMBERSHIP, 'No active membership for this session.');
      }
      const access = await signAccessToken({
        sub: reusedSession.userId,
        org: reusedSession.organizationId!,
        role: effectiveRole,
        aa: reusedSession.user.isAlignedAdmin,
        sid: reusedSession.id,
      });
      // Don't return a new refresh token — the client's cookie is the
      // already-rotated T2 (set by the first call which is currently
      // in flight), so leaving the refresh cookie untouched is correct.
      // Callers that want the cookie can read it from the response of
      // the first refresh; this one only re-mints the bearer.
      return {
        accessToken: access.token,
        refreshToken: null as string | null,
        expiresAt: access.expiresAt,
      };
    }
    // Outside the grace window OR no rotation timestamp recorded
    // (pre-migration rows): treat as malicious replay.
    await prisma.session.update({
      where: { id: reusedSession.id },
      data: { revokedAt: new Date() },
    });
    await recordAudit({
      action: 'refresh_token_reuse_detected',
      actorUserId: reusedSession.userId,
      organizationId: reusedSession.organizationId,
      ipAddress: meta.ip,
      userAgent: meta.userAgent,
      metadata: { sessionId: reusedSession.id },
    });
    throw unauthorized(ApiErrorCode.AUTH_REFRESH_INVALID, 'Refresh token invalid or expired.');
  }

  const session = await prisma.session.findUnique({
    where: { refreshTokenHash: tokenHash },
    include: {
      user: true,
      organization: true,
    },
  });
  if (!session || session.revokedAt || session.expiresAt < new Date()) {
    throw unauthorized(ApiErrorCode.AUTH_REFRESH_INVALID, 'Refresh token invalid or expired.');
  }

  const membership = await prisma.membership.findUnique({
    where: { organizationId_userId: { organizationId: session.organizationId!, userId: session.userId } },
  });
  // Sprint 1 H-3 — the no-membership admin-role synthesis is now gated on the
  // session being an explicit impersonation session (POST /aligned-admin/
  // orgs/:id/impersonate sets is_impersonation = true). Regular sessions for
  // ALIGNED admins still require an active membership, so removing them from
  // org X via the members page invalidates their access to X on next refresh.
  let effectiveRole: OrgRole;
  if (membership && membership.isActive) {
    effectiveRole = membership.role as OrgRole;
  } else if (session.isImpersonation && session.user.isAlignedAdmin) {
    effectiveRole = 'admin' as OrgRole;
  } else {
    throw forbidden(ApiErrorCode.AUTH_NO_MEMBERSHIP, 'No active membership for this session.');
  }

  // Rotate refresh token. Move the current hash to previous_token_hash so a
  // replay of the rotated token trips the reuse-detection branch above.
  const newRefresh = await signRefreshToken({ sub: session.userId, sid: session.id });
  const access = await signAccessToken({
    sub: session.userId,
    org: session.organizationId!,
    role: effectiveRole,
    aa: session.user.isAlignedAdmin,
    sid: session.id,
  });

  await prisma.session.update({
    where: { id: session.id },
    data: {
      previousTokenHash: session.refreshTokenHash,
      // Stamped so the next /refresh that arrives carrying the
      // just-rotated token can decide whether it's a concurrent-tab
      // race (within REUSE_GRACE_WINDOW_MS) or a real attacker replay.
      previousTokenRotatedAt: new Date(),
      refreshTokenHash: hashToken(newRefresh.token),
      lastUsedAt: new Date(),
      userAgent: meta.userAgent ?? session.userAgent,
      ipAddress: meta.ip ?? session.ipAddress,
    },
  });

  return {
    accessToken: access.token,
    refreshToken: newRefresh.token,
    expiresAt: access.expiresAt,
  };
}

export async function logout(sessionId: string, meta: RequestMeta) {
  const session = await prisma.session.findUnique({ where: { id: sessionId } });
  if (session && !session.revokedAt) {
    await prisma.session.update({ where: { id: sessionId }, data: { revokedAt: new Date() } });
    await recordAudit({
      action: 'logout',
      actorUserId: session.userId,
      organizationId: session.organizationId,
      ipAddress: meta.ip,
      userAgent: meta.userAgent,
    });
  }
}

// ---------- email verification ---------------------------------------------
export async function verifyEmail(token: string) {
  const tokenHash = hashToken(token);
  const user = await prisma.user.findFirst({
    where: { emailVerificationTokenHash: tokenHash },
  });
  if (!user || !user.emailVerificationExpiresAt || user.emailVerificationExpiresAt < new Date()) {
    throw badRequest(ApiErrorCode.AUTH_TOKEN_INVALID, 'Verification link is invalid or expired.');
  }

  await prisma.user.update({
    where: { id: user.id },
    data: {
      emailVerifiedAt: new Date(),
      status: 'active',
      emailVerificationTokenHash: null,
      emailVerificationExpiresAt: null,
    },
  });

  await recordAudit({ action: 'email_verified', actorUserId: user.id });
  return { ok: true as const };
}

// ---------- password reset --------------------------------------------------
export async function forgotPassword(email: string, meta: RequestMeta) {
  // Always return success — never leak whether an account exists. To prevent
  // account-enumeration via response-time analysis, the no-user path performs
  // dummy work so the request takes roughly as long as the hit path.
  const start = Date.now();
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    // Burn ~150ms (a typical resend-template + email-send roundtrip) so the
    // hit/miss paths return in similar wall-clock time.
    const elapsed = Date.now() - start;
    const padMs = Math.max(0, 150 - elapsed);
    if (padMs > 0) await new Promise((res) => setTimeout(res, padMs));
    return { ok: true as const };
  }

  const resetToken = generateOpaqueToken();
  const resetTokenHash = hashToken(resetToken);

  await prisma.user.update({
    where: { id: user.id },
    data: {
      passwordResetTokenHash: resetTokenHash,
      passwordResetExpiresAt: hoursFromNow(PASSWORD_RESET_TTL_HOURS),
    },
  });

  const url = `${env.WEB_PUBLIC_URL}/reset-password?token=${resetToken}`;
  const tpl = passwordResetTemplate({ firstName: user.firstName, url });
  await sendEmail({ to: user.email, ...tpl }).catch((err) =>
    console.error('[auth] reset email send failed', err),
  );

  await recordAudit({
    action: 'password_reset_requested',
    actorUserId: user.id,
    ipAddress: meta.ip,
    userAgent: meta.userAgent,
  });
  return { ok: true as const };
}

export async function resetPassword(token: string, newPassword: string, meta: RequestMeta) {
  const tokenHash = hashToken(token);
  const user = await prisma.user.findFirst({ where: { passwordResetTokenHash: tokenHash } });
  if (!user || !user.passwordResetExpiresAt || user.passwordResetExpiresAt < new Date()) {
    throw badRequest(ApiErrorCode.AUTH_TOKEN_INVALID, 'Reset link is invalid or expired.');
  }

  const passwordHash = await hashPassword(newPassword);
  await prisma.user.update({
    where: { id: user.id },
    data: {
      passwordHash,
      passwordResetTokenHash: null,
      passwordResetExpiresAt: null,
      failedLoginAttempts: 0,
      lockedUntil: null,
    },
  });

  // Revoke all existing sessions on password change — force re-login everywhere.
  await prisma.session.updateMany({
    where: { userId: user.id, revokedAt: null },
    data: { revokedAt: new Date() },
  });

  await recordAudit({
    action: 'password_changed',
    actorUserId: user.id,
    ipAddress: meta.ip,
    userAgent: meta.userAgent,
  });
  return { ok: true as const };
}

// ---------- profile: update name / avatar ----------------------------------
export async function updateProfile(
  userId: string,
  patch: { firstName?: string; lastName?: string; avatarUrl?: string | null },
  meta: RequestMeta,
) {
  const user = await prisma.user.update({
    where: { id: userId },
    data: {
      ...(patch.firstName !== undefined ? { firstName: patch.firstName } : {}),
      ...(patch.lastName !== undefined ? { lastName: patch.lastName } : {}),
      ...(patch.avatarUrl !== undefined ? { avatarUrl: patch.avatarUrl } : {}),
    },
  });
  await recordAudit({
    action: 'user_updated',
    actorUserId: user.id,
    entityType: 'user',
    entityId: user.id,
    ipAddress: meta.ip,
    userAgent: meta.userAgent,
  });
  return {
    id: user.id,
    email: user.email,
    firstName: user.firstName,
    lastName: user.lastName,
  };
}

// ---------- profile: change password in place -------------------------------
export async function changePassword(
  userId: string,
  args: { currentPassword: string; newPassword: string; currentSessionId?: string },
  meta: RequestMeta,
) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw notFound('User not found.');

  const ok = await verifyPassword(args.currentPassword, user.passwordHash);
  if (!ok) throw unauthorized(ApiErrorCode.AUTH_INVALID_CREDENTIALS, 'Current password is incorrect.');

  const newHash = await hashPassword(args.newPassword);
  await prisma.user.update({
    where: { id: user.id },
    data: {
      passwordHash: newHash,
      passwordResetTokenHash: null,
      passwordResetExpiresAt: null,
      failedLoginAttempts: 0,
      lockedUntil: null,
    },
  });

  // Revoke every other session — keep the one making this request alive so
  // the user isn't bounced back to /login.
  await prisma.session.updateMany({
    where: {
      userId: user.id,
      revokedAt: null,
      ...(args.currentSessionId ? { NOT: { id: args.currentSessionId } } : {}),
    },
    data: { revokedAt: new Date() },
  });

  await recordAudit({
    action: 'password_changed',
    actorUserId: user.id,
    ipAddress: meta.ip,
    userAgent: meta.userAgent,
  });
  return { ok: true as const };
}

// ---------- invitations -----------------------------------------------------
export async function createInvitation(args: {
  organizationId: string;
  email: string;
  role: OrgRole;
  invitedById: string;
  meta: RequestMeta;
}) {
  return withRlsBypass(async (tx) => {
    // Reject if user is already a member.
    const existingMembership = await tx.membership.findFirst({
      where: { organizationId: args.organizationId, user: { email: args.email } },
    });
    if (existingMembership) throw conflict('This person is already a member.');

    // Revoke any existing pending invitation for this email+org so token is unique.
    const existingInvite = await tx.invitation.findUnique({
      where: { organizationId_email: { organizationId: args.organizationId, email: args.email } },
    });
    if (existingInvite && existingInvite.status === 'pending') {
      await tx.invitation.update({
        where: { id: existingInvite.id },
        data: { status: 'revoked' },
      });
    } else if (existingInvite) {
      await tx.invitation.delete({ where: { id: existingInvite.id } });
    }

    const token = generateOpaqueToken();
    const tokenHash = hashToken(token);

    const invite = await tx.invitation.create({
      data: {
        organizationId: args.organizationId,
        email: args.email,
        role: args.role,
        tokenHash,
        invitedById: args.invitedById,
        expiresAt: daysFromNow(INVITATION_TTL_DAYS),
      },
      include: { organization: true, invitedBy: true },
    });

    const inviterName =
      [invite.invitedBy.firstName, invite.invitedBy.lastName].filter(Boolean).join(' ') ||
      invite.invitedBy.email;
    const url = `${env.WEB_PUBLIC_URL}/invite/${token}`;
    const tpl = invitationTemplate({ orgName: invite.organization.name, inviterName, url });
    await sendEmail({ to: invite.email, ...tpl }).catch((err) =>
      console.error('[auth] invite email send failed', err),
    );

    await recordAudit({
      action: 'invitation_sent',
      organizationId: args.organizationId,
      actorUserId: args.invitedById,
      entityType: 'invitation',
      entityId: invite.id,
      metadata: { email: args.email, role: args.role },
      ipAddress: args.meta.ip,
      userAgent: args.meta.userAgent,
    });

    return invite;
  });
}

export async function acceptInvitation(args: {
  token: string;
  password?: string;
  firstName?: string;
  lastName?: string;
  meta: RequestMeta;
}) {
  return withRlsBypass(async (tx) => {
    const tokenHash = hashToken(args.token);
    const invite = await tx.invitation.findUnique({
      where: { tokenHash },
      include: { organization: true },
    });
    if (!invite) throw notFound('Invitation not found.');
    if (invite.status !== 'pending') throw badRequest(ApiErrorCode.CONFLICT, 'Invitation already used or revoked.');
    if (invite.expiresAt < new Date()) {
      await tx.invitation.update({ where: { id: invite.id }, data: { status: 'expired' } });
      throw badRequest(ApiErrorCode.AUTH_TOKEN_EXPIRED, 'Invitation has expired.');
    }

    let user = await tx.user.findUnique({ where: { email: invite.email } });
    let createdNewUserPendingVerification = false;

    if (!user) {
      if (!args.password || !args.firstName || !args.lastName) {
        throw badRequest(
          ApiErrorCode.VALIDATION_ERROR,
          'Password, firstName, and lastName are required to create a new account.',
        );
      }
      const passwordHash = await hashPassword(args.password);
      // Sprint 1 H-4 — previously this set emailVerifiedAt immediately,
      // trusting that holding the invite token implies mailbox control.
      // That assumption breaks if the invite link is leaked (browser
      // history, corporate proxy, log scraping). The brand-new user now
      // goes through the standard verify-email flow before they can log
      // in — defense in depth on top of the token's already-high entropy.
      const verifyToken = generateOpaqueToken();
      const verifyTokenHash = hashToken(verifyToken);
      user = await tx.user.create({
        data: {
          email: invite.email,
          passwordHash,
          firstName: args.firstName,
          lastName: args.lastName,
          status: 'active',
          emailVerificationTokenHash: verifyTokenHash,
          emailVerificationExpiresAt: hoursFromNow(EMAIL_VERIFY_TTL_HOURS),
        },
      });
      createdNewUserPendingVerification = true;

      const verifyUrl = `${env.WEB_PUBLIC_URL}/verify-email?token=${verifyToken}`;
      const tpl = emailVerifyTemplate({ firstName: user.firstName, url: verifyUrl });
      await sendEmail({ to: user.email, ...tpl }).catch((err) =>
        console.error('[auth] invite verify email send failed', err),
      );
    }
    void createdNewUserPendingVerification;

    await tx.membership.upsert({
      where: { organizationId_userId: { organizationId: invite.organizationId, userId: user.id } },
      create: { organizationId: invite.organizationId, userId: user.id, role: invite.role },
      update: { role: invite.role, isActive: true },
    });

    await tx.invitation.update({
      where: { id: invite.id },
      data: { status: 'accepted', acceptedAt: new Date(), acceptedById: user.id },
    });

    await recordAudit({
      action: 'invitation_accepted',
      organizationId: invite.organizationId,
      actorUserId: user.id,
      entityType: 'invitation',
      entityId: invite.id,
      ipAddress: args.meta.ip,
      userAgent: args.meta.userAgent,
    });

    return { user, invitation: invite };
  });
}

// ---------- switch active org for a session -------------------------------
export async function switchOrganization(args: {
  userId: string;
  sessionId: string;
  newOrganizationId: string;
  isAlignedAdmin: boolean;
  meta: RequestMeta;
}) {
  const membership = await prisma.membership.findUnique({
    where: { organizationId_userId: { organizationId: args.newOrganizationId, userId: args.userId } },
    include: { organization: true },
  });
  if (!membership || !membership.isActive || membership.organization.status !== 'active') {
    throw forbidden(ApiErrorCode.AUTH_NO_MEMBERSHIP, 'You do not belong to that organization.');
  }

  // Revoke current session, issue a new one bound to the new org.
  await prisma.session.update({ where: { id: args.sessionId }, data: { revokedAt: new Date() } });

  return issueSession({
    userId: args.userId,
    organizationId: membership.organizationId,
    role: membership.role as OrgRole,
    isAlignedAdmin: args.isAlignedAdmin,
    meta: args.meta,
  });
}

export async function getSessionContext(userId: string, organizationId: string, sessionId?: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: {
      memberships: {
        where: { isActive: true, organization: { status: 'active' } },
        include: { organization: true },
      },
    },
  });
  if (!user) throw notFound('User not found.');

  const active = user.memberships.find((m) => m.organizationId === organizationId);

  // Sprint 1 H-3 — the no-membership admin synthesis is now gated on the
  // current session being an explicit impersonation session. An ALIGNED admin
  // who has been removed from org X is no longer silently granted admin
  // rights to X via this code path.
  if (!active) {
    if (user.isAlignedAdmin && sessionId) {
      const session = await prisma.session.findUnique({
        where: { id: sessionId },
        select: { isImpersonation: true, revokedAt: true },
      });
      if (session && !session.revokedAt && session.isImpersonation) {
        const impersonated = await prisma.organization.findUnique({
          where: { id: organizationId },
        });
        if (!impersonated || impersonated.status !== 'active') {
          throw forbidden(ApiErrorCode.AUTH_NO_MEMBERSHIP, 'No active membership for this org.');
        }
        return {
          user,
          organization: { ...impersonated, role: 'admin' as OrgRole },
          availableOrganizations: user.memberships.map((m) => ({
            id: m.organizationId,
            slug: m.organization.slug,
            name: m.organization.name,
            role: m.role as OrgRole,
          })),
          // Caller can render an "Impersonating <name>" banner / switcher
          // back into the admin's actual orgs.
          impersonating: true as const,
        };
      }
    }
    throw forbidden(ApiErrorCode.AUTH_NO_MEMBERSHIP, 'No active membership for this org.');
  }

  return {
    user,
    organization: { ...active.organization, role: active.role as OrgRole },
    availableOrganizations: user.memberships.map((m) => ({
      id: m.organizationId,
      slug: m.organization.slug,
      name: m.organization.name,
      role: m.role as OrgRole,
    })),
    impersonating: false as const,
  };
}
