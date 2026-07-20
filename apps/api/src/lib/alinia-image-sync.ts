// Re-host Alinia mirror listing photos into Hader Asset + ProductImage rows so
// the bot's EXISTING WhatsApp image-send + Meta media_id cache light up for
// properties (both read ProductImage -> Asset.storageKey; they don't care that
// the row is a mirror). Alinia-only: invoked solely from /partner/ingest, and
// every row created is tagged sourceSystem='alinia'. Idempotent by
// Asset.metadata.aliniaImageUrl so re-syncs reuse assets and keep the media_id
// cache warm (never delete+recreate an unchanged image).
import crypto from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';

import { withAliniaSync } from './db.js';
import { buildStorageKey, isStorageConfigured, putObject } from './storage.js';

const MAX_BYTES = 10 * 1024 * 1024;
const MAX_IMAGES_PER_LISTING = 8;

export interface MirrorImageItem {
  productId: string;
  imageUrls: string[];
}

/** Reject loopback / private / link-local (incl. cloud metadata 169.254.169.254). */
function isPrivateIp(ip: string): boolean {
  if (isIP(ip) === 4) {
    const parts = ip.split('.').map(Number);
    const a = parts[0] ?? 0;
    const b = parts[1] ?? 0;
    if (a === 0 || a === 127 || a === 10) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    return false;
  }
  const low = ip.toLowerCase();
  return (
    low === '::1' ||
    low === '::' ||
    low.startsWith('fc') ||
    low.startsWith('fd') ||
    low.startsWith('fe80')
  );
}

/** Fetch an image with SSRF + size + content-type guards. Returns null on any problem. */
async function safeFetchImage(url: string): Promise<{ body: Buffer; contentType: string } | null> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:') return null;
  try {
    const host = u.hostname;
    if (isIP(host)) {
      if (isPrivateIp(host)) return null;
    } else {
      const addrs = await dnsLookup(host, { all: true });
      if (!addrs.length || addrs.some((r) => isPrivateIp(r.address))) return null;
    }
  } catch {
    return null;
  }
  let res: Response;
  try {
    // redirect:'error' blocks redirect-to-internal rebind; our image hosts serve directly.
    res = await fetch(u, { redirect: 'error', signal: AbortSignal.timeout(15_000) });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  const ct = (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  if (!ct.startsWith('image/')) return null;
  if (Number(res.headers.get('content-length') ?? '0') > MAX_BYTES) return null;
  const body = Buffer.from(await res.arrayBuffer());
  if (body.length === 0 || body.length > MAX_BYTES) return null;
  return { body, contentType: ct };
}

function extForMime(mime: string): string {
  if (mime === 'image/png') return 'png';
  if (mime === 'image/webp') return 'webp';
  if (mime === 'image/gif') return 'gif';
  return 'jpg';
}

/**
 * Reconcile one product's mirror images: reuse assets already stored for a URL,
 * fetch+store newly-added ones, re-point sortOrder/isPrimary, and drop removed
 * links. Network + S3 I/O happens OUTSIDE the DB transaction; a single short
 * withAliniaSync burst does the Asset/ProductImage writes.
 */
async function syncOne(orgId: string, productId: string, urls: string[]): Promise<void> {
  const wanted = urls.slice(0, MAX_IMAGES_PER_LISTING);

  const existing = await withAliniaSync(orgId, (tx) =>
    tx.productImage.findMany({
      where: { productId, sourceSystem: 'alinia' },
      select: { id: true, assetId: true, asset: { select: { metadata: true } } },
    }),
  );
  const urlToAsset = new Map<string, string>();
  for (const pi of existing) {
    const md = pi.asset?.metadata as Record<string, unknown> | null;
    const u = md && typeof md.aliniaImageUrl === 'string' ? md.aliniaImageUrl : null;
    if (u) urlToAsset.set(u, pi.assetId);
  }

  interface NewAsset {
    id: string;
    url: string;
    storageKey: string;
    contentType: string;
    byteSize: number;
    checksum: string;
  }
  const newAssets: NewAsset[] = [];
  const finalOrder: { assetId: string; sortOrder: number; isPrimary: boolean }[] = [];

  for (let i = 0; i < wanted.length; i++) {
    const url = wanted[i]!;
    let assetId = urlToAsset.get(url) ?? null;
    if (!assetId) {
      const img = await safeFetchImage(url);
      if (!img) continue; // skip this photo, keep the rest
      const id = crypto.randomUUID();
      const storageKey = buildStorageKey({
        organizationId: orgId,
        kind: 'alinia-listing-image',
        assetId: id,
        filename: `p.${extForMime(img.contentType)}`,
      });
      await putObject({ storageKey, body: img.body, contentType: img.contentType });
      newAssets.push({
        id,
        url,
        storageKey,
        contentType: img.contentType,
        byteSize: img.body.length,
        checksum: crypto.createHash('sha256').update(img.body).digest('hex'),
      });
      assetId = id;
    }
    finalOrder.push({ assetId, sortOrder: i, isPrimary: i === 0 });
  }

  const keep = new Set(finalOrder.map((f) => f.assetId));
  const removeIds = existing.filter((pi) => !keep.has(pi.assetId)).map((pi) => pi.id);

  if (newAssets.length === 0 && finalOrder.length === 0 && removeIds.length === 0) return;

  await withAliniaSync(orgId, async (tx) => {
    for (const a of newAssets) {
      await tx.asset.create({
        data: {
          id: a.id,
          organizationId: orgId,
          kind: 'image',
          storageKey: a.storageKey,
          contentType: a.contentType,
          byteSize: a.byteSize,
          checksumSha256: a.checksum,
          metadata: { sourceSystem: 'alinia', aliniaImageUrl: a.url },
        },
      });
    }
    for (const f of finalOrder) {
      await tx.productImage.upsert({
        where: { productId_assetId: { productId, assetId: f.assetId } },
        create: {
          organizationId: orgId,
          productId,
          assetId: f.assetId,
          sourceSystem: 'alinia',
          sortOrder: f.sortOrder,
          isPrimary: f.isPrimary,
        },
        update: { sortOrder: f.sortOrder, isPrimary: f.isPrimary },
      });
    }
    // Drop links the agent removed/reordered out. Assets are left in place
    // (cheap, reusable across re-syncs); a future reconcile can GC orphans.
    if (removeIds.length) {
      await tx.productImage.deleteMany({ where: { id: { in: removeIds } } });
    }
  });
}

/** Re-host photos for a batch of mirror listings. Best-effort per product. */
export async function syncMirrorImages(orgId: string, items: MirrorImageItem[]): Promise<void> {
  if (!isStorageConfigured()) return;
  for (const it of items) {
    if (!it.imageUrls.length) continue;
    try {
      await syncOne(orgId, it.productId, it.imageUrls);
    } catch (err) {
      console.error('[alinia-image-sync] product', it.productId, 'failed:', err);
    }
  }
}
