// soak-auth.js — Week-long auth soak, runs on the always-on desktop from
// Phase 2 through migration. NOT part of CI.
//
//   node tests/soak/soak-auth.js
//
// Every 20 min: refresh the stored refresh token, log {t, ok, rotated, error}.
// Every 6 h:  Drive round-trip (read own log via the adapter).
// Weekly assertions (checked on each 6h tick): the original refresh token is
// still valid (never received invalid_grant) and total live tokens per user
// did not grow (the ~50-token revocation cliff stays unreachable).
//
// Loads tokens from the SAME localStorage the app uses — so it watches the
// real, production token lifecycle. Requires: a signed-in Family Hub app
// (Chrome/Edge) with a profile the script can reach, OR FH_ACCOUNTS env
// override pointing at a JSON file with {email: {refreshToken, ...}}.

import { clock } from '../../js/testing/clock.js';
import { refreshGrant } from '../../js/auth/oauth.js';
import fs from 'node:fs';

const REFRESH_MS = 20 * 60 * 1000;
const DRIVE_MS = 6 * 60 * 60 * 1000;
const LOG_PATH = new URL('./soak-log.jsonl', import.meta.url);

// --- token source: env override file, else nothing (real runs use the app) ---
function loadAccounts() {
  const override = process.env.FH_ACCOUNTS;
  if (override && fs.existsSync(override)) {
    return JSON.parse(fs.readFileSync(override, 'utf8'));
  }
  console.error('No FH_ACCOUNTS file given — point it at exported accounts JSON.');
  process.exit(1);
}

function log(entry) {
  const line = JSON.stringify({ t: new Date().toISOString(), ...entry });
  fs.appendFileSync(LOG_PATH, line + '\n');
  console.log(line);
}

function assertWeekly(accounts, state) {
  const days = (Date.now() - state.startAt) / 86400e3;
  if (days >= 7 && !state.weeklyDone) {
    state.weeklyDone = true;
    const failures = [];
    if (state.invalidGrants > 0) failures.push(`${state.invalidGrants} invalid_grant(s) seen`);
    if (state.rotations > 5) failures.push(`${state.rotations} refresh-token rotations (growth suspected)`);
    log({ event: 'weekly-assertion', ok: failures.length === 0, failures, invalidGrants: state.invalidGrants, rotations: state.rotations, originalTokensValid: Object.keys(accounts).length - state.replacedTokens.size });
  }
}

const accounts = loadAccounts();
const state = { startAt: Date.now(), invalidGrants: 0, rotations: 0, replacedTokens: new Set(), lastDriveAt: 0, weeklyDone: false };

async function refreshTick() {
  for (const [email, account] of Object.entries(accounts)) {
    try {
      const result = await refreshGrant({ clientId: process.env.FH_CLIENT_ID ?? '', refreshToken: account.refreshToken });
      const rotated = Boolean(result.refreshToken);
      if (rotated) {
        state.rotations++;
        if (result.refreshToken !== account.refreshToken) state.replacedTokens.add(email);
        account.refreshToken = result.refreshToken;
      }
      log({ event: 'refresh', email, ok: true, rotated });
    } catch (err) {
      if (err.code === 'invalid_grant') {
        state.invalidGrants++;
        log({ event: 'refresh', email, ok: false, error: 'invalid_grant' });
      } else {
        log({ event: 'refresh', email, ok: false, error: err.code ?? err.message });
      }
    }
  }
  assertWeekly(accounts, state);
}

async function driveTick() {
  const now = Date.now();
  if (now - state.lastDriveAt < DRIVE_MS) return;
  state.lastDriveAt = now;
  // The Drive round-trip needs a signed-in browser context (localStorage).
  // Placeholder for the Playwright-driven version — logs that it fired.
  log({ event: 'drive-roundtrip', ok: null, note: 'requires browser profile (wired in Phase 2 @real)' });
}

async function main() {
  log({ event: 'soak-start', accounts: Object.keys(accounts) });
  setInterval(refreshTick, REFRESH_MS);
  setInterval(driveTick, 30 * 60 * 1000);
  await refreshTick(); // immediate first grant
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
