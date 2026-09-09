import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEvent, EVENT_TYPES } from '../../js/storage/log-format.js';
import { reduceEvents, buildView, mergeLogs, isNewerThan, isTie } from '../../js/storage/merge.js';

const NOW = 1725800000123;
const ev = (type, author, payload, ts = NOW) => makeEvent(type, author, payload, { now: ts });

test('LWW by ts: later edit wins', () => {
  const view = mergeLogs(
    [
      ev(EVENT_TYPES.NOTE_UPSERT, 'mom', { noteId: 'n1', text: 'old' }, 1000),
      ev(EVENT_TYPES.NOTE_UPSERT, 'mom', { noteId: 'n1', text: 'new' }, 2000),
    ],
    { now: NOW }
  );
  assert.equal(view.notes.get('n1').text, 'new');
});

test('LWW tie-break is (author, id) lexicographic and deterministic', () => {
  const a = ev(EVENT_TYPES.NOTE_UPSERT, 'aaron', { noteId: 'n1', text: 'a' }, 1000);
  const b = ev(EVENT_TYPES.NOTE_UPSERT, 'betty', { noteId: 'n1', text: 'b' }, 1000);
  // betty > aaron lexicographically → betty's event wins
  const view1 = mergeLogs([a, b], { now: NOW });
  const view2 = mergeLogs([b, a], { now: NOW });
  assert.equal(view1.notes.get('n1').text, 'b');
  assert.deepEqual(view1, view2); // order-independent
});

test('dedupe by id: offline replay duplicates are harmless', () => {
  const one = ev(EVENT_TYPES.NOTE_UPSERT, 'mom', { noteId: 'n1', text: 'x' }, 1000);
  const dup = { ...one };
  const view = mergeLogs([one, dup], { now: NOW });
  assert.equal(view.notes.size, 1);
  assert.equal(view.notes.get('n1').text, 'x');
});

test('tombstone removes; later upsert revives', () => {
  const view = mergeLogs(
    [
      ev(EVENT_TYPES.NOTE_UPSERT, 'mom', { noteId: 'n1', text: 'x' }, 1000),
      ev(EVENT_TYPES.NOTE_TOMBSTONE, 'mom', { noteId: 'n1' }, 2000),
    ],
    { now: NOW }
  );
  assert.equal(view.notes.has('n1'), false);

  const revived = mergeLogs(
    [
      ev(EVENT_TYPES.NOTE_UPSERT, 'mom', { noteId: 'n1', text: 'x' }, 1000),
      ev(EVENT_TYPES.NOTE_TOMBSTONE, 'mom', { noteId: 'n1' }, 2000),
      ev(EVENT_TYPES.NOTE_UPSERT, 'dad', { noteId: 'n1', text: 'back' }, 3000),
    ],
    { now: NOW }
  );
  assert.equal(revived.notes.get('n1').text, 'back');
});

test('clock skew: future ts is clamped to now+24h', () => {
  const farFuture = ev(EVENT_TYPES.NOTE_UPSERT, 'mom', { noteId: 'n1', text: 'future' }, NOW + 3 * 24 * 3600 * 1000);
  const view = mergeLogs([farFuture], { now: NOW });
  assert.equal(view.notes.get('n1').text, 'future');
  // the clamped timestamp must be visible to downstream LWW
  const { winners } = reduceEvents([farFuture], { now: NOW });
  assert.equal([...winners.values()][0].ts, NOW + 24 * 3600 * 1000);
});

test('votes tally per option and re-vote replaces the member vote', () => {
  const events = [
    ev(EVENT_TYPES.POLL_CREATED, 'mom', { pollId: 'p1', title: 'Dinner?', kind: 'dinner', options: [{ id: 'cook', label: 'Cook' }, { id: 'takeout', label: 'Takeout' }] }, 1000),
    ev(EVENT_TYPES.VOTE_CAST, 'mom', { pollId: 'p1', optionId: 'cook' }, 2000),
    ev(EVENT_TYPES.VOTE_CAST, 'dad', { pollId: 'p1', optionId: 'takeout' }, 3000),
    ev(EVENT_TYPES.VOTE_CAST, 'avery', { pollId: 'p1', optionId: 'cook' }, 4000),
    ev(EVENT_TYPES.VOTE_CAST, 'dad', { pollId: 'p1', optionId: 'cook' }, 5000), // re-vote
  ];
  const view = mergeLogs(events, { now: NOW });
  const poll = view.polls.get('p1');
  assert.equal(poll.poll.title, 'Dinner?');
  assert.equal(poll.votes.size, 3);
  assert.equal(poll.votes.get('dad'), 'cook');
  assert.equal(poll.tallies.get('cook'), 3);
  assert.equal(poll.tallies.get('takeout'), 0);
  assert.equal(isTie(poll.tallies, ['cook', 'takeout']), false);
});

test('poll.closed never destroys the poll definition (own merge key)', () => {
  const created = ev(EVENT_TYPES.POLL_CREATED, 'mom', { pollId: 'p1', title: 'Dinner?', kind: 'dinner', options: [{ id: 'cook', label: 'Cook' }] }, 1000);
  const closed = ev(EVENT_TYPES.POLL_CLOSED, 'mom', { pollId: 'p1', winner: 'cook' }, 9000);
  const view = mergeLogs([created, closed], { now: NOW });
  const poll = view.polls.get('p1');
  assert.equal(poll.poll.title, 'Dinner?');
  assert.equal(poll.closedWinner, 'cook');
});

test('close processed before create in event order still applies', () => {
  const created = ev(EVENT_TYPES.POLL_CREATED, 'mom', { pollId: 'p1', title: 'Dinner?', kind: 'dinner', options: [{ id: 'cook', label: 'Cook' }] }, 1000);
  const closed = ev(EVENT_TYPES.POLL_CLOSED, 'mom', { pollId: 'p1', winner: 'cook' }, 9000);
  // feed close first — must not lose it
  const view = mergeLogs([closed, created], { now: NOW });
  assert.equal(view.polls.get('p1').closedWinner, 'cook');
});

test('tie detection', () => {
  const tallies = new Map([['a', 1], ['b', 1]]);
  assert.equal(isTie(tallies, ['a', 'b']), true);
  assert.equal(isTie(new Map([['a', 2], ['b', 1]]), ['a', 'b']), false);
});

test('members and config accumulate across accounts', () => {
  const events = [
    ev(EVENT_TYPES.MEMBER_JOINED, 'mom', { key: 'mom', name: 'Mike', email: 'mike@x.com' }, 1000),
    ev(EVENT_TYPES.MEMBER_JOINED, 'dad', { key: 'dad', name: 'Charlie', email: 'charlie@x.com' }, 2000),
    ev(EVENT_TYPES.CONFIG_UPSERT, 'mom', { key: 'appPrefs', value: { theme: 'dark' } }, 3000),
  ];
  const view = mergeLogs(events, { now: NOW });
  assert.equal(view.members.size, 2);
  assert.equal(view.members.get('dad').name, 'Charlie');
  assert.deepEqual(view.config.get('appPrefs'), { theme: 'dark' });
});

test('malformed events are skipped by buildView', () => {
  const good = ev(EVENT_TYPES.NOTE_UPSERT, 'mom', { noteId: 'n1', text: 'x' });
  const view = mergeLogs([{ id: 'bad', ts: 1 }, good], { now: NOW });
  assert.equal(view.notes.get('n1').text, 'x');
});

test('isNewerThan strict ordering', () => {
  const base = { ts: 100, author: 'a', id: 'x' };
  assert.equal(isNewerThan({ ...base, ts: 101 }, base), true);
  assert.equal(isNewerThan({ ...base, author: 'b' }, base), true);
  assert.equal(isNewerThan({ ...base, id: 'y' }, base), true);
  assert.equal(isNewerThan(base, { ...base, ts: 101 }), false);
});
