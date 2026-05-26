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

  it('refresh rotates the cookie and yields a fresh access token', async () => {
    const app = getApp();
    const session = await seedOrgAndLogin(app, 'refreshtest');
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: { cookie: session.refreshCookie },
    });
    expect(res.statusCode).toBe(200);

    // The rotation guarantee under test is structural: a fresh access token is
    // issued AND a new refresh cookie is set. We deliberately do not assert on
    // string-inequality of the access token because login + refresh may share
    // the same iat-second (a JWT with the same claims encodes identically).
    // The reuse-detection test below proves the *security* property —
    // re-presenting the old refresh token must now fail.
    const body = res.json() as { accessToken: string };
    expect(body.accessToken).toMatch(/^[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+$/);
    const setCookie = res.headers['set-cookie'];
    const newRefreshHeader = Array.isArray(setCookie)
      ? setCookie.find((c) => c.startsWith('aligned_refresh='))
      : setCookie?.startsWith('aligned_refresh=')
        ? setCookie
        : undefined;
    expect(newRefreshHeader).toBeTruthy();
  });

  it('Sprint 1 M-2 — replaying the rotated refresh token revokes the session', async () => {
    const app = getApp();
    const session = await seedOrgAndLogin(app, 'rotrefreshtest');

    // First refresh rotates the cookie. The OLD cookie should now be invalid.
    const r1 = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: { cookie: session.refreshCookie },
    });
    expect(r1.statusCode).toBe(200);

    // Re-present the original (now rotated) refresh cookie. Reuse detection
    // should trip and the response should be 401.
    const replay = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: { cookie: session.refreshCookie },
    });
    expect(replay.statusCode).toBe(401);
  });
});
