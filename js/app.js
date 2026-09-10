// app.js — Boot, routing, and event wiring. The ESM entry point.
//
// Boot order (rebuild plan):
//   parse #invite= → render cached merged view instantly → ensureValidToken()
//   → sync-engine.run() → silent re-auth or sign-in screen → calendar fetch.

import { CONFIG } from './config.js';
import { clock } from './testing/clock.js';
import * as oauth from './auth/oauth.js';
import {
  ensureValidToken,
  fetchWithAuth,
  isSignedIn,
  signOut,
  startProactiveRefresh,
  onAuthStateChange,
} from './auth/token.js';
import { getActiveAccount, updateAccount, clearLegacyTokens, setActiveEmail } from './auth/token-store.js';
import { SyncEngine, makeDriveAdapter } from './sync/sync-engine.js';
import * as localDb from './storage/local-db.js';
import { buildInviteLink, parseInvite, provisionFirstUser, joinFamily } from './provisioning.js';
import * as calendar from './calendar.js';
import * as notesMod from './notes.js';
import * as votesMod from './votes.js';
import * as choresMod from './chores.js';
import * as shoppingMod from './shopping.js';
import * as ui from './ui.js';

const $ = (sel) => document.querySelector(sel);

// ---------- state ----------

const engine = new SyncEngine({ adapter: makeDriveAdapter() });
let range = 1;
let scheduleView = 'my';
let calendarEvents = [];
let notesFilter = { search: '', sort: 'newest', showDone: true, category: 'All', importance: 'All' };

function renderNotesPanel() {
  if (!engine.view) return;
  ui.renderNotes(engine.view.notes, notesFilter);
  ui.renderNoteFilters(engine.view.notes, notesFilter);
}

let wishlistEnsured = false;

function renderShoppingPanel() {
  if (!engine.view) return;
  ui.renderShopping(engine.view, { activeMemberKey: engine.activeMemberKey() });
  ui.renderWishlist(engine.view);
  // One-shot: the wish list section exists for every family
  if (!wishlistEnsured && engine.view.lists.size > 0 && !shoppingMod.ensureWishlist(engine.view)) {
    wishlistEnsured = true;
    shoppingMod.createWishlist(engine).catch(() => {});
  }
}

// ---------- boot ----------

document.addEventListener('DOMContentLoaded', async () => {
  clearLegacyTokens();
  ui.applyTheme();
  ui.updateHeaderDate();
  setInterval(ui.updateHeaderDate, 60_000);
  ui.wireModalClosers();
  wireStaticControls();

  const invite = parseInvite();

  // 1. If signed in: render cached view instantly (offline-first)
  if (isSignedIn()) {
    await engine.init();
    ui.showApp();
    ui.renderAccount(getActiveAccount());
    // Always build a view from the local log — even with no cache and no
    // network, the UI must render (a failed first sync must never blank it)
    if (engine.view) renderAll();
    else {
      await engine.remerge();
      renderAll();
    }
    // 2. Ensure token, then sync
    ensureValidToken()
      .then(() => engine.run())
      .then(() => afterSync())
      .catch(handleBootAuthError);
  } else {
    // Handle an in-flight OAuth redirect first
    const redirectResult = await handleAuthRedirect();
    if (redirectResult === 'signed-in') {
      await bootAfterSignIn(invite);
    } else {
      ui.showAuthScreen({
        error: redirectResult === 'error' ? 'Sign-in failed. Please try again.' : undefined,
        invite: invite ?? undefined, // invite landing context on the auth screen
      });
    }
  }

  wireAppEvents();
  startProactiveRefresh();
  announceUpdate();
});

// Update notice: first boot of a new version → friendly toast. The FAQ
// carries the guarantee: updates never touch tokens or local data.
function announceUpdate() {
  const version = window.APP_VERSION;
  if (!version) return;
  try {
    const last = localStorage.getItem('fh_last_version');
    if (last !== version) {
      localStorage.setItem('fh_last_version', version);
      ui.toast(`Updated to v${version} 🎉 — you stay signed in`, 'success');
    }
  } catch { /* private mode */ }
}

async function afterSync() {
  if (!engine.dirState) {
    // Signed in but not provisioned — walk through the wizard
    const invite = parseInvite();
    if (invite) ui.showProvisionScreen({ mode: 'join', invite });
    else ui.showProvisionScreen({ mode: 'provision' });
    prefillProvisionName();
    return;
  }
  await autoLinkCalendars(); // hook up shared calendars automatically
  await loadCalendar();
}

// Flawless onboarding: the name field is already filled from their Google
// profile — one less typing step for a non-technical family member
function prefillProvisionName() {
  const account = getActiveAccount();
  const nameEl = $('#provision-name');
  if (account?.name && !nameEl.value) nameEl.value = account.name.split(' ')[0];
}

async function bootAfterSignIn(invite) {
  await engine.init();
  ui.showApp();
  ui.renderAccount(getActiveAccount());
  if (engine.view) renderAll();
  else {
    await engine.remerge();
    renderAll();
  }
  await engine.run();
  await afterSync();
}

function handleBootAuthError(err) {
  if (err?.needsSignIn || err?.signedOut) {
    ui.showAuthScreen();
  } else if (err?.interactionRequired) {
    ui.showAuthScreen();
  } else {
    // transient (network/5xx) — keep cached app, retry on next tick
    ui.setSyncStatus('error', 'Connection issue — will retry');
  }
}

// ---------- OAuth redirect handling ----------

async function handleAuthRedirect() {
  const params = new URLSearchParams(location.search);
  const code = params.get('code');
  if (!code) return null;

  const state = params.get('state');
  const saved = oauth.loadOauthState();
  if (!saved || saved.state !== state) {
    ui.showAuthScreen({ error: 'Sign-in was interrupted. Please try again.' });
    return 'error';
  }

  try {
    const tokens = await oauth.exchangeCode({
      clientId: CONFIG.WEB_CLIENT_ID,
      code,
      redirectUri: saved.redirect,
      verifier: saved.verifier,
    });
    const profile = await profileFromTokens(tokens);
    if (!profile.email) {
      ui.showAuthScreen({ error: 'Sign-in incomplete — Google returned no account email.' });
      return 'error';
    }
    updateAccount(profile.email, {
      sub: profile.sub,
      name: profile.name,
      email: profile.email,
      accessToken: tokens.accessToken,
      expiresAt: tokens.expiresAt,
      ...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}),
    });
    // The newly signed-in account becomes the ACTIVE account — otherwise a
    // second sign-in (add-account flow) silently provisions for the old one.
    setActiveEmail(profile.email);
    history.replaceState({}, '', location.pathname); // drop ?code= from URL
    return 'signed-in';
  } catch (err) {
    console.error('token exchange failed', err);
    return 'error';
  }
}

function decodeIdToken(idToken) {
  if (!idToken) return {};
  try {
    // JWTs are unpadded base64url — atob needs padding added back
    const b64 = idToken.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64.padEnd(Math.ceil(b64.length / 4) * 4, '=');
    const payload = JSON.parse(atob(padded));
    return { sub: payload.sub, email: payload.email, name: payload.name };
  } catch {
    return {};
  }
}

// Desktop-type clients often return NO id_token — fall back to the userinfo
// endpoint. NEVER store an account without an email (the 'undefined'-key bug).
async function profileFromTokens(tokens) {
  // Web flow uses camelCase (idToken), Electron's raw Google JSON is
  // snake_case (id_token) — accept both
  const fromId = decodeIdToken(tokens.id_token ?? tokens.idToken);
  if (fromId.email) return fromId;
  const accessToken = tokens.access_token ?? tokens.accessToken;
  const resp = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const text = await resp.text().catch(() => '');
  if (!resp.ok) throw new Error(`userinfo failed (${resp.status}): ${text.slice(0, 200)}`);
  let data = {};
  try { data = JSON.parse(text); } catch { /* non-JSON body */ }
  console.error('userinfo response:', text.slice(0, 300), '| token keys:', Object.keys(tokens).join(','));
  return { sub: data.sub, email: data.email, name: data.name };
}

// ---------- provisioning ----------

async function handleProvisionSubmit(e) {
  e.preventDefault();
  const name = $('#provision-name').value.trim();
  const account = getActiveAccount();
  if (!account) return;
  if (!name) {
    ui.toast('Enter your name too', 'error');
    $('#provision-name').focus();
    return;
  }

  const btn = $('#btn-provision');
  btn.disabled = true;
  try {
    const invite = parseInvite();
    let dirState;

    if (invite) {
      // Already a member (re-opened an old link / fresh device)? Just enter.
      // Check the family's dir.json — the local view may be empty on a new
      // device, but the directory knows who belongs.
      const dir = await engine.adapter.readDir(invite.dirFileId).catch(() => null);
      const already = dir?.data?.members
        ? Object.entries(dir.data.members).find(([, m]) => m.email === account.email)
        : null;
      if (already) {
        dirState = { folderId: invite.folderId, dirFileId: invite.dirFileId, memberKey: already[0], name, email: account.email };
        ui.toast("You're already in this family — welcome back! 🎉", 'success');
      } else {
        const result = await joinFamily(engine.adapter, {
          invite, name, email: account.email, clock: () => clock.now(),
        });
        dirState = { folderId: result.folderId, dirFileId: result.dirFileId, memberKey: result.memberKey, name, email: account.email };
        ui.toast('Welcome to the family! 🎉', 'success');
      }
    } else {
      const familyName = $('#provision-family')?.value?.trim() ?? '';
      if (!familyName) {
        ui.toast('Give your family a name first', 'error');
        btn.disabled = false;
        return;
      }
      const result = await provisionFirstUser(engine.adapter, {
        name, email: account.email, familyName, clock: () => clock.now(),
      });
      dirState = { folderId: result.folderId, dirFileId: result.dirFileId, memberKey: result.memberKey, name, email: account.email };
      updateAccount(account.email, { driveFolderId: result.folderId, dirFileId: result.dirFileId });
      ui.toast('Family hub created 🎉', 'success');
      ui.showInviteLink(buildInviteLink({ folderId: result.folderId, dirFileId: result.dirFileId }));
      // Prefill the invite email flow with the founder's own email as the example
      $('#invite-email').value = '';
      $('#invite-email').focus();
    }
    await engine.setDirState(dirState);
    await engine.run();
    if (!invite) {
      // stay on the invite screen until the user clicks through
    } else {
      ui.showApp();
      renderAll();
    }
  } catch (err) {
    if (err.friendly) {
      ui.toast(err.message, 'error');
    } else {
      console.error('provision failed', err);
      ui.toast('Setup failed — check your connection and try again', 'error');
    }
  } finally {
    btn.disabled = false;
  }
}

// ---------- rendering ----------

function renderAll() {
  if (!engine.view) return;
  ui.setMembers(engine.view.members);
  ui.renderDinnerCard(engine.view, { activeMemberKey: engine.activeMemberKey() });
  ui.renderScheduleSelector(engine.view.members, engine.activeMemberKey(), scheduleView);
  ui.renderDueToday(engine.view.chores, { members: engine.view.members, activeMemberKey: engine.activeMemberKey() });
  ui.renderEvents(calendarEvents, { containerId: 'myday-events', range });
  renderNotesPanel();
  ui.renderVotes(engine.view, { activeMemberKey: engine.activeMemberKey(), members: engine.view.members });
  ui.renderChores(engine.view.chores, { activeMemberKey: engine.activeMemberKey(), members: engine.view.members });
  renderShoppingPanel();
  ui.renderSettings({
    members: engine.view.members,
    dirState: engine.dirState,
    account: getActiveAccount(),
    familyName: engine.view.config.get('familyName') ?? null,
    memberCalendars: engine.view.config.get('calendars') ?? {},
  });
  ui.renderAccount(getActiveAccount());
}

// Auto-link: anyone who already shares their calendar with the active
// account gets hooked up automatically (matched by email) — no manual IDs.
async function autoLinkCalendars() {
  if (!engine.view?.members?.size) return;
  try {
    const list = await calendar.discoverCalendars();
    const matched = calendar.matchSharedCalendars(engine.view.members, Object.values(list));
    const current = engine.view.config.get('calendars') ?? {};
    const merged = { ...matched, ...current }; // manual config wins over auto
    if (JSON.stringify(merged) !== JSON.stringify(current)) {
      await engine.mutate('config.upsert', { key: 'calendars', value: merged });
    }
  } catch (err) {
    console.error('calendar auto-link failed', err);
  }
}

// Schedule view: 'my' | 'all' | memberKey. Calendar ids come from the
// config.upsert 'calendars' map {memberKey: calendarId}, with the active
// member defaulting to their own 'primary' calendar.
async function loadCalendar() {
  const active = getActiveAccount();
  if (!active) return;
  const members = engine.view?.members ?? new Map();
  const memberCalendars = engine.view?.config.get('calendars') ?? {};
  const activeKey = engine.activeMemberKey();

  let calendars = [];
  if (scheduleView === 'my') {
    const name = members.get(activeKey)?.name ?? active.name ?? 'Me';
    calendars = [{ calendarId: memberCalendars[activeKey] ?? 'primary', name, color: ui.memberColor(activeKey) }];
  } else if (scheduleView === 'all') {
    calendars = [...members.entries()]
      .map(([key, m]) => ({
        calendarId: memberCalendars[key] ?? (key === activeKey ? 'primary' : ''),
        name: m.name,
        color: ui.memberColor(key),
      }))
      .filter((c) => c.calendarId);
  } else {
    const m = members.get(scheduleView);
    const id = memberCalendars[scheduleView] ?? (scheduleView === activeKey ? 'primary' : '');
    if (m && id) calendars = [{ calendarId: id, name: m.name, color: ui.memberColor(scheduleView) }];
  }

  if (!calendars.length) {
    $('#myday-events').replaceChildren(ui.emptyState('📅', 'No calendars connected yet', 'Each person shares their Google Calendar with you once — see the ? help for the one-time steps.'));
    return;
  }
  ui.skeletons($('#myday-events'), 4);
  try {
    calendarEvents = await calendar.fetchCalendarEvents(calendars, { range, now: new Date(clock.now()) });
    ui.renderEvents(calendarEvents, { containerId: 'myday-events', range });
  } catch (err) {
    console.error('calendar fetch failed', err);
    $('#myday-events').replaceChildren(ui.emptyState('📅', 'Calendar unavailable', 'Check your connection — notes and votes still work.'));
  }
}

// ---------- static controls ----------

function wireStaticControls() {
  $('#btn-theme').addEventListener('click', ui.toggleTheme);
  $('#setting-darkmode')?.addEventListener('change', ui.toggleTheme);
  // Window size toggle (Electron only — hidden on web/PWA)
  const SIZES = [
    { width: 400, height: 660 }, // compact widget ("pin size")
    { width: 613, height: 804 }, // the owner-approved default ratio
  ];
  if (window.__electron?.setWindowSize) {
    $('#btn-winsize').addEventListener('click', () => {
      const compact = window.innerWidth < 500;
      const next = compact ? SIZES[1] : SIZES[0];
      window.__electron.setWindowSize(next.width, next.height);
      ui.toast(compact ? 'Expanded' : 'Compact', 'success');
    });
  } else {
    $('#btn-winsize').classList.add('hidden');
  }
  $('#btn-refresh').addEventListener('click', async () => {
    const btn = $('#btn-refresh');
    await ui.busy(btn, (async () => {
      ui.setSyncStatus('working', 'Syncing…');
      try {
        await engine.run();
        await loadCalendar();
        ui.setSyncStatus('synced', 'Up to date');
        ui.toast('Refreshed', 'success');
      } catch {
        ui.setSyncStatus('error', 'Sync failed');
        ui.toast('Sync failed — check your connection', 'error');
      }
    })());
  });
  $('#btn-settings').addEventListener('click', () => {
    renderAll();
    ui.openModal('modal-settings');
  });
  $('#btn-help').addEventListener('click', () => ui.openModal('modal-help'));
  $('#invite-faq-link')?.addEventListener('click', (e) => {
    e.preventDefault();
    ui.openModal('modal-help');
  });
  $('#btn-account').addEventListener('click', () => {
    renderAll();
    ui.openModal('modal-settings');
  });
  $('#btn-auth-signin').addEventListener('click', () => ui.busy($('#btn-auth-signin'), startSignIn(), { label: 'Opening Google…' }));
  $('#form-provision').addEventListener('submit', handleProvisionSubmit);
  ui.wireFormatToolbar();
  $('#btn-enter-hub').addEventListener('click', () => {
    ui.showApp();
    renderAll();
  });
  $('#btn-copy-invite').addEventListener('click', async () => {
    const input = $('#invite-link');
    if (!input.value) return ui.toast('Invite someone first — enter their email above', 'error');
    input.select();
    try {
      await navigator.clipboard.writeText(input.value);
      ui.toast('Invite link copied', 'success');
    } catch {
      ui.toast('Select and copy manually', 'error');
    }
  });
  // Pre-written invite email: how it works, install note, the link itself.
  // Opens the owner's own mail app (mailto) — zero servers, zero new scopes.
  let lastInviteEmail = ''; // tracks the last invited person for the Email button

  const emailInvite = (email) => {
    const link = buildInviteLink({ folderId: engine.dirState.folderId, dirFileId: engine.dirState.dirFileId });
    const subject = 'You\'re invited to our Family Hub!';
    const body = [
      'Hi!',
      '',
      "You've been invited to join our family's Family Hub — our shared calendar, notes, votes, chores and shopping lists.",
      '',
      'How it works:',
      '1. Open the link for your device below',
      '2. Sign in with YOUR OWN Google account (never a shared one)',
      '3. Pick your name — done!',
      '',
      'MOBILE (phone/tablet):',
      `  Open this link in Chrome — no download needed, it installs itself: ${link}`,
      '',
      'DESKTOP (PC):',
      `  Download and install: https://github.com/caradeen333-ux/family-hub/releases/download/v2.1.0-rebuild/Family.Hub.Setup.2.1.0.exe`,
      `  Then open the same link to join: ${link}`,
      '',
      "Everything lives in our family's own Google Drive folder — we own it, no company sees it. Google will also email you separately about folder access; that's expected.",
      '',
      "One optional step (once, ever): share your Google Calendar with the family so everyone's schedules show up — Google Calendar > Settings > Share with specific people.",
      '',
      'See you inside! 🏡',
    ].join('\n');
    window.location.href = `mailto:${encodeURIComponent(email)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  };

  // The full invite flow: grant Drive access to the invitee's email, THEN
  // hand over the link. Order matters — a link without access is a dead end.
  const inviteWithEmail = async (email, { fromProvisionScreen = false } = {}) => {
    if (!engine.dirState) return ui.toast('Set up the family first', 'error');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return ui.toast('That email doesn\'t look right', 'error');
    try {
      await ui.busy(fromProvisionScreen ? $('#btn-share-email') : $('#btn-invite'), engine.adapter.shareWith({
        folderId: engine.dirState.folderId,
        email,
      }), { label: 'Sharing…' });
    } catch (err) {
      console.error('shareWith failed', err);
      return ui.toast('Could not share the folder — check the email and try again', 'error');
    }
    const link = buildInviteLink({ folderId: engine.dirState.folderId, dirFileId: engine.dirState.dirFileId });
    lastInviteEmail = email;
    if (fromProvisionScreen) $('#invite-link').value = link;
    navigator.clipboard?.writeText(link).catch(() => {});
    ui.toast(`Folder shared with ${email} — link copied`, 'success', {
      actionLabel: 'Email invite',
      onAction: () => emailInvite(email),
    });
  };
  $('#btn-share-email').addEventListener('click', async () => {
    const input = $('#invite-email');
    const email = input.value.trim();
    if (!email) return ui.toast('Enter their Google email first', 'error');
    input.value = '';
    await inviteWithEmail(email, { fromProvisionScreen: true });
  });
  $('#invite-email').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      $('#btn-share-email').click();
    }
  });
  $('#btn-email-invite').addEventListener('click', () => {
    if (lastInviteEmail) emailInvite(lastInviteEmail);
    else ui.toast('Invite someone first — enter their email above', 'error');
  });
  document.addEventListener('fh:member-calendar', async (e) => {
    const current = engine.view?.config.get('calendars') ?? {};
    const next = { ...current };
    if (e.detail.calendarId) next[e.detail.memberKey] = e.detail.calendarId;
    else delete next[e.detail.memberKey];
    await engine.mutate('config.upsert', { key: 'calendars', value: next });
    ui.toast('Calendar saved — schedules will update', 'success');
    loadCalendar().catch(() => {});
  });
  document.addEventListener('fh:family-rename', async () => {
    const current = engine.view?.config.get('familyName') ?? '';
    const name = await ui.promptDialog('Rename your family — this is the name everyone shares.', { placeholder: 'e.g. The Murphys' });
    if (!name) return;
    await engine.mutate('config.upsert', { key: 'familyName', value: name });
    ui.toast(`Family renamed to "${name}"`, 'success');
  });
  $('#btn-invite').addEventListener('click', async () => {
    const email = await ui.promptDialog('Invite a family member — enter their Google email. We\'ll give them access to the family folder and copy you an invite link.', { placeholder: 'their.name@gmail.com', inputType: 'email' });
    if (!email) return;
    await inviteWithEmail(email);
  });
  $('#setting-alwaysontop')?.addEventListener('change', (e) => {
    window.__electron?.setAlwaysOnTop(e.target.checked);
  });
  $('#btn-install')?.addEventListener('click', installPrompt?.prompt?.bind(installPrompt));
  $('#btn-export')?.addEventListener('click', () => {
    exportData();
    ui.toast('Export downloaded', 'success');
  });
}

let installPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installPrompt = e;
  $('#btn-install')?.classList.remove('hidden');
});

// ---------- sign-in ----------

async function startSignIn() {
  // Electron: main runs the loopback server and token exchange
  if (window.__electron?.startOauth) {
    const result = await window.__electron.startOauth();
    if (result?.ok) {
      try {
        const profile = await profileFromTokens(result.tokens);
        if (!profile.email) throw new Error('no account email returned by Google');
        updateAccount(profile.email, {
          sub: profile.sub,
          name: profile.name,
          email: profile.email,
          accessToken: result.tokens.access_token,
          expiresAt: clock.now() + (result.tokens.expires_in ?? 3600) * 1000,
          ...(result.tokens.refresh_token ? { refreshToken: result.tokens.refresh_token } : {}),
        });
        setActiveEmail(profile.email); // the new account becomes active
        await bootAfterSignIn(parseInvite());
      } catch (err) {
        console.error('profile resolution failed', err);
        ui.toast('Sign-in incomplete: ' + err.message, 'error');
      }
    } else {
      ui.toast(result?.error ?? 'Sign-in failed', 'error');
    }
    return;
  }

  // Web/PWA: full-page redirect with PKCE + state
  const url = await oauth.buildAuthorizeUrl({
    clientId: CONFIG.WEB_CLIENT_ID,
    redirectUri: CONFIG.webRedirectUri,
    scopes: CONFIG.scopes,
  });
  location.href = url;
}

// ---------- app events (mutations) ----------

function wireAppEvents() {
  // Tab bar: click + arrow-key navigation (roving tabindex)
  const tabs = [...document.querySelectorAll('.tab')];
  tabs.forEach((t) => {
    t.addEventListener('click', () => {
      ui.switchTab(t.dataset.tab);
      // First visit to Shopping gets a ready-made Groceries list — once.
      // (Not in renderShoppingPanel: renders happen before the view updates,
      // which would create duplicate lists.)
      if (t.dataset.tab === 'shopping' && engine.view && engine.view.lists.size === 0) {
        shoppingMod.createList(engine, { name: 'Groceries' }).catch(() => {});
      }
    });
    t.addEventListener('keydown', (e) => {
      const idx = tabs.indexOf(t);
      let next = null;
      if (e.key === 'ArrowRight') next = tabs[(idx + 1) % tabs.length];
      if (e.key === 'ArrowLeft') next = tabs[(idx - 1 + tabs.length) % tabs.length];
      if (next) {
        e.preventDefault();
        next.focus();
        ui.switchTab(next.dataset.tab);
      }
    });
  });
  document.addEventListener('fh:schedule-change', (e) => {
    scheduleView = e.detail.key;
    ui.renderScheduleSelector(engine.view?.members ?? new Map(), engine.activeMemberKey(), scheduleView);
    loadCalendar().catch(() => {});
  });
  document.querySelectorAll('.range-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      btn.parentElement.querySelectorAll('.range-btn').forEach((b) => b.classList.toggle('active', b === btn));
      range = Number(btn.dataset.range);
      ui.renderEvents(calendarEvents, { containerId: 'myday-events', range });
    });
  });

  // Event form
  $('#btn-add-event').addEventListener('click', () => openEventForm());
  $('#form-event').addEventListener('submit', submitEventForm);
  // Delete events created from Family Hub (clientKey-marked)
  document.addEventListener('fh:event-delete', async (e) => {
    const ev = e.detail;
    if (await ui.confirmDialog(`Delete event "${ev.title}"? This removes it from Google Calendar.`)) {
      try {
        await calendar.deleteEvent(ev.calendarId, ev.id);
        ui.toast('Event deleted');
        await loadCalendar();
      } catch (err) {
        ui.toast('Could not delete event: ' + err.message, 'error');
      }
    }
  });

  // Notes
  $('#quick-note-input').addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter') return;
    const input = e.target;
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    await notesMod.addNote(engine, { text });
    ui.toast('Note added', 'success');
  });
  // Detailed add/edit modal (with formatting toolbar)
  $('#btn-add-note').addEventListener('click', () => ui.openNoteModal(null));
  document.addEventListener('fh:note-edit', (e) => ui.openNoteModal(e.detail));
  $('#form-note').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const data = {
      text: f.note.value.trim(),
      importance: f.importance.value,
      category: f.category.value,
      date: f.date.value || '',
      time: f.time.value || '',
      pinned: f.pinned.checked,
      done: f.done.checked,
    };
    if (!data.text) return;
    const btn = f.querySelector('button[type="submit"]');
    await ui.busy(btn, (async () => {
      if (f.noteId.value) {
        await notesMod.updateNote(engine, { ...data, noteId: f.noteId.value });
        ui.toast('Note updated');
      } else {
        await notesMod.addNote(engine, data);
        ui.toast('Note added', 'success');
      }
    })(), { label: 'Saving…' });
    ui.closeModal('modal-note');
  });
  document.addEventListener('fh:note-toggle', async (e) => {
    await notesMod.updateNote(engine, { ...e.detail, done: !e.detail.done });
  });
  document.addEventListener('fh:note-delete', async (e) => {
    if (await ui.confirmDialog(`Delete note "${e.detail.text.slice(0, 40)}"?`)) {
      await notesMod.deleteNote(engine, e.detail.noteId);
      ui.toast('Note deleted');
    }
  });
  // Search / sort / show-done
  $('#notes-search').addEventListener('input', (e) => {
    notesFilter.search = e.target.value.trim();
    renderNotesPanel();
  });
  $('#sort-notes').addEventListener('change', (e) => {
    notesFilter.sort = e.target.value;
    renderNotesPanel();
  });
  $('#notes-show-done').addEventListener('change', (e) => {
    notesFilter.showDone = e.target.checked;
    renderNotesPanel();
  });
  document.addEventListener('fh:notes-filter', (e) => {
    notesFilter[e.detail.key] = e.detail.value;
    renderNotesPanel();
  });

  // Votes
  document.addEventListener('fh:vote', async (e) => {
    const author = engine.activeMemberKey();
    await votesMod.castVote(engine, e.detail.pollId, e.detail.optionId, author);
    ui.toast('Vote recorded ✓', 'success');
  });
  // Vote note (quiet save — no toast, re-cast same option with the note)
  document.addEventListener('fh:vote-note', async (e) => {
    const author = engine.activeMemberKey();
    await votesMod.castVote(engine, e.detail.pollId, e.detail.optionId, author, e.detail.note);
  });
  document.addEventListener('fh:dinner-poll', async () => {
    const meal = votesMod.mealOfDay();
    await votesMod.startMealPoll(engine, { author: engine.activeMemberKey(), meal });
    ui.toast(`${votesMod.MEAL_EMOJIS[meal]} ${meal[0].toUpperCase() + meal.slice(1)} poll started`, 'success');
  });
  // Creator closes: winner = leading option (none on ties / zero votes)
  document.addEventListener('fh:poll-close', async (e) => {
    const { poll, tallies } = e.detail;
    const leaders = votesMod.leadingOptions(poll, tallies);
    const winner = leaders.length === 1 ? leaders[0].id : null;
    const label = winner ? `Close "${poll.title}" with ${leaders[0].label} winning?` : `Close "${poll.title}"?`;
    if (await ui.confirmDialog(label)) {
      await votesMod.closePoll(engine, poll.pollId, winner);
      ui.toast(winner ? 'Poll closed — winner set 🏆' : 'Poll closed');
    }
  });
  $('#btn-poll-add-option').addEventListener('click', () => {
    const container = $('#poll-options-container');
    const newRow = document.createElement('div');
    newRow.className = 'poll-option-row';
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'poll-option-input';
    input.placeholder = `Option ${container.children.length + 1}`;
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        if (input.value.trim()) document.getElementById('btn-poll-add-option').click();
      }
    });
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'icon-btn';
    remove.textContent = '✕';
    remove.style.width = '32px';
    remove.style.height = '32px';
    remove.setAttribute('aria-label', 'Remove option');
    remove.addEventListener('click', () => {
      if (container.children.length > 2) newRow.remove();
    });
    newRow.append(input, remove);
    container.appendChild(newRow);
    input.focus();
  });
  $('#form-poll').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const options = ui.collectPollOptions();
    if (options.length < 2) return ui.toast('Add at least two options', 'error');
    const title = f.title.value.trim();
    if (!title) return ui.toast('Give the poll a question', 'error');
    const btn = f.querySelector('button[type="submit"]');
    await ui.busy(btn, votesMod.createPoll(engine, { title, kind: 'general', options, author: engine.activeMemberKey() }), { label: 'Starting…' });
    ui.closeModal('modal-poll');
    ui.toast('Poll started', 'success');
  });

  // Chores
  const addChoreFromInput = async (input) => {
    const title = input.value.trim();
    if (!title) return;
    input.value = '';
    await choresMod.addChore(engine, { title, assignee: engine.activeMemberKey() });
    ui.toast('Chore added', 'success');
  };
  $('#chore-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') addChoreFromInput(e.target);
  });
  $('#btn-add-chore').addEventListener('click', () => addChoreFromInput($('#chore-input')));
  document.addEventListener('fh:chore-edit', (e) => ui.openChoreModal(e.detail));
  $('#form-chore').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const data = {
      title: f.title.value.trim(),
      assignee: f.assignee.value || '',
      dueDate: f.dueDate.value || '',
      done: f.done.checked,
    };
    if (!data.title) return;
    const btn = f.querySelector('button[type="submit"]');
    await ui.busy(btn, (async () => {
      if (f.choreId.value) {
        await choresMod.updateChore(engine, { ...data, choreId: f.choreId.value });
        ui.toast('Chore updated');
      } else {
        await choresMod.addChore(engine, data);
        ui.toast('Chore added', 'success');
      }
    })(), { label: 'Saving…' });
    ui.closeModal('modal-chore');
  });
  document.addEventListener('fh:chore-toggle', async (e) => {
    await choresMod.toggleChore(engine, e.detail);
  });
  document.addEventListener('fh:chore-delete', async (e) => {
    if (await ui.confirmDialog(`Delete chore "${e.detail.title}"?`)) {
      await choresMod.deleteChore(engine, e.detail.choreId);
      ui.toast('Chore deleted');
    }
  });

  // Shopping
  const addShopItems = async (raw) => {
    const entries = shoppingMod.splitInput(raw);
    if (!entries.length) return;
    let listId = ui.getActiveShoppingListId();
    if (!listId && engine.view.lists.size === 0) {
      await shoppingMod.createList(engine, { name: 'Groceries' });
    }
    listId = ui.getActiveShoppingListId() ?? [...engine.view.lists.values()][0]?.listId;
    if (!listId) return;
    await shoppingMod.addItems(engine, listId, entries, { author: engine.activeMemberKey() });
    ui.toast(entries.length > 1 ? `Added ${entries.length} items` : 'Added to list', 'success');
  };
  $('#shop-input').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const input = e.target;
    const raw = input.value;
    input.value = '';
    addShopItems(raw);
  });
  $('#btn-add-item').addEventListener('click', async () => {
    const input = $('#shop-input');
    const raw = input.value;
    input.value = '';
    await addShopItems(raw);
  });
  document.addEventListener('fh:shopping-render', () => renderShoppingPanel());
  document.addEventListener('fh:item-toggle', async (e) => {
    await shoppingMod.toggleItem(engine, e.detail);
  });
  document.addEventListener('fh:item-delete', async (e) => {
    await shoppingMod.deleteItem(engine, e.detail);
    ui.toast('Removed');
  });
  document.addEventListener('fh:item-edit', async (e) => {
    const item = e.detail;
    const current = `${(item.qty ?? 1) > 1 ? item.qty + 'x ' : ''}${item.text}`;
    const value = await ui.promptDialog('Edit item — a number prefix sets quantity ("2x eggs")', { placeholder: '2x eggs' });
    if (!value) return;
    const { qty, text } = shoppingMod.parseQty(value);
    if (!text) return;
    await shoppingMod.updateItem(engine, item, { text, qty });
  });
  $('#btn-clear-checked').addEventListener('click', async () => {
    const listId = ui.getActiveShoppingListId();
    if (!listId) return;
    const inList = shoppingMod.itemsInList(engine.view, listId);
    const cleared = await shoppingMod.clearChecked(engine, inList);
    if (cleared.length) {
      ui.toast(`Cleared ${cleared.length} item${cleared.length > 1 ? 's' : ''}`, 'success', {
        actionLabel: 'Undo',
        onAction: async () => {
          await shoppingMod.restoreItems(engine, cleared);
          ui.toast('Restored');
        },
      });
    }
  });
  $('#btn-new-list').addEventListener('click', () => ui.openListModal());
  // Wish list
  const addWish = async (raw) => {
    const value = raw.trim();
    if (!value) return;
    let text = value;
    let url = '';
    if (/^https?:\/\//i.test(value)) {
      url = value;
      const store = shoppingMod.detectStore(url);
      text = await ui.promptDialog('Name this wish — what is it?', { placeholder: `${store.label} — something specific` });
      if (!text) return;
    }
    await shoppingMod.addWishItem(engine, { text, url }, { author: engine.activeMemberKey() });
    ui.toast(url ? 'Added to the wish list 🎁' : 'Added to the wish list', 'success');
  };
  $('#wish-input').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const input = e.target;
    const raw = input.value;
    input.value = '';
    addWish(raw);
  });
  $('#btn-add-wish').addEventListener('click', async () => {
    const input = $('#wish-input');
    const raw = input.value;
    input.value = '';
    await addWish(raw);
  });
  document.addEventListener('fh:wish-delete', async (e) => {
    const item = e.detail;
    if (await ui.confirmDialog(`Remove "${item.text}" from the wish list?`)) {
      await shoppingMod.deleteItem(engine, item);
      ui.toast('Removed');
    }
  });
  document.addEventListener('fh:wish-edit', async (e) => {
    const item = e.detail;
    const name = await ui.promptDialog('Edit wish name', { placeholder: 'Item name' });
    if (!name) return;
    const url = await ui.promptDialog('Edit wish link (https://…) — leave blank to keep', { placeholder: item.url ?? 'https://…' });
    await shoppingMod.updateWishItem(engine, item, { text: name, url: url || item.url || '' });
    ui.toast('Wish updated');
  });
  $('#form-list').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const name = f.name.value.trim();
    if (!name) return;
    const btn = f.querySelector('button[type="submit"]');
    const created = await ui.busy(btn, shoppingMod.createList(engine, { name, emoji: f.emoji.value }), { label: 'Creating…' });
    ui.closeModal('modal-list');
    ui.setActiveShoppingListId(created.payload.listId); // jump to the new list
    renderShoppingPanel(); // the create's view-emit fired BEFORE the id was set
    ui.toast(`List "${name}" created`, 'success');
  });

  // Sign out (account-scoped)
  document.addEventListener('fh:signout', async () => {
    if (await ui.confirmDialog('Sign out of this account? Your data stays in Drive.')) {
      await signOut();
      ui.closeModal('modal-settings');
      location.reload();
    }
  });

  // Account switching (multi-account devices)
  document.addEventListener('fh:switch-account', async (e) => {
    ui.closeModal('modal-settings');
    setActiveEmail(e.detail.email);
    location.reload();
  });
  document.addEventListener('fh:add-account', async () => {
    ui.closeModal('modal-settings');
    await startSignIn(); // new account signs in; existing accounts untouched
  });

  // Pull-to-refresh (touch)
  wirePullToRefresh();

  // Sync engine → view updates
  engine.onChange(({ type }) => {
    if (type === 'view') {
      renderAll();
      updateSyncStatus();
    } else if (type === 'flushed' || type === 'synced') {
      updateSyncStatus();
    }
  });

  // Auth events
  onAuthStateChange(({ type, email }) => {
    if (type === 'invalid-grant') {
      ui.toast('Session expired for ' + (email || 'your account'), 'error');
    } else if (type === 'needs-sign-in') {
      ui.showAuthScreen();
    } else if (type === 'transient-error') {
      ui.setSyncStatus('error', 'Connection issue — retrying');
    }
  });

  window.addEventListener('online', () => {
    ui.setOffline(false);
    ui.setSyncStatus('working', 'Back online — syncing…');
  });
  window.addEventListener('offline', () => {
    ui.setOffline(true);
    ui.setSyncStatus('error', 'Offline');
  });

  // Service worker + first sync status
  setupServiceWorker();
  updateSyncStatus();
}

async function updateSyncStatus() {
  const pending = await localDb.getUnconfirmed().catch(() => []);
  if (engine.lastSyncAt) ui.setSyncStatus('synced', pending.length ? `Up to date · ${pending.length} pending` : 'Up to date');
  else ui.setSyncStatus('working', 'Syncing…');
}

// ---------- data export ----------

function exportData() {
  if (!engine.view) return;
  const view = engine.view;
  const data = {
    app: 'Family Hub',
    exportedAt: new Date(clock.now()).toISOString(),
    version: window.APP_VERSION ?? 'dev',
    members: Object.fromEntries([...view.members.entries()].map(([k, m]) => [k, { name: m.name, email: m.email }])),
    notes: [...view.notes.values()],
    chores: [...view.chores.values()],
    polls: [...view.polls.values()].map(({ poll, tallies, votes, closedWinner }) => ({
      ...poll,
      closedWinner,
      tallies: Object.fromEntries(tallies),
      votes: Object.fromEntries(votes),
    })),
    config: Object.fromEntries(view.config),
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `family-hub-export-${new Date(clock.now()).toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

// ---------- event form ----------

function openEventForm() {
  const form = $('#form-event');
  form.reset();
  const now = new Date(clock.now());
  form.date.value = now.toISOString().split('T')[0];
  const select = form.calendarId;
  const members = [...(engine.view?.members?.values() ?? [])];
  select.replaceChildren(...CONFIG.defaultPeople
    .filter((p) => p.calendarId)
    .map((p) => {
      const opt = document.createElement('option');
      opt.value = p.calendarId;
      opt.textContent = p.name;
      return opt;
    }));
  ui.openModal('modal-event');
}

async function submitEventForm(e) {
  e.preventDefault();
  const f = e.target;
  const form = new FormData(f);
  const btn = f.querySelector('button[type="submit"]');
  try {
    await ui.busy(btn, calendar.createEvent({
      calendarId: form.get('calendarId'),
      title: form.get('title'),
      date: form.get('date'),
      startTime: form.get('startTime'),
      endTime: form.get('endTime'),
      allDay: form.get('allday') === 'on',
      location: form.get('location'),
      description: form.get('description'),
      clientKey: 'ev-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
    }), { label: 'Saving…' });
    ui.closeModal('modal-event');
    ui.toast('Event created', 'success');
    await loadCalendar();
  } catch (err) {
    ui.toast('Could not create event: ' + err.message, 'error');
  }
}

// ---------- pull-to-refresh (touch) ----------

function wirePullToRefresh() {
  const main = $('#main');
  let indicator = null;
  let startY = null;
  let pulling = false;
  const THRESHOLD = 70;

  const ensureIndicator = () => {
    if (indicator) return indicator;
    indicator = document.createElement('div');
    indicator.className = 'pull-indicator';
    indicator.textContent = '↓ Pull to refresh';
    document.body.appendChild(indicator);
    return indicator;
  };

  main.addEventListener('touchstart', (e) => {
    if (main.scrollTop > 0) return;
    startY = e.touches[0].clientY;
    pulling = false;
  }, { passive: true });

  main.addEventListener('touchmove', (e) => {
    if (startY == null || main.scrollTop > 0) return;
    const dy = e.touches[0].clientY - startY;
    if (dy <= 0) return;
    pulling = dy > 12;
    const el = ensureIndicator();
    const clamped = Math.min(dy, 110);
    el.style.setProperty('--pull', clamped + 'px');
    el.classList.toggle('pulling', pulling);
    el.classList.toggle('ready', dy > THRESHOLD);
    el.textContent = dy > THRESHOLD ? '↑ Release to refresh' : '↓ Pull to refresh';
  }, { passive: true });

  main.addEventListener('touchend', async () => {
    if (!pulling || startY == null) { startY = null; return; }
    const el = indicator;
    indicator = null;
    startY = null;
    const dy = Number(el?.style.getPropertyValue('--pull').replace('px', '') ?? 0);
    el?.classList.remove('pulling', 'ready');
    el?.remove();
    if (dy > THRESHOLD) {
      ui.setSyncStatus('working', 'Refreshing…');
      try {
        await engine.run();
        await loadCalendar();
        ui.setSyncStatus('synced', 'Up to date');
      } catch {
        ui.setSyncStatus('error', 'Refresh failed');
      }
    }
  }, { passive: true });
}

// ---------- service worker ----------

function setupServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('sw.js').catch((err) => console.error('SW registration failed', err));
}

// ---------- test hook (Playwright, ?testClock=1) ----------

if (typeof location !== 'undefined' && new URLSearchParams(location.search).has('testClock')) {
  window.__fhTest = {
    engine,
    clock,
    oauth,
    auth: { ensureValidToken, fetchWithAuth, signOut },
    localDb,
    votes: votesMod,
    notes: notesMod,
    chores: choresMod,
    calendar,
  };
}
