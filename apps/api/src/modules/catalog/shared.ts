import { presignGetUrl, publicUrlFor } from '../../lib/storage.js';

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

/** Resolve a public or signed URL for an asset's storage key. */
export async function resolveAssetUrl(storageKey: string): Promise<string> {
  return publicUrlFor(storageKey) ?? (await presignGetUrl(storageKey));
}

/**
 * Cursor pagination using opaque base64-encoded JSON cursors.
 * Used by product/service list endpoints.
 */
export function encodeCursor(payload: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

export function decodeCursor<T = Record<string, unknown>>(cursor: string | undefined): T | null {
  if (!cursor) return null;
  try {
    return JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as T;
  } catch {
    return null;
  }
}

/** Maximum number of fan-out queries we'll run for a single list response. */
export const MAX_LIST_LIMIT = 100;
