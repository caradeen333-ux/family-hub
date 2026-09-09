// ui.js — DOM rendering. Pure view layer: takes state, paints it.
// All mutations are declared by app.js / handlers; nothing here touches data.

import { sortedNotes } from './notes.js';
import { sortedChores } from './chores.js';
import { isPollOpen, leadingOptions, dinnerPollForToday, todayKey } from './votes.js';
import { formatTime } from './calendar.js';
import { clock } from './testing/clock.js';

const $ = (sel) => document.querySelector(sel);
const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
};

// Members map for chips, set on every render (filter re-renders reuse it)
let currentMembers = new Map();
export function setMembers(members) {
  currentMembers = members ?? new Map();
}

// ---------- Toasts ----------

export function toast(message, type = '') {
  const container = $('#toast-container');
  const node = el('div', `toast ${type}`, message);
  container.appendChild(node);
  setTimeout(() => {
    node.classList.add('leaving');
    setTimeout(() => node.remove(), 260);
  }, 2600);
}

// ---------- Sync status ----------

export function setSyncStatus(state, text) {
  const status = $('#sync-status');
  status.className = `sync-status ${state}`;
  $('#sync-text').textContent = text;
}

export function setOffline(offline) {
  let pill = document.querySelector('.offline-pill');
  if (offline && !pill) {
    pill = el('div', 'offline-pill', 'Offline — changes will sync when you reconnect');
    document.body.appendChild(pill);
    setTimeout(() => pill?.remove(), 4000);
  }
}

// ---------- Header / theme / account ----------

export function updateHeaderDate() {
  const d = new Date(clock.now());
  $('#header-date').textContent = d.toLocaleDateString(undefined, {
    weekday: 'long', month: 'short', day: 'numeric',
  });
}

export function applyTheme() {
  const dark = localStorage.getItem('fh_darkmode');
  const theme = dark === null ? 'dark' : dark === 'true' ? 'dark' : 'light';
  document.documentElement.dataset.theme = theme;
  $('#setting-darkmode') && ($('#setting-darkmode').checked = theme === 'dark');
  $('meta[name="theme-color"]').content = theme === 'dark' ? '#0d0f1a' : '#f4f5fb';
}

export function toggleTheme() {
  const dark = document.documentElement.dataset.theme !== 'light';
  localStorage.setItem('fh_darkmode', String(!dark));
  applyTheme();
  toast(dark ? 'Light mode' : 'Dark mode', 'success');
}

export function renderAccount(account) {
  if (!account) return;
  const initial = (account.name || account.email || '?')[0].toUpperCase();
  $('#account-avatar').textContent = initial;
  const chip = $('#btn-account');
  const existing = chip.querySelector('.account-name');
  if (existing) existing.remove();
  chip.appendChild(el('span', 'account-name', account.name || account.email));
  chip.title = `${account.name} · ${account.email}`;
}

// ---------- Tabs ----------

export function switchTab(tab) {
  document.querySelectorAll('.tab').forEach((t) => {
    const active = t.dataset.tab === tab;
    t.classList.toggle('active', active);
    t.setAttribute('aria-selected', String(active));
  });
  document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('active', p.id === `panel-${tab}`));
  localStorage.setItem('fh_tab', tab);
  $('#main').scrollTop = 0;
}

// ---------- Modals ----------

export function openModal(id) {
  const modal = document.getElementById(id);
  modal.classList.remove('hidden');
  const focusable = modal.querySelector('input, select, textarea, button');
  focusable?.focus();
}
export function closeModal(id) {
  document.getElementById(id).classList.add('hidden');
}
export function confirmDialog(message) {
  return new Promise((resolve) => {
    $('#confirm-message').textContent = message;
    const btn = $('#btn-confirm-delete');
    const onConfirm = () => { cleanup(); resolve(true); };
    const onCancel = () => { cleanup(); resolve(false); };
    const onOverlay = (e) => { if (e.target.id === 'modal-confirm') onCancel(); };
    const cleanup = () => {
      btn.removeEventListener('click', onConfirm);
      document.querySelectorAll('[data-close="modal-confirm"]').forEach((b) => b.removeEventListener('click', onCancel));
      document.getElementById('modal-confirm').removeEventListener('click', onOverlay);
      closeModal('modal-confirm');
    };
    btn.addEventListener('click', onConfirm);
    document.querySelectorAll('[data-close="modal-confirm"]').forEach((b) => b.addEventListener('click', onCancel));
    document.getElementById('modal-confirm').addEventListener('click', onOverlay);
    openModal('modal-confirm');
  });
}

export function wireModalClosers() {
  document.querySelectorAll('[data-close]').forEach((b) => {
    b.addEventListener('click', () => closeModal(b.dataset.close));
  });
  document.querySelectorAll('.modal-overlay').forEach((overlay) => {
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) overlay.classList.add('hidden');
    });
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      document.querySelectorAll('.modal-overlay:not(.hidden)').forEach((m) => m.classList.add('hidden'));
    }
  });
}

// ---------- Person chips / member colors ----------

const MEMBER_COLORS = ['#8b5cf6', '#0ea5e9', '#f59e0b', '#10b981', '#ef4444', '#ec4899'];

export function memberColor(memberKey) {
  let hash = 0;
  for (const ch of String(memberKey)) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  return MEMBER_COLORS[Math.abs(hash) % MEMBER_COLORS.length];
}

export function memberChip(memberKey, members) {
  const member = members.get(memberKey);
  const chip = el('span', 'note-author', member?.name ?? memberKey);
  chip.style.background = `color-mix(in srgb, ${memberColor(memberKey)} 16%, transparent)`;
  chip.style.color = memberColor(memberKey);
  return chip;
}

// ---------- Empty / skeleton ----------

export function emptyState(icon, title, sub) {
  const node = el('div', 'empty-state');
  node.appendChild(el('span', 'empty-icon', icon));
  node.appendChild(el('div', 'empty-title', title));
  if (sub) node.appendChild(el('div', 'empty-sub', sub));
  return node;
}

export function skeletons(container, count = 3) {
  const frag = document.createDocumentFragment();
  for (let i = 0; i < count; i++) frag.appendChild(el('div', 'skeleton'));
  container.replaceChildren(frag);
}

// ---------- Events (calendar) ----------

export function renderEvents(events, { containerId, range }) {
  const container = document.getElementById(containerId);
  if (!events.length) {
    container.replaceChildren(emptyState('🗓️', 'Nothing on the calendar', 'Add an event and it shows up here for everyone.'));
    return;
  }
  const end = new Date(clock.now());
  end.setHours(0, 0, 0, 0);
  end.setDate(end.getDate() + range);

  const visible = events.filter((e) => !e.date || new Date(e.date) < end);
  const groups = new Map();
  for (const e of visible) {
    const key = e.date || 'undated';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(e);
  }

  const frag = document.createDocumentFragment();
  for (const [date, dayEvents] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    frag.appendChild(dayTitle(date));
    for (const ev of dayEvents) frag.appendChild(eventCard(ev));
  }
  container.replaceChildren(frag);
}

function dayTitle(date) {
  if (date === 'undated') return el('div', 'day-group-title', 'Unscheduled');
  const d = new Date(date + 'T00:00:00');
  const today = todayKey();
  const label = date === today
    ? 'Today'
    : d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
  return el('div', 'day-group-title', label);
}

function eventCard(ev) {
  const card = el('article', 'card card-interactive event-card');
  card.style.cursor = 'pointer';
  const color = el('span', 'event-color');
  color.style.background = ev.personColor || 'var(--accent)';
  const body = el('div', 'event-body');
  body.appendChild(el('div', 'event-title', ev.title));
  const meta = el('div', 'event-meta');
  if (ev.allDay) {
    meta.appendChild(el('span', '', 'All day'));
  } else if (ev.startTime) {
    meta.appendChild(el('span', '', formatTime(ev.startTime)));
    if (ev.endTime) meta.appendChild(el('span', '', '→ ' + formatTime(ev.endTime)));
  }
  meta.appendChild(el('span', '', ev.personName));
  if (ev.location) meta.appendChild(el('span', '', '📍 ' + ev.location));
  body.appendChild(meta);
  card.append(color, body);
  if (ev.link) card.addEventListener('click', () => window.open(ev.link, '_blank'));
  return card;
}

// ---------- Notes ----------

export function renderNotes(notesMap, filter = {}) {
  const container = $('#notes-list');
  let notes = sortedNotes(notesMap);
  if (filter.category && filter.category !== 'All') notes = notes.filter((n) => n.category === filter.category);
  if (filter.importance && filter.importance !== 'All') notes = notes.filter((n) => (n.importance ?? 'normal') === filter.importance);

  if (!notes.length) {
    container.replaceChildren(emptyState('📝', filter.category !== 'All' ? 'No notes here' : 'No notes yet', filter.category !== 'All' ? 'Try another filter.' : 'Jot something down — everyone in the family sees it.'));
    return;
  }
  const frag = document.createDocumentFragment();
  for (const note of notes) frag.appendChild(noteCard(note));
  container.replaceChildren(frag);
}

export function renderNoteFilters(notesMap) {
  const categories = new Set(['All']);
  const importances = new Set(['All']);
  for (const n of notesMap.values()) {
    categories.add(n.category ?? 'General');
    importances.add(n.importance ?? 'normal');
  }
  const container = $('#filter-notes');
  const chips = [];
  for (const c of categories) chips.push({ key: 'category', value: c, label: c });
  for (const i of importances) chips.push({ key: 'importance', value: i, label: ({ high: '🔴 High', normal: '🟡 Normal', low: '🟢 Low' })[i] ?? i });
  container.replaceChildren(...chips.map(({ key, value, label }) => {
    const chip = el('button', 'chip', label);
    chip.dataset.key = key;
    chip.dataset.value = value;
    if (value === 'All') chip.classList.add('active');
    chip.addEventListener('click', () => {
      const isCategory = key === 'category';
      container.querySelectorAll(`.chip[data-key="${key}"]`).forEach((c) => c.classList.toggle('active', c === chip));
      const active = (sel) => container.querySelector(`.chip[data-key="${sel}"].active`)?.dataset.value ?? 'All';
      renderNotes(notesMap, { category: active('category'), importance: active('importance') });
    });
    return chip;
  }));
}

function noteCard(note) {
  const card = el('article', `card card-interactive note-card ${note.done ? 'done' : ''}`);
  const body = el('div', 'note-body');

  const check = el('button', 'note-check');
  check.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M4 12.5 9.5 18 20 6.5"/></svg>';
  check.setAttribute('aria-label', note.done ? 'Mark not done' : 'Mark done');
  check.addEventListener('click', (e) => {
    e.stopPropagation();
    document.dispatchEvent(new CustomEvent('fh:note-toggle', { detail: note }));
  });

  const main = el('div', '');
  const head = el('div', 'note-head');
  const dot = el('span', `note-importance ${note.importance ?? 'normal'}`);
  head.appendChild(dot);
  head.appendChild(el('span', 'note-category', note.category ?? 'General'));
  head.appendChild(memberChip(note.author ?? '?', currentMembers));
  main.appendChild(head);
  main.appendChild(el('div', 'note-text', note.text));
  body.append(check, main);
  card.appendChild(body);

  const actions = el('div', 'note-actions');
  const del = el('button', 'icon-btn', '🗑');
  del.style.width = '30px';
  del.style.height = '30px';
  del.addEventListener('click', (e) => {
    e.stopPropagation();
    document.dispatchEvent(new CustomEvent('fh:note-delete', { detail: note }));
  });
  actions.appendChild(del);
  card.appendChild(actions);
  return card;
}

// ---------- Votes ----------

export function renderVotes(view, { activeMemberKey, members }) {
  const container = $('#votes-list');
  const frag = document.createDocumentFragment();
  frag.appendChild(dinnerCard(view, { activeMemberKey }));
  frag.appendChild(newPollButton());

  const polls = [...view.polls.values()].filter(({ poll }) => poll.kind !== 'dinner' || poll.date !== todayKey());
  if (!polls.length) {
    frag.appendChild(emptyState('🗳️', 'No polls yet', 'Start one — dinner, vacations, whatever needs deciding.'));
  }
  for (const p of polls) frag.appendChild(pollCard(p, { activeMemberKey, members }));
  container.replaceChildren(frag);
}

export function renderDinnerCard(view, { activeMemberKey }) {
  $('#dinner-card-slot').replaceChildren(dinnerCard(view, { activeMemberKey }));
}

function newPollButton() {
  const btn = el('button', 'btn-secondary', '+ New poll');
  btn.style.marginBottom = '14px';
  btn.addEventListener('click', () => openModal('modal-poll'));
  return btn;
}

function dinnerCard(view, { activeMemberKey }) {
  const open = dinnerPollForToday(view);
  const card = el('div', 'card dinner-card');

  if (open) {
    card.appendChild(el('div', 'dinner-kicker', '🍽️ Tonight'));
    card.appendChild(el('div', 'dinner-title', "What's for dinner?"));
    const options = el('div', 'poll-options');
    const counts = [...open.tallies.values()];
    const max = Math.max(0, ...counts);
    for (const option of open.poll.options ?? []) {
      const count = open.tallies.get(option.id) ?? 0;
      const mine = open.votes.get(activeMemberKey) === option.id;
      const row = el('button', `poll-option ${mine ? 'my-vote' : ''}`);
      row.innerHTML = '';
      const fill = el('div', 'poll-option-fill');
      fill.style.transform = `scaleX(${max ? count / max : 0})`;
      const content = el('div', 'poll-option-content');
      content.appendChild(el('span', 'poll-option-label', option.label));
      const countEl = el('span', 'poll-option-count', count ? `${count} vote${count > 1 ? 's' : ''}` : '');
      if (mine) countEl.textContent = '✓ ' + (countEl.textContent || 'you');
      content.appendChild(countEl);
      row.append(fill, content);
      row.addEventListener('click', () => {
        document.dispatchEvent(new CustomEvent('fh:vote', { detail: { pollId: open.poll.pollId, optionId: option.id } }));
      });
      options.appendChild(row);
    }
    card.appendChild(options);

    const foot = el('div', 'poll-foot');
    const leaders = leadingOptions(open.poll, open.tallies);
    if (leaders.length > 1 && max > 0) {
      foot.appendChild(el('span', 'poll-tie', 'Tie — still deciding'));
    } else if (leaders.length === 1 && max > 0) {
      foot.appendChild(el('span', '', `Leading: ${leaders[0].label}`));
    } else {
      foot.appendChild(el('span', '', 'Cast your vote'));
    }
    const closes = new Date(open.poll.closesAt);
    if (open.poll.closesAt) {
      foot.appendChild(el('span', '', `closes ${closes.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`));
    }
    card.appendChild(foot);
    return card;
  }

  // No open dinner poll → one-tap create card
  const create = el('div', 'dinner-create');
  create.appendChild(el('span', 'empty-icon', '🍽️'));
  create.appendChild(el('div', 'dinner-title', "What's for dinner?"));
  create.appendChild(el('div', 'empty-sub', 'No poll yet — start one in one tap.'));
  const btn = el('button', 'btn-primary', 'Start dinner vote');
  btn.style.marginTop = '14px';
  btn.addEventListener('click', () => {
    document.dispatchEvent(new CustomEvent('fh:dinner-poll'));
  });
  create.appendChild(btn);
  card.appendChild(create);
  return card;
}

function pollCard({ poll, tallies, votes, closedWinner }, { activeMemberKey, members }) {
  const card = el('div', 'card poll-card');
  card.appendChild(el('div', 'poll-question', poll.title));
  const closed = closedWinner !== undefined;
  const counts = [...tallies.values()];
  const max = Math.max(0, ...counts);
  const options = el('div', 'poll-options');

  for (const option of poll.options ?? []) {
    const count = tallies.get(option.id) ?? 0;
    const mine = votes.get(activeMemberKey) === option.id;
    const winner = closed && closedWinner === option.id;
    const row = el('div', `poll-option ${mine ? 'my-vote' : ''} ${winner ? 'winner' : ''}`);
    const fill = el('div', 'poll-option-fill');
    fill.style.transform = `scaleX(${max ? count / max : 0})`;
    const content = el('div', 'poll-option-content');
    content.appendChild(el('span', 'poll-option-label', `${winner ? '🏆 ' : ''}${option.label}`));
    content.appendChild(el('span', 'poll-option-count', count ? `${count}` : ''));
    row.append(fill, content);
    if (!closed && poll.kind !== 'dinner') {
      row.style.cursor = 'pointer';
      row.addEventListener('click', () => {
        document.dispatchEvent(new CustomEvent('fh:vote', { detail: { pollId: poll.pollId, optionId: option.id } }));
      });
    }
    options.appendChild(row);
  }
  card.appendChild(options);

  const foot = el('div', 'poll-foot');
  if (closed) {
    foot.appendChild(el('span', 'poll-closed-badge', closedWinner ? `Winner: ${poll.options?.find((o) => o.id === closedWinner)?.label ?? closedWinner}` : 'Closed'));
  } else {
    const leaders = leadingOptions(poll, tallies);
    foot.appendChild(el('span', '', leaders.length > 1 && max > 0 ? 'Tied' : `${counts.reduce((a, b) => a + b, 0)} vote${counts.reduce((a, b) => a + b, 0) === 1 ? '' : 's'}`));
  }
  const author = poll.author ? memberChip(poll.author, members) : el('span', '', '');
  foot.appendChild(author);
  card.appendChild(foot);
  return card;
}

// ---------- Chores ----------

export function renderChores(choresMap, { activeMemberKey, members }) {
  const container = $('#chores-list');
  const chores = sortedChores(choresMap);
  if (!chores.length) {
    container.replaceChildren(emptyState('🧹', 'No chores', 'Add one and assign it to somebody.'));
    return;
  }
  const frag = document.createDocumentFragment();
  for (const chore of chores) {
    const row = el('div', `card card-interactive chore-row ${chore.done ? 'done' : ''}`);
    const check = el('button', 'note-check');
    check.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M4 12.5 9.5 18 20 6.5"/></svg>';
    check.addEventListener('click', () => document.dispatchEvent(new CustomEvent('fh:chore-toggle', { detail: chore })));
    const title = el('span', 'chore-title', chore.title);
    if (chore.dueDate) row.appendChild(el('span', 'chore-due', chore.dueDate));
    if (chore.assignee) row.appendChild(memberChip(chore.assignee, members));
    const del = el('button', 'icon-btn', '🗑');
    del.addEventListener('click', () => document.dispatchEvent(new CustomEvent('fh:chore-delete', { detail: chore })));
    row.append(check, title, del);
    frag.appendChild(row);
  }
  container.replaceChildren(frag);
}

// ---------- Settings ----------

export function renderSettings({ members, dirState, account }) {
  // Family
  const info = $('#family-info');
  if (dirState) {
    info.replaceChildren(el('p', 'about-text', 'Family data lives in your shared Google Drive folder — everyone signs in with their own account. Export anytime from Drive.'));
  } else {
    info.replaceChildren(el('p', 'about-text', 'No family set up yet.'));
  }
  const list = $('#member-list');
  if (members.size) {
    list.replaceChildren(...[...members.entries()].map(([key, m]) => {
      const row = el('div', 'member-row');
      row.appendChild(memberChip(key, members));
      row.appendChild(el('span', 'member-email', m.email));
      return row;
    }));
  } else {
    list.replaceChildren(el('p', 'about-text', 'No members joined yet.'));
  }

  // Account
  const area = $('#auth-area');
  if (account) {
    const row = el('div', 'member-row');
    row.appendChild(el('span', 'avatar', (account.name || '?')[0].toUpperCase()));
    row.appendChild(el('span', 'member-email', account.email));
    area.replaceChildren(row, signOutButton());
  } else {
    area.replaceChildren(el('p', 'about-text', 'Not signed in.'));
  }

  $('#app-version').textContent = 'v' + (window.APP_VERSION || 'dev');
}

function signOutButton() {
  const btn = el('button', 'btn-cancel', 'Sign out');
  btn.style.marginTop = '8px';
  btn.addEventListener('click', () => document.dispatchEvent(new CustomEvent('fh:signout')));
  return btn;
}

// ---------- Auth screens ----------

export function showAuthScreen({ error } = {}) {
  $('#app').classList.add('hidden');
  $('#screen-provision').classList.add('hidden');
  const screen = $('#screen-auth');
  screen.classList.remove('hidden');
  const err = $('#auth-error');
  if (error) {
    err.textContent = error;
    err.classList.remove('hidden');
  } else {
    err.classList.add('hidden');
  }
}

export function showProvisionScreen({ mode, invite }) {
  $('#app').classList.add('hidden');
  $('#screen-auth').classList.add('hidden');
  const screen = $('#screen-provision');
  screen.classList.remove('hidden');
  $('#provision-invite').classList.add('hidden');
  $('#form-provision').classList.remove('hidden');
  if (mode === 'join') {
    $('#provision-title').textContent = 'Join your family';
    $('#provision-body').textContent = 'You were invited to a Family Hub. Sign in with your own Google account and set your name.';
    $('#btn-provision').textContent = 'Join family';
  } else {
    $('#provision-title').textContent = 'Set up your family';
    $('#provision-body').textContent = 'First, one person creates the hub. Then everyone else joins with their own account — no shared passwords, ever.';
    $('#btn-provision').textContent = 'Create our family hub';
  }
}

export function showInviteLink(link) {
  $('#form-provision').classList.add('hidden');
  $('#provision-invite').classList.remove('hidden');
  $('#invite-link').value = link;
}

export function showApp() {
  $('#screen-auth').classList.add('hidden');
  $('#screen-provision').classList.add('hidden');
  $('#app').classList.remove('hidden');
}
