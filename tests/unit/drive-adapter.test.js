import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DriveAdapter } from '../../js/storage/drive-adapter.js';
import { makeEvent, EVENT_TYPES } from '../../js/storage/log-format.js';

// ---- minimal in-memory Drive server ----

function createMockDrive() {
  const files = new Map(); // id → {name, mimeType, appProperties, parents, content, etag}
  let nextId = 1;
  let etagCounter = 0;

  const makeFile = (meta, content = '') => {
    const id = `f${nextId++}`;
    files.set(id, { id, content, etag: `e${etagCounter++}`, ...meta });
    return files.get(id);
  };

  const calls = []; // {method, url, body}

  async function handle(url, init = {}) {
    calls.push({ method: init.method ?? 'GET', url, body: init.body });
    const u = new URL(url);
    // Real Drive serves uploads from /upload/drive/v3/... — normalize so the
    // mock can't mask endpoint mistakes (mediaUpdate once hit the wrong host)
    const path = u.pathname.replace(/^\/upload(?=\/drive)/, '');
    const m = /^\/drive\/v3\/files\/([^/]+)(?:\/(permissions))?$/.exec(path);
    const listMatch = /^\/drive\/v3\/files\/?$/.test(path);

    // POST /files (create metadata-only)
    if (listMatch && (init.method ?? 'GET') === 'POST') {
      const meta = JSON.parse(init.body);
      const f = makeFile({ name: meta.name, mimeType: meta.mimeType, appProperties: meta.appProperties, parents: meta.parents ?? [] });
      return json(200, { id: f.id, name: f.name });
    }

    // GET /files?q=... (list children / property search)
    if (listMatch) {
      const q = u.searchParams.get('q') ?? '';
      const parentMatch = /'([^']+)' in parents/.exec(q);
      const propMatch = /appProperties has \{ key='([^']+)' and value='([^']+)' \}/.exec(q);
      const nameMatch = /name = '([^']+)'/.exec(q);
      let out = [...files.values()];
      if (parentMatch) out = out.filter((f) => f.parents.includes(parentMatch[1]));
      if (propMatch) out = out.filter((f) => f.appProperties?.[propMatch[1]] === propMatch[2]);
      if (nameMatch) out = out.filter((f) => f.name === nameMatch[1]);
      return json(200, { files: out.map((f) => ({ id: f.id, name: f.name, appProperties: f.appProperties, etag: f.etag, trashed: false })) });
    }

    // permissions create
    if (m && m[2] === 'permissions' && (init.method ?? 'GET') === 'POST') {
      calls.push({ method: 'permission', body: JSON.parse(init.body), fileId: m[1] });
      return json(200, { id: 'perm1' });
    }

    if (m) {
      const file = files.get(m[1]);
      if (!file) return json(404, { error: 'not found' });
      if (u.searchParams.get('alt') === 'media') {
        return new Response(file.content, { status: 200, headers: { etag: file.etag, 'content-type': 'text/plain' } });
      }
      if ((init.method ?? 'GET') === 'PATCH') {
        file.content = init.body;
        file.etag = `e${etagCounter++}`;
        return json(200, { id: file.id, etag: file.etag });
      }
      // metadata GET
      const { fields } = u.searchParams;
      const meta = {
        id: file.id,
        name: file.name,
        etag: file.etag,
        appProperties: file.appProperties,
        parents: file.parents,
        trashed: false,
      };
      return json(200, meta);
    }
    return json(404, { error: 'no match' });
  }

  function json(status, body) {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }

  return {
    handle,
    files,
    calls,
    seed: makeFile,
    // simulate another member appending to a file between our read and write
    externalAppend(fileId, line) {
      const f = files.get(fileId);
      f.content = (f.content ? f.content + '\n' : '') + line + '\n';
      f.etag = `e${etagCounter++}`;
    },
  };
}

const NOW = 1788955200000; // 2026-09-09T12:00:00Z — matches seeded 2026-09 logs
const fakeToken = async () => 'test-token';

function makeAdapter(drive) {
  return new DriveAdapter({ fetchFn: (url, init) => drive.handle(url, init), getAccessToken: fakeToken, clock: () => NOW });
}

function provisionedDrive(drive) {
  // folder + dir.json + member log, as provision() would leave them
  const folder = drive.seed({ name: 'Family Hub', mimeType: 'application/vnd.google-apps.folder', appProperties: { familyHubFolder: '1' }, parents: [] });
  const dirFile = drive.seed({ name: 'dir.json', mimeType: 'application/json', appProperties: { familyHubFile: 'dir' }, parents: [folder.id] }, JSON.stringify({ v: 1, members: {} }, null, 2));
  const logFile = drive.seed({ name: 'mom-2026-09.jsonl', mimeType: 'text/plain', appProperties: { familyHubFile: 'mom' }, parents: [folder.id] }, '');
  return { folder, dirFile, logFile };
}

test('provision creates folder + dir.json', async () => {
  const drive = createMockDrive();
  const adapter = makeAdapter(drive);
  const { folderId, dirFileId } = await adapter.provision({ name: 'Mike', email: 'mike@x.com' });
  const folder = drive.files.get(folderId);
  assert.equal(folder.name, 'Family Hub');
  assert.equal(folder.appProperties.familyHubFolder, '1');
  assert.equal(drive.files.get(dirFileId).name, 'dir.json');
});

test('appendToMyLog appends and read-back acknowledges', async () => {
  const drive = createMockDrive();
  const adapter = makeAdapter(drive);
  const { folder, dirFile, logFile } = provisionedDrive(drive);

  const events = [
    makeEvent(EVENT_TYPES.NOTE_UPSERT, 'mom', { noteId: 'n1', text: 'hello' }, { now: NOW }),
    makeEvent(EVENT_TYPES.NOTE_UPSERT, 'mom', { noteId: 'n2', text: 'world' }, { now: NOW }),
  ];
  const result = await adapter.appendToMyLog({
    folderId: folder.id,
    dirFileId: dirFile.id,
    memberKey: 'mom',
    name: 'Mike',
    email: 'mike@x.com',
    events,
  });

  assert.deepEqual(result.acknowledged.sort(), ['n1', 'n2'].map((n) => events.find((e) => e.payload.noteId === n).id).sort());
  assert.equal(result.unacknowledged.length, 0);
  const content = drive.files.get(logFile.id).content;
  for (const ev of events) assert.match(content, new RegExp(`"id":"${ev.id}"`));
});

test('re-append is idempotent: existing ids acked, no duplicates', async () => {
  const drive = createMockDrive();
  const adapter = makeAdapter(drive);
  const { folder, dirFile, logFile } = provisionedDrive(drive);

  const ev1 = makeEvent(EVENT_TYPES.NOTE_UPSERT, 'mom', { noteId: 'n1', text: 'hello' }, { now: NOW });
  await adapter.appendToMyLog({ folderId: folder.id, dirFileId: dirFile.id, memberKey: 'mom', name: 'M', email: 'm@x.com', events: [ev1] });
  // replay the same event (offline retry / lost-ack case)
  const again = await adapter.appendToMyLog({ folderId: folder.id, dirFileId: dirFile.id, memberKey: 'mom', name: 'M', email: 'm@x.com', events: [ev1] });
  assert.deepEqual(again.acknowledged, [ev1.id]);
  const count = drive.files.get(logFile.id).content.split('\n').filter((l) => l.includes(ev1.id)).length;
  assert.equal(count, 1);
});

test('lost update degrades gracefully: other writer between read and write → our ids retry', async () => {
  const drive = createMockDrive();
  const adapter = makeAdapter(drive);
  const { folder, dirFile, logFile } = provisionedDrive(drive);

  const mine = makeEvent(EVENT_TYPES.NOTE_UPSERT, 'mom', { noteId: 'n1', text: 'mine' }, { now: NOW });

  // Intercept: a concurrent writer appends to the same log AFTER our read but
  // BEFORE our blind write lands (simulated by appending on the PATCH, then
  // letting the PATCH overwrite the whole content).
  const originalHandle = drive.handle;
  let firstLogPatch = true;
  drive.handle = async (url, init) => {
    const u = new URL(url);
    if ((init.method ?? 'GET') === 'PATCH' && u.pathname.includes(logFile.id) && firstLogPatch) {
      firstLogPatch = false;
      const other = makeEvent(EVENT_TYPES.NOTE_UPSERT, 'dad', { noteId: 'n2', text: 'theirs' }, { now: NOW });
      drive.externalAppend(logFile.id, JSON.stringify(other));
    }
    return originalHandle(url, init);
  };

  const result = await adapter.appendToMyLog({ folderId: folder.id, dirFileId: dirFile.id, memberKey: 'mom', name: 'M', email: 'm@x.com', events: [mine] });
  // our blind PATCH clobbered dad's line; read-back still contains OUR id → acked
  assert.deepEqual(result.acknowledged, [mine.id]);
  // retry next sync: dad's line is gone from the file (acceptable degradation —
  // dad's device still has it unconfirmed and will re-append it as a duplicate line)
  const content = drive.files.get(logFile.id).content;
  assert.doesNotMatch(content, /"n2"/);
});

test('cross-month events split into separate monthly files', async () => {
  const drive = createMockDrive();
  const adapter = makeAdapter(drive);
  const { folder, dirFile, logFile } = provisionedDrive(drive);

  const nextMonth = new Date(Date.UTC(2026, 9, 2)).getTime(); // Oct 2026
  const octEv = makeEvent(EVENT_TYPES.NOTE_UPSERT, 'mom', { noteId: 'oct1', text: 'oct' }, { now: nextMonth });
  const result = await adapter.appendToMyLog({ folderId: folder.id, dirFileId: dirFile.id, memberKey: 'mom', name: 'M', email: 'm@x.com', events: [octEv] });
  assert.equal(result.acknowledged.length, 1);

  // a new file mom-2026-10.jsonl must exist and contain the event
  const octFile = [...drive.files.values()].find((f) => f.name === 'mom-2026-10.jsonl');
  assert.ok(octFile, 'october file created');
  assert.match(octFile.content, /"oct1"/);
  // dir.json must register the new month
  const dir = JSON.parse(drive.files.get(dirFile.id).content);
  assert.equal(dir.members.mom.months['2026-10'], octFile.id);
});

test('readAllLogs reads all members and skips unchanged files by etag', async () => {
  const drive = createMockDrive();
  const adapter = makeAdapter(drive);
  const { folder, dirFile, logFile } = provisionedDrive(drive);
  const dadLog = drive.seed({ name: 'dad-2026-09.jsonl', mimeType: 'text/plain', parents: [folder.id] }, '');
  const dadEv = makeEvent(EVENT_TYPES.NOTE_UPSERT, 'dad', { noteId: 'd1', text: 'dad note' }, { now: NOW });
  drive.files.get(dadLog.id).content = JSON.stringify(dadEv) + '\n';

  const first = await adapter.readAllLogs({ folderId: folder.id, dirFileId: dirFile.id });
  assert.equal(first.logs.length, 2);
  assert.equal(first.malformed, 0);
  const etags = Object.fromEntries(first.logs.map((l) => [l.fileId, l.etag]));

  const second = await adapter.readAllLogs({ folderId: folder.id, dirFileId: dirFile.id, knownEtags: etags });
  assert.ok(second.logs.every((l) => l.unchanged));
});

test('shareWith sends a user-scoped writer permission', async () => {
  const drive = createMockDrive();
  const adapter = makeAdapter(drive);
  const { folder } = provisionedDrive(drive);
  await adapter.shareWith({ folderId: folder.id, email: 'charlie@x.com' });
  const permCall = drive.calls.find((c) => c.method === 'permission');
  assert.equal(permCall.fileId, folder.id);
  assert.deepEqual(permCall.body, { type: 'user', role: 'writer', emailAddress: 'charlie@x.com' });
});

test('join registers member + own log in dir.json', async () => {
  const drive = createMockDrive();
  const adapter = makeAdapter(drive);
  const { folder, dirFile, logFile } = provisionedDrive(drive);

  await adapter.join({ folderId: folder.id, dirFileId: dirFile.id, memberKey: 'dad', name: 'Charlie', email: 'charlie@x.com' });
  const dir = JSON.parse(drive.files.get(dirFile.id).content);
  assert.equal(dir.members.dad.name, 'Charlie');
  const dadLog = [...drive.files.values()].find((f) => f.appProperties?.familyHubFile === 'dad');
  assert.ok(dadLog);
  assert.equal(dir.members.dad.months['2026-09'], dadLog.id);
});
