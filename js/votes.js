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

// Time-of-day meal awareness: the "What's for dinner?" card becomes
// breakfast/lunch/dinner depending on the hour. Each meal gets its own
// poll for the day, so breakfast and dinner can coexist.
export function mealOfDay(now = clock.now()) {
  const h = new Date(now).getHours();
  if (h < 10) return 'breakfast';
  if (h < 15) return 'lunch';
  return 'dinner';
}

export const MEAL_LABELS = {
  breakfast: "What's for breakfast?",
  lunch: "What's for lunch?",
  dinner: "What's for dinner?",
};

export const MEAL_EMOJIS = { breakfast: '🍳', lunch: '🥪', dinner: '🍽️' };

export function defaultMealClosesAt(meal = mealOfDay()) {
  const d = new Date(clock.now());
  const hour = meal === 'breakfast' ? 10 : meal === 'lunch' ? 15 : 17;
  d.setHours(hour, 0, 0, 0);
  return d.toISOString();
}

export function defaultDinnerClosesAt() {
  return defaultMealClosesAt('dinner');
}

// Start a poll. kind: 'general' | 'dinner'. Extra fields (like `meal`)
// ride along in the payload — they're what mealPollForNow filters on.
export async function createPoll(engine, { title, kind = 'general', date = '', options, closesAt, author, ...extra }) {
  return engine.mutate(EVENT_TYPES.POLL_CREATED, {
    pollId: generateId(),
    title,
    kind,
    date,
    options: options.map((label, i) => ({ id: `o${i + 1}`, label })),
    closesAt: closesAt ?? null,
    ...extra,
  }, { author });
}

// The one-tap meal poll for right now (breakfast/lunch/dinner by the hour)
export async function startMealPoll(engine, { author, meal = mealOfDay() } = {}) {
  return createPoll(engine, {
    title: MEAL_LABELS[meal] ?? MEAL_LABELS.dinner,
    kind: 'dinner',
    meal,
    date: todayKey(),
    options: [...DINNER_OPTIONS, 'Eating out'],
    closesAt: defaultMealClosesAt(meal),
    author,
  });
}

export async function startDinnerPoll(engine, { author } = {}) {
  return startMealPoll(engine, { author, meal: 'dinner' });
}

// Re-voting the same option with a note updates it (same merge key —
// vote:<pollId>:<author>). A note answers "Cook at home — WHAT are we
// cooking?" / "Takeout — from where?".
export async function castVote(engine, pollId, optionId, author, note = '') {
  return engine.mutate(EVENT_TYPES.VOTE_CAST, { pollId, optionId, note }, { author });
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

// The open meal poll for THIS moment (right meal, today, still open)
export function mealPollForNow(view, now = clock.now()) {
  const today = todayKey();
  const meal = mealOfDay(now);
  for (const { poll, tallies, votes, closedWinner } of view?.polls?.values() ?? []) {
    if (poll.kind !== 'dinner') continue;
    if (poll.date && poll.date !== today) continue;
    if ((poll.meal ?? 'dinner') !== meal) continue; // old polls default to dinner
    if (closedWinner !== undefined) continue;
    if (isPollOpen(poll, now)) return { poll, tallies, votes };
  }
  return null;
}

export function dinnerPollForToday(view, now = clock.now()) {
  return mealPollForNow(view, now);
}

// Leading option(s) by tally. Returns [] on a zero-vote poll or a tie.
export function leadingOptions(poll, tallies) {
  const counts = (poll.options ?? []).map((o) => tallies.get(o.id) ?? 0);
  const max = Math.max(0, ...counts);
  if (max === 0) return [];
  const leaders = (poll.options ?? []).filter((o) => (tallies.get(o.id) ?? 0) === max);
  return leaders;
}
