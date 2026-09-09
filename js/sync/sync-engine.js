// sync-engine.js — Local-first sync loop over the storage adapter.
//
//   mutate()   append to IndexedDB log → re-merge → re-render → flush later
//   run()      discover → readAllLogs (etag-aware) → mirror remote events →
//              merge everything → flush unconfirmed to Drive → save view
//
// Offline is the default posture; Drive is a background mirror. Unconfirmed
// events retry on `online` and on a timer, and replay is safe: merge dedupes
// by event id.

import { makeEvent } from '../storage/log-format.js';
import { mergeLogs } from '../storage/merge.js';
import * as localDb from '../storage/local-db.js';
import { clock } from '../testing/clock.js';
import { ensureValidToken } from '../auth/token.js';
import { getActiveEmail } from '../auth/token-store.js';
import { deriveMemberKey } from '../provisioning.js';
import { DriveAdapter } from '../storage/drive-adapter.js';

const FLUSH_INTERVAL_MS = 30 * 1000;
const KV_DIRSTATE = 'dirState';
const KV_ETAGS = 'knownEtags';

const listeners = new Set();

export class SyncEngine {
  constructor({ adapter }) {
    this.adapter = adapter;
    this.view = null; // merged view-model
    this.dirState = null; // {folderId, dirFileId, memberKey, name, email}
    this.flushTimer = null;
    this.running = false;
    this.lastSyncAt = null;
  }

  onChange(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  emit(change) {
    for (const fn of listeners) fn(change);
  }

  // ---- membership ----

  activeMemberKey() {
    const email = getActiveEmail();
    if (!email) return null;
    // member.joined events carry the canonical key for this email
    for (const [key, member] of this.view?.members ?? []) {
      if (member.email === email) return key;
    }
    return deriveMemberKey(email);
  }

  // ---- boot ----

  async init() {
    this.view = (await localDb.getKv('cachedView')) ?? null;
    this.dirState = (await localDb.getKv(KV_DIRSTATE)) ?? null;
    // Render cached state instantly (offline-first boot)
    if (this.view) this.emit({ type: 'view', view: this.view, cached: true });
    return this;
  }

  // ---- local-first mutations ----

  // Append a mutation to the local log and re-merge immediately. The UI
  // re-renders from the returned view; Drive flush happens in the background.
  async mutate(type, payload, { author = this.activeMemberKey() } = {}) {
    if (!author) throw new Error('no active member');
    const event = makeEvent(type, author, payload, { now: clock.now() });
    await localDb.appendLocal([event]);
    await this.remerge();
    this.scheduleFlush();
    return event;
  }

  // Rebuild the merged view from everything local (own + mirrored remote)
  async remerge() {
    const events = await localDb.getLocalEvents();
    this.view = mergeLogs(events, { now: clock.now() });
    await localDb.setKv('cachedView', this.view);
    this.emit({ type: 'view', view: this.view, cached: false });
    return this.view;
  }

  scheduleFlush() {
    clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => this.flush().catch(() => {}), FLUSH_INTERVAL_MS);
  }

  // ---- sync cycle ----

  async run() {
    if (this.running) return;
    this.running = true;
    try {
      if (!this.dirState) return { provisioned: false }; // caller runs provisioning wizard

      const knownEtags = (await localDb.getKv(KV_ETAGS)) ?? {};
      const result = await this.adapter.readAllLogs({
        folderId: this.dirState.folderId,
        dirFileId: this.dirState.dirFileId,
        knownEtags,
      });

      const remoteEvents = result.logs.flatMap((l) => l.events ?? []);
      if (remoteEvents.length) await localDb.mirrorEvents(remoteEvents);

      // Record fresh etags for unchanged-detection next cycle
      const etags = Object.fromEntries(result.logs.filter((l) => l.etag).map((l) => [l.fileId, l.etag]));
      await localDb.setKv(KV_ETAGS, etags);

      await this.remerge();
      this.lastSyncAt = clock.now();
      await this.flush();
      this.emit({ type: 'synced', remoteEvents: remoteEvents.length, malformed: result.malformed });
      return { provisioned: true, remoteEvents: remoteEvents.length };
    } finally {
      this.running = false;
    }
  }

  // ---- flush local writes to Drive ----
  // Single-flight: boot sync, timers, online events, and user actions can all
  // trigger flushes — concurrent RMW appends to the same Drive file waste
  // requests and can clobber each other's reads. One shared promise instead.

  async flush() {
    if (this.flushing) return this.flushing;
    this.flushing = this._flush().finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }

  async _flush() {
    if (!this.dirState) return { acknowledged: [], unacknowledged: [] };
    const unconfirmed = await localDb.getUnconfirmed();
    if (!unconfirmed.length) return { acknowledged: [], unacknowledged: [] };

    const result = await this.adapter.appendToMyLog({
      folderId: this.dirState.folderId,
      dirFileId: this.dirState.dirFileId,
      memberKey: this.dirState.memberKey,
      name: this.dirState.name,
      email: this.dirState.email,
      events: unconfirmed,
    });
    if (result.acknowledged.length) {
      await localDb.markConfirmed(result.acknowledged);
      this.emit({ type: 'flushed', acknowledged: result.acknowledged.length, pending: result.unacknowledged.length });
    }
    return result;
  }

  // ---- lifecycle wiring ----

  startBackgroundSync() {
    window.addEventListener('online', () => {
      this.flush().then(() => this.run()).catch(() => {});
    });
    setInterval(() => {
      if (navigator.onLine && document.visibilityState === 'visible') {
        this.run().catch(() => {});
      }
    }, 5 * 60 * 1000);
  }

  // Save directory state after provision/join
  async setDirState(dirState) {
    this.dirState = dirState;
    await localDb.setKv(KV_DIRSTATE, dirState);
  }
}

// Adapter factory: the Drive adapter wired to the active account's token
export function makeDriveAdapter() {
  return new DriveAdapter({
    getAccessToken: async () => ensureValidToken(),
    clock: () => clock.now(),
  });
}
