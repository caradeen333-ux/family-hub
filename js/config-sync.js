// config-sync.js — Backs up app settings (people config with calendar emails)
// to the Google Sheet so they survive device wipes. Local storage is the source
// of truth while it exists; the sheet is the backup that restores it.

const CONFIG_TAB = 'AppConfig';

function getConfigSheetId() {
  return loadSetting('notesSheetId') || CONFIG.notesSheetId;
}

// Ensure the AppConfig tab exists in the sheet (create it if missing)
async function ensureConfigTab(sheetId, token) {
  try {
    const url = `${SHEETS_API}/${sheetId}/values/${encodeURIComponent(CONFIG_TAB + '!A1')}`;
    const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (resp.ok) return true;
  } catch (e) { /* fall through to create */ }

  try {
    const url = `${SHEETS_API}/${sheetId}:batchUpdate`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ requests: [{ addSheet: { properties: { title: CONFIG_TAB } } }] }),
    });
    return resp.ok;
  } catch (e) {
    console.error('Config tab create error:', e);
    return false;
  }
}

// Push the local people config (names, calendar emails, colors) to the sheet
async function savePeopleConfigToSheet() {
  const token = getAccessToken();
  const sheetId = getConfigSheetId();
  if (!token || !sheetId) return false;

  try {
    if (!await ensureConfigTab(sheetId, token)) return false;

    const url = `${SHEETS_API}/${sheetId}/values/${encodeURIComponent(CONFIG_TAB + '!A1:B2')}?valueInputOption=RAW`;
    const resp = await fetch(url, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        values: [
          ['Key', 'Value'],
          ['people', JSON.stringify(CONFIG.people)],
        ],
      }),
    });
    return resp.ok;
  } catch (e) {
    console.error('Config save error:', e);
    return false;
  }
}

// Fetch the people config from the sheet (returns null if not stored there)
async function loadPeopleConfigFromSheet() {
  const token = getAccessToken();
  const sheetId = getConfigSheetId();
  if (!token || !sheetId) return null;

  try {
    const url = `${SHEETS_API}/${sheetId}/values/${encodeURIComponent(CONFIG_TAB + '!A2:B2')}`;
    const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!resp.ok) return null;
    const data = await resp.json();
    const rows = data.values || [];
    for (const row of rows) {
      if (row[0] === 'people' && row[1]) {
        const parsed = JSON.parse(row[1]);
        if (Array.isArray(parsed) && parsed.every(p => p && typeof p.name === 'string')) {
          return parsed;
        }
      }
    }
    return null;
  } catch (e) {
    console.error('Config load error:', e);
    return null;
  }
}

// True if this config has no calendar emails filled in (never configured)
function isBlankConfig(people) {
  return Array.isArray(people) && people.every(p => !p.calendarId);
}

// Apply a people config from the sheet to the running app
function applyPeopleConfig(people) {
  CONFIG.people = people;
  localStorage.setItem('fh_people', JSON.stringify(people));
  renderPeopleConfig();
  renderPersonPicker(getSelectedPerson());
}

// Sync people config between localStorage and the sheet:
// - Local exists → back it up (unless a configured sheet would be clobbered
//   by an unconfigured device — then restore the sheet instead)
// - Local missing → restore from the sheet (survives device wipes)
async function syncPeopleConfig() {
  if (!isSignedIn()) return false;

  try {
    const localRaw = localStorage.getItem('fh_people');
    const remote = await loadPeopleConfigFromSheet();

    if (localRaw) {
      const local = JSON.parse(localRaw);
      // A device that never filled in emails shouldn't overwrite a seeded sheet
      if (remote && isBlankConfig(local) && !isBlankConfig(remote)) {
        applyPeopleConfig(remote);
        return true;
      }
      await savePeopleConfigToSheet();
      return true;
    }

    if (remote) {
      applyPeopleConfig(remote);
      return true;
    }
  } catch (e) {
    console.error('Config sync error:', e);
  }
  return false;
}
