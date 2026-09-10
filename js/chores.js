// chores.js — Chores as events over the log.

import { EVENT_TYPES } from './storage/log-format.js';

export function generateId() {
  return 'c' + Date.now().toString(36) + Math.random().toString(36).substring(2, 8);
}

// payload: {choreId, title, assignee, dueDate, done}
export async function addChore(engine, { title, assignee = '', dueDate = '' }) {
  return engine.mutate(EVENT_TYPES.CHORE_UPSERT, {
    choreId: generateId(),
    title,
    assignee,
    dueDate,
    done: false,
  });
}

export async function updateChore(engine, chore) {
  return engine.mutate(EVENT_TYPES.CHORE_UPSERT, { ...chore });
}

export async function toggleChore(engine, chore) {
  return engine.mutate(EVENT_TYPES.CHORE_UPSERT, { ...chore, done: !chore.done });
}

export async function deleteChore(engine, choreId) {
  return engine.mutate(EVENT_TYPES.CHORE_TOMBSTONE, { choreId });
}

export function sortedChores(choresMap) {
  return [...choresMap.values()].sort((a, b) => {
    if (a.done !== b.done) return a.done ? 1 : -1;
    return (a.dueDate ?? '').localeCompare(b.dueDate ?? '');
  });
}
