// drive-adapter.js — Google Drive REST storage adapter (no gapi).
//
// Scope: drive.file only. Discovery is dir.json-first (a directory file in the
// shared folder mapping member → file ids), invite links carry {folderId,
// dirFileId} so a joining member's files.get(dirFileId) is the required
// "open" gesture under drive.file.
//
// Appends: Drive has no append API. RMW per plan:
//   files.get(alt=media) → append pending lines not already present by id →
//   files.update → read-back acknowledgment. Lost updates degrade to
//   duplicate lines, and duplicates are invisible to the merge engine.

import { logFileName, parseLogFile, makeEvent } from './log-format.js';

const DRIVE_API = 'https://www.googleapis.com/drive/v3/files';
const DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
const APP_FOLDER_PROP = 'familyHubFolder';
const APP_FILE_PROP = 'familyHubFile';
const DIR_FILE_NAME = 'dir.json';
const RMW_RETRIES = 3;

export class DriveAdapter {
  // fetchFn injectable for tests; getAccessToken() → Promise<access_token string>
  constructor({ fetchFn = fetch, getAccessToken, clock = () => Date.now() }) {
    this.fetchFn = fetchFn;
    this.getAccessToken = getAccessToken;
    this.clock = clock;
  }

  // ---- low-level REST ----

  async authHeaders() {
    const token = await this.getAccessToken();
    return { Authorization: `Bearer ${token}` };
  }

  async driveFetch(path, { method = 'GET', body, headers = {}, query = '', expectJson = true } = {}) {
    const url = `${DRIVE_API}/${path}${query ? `?${query}` : ''}`;
    const resp = await this.fetchFn(url, {
      method,
      headers: { ...(await this.authHeaders()), ...headers },
      body,
    });
    if (resp.status === 401) {
      const err = new Error('drive-401');
      err.status = 401;
      throw err; // sync-engine handles re-auth + retry
    }
    return resp;
  }

  async driveJson(path, opts) {
    const resp = await this.driveFetch(path, opts);
    if (!resp.ok) {
      const err = new Error(`Drive ${opts?.method ?? 'GET'} ${path} failed (${resp.status})`);
      err.status = resp.status;
      err.detail = await resp.text().catch(() => '');
      throw err;
    }
    return resp.json();
  }

  async mediaGet(fileId) {
    const resp = await this.driveFetch(`${fileId}`, { query: 'alt=media', expectJson: false });
    if (!resp.ok) {
      const err = new Error(`Drive media get ${fileId} failed (${resp.status})`);
      err.status = resp.status;
      throw err;
    }
    return { text: await resp.text(), etag: resp.headers.get('etag') };
  }

  // Metadata-only create; content set via mediaUpdate afterwards
  async createFile({ name, mimeType = 'text/plain', parents, appProperties }) {
    const body = { name, mimeType };
    if (parents?.length) body.parents = parents;
    if (appProperties) body.appProperties = appProperties;
    return this.driveJson('', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  // Full-content update. Deliberately no If-Match: Drive's conditional-write
  // support for media uploads is inconsistent, and a rejected header would
  // break appends outright. Correctness comes from the read-back ack instead —
  // a clobbered update leaves our ids out of the file and they retry next
  // sync as duplicate lines (invisible to merge). Spike S5 tunes this.
  async mediaUpdate(fileId, text, etag) {
    const resp = await this.driveFetch(`${fileId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'text/plain' },
      body: text,
      expectJson: false,
    });
    if (resp.status === 412 || resp.status === 409) {
      const err = new Error(`Drive update conflict on ${fileId}`);
      err.conflict = true;
      throw err;
    }
    if (!resp.ok) {
      const err = new Error(`Drive media update ${fileId} failed (${resp.status})`);
      err.status = resp.status;
      throw err;
    }
    return resp.json().catch(() => ({}));
  }

  async getMetadata(fileId) {
    return this.driveJson(`${fileId}`, {
      query: 'fields=id,name,etag,appProperties,parents,trashed',
    });
  }

  async listChildren(folderId, query = '', fields = 'files(id,name,appProperties,etag,trashed)') {
    const q = [`'${folderId}' in parents`, 'trashed = false', query].filter(Boolean).join(' and ');
    const url = `${DRIVE_API}?q=${encodeURIComponent(q)}&fields=${fields}&pageSize=1000`;
    const resp = await this.fetchFn(url, { headers: await this.authHeaders() });
    if (!resp.ok) {
      const err = new Error(`Drive list failed (${resp.status})`);
      err.status = resp.status;
      throw err;
    }
    return (await resp.json()).files ?? [];
  }

  // ---- provisioning ----

  // First person: find-or-create the family folder, then dir.json + own log.
  async provision({ name, email }) {
    let folder = await this.findFolderByProperty();
    if (!folder) folder = await this.findFolderByName('Family Hub');
    if (!folder) {
      folder = await this.createFile({
        name: 'Family Hub',
        mimeType: 'application/vnd.google-apps.folder',
        appProperties: { [APP_FOLDER_PROP]: '1' },
      });
    }

    const dirFile = await this.createFile({
      name: DIR_FILE_NAME,
      mimeType: 'application/json',
      parents: [folder.id],
      appProperties: { [APP_FILE_PROP]: 'dir' },
    });

    return {
      folderId: folder.id,
      dirFileId: dirFile.id,
    };
  }

  async findFolderByProperty() {
    // drive.file may not surface folders created by other users; the first
    // user provisions so this is our own folder — query by appProperty.
    const url = `${DRIVE_API}?q=${encodeURIComponent(
      `appProperties has { key='${APP_FOLDER_PROP}' and value='1' } and trashed = false`
    )}&fields=files(id,name)&pageSize=10`;
    const resp = await this.fetchFn(url, { headers: await this.authHeaders() });
    if (!resp.ok) throw new Error(`Drive folder search failed (${resp.status})`);
    const files = (await resp.json()).files ?? [];
    return files[0] ?? null;
  }

  async findFolderByName(name) {
    const url = `${DRIVE_API}?q=${encodeURIComponent(
      `name = '${name}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`
    )}&fields=files(id,name)&pageSize=10`;
    const resp = await this.fetchFn(url, { headers: await this.authHeaders() });
    if (!resp.ok) throw new Error(`Drive folder search failed (${resp.status})`);
    return (await resp.json()).files?.[0] ?? null;
  }

  // Invite another person as a writer on the folder (never 'anyone')
  async shareWith({ folderId, email }) {
    return this.driveJson(`${folderId}/permissions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'user', role: 'writer', emailAddress: email }),
    });
  }

  // ---- join ----

  // Joining member: the files.get below is the drive.file "open" gesture.
  // Registers own member entry + current month's log into dir.json.
  async join({ folderId, dirFileId, memberKey, name, email }) {
    await this.getMetadata(dirFileId); // open gesture — throws if not granted
    const month = this.currentMonth();
    const logFile = await this.createFile({
      name: logFileName(memberKey, month),
      parents: [folderId],
      appProperties: { [APP_FILE_PROP]: memberKey },
    });
    await this.registerFiles({ dirFileId, memberKey, name, email, files: { [this.monthKey(month)]: logFile.id } });
    return { folderId, dirFileId, logFileId: logFile.id };
  }

  // ---- discovery ----

  currentMonth() {
    return new Date(this.clock());
  }

  monthKey(date) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
  }

  // Read dir.json (metadata + media). Returns {members, etag} or null.
  async readDir(dirFileId) {
    if (!dirFileId) return null;
    try {
      const [meta, media] = await Promise.all([this.getMetadata(dirFileId), this.mediaGet(dirFileId)]);
      let parsed = null;
      try {
        parsed = JSON.parse(media.text);
      } catch {
        parsed = null; // corrupted dir.json — discovery falls back to listing
      }
      return { etag: media.etag, meta, data: parsed };
    } catch (err) {
      if (err.status === 404) return null;
      throw err;
    }
  }

  // RMW-append member registration into dir.json (append-only entries converge)
  async registerFiles({ dirFileId, memberKey, name, email, files }) {
    for (let attempt = 1; ; attempt++) {
      const dir = await this.readDir(dirFileId);
      const data = dir?.data ?? { v: 1, members: {} };
      const member = data.members?.[memberKey] ?? {};
      data.v = 1;
      data.members ??= {};
      data.members[memberKey] = {
        ...member,
        name: name ?? member.name,
        email: email ?? member.email,
        months: { ...(member.months ?? {}), ...files },
      };
      const text = JSON.stringify(data, null, 2);
      try {
        await this.mediaUpdate(dirFileId, text, dir?.etag);
        return;
      } catch (err) {
        if (err.conflict && attempt < RMW_RETRIES) continue;
        throw err;
      }
    }
  }

  // Discover member log files: dir.json first, then drive.file listing of
  // the folder by the log-file name pattern, then manual paste (caller).
  async discoverLogs({ folderId, dirFileId }) {
    const dir = await this.readDir(dirFileId);
    const found = []; // {memberKey, name, fileId, conflictCopy}
    const seen = new Set();

    const add = (memberKey, name, fileId, conflictCopy = false) => {
      const key = `${memberKey}:${fileId}`;
      if (!seen.has(key)) {
        seen.add(key);
        found.push({ memberKey, name, fileId, conflictCopy });
      }
    };

    for (const [memberKey, member] of Object.entries(dir?.data?.members ?? {})) {
      for (const [month, fileId] of Object.entries(member.months ?? {})) {
        if (typeof fileId === 'string') add(memberKey, `${memberKey}-${month}.jsonl`, fileId);
      }
    }

    // Fallback / conflict-copy sweep: list the folder, match by filename
    // pattern (conflict copies like `mom (1)-2026-09.jsonl` included).
    const children = await this.listChildren(folderId);
    for (const file of children) {
      if (file.name === DIR_FILE_NAME) continue;
      const m = file.name.match(/^([\w.-]+?)(\s\(\d+\))?-\d{4}-\d{2}\.jsonl$/);
      if (m) add(m[1], file.name, file.id, Boolean(m[2]));
    }
    return { dir, logs: found };
  }

  // ---- reading logs ----

  // Read all discovered logs. 304-aware: skip unchanged files when etags match
  // a previously seen state (caller passes knownEtags = {fileId: etag}).
  async readAllLogs({ folderId, dirFileId, knownEtags = {} }) {
    const { dir, logs } = await this.discoverLogs({ folderId, dirFileId });
    const out = { dirFileId, folderId, dirEtag: dir?.etag, logs: [], malformed: 0 };
    for (const entry of logs) {
      try {
        const meta = await this.getMetadata(entry.fileId);
        if (meta.trashed) continue;
        if (knownEtags[entry.fileId] === meta.etag) {
          out.logs.push({ ...entry, unchanged: true });
          continue;
        }
        const media = await this.mediaGet(entry.fileId);
        const parsed = parseLogFile(media.text);
        out.logs.push({ ...entry, events: parsed.events, malformed: parsed.malformed, etag: meta.etag, unchanged: false });
        out.malformed += parsed.malformed;
      } catch (err) {
        if (err.status === 404) continue; // deleted between list and get
        throw err;
      }
    }
    return out;
  }

  // ---- appending ----

  // Append the caller's own events to their monthly file(s). Groups by month,
  // RMW with etag guard, then read-back acknowledges each event id.
  // Returns {acknowledged: [ids], unacknowledged: [ids]}
  async appendToMyLog({ folderId, dirFileId, memberKey, name, email, events }) {
    const byMonth = new Map();
    for (const ev of events) {
      const month = this.monthKey(new Date(ev.ts));
      if (!byMonth.has(month)) byMonth.set(month, []);
      byMonth.get(month).push(ev);
    }

    const acknowledged = [];
    const unacknowledged = [];

    for (const [month, monthEvents] of byMonth) {
      const fileId = await this.ensureMonthlyFile({ folderId, dirFileId, memberKey, name, email, month });
      for (let attempt = 1; ; attempt++) {
        try {
          await this.rmwAppend(fileId, monthEvents, acknowledged, unacknowledged);
          break;
        } catch (err) {
          if (err.conflict && attempt < RMW_RETRIES) continue;
          // Lost update: keep entries unacknowledged — they'll retry next sync
          // and degrade to duplicate lines (invisible to merge).
          if (err.conflict) {
            for (const ev of monthEvents) unacknowledged.push(ev.id);
            break;
          }
          throw err;
        }
      }
    }
    return { acknowledged, unacknowledged };
  }

  // Find-or-create this member's monthly log file and record it in dir.json
  async ensureMonthlyFile({ folderId, dirFileId, memberKey, name, email, month }) {
    const { dir, logs } = await this.discoverLogs({ folderId, dirFileId });
    const canonical = logFileName(memberKey, new Date(month + '-01T00:00:00'));
    let fileId = logs.find(
      (l) => l.memberKey === memberKey && !l.conflictCopy && l.name === canonical
    )?.fileId;

    if (!fileId) {
      const created = await this.createFile({
        name: canonical,
        parents: [folderId],
        appProperties: { [APP_FILE_PROP]: memberKey },
      });
      fileId = created.id;
      await this.registerFiles({ dirFileId, memberKey, name, email, files: { [month]: fileId } });
    }
    return fileId;
  }

  // Single RMW cycle: read media, append lines for events not already present
  // by id, write back, then read back and acknowledge ids actually present.
  async rmwAppend(fileId, events, acknowledged, unacknowledged) {
    const { text, etag } = await this.mediaGet(fileId);
    const existingIds = new Set(
      text
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line).id;
          } catch {
            return null;
          }
        })
    );

    const pending = [];
    for (const ev of events) {
      if (existingIds.has(ev.id)) {
        acknowledged.push(ev.id); // already there — acked
      } else {
        pending.push(ev);
      }
    }
    if (!pending.length) return;

    const newText =
      (text ? text.replace(/\s+$/, '') + '\n' : '') +
      pending.map((ev) => JSON.stringify(ev)).join('\n') +
      '\n';

    await this.mediaUpdate(fileId, newText, etag);

    // Read-back acknowledgment
    const after = await this.mediaGet(fileId);
    const afterIds = new Set();
    for (const line of after.text.split(/\r?\n/)) {
      try {
        afterIds.add(JSON.parse(line).id);
      } catch {
        /* skip */
      }
    }
    for (const ev of pending) {
      if (afterIds.has(ev.id)) acknowledged.push(ev.id);
      else unacknowledged.push(ev.id);
    }
  }

  // ---- config (config.upsert events live in the log) ----

  async writeConfig({ key, value, authorKey, ...appendArgs }) {
    return this.appendToMyLog({
      ...appendArgs,
      events: [makeEvent('config.upsert', authorKey, { key, value }, { now: this.clock() })],
    });
  }

  // Convenience: create this month's file without appending (used by provision)
  async createMonthlyFile({ folderId, dirFileId, memberKey, name, email }) {
    const month = this.monthKey(this.currentMonth());
    return this.ensureMonthlyFile({ folderId, dirFileId, memberKey, name, email, month });
  }

  // readConfig is derived by the sync engine from readAllLogs + merge —
  // provided here for interface completeness on adapters that store config
  // outside the log (WebDAV may not).
  async readConfig() {
    return null;
  }
}
