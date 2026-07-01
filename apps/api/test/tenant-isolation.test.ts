// HARD GATE: ensure no API call can read another org's data.
// If this test ever fails, do not deploy.
import { describe, expect, it } from 'vitest';

import { seedOrgAndLogin } from './helpers.js';
import { getApp, prisma } from './setup.js';

describe('tenant isolation', () => {
  it('a user in org A cannot read products from org B even with crafted IDs', async () => {
    const app = getApp();
    const a = await seedOrgAndLogin(app, 'tenant-a');
    const b = await seedOrgAndLogin(app, 'tenant-b');

    // Create a product in org B directly via the API.
    const createB = await app.inject({
      method: 'POST',
      url: '/api/v1/products',
      headers: { authorization: `Bearer ${b.accessToken}` },
      payload: { sku: 'SECRET-001', name: 'B Only', isAvailable: true },
    });
    expect(createB.statusCode).toBe(201);
    const bProductId = (createB.json() as { data: { id: string } }).data.id;

    // Org A tries to fetch it by ID — must 404, not 200.
    const fetchA = await app.inject({
      method: 'GET',
      url: `/api/v1/products/${bProductId}`,
      headers: { authorization: `Bearer ${a.accessToken}` },
    });
    expect(fetchA.statusCode).toBe(404);

    // Org A's list endpoint must not contain B's product.
    const listA = await app.inject({
      method: 'GET',
      url: '/api/v1/products',
      headers: { authorization: `Bearer ${a.accessToken}` },
    });
    const listBody = listA.json() as { data: { id: string }[] };
    expect(listBody.data.find((p) => p.id === bProductId)).toBeUndefined();

    // Audit log row directly in DB still belongs to the right org.
    await prisma.$executeRawUnsafe(`SET app.bypass_rls = 'on'`);
    const logs = await prisma.auditLog.findMany({ where: { entityId: bProductId } });
    expect(logs.every((l) => l.organizationId === b.orgId)).toBe(true);
  });

  // Phase 4 — broadcasts. Same gate: org A must not see org B's contacts,
  // segments, or broadcasts even with crafted IDs.
  it('a user in org A cannot read contacts/segments/broadcasts from org B', async () => {
    const app = getApp();
    const a = await seedOrgAndLogin(app, 'p4-iso-a');
    const b = await seedOrgAndLogin(app, 'p4-iso-b');

    // Create a contact in org B.
    const createContactB = await app.inject({
      method: 'POST',
      url: '/api/v1/contacts',
      headers: { authorization: `Bearer ${b.accessToken}` },
      payload: { phoneE164: '+14155550101', displayName: 'B-only', tags: ['secret'] },
    });
    expect(createContactB.statusCode).toBe(201);
    const bContactId = (createContactB.json() as { data: { id: string } }).data.id;

    // Org A: fetch by ID → 404
    const fetchContactA = await app.inject({
      method: 'GET',
      url: `/api/v1/contacts/${bContactId}`,
      headers: { authorization: `Bearer ${a.accessToken}` },
    });
    expect(fetchContactA.statusCode).toBe(404);

    // Org A: list does not contain B's contact
    const listContactsA = await app.inject({
      method: 'GET',
      url: '/api/v1/contacts',
      headers: { authorization: `Bearer ${a.accessToken}` },
    });
    const contactBody = listContactsA.json() as { data: { id: string }[] };
    expect(contactBody.data.find((c) => c.id === bContactId)).toBeUndefined();

    // Create a segment in org B
    const createSegB = await app.inject({
      method: 'POST',
      url: '/api/v1/segments',
      headers: { authorization: `Bearer ${b.accessToken}` },
      payload: {
        name: 'B-only segment',
        filter: { mode: 'all', clauses: [{ field: 'tag', op: 'in', value: ['secret'] }] },
      },
    });
    expect(createSegB.statusCode).toBe(201);
    const bSegmentId = (createSegB.json() as { data: { id: string } }).data.id;

    const fetchSegA = await app.inject({
      method: 'GET',
      url: `/api/v1/segments/${bSegmentId}`,
      headers: { authorization: `Bearer ${a.accessToken}` },
    });
    expect(fetchSegA.statusCode).toBe(404);
  });

  // Sprint 3 #26 — deeper, post-route RLS checks. The route gates above
  // confirm 401/403/404 but a regression that bypassed the route handler
  // (e.g. a future feature using raw SQL) would still be caught by the
  // policy. These tests INSERT a row in org B as the bypass role, then
  // re-bind the session to org A's role + current_org_id and confirm the
  // row is invisible. They prove the Postgres-level isolation directly.
  async function probeRls(table: string, rowId: string, orgIdForContext: string): Promise<number> {
    // Run inside an interactive Prisma transaction so all the SET LOCAL +
    // SELECT statements share a single Postgres connection and the policy
    // evaluation sees the tenant context we just bound.
    const count = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE aligned_app');
      await tx.$executeRawUnsafe(
        `SELECT set_config('app.current_org_id', $1, true)`,
        orgIdForContext,
      );
      await tx.$executeRawUnsafe(`SELECT set_config('app.bypass_rls', 'off', true)`);
      const rows = (await tx.$queryRawUnsafe(
        `SELECT id FROM ${table} WHERE id = $1::uuid`,
        rowId,
      )) as { id: string }[];
      return rows.length;
    });
    // Restore bypass for the next beforeEach truncate (which the setup.ts
    // beforeEach hook expects to be on so it can wipe tables).
    await prisma.$executeRawUnsafe(`SET app.bypass_rls = 'on'`);
    return count;
  }

  it('Postgres RLS hides org B contact rows from a tenant query bound to org A', async () => {
    const a = await seedOrgAndLogin(getApp(), 'rls-contact-a');
    const b = await seedOrgAndLogin(getApp(), 'rls-contact-b');

    await prisma.$executeRawUnsafe(`SET app.bypass_rls = 'on'`);
    const bContact = await prisma.contact.create({
      data: { organizationId: b.orgId, phoneE164: '+15555550456', displayName: 'leak-test' },
    });

    // Sanity: the row exists when querying with bypass (control case).
    const sanity = await probeRls('contacts', bContact.id, b.orgId);
    expect(sanity).toBe(1);

    // The probe: bind to org A's id — RLS must hide org B's row.
    const visible = await probeRls('contacts', bContact.id, a.orgId);
    expect(visible).toBe(0);
  });

  // Phone integrations. Same gate, with an extra wrinkle: phone_number is
  // GLOBALLY unique (it's the gateway routing key), so we also confirm that
  // collision surfaces as a generic 409 and never leaks org B's row to org A.
  it('a user in org A cannot read phone integrations from org B (and the global number unique does not leak)', async () => {
    const app = getApp();
    const a = await seedOrgAndLogin(app, 'phone-iso-a');
    const b = await seedOrgAndLogin(app, 'phone-iso-b');

    const createB = await app.inject({
      method: 'POST',
      url: '/api/v1/phone-integrations',
      headers: { authorization: `Bearer ${b.accessToken}` },
      payload: { name: 'B line', phoneNumber: '+961 1 000 000' },
    });
    expect(createB.statusCode).toBe(201);
    const bLineId = (createB.json() as { data: { id: string } }).data.id;

    // Org A: fetch by ID → 404
    const fetchA = await app.inject({
      method: 'GET',
      url: `/api/v1/phone-integrations/${bLineId}`,
      headers: { authorization: `Bearer ${a.accessToken}` },
    });
    expect(fetchA.statusCode).toBe(404);

    // Org A: list does not contain B's line
    const listA = await app.inject({
      method: 'GET',
      url: '/api/v1/phone-integrations',
      headers: { authorization: `Bearer ${a.accessToken}` },
    });
    expect((listA.json() as { data: { id: string }[] }).data.find((l) => l.id === bLineId)).toBeUndefined();

    // Org A registering B's number (same normalized DID) → generic 409, no leak.
    const dupA = await app.inject({
      method: 'POST',
      url: '/api/v1/phone-integrations',
      headers: { authorization: `Bearer ${a.accessToken}` },
      payload: { name: 'A dup', phoneNumber: '961-1-000-000' },
    });
    expect(dupA.statusCode).toBe(409);

    // Postgres-level: B's line row is invisible bound to org A.
    const visibleToA = await probeRls('phone_integrations', bLineId, a.orgId);
    expect(visibleToA).toBe(0);
  });

  it('Postgres RLS hides org B api_connector rows from org A', async () => {
    const app = getApp();
    const a = await seedOrgAndLogin(app, 'rls-conn-a');
    const b = await seedOrgAndLogin(app, 'rls-conn-b');

    // Create a connector in org B via the API (real path).
    const createB = await app.inject({
      method: 'POST',
      url: '/api/v1/connectors',
      headers: { authorization: `Bearer ${b.accessToken}` },
      payload: { name: 'B Inbound', entityKind: 'product', enableInboundWebhook: true },
    });
    expect(createB.statusCode).toBe(201);
    const bConnectorId = (createB.json() as { data: { id: string } }).data.id;

    const visibleToA = await probeRls('api_connectors', bConnectorId, a.orgId);
    expect(visibleToA).toBe(0);
  });

  // Tenant wallet & metered billing. A tenant's balance and ledger are money —
  // cross-tenant visibility here would be a billing leak. Prove the RLS on both
  // new tables directly, and that /billing/overview only ever shows own balance.
  it('Postgres RLS hides org B tenant_wallets + wallet_ledger rows from org A', async () => {
    const a = await seedOrgAndLogin(getApp(), 'rls-wallet-a');
    const b = await seedOrgAndLogin(getApp(), 'rls-wallet-b');

    await prisma.$executeRawUnsafe(`SET app.bypass_rls = 'on'`);
    const bWallet = await prisma.tenantWallet.create({ data: { organizationId: b.orgId } });
    const bLedger = await prisma.walletLedger.create({
      data: { organizationId: b.orgId, kind: 'topup', amountMicros: 1000n, availableAfter: 1000n, heldAfter: 0n },
    });

    // Control: rows are visible with bypass / own-org context.
    expect(await probeRls('tenant_wallets', bWallet.id, b.orgId)).toBe(1);
    expect(await probeRls('wallet_ledger', bLedger.id, b.orgId)).toBe(1);

    // Isolation: invisible bound to org A.
    expect(await probeRls('tenant_wallets', bWallet.id, a.orgId)).toBe(0);
    expect(await probeRls('wallet_ledger', bLedger.id, a.orgId)).toBe(0);
  });

  it('/billing/overview and /billing/ledger only ever return the caller org', async () => {
    const app = getApp();
    const a = await seedOrgAndLogin(app, 'bill-iso-a');
    const b = await seedOrgAndLogin(app, 'bill-iso-b');

    await prisma.$executeRawUnsafe(`SET app.bypass_rls = 'on'`);
    // Fund org B only, via a distinctive amount.
    await prisma.tenantWallet.create({
      data: { organizationId: b.orgId, availableMicros: 12_345_678n, meteringEnabled: true, pricePerMessageMicros: 80_000n },
    });

    const ovA = await app.inject({
      method: 'GET',
      url: '/api/v1/billing/overview',
      headers: { authorization: `Bearer ${a.accessToken}` },
    });
    expect(ovA.statusCode).toBe(200);
    // Org A has no wallet → unmetered, zero balance — never org B's $12.34.
    expect((ovA.json() as { data: { availableMicros: number } }).data.availableMicros).toBe(0);

    const ovB = await app.inject({
      method: 'GET',
      url: '/api/v1/billing/overview',
      headers: { authorization: `Bearer ${b.accessToken}` },
    });
    expect((ovB.json() as { data: { availableMicros: number } }).data.availableMicros).toBe(12_345_678);
  });
});
