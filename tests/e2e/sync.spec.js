// sync.spec.js — SYNC-* scenarios: offline writes flush exactly once to a
// mocked Drive; votes merge locally; malformed remote lines are tolerated.

import { test, expect } from '@playwright/test';
import { seedAccounts, accountPatch, mockDrive, seedDirState, TEST_DIRSTATE, TEST_EMAIL } from './helpers.js';

const T = '?testClock=1';

test('SYNC-01 offline note flushes to Drive exactly once, then acks', async ({ page }) => {
  await seedAccounts({ [TEST_EMAIL]: accountPatch() })({ context: page.context() });
  await seedDirState(TEST_DIRSTATE)({ context: page.context() });

  const drive = mockDrive(page);
  await page.route('**/www.googleapis.com/**/drive/v3/**', drive.routeAll);

  await page.goto('/' + T);
  await expect(page.locator('#app')).toBeVisible({ timeout: 10_000 });

  // Create a note (local-first)
  await page.evaluate(async () => {
    await window.__fhTest.notes.addNote(window.__fhTest.engine, { text: 'buy milk' });
  });
  // It renders instantly from the local merge
  await page.click('[data-tab="notes"]');
  await expect(page.locator('.note-card .note-text', { hasText: 'buy milk' })).toBeVisible();

  // Flush to Drive (the boot-time background flush may legitimately win the
  // ack race — what matters is END STATE: everything acked, exactly one line)
  await page.evaluate(async () => window.__fhTest.engine.flush());

  // Exactly ONE line landed in the member's log file
  const logFiles = [...drive.files.values()].filter((f) => f.name.startsWith('mike-'));
  expect(logFiles.length).toBe(1);
  const lines = logFiles[0].content.split('\n').filter(Boolean);
  expect(lines.length).toBe(1);
  const event = JSON.parse(lines[0]);
  expect(event.type).toBe('note.upsert');
  expect(event.payload.text).toBe('buy milk');
  expect(event.author).toBe('mike');

  // Unconfirmed store is drained
  const pending = await page.evaluate(async () => (await window.__fhTest.localDb.getUnconfirmed()).length);
  expect(pending).toBe(0);
});

test('SYNC-02 replayed append is idempotent (no duplicate lines)', async ({ page }) => {
  await seedAccounts({ [TEST_EMAIL]: accountPatch() })({ context: page.context() });
  await seedDirState(TEST_DIRSTATE)({ context: page.context() });

  const drive = mockDrive(page);
  await page.route('**/www.googleapis.com/**/drive/v3/**', drive.routeAll);

  await page.goto('/' + T);
  await expect(page.locator('#app')).toBeVisible({ timeout: 10_000 });

  await page.evaluate(async () => {
    await window.__fhTest.notes.addNote(window.__fhTest.engine, { text: 'call dentist' });
  });
  await page.evaluate(async () => window.__fhTest.engine.flush());

  // Simulate a lost acknowledgment: the same event is re-appended (the crash
  // window between Drive write and local ack).
  const ev = await page.evaluate(async () => (await window.__fhTest.localDb.getLocalEvents())[0]);
  const again = await page.evaluate(async (ev) => {
    return window.__fhTest.engine.adapter.appendToMyLog({
      folderId: 'FOLDER',
      dirFileId: 'DIRFILE',
      memberKey: 'mike',
      name: 'Mike',
      email: 'mike@test.local',
      events: [ev],
    });
  }, ev);

  expect(again.acknowledged.length).toBe(1); // already present → acked
  const logFiles = [...drive.files.values()].filter((f) => f.name.startsWith('mike-'));
  const lines = logFiles[0].content.split('\n').filter(Boolean);
  expect(lines.length).toBe(1); // no duplicate line written
});

test('SYNC-03 re-vote replaces the member vote; tallies stay correct', async ({ page }) => {
  await seedAccounts({ [TEST_EMAIL]: accountPatch() })({ context: page.context() });
  await seedDirState(TEST_DIRSTATE)({ context: page.context() });

  await page.goto('/' + T);
  await expect(page.locator('#app')).toBeVisible({ timeout: 10_000 });

  const result = await page.evaluate(async () => {
    const engine = window.__fhTest.engine;
    const poll = await window.__fhTest.votes.createPoll(engine, {
      title: 'Movie night?',
      kind: 'general',
      options: ['Horror', 'Comedy'],
      author: 'mike',
    });
    const pollId = poll.payload.pollId;
    await window.__fhTest.votes.castVote(engine, pollId, 'o1', 'mike');
    await window.__fhTest.votes.castVote(engine, pollId, 'o1', 'avery');
    await window.__fhTest.votes.castVote(engine, pollId, 'o2', 'avery'); // re-vote
    const view = await engine.remerge();
    const state = view.polls.get(pollId);
    return { votes: Object.fromEntries(state.votes), tallies: Object.fromEntries(state.tallies) };
  });

  expect(result.votes.mike.optionId).toBe('o1');
  expect(result.votes.avery.optionId).toBe('o2'); // replaced, not doubled
  expect(result.tallies.o1).toBe(1);
  expect(result.tallies.o2).toBe(1);

  // UI renders the votes panel with the poll
  await page.click('[data-tab="votes"]');
  await expect(page.locator('.poll-question', { hasText: 'Movie night?' })).toBeVisible();
});

test('SYNC-04 malformed remote lines are tolerated', async ({ page }) => {
  await seedAccounts({ [TEST_EMAIL]: accountPatch() })({ context: page.context() });
  await seedDirState(TEST_DIRSTATE)({ context: page.context() });

  const drive = mockDrive(page);
  await page.route('**/www.googleapis.com/**/drive/v3/**', drive.routeAll);

  await page.goto('/' + T);
  await expect(page.locator('#app')).toBeVisible({ timeout: 10_000 });

  // Plant a remote log with one malformed + one valid line via the adapter
  const good = {
    id: 'ev-remote1',
    ts: Date.now(),
    author: 'mike',
    type: 'note.upsert',
    payload: { noteId: 'n-remote', text: 'remote note' },
  };
  await page.evaluate(async (good) => {
    const adapter = window.__fhTest.engine.adapter;
    await adapter.appendToMyLog({
      folderId: 'FOLDER',
      dirFileId: 'DIRFILE',
      memberKey: 'mike',
      name: 'Mike',
      email: 'mike@test.local',
      events: [good],
    });
  }, good);

  // Corrupt the remote file with a garbage line, then sync — merge survives
  const logFile = [...drive.files.values()].find((f) => f.name.startsWith('mike-'));
  logFile.content = 'garbage-not-json\n' + logFile.content;

  const run = await page.evaluate(async () => window.__fhTest.engine.run());
  expect(run.provisioned).toBe(true);
  await page.click('[data-tab="notes"]');
  await expect(page.locator('.note-card .note-text', { hasText: 'remote note' })).toBeVisible();
});
