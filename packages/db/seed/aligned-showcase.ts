// One-shot showcase seed for the ALIGNED demo org.
//
// What it does:
//   1. Finds the org named "ALIGNED" (case-insensitive on name + slug).
//   2. Picks 5 showcase SKUs (signature mix across the catalog).
//   3. SOFT-DELETES every other product on that org (deletedAt = now()).
//   4. Wipes existing images on the 5 showcase products.
//   5. Downloads 3 product photos per SKU from Unsplash, uploads each to
//      Wasabi via PutObjectCommand, and creates Asset + ProductImage rows.
//
// Run once on the server (or any machine with prod env access):
//   pnpm --filter @aligned/db exec tsx ./seed/aligned-showcase.ts
//
// Required env vars (same names the API + worker use):
//   DATABASE_URL or DIRECT_DATABASE_URL
//   WASABI_ACCESS_KEY_ID
//   WASABI_SECRET_ACCESS_KEY
//   WASABI_REGION (e.g. us-east-1)
//   WASABI_ENDPOINT (e.g. https://s3.us-east-1.wasabisys.com)
//   WASABI_BUCKET
//
// SELF-DESTRUCTING: on success this script removes itself from disk so it
// can't be accidentally re-run. Idempotent inside a single run (safe to
// retry if it fails partway).
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SHOWCASE_SKUS = [
  'ATK-MIX-HEARTATTACK',
  'ATK-MIX-VIP',
  'ATK-SWEET-DUBAICREPE',
  'ATK-COF-CAPPUCCINO',
  'ATK-SPEC-MACINTOSH',
] as const;

// 3 image URLs per SKU. Unsplash CDN links — visually close to each
// product, deterministic, no auth needed. Replace with Aseer Time's
// own product photos once they're available.
const IMAGES: Record<string, string[]> = {
  'ATK-MIX-HEARTATTACK': [
    'https://images.unsplash.com/photo-1505252585461-04db1eb84625?w=1200',
    'https://images.unsplash.com/photo-1623065422902-30a2d299bbe4?w=1200',
    'https://images.unsplash.com/photo-1638176067000-9e2e60beb3b1?w=1200',
  ],
  'ATK-MIX-VIP': [
    'https://images.unsplash.com/photo-1623065422902-30a2d299bbe4?w=1200',
    'https://images.unsplash.com/photo-1502741338009-cac2772e18bc?w=1200',
    'https://images.unsplash.com/photo-1612257999691-c7b3ddb56251?w=1200',
  ],
  'ATK-SWEET-DUBAICREPE': [
    'https://images.unsplash.com/photo-1565299624946-b28f40a0ae38?w=1200',
    'https://images.unsplash.com/photo-1587132137056-bfbf0166836e?w=1200',
    'https://images.unsplash.com/photo-1551024601-bec78aea704b?w=1200',
  ],
  'ATK-COF-CAPPUCCINO': [
    'https://images.unsplash.com/photo-1572442388796-11668a67e53d?w=1200',
    'https://images.unsplash.com/photo-1509042239860-f550ce710b93?w=1200',
    'https://images.unsplash.com/photo-1517256064527-09c73fc73e38?w=1200',
  ],
  'ATK-SPEC-MACINTOSH': [
    'https://images.unsplash.com/photo-1549007994-cb92caebd54b?w=1200',
    'https://images.unsplash.com/photo-1481391319762-47dff72954d9?w=1200',
    'https://images.unsplash.com/photo-1481391319762-47dff72954d9?w=1200&blur=2',
  ],
};

interface Env {
  DATABASE_URL: string;
  WASABI_ACCESS_KEY_ID: string;
  WASABI_SECRET_ACCESS_KEY: string;
  WASABI_REGION: string;
  WASABI_ENDPOINT: string;
  WASABI_BUCKET: string;
}

function readEnv(): Env {
  const missing: string[] = [];
  const required = [
    'DATABASE_URL',
    'WASABI_ACCESS_KEY_ID',
    'WASABI_SECRET_ACCESS_KEY',
    'WASABI_REGION',
    'WASABI_ENDPOINT',
    'WASABI_BUCKET',
  ];
  const env: Record<string, string> = {};
  for (const k of required) {
    const v = process.env[k] ?? (k === 'DATABASE_URL' ? process.env.DIRECT_DATABASE_URL : undefined);
    if (!v) missing.push(k);
    else env[k] = v;
  }
  if (missing.length > 0) {
    throw new Error(`Missing env vars: ${missing.join(', ')}`);
  }
  return env as unknown as Env;
}

async function downloadImage(url: string): Promise<{ buffer: Buffer; contentType: string }> {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`fetch ${url} → HTTP ${res.status}`);
  const contentType = res.headers.get('content-type') ?? 'image/jpeg';
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length === 0) throw new Error(`empty body for ${url}`);
  return { buffer: buf, contentType };
}

async function uploadToWasabi(args: {
  client: S3Client;
  bucket: string;
  key: string;
  body: Buffer;
  contentType: string;
}): Promise<void> {
  await args.client.send(
    new PutObjectCommand({
      Bucket: args.bucket,
      Key: args.key,
      Body: args.body,
      ContentType: args.contentType,
    }),
  );
}

function extOf(contentType: string): string {
  if (contentType.includes('png')) return '.png';
  if (contentType.includes('webp')) return '.webp';
  if (contentType.includes('gif')) return '.gif';
  return '.jpg';
}

async function main(): Promise<void> {
  const env = readEnv();
  const prisma = new PrismaClient();
  const s3 = new S3Client({
    region: env.WASABI_REGION,
    endpoint: env.WASABI_ENDPOINT,
    forcePathStyle: false,
    credentials: {
      accessKeyId: env.WASABI_ACCESS_KEY_ID,
      secretAccessKey: env.WASABI_SECRET_ACCESS_KEY,
    },
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });

  try {
    // Bypass RLS for the whole script — we're an out-of-band admin tool.
    await prisma.$executeRawUnsafe(`SET app.bypass_rls = 'on'`);

    // 1. Find the ALIGNED org. Match case-insensitively on name OR slug.
    const org = await prisma.organization.findFirst({
      where: {
        OR: [
          { name: { equals: 'ALIGNED', mode: 'insensitive' } },
          { slug: { equals: 'aligned', mode: 'insensitive' } },
        ],
      },
    });
    if (!org) throw new Error('No org named "ALIGNED" (or slug "aligned"). Aborting.');
    console.log(`[showcase] target org: ${org.name} (${org.id})`);

    // 2. Resolve showcase products by SKU.
    const showcaseProducts = await prisma.product.findMany({
      where: {
        organizationId: org.id,
        sku: { in: [...SHOWCASE_SKUS] },
        deletedAt: null,
      },
    });
    const found = new Set(showcaseProducts.map((p) => p.sku));
    const missing = SHOWCASE_SKUS.filter((s) => !found.has(s));
    if (missing.length > 0) {
      throw new Error(
        `Missing showcase SKUs in this org: ${missing.join(', ')}. Import them first.`,
      );
    }
    console.log(`[showcase] found ${showcaseProducts.length} showcase products`);

    // 3. Soft-delete every OTHER product on this org. We use updateMany +
    //    notIn so a re-run of the script after new imports cleans up again.
    const showcaseIds = showcaseProducts.map((p) => p.id);
    const culled = await prisma.product.updateMany({
      where: {
        organizationId: org.id,
        id: { notIn: showcaseIds },
        deletedAt: null,
      },
      data: { deletedAt: new Date() },
    });
    console.log(`[showcase] soft-deleted ${culled.count} non-showcase products`);

    // 4. For each showcase product: wipe existing images + upload 3 new.
    for (const product of showcaseProducts) {
      // Wipe ProductImage rows. The Asset rows themselves stay (other
      // products might reference them in theory; orphan cleanup is a
      // separate job).
      await prisma.productImage.deleteMany({ where: { productId: product.id } });

      const urls = IMAGES[product.sku];
      if (!urls || urls.length !== 3) {
        console.warn(`[showcase] no images mapped for ${product.sku}, skipping`);
        continue;
      }

      console.log(`[showcase] ${product.sku} (${product.name}) → uploading 3 images…`);
      for (let i = 0; i < urls.length; i++) {
        const url = urls[i]!;
        const { buffer, contentType } = await downloadImage(url);
        const assetId = randomUUID();
        const now = new Date();
        const yyyy = now.getUTCFullYear();
        const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
        const storageKey = `org/${org.id}/image/${yyyy}/${mm}/${assetId}${extOf(contentType)}`;
        await uploadToWasabi({
          client: s3,
          bucket: env.WASABI_BUCKET,
          key: storageKey,
          body: buffer,
          contentType,
        });
        const asset = await prisma.asset.create({
          data: {
            id: assetId,
            organizationId: org.id,
            kind: 'image',
            storageKey,
            contentType,
            byteSize: buffer.length,
            metadata: { source: 'aligned-showcase-seed', sourceUrl: url },
          },
        });
        await prisma.productImage.create({
          data: {
            organizationId: org.id,
            productId: product.id,
            assetId: asset.id,
            altText: `${product.name} — image ${i + 1}`,
            sortOrder: i,
            isPrimary: i === 0,
          },
        });
        console.log(`[showcase]   uploaded ${i + 1}/3 (${(buffer.length / 1024).toFixed(0)} KB)`);
      }
    }

    console.log('\n[showcase] ✓ done. ALIGNED catalog now has 5 products, 3 images each.');
  } finally {
    await prisma.$disconnect();
  }

  // SELF-DESTRUCT — remove this script so it can't accidentally re-run.
  // Done last + only on success (caught errors propagate before we get
  // here). The caller commits the file removal afterward.
  try {
    const here = fileURLToPath(import.meta.url);
    unlinkSync(here);
    console.log(`[showcase] script removed: ${here}`);
    console.log('[showcase] remember to commit the deletion so it doesn\'t come back on next deploy.');
  } catch (err) {
    console.warn('[showcase] could not self-delete script (permissions?):', err);
  }
}

main().catch((err) => {
  console.error('\n[showcase] FAILED:', err instanceof Error ? err.message : err);
  process.exit(1);
});
