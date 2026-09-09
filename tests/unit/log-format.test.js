import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  generateId,
  logFileName,
  logFileRegex,
  makeEvent,
  validateEvent,
  parseLogLine,
  parseLogFile,
  mergeKey,
  EVENT_TYPES,
} from '../../js/storage/log-format.js';

test('logFileName renders YYYY-MM', () => {
  assert.equal(logFileName('mom', new Date(2026, 8, 9)), 'mom-2026-09.jsonl');
  assert.equal(logFileName('dad', new Date(2027, 0, 1)), 'dad-2027-01.jsonl');
});

test('logFileRegex matches canonical files and conflict copies, not others', () => {
  const re = logFileRegex('mom');
  assert.match('mom-2026-09.jsonl', re);
  assert.match('mom (1)-2026-09.jsonl', re);
  assert.match('mom (12)-2027-01.jsonl', re);
  assert.doesNotMatch('mom-2026-9.jsonl', re); // no zero-padding
  assert.doesNotMatch('dad-2026-09.jsonl', re);
  assert.doesNotMatch('dir.json', re);
  assert.doesNotMatch('mom-2026-09.jsonl.bak', re);
});

test('makeEvent fills required fields and generates ids', () => {
  const ev = makeEvent(EVENT_TYPES.NOTE_UPSERT, 'mom', { noteId: 'n1', text: 'hi' }, { now: 1000 });
  assert.equal(ev.ts, 1000);
  assert.equal(ev.author, 'mom');
  assert.match(ev.id, /^ev_/);
  assert.throws(() => makeEvent(EVENT_TYPES.NOTE_UPSERT, 'mom', { text: 'no id' }));
  assert.throws(() => makeEvent('no.such.type', 'mom', {}));
});

test('validateEvent accepts good events, rejects bad ones', () => {
  const good = makeEvent(EVENT_TYPES.VOTE_CAST, 'dad', { pollId: 'p1', optionId: 'o2' });
  assert.equal(validateEvent(good).ok, true);
  assert.equal(validateEvent({ ...good, ts: 'yesterday' }).ok, false);
  assert.equal(validateEvent({ ...good, author: '' }).ok, false);
  assert.equal(validateEvent({ ...good, type: 'nope' }).ok, false);
  assert.equal(validateEvent({ ...good, payload: { pollId: 'p1' } }).ok, false);
  assert.equal(validateEvent(null).ok, false);
});

test('parseLogLine returns null for malformed lines', () => {
  const good = makeEvent(EVENT_TYPES.NOTE_UPSERT, 'mom', { noteId: 'n1', text: 'x' });
  assert.deepEqual(parseLogLine(JSON.stringify(good)), good);
  assert.equal(parseLogLine(''), null);
  assert.equal(parseLogLine('   '), null);
  assert.equal(parseLogLine('not json'), null);
  assert.equal(parseLogLine('{"id":"x","ts":1,"author":"a","type":"bogus","payload":{}}'), null);
  assert.equal(parseLogLine('{"half": '), null);
});

test('parseLogFile counts malformed lines and survives them', () => {
  const good = makeEvent(EVENT_TYPES.NOTE_UPSERT, 'mom', { noteId: 'n1', text: 'x' });
  const text = ['garbage', '', JSON.stringify(good), '{"broken', ''].join('\n');
  const { events, malformed } = parseLogFile(text);
  assert.equal(events.length, 1);
  assert.equal(malformed, 2);
});

test('mergeKey maps every type', () => {
  assert.equal(mergeKey(makeEvent(EVENT_TYPES.NOTE_UPSERT, 'a', { noteId: 'n', text: 'x' })), 'note:n');
  assert.equal(mergeKey(makeEvent(EVENT_TYPES.NOTE_TOMBSTONE, 'a', { noteId: 'n' })), 'note:n');
  assert.equal(mergeKey(makeEvent(EVENT_TYPES.CHORE_UPSERT, 'a', { choreId: 'c', title: 't' })), 'chore:c');
  assert.equal(mergeKey(makeEvent(EVENT_TYPES.POLL_CREATED, 'a', { pollId: 'p', title: 't', kind: 'dinner', options: [] })), 'poll:p');
  assert.equal(mergeKey(makeEvent(EVENT_TYPES.POLL_CLOSED, 'a', { pollId: 'p' })), 'poll:closed:p');
  assert.equal(mergeKey(makeEvent(EVENT_TYPES.VOTE_CAST, 'dad', { pollId: 'p', optionId: 'o' })), 'vote:p:dad');
  assert.equal(mergeKey(makeEvent(EVENT_TYPES.CONFIG_UPSERT, 'a', { key: 'k', value: 1 })), 'config:k');
  assert.equal(mergeKey(makeEvent(EVENT_TYPES.MEMBER_JOINED, 'a', { key: 'k', name: 'n', email: 'e' })), 'member:k');
});

test('generated ids are unique', () => {
  const ids = new Set(Array.from({ length: 1000 }, generateId));
  assert.equal(ids.size, 1000);
});
