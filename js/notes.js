// notes.js — Google Sheets API wrapper for structured notes
// Schema: id | author | date | time | importance | color | category | note | created_at | updated_at | status | _row

const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets';

// Read all notes from the configured sheet
async function fetchNotes() {
  const token = getAccessToken();
  const sheetId = loadSetting('notesSheetId') || CONFIG.notesSheetId;
  if (!token || !sheetId) return [];

  const range = 'Notes!A2:L'; // Skip header row
  const url = `${SHEETS_API}/${sheetId}/values/${encodeURIComponent(range)}`;

  try {
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!resp.ok) {
      if (resp.status === 401) {
        const refreshed = await refreshToken();
        if (refreshed) return fetchNotes();
      }
      console.error('Sheets fetch failed:', resp.status);
      return [];
    }
    const data = await resp.json();
    const rows = data.values || [];
    return rows.map((row, i) => ({
      id:          row[0]  || '',
      author:      row[1]  || '',
      date:        row[2]  || '',
      time:        row[3]  || '',
      importance:  row[4]  || 'medium',
      color:       row[5]  || '',
      category:    row[6]  || 'General',
      note:        row[7]  || '',
      createdAt:   row[8]  || '',
      updatedAt:   row[9]  || '',
      status:      row[10] || 'active',
      rowIndex:    i + 2, // Row number in sheet (1-indexed, +1 for header)
    }));
  } catch (e) {
    console.error('Sheets fetch error:', e);
    return [];
  }
}

// Append a new note row
async function addNote(noteData) {
  const token = getAccessToken();
  const sheetId = loadSetting('notesSheetId') || CONFIG.notesSheetId;
  if (!token || !sheetId) throw new Error('Not signed in or no sheet configured');

  const now = new Date().toISOString();
  const row = [
    noteData.id,
    noteData.author,
    noteData.date,
    noteData.time || '',
    noteData.importance || 'medium',
    noteData.color || CONFIG.people.find(p => p.name === noteData.author)?.color || '#7c5cfc',
    noteData.category || 'General',
    noteData.note,
    noteData.createdAt || now,
    noteData.updatedAt || now,
    noteData.status || 'active',
  ];

  const range = 'Notes!A2:L2';
  const url = `${SHEETS_API}/${sheetId}/values/${encodeURIComponent(range)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`;

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ values: [row] }),
  });

  if (!resp.ok) throw new Error(`Failed to add note (${resp.status})`);
  return resp.json();
}

// Update a specific row (for edits and status changes)
async function updateNoteRow(rowIndex, values) {
  const token = getAccessToken();
  const sheetId = loadSetting('notesSheetId') || CONFIG.notesSheetId;
  if (!token || !sheetId) throw new Error('Not signed in or no sheet configured');

  const range = `Notes!A${rowIndex}:L${rowIndex}`;
  const url = `${SHEETS_API}/${sheetId}/values/${encodeURIComponent(range)}?valueInputOption=RAW`;

  const resp = await fetch(url, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ values: [values] }),
  });

  if (!resp.ok) throw new Error(`Failed to update note (${resp.status})`);
  return resp.json();
}

// Generate a simple UUID (no crypto dependency needed for note IDs)
function generateId() {
  return 'n' + Date.now().toString(36) + Math.random().toString(36).substring(2, 8);
}

// Helper: load from localStorage with fallback to CONFIG
function loadSetting(key) {
  try {
    const val = localStorage.getItem(`fh_${key}`);
    if (val) return val;
  } catch (e) { /* */ }
  return CONFIG[key] || null;
}
