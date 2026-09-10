// config.js — Constants only: OAuth clients, scopes, defaults.
// Runtime-configurable state lives in the event log (config.upsert events).

// Playwright serves the site at http://localhost:4173 — that origin IS in the
// console redirect list, so tests run the real redirect flow against the
// local origin instead of bouncing to production.
const isLocal = typeof location !== 'undefined' &&
  (location.hostname === 'localhost' || location.hostname === '127.0.0.1');

export const CONFIG = {
  // === OAuth ===
  // Public clients only — no secret anywhere in this codebase.
  WEB_CLIENT_ID: '251957454378-421ngcghpsauj9c7h3pie3715fgj7hme.apps.googleusercontent.com',
  DESKTOP_CLIENT_ID: '251957454378-3riapnrcu961tvtfcrdifstv791l70h1.apps.googleusercontent.com',

  // The three data scopes + openid/email/profile (email+profile are
  // non-sensitive and required for Google to return the account email)
  scopes: ['openid', 'email', 'profile', 'https://www.googleapis.com/auth/calendar.readonly', 'https://www.googleapis.com/auth/calendar.events', 'https://www.googleapis.com/auth/drive.file'],

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
