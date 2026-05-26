# Security Policy

The ALIGNED Business Platform handles tenant-isolated catalog data, customer
conversations on WhatsApp, and outbound broadcasts at scale. We take security
seriously and we depend on the security community to find what we miss.

This document is the disclosure policy for the platform. It is the contract a
researcher can rely on when they reach out — and the playbook the team follows
when a report lands.

---

## Reporting a vulnerability

**Email:** `security@hader.ai`
**PGP:** Available on request.

We acknowledge every report within **2 business days** and provide a first
substantive response within **5 business days**. Critical issues are
triaged the same day they're received.

Please include:

- A clear description of the issue + impact you can demonstrate.
- The minimum reproduction steps. Screenshots / curls / video are welcome
  but plain English first.
- Your account email if testing against a hosted tenant, so we can correlate
  with our logs.

You will hear back. If you don't within 5 business days, follow up — your
report did not get lost on purpose.

---

## Scope

**In scope:**

- The web portal at `app.hader.ai` and `*.aligned.example` test
  environments shared with you on request.
- The HTTP API at `api.hader.ai` and `api.*.aligned.example`.
- The chatbot read API at `api.hader.ai/api/v1/read/*`.
- Tenant data isolation across organizations (Postgres RLS), including
  attempting to read or modify another organization's data.
- Authentication / authorisation flows: signup, login, refresh, invitations,
  password reset, TOTP 2FA, recovery codes, switch-org, account deletion.
- Stored XSS, CSRF, SSRF on user-controlled URL fields (webhooks,
  connectors).
- Server-side vulnerabilities in `apps/api`, `apps/worker`, and
  `apps/web` (this repository).
- Information disclosure — log leakage, error messages that expose
  internals, predictable IDs.

**Out of scope:**

- Findings that require physical access to a user's device or full
  control of their browser.
- Brute-force / volumetric attacks against rate-limited endpoints (we
  test these ourselves; if you find a way to bypass the limit, *that's*
  in scope).
- Social engineering of ALIGNED staff or customers.
- Anything that requires being signed in to multiple organizations
  *and* having an active membership in both — that's the documented
  ALIGNED-admin "Control" workflow, not a vulnerability.
- Self-XSS where the only victim is the attacker's own browser.
- Reports based on outdated software running on a tenant's own
  infrastructure (e.g. their browser, their WhatsApp number).
- CSP / header reports that don't include a concrete attack chain.
- Open redirects on routes we don't take user input on — show us the
  redirector first.
- Username / email enumeration via response timing where the time
  difference is < 50 ms (within normal jitter).
- Anything in `docs/`, `infra/`, or `.github/` workflows running against
  test data — those are not production attack surface.

---

## Safe harbour

We will not pursue legal action or law-enforcement complaints against
researchers who:

1. Make a good-faith effort to avoid privacy violations, service
   degradation, and data destruction during testing.
2. Only test against accounts they own or accounts the platform owner
   has explicitly authorised. **Do not pivot from your tenant into
   another tenant's data even if you find a way to.** Stop, document, and
   send us the report.
3. Do not exfiltrate more data than the minimum needed to demonstrate
   the issue. If you find a SQL-injection-shaped foothold, fetch *one*
   row, not the table.
4. Give us a reasonable disclosure window — at least **90 days from
   first report**, longer if we ask and explain why. We will agree to
   public disclosure timing in writing once the fix ships.
5. Comply with all applicable laws.

Researchers who follow this policy will be credited in our security
advisories unless they ask to remain anonymous. We will not publish your
name without your consent.

---

## Severity & rewards

We are not yet a paid bounty program. Once we open one (publicly or via
HackerOne / Intigriti), this section will reflect the live payout table.
In the meantime:

| Severity | Examples | Acknowledgement |
|----------|----------|----------------|
| **Critical** | Cross-tenant data read or write at scale; auth bypass; remote code execution. | Hall of fame + ALIGNED branded swag + a written commitment that you will be a paid bounty participant on day 1 of the program. |
| **High** | Single-tenant account takeover; sensitive secret leak; cross-tenant data leak via a narrow vector. | Hall of fame + swag. |
| **Medium** | XSS without auth context; missing security control that requires another flaw to chain. | Hall of fame. |
| **Low / Info** | Security-relevant best-practice deviation; theoretical issue with no concrete exploit. | Listed in `docs/security/acknowledgements.md` for the next release. |

---

## What we ship as fixes

A critical or high-severity fix goes through this cycle:

1. **Hotfix branch** off `main` (within hours for critical).
2. **Backports** to any active release branch.
3. **Migration + test** that locks down the regression so the same issue
   can't ship again. Tenant-isolation regressions get a dedicated test
   in `apps/api/test/tenant-isolation.test.ts` (a hard CI deploy gate).
4. **Coordinated disclosure** with the reporter. We publish an advisory
   at `docs/security/advisories/YYYY-NN.md` once the fix is live for
   all pilot tenants.

You can see the four-sprint hardening pass that closed the May 2026
internal audit in `docs/SECURITY-AUDIT-2026-05-26.md`. Future audits
will land alongside it.

---

## Where this policy lives

- This file: `SECURITY.md` at the repository root (you're reading it).
- Mirrored to a discoverable page: `https://hader.ai/security` (planned).
- Reachable via the standardised `.well-known` endpoint:
  `https://hader.ai/.well-known/security.txt` (planned).

Last reviewed: 2026-05-26.
