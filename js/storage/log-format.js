// log-format.js — Event log format for the append-only per-member monthly files.
//
// Each member has their own log, chunked monthly: `mom-2026-09.jsonl`.
// One JSON event per line: {"id":"ev_…","ts":1725800000123,"author":"mom","type":"note.upsert","payload":{…}}
// Appends stay cheap (~50 KB/month); conflict copies are absorbed on read.
//
// Pure module — no I/O, unit-testable.

// Generate a unique event id (no crypto dependency needed)
export function generateId() {
  return 'ev_' + Date.now().toString(36) + Math.random().toString(36).substring(2, 10);
}

// Canonical file name for a member's log covering the given Date
export function logFileName(memberKey, date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  return `${memberKey}-${y}-${m}.jsonl`;
}

// Regex matching a member's canonical file AND any conflict copies
// Google Drive writes "file (1)" style copies on concurrent updates.
// Copies are absorbed inputs — never written to.
export function logFileRegex(memberKey) {
  const esc = memberKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${esc}(\\s\\(\\d+\\))?-\\d{4}-\\d{2}\\.jsonl$`);
}

// Event types and their payload shape (single source of truth)
export const EVENT_TYPES = Object.freeze({
  NOTE_UPSERT: 'note.upsert',
  NOTE_TOMBSTONE: 'note.tombstone',
  CHORE_UPSERT: 'chore.upsert',
  CHORE_TOMBSTONE: 'chore.tombstone',
  POLL_CREATED: 'poll.created',
  POLL_CLOSED: 'poll.closed',
  VOTE_CAST: 'vote.cast',
  CONFIG_UPSERT: 'config.upsert',
  MEMBER_JOINED: 'member.joined',
});

// Required payload fields per event type (used for validation)
const PAYLOAD_FIELDS = {
  [EVENT_TYPES.NOTE_UPSERT]: ['noteId', 'text'],
  [EVENT_TYPES.NOTE_TOMBSTONE]: ['noteId'],
  [EVENT_TYPES.CHORE_UPSERT]: ['choreId', 'title'],
  [EVENT_TYPES.CHORE_TOMBSTONE]: ['choreId'],
  [EVENT_TYPES.POLL_CREATED]: ['pollId', 'title', 'kind', 'options'],
  [EVENT_TYPES.POLL_CLOSED]: ['pollId'],
  [EVENT_TYPES.VOTE_CAST]: ['pollId', 'optionId'],
  [EVENT_TYPES.CONFIG_UPSERT]: ['key', 'value'],
  [EVENT_TYPES.MEMBER_JOINED]: ['key', 'name', 'email'],
};

// Build a complete event. ts defaults to now, but callers pass an explicit
// clock (js/testing/clock.js) so tests can drive time.
export function makeEvent(type, author, payload, { now = Date.now() } = {}) {
  if (!PAYLOAD_FIELDS[type]) throw new Error(`Unknown event type: ${type}`);
  for (const field of PAYLOAD_FIELDS[type]) {
    if (payload == null || !(field in payload)) {
      throw new Error(`${type} is missing payload field "${field}"`);
    }
  }
  return { id: generateId(), ts: now, author, type, payload };
}

// Validate an unknown object against the log format.
// Returns {ok:true, event} or {ok:false, reason}
export function validateEvent(obj) {
  if (!obj || typeof obj !== 'object') return { ok: false, reason: 'not an object' };
  if (typeof obj.id !== 'string' || obj.id.length < 3) return { ok: false, reason: 'bad id' };
  if (typeof obj.ts !== 'number' || !Number.isFinite(obj.ts)) return { ok: false, reason: 'bad ts' };
  if (typeof obj.author !== 'string' || !obj.author) return { ok: false, reason: 'bad author' };
  const fields = PAYLOAD_FIELDS[obj.type];
  if (!fields) return { ok: false, reason: `unknown type ${obj.type}` };
  if (!obj.payload || typeof obj.payload !== 'object') return { ok: false, reason: 'bad payload' };
  for (const field of fields) {
    if (!(field in obj.payload)) return { ok: false, reason: `missing ${field}` };
  }
  return { ok: true, event: obj };
}

// Serialize one event to a single JSON line (no trailing newline)
export function serializeEvent(event) {
  return JSON.stringify(event);
}

// Parse one line of a log. Returns null for malformed lines — merge skips
// them but counts them as errors; a corrupted line must never abort a sync.
export function parseLogLine(line) {
  if (!line || !line.trim()) return null;
  try {
    const obj = JSON.parse(line);
    const result = validateEvent(obj);
    return result.ok ? result.event : null;
  } catch {
    return null;
  }
}

// Parse a whole file's text into events + malformed-line count
export function parseLogFile(text) {
  const events = [];
  let malformed = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const ev = parseLogLine(line);
    if (ev) events.push(ev);
    else malformed++;
  }
  return { events, malformed };
}

// Merge key for an event (see merge.js — same rules)
export function mergeKey(event) {
  switch (event.type) {
    case EVENT_TYPES.NOTE_UPSERT:
    case EVENT_TYPES.NOTE_TOMBSTONE:
      return `note:${event.payload.noteId}`;
    case EVENT_TYPES.CHORE_UPSERT:
    case EVENT_TYPES.CHORE_TOMBSTONE:
      return `chore:${event.payload.choreId}`;
    case EVENT_TYPES.POLL_CREATED:
      return `poll:${event.payload.pollId}`;
    // Close gets its own sub-key so a later close can never LWW-replace the
    // poll definition itself (title/options). Deviates from the plan table,
    // which listed `poll:<id>` for both — that would have discarded the poll.
    case EVENT_TYPES.POLL_CLOSED:
      return `poll:closed:${event.payload.pollId}`;
    case EVENT_TYPES.VOTE_CAST:
      return `vote:${event.payload.pollId}:${event.author}`;
    case EVENT_TYPES.CONFIG_UPSERT:
      return `config:${event.payload.key}`;
    case EVENT_TYPES.MEMBER_JOINED:
      return `member:${event.payload.key}`;
    default:
      return null;
  }
}
