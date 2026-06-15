// One-time backfill: encrypt existing plaintext whatsapp_channels secrets.
//
// Run AFTER SECRET_ENCRYPTION_KEY is set in the environment:
//   set -a; . ./.env.production; set +a
//   pnpm --filter @aligned/db exec tsx scripts/backfill-encrypt-secrets.ts
//
// Uses a RAW PrismaClient (no crypto extension) and encrypts explicitly, so
// it can't double-encrypt. Idempotent: already-encrypted rows are skipped.
import { PrismaClient } from '@prisma/client';

import { encryptSecret, secretCryptoEnabled } from '../src/secret-crypto.js';

async function main(): Promise<void> {
  if (!secretCryptoEnabled()) {
    console.error('✗ SECRET_ENCRYPTION_KEY is not set — refusing to run.');
    process.exit(1);
  }
  const prisma = new PrismaClient();
  try {
    const rows = await prisma.$queryRawUnsafe<
      { id: string; access_token: string | null; app_secret: string | null }[]
    >(`SELECT id, access_token, app_secret FROM whatsapp_channels`);

    let changed = 0;
    for (const r of rows) {
      const encAccess = encryptSecret(r.access_token);
      const encSecret = encryptSecret(r.app_secret);
      if (encAccess === r.access_token && encSecret === r.app_secret) continue; // already encrypted / null
      await prisma.$executeRawUnsafe(
        `UPDATE whatsapp_channels SET access_token = $1, app_secret = $2 WHERE id = $3::uuid`,
        encAccess,
        encSecret,
        r.id,
      );
      changed++;
    }
    console.log(`✓ Encrypted secrets on ${changed}/${rows.length} channel(s).`);
  } finally {
    await prisma.$disconnect();
  }
}

void main();
