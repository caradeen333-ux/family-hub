import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatTime, matchSharedCalendars } from '../../js/calendar.js';

test('formatTime renders 12-hour times', () => {
  assert.equal(formatTime('2026-09-10T09:00:00'), '9 AM');
  assert.equal(formatTime('2026-09-10T17:30:00'), '5:30 PM');
});

test('matchSharedCalendars links members to calendars by email', () => {
  const members = new Map([
    ['mike', { email: 'mike@x.com' }],
    ['charlie', { email: 'charlie@x.com' }],
    ['avery', { email: 'avery@x.com' }],
  ]);
  const calendarList = [
    { id: 'mike@x.com', summary: 'Mike' },
    { id: 'avery@x.com', summary: 'Avery' },
    { id: 'someone@else.com', summary: 'Stranger' },
  ];
  const matched = matchSharedCalendars(members, calendarList);
  assert.deepEqual(matched, { mike: 'mike@x.com', avery: 'avery@x.com' });
  // charlie hasn't shared yet → absent
  assert.equal('charlie' in matched, false);
});

test('matchSharedCalendars is case-insensitive on emails', () => {
  const members = new Map([['mike', { email: 'Mike@X.com' }]]);
  assert.deepEqual(matchSharedCalendars(members, [{ id: 'mike@x.com' }]), { mike: 'mike@x.com' });
});
