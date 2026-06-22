// SSRF-safe outbound fetch for tenant-triggered requests (connector test
// probes, etc.). Combines the synchronous URL guard (scheme/credentials/
// literal-IP) with a DNS-resolving + IP-pinning undici dispatcher that closes
// the DNS-rebinding hole (F-05).
import { assertSafeOutboundUrl } from '@aligned/shared';
import { ssrfSafeLookup } from '@aligned/shared/ssrf';
import { Agent } from 'undici';

let dispatcher: Agent | null = null;

/** Lazily-built undici Agent that refuses to connect to private/loopback IPs. */
export function ssrfSafeDispatcher(): Agent {
  if (!dispatcher) {
    dispatcher = new Agent({ connect: { lookup: ssrfSafeLookup } });
  }
  return dispatcher;
}

/**
 * Drop-in `fetch` for outbound calls to tenant-supplied URLs. Validates the
 * URL up front (throws `UrlGuardError`) and pins the connection to a
 * validated public IP. Throws on a rebinding attempt at connect time.
 */
export async function safeFetch(url: string, init?: RequestInit): Promise<Response> {
  assertSafeOutboundUrl(url);
  return fetch(url, { ...init, dispatcher: ssrfSafeDispatcher() } as RequestInit & {
    dispatcher: Agent;
  });
}
