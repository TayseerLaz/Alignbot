import { prisma } from '@aligned/db';
import type { Prisma, PrismaClient } from '@aligned/db';

export { prisma };

export type Tx = Omit<PrismaClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'>;

/**
 * Run callback inside a transaction with `app.current_org_id` set.
 * Switches to the non-superuser `aligned_app` role so RLS policies actually
 * filter — superusers bypass RLS unconditionally.
 */
export async function withTenant<T>(organizationId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL ROLE aligned_app`);
    await tx.$executeRawUnsafe(`SELECT set_config('app.current_org_id', $1, true)`, organizationId);
    return fn(tx as Tx);
  });
}

/**
 * Bypass RLS — for ALIGNED super-admin cross-tenant ops and auth bootstrap.
 * Caller MUST gate access with requireAlignedAdmin or be in the auth path.
 */
export async function withRlsBypass<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SELECT set_config('app.bypass_rls', 'on', true)`);
    return fn(tx as Tx);
  });
}

export type { Prisma };
