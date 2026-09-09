// notes.js — Notes as events over the log (replaces the Sheets DB).
// Every mutation is local-first: the sync engine merges + flushes.

import { EVENT_TYPES } from './storage/log-format.js';

export const NOTE_CATEGORIES = ['General', 'Shopping', 'Medical', 'School', 'Chores', 'Work'];

export function generateId() {
  return 'n' + Date.now().toString(36) + Math.random().toString(36).substring(2, 8);
}

// Notes live in engine.view.notes: Map<noteId, payload>
// payload: {noteId, text, importance, category, date, time, done}

export async function addNote(engine, { text, importance = 'normal', category = 'General', date = '', time = '', done = false, pinned = false }) {
  return engine.mutate(EVENT_TYPES.NOTE_UPSERT, {
    noteId: generateId(),
    text,
    importance,
    category,
    date,
    time,
    done,
    pinned,
  });
}

export async function updateNote(engine, note) {
  return engine.mutate(EVENT_TYPES.NOTE_UPSERT, { ...note });
}

export async function deleteNote(engine, noteId) {
  return engine.mutate(EVENT_TYPES.NOTE_TOMBSTONE, { noteId });
}

// Sort view-model notes for display: done sinks, then importance rank,
// then newest first (payloads are enriched with ts by merge)
export function sortedNotes(notesMap) {
  return [...notesMap.values()].sort((a, b) => {
    if (a.done !== b.done) return a.done ? 1 : -1;
    const rank = { high: 0, normal: 1, low: 2 };
    const imp = (rank[a.importance ?? 'normal'] ?? 1) - (rank[b.importance ?? 'normal'] ?? 1);
    if (imp) return imp;
    return (b.ts ?? 0) - (a.ts ?? 0);
  });
}
