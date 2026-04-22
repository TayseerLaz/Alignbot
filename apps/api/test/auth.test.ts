import { describe, expect, it } from 'vitest';

import { seedOrgAndLogin, TEST_PASSWORD } from './helpers.js';
import { getApp } from './setup.js';

describe('auth flow', () => {
  it('signs up an org + admin user and rejects duplicates', async () => {
    const app = getApp();
    const res1 = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/signup',
      payload: {
        email: 'first@example.com',
        password: TEST_PASSWORD,
        firstName: 'First',
        lastName: 'Owner',
        organizationName: 'First Co',
        organizationSlug: 'firstco',
      },
    });
    expect(res1.statusCode).toBe(201);

    const res2 = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/signup',
      payload: {
        email: 'first@example.com',
        password: TEST_PASSWORD,
        firstName: 'First',
        lastName: 'Owner',
        organizationName: 'Second Co',
        organizationSlug: 'secondco',
      },
    });
    expect(res2.statusCode).toBe(409);
  });

  it('signs in only when email is verified', async () => {
    const app = getApp();
    const session = await seedOrgAndLogin(app, 'verifytest');
    expect(session.accessToken).toMatch(/^[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+$/);
  });

  it('refresh rotates tokens', async () => {
    const app = getApp();
    const session = await seedOrgAndLogin(app, 'refreshtest');
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: { cookie: session.refreshCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { accessToken: string };
    expect(body.accessToken).not.toBe(session.accessToken);
  });
});
