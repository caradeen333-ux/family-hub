// polish.spec.js — Organization + formatting features: markdown rendering,
// search, pinning, note/chore editing, poll closing. UI-level regressions.

import { test, expect } from '@playwright/test';
import { seedAccounts, accountPatch, seedDirState, TEST_DIRSTATE, TEST_EMAIL } from './helpers.js';

const T = '?testClock=1';

async function boot(page) {
  await seedAccounts({ [TEST_EMAIL]: accountPatch() })({ context: page.context() });
  await seedDirState(TEST_DIRSTATE)({ context: page.context() });
  await page.goto('/' + T);
  await expect(page.locator('#app')).toBeVisible({ timeout: 10_000 });
}

test('POL-01 note text renders markdown formatting', async ({ page }) => {
  await boot(page);
  await page.evaluate(async () => {
    await window.__fhTest.notes.addNote(window.__fhTest.engine, {
      text: '**Buy milk**\n- eggs\n- bread',
    });
  });
  await page.click('[data-tab="notes"]');
  const text = page.locator('.note-text');
  await expect(text.locator('strong', { hasText: 'Buy milk' })).toBeVisible();
  await expect(text.locator('li', { hasText: 'eggs' })).toBeVisible();
  await expect(text.locator('li', { hasText: 'bread' })).toBeVisible();
});

test('POL-02 search filters notes', async ({ page }) => {
  await boot(page);
  await page.evaluate(async () => {
    await window.__fhTest.notes.addNote(window.__fhTest.engine, { text: 'milk run' });
    await window.__fhTest.notes.addNote(window.__fhTest.engine, { text: 'dentist appointment' });
  });
  await page.click('[data-tab="notes"]');
  await page.fill('#notes-search', 'dentist');
  await expect(page.locator('.note-text', { hasText: 'dentist appointment' })).toBeVisible();
  await expect(page.locator('.note-text', { hasText: 'milk run' })).toHaveCount(0);
});

test('POL-03 pinned notes sort to the top', async ({ page }) => {
  await boot(page);
  await page.evaluate(async () => {
    await window.__fhTest.notes.addNote(window.__fhTest.engine, { text: 'first note' });
    await window.__fhTest.notes.addNote(window.__fhTest.engine, { text: 'pinned note', pinned: true });
  });
  await page.click('[data-tab="notes"]');
  const first = page.locator('.note-card').first();
  await expect(first).toContainText('pinned note');
  await expect(first).toHaveClass(/pinned/);
});

test('POL-04 note edit modal saves changes', async ({ page }) => {
  await boot(page);
  await page.evaluate(async () => {
    await window.__fhTest.notes.addNote(window.__fhTest.engine, { text: 'original text' });
  });
  await page.click('[data-tab="notes"]');
  await page.click('.note-card'); // opens edit modal
  await expect(page.locator('#modal-note')).toBeVisible();
  await page.fill('#note-textarea', 'updated **text**');
  await page.selectOption('#form-note select[name="importance"]', 'high');
  await page.click('#form-note button[type="submit"]');
  await expect(page.locator('.note-text strong', { hasText: 'text' })).toBeVisible();
  await expect(page.locator('.note-card')).toContainText('updated');
});

test('POL-05 chore modal creates with assignee + due date', async ({ page }) => {
  await boot(page);
  await page.click('[data-tab="chores"]');
  await page.fill('#chore-input', 'take out trash');
  await page.click('#btn-add-chore');
  await expect(page.locator('.chore-title', { hasText: 'take out trash' })).toBeVisible();
  // Edit via row click → set due date → overdue badge renders
  await page.click('.chore-row');
  await expect(page.locator('#modal-chore')).toBeVisible();
  await page.fill('#form-chore input[name="dueDate"]', '2020-01-01');
  await page.click('#form-chore button[type="submit"]');
  await expect(page.locator('.chore-due.overdue')).toBeVisible();
});

test('POL-07 account switcher lists and switches accounts', async ({ page }) => {
  await boot(page);
  // Seed a second account, then open settings
  await page.evaluate(() => {
    const accounts = JSON.parse(localStorage.getItem('fh_accounts') ?? '{}');
    accounts['avery@test.local'] = { sub: 'xyz', name: 'Avery', email: 'avery@test.local', accessToken: 'AT-2', refreshToken: 'RT-2', expiresAt: Date.now() + 3600000 };
    localStorage.setItem('fh_accounts', JSON.stringify(accounts));
  });
  await page.click('#btn-settings');
  await expect(page.locator('#auth-area .member-row', { hasText: 'avery@test.local' })).toBeVisible();
  await page.click('#auth-area .btn-xs'); // Switch (triggers reload)
  await page.waitForFunction(() => localStorage.getItem('fh_activeAccount') === 'avery@test.local');
  // And the app reboots under the new account (header shows Avery's initial)
  await expect(page.locator('#app')).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('#account-avatar')).toHaveText('A');
});

test('POL-09 due-today chores appear on My Day with one-tap completion', async ({ page }) => {
  await boot(page);
  // Same local-date computation as todayKey() — not UTC
  const todayStr = await page.evaluate(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  });
  await page.evaluate(async ({ todayStr }) => {
    await window.__fhTest.chores.addChore(window.__fhTest.engine, { title: 'water plants', dueDate: todayStr, assignee: 'mike' });
    await window.__fhTest.chores.addChore(window.__fhTest.engine, { title: 'future thing', dueDate: '2030-01-01', assignee: 'mike' });
  }, { todayStr });
  await expect(page.locator('#due-today-slot')).toContainText('water plants');
  await expect(page.locator('#due-today-slot')).not.toContainText('future thing');
  // One tap completes it — disappears from Due today
  await page.click('#due-today-slot .note-check');
  await expect(page.locator('#due-today-slot')).not.toContainText('water plants');
});

test('POL-10 poll options show voter chips', async ({ page }) => {
  await boot(page);
  await page.evaluate(async () => {
    const e = window.__fhTest.engine;
    const poll = await window.__fhTest.votes.createPoll(e, { title: 'Chips test', kind: 'general', options: ['A', 'B'], author: 'mike' });
    await window.__fhTest.votes.castVote(e, poll.payload.pollId, 'o1', 'mike');
    await window.__fhTest.votes.castVote(e, poll.payload.pollId, 'o1', 'avery');
  });
  await page.click('[data-tab="votes"]');
  const firstOption = page.locator('.poll-option').first();
  await expect(firstOption.locator('.voter-chip')).toHaveCount(2);
});

test('POL-11 account switch scopes dirState — mutations authored by the active account', async ({ page }) => {
  await boot(page);
  // Seed a second account AND its own scoped dirState (avery joined)
  await page.evaluate(() => {
    const accounts = JSON.parse(localStorage.getItem('fh_accounts') ?? '{}');
    accounts['avery@test.local'] = { sub: 'xyz', name: 'Avery', email: 'avery@test.local', accessToken: 'AT-2', refreshToken: 'RT-2', expiresAt: Date.now() + 3600000 };
    localStorage.setItem('fh_accounts', JSON.stringify(accounts));
  });
  const seedAveryDir = async () => page.evaluate(() => new Promise((res) => {
    const req = indexedDB.open('family-hub-local', 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
    };
    req.onsuccess = () => {
      const t = req.result.transaction('kv', 'readwrite');
      t.objectStore('kv').put({ folderId: 'FOLDER', dirFileId: 'DIRFILE', memberKey: 'avery', name: 'Avery', email: 'avery@test.local' }, 'dirState:avery@test.local');
      t.oncomplete = res;
    };
  }));
  await seedAveryDir();

  await page.click('#btn-settings');
  await page.click('#auth-area .btn-xs'); // Switch to Avery
  await page.waitForFunction(() => localStorage.getItem('fh_activeAccount') === 'avery@test.local');
  await expect(page.locator('#app')).toBeVisible({ timeout: 10_000 });

  // A note authored under Avery's session must carry Avery's key
  await page.evaluate(async () => {
    await window.__fhTest.notes.addNote(window.__fhTest.engine, { text: 'avery wrote this' });
  });
  const author = await page.evaluate(async () => (await window.__fhTest.localDb.getLocalEvents()).find((e) => e.payload?.text === 'avery wrote this')?.author);
  expect(author).toBe('avery');
});

test('POL-08 export downloads a JSON snapshot', async ({ page }) => {
  await boot(page);
  await page.evaluate(async () => {
    await window.__fhTest.notes.addNote(window.__fhTest.engine, { text: 'exported note' });
  });
  const downloadPromise = page.waitForEvent('download');
  await page.click('#btn-settings');
  await page.click('#btn-export');
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^family-hub-export-\d{4}-\d{2}-\d{2}\.json$/);
  const stream = await download.createReadStream();
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  expect(data.app).toBe('Family Hub');
  expect(data.notes.some((n) => n.text === 'exported note')).toBe(true);
});

test('POL-06 creator closes a poll with the leading option as winner', async ({ page }) => {
  await boot(page);
  await page.evaluate(async () => {
    const e = window.__fhTest.engine;
    const poll = await window.__fhTest.votes.createPoll(e, {
      title: 'Weekend plan?', kind: 'general', options: ['Beach', 'Mountains'], author: 'mike',
    });
    await window.__fhTest.votes.castVote(e, poll.payload.pollId, 'o1', 'mike');
  });
  await page.click('[data-tab="votes"]');
  await expect(page.locator('.poll-question', { hasText: 'Weekend plan?' })).toBeVisible();
  await page.click('.poll-card .btn-xs'); // Close poll
  await expect(page.locator('#modal-confirm')).toBeVisible();
  await page.click('#btn-confirm-delete');
  await expect(page.locator('.poll-closed-badge', { hasText: 'Beach' })).toBeVisible();
});
