// Worker-side Prisma client + tenant helper. Mirrors apps/api/src/lib/db.ts so
// that RLS is enforced for any queries done on behalf of a specific tenant.
import { withSecretCrypto } from '@aligned/db';
import { PrismaClient } from '@prisma/client';

declare global {
  // eslint-disable-next-line no-var
  var __alignedWorkerPrisma: PrismaClient | undefined;
}

// withSecretCrypto is inert unless SECRET_ENCRYPTION_KEY is set; mirrors the
// api client so the worker also decrypts whatsapp_channels secrets at read.
export const prisma: PrismaClient =
  globalThis.__alignedWorkerPrisma ??
  (globalThis.__alignedWorkerPrisma = withSecretCrypto(
    new PrismaClient({ log: ['warn', 'error'] }),
  ));

export async function withTenant<T>(organizationId: string, fn: (tx: PrismaClient) => Promise<T>): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SELECT set_config('app.current_org_id', $1, true)`, organizationId);
    return fn(tx as unknown as PrismaClient);
  });
}

export async function withRlsBypass<T>(fn: (tx: PrismaClient) => Promise<T>): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SELECT set_config('app.bypass_rls', 'on', true)`);
    return fn(tx as unknown as PrismaClient);
  });
}
