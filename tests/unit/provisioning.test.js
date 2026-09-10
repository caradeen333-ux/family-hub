import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveMemberKey,
  buildInviteLink,
  parseInvite,
  provisionFirstUser,
  joinFamily,
} from '../../js/provisioning.js';

// Fake adapter recording calls — provisioning only cares about the sequence
function fakeAdapter() {
  const calls = [];
  return {
    calls,
    async provision({ name, email }) {
      calls.push(['provision', { name, email }]);
      return { folderId: 'FOLDER', dirFileId: 'DIRFILE' };
    },
    async join({ folderId, dirFileId, memberKey, name, email }) {
      calls.push(['join', { folderId, dirFileId, memberKey, name, email }]);
      return { folderId, dirFileId, logFileId: 'LOGFILE', memberKey };
    },
    async appendToMyLog(args) {
      calls.push(['appendToMyLog', args]);
      return { acknowledged: args.events.map((e) => e.id), unacknowledged: [] };
    },
    async shareWith(args) {
      calls.push(['shareWith', args]);
    },
  };
}

const NOW = 1725800000123;

test('deriveMemberKey sanitizes email local part', () => {
  assert.equal(deriveMemberKey('Mike.Murphy@x.com'), 'mikemurphy');
  assert.equal(deriveMemberKey('avery-q@x.com'), 'averyq');
  assert.throws(() => deriveMemberKey('@x.com'));
  assert.throws(() => deriveMemberKey('!@#@x.com'));
});

test('invite link round-trips through base64url', () => {
  const link = buildInviteLink({ folderId: 'FOLDER1', dirFileId: 'DIRFILE1', origin: 'https://x.example' });
  assert.equal(link, 'https://x.example/#invite=' + link.split('=')[1]);
  const parsed = parseInvite('#' + link.split('#')[1]);
  assert.deepEqual(parsed, { folderId: 'FOLDER1', dirFileId: 'DIRFILE1' });
});

test('parseInvite rejects garbage', () => {
  assert.equal(parseInvite('#invite=!!!notbase64'), null);
  assert.equal(parseInvite('#invite=eyJ2IjoyfQ'), null); // wrong version
  assert.equal(parseInvite('#invite='), null);
  assert.equal(parseInvite('#other=stuff'), null);
});

test('provisionFirstUser sequences provision → join → founding events', async () => {
  const adapter = fakeAdapter();
  const result = await provisionFirstUser(adapter, { name: 'Mike', email: 'mike@x.com', clock: () => NOW });
  assert.deepEqual(result, { folderId: 'FOLDER', dirFileId: 'DIRFILE', logFileId: 'LOGFILE', memberKey: 'mike' });

  const [first, second, third] = adapter.calls.map((c) => c[0]);
  assert.equal(first, 'provision');
  assert.equal(second, 'join');
  assert.equal(third, 'appendToMyLog');

  const events = adapter.calls[2][1].events;
  assert.deepEqual(events.map((e) => e.type), ['member.joined', 'config.upsert']);
  assert.equal(events[0].payload.key, 'mike');
});

test('provisionFirstUser stores the family name as its own config event', async () => {
  const adapter = fakeAdapter();
  await provisionFirstUser(adapter, { name: 'Mike', email: 'mike@x.com', familyName: 'The Murphys', clock: () => NOW });
  const events = adapter.calls[2][1].events;
  const familyEvent = events.find((e) => e.type === 'config.upsert' && e.payload.key === 'familyName');
  assert.ok(familyEvent, 'familyName config event exists');
  assert.equal(familyEvent.payload.value, 'The Murphys');
});

test('joinFamily sequences join → member.joined', async () => {
  const adapter = fakeAdapter();
  const result = await joinFamily(adapter, {
    invite: { folderId: 'FOLDER', dirFileId: 'DIRFILE' },
    name: 'Charlie',
    email: 'charlie.d@x.com',
    clock: () => NOW,
  });
  assert.equal(result.memberKey, 'charlied');
  const events = adapter.calls[1][1].events;
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'member.joined');
});

test('joinFamily uses the adapter-resolved key when collisions suffix it', async () => {
  const adapter = fakeAdapter();
  adapter.join = async ({ memberKey }) => ({ folderId: 'F', dirFileId: 'D', logFileId: 'L', memberKey: memberKey + '2' });
  const result = await joinFamily(adapter, {
    invite: { folderId: 'FOLDER', dirFileId: 'DIRFILE' },
    name: 'Charlie',
    email: 'charlie.d@x.com',
    clock: () => NOW,
  });
  assert.equal(result.memberKey, 'charlied2');
  // The member.joined event must carry the FINAL key, not the derived one
  // (the overridden join doesn't record itself — the append is calls[0])
  const events = adapter.calls.find((c) => c[0] === 'appendToMyLog')[1].events;
  assert.equal(events[0].payload.key, 'charlied2');
  assert.equal(events[0].author, 'charlied2');
});
