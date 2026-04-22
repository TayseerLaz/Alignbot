/**
 * One-shot super-admin bootstrap for production deploy.
 *
 * Reads INITIAL_ADMIN_EMAIL + INITIAL_ADMIN_PASSWORD from the environment,
 * upserts a user with is_aligned_admin=true, email_verified_at=NOW, active.
 *
 * Idempotent — safe to run on every deploy. If the email already exists,
 * updates the password + ensures super-admin flag.
 *
 * Usage (on the server, inside the api container or via pnpm script):
 *   INITIAL_ADMIN_EMAIL=admin@aligned-tech.com \
 *   INITIAL_ADMIN_PASSWORD='...' \
 *   node node_modules/.bin/tsx packages/db/seed/super-admin.ts
 */
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  const email = process.env.INITIAL_ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.INITIAL_ADMIN_PASSWORD;

  if (!email || !password) {
    console.warn('[super-admin] INITIAL_ADMIN_EMAIL or INITIAL_ADMIN_PASSWORD not set — skipping.');
    return;
  }
  if (password.length < 12) {
    console.warn('[super-admin] Password is shorter than 12 chars; the app will reject future password changes to this value.');
  }

  await prisma.$executeRawUnsafe(`SET app.bypass_rls = 'on'`);

  const passwordHash = await bcrypt.hash(password, 12);

  const user = await prisma.user.upsert({
    where: { email },
    update: {
      passwordHash,
      status: 'active',
      emailVerifiedAt: new Date(),
      isAlignedAdmin: true,
    },
    create: {
      email,
      passwordHash,
      firstName: 'ALIGNED',
      lastName: 'Admin',
      status: 'active',
      emailVerifiedAt: new Date(),
      isAlignedAdmin: true,
    },
  });

  console.warn(`[super-admin] ${user.id} ${user.email} is_aligned_admin=${user.isAlignedAdmin}`);
}

main()
  .catch((err) => {
    console.error('[super-admin] failed', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
