// merge.js — Pure merge engine: event logs → view-model state.
//
// Rules (from the rebuild plan):
//  - Malformed lines are skipped (counted as errors, never abort).
//  - Dedupe by event id — offline replay duplicates become harmless.
//  - Last-write-wins by ts; tie-break (author, id) lexicographic so every
//    device computes a byte-identical result.
//  - Tombstones remove entities.
//  - ts > now + 24h is clamped (defensive guard against bad device clocks).
//  - Polls tallied per option; re-vote = new cast event (LWW per member).
//
// Pure: no I/O, no Date.now() — callers pass `now`.

import { mergeKey } from './log-format.js';

const FUTURE_CLAMP_MS = 24 * 60 * 60 * 1000;

// Dedupe + order + clamp a flat event list into (id → winning event) pairs.
// Returns { winners: Map<eventId, event>, dropped: number }
export function reduceEvents(events, { now }) {
  const winners = new Map();
  let dropped = 0;

  for (const raw of events) {
    // Clamp impossible future timestamps — a device clock set 3 days ahead
    // must not permanently win every merge.
    const ev =
      raw.ts > now + FUTURE_CLAMP_MS ? { ...raw, ts: now + FUTURE_CLAMP_MS } : raw;

    const existing = winners.get(ev.id);
    if (existing) {
      // Same id twice (offline replay, conflict copy) — identical event, keep one.
      if (existing.ts === ev.ts && existing.author === ev.author) {
        dropped++;
        continue;
      }
      // Same id, different content: still LWW on the event itself
      if (isNewerThan(ev, existing)) winners.set(ev.id, ev);
      else dropped++;
      continue;
    }
    winners.set(ev.id, ev);
  }
  return { winners, dropped };
}

// Strict LWW: higher ts wins; equal ts → lexicographic (author, id)
export function isNewerThan(a, b) {
  if (a.ts !== b.ts) return a.ts > b.ts;
  if (a.author !== b.author) return a.author > b.author;
  return a.id > b.id;
}

// Build the view-model from a flat event list.
// Returns:
// {
//   notes:        Map<noteId, payload|null>       (null = tombstoned... removed)
//   chores:       Map<choreId, payload>
//   polls:        Map<pollId, {poll, votes: Map<author, optionId>, tallies: Map<optionId, count>}>
//   config:       Map<key, value>
//   members:      Map<memberKey, {key, name, email}>
//   errors:       count of malformed lines encountered upstream
// }
export function buildView(events, { now }) {
  // Per merge-key: winning event (LWW)
  const keyWinners = new Map();

  for (const ev of events) {
    const key = mergeKey(ev);
    if (key == null) continue;
    const existing = keyWinners.get(key);
    if (!existing || isNewerThan(ev, existing)) keyWinners.set(key, ev);
  }

  const notes = new Map();
  const chores = new Map();
  const pollStates = new Map(); // pollId → {poll, votes: Map}
  const pollClosed = new Map(); // pollId → winner (applied after the loop)
  const config = new Map();
  const members = new Map();
  const lists = new Map(); // listId → {listId, name, emoji, author, ts}
  const items = new Map(); // itemId → {itemId, listId, text, qty, done, author, ts}

  for (const ev of keyWinners.values()) {
    switch (ev.type) {
      case 'note.upsert':
        // enrich with the event's author/ts — the UI needs both
        notes.set(ev.payload.noteId, { ...ev.payload, author: ev.author, ts: ev.ts });
        break;
      case 'note.tombstone':
        notes.delete(ev.payload.noteId);
        break;
      case 'chore.upsert':
        chores.set(ev.payload.choreId, { ...ev.payload, author: ev.author, ts: ev.ts });
        break;
      case 'chore.tombstone':
        chores.delete(ev.payload.choreId);
        break;
      case 'poll.created': {
        const votes = pollStates.get(ev.payload.pollId)?.votes ?? new Map();
        pollStates.set(ev.payload.pollId, { poll: { ...ev.payload, author: ev.author }, votes });
        break;
      }
      case 'poll.closed':
        // Side map: a close event processed before its poll.created (sync
        // ordering) still applies once the poll exists.
        pollClosed.set(ev.payload.pollId, ev.payload.winner ?? null);
        break;
      case 'vote.cast': {
        const state = pollStates.get(ev.payload.pollId);
        // votes: author → {optionId, note} (note optional, survives re-votes)
        if (state) state.votes.set(ev.author, { optionId: ev.payload.optionId, note: ev.payload.note ?? '' });
        break;
      }
      case 'config.upsert':
        config.set(ev.payload.key, ev.payload.value);
        break;
      case 'member.joined':
        members.set(ev.payload.key, ev.payload);
        break;
      case 'list.upsert':
        lists.set(ev.payload.listId, { ...ev.payload, author: ev.author, ts: ev.ts });
        break;
      case 'list.tombstone':
        lists.delete(ev.payload.listId);
        // items in a deleted list are unreachable anyway — tombstones below
        break;
      case 'item.upsert':
        items.set(ev.payload.itemId, { ...ev.payload, author: ev.author, ts: ev.ts });
        break;
      case 'item.tombstone':
        items.delete(ev.payload.itemId);
        break;
    }
  }

  // Tally votes per option — every option is present (0 when unvoted) so the
  // UI can render bars without special-casing missing entries
  const polls = new Map();
  for (const [pollId, state] of pollStates) {
    const tallies = new Map();
    for (const option of state.poll.options ?? []) tallies.set(option.id, 0);
    for (const vote of state.votes.values()) {
      tallies.set(vote.optionId, (tallies.get(vote.optionId) ?? 0) + 1);
    }
    polls.set(pollId, {
      poll: state.poll,
      votes: state.votes,
      tallies,
      closedWinner: pollClosed.get(pollId) ?? undefined,
    });
  }

  return { notes, chores, polls, config, members, lists, items, now };
}

// Convenience: merge full parsed logs into a view. events are flat arrays of
// {id, ts, author, type, payload} — merge handles dedupe internally.
export function mergeLogs(events, { now }) {
  const { winners } = reduceEvents(events, { now });
  return buildView([...winners.values()], { now });
}

// Did this view produce a tie among the top tally values?
export function isTie(tally, optionIds) {
  const counts = optionIds
    .map((id) => tally.get(id) ?? 0)
    .filter((n) => n > 0)
    .sort((a, b) => b - a);
  return counts.length >= 2 && counts[0] === counts[1];
}
