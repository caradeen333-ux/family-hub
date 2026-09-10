// onboarding.spec.js — Family formation flows: provision → share-by-email →
// invite link; join with friendly failures. The onboarding must be flawless.

import { test, expect } from '@playwright/test';
import { seedAccounts, accountPatch, mockDrive, seedDirState, TEST_EMAIL, base64url } from './helpers.js';

const T = '?testClock=1';
const INVITE_HASH = '#invite=' + base64url({ v: 1, folderId: 'FOLDER', dirFileId: 'DIRFILE' })
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

test('ONB-01 founder provisions, shares by email, gets an invite link', async ({ page }) => {
  await seedAccounts({ [TEST_EMAIL]: accountPatch() })({ context: page.context() });
  const drive = mockDrive(page);
  await page.route('**/www.googleapis.com/**/drive/v3/**', drive.routeAll);

  await page.goto('/' + T);
  // Provision screen: family name first, personal name pre-filled from Google
  await expect(page.locator('#screen-provision')).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('#provision-family')).toBeVisible();
  await expect(page.locator('#provision-name')).toHaveValue('Mike');

  await page.fill('#provision-family', 'The Murphys');
  await page.click('#btn-provision');
  await expect(page.locator('#provision-invite')).toBeVisible({ timeout: 10_000 });

  // Drive folder + dir.json + founding log were created (provision creates a
  // fresh dir.json — find it by its member registration, not the seed)
  const folder = [...drive.files.values()].find((f) => f.name === 'Family Hub');
  expect(folder).toBeTruthy();
  const dirWithMike = [...drive.files.values()].find((f) => f.name === 'dir.json' && f.content.includes('mike'));
  expect(dirWithMike).toBeTruthy();

  // Share with an invitee by email → permission grant + link
  await page.fill('#invite-email', 'charlie@test.local');
  await page.click('#btn-share-email');
  await expect(page.locator('#invite-link')).toHaveValue(/^http:\/\/localhost:4173\/#invite=/);
  const permCall = drive.calls.find((c) => c.method === 'permission');
  expect(permCall).toBeTruthy();
  expect(permCall.body).toEqual({ type: 'user', role: 'writer', emailAddress: 'charlie@test.local' });

  await page.click('#btn-enter-hub');
  await expect(page.locator('#app')).toBeVisible();
  // The family name lives in config — never conflated with the founder's name
  const familyName = await page.evaluate(async () => (await window.__fhTest.engine.remerge()).config.get('familyName'));
  expect(familyName).toBe('The Murphys');
});

test('ONB-02 join without folder access shows the friendly message', async ({ page }) => {
  await seedAccounts({ [TEST_EMAIL]: accountPatch() })({ context: page.context() });
  const drive = mockDrive(page);
  await page.route('**/www.googleapis.com/**/drive/v3/**', drive.routeAll);
  // The invite's dir.json id doesn't exist in the mock — the family never
  // shared the folder with this account (no open-gesture access)
  const MISSING_INVITE = '#invite=' + base64url({ v: 1, folderId: 'FOLDER', dirFileId: 'MISSING' })
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  await page.goto('/' + T + MISSING_INVITE);
  await expect(page.locator('#screen-provision')).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('#provision-title')).toHaveText('Join your family');
  await page.click('#btn-provision');

  // The friendly error names the exact account the family must invite
  await expect(page.locator('.toast.error')).toContainText('hasn\'t added your account yet', { timeout: 10_000 });
});

test('ONB-03 re-opening an invite as an existing member just enters the app', async ({ page }) => {
  await seedAccounts({ [TEST_EMAIL]: accountPatch() })({ context: page.context() });
  const drive = mockDrive(page);
  await page.route('**/www.googleapis.com/**/drive/v3/**', drive.routeAll);
  // The member already exists in dir.json (founder provisioned earlier)
  drive.files.get('DIRFILE').content = JSON.stringify({
    v: 1,
    members: {
      mike: { name: 'Mike', email: TEST_EMAIL, months: { '2026-09': 'LOG1' } },
    },
  });

  await page.goto('/' + T + INVITE_HASH);
  await expect(page.locator('#screen-provision')).toBeVisible({ timeout: 10_000 });
  await page.click('#btn-provision');
  await expect(page.locator('#app')).toBeVisible({ timeout: 10_000 });
  // No new member registration — dir.json still has exactly one member
  const dir = JSON.parse(drive.files.get('DIRFILE').content);
  expect(Object.keys(dir.members).length).toBe(1);
});
