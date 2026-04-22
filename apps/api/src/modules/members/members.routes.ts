import {
  ApiErrorCode,
  createInvitationBodySchema,
  invitationListItemSchema,
  itemEnvelopeSchema,
  listEnvelopeSchema,
  memberSchema,
  successSchema,
  updateMemberRoleBodySchema,
  uuidSchema,
} from '@aligned/shared';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { recordAudit } from '../../lib/audit.js';
import { prisma } from '../../lib/db.js';
import { badRequest, forbidden, notFound } from '../../lib/errors.js';
import { createInvitation } from '../auth/auth.service.js';

export default async function memberRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  // ---------- GET /members --------------------------------------------------
  r.get(
    '/members',
    {
      schema: {
        tags: ['members'],
        summary: 'List members of the active organization.',
        response: { 200: listEnvelopeSchema(memberSchema) },
      },
      preHandler: [app.requireRole('viewer')],
    },
    async (req) => {
      return app.tenant(req, async (tx) => {
        const memberships = await tx.membership.findMany({
          orderBy: { createdAt: 'asc' },
          include: { user: true },
        });
        return {
          data: memberships.map((m) => ({
            membershipId: m.id,
            userId: m.userId,
            email: m.user.email,
            firstName: m.user.firstName,
            lastName: m.user.lastName,
            avatarUrl: m.user.avatarUrl,
            role: m.role,
            status: m.user.status,
            isActive: m.isActive,
            lastLoginAt: m.user.lastLoginAt?.toISOString() ?? null,
            createdAt: m.createdAt.toISOString(),
          })),
          nextCursor: null,
        };
      });
    },
  );

  // ---------- PATCH /members/:id/role --------------------------------------
  r.patch(
    '/members/:id/role',
    {
      schema: {
        tags: ['members'],
        summary: 'Change a member’s role.',
        params: z.object({ id: uuidSchema }),
        body: updateMemberRoleBodySchema,
        response: { 200: itemEnvelopeSchema(memberSchema) },
      },
      preHandler: [app.requireRole('admin')],
    },
    async (req) => {
      return app.tenant(req, async (tx) => {
        const membership = await tx.membership.findUnique({ where: { id: req.params.id } });
        if (!membership) throw notFound('Member not found.');

        // Prevent demoting the last admin.
        if (membership.role === 'admin' && req.body.role !== 'admin') {
          const adminCount = await tx.membership.count({ where: { role: 'admin', isActive: true } });
          if (adminCount <= 1) throw badRequest(ApiErrorCode.CONFLICT, 'You cannot demote the last admin.');
        }

        const updated = await tx.membership.update({
          where: { id: req.params.id },
          data: { role: req.body.role },
          include: { user: true },
        });

        await recordAudit({
          action: 'user_role_changed',
          organizationId: req.auth!.organizationId,
          actorUserId: req.auth!.userId,
          entityType: 'membership',
          entityId: updated.id,
          metadata: { from: membership.role, to: req.body.role },
        });

        return {
          data: {
            membershipId: updated.id,
            userId: updated.userId,
            email: updated.user.email,
            firstName: updated.user.firstName,
            lastName: updated.user.lastName,
            avatarUrl: updated.user.avatarUrl,
            role: updated.role,
            status: updated.user.status,
            isActive: updated.isActive,
            lastLoginAt: updated.user.lastLoginAt?.toISOString() ?? null,
            createdAt: updated.createdAt.toISOString(),
          },
        };
      });
    },
  );

  // ---------- POST /members/:id/deactivate ---------------------------------
  r.post(
    '/members/:id/deactivate',
    {
      schema: {
        tags: ['members'],
        summary: 'Deactivate a member (revokes their sessions).',
        params: z.object({ id: uuidSchema }),
        response: { 200: successSchema },
      },
      preHandler: [app.requireRole('admin')],
    },
    async (req) => {
      const orgId = req.auth!.organizationId;
      return app.tenant(req, async (tx) => {
        const membership = await tx.membership.findUnique({ where: { id: req.params.id } });
        if (!membership) throw notFound('Member not found.');
        if (membership.userId === req.auth!.userId) {
          throw forbidden(ApiErrorCode.FORBIDDEN, 'You cannot deactivate yourself.');
        }
        if (membership.role === 'admin') {
          const adminCount = await tx.membership.count({ where: { role: 'admin', isActive: true } });
          if (adminCount <= 1) throw badRequest(ApiErrorCode.CONFLICT, 'You cannot deactivate the last admin.');
        }
        await tx.membership.update({ where: { id: membership.id }, data: { isActive: false } });

        // Revoke all sessions for this user in this org.
        await prisma.session.updateMany({
          where: { userId: membership.userId, organizationId: orgId, revokedAt: null },
          data: { revokedAt: new Date() },
        });

        await recordAudit({
          action: 'user_deactivated',
          organizationId: orgId,
          actorUserId: req.auth!.userId,
          entityType: 'membership',
          entityId: membership.id,
        });

        return { ok: true as const };
      });
    },
  );

  // ---------- GET /invitations ---------------------------------------------
  r.get(
    '/invitations',
    {
      schema: {
        tags: ['members'],
        summary: 'List invitations for the active organization.',
        response: { 200: listEnvelopeSchema(invitationListItemSchema) },
      },
      preHandler: [app.requireRole('admin')],
    },
    async (req) => {
      return app.tenant(req, async (tx) => {
        const invites = await tx.invitation.findMany({
          orderBy: { createdAt: 'desc' },
          include: { invitedBy: true },
        });
        return {
          data: invites.map((i) => ({
            id: i.id,
            email: i.email,
            role: i.role,
            status: i.status,
            invitedById: i.invitedById,
            invitedByName:
              [i.invitedBy.firstName, i.invitedBy.lastName].filter(Boolean).join(' ') || i.invitedBy.email,
            acceptedAt: i.acceptedAt?.toISOString() ?? null,
            expiresAt: i.expiresAt.toISOString(),
            createdAt: i.createdAt.toISOString(),
          })),
          nextCursor: null,
        };
      });
    },
  );

  // ---------- POST /invitations --------------------------------------------
  r.post(
    '/invitations',
    {
      schema: {
        tags: ['members'],
        summary: 'Invite a teammate to the active organization.',
        body: createInvitationBodySchema,
        response: { 201: itemEnvelopeSchema(invitationListItemSchema) },
      },
      preHandler: [app.requireRole('admin')],
    },
    async (req, reply) => {
      const invite = await createInvitation({
        organizationId: req.auth!.organizationId,
        email: req.body.email,
        role: req.body.role,
        invitedById: req.auth!.userId,
        meta: { ip: req.ip, userAgent: req.headers['user-agent'] ?? null },
      });
      reply.code(201);
      return {
        data: {
          id: invite.id,
          email: invite.email,
          role: invite.role,
          status: invite.status,
          invitedById: invite.invitedById,
          invitedByName:
            [invite.invitedBy.firstName, invite.invitedBy.lastName].filter(Boolean).join(' ') ||
            invite.invitedBy.email,
          acceptedAt: invite.acceptedAt?.toISOString() ?? null,
          expiresAt: invite.expiresAt.toISOString(),
          createdAt: invite.createdAt.toISOString(),
        },
      };
    },
  );

  // ---------- POST /invitations/:id/revoke ---------------------------------
  r.post(
    '/invitations/:id/revoke',
    {
      schema: {
        tags: ['members'],
        summary: 'Revoke a pending invitation.',
        params: z.object({ id: uuidSchema }),
        response: { 200: successSchema },
      },
      preHandler: [app.requireRole('admin')],
    },
    async (req) => {
      return app.tenant(req, async (tx) => {
        const invite = await tx.invitation.findUnique({ where: { id: req.params.id } });
        if (!invite) throw notFound('Invitation not found.');
        if (invite.status !== 'pending') {
          throw badRequest(ApiErrorCode.CONFLICT, 'Only pending invitations can be revoked.');
        }
        await tx.invitation.update({ where: { id: invite.id }, data: { status: 'revoked' } });
        await recordAudit({
          action: 'invitation_revoked',
          organizationId: req.auth!.organizationId,
          actorUserId: req.auth!.userId,
          entityType: 'invitation',
          entityId: invite.id,
        });
        return { ok: true as const };
      });
    },
  );
}
