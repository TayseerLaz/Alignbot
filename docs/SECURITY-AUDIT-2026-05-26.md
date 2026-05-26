# ALIGNED Business Platform — Security Assessment & Remediation Plan

**Assessor:** Senior Cybersecurity & Data Analyst (Claude)
**Date:** 2026-05-26
**Target:** ALIGNED Business Platform (multi-tenant SaaS — catalogs, chatbot read API, WhatsApp inbox, broadcasts)
**Scope:** apps/api, apps/worker, apps/web, packages/db, infra/caddy. Phase 1 — Phase 8 code as of commit `e53a807`.
**Methodology:** White-box code review + threat modelling against OWASP Top 10 (2021), OWASP API Security Top 10 (2023), SAMM, and platform-specific multi-tenant SaaS risks.

---

## 1. Executive Summary

The platform is **fundamentally well-built**: tenant isolation is defense-in-depth (Postgres RLS + non-superuser role + per-request `SET LOCAL`), input validation is Zod-everywhere, secrets are properly hashed at rest, HMAC verification is timing-safe, and the prior RLS-bypass incident is definitively resolved. The codebase exhibits the discipline of a security-aware team.

That said, this assessment surfaces **3 Critical, 5 High, 7 Medium, and 6 Low findings** — the vast majority concentrated in two areas the operator explicitly called out:

- **HTTP security headers** — CSP is disabled; the API ships with no script/style/frame policy.
- **Rate limiting** — two unauthenticated, high-leverage endpoints (inbound webhooks, CSV multipart upload) are not rate-limited beyond the global ceiling, and the global ceiling is per-IP (trivial to bypass with proxies).

If a single attacker were briefed on this report, the **highest-impact exploit chain** would be:
1. Steal a session via SSE token leakage (Critical #1) → ride an admin's session for 30 days (Critical #2).
2. Or: enumerate connectorIds (which appear in URLs) and DoS the worker queue via unrate-limited inbound webhooks (Medium #2).
3. Or: brute-force TOTP at unlimited speed on a known admin email (High #1).

All three are fixable within ~2 days of work. None require architectural change.

---

## 2. Penetration Test Findings

### 2.1 Severity & Scoring

| ID | Severity | Category | Title | OWASP |
|----|----------|----------|-------|-------|
| C-1 | **CRITICAL** | Auth | Access token accepted via `?token=` query param | A02, A09 |
| C-2 | **CRITICAL** | Auth | 30-day refresh token TTL default | A07 |
| C-3 | **CRITICAL** | Headers | Content-Security-Policy disabled | A05 |
| H-1 | High | Auth | TOTP has no brute-force protection | A07 |
| H-2 | High | SSRF | Webhook endpoint URL not validated for private IPs | A10 |
| H-3 | Auth | Switch-org refresh skips membership re-check for ALIGNED admins | A01 |
| H-4 | Auth | Email verification bypassed via invitation acceptance | A07 |
| H-5 | Rate | Inbound webhook receiver has no per-route rate limit | A04 |
| M-1 | Medium | Rate | Multipart CSV upload has no per-user rate limit | A04 |
| M-2 | Medium | Auth | Refresh tokens lack family/reuse detection | A07 |
| M-3 | Medium | Auth | Recovery codes can be lost on response interruption | A07 |
| M-4 | Medium | Auth | Password reset token not invalidated on login | A07 |
| M-5 | Medium | Auth | Account enumeration via timing on forgot-password | A07 |
| M-6 | Medium | Provenance | Verify cross-tenant gate on `/inbox` provenance reads | A01 |
| M-7 | Medium | Headers | Caddy TLS minimum version not pinned | A02 |
| L-1 | Low | Auth | JWT verify doesn't pin algorithm allowlist | A02 |
| L-2 | Low | Crypto | Connector lookup is a (very weak) timing oracle | A04 |
| L-3 | Low | Logging | Audit log not tamper-evident (no hash chain) | A09 |
| L-4 | Low | Headers | Referrer-Policy inconsistent between portal & API | — |
| L-5 | Low | Auth | Sentry DSN must be the client (read-only) key in prod | A05 |
| L-6 | Low | Auth | TOTP allows ±1 step (60s) instead of ±0 (30s) | A07 |

### 2.2 Critical Findings — Details

#### C-1 · Access token accepted via `?token=` query string
**File:** [apps/api/src/plugins/auth.ts:27-30](apps/api/src/plugins/auth.ts#L27-L30)
**OWASP:** A02:2021 (Cryptographic Failures), A09:2021 (Security Logging & Monitoring Failures)
**CVSS:** 7.5 (High → upgraded to Critical for this platform because access tokens carry `is_aligned_admin`)

The auth plugin falls back to `?token=` for SSE because EventSource can't set headers. URL query strings are:
- written to access logs (Caddy, CloudFront, every proxy in the chain),
- written to browser history,
- sent in `Referer` headers to any image/script linked from the page,
- visible in `process.title` on some platforms,
- captured by browser extensions and developer tools history.

A stolen access token (15-min TTL, fine in isolation) combined with a stolen refresh cookie (cookies follow standard browser controls) is a full session.

**Exploit walkthrough.** Open the /inbox in any modern browser → an EventSource is opened to `/api/v1/inbox/events?token=eyJhbG...` → the URL appears in DevTools → Network → and in the dev server's access log → any third-party JS on the page (Sentry replays, Posthog, etc.) sees the URL.

**Fix.** Don't accept query-param tokens. Implement an SSE-bootstrap endpoint that exchanges the cookie for a short-lived (30s, single-use) signed nonce; the EventSource URL carries the nonce, server swaps it for a session at SSE connect.

---

#### C-2 · 30-day refresh token TTL default
**File:** [apps/api/src/lib/env.ts:20](apps/api/src/lib/env.ts#L20)
**OWASP:** A07:2021 (Identification & Authentication Failures)
**CVSS:** 6.5

`JWT_REFRESH_TTL_SECONDS` defaults to 2,592,000 (30 days). Combined with the missing **token family / reuse detection** (M-2), a refresh token that leaks (via C-1, via a stolen device, via a misplaced cookie jar) grants 30 days of access — silently.

**Fix.** Default to 7 days. The ops team can raise it via env if needed. Pair with M-2 (family tracking → revoke on reuse) to make leak windows hours, not days.

---

#### C-3 · Content-Security-Policy disabled
**File:** [apps/api/src/server.ts:146](apps/api/src/server.ts#L146)
**OWASP:** A05:2021 (Security Misconfiguration)
**CVSS:** 6.1

Literal code: `await app.register(helmet, { contentSecurityPolicy: false });`

The API ships with **no CSP**. While `apps/web` is a Next.js portal (different origin, separate hardening), the API serves Swagger UI at `/docs` and `/docs/chatbot` — both are first-party UI surfaces. A single stored-XSS via a Swagger description string, OpenAPI tag, or an error-message reflection becomes JS execution with `document.cookie` access. The `apps/web` `next.config.ts` *does* set X-Frame-Options + Referrer-Policy + Permissions-Policy on every route, but **also has no CSP**.

**Fix.** Add a strict CSP on both surfaces — see §3.1 below for the exact policy to ship.

---

### 2.3 High Findings — Details

#### H-1 · TOTP has no brute-force protection
**File:** [apps/api/src/modules/auth/auth.service.ts:180-211](apps/api/src/modules/auth/auth.service.ts#L180-L211)

Password failures increment `failedLoginAttempts` and lock the user after 5 attempts. **TOTP failures do not.** An attacker with a leaked password but no TOTP code can brute-force all 10⁶ codes at the global API rate limit. At ~100 req/sec they exhaust the space in ~3 hours.

**Fix.** Add a `failedTotpAttempts` counter (or reuse `failedLoginAttempts`) and lock the account on 5 failed TOTPs. Apply the auth-route rate limit specifically to the TOTP-verify endpoint (currently it's inline in the login flow).

#### H-2 · Webhook endpoint URL not SSRF-validated
**File:** [apps/api/src/modules/webhooks/webhooks.routes.ts:76](apps/api/src/modules/webhooks/webhooks.routes.ts#L76)

The repo already ships `assertSafeOutboundUrl()` from `@aligned/shared` and uses it on the API connector route ([connector.routes.ts:100, 177, 315](apps/api/src/modules/connectors/connector.routes.ts#L100)). It is **not** used on the webhook endpoint route. A tenant admin can register `http://169.254.169.254/latest/meta-data/iam/security-credentials/` or `http://localhost:9200/_search` as a webhook URL — the worker will dutifully POST signed payloads there.

**Fix.** Wrap `req.body.url` in `assertSafeOutboundUrl()` on both POST and PATCH. One-line change.

#### H-3 · Switch-org refresh skips membership re-check for ALIGNED admins
**File:** [apps/api/src/modules/auth/auth.service.ts:~335 + 689-695](apps/api/src/modules/auth/auth.service.ts#L689-L695)

When a refresh token is exchanged, if the user is `is_aligned_admin`, the org-membership re-check is skipped. If an ALIGNED admin is later removed from a specific org, their active session can continue to refresh tokens scoped to that org.

**Fix.** Always re-check membership on refresh, regardless of `is_aligned_admin`. Aligned admins legitimately have cross-tenant access via `requireAlignedAdmin` — but that should be an *explicit* path, not an implicit refresh-time bypass.

#### H-4 · Invitation acceptance bypasses email verification
**File:** [apps/api/src/modules/auth/auth.service.ts:651](apps/api/src/modules/auth/auth.service.ts#L651)

`acceptInvitation` sets `emailVerifiedAt = new Date()` on any user who walks through the flow — including a brand-new user who has never proven they control the email. An attacker who guesses or leaks an invitation token (or invites are sent to a typo'd address) can claim the account.

**Fix.** Set `emailVerifiedAt` only when the user is *both* (a) clicking from the invitation email itself AND (b) the user is brand new. For existing unverified users, send them through the standard verify flow.

#### H-5 · Inbound webhook receiver has no per-route rate limit
**File:** [apps/api/src/modules/connectors/inbound-webhook.routes.ts](apps/api/src/modules/connectors/inbound-webhook.routes.ts) (the comment at line 45 reads *"No preHandler — this is public (HMAC-verified)."*)

The inbound webhook receiver enqueues a BullMQ sync job per request. The global rate limit is per-IP — an attacker rotating IPs and hitting any valid `connectorId` URL bypasses it. HMAC verification fails fast, but the queue fills with rejected attempts and Redis I/O burns CPU.

**Fix.** Add `config: { rateLimit: { max: 30, timeWindow: '1 second', keyGenerator: req => req.params.connectorId } }` so the limit is *per connector*, not per IP. Also reject early when the HMAC header is missing (don't enqueue).

---

### 2.4 Medium Findings — Details

#### M-1 · Multipart CSV upload has no per-user rate limit
**File:** [apps/api/src/modules/storage/multipart-upload.routes.ts:70](apps/api/src/modules/storage/multipart-upload.routes.ts#L70)

Only `requireRole('editor')` guards uploads. A compromised editor account can queue dozens of 50 MB imports per minute, each pinned to Wasabi + Redis + a worker thread.

**Fix.** Add per-user/per-org limit: 5 uploads/minute is generous.

#### M-2 · Refresh tokens lack family / reuse detection
**File:** [apps/api/src/modules/auth/auth.service.ts:311-367](apps/api/src/modules/auth/auth.service.ts#L311-L367)

Rotation is implemented; family tracking is not. The industry-standard OAuth 2.1 pattern: when a *previously rotated* refresh token is presented, revoke the entire family. Currently the second use silently fails.

**Fix.** Add `refreshTokenFamily` (UUID) and `parentTokenHash` columns. On rotation, mark the parent as `rotated`. On any subsequent use of a token whose hash is `rotated`, revoke the entire family + force re-login.

#### M-3 · Recovery codes can be lost on response interruption
**File:** [apps/api/src/modules/account/2fa.routes.ts:153-172](apps/api/src/modules/account/2fa.routes.ts#L153-L172)

Recovery codes are generated, immediately hashed, and returned in the response body. If the network drops between server and client, the user is locked into 2FA with no recovery path.

**Fix.** Make the enable flow two-step: (1) generate codes, persist to a *transient* table with a short TTL; (2) require the user to confirm receipt via a "I saved these" button before the codes hash-and-stick.

#### M-4 · Password reset token not invalidated on login
**File:** [apps/api/src/modules/auth/auth.service.ts:233](apps/api/src/modules/auth/auth.service.ts#L233)

Successful login clears `failedLoginAttempts` and `lockedUntil` but does *not* clear `passwordResetTokenHash` / `passwordResetExpiresAt`. A reset link sent before login remains usable.

**Fix.** Add the reset-token fields to the clear set in the login success block.

#### M-5 · Account enumeration via timing
**File:** [apps/api/src/modules/auth/auth.service.ts:408-426](apps/api/src/modules/auth/auth.service.ts#L408-L426)

`forgotPassword` returns 200 OK for non-existent emails but skips the email-send branch — making the response ~100ms faster for non-users. Trivial to enumerate at scale.

**Fix.** Constant-time the path: enqueue the email send job either way, drop it server-side if the user doesn't exist (or, even simpler, always sleep for ~100ms when the user lookup misses).

#### M-6 · Verify provenance read-gate
**File:** [apps/api/src/modules/whatsapp-inbox/inbox.routes.ts](apps/api/src/modules/whatsapp-inbox/inbox.routes.ts), [apps/api/src/modules/admin/admin.routes.ts](apps/api/src/modules/admin/admin.routes.ts) (provenance routes)

The Phase 8 message provenance store contains full system prompts + conversation history + KB candidate rows for every bot reply. The cross-tenant browser at `/aligned-admin/provenance` is correctly gated by `requireAlignedAdmin`. The *per-thread* inline panel in `/inbox` needs to be confirmed: ALIGNED-admin-only on read, RLS catches it as a backstop. Code review suggests this is correct, but I could not verify the UI condition in this pass.

**Action.** Add a regression test that asserts an org admin (not aligned admin) calling `GET /api/v1/inbox/messages/:id/provenance` receives 403, and confirms RLS denies it as a second layer.

#### M-7 · Caddy TLS minimum version not pinned
**File:** [infra/caddy/Caddyfile:74-76](infra/caddy/Caddyfile#L74-L76)

The `on_demand` TLS block for custom CNAMEs doesn't pin a minimum version; the default is TLS 1.2 which is fine but explicit is better.

**Fix.** Add `protocols tls1.3` (or `tls1.2 tls1.3`) under the `tls` blocks. ALIGNED's customer base is modern; TLS 1.3 only is realistic.

---

### 2.5 Low Findings — Details (one-liners)

- **L-1** [apps/api/src/lib/jwt.ts](apps/api/src/lib/jwt.ts) — explicitly pin `algorithms: ['HS256']` on `jwtVerify` calls. `jose` is sane by default but explicit beats implicit.
- **L-2** [apps/api/src/modules/connectors/inbound-webhook.routes.ts](apps/api/src/modules/connectors/inbound-webhook.routes.ts) — connector-not-found and bad-HMAC return at different times. Negligible information leak (an attacker who knows the connectorId already knows the org). Document and move on.
- **L-3** Audit log table has no hash chain or write-once enforcement. Acceptable for Phase 1; revisit if compliance (SOC2 type 2, HIPAA) is in scope.
- **L-4** [infra/caddy/Caddyfile:20, 54](infra/caddy/Caddyfile#L20) — Portal uses `strict-origin-when-cross-origin`, API uses `no-referrer`. Unify to `strict-origin-when-cross-origin`.
- **L-5** Confirm at deploy time that `SENTRY_DSN` is the project's *client* DSN (read-only ingest). Document in `docs/RUNBOOK.md` § secrets.
- **L-6** [apps/api/src/lib/totp.ts:72](apps/api/src/lib/totp.ts#L72) — `±1` step window allows code reuse for up to 60s. Standard, but you can tighten to `0` for security-sensitive admins.

---

## 3. Deep Dive — Headers (operator-requested)

### 3.1 Recommended Helmet Config (apps/api/src/server.ts:146)

Replace `contentSecurityPolicy: false` with:

```ts
await app.register(helmet, {
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      'default-src': ["'self'"],
      'script-src': ["'self'"],          // Swagger UI bundles its own JS at /docs
      'style-src': ["'self'", "'unsafe-inline'"], // Swagger needs inline styles
      'img-src': ["'self'", 'data:', 'https://*.wasabisys.com'],
      'connect-src': ["'self'"],
      'frame-ancestors': ["'none'"],
      'object-src': ["'none'"],
      'base-uri': ["'self'"],
      'form-action': ["'self'"],
      'upgrade-insecure-requests': [],
    },
  },
  crossOriginEmbedderPolicy: false,       // breaks Swagger UI otherwise
  crossOriginOpenerPolicy: { policy: 'same-origin' },
  crossOriginResourcePolicy: { policy: 'same-site' },
  hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
  noSniff: true,
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  permittedCrossDomainPolicies: { permittedPolicies: 'none' },
  xssFilter: false,                       // deprecated; CSP supersedes
});
```

Verify in dev: `curl -I https://localhost:4000/health` should show every header above. Test that `/docs` Swagger still loads.

### 3.2 Next.js Portal Headers (apps/web/next.config.ts)

Add CSP to the existing headers array:

```ts
{
  key: 'Content-Security-Policy',
  value: [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval'", // Next.js needs these in dev; tighten with nonce in prod
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https://*.wasabisys.com",
    `connect-src 'self' ${process.env.NEXT_PUBLIC_API_URL ?? ''} https://*.sentry.io`,
    "frame-ancestors 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "upgrade-insecure-requests",
  ].join('; '),
}
```

For prod, generate per-request nonces and drop `'unsafe-inline'`/`'unsafe-eval'` from `script-src`. This is a separate engineering task — schedule it for after the initial CSP rollout proves stable.

### 3.3 Caddy Edge Headers

Caddyfile already sets HSTS, X-Frame-Options, X-Content-Type-Options, Permissions-Policy, Referrer-Policy. Add:

```caddy
header {
  # Defense in depth — these can be removed once Helmet + Next ship CSP
  Cross-Origin-Opener-Policy "same-origin"
  Cross-Origin-Resource-Policy "same-site"
  -Server
  -X-Powered-By
}

tls {
  protocols tls1.2 tls1.3
}
```

Also: remove the `no-referrer` on the API block — `strict-origin-when-cross-origin` is the right default for both.

---

## 4. Deep Dive — Rate Limits (operator-requested)

### 4.1 Current Posture

| Surface | Limit | Key | Verdict |
|---|---|---|---|
| Global `/api/v1/*` | `RATE_LIMIT_API_PER_SECOND` (default 100) | IP | OK as baseline |
| `/api/v1/read/*` | `RATE_LIMIT_READ_API_PER_SECOND` (default 200) | API key | Good |
| `/api/v1/auth/*` | `RATE_LIMIT_AUTH_PER_MINUTE` (default 10) | IP | Good |
| Inbound webhooks | Global only | IP | **Gap** (H-5) |
| Multipart upload | Global only | IP | **Gap** (M-1) |
| TOTP verify | Global only | IP | **Gap** (H-1) |

### 4.2 Recommended Per-Route Limits

```ts
// inbound-webhook.routes.ts — per connector
config: { rateLimit: { max: 30, timeWindow: '1 second',
  keyGenerator: (req) => `inbound:${req.params.connectorId}` } }

// multipart-upload.routes.ts — per user
config: { rateLimit: { max: 5, timeWindow: '1 minute',
  keyGenerator: (req) => `upload:${req.auth!.userId}` } }

// totp verify — per user
config: { rateLimit: { max: 5, timeWindow: '1 minute',
  keyGenerator: (req) => `totp:${req.body.email}` } }

// password reset request — per email
config: { rateLimit: { max: 3, timeWindow: '15 minutes',
  keyGenerator: (req) => `reset:${req.body.email?.toLowerCase()}` } }

// signup — per IP, with email field as a soft secondary
config: { rateLimit: { max: 3, timeWindow: '10 minutes' } }
```

### 4.3 Trust-Proxy Sanity Check

`server.ts:114` has `trustProxy: true` which is correct *only* when running behind a known proxy (Caddy). When deployed direct-to-public, this lets any client spoof `X-Forwarded-For` and bypass IP-based limits. Document in RUNBOOK that the API must never face the public internet directly.

### 4.4 Redis Shared State

`@fastify/rate-limit` is wired with `redis: getRedis()` — limits are correctly shared across the 2 replicas behind Caddy. ✓

### 4.5 E2E Bypass

`x-e2e-run: 1` header bypass is correctly gated on `NODE_ENV !== 'production'`. ✓

---

## 5. Remediation Plan

### 5.1 Sprint 0 — Same-day Hot Fixes (4 hours)

| # | Task | Files | Owner |
|---|------|-------|-------|
| 1 | Drop `?token=` query-param fallback; build SSE nonce-exchange endpoint | apps/api/src/plugins/auth.ts, apps/api/src/modules/whatsapp-inbox/inbox.routes.ts, apps/web/src/.../inbox EventSource consumer | Auth lead |
| 2 | Ship base CSP via Helmet | apps/api/src/server.ts:146 | Platform |
| 3 | Ship base CSP via Next.js | apps/web/next.config.ts | Platform |
| 4 | Add `assertSafeOutboundUrl()` to webhook endpoint create/update | apps/api/src/modules/webhooks/webhooks.routes.ts:76, :130 | Platform |
| 5 | Default `JWT_REFRESH_TTL_SECONDS` → 7 days; update `.env.example` | apps/api/src/lib/env.ts:20, `.env.example` | Platform |

### 5.2 Sprint 1 — Week 1 (8–12 hours)

| # | Task | Notes |
|---|------|-------|
| 6 | Add TOTP attempt counter + lockout (H-1) | Reuse `failedLoginAttempts` or add `failedTotpAttempts` |
| 7 | Per-route rate limits: inbound webhooks, multipart upload, TOTP, signup, forgot-password | See §4.2 |
| 8 | Fix switch-org refresh membership re-check (H-3) | Audit unit test required |
| 9 | Fix invitation email verification (H-4) | Don't auto-set `emailVerifiedAt` for new users |
| 10 | Refresh token family + reuse detection (M-2) | DB migration: `refreshTokenFamily`, `parentTokenHash` |
| 11 | Clear `passwordResetToken*` on successful login (M-4) | One-line change |
| 12 | Constant-time `forgotPassword` (M-5) | Equalize the timing on the no-user path |
| 13 | Caddy: pin TLS 1.2+ and unify Referrer-Policy (M-7, L-4) | Caddyfile edit |
| 14 | Add provenance access regression test (M-6) | New Vitest |

### 5.3 Sprint 2 — Week 2 (6–10 hours)

| # | Task | Notes |
|---|------|-------|
| 15 | Two-step recovery code flow (M-3) | New UX: generate → confirm → persist |
| 16 | Explicit JWT algorithm allowlist (L-1) | `algorithms: ['HS256']` |
| 17 | Tighten Next.js CSP to nonce-based (drop `unsafe-inline`/`unsafe-eval`) | Requires Next.js middleware for nonce injection |
| 18 | Remove server tokens (`-Server`, `-X-Powered-By`) in Caddy | Caddyfile edit |
| 19 | Wasabi presigned URL scoping (audit: confirm `ContentLength` range hard caps) | Inspection only |

### 5.4 Sprint 3 — Sustaining (recurring)

| # | Practice | Cadence |
|---|----------|---------|
| 20 | Run **OWASP ZAP** baseline scan against staging | Weekly, in CI |
| 21 | Run **`npm audit` + Snyk/Dependabot** on PRs | Per-PR |
| 22 | Run **k6 load test** including auth + read API | Pre-deploy |
| 23 | Rotate JWT signing secret + cookie secret + Wasabi keys + Resend/SES creds | Quarterly |
| 24 | Quarterly tenant-isolation chaos test: spawn 2 orgs, randomized reads, assert no cross-leak | Quarterly |
| 25 | Sentry alert: any 5xx originating from `apps/api/src/lib/db.ts` (RLS errors look like permission-denied) | Page on-call |
| 26 | Add CI gate: deploy blocks if `tenant-isolation.test.ts` fails (already done) — extend with provenance + broadcast cross-tenant checks | Per-PR |

---

## 6. Penetration Test Cases — Re-Test Script

After Sprint 0+1, the following should all return their expected (secure) outcome. Run from outside the cluster, against staging.

```bash
# C-1: SSE query token should be rejected (after fix)
curl -sS "https://api.staging.aligned.com/api/v1/inbox/events?token=$ANY"
# expect: 401

# C-3: CSP should be present
curl -sI https://api.staging.aligned.com/health | grep -i content-security
# expect: Content-Security-Policy: default-src 'self'; ...

# H-1: TOTP brute-force should lock after 5
for i in {1..6}; do
  curl -sS -X POST https://api.staging.aligned.com/api/v1/auth/login \
    -d '{"email":"victim@example.com","password":"correctpw","totpCode":"000000"}' \
    -H content-type:application/json
done
# expect 6th: 423 Locked or 429 Too Many Requests

# H-2: webhook endpoint with private IP must be rejected
curl -sS -X POST https://api.staging.aligned.com/api/v1/webhook-endpoints \
  -H "Authorization: Bearer $ADMIN_JWT" \
  -d '{"url":"http://169.254.169.254/latest/meta-data/","eventKinds":["product.updated"]}'
# expect: 400 unsafe_url

# H-5: inbound webhook flood should rate-limit per connector
seq 1 100 | xargs -P10 -I{} curl -sS -o /dev/null -w "%{http_code}\n" \
  -X POST https://api.staging.aligned.com/api/v1/webhooks/inbound/$CONN_ID \
  -d '{}' | sort | uniq -c
# expect: a meaningful count of 429s

# Headers: HSTS + COOP + CSP + Referrer-Policy + Permissions-Policy
curl -sI https://app.staging.aligned.com/ | grep -iE "strict-transport|cross-origin|content-security|referrer-policy|permissions-policy"
```

---

## 7. What's Already Right (don't regress)

- ✅ Postgres RLS on all 45+ tenant-scoped tables + non-superuser `aligned_app` connection role + per-transaction `SET LOCAL`.
- ✅ Zod validation on every route; no `.passthrough()` / `.any()` smell on inputs.
- ✅ HMAC verification (outbound webhooks, inbound webhooks, Meta WhatsApp) uses raw body + timing-safe compare + 5-min skew window.
- ✅ API keys hashed at rest (sha256, acceptable for 192-bit random tokens); secret shown once.
- ✅ Bcrypt cost 12 for passwords.
- ✅ httpOnly + Secure + SameSite=Lax cookies, scoped path.
- ✅ Pino redact config covers Authorization, Cookie, X-Aligned-Api-Key, passwords, hashes — no secrets in logs.
- ✅ Error handler hides stack traces from non-admin / production.
- ✅ Tenant-isolation integration test as a hard deploy gate.
- ✅ Rate limit uses Redis (shared across replicas).
- ✅ `trustProxy: true` correctly used because the API only sits behind Caddy.
- ✅ Connector SSRF guard exists and is consistently applied to scheduled & manual sync paths.

---

## 8. Out-of-Scope / Recommendations for a Future Phase

- **WAF / edge protection.** Caddy is fine for TLS + reverse proxy; for production traffic at scale, layer Cloudflare or AWS WAF in front, with managed rules for OWASP Top 10 and bot-detection.
- **Penetration test by external firm.** White-box review surfaces a lot; a black-box test by an outside firm (e.g. NCC, Doyensec) before onboarding regulated customers (healthcare, finance) is worth the spend.
- **SOC2 readiness.** Add tamper-evident audit log (hash-chain), formalize access reviews, document key rotation runbook.
- **Bug bounty.** Once the surface is clean (post-Sprint 1), open a private bounty program on HackerOne or Intigriti starting at $100-$2k for criticals.

---

**Total estimated remediation effort:** ~22 engineering hours across 2 weeks. None of the findings are architectural; all are tractable patches.

**The most consequential single fix** is C-1 (kill the `?token=` SSE path). Do it before C-3 / H-* if you can only do one.
