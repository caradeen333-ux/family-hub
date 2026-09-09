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
import * as ui from './ui.js';

const $ = (sel) => document.querySelector(sel);

// ---------- state ----------

const engine = new SyncEngine({ adapter: makeDriveAdapter() });
let range = 1;
let calendarEvents = [];
let notesFilter = { search: '', sort: 'newest', showDone: true, category: 'All', importance: 'All' };

function renderNotesPanel() {
  if (!engine.view) return;
  ui.renderNotes(engine.view.notes, notesFilter);
  ui.renderNoteFilters(engine.view.notes, notesFilter);
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
      ui.showAuthScreen({ error: redirectResult === 'error' ? 'Sign-in failed. Please try again.' : undefined });
    }
  }

  wireAppEvents();
  startProactiveRefresh();
});

async function afterSync() {
  if (!engine.dirState) {
    // Signed in but not provisioned — walk through the wizard
    const invite = parseInvite();
    if (invite) ui.showProvisionScreen({ mode: 'join', invite });
    else ui.showProvisionScreen({ mode: 'provision' });
    return;
  }
  await loadCalendar();
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
      clientId: window.__electron?.oauthClientId ?? CONFIG.WEB_CLIENT_ID,
      code,
      redirectUri: saved.redirect,
      verifier: saved.verifier,
    });
    const profile = decodeIdToken(tokens.idToken);
    updateAccount(profile.email, {
      sub: profile.sub,
      name: profile.name,
      email: profile.email,
      accessToken: tokens.accessToken,
      expiresAt: tokens.expiresAt,
      ...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}),
    });
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
    const payload = JSON.parse(atob(idToken.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    return { sub: payload.sub, email: payload.email, name: payload.name };
  } catch {
    return {};
  }
}

// ---------- provisioning ----------

async function handleProvisionSubmit(e) {
  e.preventDefault();
  const name = $('#provision-name').value.trim();
  const account = getActiveAccount();
  if (!name || !account) return;

  const btn = $('#btn-provision');
  btn.disabled = true;
  try {
    const invite = parseInvite();
    let dirState;
    if (invite) {
      const result = await joinFamily(engine.adapter, {
        invite, name, email: account.email, clock: () => clock.now(),
      });
      dirState = { folderId: result.folderId, dirFileId: result.dirFileId, memberKey: result.memberKey, name, email: account.email };
      ui.toast('Welcome to the family! 🎉', 'success');
    } else {
      const result = await provisionFirstUser(engine.adapter, {
        name, email: account.email, clock: () => clock.now(),
      });
      dirState = { folderId: result.folderId, dirFileId: result.dirFileId, memberKey: result.memberKey, name, email: account.email };
      updateAccount(account.email, { driveFolderId: result.folderId, dirFileId: result.dirFileId });
      ui.toast('Family hub created 🎉', 'success');
      ui.showInviteLink(buildInviteLink({ folderId: result.folderId, dirFileId: result.dirFileId }));
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
    ui.toast(`Setup failed: ${err.message}`, 'error');
  } finally {
    btn.disabled = false;
  }
}

// ---------- rendering ----------

function renderAll() {
  if (!engine.view) return;
  ui.setMembers(engine.view.members);
  ui.renderDinnerCard(engine.view, { activeMemberKey: engine.activeMemberKey() });
  ui.renderEvents(calendarEvents, { containerId: 'myday-events', range });
  renderNotesPanel();
  ui.renderVotes(engine.view, { activeMemberKey: engine.activeMemberKey(), members: engine.view.members });
  ui.renderChores(engine.view.chores, { activeMemberKey: engine.activeMemberKey(), members: engine.view.members });
  ui.renderSettings({ members: engine.view.members, dirState: engine.dirState, account: getActiveAccount() });
  ui.renderAccount(getActiveAccount());
}

async function loadCalendar() {
  const active = getActiveAccount();
  if (!active) return;
  const members = [...(engine.view?.members?.values() ?? [])];
  const calendars = CONFIG.defaultPeople
    .filter((p) => members.some((m) => m.name === p.name))
    .map((p) => ({ ...p, calendarId: p.calendarId }));
  if (!calendars.length) return;
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
    input.select();
    try {
      await navigator.clipboard.writeText(input.value);
      ui.toast('Invite link copied', 'success');
    } catch {
      ui.toast('Select and copy manually', 'error');
    }
  });
  $('#btn-invite').addEventListener('click', () => {
    if (!engine.dirState) return ui.toast('Set up the family first', 'error');
    const link = buildInviteLink({ folderId: engine.dirState.folderId, dirFileId: engine.dirState.dirFileId });
    navigator.clipboard?.writeText(link).catch(() => {});
    ui.toast('Invite link copied — share it!', 'success');
  });
  $('#setting-alwaysontop')?.addEventListener('change', (e) => {
    window.__electron?.setAlwaysOnTop(e.target.checked);
  });
  $('#btn-install')?.addEventListener('click', installPrompt?.prompt?.bind(installPrompt));
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
      const profile = decodeIdToken(result.tokens.id_token);
      updateAccount(profile.email, {
        sub: profile.sub,
        name: profile.name,
        email: profile.email,
        accessToken: result.tokens.access_token,
        expiresAt: clock.now() + (result.tokens.expires_in ?? 3600) * 1000,
        ...(result.tokens.refresh_token ? { refreshToken: result.tokens.refresh_token } : {}),
      });
      await bootAfterSignIn(parseInvite());
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
    t.addEventListener('click', () => ui.switchTab(t.dataset.tab));
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
  });
  document.addEventListener('fh:dinner-poll', async () => {
    await votesMod.startDinnerPoll(engine, { author: engine.activeMemberKey() });
    ui.toast("Dinner poll started 🍽️", 'success');
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
  $('#form-poll').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const options = f.options.value.split('\n').map((s) => s.trim()).filter(Boolean);
    if (options.length < 2) return ui.toast('Need at least two options', 'error');
    const btn = f.querySelector('button[type="submit"]');
    await ui.busy(btn, votesMod.createPoll(engine, { title: f.title.value.trim(), kind: 'general', options, author: engine.activeMemberKey() }), { label: 'Starting…' });
    ui.closeModal('modal-poll');
    f.reset();
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
