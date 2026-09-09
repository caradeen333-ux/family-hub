// votes.js — In-app polls on the event log.
//
// Events: poll.created / vote.cast / poll.closed (re-vote = a second cast,
// LWW per (pollId, author) in merge). closesAt is a pure display rule —
// auto-close never writes an event, so there is no close-event race.
// Recurring "dinner poll" is client-side: no open dinner poll for today →
// show the one-tap create card.

import { EVENT_TYPES } from './storage/log-format.js';
import { clock } from './testing/clock.js';

export function generateId() {
  return 'p' + Date.now().toString(36) + Math.random().toString(36).substring(2, 8);
}

export const DINNER_OPTIONS = ['Cook at home', 'Takeout', 'Leftovers'];

export function defaultDinnerClosesAt() {
  const d = new Date(clock.now());
  d.setHours(17, 0, 0, 0);
  return d.toISOString();
}

// Start a poll. kind: 'general' | 'dinner'
export async function createPoll(engine, { title, kind = 'general', date = '', options, closesAt, author }) {
  return engine.mutate(EVENT_TYPES.POLL_CREATED, {
    pollId: generateId(),
    title,
    kind,
    date,
    options: options.map((label, i) => ({ id: `o${i + 1}`, label })),
    closesAt: closesAt ?? null,
  }, { author });
}

// The one-tap "What's for dinner?" poll for today
export async function startDinnerPoll(engine, { author } = {}) {
  return createPoll(engine, {
    title: "What's for dinner?",
    kind: 'dinner',
    date: todayKey(),
    options: [...DINNER_OPTIONS, 'Eating out'],
    closesAt: defaultDinnerClosesAt(),
    author,
  });
}

export async function castVote(engine, pollId, optionId, author) {
  return engine.mutate(EVENT_TYPES.VOTE_CAST, { pollId, optionId }, { author });
}

// Creator-close only at the UI layer; merge accepts any poll.closed for robustness
export async function closePoll(engine, pollId, winner) {
  return engine.mutate(EVENT_TYPES.POLL_CLOSED, { pollId, winner: winner ?? null });
}

// ---- display rules ----

export function todayKey() {
  const d = new Date(clock.now());
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Is a poll still accepting votes? (pure display rule)
export function isPollOpen(poll, now = clock.now()) {
  if (!poll.closesAt) return true;
  return now < new Date(poll.closesAt).getTime();
}

// The open dinner poll for today, if any
export function dinnerPollForToday(view, now = clock.now()) {
  const today = todayKey();
  for (const { poll, tallies, votes, closedWinner } of view?.polls?.values() ?? []) {
    if (poll.kind !== 'dinner') continue;
    if (poll.date && poll.date !== today) continue;
    if (closedWinner !== undefined) continue;
    if (isPollOpen(poll, now)) return { poll, tallies, votes };
  }
  return null;
}

// Leading option(s) by tally. Returns [] on a zero-vote poll or a tie.
export function leadingOptions(poll, tallies) {
  const counts = (poll.options ?? []).map((o) => tallies.get(o.id) ?? 0);
  const max = Math.max(0, ...counts);
  if (max === 0) return [];
  const leaders = (poll.options ?? []).filter((o) => (tallies.get(o.id) ?? 0) === max);
  return leaders;
}
