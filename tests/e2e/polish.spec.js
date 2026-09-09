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
