// config.js — Constants only: OAuth clients, scopes, defaults.
// Runtime-configurable state lives in the event log (config.upsert events).

// Playwright serves the site at http://localhost:4173 — that origin IS in the
// console redirect list, so tests run the real redirect flow against the
// local origin instead of bouncing to production.
const isLocal = typeof location !== 'undefined' &&
  (location.hostname === 'localhost' || location.hostname === '127.0.0.1');

export const CONFIG = {
  // === OAuth ===
  // ⚠️ OWNER TODO: replace both with the new clients from the console step
  // (delete the old client — its secret leaked). Until then, the old public
  // ID keeps refresh working for already-signed-in devices.
  WEB_CLIENT_ID: '251957454378-5sp17im5fa0d8vu5c13h4dsg32gdk6b3.apps.googleusercontent.com',
  DESKTOP_CLIENT_ID: '251957454378-5sp17im5fa0d8vu5c13h4dsg32gdk6b3.apps.googleusercontent.com',

  // Exactly these three scopes (rebuild plan, Phase 0)
  scopes: ['openid', 'https://www.googleapis.com/auth/calendar.readonly', 'https://www.googleapis.com/auth/calendar.events', 'https://www.googleapis.com/auth/drive.file'],

  // Redirects must match the console EXACTLY
  webRedirectUri: isLocal
    ? `${location.origin}/`
    : 'https://caradeen333-ux.github.io/family-hub/',
  silentRedirectUri: isLocal
    ? `${location.origin}/silent.html`
    : 'https://caradeen333-ux.github.io/family-hub/silent.html',

  // Injectable so tests can page.route a mock
  tokenEndpoint: 'https://oauth2.googleapis.com/token',

  // === App ===
  refreshInterval: 5 * 60 * 1000,
  defaultTab: 'myday',

  // Default people until member.joined events arrive (colors are brand tokens)
  defaultPeople: [
    { name: 'Mike',    calendarId: 'primary', color: '#8b5cf6' },
    { name: 'Charlie', calendarId: '',        color: '#0ea5e9' },
    { name: 'Avery',   calendarId: '',        color: '#f59e0b' },
  ],
};

// Expose for the Playwright harness (?testClock=1 and route mocks)
if (typeof window !== 'undefined') {
  window.CONFIG = CONFIG;
}
