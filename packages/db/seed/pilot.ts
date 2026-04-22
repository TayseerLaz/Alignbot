// Pilot seed (Day 4.15): three live tenants ready for onboarding.
// Run with: pnpm --filter @aligned/db exec tsx ./seed/pilot.ts
//
// Idempotent: safe to re-run. Each org gets:
//   - One admin user (password printed at end)
//   - Sample products + services + an FAQ + one API key
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { createHash, randomBytes } from 'node:crypto';

const prisma = new PrismaClient();

interface PilotSpec {
  slug: string;
  name: string;
  adminEmail: string;
}

const PILOTS: PilotSpec[] = [
  { slug: 'pilot-cafe', name: 'Pilot Café', adminEmail: 'admin@pilot-cafe.example' },
  { slug: 'pilot-clinic', name: 'Pilot Clinic', adminEmail: 'admin@pilot-clinic.example' },
  { slug: 'pilot-store', name: 'Pilot Store', adminEmail: 'admin@pilot-store.example' },
];

const PASSWORD = 'Pilot1234!';

async function seedOne(spec: PilotSpec): Promise<{ org: string; user: string; key: string | null }> {
  await prisma.$executeRawUnsafe(`SET app.bypass_rls = 'on'`);

  const passwordHash = await bcrypt.hash(PASSWORD, 12);
  const org = await prisma.organization.upsert({
    where: { slug: spec.slug },
    update: {},
    create: { slug: spec.slug, name: spec.name },
  });
  const user = await prisma.user.upsert({
    where: { email: spec.adminEmail },
    update: { passwordHash, status: 'active', emailVerifiedAt: new Date() },
    create: {
      email: spec.adminEmail,
      passwordHash,
      firstName: 'Pilot',
      lastName: 'Admin',
      status: 'active',
      emailVerifiedAt: new Date(),
    },
  });
  await prisma.membership.upsert({
    where: { organizationId_userId: { organizationId: org.id, userId: user.id } },
    update: { role: 'admin', isActive: true },
    create: { organizationId: org.id, userId: user.id, role: 'admin' },
  });

  // Two sample products and one service so the read API has something to return.
  await prisma.product.upsert({
    where: { organizationId_sku: { organizationId: org.id, sku: 'SAMPLE-1' } },
    update: {},
    create: {
      organizationId: org.id,
      sku: 'SAMPLE-1',
      name: 'Sample Product',
      slug: 'sample-product',
      shortDescription: 'A sample product for the chatbot to find.',
      priceMinor: 1999,
      currency: 'USD',
      isAvailable: true,
    },
  });
  await prisma.service.upsert({
    where: { organizationId_slug: { organizationId: org.id, slug: 'sample-service' } },
    update: {},
    create: {
      organizationId: org.id,
      name: 'Sample Service',
      slug: 'sample-service',
      shortDescription: 'A bookable sample service.',
      durationMinutes: 30,
      basePriceMinor: 5000,
      currency: 'USD',
      priceUnit: 'flat',
      isAvailable: true,
    },
  });
  // One FAQ so /read/faqs has data on day 1.
  const existingFaq = await prisma.fAQ.findFirst({
    where: { organizationId: org.id, question: 'What are your business hours?' },
  });
  if (!existingFaq) {
    await prisma.fAQ.create({
      data: {
        organizationId: org.id,
        question: 'What are your business hours?',
        answer: 'We are open Monday to Friday, 9 AM to 5 PM.',
        visibility: 'public',
        isPublished: true,
      },
    });
  }

  // Issue an API key the first time only (we cannot recover the secret later).
  const existingKey = await prisma.apiKey.findFirst({
    where: { organizationId: org.id, name: 'Pilot bot key' },
  });
  let secret: string | null = null;
  if (!existingKey) {
    secret = `ak_live_${randomBytes(24).toString('base64url')}`;
    await prisma.apiKey.create({
      data: {
        organizationId: org.id,
        name: 'Pilot bot key',
        prefix: secret.slice(0, 16),
        keyHash: createHash('sha256').update(secret).digest('hex'),
        scopes: ['read:catalog', 'read:business-info', 'read:faqs'],
        createdById: user.id,
      },
    });
  }

  return { org: org.slug, user: spec.adminEmail, key: secret };
}

async function main() {
  console.warn('[pilot] seeding three pilot tenants…');
  const results = [];
  for (const spec of PILOTS) {
    const out = await seedOne(spec);
    results.push(out);
    console.warn(`[pilot] ✔ ${out.org} — admin ${out.user} / ${PASSWORD}`);
    if (out.key) console.warn(`            api key (save now): ${out.key}`);
  }
  console.warn('\n[pilot] Done. Onboarding checklist is in docs/RUNBOOK.md.');
}

main()
  .catch((err) => {
    console.error('[pilot] failed', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
