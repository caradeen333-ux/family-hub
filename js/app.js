// app.js — Entry point. Wires up navigation, data flow, and lifecycle.

// ===== BOOT SEQUENCE =====
document.addEventListener('DOMContentLoaded', async () => {
  updateHeaderDate();
  applyTheme();

  // RESTORE saved auth token from localStorage (survives power-off/restart)
  loadToken();

  // Settings AFTER token load so sheet backup/restore can use the token
  loadSettings();

  // If token is expired but we have a refresh token, try refreshing silently
  if (!isSignedIn() && localStorage.getItem('fh_refresh_token')) {
    setSyncStatus('', '● Refreshing session...');
    const refreshed = await refreshToken();
    if (refreshed) {
      console.log('Auth: session restored via refresh token');
    } else {
      console.log('Auth: refresh failed — user needs to sign in again');
    }
  }

  // Handle OAuth redirect back from Google
  const authResult = await handleAuthRedirect();
  if (authResult !== null) {
    if (authResult.success) {
      toast('Signed in!', 'success');
      await syncPeopleConfig(); // Restore calendar emails from sheet if this device lost them
      await autoConfigureCalendars();
      await loadAllData();
    } else {
      toast('Sign in failed: ' + authResult.error, 'error');
    }
  }

  // Load cached data immediately (offline-first)
  await loadCachedData();

  // If signed in, fetch fresh data; otherwise show demo
  if (isSignedIn()) {
    await loadAllData();
  } else {
    loadDemoData();
  }

  updateAuthUI();
  setupEventListeners();
  setupServiceWorker();

  // Restore last tab
  const savedTab = localStorage.getItem('fh_tab') || CONFIG.defaultTab;
  switchTab(savedTab);

  // Periodic refresh
  setInterval(() => {
    if (isSignedIn() && document.visibilityState === 'visible') {
      loadAllData(true); // silent refresh
    }
  }, CONFIG.refreshInterval);

  // Refresh when tab becomes visible
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && isSignedIn()) {
      loadAllData(true);
    }
  });

  // Refresh on online event
  window.addEventListener('online', () => {
    setOffline(false);
    if (isSignedIn()) loadAllData();
  });
  window.addEventListener('offline', () => setOffline(true));
  setOffline(!navigator.onLine);

  updateHeaderDate();
  setInterval(updateHeaderDate, 60000); // Update date display every minute
});

// ===== DATA LOADING =====
async function loadAllData(silent = false) {
  if (!silent) setSyncStatus('', 'Syncing...');

  try {
    // Fetch calendar events
    const events = await fetchTodayEvents(currentRange);
    await cacheEvents(events);

    // Render based on active tab
    const activeTab = document.querySelector('.tab.active')?.dataset.tab || 'myday';
    if (activeTab === 'myday') {
      const person = getSelectedPerson();
      const personEvents = events.filter(e => e.personName === person);
      renderEvents('myday-events', personEvents, false);
    }
    if (activeTab === 'everyone') {
      renderEvents('everyone-events', events, true);
    }

    // Fetch notes
    const notes = await fetchNotes();
    if (notes.length > 0) {
      setNotesData(notes);
      await cacheNotes(notes);
      if (activeTab === 'notes') {
        renderNotes();
        renderNoteFilters();
        attachNoteActionHandlers();
      }
    }

    await setMeta('lastSync', Date.now());
    setSyncStatus('synced', '● Synced ' + formatTimeAgo(Date.now()));
    setOffline(false);
  } catch (e) {
    console.error('Sync error:', e);
    setSyncStatus('error', '● Sync failed');
    // Already served cached data, so this is non-fatal
  }
}

async function loadCachedData() {
  try {
    // Load and render cached events
    const cachedEvents = await getCachedEvents();
    if (cachedEvents.length > 0) {
      const activeTab = localStorage.getItem('fh_tab') || CONFIG.defaultTab;
      if (activeTab === 'myday') {
        const person = getSelectedPerson();
        renderEvents('myday-events', cachedEvents.filter(e => e.personName === person), false);
      }
      if (activeTab === 'everyone') {
        renderEvents('everyone-events', cachedEvents, true);
      }
      const lastSync = await getMeta('lastSync');
      if (lastSync) {
        setSyncStatus('', '● Cached ' + formatTimeAgo(lastSync));
      }
    }

    // Load and render cached notes
    const cachedNotes = await getCachedNotes();
    if (cachedNotes.length > 0) {
      setNotesData(cachedNotes);
      const activeTab = localStorage.getItem('fh_tab') || CONFIG.defaultTab;
      if (activeTab === 'notes') {
        renderNotes();
        renderNoteFilters();
        attachNoteActionHandlers();
      }
    }

    // Process offline queue
    const queue = await getOfflineQueue();
    if (queue.length > 0 && isSignedIn() && navigator.onLine) {
      toast(`Syncing ${queue.length} offline change(s)...`, 'success');
      await processOfflineQueue(queue);
    }
  } catch (e) {
    console.error('Cache load error:', e);
  }
}

// ===== EVENT LISTENERS =====
let currentRange = 1; // Default: Day

function setupEventListeners() {
  // Day/Week/Month range buttons
  document.querySelectorAll('.range-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const range = parseInt(btn.dataset.range);
      currentRange = range;
      // Update active state in all range groups
      document.querySelectorAll('.range-btn').forEach(b => {
        b.classList.toggle('active', parseInt(b.dataset.range) === range);
      });
      // Refetch and re-render current tab
      try {
        await refreshCurrentTab();
      } catch (e) {
        console.error('Range refresh error:', e);
      }
    });
  });

  // Tabs
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', async () => {
      const tabName = tab.dataset.tab;
      switchTab(tabName);

      // Re-render from cache first, then refresh — fall back to demo if not signed in
      if (tabName === 'myday') {
        const person = getSelectedPerson();
        const cached = await getCachedEvents();
        if (cached.length > 0) {
          renderEvents('myday-events', cached.filter(e => e.personName === person), false);
        } else if (!isSignedIn()) {
          loadDemoTab('myday');
          return;
        }
        attachEventHandlers();
        if (isSignedIn()) {
          const events = await fetchTodayEvents(currentRange);
          await cacheEvents(events);
          renderEvents('myday-events', events.filter(e => e.personName === getSelectedPerson()), false);
          attachEventHandlers();
        }
      }
      if (tabName === 'everyone') {
        const cached = await getCachedEvents();
        if (cached.length > 0) {
          renderEvents('everyone-events', cached, true);
        } else if (!isSignedIn()) {
          loadDemoTab('everyone');
          return;
        }
        attachEventHandlers();
        if (isSignedIn()) {
          const events = await fetchTodayEvents(currentRange);
          await cacheEvents(events);
          renderEvents('everyone-events', events, true);
          attachEventHandlers();
        }
      }
      if (tabName === 'notes') {
        const cachedNotes = await getCachedNotes();
        if (cachedNotes.length > 0) {
          setNotesData(cachedNotes);
        } else if (!isSignedIn()) {
          loadDemoTab('notes');
          return;
        }
        renderNotes();
        renderNoteFilters();
        attachNoteFilterHandlers();
        attachNoteActionHandlers();
        if (isSignedIn()) {
          const notes = await fetchNotes();
          if (notes.length > 0) {
            setNotesData(notes);
            await cacheNotes(notes);
            renderNotes();
            renderNoteFilters();
            attachNoteFilterHandlers();
            attachNoteActionHandlers();
          }
        }
      }
    });
  });

  // Person picker change
  document.getElementById('person-picker').addEventListener('change', async () => {
    const person = getSelectedPerson();
    localStorage.setItem('fh_myday_person', person);
    const cached = await getCachedEvents();
    renderEvents('myday-events', cached.filter(e => e.personName === person), false);
    attachEventHandlers();
    if (isSignedIn()) {
      const events = await fetchTodayEvents(currentRange);
      await cacheEvents(events);
      renderEvents('myday-events', events.filter(e => e.personName === person), false);
      attachEventHandlers();
    }
  });

  // Add event button
  document.getElementById('btn-add').addEventListener('click', () => {
    if (!isSignedIn()) { toast('Sign in first', 'error'); openModal('modal-settings'); return; }
    openEventModal();
  });
  document.querySelector('.cb-allday')?.addEventListener('change', (e) => {
    toggleTimeFields(e.target.checked);
  });

  // Event form submit
  document.getElementById('form-event').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    try {
      await createEvent({
        calendarId: form.elements.calendarId.value,
        title: form.elements.title.value,
        date: form.elements.date.value,
        startTime: form.elements.startTime.value || undefined,
        endTime: form.elements.endTime.value || undefined,
        allDay: form.elements.allday.checked,
        location: form.elements.location.value || undefined,
        description: form.elements.description.value || undefined,
      });
      toast('Event created!', 'success');
      closeModal('modal-event');
      await loadAllData(true);
    } catch (err) {
      toast('Failed: ' + err.message, 'error');
    }
  });

  // Add note button (FAB)
  document.getElementById('btn-add-note').addEventListener('click', () => {
    if (!isSignedIn()) { toast('Sign in first', 'error'); openModal('modal-settings'); return; }
    openNoteModal();
  });

  // Note form submit
  document.getElementById('form-note').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const noteData = {
      id: form.dataset.noteId || generateId(),
      author: form.elements.author.value,
      date: form.elements.date.value,
      time: form.elements.time.value,
      importance: form.elements.importance.value,
      color: CONFIG.people.find(p => p.name === form.elements.author.value)?.color,
      category: form.elements.category.value,
      note: form.elements.note.value,
      status: 'active',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    try {
      if (!navigator.onLine) {
        await queueOfflineWrite({ type: 'note', action: 'add', data: noteData });
        toast('Queued for sync', 'success');
      } else {
        if (form.dataset.rowIndex) {
          await updateNoteInSheet(parseInt(form.dataset.rowIndex), noteData, {});
          toast('Note updated!', 'success');
        } else {
          await addNote(noteData);
          toast('Note added!', 'success');
        }
        // Refresh notes data
        const notes = await fetchNotes();
        setNotesData(notes);
        await cacheNotes(notes);
        renderNotes();
        renderNoteFilters();
        attachNoteFilterHandlers();
        attachNoteActionHandlers();
      }
      closeModal('modal-note');
    } catch (err) {
      toast('Failed: ' + err.message, 'error');
    }
  });

  // Refresh button
  document.getElementById('btn-refresh').addEventListener('click', () => {
    if (!isSignedIn()) { toast('Sign in first', 'error'); return; }
    loadAllData();
    toast('Refreshed', 'success');
  });

  // Settings button
  document.getElementById('btn-settings').addEventListener('click', () => {
    updateAuthUI();
    populateSettingsForm();
    renderPeopleConfig();
    openModal('modal-settings');
  });

  // Settings: sign in / out
  document.getElementById('btn-signin').addEventListener('click', () => signIn());
  document.getElementById('btn-signout').addEventListener('click', () => {
    signOut();
    updateAuthUI();
    toast('Signed out', 'success');
  });

  // Theme toggle button
  document.getElementById('btn-theme').addEventListener('click', () => {
    document.body.classList.toggle('light');
    const isDark = !document.body.classList.contains('light');
    localStorage.setItem('fh_darkmode', isDark);
    document.getElementById('btn-theme').textContent = isDark ? '🌙' : '☀️';
    document.getElementById('setting-darkmode').checked = isDark;
  });

  // Quick-add note: toggle button shows/hides the inline input
  const quickForm = document.querySelector('.quick-add-form');
  const quickInput = document.getElementById('quick-note-input');
  const quickToggle = document.getElementById('btn-quick-add');

  quickToggle.addEventListener('click', () => {
    quickForm.classList.toggle('hidden');
    if (!quickForm.classList.contains('hidden')) quickInput.focus();
  });

  document.getElementById('btn-quick-cancel').addEventListener('click', () => {
    quickForm.classList.add('hidden');
    quickInput.value = '';
  });

  // Quick-add note (Enter to save)
  quickInput.addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter' || !quickInput.value.trim()) return;
    const text = quickInput.value.trim();
    quickInput.value = '';
    quickForm.classList.add('hidden');
    const author = getSelectedPerson() || CONFIG.people[0]?.name || 'Mike';
    const noteData = {
      id: generateId(),
      author,
      date: new Date().toISOString().split('T')[0],
      time: '',
      importance: 'medium',
      color: CONFIG.people.find(p => p.name === author)?.color || '#7c5cfc',
      category: 'General',
      note: text,
      status: 'active',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    try {
      if (!navigator.onLine) {
        await queueOfflineWrite({ type: 'note', action: 'add', data: noteData });
        toast('Queued for sync', 'success');
      } else {
        await addNote(noteData);
        toast('Note added!', 'success');
        const notes = await fetchNotes();
        setNotesData(notes);
        await cacheNotes(notes);
        renderNotes();
        renderNoteFilters();
        attachNoteFilterHandlers();
        attachNoteActionHandlers();
      }
      updateNotesBadge();
    } catch (err) {
      toast('Failed: ' + err.message, 'error');
    }
  });

  // Settings: always on top
  document.getElementById('setting-alwaysontop').addEventListener('change', (e) => {
    localStorage.setItem('fh_alwaysontop', e.target.checked);
    if (window.__electron && window.__electron.setAlwaysOnTop) {
      window.__electron.setAlwaysOnTop(e.target.checked);
    }
  });

  // Settings: dark mode toggle
  document.getElementById('setting-darkmode').addEventListener('change', (e) => {
    document.body.classList.toggle('light', !e.target.checked);
    localStorage.setItem('fh_darkmode', e.target.checked);
  });

  // Settings: sheet ID
  document.getElementById('setting-sheet-id').addEventListener('change', (e) => {
    localStorage.setItem('fh_notesSheetId', e.target.value);
  });

  // Settings: add person
  document.getElementById('btn-add-person')?.addEventListener('click', () => {
    const container = document.getElementById('people-config');
    const idx = CONFIG.people.length;
    CONFIG.people.push({ name: '', calendarId: '', color: '#7c5cfc', default: false });
    renderPeopleConfig();
  });

  // PWA install button
  const installBtn = document.getElementById('btn-install');
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    window._installPrompt = e;
    installBtn.classList.remove('hidden');
    installBtn.addEventListener('click', () => {
      e.prompt();
      e.userChoice.then(() => installBtn.classList.add('hidden'));
    });
  });
  window.addEventListener('appinstalled', () => {
    installBtn.classList.add('hidden');
    toast('App installed! 🎉', 'success');
  });

  // Confirm delete
  document.getElementById('btn-confirm-delete').addEventListener('click', () => {
    if (confirmCallback) confirmCallback();
    closeModal('modal-confirm');
    confirmCallback = null;
  });

  // Modal close buttons
  document.querySelectorAll('.modal-close, .btn-cancel').forEach(btn => {
    btn.addEventListener('click', () => {
      const modalId = btn.dataset.close;
      if (modalId) closeModal(modalId);
    });
  });

  // Close modals on overlay click
  document.querySelectorAll('.modal-overlay').forEach(overlay => {
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) closeModal(overlay.id);
    });
  });

  // Keyboard: Escape closes modals
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeAllModals();
  });
}

// ===== SETTINGS PERSISTENCE =====
function loadSettings() {
  // Restore sheet ID
  const sheetId = localStorage.getItem('fh_notesSheetId');
  if (sheetId) CONFIG.notesSheetId = sheetId;

  // Restore person picker preference
  const savedPerson = localStorage.getItem('fh_myday_person');
  const defaultPerson = CONFIG.people.find(p => p.default)?.name || CONFIG.people[0]?.name;

  // Ensure people config is loaded from localStorage if saved
  try {
    const savedPeople = localStorage.getItem('fh_people');
    if (savedPeople) CONFIG.people = JSON.parse(savedPeople);
  } catch (e) { /* */ }

  renderPersonPicker(savedPerson || defaultPerson);

  // Back up / restore people config (calendar emails) to the Google Sheet
  if (isSignedIn()) syncPeopleConfig();
}

function renderPeopleConfig() {
  const container = document.getElementById('people-config');
  container.innerHTML = CONFIG.people.map((p, i) => `
    <div class="form-row" style="margin-bottom:8px">
      <label style="flex:2">Name <input type="text" value="${escapeHtml(p.name)}" data-person-idx="${i}" data-field="name"></label>
      <label style="flex:3">Calendar ID <input type="text" value="${escapeHtml(p.calendarId)}" data-person-idx="${i}" data-field="calendarId"></label>
      <label style="flex:1">Color <input type="color" value="${p.color}" data-person-idx="${i}" data-field="color"></label>
    </div>
  `).join('');

  // Attach change handlers
  container.querySelectorAll('input').forEach(input => {
    input.addEventListener('change', () => {
      const idx = parseInt(input.dataset.personIdx);
      const field = input.dataset.field;
      CONFIG.people[idx][field] = input.value;
      localStorage.setItem('fh_people', JSON.stringify(CONFIG.people));
      savePeopleConfigToSheet(); // Back up to the sheet so a device wipe can't lose the emails
      renderPersonPicker(getSelectedPerson());
    });
  });
}

function applyTheme() {
  const dark = localStorage.getItem('fh_darkmode') !== 'false'; // default dark
  document.body.classList.toggle('light', !dark);
  document.getElementById('setting-darkmode').checked = dark;
  const themeBtn = document.getElementById('btn-theme');
  if (themeBtn) themeBtn.textContent = dark ? '🌙' : '☀️';
}

// ===== SERVICE WORKER =====
function setupServiceWorker() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js')
      .then(reg => console.log('SW registered:', reg.scope))
      .catch(err => console.error('SW registration failed:', err));
  }
}

// ===== OFFLINE QUEUE =====
async function processOfflineQueue(queue) {
  for (const entry of queue) {
    try {
      if (entry.type === 'note' && entry.action === 'add') {
        await addNote(entry.data);
      }
    } catch (e) {
      console.error('Offline sync error:', e);
    }
  }
  await clearOfflineQueue();
}

async function refreshCurrentTab() {
  const tabName = document.querySelector('.tab.active')?.dataset.tab || 'myday';
  if (tabName === 'myday') {
    const person = getSelectedPerson();
    const events = await fetchTodayEvents(currentRange);
    await cacheEvents(events);
    renderEvents('myday-events', events.filter(e => e.personName === person), false);
    attachEventHandlers();
  }
  if (tabName === 'everyone') {
    const events = await fetchTodayEvents(currentRange);
    await cacheEvents(events);
    renderEvents('everyone-events', events, true);
    attachEventHandlers();
  }
}

// ===== DEMO DATA =====
function getDemoEvents() {
  const today = new Date().toISOString().split('T')[0];
  return [
    { id:'demo1', calendarId:'mike@example.com', personName:'Mike', personColor:'#7c5cfc',
      title:'Morning workout', date:today, startTime:`${today}T07:00:00Z`, endTime:`${today}T08:00:00Z`,
      allDay:false, location:'Home', status:'confirmed' },
    { id:'demo2', calendarId:'charlie@example.com', personName:'Charlie', personColor:'#5cc9fc',
      title:'Dentist appointment', date:today, startTime:`${today}T10:00:00Z`, endTime:`${today}T11:00:00Z`,
      allDay:false, location:'123 Main St', status:'confirmed' },
    { id:'demo3', calendarId:'avery@example.com', personName:'Avery', personColor:'#fcd45c',
      title:'Soccer practice', date:today, startTime:`${today}T15:00:00Z`, endTime:`${today}T16:30:00Z`,
      allDay:false, location:'Sports Complex', status:'confirmed' },
    { id:'demo4', calendarId:'mike@example.com', personName:'Mike', personColor:'#7c5cfc',
      title:'School starts', date:today, allDay:true, status:'confirmed' },
    { id:'demo5', calendarId:'charlie@example.com', personName:'Charlie', personColor:'#5cc9fc',
      title:'Team meeting', date:today, startTime:`${today}T14:00:00Z`, endTime:`${today}T14:30:00Z`,
      allDay:false, location:'Zoom', status:'confirmed' },
  ];
}

function getDemoNotes() {
  const today = new Date().toISOString().split('T')[0];
  const ts = new Date().toISOString();
  return [
    { id:'dn1', author:'Mike', date:today, time:'12:00', importance:'high', color:'#7c5cfc',
      category:'Medical', note:'Pick up prescription before pharmacy closes', createdAt:ts, updatedAt:ts, status:'active', rowIndex:2 },
    { id:'dn2', author:'Charlie', date:today, time:'', importance:'medium', color:'#5cc9fc',
      category:'Shopping', note:'Get milk, eggs, and bread from the store', createdAt:ts, updatedAt:ts, status:'active', rowIndex:3 },
    { id:'dn3', author:'Avery', date:today, time:'17:00', importance:'low', color:'#fcd45c',
      category:'Chores', note:'Take out the trash bins for tomorrow pickup', createdAt:ts, updatedAt:ts, status:'done', rowIndex:4 },
    { id:'dn4', author:'Mike', date:today, time:'', importance:'medium', color:'#7c5cfc',
      category:'School', note:'Sign permission slip for field trip on Friday', createdAt:ts, updatedAt:ts, status:'active', rowIndex:5 },
  ];
}

function loadDemoData() {
  const activeTab = localStorage.getItem('fh_tab') || 'myday';
  loadDemoTab(activeTab);
  setSyncStatus('', '● Demo mode — sign in to sync');
}

function loadDemoTab(tabName) {
  if (tabName === 'myday') {
    const person = getSelectedPerson();
    renderEvents('myday-events', getDemoEvents().filter(e => e.personName === person), false);
    attachEventHandlers();
  }
  if (tabName === 'everyone') {
    renderEvents('everyone-events', getDemoEvents(), true);
    attachEventHandlers();
  }
  if (tabName === 'notes') {
    setNotesData(getDemoNotes());
    renderNotes();
    renderNoteFilters();
    attachNoteFilterHandlers();
    attachNoteActionHandlers();
  }
}

// ===== HELPERS =====
async function autoConfigureCalendars() {
  try {
    const calendars = await discoverCalendars();
    let changed = false;

    for (const person of CONFIG.people) {
      if (person.calendarId && person.calendarId !== 'primary') continue; // Already configured

      // Try to find a shared calendar matching this person
      for (const [key, cal] of Object.entries(calendars)) {
        if (cal.accessRole === 'owner' && person.calendarId === 'primary') continue; // Skip, primary is fine
        // Match by email or summary containing the person's name
        const nameLower = person.name.toLowerCase();
        if (
          key.toLowerCase().includes(nameLower) ||
          (cal.summary && cal.summary.toLowerCase().includes(nameLower))
        ) {
          person.calendarId = cal.id;
          changed = true;
          console.log(`Auto-mapped ${person.name} → ${cal.id} (${cal.summary})`);
          break;
        }
      }
    }

    if (changed) {
      localStorage.setItem('fh_people', JSON.stringify(CONFIG.people));
      renderPersonPicker(getSelectedPerson());
    }
  } catch (e) {
    console.warn('Auto calendar discovery failed:', e);
    // Non-fatal — user can configure manually in Settings
  }
}

function formatTimeAgo(timestamp) {
  const diff = Date.now() - timestamp;
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.floor(hr / 24);
  return `${days}d ago`;
}
