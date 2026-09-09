// auth.spec.js — AUTH-* scenarios with mocked endpoints (CI-safe).
// Covers the "logins must stay stable" regression suite.

import { test, expect } from '@playwright/test';
import {
  fakeIdToken,
  seedAccounts,
  accountPatch,
  mockTokenEndpoint,
  mockAuthorizeRedirect,
  TEST_EMAIL,
} from './helpers.js';

const T = '?testClock=1'; // enables clock control + __fhTest hook

// AUTH-01: fresh sign-in — full PKCE redirect round-trip with state
test('AUTH-01 fresh sign-in completes the PKCE round-trip', async ({ page }) => {
  const authorizeSeen = await mockAuthorizeRedirect(page);
  await mockTokenEndpoint(page, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        access_token: 'AT-NEW',
        refresh_token: 'RT-NEW',
        expires_in: 3600,
        id_token: fakeIdToken({ email: TEST_EMAIL, name: 'Mike' }),
      }),
    });
  });

  await page.goto('/' + T);
  await expect(page.locator('#screen-auth')).toBeVisible();
  await page.click('#btn-auth-signin');

  // The authorize URL must carry PKCE + state
  expect(authorizeSeen.length).toBe(1);
  const authUrl = authorizeSeen[0];
  expect(authUrl.searchParams.get('code_challenge')).toBeTruthy();
  expect(authUrl.searchParams.get('code_challenge_method')).toBe('S256');
  expect(authUrl.searchParams.get('state')).toBeTruthy();
  expect(authUrl.searchParams.get('scope')).toContain('drive.file');

  // Redirect lands back, code is exchanged, account is stored
  await expect(page.locator('#screen-provision')).toBeVisible({ timeout: 10_000 });
  const accounts = await page.evaluate(() => JSON.parse(localStorage.getItem('fh_accounts') ?? '{}'));
  expect(accounts[TEST_EMAIL].accessToken).toBe('AT-NEW');
  expect(accounts[TEST_EMAIL].refreshToken).toBe('RT-NEW');
});

// AUTH-02: boot with a valid token makes ZERO token calls
test('AUTH-02 boot with valid token makes zero token endpoint calls', async ({ page }) => {
  await seedAccounts({ [TEST_EMAIL]: accountPatch() })({ context: page.context() });
  const calls = await mockTokenEndpoint(page, async (route) => {
    await route.fulfill({ status: 500, contentType: 'application/json', body: '{}' });
  });

  await page.goto('/' + T);
  await expect(page.locator('#screen-provision')).toBeVisible({ timeout: 10_000 }); // signed in, not provisioned
  await page.waitForTimeout(800); // settle — any churn would land here
  expect(calls.length).toBe(0);
});

// AUTH-03: proactive refresh fires before expiry (clock-driven)
test('AUTH-03 proactive refresh before expiry', async ({ page }) => {
  await seedAccounts({ [TEST_EMAIL]: accountPatch({ expiresAt: Date.now() + 20 * 60 * 1000 }) })({ context: page.context() });
  let refreshCalls = 0;
  await mockTokenEndpoint(page, async (route) => {
    refreshCalls++;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ access_token: 'AT-REFRESHED', expires_in: 3600 }),
    });
  });

  await page.goto('/' + T);
  await expect(page.locator('#screen-provision')).toBeVisible({ timeout: 10_000 });

  // Advance past the refresh lead (expiry−10min → refresh at +10min fake time)
  await page.evaluate(() => window.__fhTest.clock._advance(11 * 60 * 1000));
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('fh_accounts') ?? '{}')['mike@test.local']?.accessToken === 'AT-REFRESHED', null, { timeout: 5000 });
  expect(refreshCalls).toBe(1);
  // The stored refresh token was preserved (merge, don't replace)
  const accounts = await page.evaluate(() => JSON.parse(localStorage.getItem('fh_accounts') ?? '{}'));
  expect(accounts[TEST_EMAIL].refreshToken).toBe('RT-1');
});

// AUTH-05: two parallel refreshes produce exactly one grant (single-flight)
test('AUTH-05 concurrent refreshes share one grant', async ({ page }) => {
  await seedAccounts({ [TEST_EMAIL]: accountPatch() })({ context: page.context() });
  let grantCalls = 0;
  await mockTokenEndpoint(page, async (route) => {
    grantCalls++;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ access_token: `AT-${grantCalls}`, expires_in: 3600 }),
    });
  });

  await page.goto('/' + T);
  await expect(page.locator('#screen-provision')).toBeVisible({ timeout: 10_000 });

  const results = await page.evaluate(async () => {
    const a = window.__fhTest.auth.ensureValidToken({ force: true });
    const b = window.__fhTest.auth.ensureValidToken({ force: true });
    const [x, y] = await Promise.all([a, b]);
    return { x, y };
  });
  expect(results.x).toBe(results.y);
  expect(grantCalls).toBe(1);
});

// AUTH-06: invalid_grant clears ONLY that account, tries one silent re-auth,
// and never destroys a sibling account
test('AUTH-06 invalid_grant is account-scoped with silent recovery', async ({ page }) => {
  const other = accountPatch({ email: 'avery@test.local', name: 'Avery', accessToken: 'AT-AVERY', refreshToken: 'RT-AVERY' });
  await seedAccounts({ [TEST_EMAIL]: accountPatch(), 'avery@test.local': other })({ context: page.context() });
  await mockAuthorizeRedirect(page); // silent prompt=none round-trip

  let tokenCalls = 0;
  await mockTokenEndpoint(page, async (route) => {
    tokenCalls++;
    const body = Object.fromEntries(route.request().postData() ? new URLSearchParams(route.request().postData()) : []);
    if (body.grant_type === 'refresh_token' && tokenCalls === 1) {
      // First refresh dies
      await route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }) });
    } else {
      // Silent recovery's code exchange succeeds
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ access_token: 'AT-RECOVERED', refresh_token: 'RT-RECOVERED', expires_in: 3600, id_token: fakeIdToken({ email: TEST_EMAIL }) }),
      });
    }
  });

  await page.goto('/' + T);
  await expect(page.locator('#screen-provision')).toBeVisible({ timeout: 10_000 });

  // Force the refresh → invalid_grant → clear + one silent attempt
  await page.evaluate(() => window.__fhTest.auth.ensureValidToken({ force: true }).catch(() => {}));
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('fh_accounts') ?? '{}')['mike@test.local']?.accessToken === 'AT-RECOVERED', null, { timeout: 8000 });

  const accounts = await page.evaluate(() => JSON.parse(localStorage.getItem('fh_accounts') ?? '{}'));
  // Recovered with a NEW refresh token; sibling account completely untouched
  expect(accounts[TEST_EMAIL].refreshToken).toBe('RT-RECOVERED');
  expect(accounts['avery@test.local'].accessToken).toBe('AT-AVERY');
  expect(accounts['avery@test.local'].refreshToken).toBe('RT-AVERY');
  // The app never bounced to the sign-in screen
  expect(await page.locator('#screen-auth').isVisible()).toBe(false);
});

// AUTH-07: state mismatch aborts the exchange and stores nothing
test('AUTH-07 state mismatch makes no mutations', async ({ page }) => {
  await mockAuthorizeRedirect(page, { state: 'tampered-state' });
  await mockTokenEndpoint(page, async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });

  await page.goto('/' + T);
  await page.click('#btn-auth-signin');
  await expect(page.locator('#auth-error')).toBeVisible({ timeout: 10_000 });
  const accounts = await page.evaluate(() => localStorage.getItem('fh_accounts'));
  expect(accounts === null || accounts === '{}').toBe(true);
});

// AUTH-08: transient 5xx keeps tokens and does not re-auth
test('AUTH-08 transient errors keep tokens with backoff', async ({ page }) => {
  await seedAccounts({ [TEST_EMAIL]: accountPatch() })({ context: page.context() });
  let calls = 0;
  await mockTokenEndpoint(page, async (route) => {
    calls++;
    await route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"server_error"}' });
  });

  await page.goto('/' + T);
  await expect(page.locator('#screen-provision')).toBeVisible({ timeout: 10_000 });
  await page.evaluate(() => window.__fhTest.auth.ensureValidToken({ force: true }).catch(() => {}));
  await page.waitForTimeout(500);

  const accounts = await page.evaluate(() => JSON.parse(localStorage.getItem('fh_accounts') ?? '{}'));
  // Tokens kept — only transient error state; no silent re-auth attempted
  expect(accounts[TEST_EMAIL].accessToken).toBe('AT-1');
  expect(accounts[TEST_EMAIL].refreshToken).toBe('RT-1');
  expect(await page.locator('#screen-auth').isVisible()).toBe(false);
});
