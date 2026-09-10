// token-store.js — Per-person, per-device account tokens.
//
//   fh_accounts = {
//     "mike@x.com": { sub, name, email, refreshToken, accessToken, expiresAt,
//                     driveFolderId, dirFileId, lastInvalidGrantAt }
//   }
//   fh_activeAccount = "mike@x.com"
//
// Merge, don't replace: refresh responses often omit refresh_token, and
// clobbering a stored token with undefined is how sessions die early.

const ACCOUNTS_KEY = 'fh_accounts';
const ACTIVE_KEY = 'fh_activeAccount';

export function getAccounts() {
  try {
    return JSON.parse(localStorage.getItem(ACCOUNTS_KEY) ?? '{}');
  } catch {
    return {};
  }
}

export function saveAccounts(accounts) {
  try {
    localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(accounts));
  } catch {
    /* private mode — session-only */
  }
}

export function getActiveEmail() {
  try {
    return localStorage.getItem(ACTIVE_KEY) ?? null;
  } catch {
    return null;
  }
}

export function setActiveEmail(email) {
  try {
    if (email) localStorage.setItem(ACTIVE_KEY, email);
    else localStorage.removeItem(ACTIVE_KEY);
  } catch {
    /* ignore */
  }
}

export function getAccount(email) {
  return getAccounts()[email] ?? null;
}

export function getActiveAccount() {
  const email = getActiveEmail();
  return email ? getAccount(email) : null;
}

// Upsert one account. `undefined` fields are dropped (merge, don't replace —
// refresh responses often omit refresh_token). `null` explicitly clears a
// field (invalid_grant teardown).
export function updateAccount(email, patch) {
  const accounts = getAccounts();
  const current = accounts[email] ?? { email };
  const next = { ...current };
  for (const [k, v] of Object.entries(patch)) {
    if (v !== undefined) next[k] = v;
  }
  accounts[email] = next;
  saveAccounts(accounts);
  return next;
}

// Account-scoped sign out: removes THIS account only. Other family accounts
// stay untouched. Never call a global clear for a session problem.
export function removeAccount(email) {
  const accounts = getAccounts();
  delete accounts[email];
  saveAccounts(accounts);
  if (getActiveEmail() === email) {
    const remaining = Object.keys(accounts);
    setActiveEmail(remaining.length ? remaining[0] : null);
  }
}

export function hasValidAccessToken(account, now) {
  return Boolean(account?.accessToken && account.expiresAt && account.expiresAt > now + 60 * 1000);
}

// Legacy single-slot keys from the old app — deleted by design
export function clearLegacyTokens() {
  try {
    localStorage.removeItem('fh_token');
    localStorage.removeItem('fh_token_expiry');
    localStorage.removeItem('fh_refresh_token');
  } catch {
    /* ignore */
  }
}
