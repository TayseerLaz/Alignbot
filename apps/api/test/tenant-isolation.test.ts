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
});
