// ui.js — DOM rendering and interaction handlers
// All view updates go through this module

// ----- Header -----
function updateHeaderDate() {
  const now = new Date();
  const opts = { weekday: 'short', month: 'short', day: 'numeric' };
  document.getElementById('header-date').textContent = now.toLocaleDateString('en-US', opts);
}

// ----- Sync status footer -----
function setSyncStatus(status, text) {
  const el = document.getElementById('sync-status');
  el.textContent = text;
  el.className = 'sync-status ' + status; // 'synced', 'error', or ''
}

function setOffline(offline) {
  document.getElementById('offline-banner').classList.toggle('hidden', !offline);
}

// ----- Tabs -----
function switchTab(tabName) {
  document.querySelectorAll('.tab').forEach(t => {
    t.classList.toggle('active', t.dataset.tab === tabName);
    t.setAttribute('aria-selected', t.dataset.tab === tabName);
  });
  document.querySelectorAll('.panel').forEach(p => {
    p.classList.toggle('active', p.id === `panel-${tabName}`);
  });
  localStorage.setItem('fh_tab', tabName);
}

// ----- Person picker -----
function renderPersonPicker(selectedName) {
  const sel = document.getElementById('person-picker');
  sel.innerHTML = '';
  for (const p of CONFIG.people) {
    if (!p.calendarId) continue;
    const opt = document.createElement('option');
    opt.value = p.name;
    opt.textContent = p.name;
    if (p.name === selectedName) opt.selected = true;
    sel.appendChild(opt);
  }
}

function getSelectedPerson() {
  return document.getElementById('person-picker').value;
}

// ----- Event list rendering -----
function renderEvents(containerId, events, showPersonChip = false) {
  const container = document.getElementById(containerId);
  if (!container) return;

  if (!events || events.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <span class="emoji">📅</span>
        <p>No events today</p>
      </div>`;
    return;
  }

  container.innerHTML = events.map(ev => `
    <div class="event-card${ev.allDay ? ' allday' : ''}"
         style="border-left-color: ${ev.personColor}"
         data-event-id="${ev.id}"
         data-calendar-id="${encodeURIComponent(ev.calendarId)}">
      <div class="event-time">
        ${ev.allDay
          ? '<span class="end-time">ALL<br>DAY</span>'
          : `${formatTime(ev.startTime)}${ev.endTime ? `<br><span class="end-time">${formatTime(ev.endTime)}</span>` : ''}`
        }
      </div>
      <div class="event-body">
        <div class="event-title">${escapeHtml(ev.title)}</div>
        <div class="event-meta">
          ${ev.location ? `<span class="event-location">📍 ${escapeHtml(ev.location)}</span>` : ''}
          ${showPersonChip ? `<span class="event-chip" style="background:${ev.personColor}22;color:${ev.personColor}">${escapeHtml(ev.personName)}</span>` : ''}
          ${ev.status === 'cancelled' ? '<span class="event-chip">Cancelled</span>' : ''}
        </div>
      </div>
    </div>
  `).join('');
}

// Add click handlers to event cards
function attachEventHandlers() {
  document.querySelectorAll('.event-card').forEach(card => {
    card.addEventListener('click', () => {
      const calId = decodeURIComponent(card.dataset.calendarId);
      const eventId = card.dataset.eventId;
      // For now, open in Google Calendar. Later: edit modal.
      if (eventId && calId) {
        window.open(`https://calendar.google.com/calendar/event?eid=${btoa(eventId)}`, '_blank');
      }
    });
  });
}

// ----- Notes rendering -----
let allNotes = [];
let noteFilters = { importance: null, author: null, category: null, sort: 'date-desc' };

function setNotesData(notes) {
  allNotes = notes;
}

function renderNotes() {
  const container = document.getElementById('notes-list');
  if (!container) return;

  let filtered = [...allNotes];

  // Apply filters
  if (noteFilters.importance) {
    filtered = filtered.filter(n => n.importance === noteFilters.importance);
  }
  if (noteFilters.author) {
    filtered = filtered.filter(n => n.author === noteFilters.author);
  }
  if (noteFilters.category) {
    filtered = filtered.filter(n => n.category === noteFilters.category);
  }

  // Only show active notes by default; archived are hidden
  filtered = filtered.filter(n => n.status !== 'archived');

  // Sort
  if (noteFilters.sort === 'date-desc') {
    filtered.sort((a, b) => b.date.localeCompare(a.date) || (b.time || '').localeCompare(a.time || ''));
  } else if (noteFilters.sort === 'date-asc') {
    filtered.sort((a, b) => a.date.localeCompare(b.date) || (a.time || '').localeCompare(b.time || ''));
  } else if (noteFilters.sort === 'importance') {
    const rank = { high: 0, medium: 1, low: 2 };
    filtered.sort((a, b) => (rank[a.importance] || 1) - (rank[b.importance] || 1));
  }

  if (filtered.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <span class="emoji">📋</span>
        <p>No notes yet — tap + to add one</p>
      </div>`;
    return;
  }

  container.innerHTML = filtered.map(n => {
    const impEmoji = { high: '🔴', medium: '🟡', low: '🟢' };
    const borderColor = n.color || CONFIG.people.find(p => p.name === n.author)?.color || '#7c5cfc';
    return `
      <div class="note-card${n.status === 'done' ? ' done' : ''}"
           style="border-left-color: ${borderColor}"
           data-note-row="${n.rowIndex}"
           data-note-id="${escapeHtml(n.id)}">
        <div class="note-header">
          <span class="note-importance">${impEmoji[n.importance] || '🟡'} ${n.importance.toUpperCase()}</span>
          <span class="note-date">📅 ${formatDisplayDate(n.date)}${n.time ? ' 🕐 ' + formatDisplayTime(n.time) : ''}</span>
          <span class="note-author" style="background:${borderColor}22;color:${borderColor}">${escapeHtml(n.author)}</span>
        </div>
        <div class="note-text">${escapeHtml(n.note)}</div>
        <div class="note-category">🏷️ ${escapeHtml(n.category)}</div>
        <div class="note-actions">
          <button class="btn-done" data-row="${n.rowIndex}">${n.status === 'done' ? '↩ Undo' : '✓ Done'}</button>
          <button class="btn-edit-note" data-row="${n.rowIndex}">✏️ Edit</button>
          <button class="btn-delete-note" data-row="${n.rowIndex}">🗑 Delete</button>
        </div>
      </div>`;
  }).join('');
}

function renderNoteFilters() {
  // Importance filter chips
  const impContainer = document.getElementById('filter-importance');
  impContainer.innerHTML = ['high', 'medium', 'low'].map(i => {
    const emoji = { high: '🔴', medium: '🟡', low: '🟢' };
    return `<button class="filter-chip${noteFilters.importance === i ? ' active' : ''}"
                   data-filter="importance" data-value="${i}">${emoji[i]} ${i.charAt(0).toUpperCase() + i.slice(1)}</button>`;
  }).join('');

  // Author filter chips
  const authContainer = document.getElementById('filter-author');
  const authors = [...new Set(allNotes.map(n => n.author).filter(Boolean))];
  authContainer.innerHTML = `<button class="filter-chip${!noteFilters.author ? ' active' : ''}"
    data-filter="author" data-value="">All</button>` +
    authors.map(a => `<button class="filter-chip${noteFilters.author === a ? ' active' : ''}"
      data-filter="author" data-value="${escapeHtml(a)}">${escapeHtml(a)}</button>`).join('');

  // Category filter chips
  const catContainer = document.getElementById('filter-category');
  const cats = [...new Set([...NOTE_CATEGORIES, ...allNotes.map(n => n.category).filter(Boolean)])];
  catContainer.innerHTML = `<button class="filter-chip${!noteFilters.category ? ' active' : ''}"
    data-filter="category" data-value="">All</button>` +
    cats.map(c => `<button class="filter-chip${noteFilters.category === c ? ' active' : ''}"
      data-filter="category" data-value="${escapeHtml(c)}">${escapeHtml(c)}</button>`).join('');
}

// Attach filter chip handlers
function attachNoteFilterHandlers() {
  document.querySelectorAll('.filter-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      const filterType = chip.dataset.filter;
      const value = chip.dataset.value;
      if (filterType === 'importance') noteFilters.importance = noteFilters.importance === value ? null : value;
      if (filterType === 'author')     noteFilters.author = value || null;
      if (filterType === 'category')   noteFilters.category = value || null;
      renderNoteFilters();
      renderNotes();
    });
  });

  const sortSel = document.getElementById('sort-notes');
  if (sortSel) {
    sortSel.value = noteFilters.sort;
    sortSel.addEventListener('change', () => {
      noteFilters.sort = sortSel.value;
      renderNotes();
    });
  }
}

// Attach note action handlers (done, edit, delete)
function attachNoteActionHandlers() {
  document.querySelectorAll('.btn-done').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const rowIndex = parseInt(btn.dataset.row);
      const note = allNotes.find(n => n.rowIndex === rowIndex);
      if (!note) return;
      const newStatus = note.status === 'done' ? 'active' : 'done';
      try {
        await updateNoteInSheet(rowIndex, note, { status: newStatus });
        note.status = newStatus;
        note.updatedAt = new Date().toISOString();
        await cacheNotes(allNotes);
        renderNotes();
        attachNoteActionHandlers();
      } catch (err) {
        toast('Failed to update note', 'error');
      }
    });
  });

  document.querySelectorAll('.btn-edit-note').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const rowIndex = parseInt(btn.dataset.row);
      const note = allNotes.find(n => n.rowIndex === rowIndex);
      if (!note) return;
      openNoteModal(note);
    });
  });

  document.querySelectorAll('.btn-delete-note').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const rowIndex = parseInt(btn.dataset.row);
      showConfirm('Delete this note?', async () => {
        const note = allNotes.find(n => n.rowIndex === rowIndex);
        if (!note) return;
        try {
          await updateNoteInSheet(rowIndex, note, { status: 'archived' });
          allNotes = allNotes.filter(n => n.rowIndex !== rowIndex);
          await cacheNotes(allNotes);
          renderNotes();
          attachNoteActionHandlers();
          toast('Note archived', 'success');
        } catch (err) {
          toast('Failed to archive note', 'error');
        }
      });
    });
  });
}

async function updateNoteInSheet(rowIndex, note, overrides) {
  const merged = { ...note, ...overrides, updatedAt: new Date().toISOString() };
  const values = [
    merged.id, merged.author, merged.date, merged.time || '',
    merged.importance, merged.color || '', merged.category,
    merged.note, merged.createdAt || '', merged.updatedAt,
    merged.status,
  ];
  await updateNoteRow(rowIndex, values);
}

// ----- Modals -----
function openModal(id) {
  document.getElementById(id).classList.remove('hidden');
  document.body.style.overflow = 'hidden';
}

function closeModal(id) {
  document.getElementById(id).classList.add('hidden');
  document.body.style.overflow = '';
}

function closeAllModals() {
  document.querySelectorAll('.modal-overlay').forEach(m => m.classList.add('hidden'));
  document.body.style.overflow = '';
}

// Event form
function openEventModal(prefill = {}) {
  const form = document.getElementById('form-event');
  form.reset();
  document.getElementById('modal-event-title').textContent = prefill.id ? 'Edit Event' : 'Add Event';

  const calSelect = form.elements.calendarId;
  calSelect.innerHTML = '';
  for (const p of CONFIG.people) {
    if (!p.calendarId) continue;
    const opt = document.createElement('option');
    opt.value = p.calendarId;
    opt.textContent = p.name;
    if (prefill.calendarId === p.calendarId) opt.selected = true;
    calSelect.appendChild(opt);
  }

  // Prefill
  form.elements.title.value = prefill.title || '';
  form.elements.date.value = prefill.date || new Date().toISOString().split('T')[0];
  form.elements.allday.checked = prefill.allDay || false;
  form.elements.startTime.value = prefill.startTime ? prefill.startTime.split('T')[1]?.substring(0, 5) : '';
  form.elements.endTime.value = prefill.endTime ? prefill.endTime.split('T')[1]?.substring(0, 5) : '';
  form.elements.location.value = prefill.location || '';
  form.elements.description.value = prefill.description || '';

  toggleTimeFields(form.elements.allday.checked);
  openModal('modal-event');
}

function toggleTimeFields(isAllDay) {
  document.querySelectorAll('.time-row').forEach(r => {
    r.style.display = isAllDay ? 'none' : '';
  });
}

// Note form
function openNoteModal(prefill = {}) {
  const form = document.getElementById('form-note');
  form.reset();
  document.getElementById('modal-note-title').textContent = prefill.id ? 'Edit Note' : 'Add Note';

  // Author dropdown
  const authSelect = form.elements.author;
  authSelect.innerHTML = '';
  for (const p of CONFIG.people) {
    const opt = document.createElement('option');
    opt.value = p.name;
    opt.textContent = p.name;
    if (prefill.author === p.name) opt.selected = true;
    authSelect.appendChild(opt);
  }

  form.elements.date.value = prefill.date || new Date().toISOString().split('T')[0];
  form.elements.time.value = prefill.time || '';
  form.elements.importance.value = prefill.importance || 'medium';
  form.elements.category.value = prefill.category || 'General';
  form.elements.note.value = prefill.note || '';

  // Store note ID for edits
  form.dataset.noteId = prefill.id || '';
  form.dataset.rowIndex = prefill.rowIndex || '';

  openModal('modal-note');
}

// Confirmation modal
let confirmCallback = null;
function showConfirm(message, onConfirm) {
  document.getElementById('confirm-message').textContent = message;
  confirmCallback = onConfirm;
  openModal('modal-confirm');
}

// ----- Toast -----
function toast(message, type = 'success') {
  const container = document.getElementById('toast-container');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => el.remove(), 3000);
}

// ----- Settings rendering -----
function updateAuthUI() {
  const signedIn = isSignedIn();
  document.getElementById('btn-signin').classList.toggle('hidden', signedIn);
  document.getElementById('btn-signout').classList.toggle('hidden', !signedIn);
  const userEl = document.getElementById('auth-user');
  userEl.classList.toggle('hidden', !signedIn);
  if (signedIn) {
    userEl.textContent = '✓ Signed in';
    userEl.style.color = 'var(--success)';
  }
}

function populateSettingsForm() {
  document.getElementById('setting-sheet-id').value =
    localStorage.getItem('fh_notesSheetId') || CONFIG.notesSheetId || '';
  document.getElementById('setting-darkmode').checked =
    localStorage.getItem('fh_darkmode') !== 'false';
  document.getElementById('setting-alwaysontop').checked =
    localStorage.getItem('fh_alwaysontop') === 'true';
}

// ----- Formatting helpers -----
function formatDisplayDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr + (dateStr.includes('T') ? '' : 'T00:00:00'));
  const opts = { month: 'short', day: 'numeric' };
  const formatted = d.toLocaleDateString('en-US', opts);
  // If it's this year, omit year
  const now = new Date();
  if (d.getFullYear() === now.getFullYear()) return formatted;
  return `${formatted}, ${d.getFullYear()}`;
}

function formatDisplayTime(timeStr) {
  if (!timeStr) return '';
  const [h, m] = timeStr.split(':').map(Number);
  const ampm = h >= 12 ? 'PM' : 'AM';
  const hour = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return m === 0 ? `${hour} ${ampm}` : `${hour}:${String(m).padStart(2, '0')} ${ampm}`;
}

function escapeHtml(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
