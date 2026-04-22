import { PrismaClient } from '@prisma/client';

declare global {
  // eslint-disable-next-line no-var
  var __alignedPrisma: PrismaClient | undefined;
}

export function createPrisma(): PrismaClient {
  return new PrismaClient({
    log:
      process.env.NODE_ENV === 'production'
        ? ['warn', 'error']
        : ['warn', 'error'], // queries logged via Fastify pino, not Prisma
  });
}

/**
 * Process-singleton Prisma client. Use this from API/worker entry points.
 * Per-request tenant scoping is applied via `withTenant()` (see api/src/lib/db).
 */
export const prisma: PrismaClient =
  globalThis.__alignedPrisma ?? (globalThis.__alignedPrisma = createPrisma());
