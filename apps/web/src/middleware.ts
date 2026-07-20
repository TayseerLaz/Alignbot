// Sprint 2 #17 — Nonce-based Content-Security-Policy.
//
// The static CSP shipped in next.config.ts had to allow `'unsafe-inline'` and
// `'unsafe-eval'` on script-src because Next.js injects its own hydration
// bootstrap as inline JS. That defeats the point of CSP for stored-XSS
// protection.
//
// This middleware generates a per-request nonce. The response carries a CSP
// header that trusts that nonce on script-src, plus `'strict-dynamic'` so
// chunks loaded by Next.js's runtime inherit the trust. The nonce is also
// forwarded into the request via `x-nonce` so the root layout (and any other
// server component) can attach it to inline `<script>` elements.
//
// Style-src keeps `'unsafe-inline'` because Tailwind v4 + Next.js inject
// inline styles that are not nonce-aware. Style-based attacks are far less
// powerful than script-based ones, so this is an acceptable trade-off.
import { NextResponse, type NextRequest } from 'next/server';

const API_ORIGIN = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

function buildCsp(nonce: string): string {
  return [
    "default-src 'self'",
    // 'strict-dynamic' lets Next.js's own bootstrap script load further
    // scripts without each needing an explicit allowlist entry.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`,
    // Style sources stay inline-permissive for the framework's CSS-in-JS.
    "style-src 'self' 'unsafe-inline'",
    // Service worker (/app/sw.js). Without an explicit worker-src, the browser
    // falls back to script-src — whose 'strict-dynamic' drops 'self' and would
    // block the same-origin SW from registering. Pin it to 'self' here.
    "worker-src 'self'",
    // PWA manifest is same-origin; keep it explicit alongside default-src.
    "manifest-src 'self'",
    // Alinia real-estate mirror: listing photos are served from the Alinia
    // media proxy (www.aliniarealestate.com/api/media/*); picsum is the demo
    // seed host. Without these, CSP blocks the mirrored <img> thumbnails.
    "img-src 'self' data: blob: https://*.wasabisys.com https://www.aliniarealestate.com https://aliniarealestate.com https://picsum.photos",
    // Wasabi is in connect-src AND in img-src/media-src below: the browser
    // does a presigned PUT (fetch → connect-src) when uploading images +
    // voice notes, then loads the resulting URL as <img>/<audio>
    // (→ img-src/media-src). Without connect-src here, CSP blocks the
    // upload itself even though the asset is allowed to render.
    `connect-src 'self' ${API_ORIGIN} https://*.sentry.io https://*.wasabisys.com`,
    "media-src 'self' blob: https://*.wasabisys.com",
    "font-src 'self' data:",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    'upgrade-insecure-requests',
  ].join('; ');
}

export function middleware(request: NextRequest): NextResponse {
  const nonce = crypto.randomUUID().replace(/-/g, '');
  const csp = buildCsp(nonce);

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('Content-Security-Policy', csp);

  const response = NextResponse.next({
    request: { headers: requestHeaders },
  });
  response.headers.set('Content-Security-Policy', csp);
  // Surface the nonce to downstream callers (Sentry, etc.) without leaking
  // a secret — the nonce is per-request and useless after the response.
  response.headers.set('x-nonce', nonce);
  return response;
}

export const config = {
  // Skip CSP for Next.js internal asset paths + the favicon/static folder.
  // Skip for prefetched RSC requests too — those don't render <head> so
  // there's no inline script to nonce.
  matcher: [
    {
      source: '/((?!api|_next/static|_next/image|favicon.ico).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
};
