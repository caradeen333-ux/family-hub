// electron.spec.js — EL-* scenarios for the Electron shell.
// Launches the real app with Playwright's _electron driver.
// Requires: site/ built (npm run build:site) — CI/test:e2e does this.
//
// Isolation: FH_TEST_PROFILE gives each test run a temp userData profile and
// FH_HIDDEN keeps windows off the user's screen. Tests never touch the real
// app's storage (which the running production app holds locked).

import { test, expect, _electron as electron } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TEST_PROFILE = path.join(os.tmpdir(), 'family-hub-test-profile');

test.beforeEach(() => {
  // Fresh profile per test — EL-03's relaunch still shares it within the test
  fs.rmSync(TEST_PROFILE, { recursive: true, force: true });
});

async function launchApp() {
  const app = await electron.launch({
    args: ['.'],
    env: { ...process.env, FH_HIDDEN: '1', FH_TEST_PROFILE: '1' },
  });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  return { app, page };
}

test('EL-01 boots offline from the local bundle server', async () => {
  const { app, page } = await launchApp();
  try {
    // The URL proves the local bundle: no Pages hit, works with no network
    expect(page.url()).toMatch(/^http:\/\/127\.0\.0\.1:/);
    await expect(page.locator('#screen-auth, #app, #screen-provision').first()).toBeVisible();
    const title = await page.title();
    expect(title).toBe('Family Hub');
  } finally {
    await app.close();
  }
});

test('EL-03 localStorage tokens survive relaunch', async () => {
  const first = await launchApp();
  await first.page.evaluate(() => {
    localStorage.setItem('fh_accounts', JSON.stringify({
      'mike@test.local': {
        sub: 'abc', name: 'Mike', email: 'mike@test.local',
        accessToken: 'AT-SURVIVES', refreshToken: 'RT-SURVIVES',
        expiresAt: Date.now() + 3600_000,
      },
    }));
    localStorage.setItem('fh_activeAccount', 'mike@test.local');
  });
  await first.app.evaluate(({ session }) => session.defaultSession.flushStorageData());
  await first.app.close();

  const second = await launchApp();
  try {
    await second.page.reload(); // re-run boot with stored tokens
    const accounts = await second.page.evaluate(() => JSON.parse(localStorage.getItem('fh_accounts') ?? '{}'));
    expect(accounts['mike@test.local'].refreshToken).toBe('RT-SURVIVES');
    // Signed-in boot: app (or provisioning) visible, not the auth screen
    await expect(second.page.locator('#screen-auth').first()).toBeHidden({ timeout: 10_000 });
  } finally {
    await second.app.close();
  }
});
