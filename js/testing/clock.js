// clock.js — The single source of time for the app.
//
// Every module that needs "now" calls clock.now() instead of Date.now().
// Playwright tests load the page with ?testClock=1 and drive time via
// page.evaluate — expiry and offline windows are simulated without waiting.

let fakeNow = null;
const enabled = typeof location !== 'undefined' && new URLSearchParams(location.search).has('testClock');

export const clock = {
  now() {
    if (enabled && fakeNow != null) return fakeNow;
    return Date.now();
  },
  // Test-only: set the fake time. Ignored unless ?testClock=1 is in the URL.
  _setNow(ms) {
    if (enabled) fakeNow = ms;
  },
  _advance(ms) {
    if (enabled) fakeNow = (fakeNow ?? Date.now()) + ms;
  },
  _reset() {
    fakeNow = null;
  },
};
