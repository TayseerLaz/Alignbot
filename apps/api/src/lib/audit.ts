import type { AuditAction } from '@aligned/db';

import { prisma } from './db.js';

interface RecordAuditArgs {
  action: AuditAction;
  organizationId?: string | null;
  actorUserId?: string | null;
  entityType?: string;
  entityId?: string;
  metadata?: Record<string, unknown>;
  ipAddress?: string | null;
  userAgent?: string | null;
}

/**
 * Write an audit row using RLS bypass (the audit log itself doesn't run inside
 * a per-tenant transaction). Failures are logged but never thrown — auditing
 * must never break the user request.
 */
export async function recordAudit(args: RecordAuditArgs): Promise<void> {
  try {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT set_config('app.bypass_rls', 'on', true)`);
      await tx.auditLog.create({
        data: {
          action: args.action,
          organizationId: args.organizationId ?? null,
          actorUserId: args.actorUserId ?? null,
          entityType: args.entityType,
          entityId: args.entityId,
          metadata: args.metadata ?? undefined,
          ipAddress: args.ipAddress ?? undefined,
          userAgent: args.userAgent ?? undefined,
        },
      });
    });
  } catch (err) {
    console.error('[audit] failed to record', args.action, err);
  }
}
