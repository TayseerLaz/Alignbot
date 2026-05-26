// Short-lived, single-use credential for EventSource (SSE) authentication.
//
// EventSource cannot set Authorization headers, so historically the access
// token was passed via `?token=` — which writes it to access logs, browser
// history, and Referer headers. To eliminate that leak, the client first
// performs a normal authenticated POST /auth/sse-nonce to exchange its
// session for an opaque nonce, then connects the EventSource with
// `?nonce=<value>`. The nonce is consumed atomically (GETDEL) on first use
// and expires after 30 seconds, so even a leaked URL is worthless after the
// SSE connection is established.
import type { OrgRole } from '@aligned/shared';

import { generateOpaqueToken } from './crypto.js';
import { getRedis } from './redis.js';

const NONCE_PREFIX = 'sse-nonce:';
const NONCE_TTL_SECONDS = 30;

export type SseAuthClaims = {
  userId: string;
  organizationId: string;
  role: OrgRole;
  isAlignedAdmin: boolean;
  sessionId: string;
};

export async function issueSseNonce(claims: SseAuthClaims): Promise<string> {
  const nonce = generateOpaqueToken(24);
  await getRedis().set(
    `${NONCE_PREFIX}${nonce}`,
    JSON.stringify(claims),
    'EX',
    NONCE_TTL_SECONDS,
  );
  return nonce;
}

export async function consumeSseNonce(nonce: string): Promise<SseAuthClaims | null> {
  if (!nonce || typeof nonce !== 'string' || nonce.length < 16) return null;
  // GETDEL is atomic — guarantees single-use semantics across replicas.
  const raw = await getRedis().getdel(`${NONCE_PREFIX}${nonce}`);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as SseAuthClaims;
  } catch {
    return null;
  }
}
