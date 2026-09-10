// ui.js — DOM rendering. Pure view layer: takes state, paints it.
// All mutations are declared by app.js / handlers; nothing here touches data.

import { sortedNotes } from './notes.js';
import { sortedChores } from './chores.js';
import { isPollOpen, leadingOptions, mealPollForNow, mealOfDay, MEAL_LABELS, MEAL_EMOJIS, todayKey } from './votes.js';
import { formatTime } from './calendar.js';
import { renderMarkdown, wrapSelection, toggleLinePrefix } from './format.js';
import { getAccounts, getActiveEmail } from './auth/token-store.js';
import { sortedLists, itemsInList, groupByAisle, LIST_EMOJIS, DEFAULT_LIST_EMOJI, aisleInfo, wishItems, detectStore, WISHLIST_ID } from './shopping.js';
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

export function toast(message, type = '', { actionLabel, onAction } = {}) {
  const container = $('#toast-container');
  const node = el('div', `toast ${type}`, message);
  let timer;
  const dismiss = () => {
    clearTimeout(timer);
    node.classList.add('leaving');
    setTimeout(() => node.remove(), 260);
  };
  if (actionLabel && onAction) {
    const btn = el('button', 'toast-action', actionLabel);
    btn.addEventListener('click', () => {
      onAction();
      dismiss();
    });
    node.appendChild(btn);
  }
  container.appendChild(node);
  timer = setTimeout(dismiss, actionLabel ? 5000 : 2600);
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

  // Date-only strings parse as UTC midnight — that's the PREVIOUS day in
  // western timezones (off-by-one: events hidden or shown a day early).
  // 'T00:00:00' pins them to local midnight.
  const visible = events.filter((e) => !e.date || new Date(e.date + 'T00:00:00') < end);
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

  // Events created from Family Hub are deletable right here
  if (ev.clientKey) {
    const del = el('button', 'icon-btn', '🗑');
    del.style.width = '36px';
    del.style.height = '36px';
    del.setAttribute('aria-label', 'Delete event');
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      document.dispatchEvent(new CustomEvent('fh:event-delete', { detail: ev }));
    });
    card.appendChild(del);
  }
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
  const edit = el('button', 'icon-btn', '✏️');
  edit.setAttribute('aria-label', 'Edit note');
  edit.addEventListener('click', (e) => {
    e.stopPropagation();
    document.dispatchEvent(new CustomEvent('fh:note-edit', { detail: note }));
  });
  const del = el('button', 'icon-btn', '🗑');
  del.setAttribute('aria-label', 'Delete note');
  del.addEventListener('click', (e) => {
    e.stopPropagation();
    document.dispatchEvent(new CustomEvent('fh:note-delete', { detail: note }));
  });
  actions.append(edit, del);
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

// "Due today" chores section on My Day — the day's obligations next to the
// day's events, one tap to check off
export function renderDueToday(choresMap, { members, activeMemberKey }) {
  const slot = $('#due-today-slot');
  const today = todayKey();
  const due = [...choresMap.values()].filter((c) => c.dueDate === today && !c.done);
  if (!due.length) {
    slot.replaceChildren();
    return;
  }
  const card = el('div', 'card due-today');
  card.appendChild(el('div', 'day-group-title', 'Due today'));
  for (const chore of due) {
    const row = el('div', 'chore-row');
    const check = el('button', 'note-check');
    check.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M4 12.5 9.5 18 20 6.5"/></svg>';
    check.setAttribute('aria-label', 'Mark done');
    check.addEventListener('click', () => document.dispatchEvent(new CustomEvent('fh:chore-toggle', { detail: chore })));
    row.appendChild(check);
    row.appendChild(el('span', 'chore-title', chore.title));
    if (chore.assignee) row.appendChild(memberChip(chore.assignee, members));
    card.appendChild(row);
  }
  slot.replaceChildren(card);
}

// Yesterday's (or any past) dinner decision — small win, big family feel
function lastDinnerWinner(view) {
  const today = todayKey();
  let latest = null;
  for (const { poll, closedWinner } of view?.polls?.values() ?? []) {
    if (poll.kind !== 'dinner' || closedWinner == null) continue;
    if (poll.date && poll.date >= today) continue;
    if (!latest || (poll.date ?? '') > (latest.poll.date ?? '')) latest = { poll, closedWinner };
  }
  return latest
    ? { label: latest.poll.options?.find((o) => o.id === latest.closedWinner)?.label ?? null, date: latest.poll.date }
    : null;
}

function newPollButton() {
  const btn = el('button', 'btn-secondary', '+ New poll');
  btn.style.marginBottom = '14px';
  btn.addEventListener('click', () => openModal('modal-poll'));
  return btn;
}

function dinnerCard(view, { activeMemberKey }) {
  const open = mealPollForNow(view);
  const meal = mealOfDay();
  const card = el('div', 'card dinner-card');

  if (open) {
    card.appendChild(el('div', 'dinner-kicker', `${MEAL_EMOJIS[meal] ?? '🍽️'} ${meal[0].toUpperCase() + meal.slice(1)}`));
    card.appendChild(el('div', 'dinner-title', open.poll.title ?? MEAL_LABELS[meal]));
    const options = el('div', 'poll-options');
    const counts = [...open.tallies.values()];
    const max = Math.max(0, ...counts);
    for (const option of open.poll.options ?? []) {
      const count = open.tallies.get(option.id) ?? 0;
      const myVote = open.votes.get(activeMemberKey);
      const mine = myVote?.optionId === option.id;
      const wrap = el('div', 'poll-option-wrap');
      const row = el('button', `poll-option ${mine ? 'my-vote' : ''}`);
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
      wrap.appendChild(row);
      // Vote notes: "Cook at home — WHAT?" / "Takeout — from WHERE?"
      if (mine) wrap.appendChild(voteNoteInput(open.poll.pollId, option.id, myVote.note));
      // Show other voters' notes inline
      const voterNotes = [...open.votes.entries()].filter(([author, v]) => v.optionId === option.id && v.note);
      for (const [, v] of voterNotes) {
        const line = el('div', 'voter-note', `💬 ${v.note}`);
        wrap.appendChild(line);
      }
      options.appendChild(wrap);
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

  // No open meal poll for this time of day → one-tap create card
  const create = el('div', 'dinner-create');
  create.appendChild(el('span', 'empty-icon', MEAL_EMOJIS[meal] ?? '🍽️'));
  create.appendChild(el('div', 'dinner-title', MEAL_LABELS[meal] ?? "What's for dinner?"));
  const last = lastDinnerWinner(view);
  create.appendChild(el('div', 'empty-sub', last && last.label
    ? `Last decision: ${last.label}`
    : 'No poll yet — start one in one tap.'));
  const btn = el('button', 'btn-primary', `Start ${meal} vote`);
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
    const myVote = votes.get(activeMemberKey);
    const mine = myVote?.optionId === option.id;
    const winner = closed && closedWinner === option.id;
    const wrap = el('div', 'poll-option-wrap');
    const row = el('div', `poll-option ${mine ? 'my-vote' : ''} ${winner ? 'winner' : ''}`);
    const fill = el('div', 'poll-option-fill');
    fill.style.transform = `scaleX(${max ? count / max : 0})`;
    const content = el('div', 'poll-option-content');
    content.appendChild(el('span', 'poll-option-label', `${winner ? '🏆 ' : ''}${option.label}`));
    content.appendChild(el('span', 'poll-option-count', count ? `${count}` : ''));
    row.append(fill, content);
    // Voter chips: who picked this option
    const voters = [...votes.entries()].filter(([, v]) => v.optionId === option.id);
    if (voters.length) {
      const chipRow = el('div', 'poll-voters');
      for (const [memberKey] of voters) {
        const chip = el('span', 'voter-chip', (members.get(memberKey)?.name ?? memberKey)[0]?.toUpperCase() ?? '?');
        chip.style.background = `color-mix(in srgb, ${memberColor(memberKey)} 20%, transparent)`;
        chip.style.color = memberColor(memberKey);
        chip.title = members.get(memberKey)?.name ?? memberKey;
        chipRow.appendChild(chip);
      }
      row.appendChild(chipRow);
    }
    wrap.appendChild(row);
    // Vote notes on the selected option
    if (mine) wrap.appendChild(voteNoteInput(poll.pollId, option.id, myVote.note));
    for (const [, v] of voters) {
      if (v.note) wrap.appendChild(el('div', 'voter-note', `💬 ${v.note}`));
    }
    if (!closed && poll.kind !== 'dinner') {
      row.style.cursor = 'pointer';
      row.addEventListener('click', () => {
        document.dispatchEvent(new CustomEvent('fh:vote', { detail: { pollId: poll.pollId, optionId: option.id } }));
      });
    }
    options.appendChild(wrap);
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
    const edit = el('button', 'icon-btn', '✏️');
    edit.setAttribute('aria-label', 'Edit chore');
    edit.addEventListener('click', () => document.dispatchEvent(new CustomEvent('fh:chore-edit', { detail: chore })));
    const del = el('button', 'icon-btn', '🗑');
    del.setAttribute('aria-label', 'Delete chore');
    del.addEventListener('click', () => document.dispatchEvent(new CustomEvent('fh:chore-delete', { detail: chore })));
    row.append(edit, del);
    // Tap the row → edit (kept for mobile muscle memory)
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

// ---------- Shopping ----------

let activeListId = null; // module-level: survives re-renders

// The app layer needs to know which list receives new items
export function getActiveShoppingListId() {
  return activeListId;
}

export function setActiveShoppingListId(id) {
  activeListId = id;
}

export function renderShopping(view, { activeMemberKey }) {
  const switcher = $('#list-switcher');
  const listEl = $('#shopping-list');

  // The wish list lives in its own pinned section, not the chip switcher
  const lists = sortedLists(view).filter((l) => l.listId !== WISHLIST_ID);
  if (!lists.length) {
    switcher.replaceChildren();
    $('#shopping-progress').classList.add('hidden');
    listEl.replaceChildren(emptyState('🛒', 'No lists yet', 'Start with Groceries — then add Costco, pharmacy runs, whatever you shop for.'));
    $('#btn-clear-checked').classList.add('hidden');
    return;
  }

  // Ensure the active list still exists (deleted while active, fresh boot)
  if (!lists.some((l) => l.listId === activeListId)) {
    activeListId = lists[0].listId;
  }
  const active = lists.find((l) => l.listId === activeListId);

  // List switcher chips
  switcher.replaceChildren(...lists.map((list) => {
    const chip = el('button', `list-chip ${list.listId === activeListId ? 'active' : ''}`, `${list.emoji ?? DEFAULT_LIST_EMOJI} ${list.name}`);
    chip.addEventListener('click', () => {
      activeListId = list.listId;
      document.dispatchEvent(new CustomEvent('fh:shopping-render'));
    });
    return chip;
  }));
  const plus = el('button', 'list-chip list-chip-add', '＋');
  plus.setAttribute('aria-label', 'New list');
  plus.addEventListener('click', () => openListModal());
  switcher.appendChild(plus);

  // Progress (checkout feel)
  const items = itemsInList(view, activeListId);
  const done = items.filter((i) => i.done);
  const progress = $('#shopping-progress');
  progress.classList.remove('hidden');
  const fill = $('#shopping-progress-fill');
  fill.style.width = `${items.length ? Math.round((done.length / items.length) * 100) : 0}%`;
  $('#shopping-progress-label').textContent = items.length
    ? done.length === items.length ? 'All set 🎉' : `${items.length - done.length} left · ${done.length} done`
    : 'Nothing yet';

  // Aisle-grouped active items
  const activeItems = items.filter((i) => !i.done).sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
  const groups = groupByAisle(activeItems);
  const frag = document.createDocumentFragment();
  if (!groups.length) {
    frag.appendChild(emptyState('🛒', 'List is empty', 'Type an item below — or paste a whole list at once: milk, eggs, bread'));
  }
  for (const { aisle, items: groupItems } of groups) {
    frag.appendChild(el('div', 'aisle-head', `${aisle.emoji} ${aisle.label}`));
    for (const item of groupItems) frag.appendChild(shopItemRow(item));
  }

  // Done section (collapsible)
  if (done.length) {
    const section = el('div', 'done-section');
    const head = el('button', 'shop-done-toggle', `Done (${done.length})`);
    const body = el('div', `done-body ${localStorage.getItem('fh_shop_done_collapsed') === '1' ? 'collapsed' : ''}`);
    head.appendChild(el('span', 'done-caret', localStorage.getItem('fh_shop_done_collapsed') === '1' ? '▸' : '▾'));
    for (const item of done.sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0))) body.appendChild(shopItemRow(item, { done: true }));
    head.addEventListener('click', () => {
      const collapsed = body.classList.toggle('collapsed');
      head.querySelector('.done-caret').textContent = collapsed ? '▸' : '▾';
      localStorage.setItem('fh_shop_done_collapsed', collapsed ? '1' : '0');
    });
    section.append(head, body);
    frag.appendChild(section);
  }
  listEl.replaceChildren(frag);

  $('#btn-clear-checked').classList.toggle('hidden', !done.length);
}

function shopItemRow(item, { done = false } = {}) {
  const row = el('div', `shop-item ${done ? 'done' : ''}`);
  const check = el('button', 'note-check');
  check.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M4 12.5 9.5 18 20 6.5"/></svg>';
  check.setAttribute('aria-label', done ? 'Put back on list' : 'Check off');
  check.addEventListener('click', () => document.dispatchEvent(new CustomEvent('fh:item-toggle', { detail: item })));

  const main = el('span', 'shop-item-main');
  if ((item.qty ?? 1) > 1) main.appendChild(el('span', 'qty-badge', `${item.qty}×`));
  main.appendChild(el('span', 'shop-text', item.text));

  const actions = el('span', 'shop-item-actions');
  const del = el('button', 'icon-btn', '🗑');
  del.style.width = '32px';
  del.style.height = '32px';
  del.setAttribute('aria-label', 'Remove item');
  del.addEventListener('click', () => document.dispatchEvent(new CustomEvent('fh:item-delete', { detail: item })));
  actions.appendChild(del);

  row.append(check, main, actions);
  // Tap the row = toggle; tap the text = edit
  row.addEventListener('click', (e) => {
    if (e.target.closest('button')) return;
    document.dispatchEvent(new CustomEvent('fh:item-toggle', { detail: item }));
  });
  row.querySelector('.shop-text').addEventListener('click', (e) => {
    e.stopPropagation();
    document.dispatchEvent(new CustomEvent('fh:item-edit', { detail: item }));
  });
  return row;
}

// Inline note input for a vote — "Cook at home — WHAT are we cooking?"
function voteNoteInput(pollId, optionId, currentNote) {
  const input = el('input', 'poll-note-input');
  input.type = 'text';
  input.placeholder = 'Add a note — what / where? (optional)';
  input.value = currentNote ?? '';
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') input.blur();
    e.stopPropagation();
  });
  input.addEventListener('click', (e) => e.stopPropagation());
  input.addEventListener('change', () => {
    document.dispatchEvent(new CustomEvent('fh:vote-note', {
      detail: { pollId, optionId, note: input.value.trim() },
    }));
  });
  return input;
}

export function openListModal() {
  const form = $('#form-list');
  form.reset();
  form.name.value = '';
  form.emoji.value = DEFAULT_LIST_EMOJI;
  const picker = $('#emoji-picker');
  picker.replaceChildren(...LIST_EMOJIS.map((emoji) => {
    const btn = el('button', `emoji-option ${emoji === DEFAULT_LIST_EMOJI ? 'active' : ''}`, emoji);
    btn.type = 'button';
    btn.setAttribute('role', 'radio');
    btn.addEventListener('click', () => {
      picker.querySelectorAll('.emoji-option').forEach((b) => b.classList.toggle('active', b === btn));
      form.emoji.value = emoji;
    });
    return btn;
  }));
  openModal('modal-list');
  form.name.focus();
}

// ---------- Wish list (shopping sub-section) ----------

export function renderWishlist(view) {
  const container = $('#wishlist');
  const items = wishItems(view);
  if (!items.length) {
    container.replaceChildren(el('div', 'wish-empty', 'Nothing yet — add a gift idea or paste an Amazon / Walmart / Target link.'));
    return;
  }
  const frag = document.createDocumentFragment();
  for (const item of items) {
    const row = el('div', 'wish-item');
    if (item.url) {
      const store = detectStore(item.url);
      const badge = el('span', 'store-badge', `${store.emoji} ${store.label}`);
      const link = el('a', 'wish-link', item.text);
      link.href = item.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      row.append(badge, link);
    } else {
      row.appendChild(el('span', 'wish-text', item.text));
    }
    const edit = el('button', 'icon-btn', '✏️');
    edit.setAttribute('aria-label', 'Edit wish');
    edit.addEventListener('click', () => document.dispatchEvent(new CustomEvent('fh:wish-edit', { detail: item })));
    const del = el('button', 'icon-btn', '🗑');
    del.setAttribute('aria-label', 'Remove wish');
    del.addEventListener('click', () => document.dispatchEvent(new CustomEvent('fh:wish-delete', { detail: item })));
    row.append(edit, del);
    frag.appendChild(row);
  }
  container.replaceChildren(frag);
}

// ---------- Settings ----------

export function renderSettings({ members, dirState, account, familyName }) {
  // Family — the family's own name first, never a person's name
  const info = $('#family-info');
  if (dirState) {
    const title = el('p', 'about-text family-name-line', familyName ? `🏡 ${familyName}` : '🏡 Family Hub');
    info.replaceChildren(title, el('p', 'about-text', 'Your data lives in your shared Google Drive folder — everyone signs in with their own account. Export anytime.'));
    const rename = el('button', 'btn-secondary btn-xs', 'Rename family');
    rename.style.marginBottom = '8px';
    rename.addEventListener('click', () => document.dispatchEvent(new CustomEvent('fh:family-rename')));
    info.appendChild(rename);
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
    // The FAMILY already has a name — joiners only set their own
    $('#provision-title').textContent = 'Join your family';
    $('#provision-body').textContent = 'You were invited to a Family Hub. Sign in with your own Google account and set your name.';
    $('#btn-provision').textContent = 'Join family';
    $('#provision-family-label').classList.add('hidden');
    $('#provision-family').required = false; // hidden required field blocks submit
  } else {
    $('#provision-title').textContent = 'Set up your family';
    $('#provision-body').textContent = 'Name your family (not just you — everyone shares this), then set your own name. Everyone else joins with their own account afterwards.';
    $('#btn-provision').textContent = 'Create our family hub';
    $('#provision-family-label').classList.remove('hidden');
    $('#provision-family').required = true;
    $('#provision-family').focus();
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
