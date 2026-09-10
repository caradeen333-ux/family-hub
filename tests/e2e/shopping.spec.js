// shopping.spec.js — SHOP-* scenarios: add/split/parse, toggle + done
// section, clear-with-undo, aisle grouping, multiple lists.

import { test, expect } from '@playwright/test';
import { seedAccounts, accountPatch, seedDirState, TEST_DIRSTATE, TEST_EMAIL } from './helpers.js';

const T = '?testClock=1';

async function boot(page) {
  await seedAccounts({ [TEST_EMAIL]: accountPatch() })({ context: page.context() });
  await seedDirState(TEST_DIRSTATE)({ context: page.context() });
  await page.goto('/' + T);
  await expect(page.locator('#app')).toBeVisible({ timeout: 10_000 });
  await page.click('[data-tab="shopping"]');
  // First visit auto-creates the Groceries list
  await expect(page.locator('.list-chip', { hasText: 'Groceries' })).toBeVisible();
}

test('SHOP-01 adding items: quantity prefixes and comma-paste splitting', async ({ page }) => {
  await boot(page);
  await page.fill('#shop-input', '2x milk');
  await page.press('#shop-input', 'Enter');
  await expect(page.locator('.shop-text', { hasText: 'milk' })).toBeVisible();
  await expect(page.locator('.qty-badge', { hasText: '2×' })).toBeVisible();

  // Paste a whole list at once
  await page.fill('#shop-input', 'eggs, bread, apples');
  await page.click('#btn-add-item');
  await expect(page.locator('.shop-text', { hasText: 'eggs' })).toBeVisible();
  await expect(page.locator('.shop-text', { hasText: 'bread' })).toBeVisible();
  await expect(page.locator('.shop-text', { hasText: 'apples' })).toBeVisible();
  await expect(page.locator('.toast', { hasText: 'Added 3 items' })).toBeVisible();
});

test('SHOP-02 aisle grouping sorts items into sections', async ({ page }) => {
  await boot(page);
  await page.fill('#shop-input', 'milk, apples, chicken, paper towels');
  await page.click('#btn-add-item');

  const heads = page.locator('.aisle-head');
  await expect(heads).toHaveCount(4);
  await expect(heads.nth(0)).toHaveText('🥬 Produce');
  await expect(heads.nth(1)).toHaveText('🥛 Dairy & Eggs');
  await expect(heads.nth(2)).toHaveText('🥩 Meat & Fish');
  await expect(heads.nth(3)).toHaveText('🧻 Household');
});

test('SHOP-03 checking off: done section, progress, collapse', async ({ page }) => {
  await boot(page);
  await page.fill('#shop-input', 'milk, eggs');
  await page.click('#btn-add-item');
  await expect(page.locator('#shopping-progress-label')).toHaveText('2 left · 0 done');

  await page.locator('.shop-item', { hasText: 'milk' }).click(); // row tap toggles
  await expect(page.locator('#shopping-progress-label')).toHaveText('1 left · 1 done');
  await expect(page.locator('.shop-done-toggle', { hasText: 'Done (1)' })).toBeVisible();

  // Collapse + expand
  await page.click('.shop-done-toggle');
  await expect(page.locator('.done-body')).toHaveClass(/collapsed/);
  await page.click('.shop-done-toggle');
  await expect(page.locator('.done-body')).not.toHaveClass(/collapsed/);
});

test('SHOP-04 clear checked with Undo restores the items', async ({ page }) => {
  await boot(page);
  await page.fill('#shop-input', 'milk, eggs');
  await page.click('#btn-add-item');
  await page.locator('.shop-item', { hasText: 'milk' }).click();
  await page.locator('.shop-item', { hasText: 'eggs' }).click();

  await page.click('#btn-clear-checked');
  await expect(page.locator('.toast', { hasText: 'Cleared 2 items' })).toBeVisible();
  await expect(page.locator('.shop-item')).toHaveCount(0);

  await page.click('.toast-action'); // Undo
  await expect(page.locator('.shop-item')).toHaveCount(2);
  await expect(page.locator('.shop-item.done')).toHaveCount(0); // restored active
});

test('SHOP-05 multiple lists switch independently', async ({ page }) => {
  await boot(page);
  await page.fill('#shop-input', 'milk');
  await page.press('#shop-input', 'Enter');

  // Create a second list
  await page.click('#btn-new-list');
  await page.fill('#form-list input[name="name"]', 'Costco run');
  await page.click('.emoji-option:nth-child(2)');
  await page.click('#form-list button[type="submit"]');
  await expect(page.locator('.list-chip', { hasText: 'Costco run' })).toHaveClass(/active/);

  await page.fill('#shop-input', 'giant pack of paper towels');
  await page.press('#shop-input', 'Enter');
  await expect(page.locator('.shop-text', { hasText: 'giant pack of paper towels' })).toBeVisible();

  // Back to Groceries — its own items
  await page.click('.list-chip', { hasText: 'Groceries' });
  await expect(page.locator('.shop-text', { hasText: 'milk' })).toBeVisible();
  await expect(page.locator('.shop-text', { hasText: 'giant pack of paper towels' })).toHaveCount(0);
});

test('SHOP-06 edit an item via the text tap', async ({ page }) => {
  await boot(page);
  await page.fill('#shop-input', 'milk');
  await page.press('#shop-input', 'Enter');
  await page.click('.shop-text', { hasText: 'milk' });
  await expect(page.locator('#modal-prompt')).toBeVisible();
  await page.fill('#prompt-input', '3x oat milk');
  await page.press('#prompt-input', 'Enter');
  await expect(page.locator('.shop-text', { hasText: 'oat milk' })).toBeVisible();
  await expect(page.locator('.qty-badge', { hasText: '3×' })).toBeVisible();
});
