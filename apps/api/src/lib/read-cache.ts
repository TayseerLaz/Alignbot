// Redis cache for the chatbot read API.
//
// Cache key shape: `read:{orgId}:{endpoint}:{queryHash}`
// We invalidate by prefix on any write to that org's catalog (`read:{orgId}:*`).
// Uses Redis SCAN so we never block on a huge KEYS call in prod.
import { createHash } from 'node:crypto';

import { getRedis } from './redis.js';

const TTL_SECONDS = 60;
const STALE_TTL_SECONDS = 300;

interface CachedEntry<T> {
  value: T;
  storedAt: number;
}

function cacheKey(orgId: string, endpoint: string, query: Record<string, unknown> | null) {
  const normalised = query
    ? Object.keys(query)
        .sort()
        .map((k) => `${k}=${String(query[k])}`)
        .join('&')
    : '';
  const hash = createHash('sha1').update(normalised).digest('hex').slice(0, 16);
  return `read:${orgId}:${endpoint}:${hash}`;
}

export async function readCacheGet<T>(
  orgId: string,
  endpoint: string,
  query: Record<string, unknown> | null,
): Promise<{ value: T; stale: boolean } | null> {
  try {
    const redis = getRedis();
    const raw = await redis.get(cacheKey(orgId, endpoint, query));
    if (!raw) return null;
    const entry = JSON.parse(raw) as CachedEntry<T>;
    const age = (Date.now() - entry.storedAt) / 1000;
    return { value: entry.value, stale: age > TTL_SECONDS };
  } catch (err) {
    console.error('[read-cache] get failed', err);
    return null;
  }
}

export async function readCacheSet<T>(
  orgId: string,
  endpoint: string,
  query: Record<string, unknown> | null,
  value: T,
): Promise<void> {
  try {
    const redis = getRedis();
    const entry: CachedEntry<T> = { value, storedAt: Date.now() };
    await redis.set(cacheKey(orgId, endpoint, query), JSON.stringify(entry), 'EX', STALE_TTL_SECONDS);
  } catch (err) {
    console.error('[read-cache] set failed', err);
  }
}

/** Delete every cache entry for a given org. Called after any catalog write. */
export async function invalidateReadCache(orgId: string): Promise<void> {
  const redis = getRedis();
  const pattern = `read:${orgId}:*`;
  let cursor = '0';
  do {
    // SCAN is non-blocking — preferable to KEYS on large databases.
    const [next, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 200);
    cursor = next;
    if (keys.length > 0) await redis.del(...keys);
  } while (cursor !== '0');
}
