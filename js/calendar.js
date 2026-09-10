// calendar.js — Google Calendar REST wrapper (ESM).
// All requests go through fetchWithAuth: one refresh on 401, single retry,
// no unbounded recursion. Calendar mutations carry a clientKey so offline
// replays can check-before-create and never double-post.

import { fetchWithAuth } from './auth/token.js';
import { clock } from './testing/clock.js';

const CALENDAR_API = 'https://www.googleapis.com/calendar/v3';
const CLIENT_KEY_PROP = 'familyHubClientKey';

// Auto-discover shared calendars (accessRole kept for the UI)
export async function discoverCalendars() {
  const url = `${CALENDAR_API}/users/me/calendarList`;
  const resp = await fetchWithAuth(url);
  if (!resp.ok) throw new Error(`Calendar list failed (${resp.status})`);
  const data = await resp.json();

  const calendars = {};
  for (const entry of (data.items || [])) {
    calendars[entry.id] = { id: entry.id, summary: entry.summary, accessRole: entry.accessRole };
  }
  return calendars;
}

// Fetch all configured calendars and return merged, normalized events.
// `calendars`: [{calendarId, name, color}] — comes from merged config.
export async function fetchCalendarEvents(calendars, { days = 7, now = new Date(clock.now()) } = {}) {
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const endOfDay = new Date(startOfDay.getTime() + days * 24 * 60 * 60 * 1000);
  const timeMin = startOfDay.toISOString();
  const timeMax = endOfDay.toISOString();

  const allEvents = [];
  for (const person of calendars) {
    if (!person.calendarId) continue;
    const url = new URL(`${CALENDAR_API}/calendars/${encodeURIComponent(person.calendarId)}/events`);
    url.searchParams.set('timeMin', timeMin);
    url.searchParams.set('timeMax', timeMax);
    url.searchParams.set('singleEvents', 'true');
    url.searchParams.set('orderBy', 'startTime');
    url.searchParams.set('maxResults', '50');

    const resp = await fetchWithAuth(url);
    if (!resp.ok) {
      console.error(`Calendar fetch failed for ${person.name}:`, resp.status);
      continue;
    }
    const data = await resp.json();
    for (const ev of (data.items || [])) allEvents.push(normalizeEvent(ev, person));
  }

  allEvents.sort((a, b) => {
    const dateA = a.date || '';
    const dateB = b.date || '';
    if (dateA !== dateB) return dateA.localeCompare(dateB);
    if (a.allDay && !b.allDay) return -1;
    if (!a.allDay && b.allDay) return 1;
    return (a.startTime || a.date).localeCompare(b.startTime || b.date);
  });
  return allEvents;
}

// Normalize a Google Calendar event into our simplified format
export function normalizeEvent(ev, person) {
  const allDay = !!ev.start?.date;
  return {
    id: ev.id,
    calendarId: person.calendarId,
    personName: person.name,
    personColor: person.color,
    title: ev.summary || '(untitled)',
    date: ev.start?.date || ev.start?.dateTime?.split('T')[0] || '',
    startTime: allDay ? null : ev.start?.dateTime ?? null,
    endTime: allDay ? null : ev.end?.dateTime ?? null,
    allDay,
    location: ev.location || '',
    description: ev.description || '',
    link: ev.htmlLink || '',
    status: ev.status,
    recurringEventId: ev.recurringEventId || null,
    // Set on events created from Family Hub — enables delete/dupe-guard
    clientKey: ev.extendedProperties?.shared?.[CLIENT_KEY_PROP] ?? null,
  };
}

function eventBody({ title, date, startTime, endTime, allDay, location, description, clientKey }) {
  let start, end;
  if (allDay) {
    start = { date };
    const nextDay = new Date(date);
    nextDay.setDate(nextDay.getDate() + 1);
    end = { date: nextDay.toISOString().split('T')[0] };
  } else {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    start = { dateTime: `${date}T${startTime || '00:00'}:00`, timeZone: tz };
    end = { dateTime: `${date}T${endTime || '23:59'}:00`, timeZone: tz };
  }
  return {
    summary: title,
    start,
    end,
    location: location || undefined,
    description: description || undefined,
    extendedProperties: clientKey
      ? { shared: { [CLIENT_KEY_PROP]: clientKey } }
      : undefined,
  };
}

// Check-before-create: did a previous attempt with this clientKey already
// land? (offline replay idempotency). Events store the key in SHARED
// extendedProperties — the query must use the matching parameter.
export async function findEventByClientKey(calendarId, clientKey) {
  const url = new URL(`${CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events`);
  url.searchParams.set('sharedExtendedProperty', `${CLIENT_KEY_PROP}=${clientKey}`);
  url.searchParams.set('maxResults', '1');
  const resp = await fetchWithAuth(url);
  if (!resp.ok) throw new Error(`Event lookup failed (${resp.status})`);
  return (await resp.json()).items?.[0] ?? null;
}

export async function createEvent({ calendarId, clientKey, ...fields }) {
  if (clientKey) {
    const existing = await findEventByClientKey(calendarId, clientKey).catch(() => null);
    if (existing) return existing; // already created — replay is a no-op
  }
  const url = `${CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events`;
  const resp = await fetchWithAuth(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(eventBody({ ...fields, clientKey })),
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(err.error?.message || `Failed to create event (${resp.status})`);
  }
  return resp.json();
}

export async function updateEvent(calendarId, eventId, updates) {
  const url = `${CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events/${eventId}`;
  const resp = await fetchWithAuth(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updates),
  });
  if (!resp.ok) throw new Error(`Failed to update event (${resp.status})`);
  return resp.json();
}

export async function deleteEvent(calendarId, eventId) {
  const url = `${CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events/${eventId}`;
  const resp = await fetchWithAuth(url, { method: 'DELETE' });
  if (!resp.ok) throw new Error(`Failed to delete event (${resp.status})`);
}

// Format time for display ("5 PM", "5:30 PM")
export function formatTime(isoString) {
  if (!isoString) return '';
  const d = new Date(isoString);
  let h = d.getHours();
  const m = d.getMinutes();
  const ampm = h >= 12 ? 'PM' : 'AM';
  if (h === 0) h = 12;
  if (h > 12) h -= 12;
  return m === 0 ? `${h} ${ampm}` : `${h}:${String(m).padStart(2, '0')} ${ampm}`;
}
