// ui.js — DOM rendering. Pure view layer: takes state, paints it.
// All mutations are declared by app.js / handlers; nothing here touches data.

import { sortedNotes } from './notes.js';
import { sortedChores } from './chores.js';
import { isPollOpen, leadingOptions, dinnerPollForToday, todayKey } from './votes.js';
import { formatTime } from './calendar.js';
import { renderMarkdown, wrapSelection, toggleLinePrefix } from './format.js';
import { getAccounts, getActiveEmail } from './auth/token-store.js';
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

// Generic text prompt modal. Resolves with the entered string, or null.
export function promptDialog(message, { placeholder = '', inputType = 'text' } = {}) {
  return new Promise((resolve) => {
    const form = $('#form-prompt');
    const input = $('#prompt-input');
    $('#prompt-message').textContent = message;
    input.type = inputType;
    input.placeholder = placeholder;
    input.value = '';
    form.reset?.();

    const done = (value) => {
      cleanup();
      closeModal('modal-prompt');
      resolve(value);
    };
    const onSubmit = (e) => {
      e.preventDefault();
      done(input.value.trim() || null);
    };
    const onCancel = () => done(null);
    const onOverlay = (e) => {
      if (e.target.id === 'modal-prompt') onCancel();
    };
    const cleanup = () => {
      form.removeEventListener('submit', onSubmit);
      document.querySelectorAll('[data-close="modal-prompt"]').forEach((b) => b.removeEventListener('click', onCancel));
      document.getElementById('modal-prompt').removeEventListener('click', onOverlay);
    };
    form.addEventListener('submit', onSubmit);
    document.querySelectorAll('[data-close="modal-prompt"]').forEach((b) => b.addEventListener('click', onCancel));
    document.getElementById('modal-prompt').addEventListener('click', onOverlay);
    openModal('modal-prompt');
    input.focus();
  });
}

export function wireModalClosers() {
  document.querySelectorAll('[data-close]').forEach((b) => {
    b.addEventListener('click', () => closeModal(b.dataset.close));
  });
  document.querySelectorAll('.modal-overlay').forEach((overlay) => {
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) {
        // Route through the overlay's close button so cancel semantics
        // (e.g. confirmDialog's promise) always run
        const closer = overlay.querySelector('.modal-close, [data-close]');
        if (closer) closer.click();
        else overlay.classList.add('hidden');
      }
    });
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      // Same: click the close button, don't just hide — confirmDialog must
      // resolve its promise or every later dialog stacks listeners
      const open = document.querySelector('.modal-overlay:not(.hidden)');
      const closer = open?.querySelector('.modal-close, [data-close]');
      if (closer) closer.click();
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

  if (filter.search) {
    const q = filter.search.toLowerCase();
    notes = notes.filter((n) => (n.text ?? '').toLowerCase().includes(q) || (n.category ?? '').toLowerCase().includes(q));
  }
  if (filter.category && filter.category !== 'All') notes = notes.filter((n) => n.category === filter.category);
  if (filter.importance && filter.importance !== 'All') notes = notes.filter((n) => (n.importance ?? 'normal') === filter.importance);
  if (filter.showDone === false) notes = notes.filter((n) => !n.done);
  if (filter.sort) {
    notes = [...notes].sort((a, b) => {
      switch (filter.sort) {
        case 'oldest': return (a.ts ?? 0) - (b.ts ?? 0);
        case 'importance': {
          const rank = { high: 0, normal: 1, low: 2 };
          return (rank[a.importance ?? 'normal'] ?? 1) - (rank[b.importance ?? 'normal'] ?? 1);
        }
        case 'category': return (a.category ?? '').localeCompare(b.category ?? '');
        default: return (b.ts ?? 0) - (a.ts ?? 0); // newest
      }
    });
  } else {
    // Default order: pinned first, then done sinks
    notes = [...notes].sort((a, b) => {
      if (Boolean(a.pinned) !== Boolean(b.pinned)) return a.pinned ? -1 : 1;
      return 0;
    });
  }

  const filtering = Boolean(filter.search || (filter.category && filter.category !== 'All') || (filter.importance && filter.importance !== 'All'));
  if (!notes.length) {
    container.replaceChildren(emptyState('📝', filtering ? 'No notes match' : 'No notes yet', filtering ? 'Try a different search or filter.' : 'Jot something down — everyone in the family sees it.'));
    return;
  }
  const frag = document.createDocumentFragment();
  for (const note of notes) frag.appendChild(noteCard(note));
  container.replaceChildren(frag);
}

export function renderNoteFilters(notesMap, { category = 'All', importance = 'All' } = {}) {
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
    const isActive = (key === 'category' ? category : importance) === value;
    if (isActive) chip.classList.add('active');
    chip.addEventListener('click', () => {
      document.dispatchEvent(new CustomEvent('fh:notes-filter', { detail: { key, value } }));
    });
    return chip;
  }));
}

function noteCard(note) {
  const card = el('article', `card card-interactive note-card ${note.done ? 'done' : ''}`);
  if (note.pinned) card.classList.add('pinned');
  const body = el('div', 'note-body');

  const check = el('button', 'note-check');
  check.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M4 12.5 9.5 18 20 6.5"/></svg>';
  check.setAttribute('aria-label', note.done ? 'Mark not done' : 'Mark done');
  check.addEventListener('click', (e) => {
    e.stopPropagation();
    document.dispatchEvent(new CustomEvent('fh:note-toggle', { detail: note }));
  });

  const main = el('div', 'note-main');
  const head = el('div', 'note-head');
  const dot = el('span', `note-importance ${note.importance ?? 'normal'}`);
  head.appendChild(dot);
  if (note.pinned) head.appendChild(el('span', 'note-pin', '📌'));
  head.appendChild(el('span', 'note-category', note.category ?? 'General'));
  if (note.date) head.appendChild(noteDateBadge(note));
  head.appendChild(memberChip(note.author ?? '?', currentMembers));
  main.appendChild(head);

  // Formatted markdown-lite text
  const textEl = el('div', 'note-text');
  textEl.innerHTML = renderMarkdown(note.text);
  main.appendChild(textEl);
  body.append(check, main);
  card.appendChild(body);

  // Tap the card body (not the check/actions) → edit
  body.addEventListener('click', (e) => {
    if (e.target.closest('button, a')) return;
    document.dispatchEvent(new CustomEvent('fh:note-edit', { detail: note }));
  });

  const actions = el('div', 'note-actions');
  const del = el('button', 'icon-btn', '🗑');
  del.setAttribute('aria-label', 'Delete note');
  del.addEventListener('click', (e) => {
    e.stopPropagation();
    document.dispatchEvent(new CustomEvent('fh:note-delete', { detail: note }));
  });
  actions.appendChild(del);
  card.appendChild(actions);
  return card;
}

function noteDateBadge(note) {
  const badge = el('span', 'note-date', '');
  const today = todayKey();
  const d = new Date(note.date + 'T00:00:00');
  const label = note.date === today
    ? 'Today'
    : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  badge.textContent = note.time ? `🕐 ${label} ${note.time}` : `📅 ${label}`;
  if (note.date < today && !note.done) badge.classList.add('overdue');
  return badge;
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

  // Creator-only close (UI rule; merge accepts any close for robustness)
  if (!closed && poll.author === activeMemberKey) {
    const closeBtn = el('button', 'btn-secondary btn-xs', 'Close poll');
    closeBtn.addEventListener('click', () => {
      document.dispatchEvent(new CustomEvent('fh:poll-close', { detail: { poll, tallies } }));
    });
    foot.appendChild(closeBtn);
  }
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
    check.setAttribute('aria-label', chore.done ? 'Mark not done' : 'Mark done');
    check.addEventListener('click', () => document.dispatchEvent(new CustomEvent('fh:chore-toggle', { detail: chore })));
    const title = el('span', 'chore-title', chore.title);
    const due = choreDueBadge(chore);
    row.append(check, title);
    if (due) row.appendChild(due);
    if (chore.assignee) row.appendChild(memberChip(chore.assignee, members));
    const del = el('button', 'icon-btn', '🗑');
    del.setAttribute('aria-label', 'Delete chore');
    del.addEventListener('click', () => document.dispatchEvent(new CustomEvent('fh:chore-delete', { detail: chore })));
    row.appendChild(del);
    // Tap the row → edit
    row.addEventListener('click', (e) => {
      if (e.target.closest('button')) return;
      document.dispatchEvent(new CustomEvent('fh:chore-edit', { detail: chore }));
    });
    frag.appendChild(row);
  }
  container.replaceChildren(frag);
}

function choreDueBadge(chore) {
  if (!chore.dueDate) return null;
  const today = todayKey();
  const badge = el('span', 'chore-due', chore.dueDate);
  if (chore.dueDate === today && !chore.done) badge.textContent = 'Due today';
  else if (chore.dueDate < today && !chore.done) badge.textContent = `Overdue · ${chore.dueDate}`;
  else if (!chore.done) badge.textContent = `Due ${chore.dueDate}`;
  if (!chore.done && chore.dueDate <= today) badge.classList.add('overdue');
  return badge;
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

  // Account: switcher for every signed-in account on this device
  const area = $('#auth-area');
  const accounts = getAccounts();
  const activeEmail = getActiveEmail();
  const rows = [];
  for (const [email, acc] of Object.entries(accounts)) {
    const row = el('div', `member-row ${email === activeEmail ? 'active-account' : ''}`);
    row.appendChild(el('span', 'avatar', (acc.name || email || '?')[0].toUpperCase()));
    const info = el('span', 'member-email', email === activeEmail ? `${acc.name ?? email} · active` : `${acc.name ?? email} — ${email}`);
    row.appendChild(info);
    if (email !== activeEmail) {
      const switchBtn = el('button', 'btn-secondary btn-xs', 'Switch');
      switchBtn.addEventListener('click', () => {
        document.dispatchEvent(new CustomEvent('fh:switch-account', { detail: { email } }));
      });
      row.appendChild(switchBtn);
    }
    rows.push(row);
  }
  if (!rows.length) {
    area.replaceChildren(el('p', 'about-text', 'Not signed in.'));
  } else {
    const addBtn = el('button', 'btn-secondary btn-sm', '+ Sign in as another account');
    addBtn.style.marginTop = '10px';
    addBtn.addEventListener('click', () => {
      document.dispatchEvent(new CustomEvent('fh:add-account'));
    });
    area.replaceChildren(...rows, addBtn, signOutButton());
  }

  $('#app-version').textContent = 'v' + (window.APP_VERSION || 'dev');
}

function signOutButton() {
  const btn = el('button', 'btn-cancel', 'Sign out');
  btn.style.marginTop = '8px';
  btn.addEventListener('click', () => document.dispatchEvent(new CustomEvent('fh:signout')));
  return btn;
}

// ---------- Note / chore modals ----------

// Open the note modal for add (note=null) or edit. Returns the form element.
export function openNoteModal(note = null) {
  const form = $('#form-note');
  form.reset();
  $('#modal-note-title').textContent = note ? 'Edit Note' : 'New Note';
  form.noteId.value = note?.noteId ?? '';
  form.note.value = note?.text ?? '';
  form.importance.value = note?.importance ?? 'normal';
  form.category.value = note?.category ?? 'General';
  form.date.value = note?.date ?? '';
  form.time.value = note?.time ?? '';
  form.pinned.checked = Boolean(note?.pinned);
  form.done.checked = Boolean(note?.done);
  openModal('modal-note');
  form.note.focus();
  return form;
}

export function openChoreModal(chore = null) {
  const form = $('#form-chore');
  form.reset();
  $('#modal-chore-title').textContent = chore ? 'Edit Chore' : 'New Chore';
  form.choreId.value = chore?.choreId ?? '';
  form.title.value = chore?.title ?? '';
  form.dueDate.value = chore?.dueDate ?? '';
  const select = form.assignee;
  select.replaceChildren(Object.assign(el('option', '', '— anyone —'), { value: '' }));
  for (const [key, member] of currentMembers) {
    const opt = el('option', '', member.name ?? key);
    opt.value = key;
    select.appendChild(opt);
  }
  select.value = chore?.assignee ?? '';
  form.done.checked = Boolean(chore?.done);
  openModal('modal-chore');
  form.title.focus();
  return form;
}

// Wire the formatting toolbar buttons to the note textarea
export function wireFormatToolbar() {
  document.querySelectorAll('#form-note .fmt-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const ta = $('#note-textarea');
      switch (btn.dataset.fmt) {
        case 'bold': wrapSelection(ta, '**'); break;
        case 'italic': wrapSelection(ta, '*'); break;
        case 'list': toggleLinePrefix(ta, '- '); break;
        case 'numlist': toggleLinePrefix(ta, '1. '); break;
        case 'link': {
          const url = prompt('Paste a link (https://…)');
          if (url && /^https?:\/\//i.test(url)) {
            wrapSelection(ta, '[', `](${url})`);
          } else if (url) {
            toast('Link must start with https://', 'error');
          }
          break;
        }
      }
      ta.dispatchEvent(new Event('input'));
    });
  });
}

// ---------- Busy states ----------

// Disable a button while a promise runs; shows a spinner via the .busy class
export async function busy(btn, promise, { label } = {}) {
  const original = btn.textContent;
  btn.disabled = true;
  btn.classList.add('busy');
  if (label) btn.textContent = label;
  try {
    return await promise;
  } finally {
    btn.disabled = false;
    btn.classList.remove('busy');
    if (label) btn.textContent = original;
  }
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
