// webdav-adapter.js — NAS/Nextcloud storage backend (Phase 1 stub).
//
// Implements the same contract as DriveAdapter against a WebDAV server:
//   PROPFIND (list + etags), GET (read), PUT (write), MKCOL (folders).
// Known target: home-network Nextcloud v33 at http://192.168.1.193:8081
// (WebDAV root: remote.php/dav/files/<user>/FamilyHub/).
//
// Not implemented yet — this exists so the sync engine and provisioning
// wizard compile against a second adapter from day one.

export class WebDAVAdapter {
  constructor({ baseUrl, username, password, fetchFn = fetch }) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.username = username;
    this.password = password;
    this.fetchFn = (...args) => fetchFn(...args); // bind — strict ESM
  }

  _notImplemented(method) {
    throw new Error(`WebDAVAdapter.${method} is not implemented yet (NAS backend is post-migration)`);
  }

  authHeaders() {
    const token = btoa(`${this.username}:${this.password}`);
    return { Authorization: `Basic ${token}` };
  }

  async provision() {
    this._notImplemented('provision');
  }

  async join() {
    this._notImplemented('join');
  }

  async shareWith() {
    this._notImplemented('shareWith');
  }

  async readAllLogs() {
    this._notImplemented('readAllLogs');
  }

  async appendToMyLog() {
    this._notImplemented('appendToMyLog');
  }

  async createMonthlyFile() {
    this._notImplemented('createMonthlyFile');
  }

  async registerFiles() {
    this._notImplemented('registerFiles');
  }

  async writeConfig() {
    this._notImplemented('writeConfig');
  }

  async readConfig() {
    this._notImplemented('readConfig');
  }
}
