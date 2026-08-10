// calendar.js — Google Calendar API wrapper
// Fetch, cache, create events. All via REST (no gapi library needed).

const CALENDAR_API = 'https://www.googleapis.com/calendar/v3';

// Auto-discover shared calendars on first sign-in
// Returns a map of calendar summary/email → calendarId
async function discoverCalendars() {
  const token = getAccessToken();
  if (!token) throw new Error('Not signed in');

  const url = `${CALENDAR_API}/users/me/calendarList`;
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!resp.ok) throw new Error(`Calendar list failed (${resp.status})`);
  const data = await resp.json();

  const calendars = {};
  for (const entry of (data.items || [])) {
    const id = entry.id;
    // Key by email, summary, and id for flexible matching
    calendars[id] = { id, summary: entry.summary, accessRole: entry.accessRole };
    if (entry.id.includes('@')) calendars[entry.id.toLowerCase()] = { id, summary: entry.summary, accessRole: entry.accessRole };
  }

  return calendars;
}

// Fetch all configured calendars and return merged, normalized events
// Default: today + 6 days = a full week view
async function fetchTodayEvents(days = 7) {
  const token = getAccessToken();
  if (!token) throw new Error('Not signed in');

  // Window: start of today → end of day N days from now
  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const endOfDay   = new Date(startOfDay.getTime() + days * 24 * 60 * 60 * 1000);

  const timeMin = startOfDay.toISOString();
  const timeMax = endOfDay.toISOString();

  const allEvents = [];

  for (const person of CONFIG.people) {
    const calId = person.calendarId;
    if (!calId) continue; // Skip unconfigured

    const url = new URL(`${CALENDAR_API}/calendars/${encodeURIComponent(calId)}/events`);
    url.searchParams.set('timeMin', timeMin);
    url.searchParams.set('timeMax', timeMax);
    url.searchParams.set('singleEvents', 'true');
    url.searchParams.set('orderBy', 'startTime');
    url.searchParams.set('maxResults', '50');

    try {
      const resp = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!resp.ok) {
        if (resp.status === 401) {
          // Token expired — try refresh
          const refreshed = await refreshToken();
          if (refreshed) return fetchTodayEvents(); // Retry with new token
        }
        console.error(`Calendar fetch failed for ${person.name}:`, resp.status);
        continue;
      }
      const data = await resp.json();
      for (const ev of (data.items || [])) {
        allEvents.push(normalizeEvent(ev, person));
      }
    } catch (e) {
      console.error(`Calendar fetch error for ${person.name}:`, e);
    }
  }

  // Sort by start time (all-day first, then timed)
  allEvents.sort((a, b) => {
    if (a.allDay && !b.allDay) return -1;
    if (!a.allDay && b.allDay) return 1;
    const sa = a.startTime || a.date;
    const sb = b.startTime || b.date;
    return sa.localeCompare(sb);
  });

  return allEvents;
}

// Normalize a Google Calendar event into our simplified format
function normalizeEvent(ev, person) {
  const allDay = !!ev.start.date; // all-day events use .date not .dateTime
  return {
    id: ev.id,
    calendarId: person.calendarId,
    personName: person.name,
    personColor: person.color,
    title: ev.summary || '(untitled)',
    date: ev.start.date || ev.start.dateTime?.split('T')[0],
    startTime: allDay ? null : (ev.start.dateTime || null),
    endTime: allDay ? null : (ev.end.dateTime || null),
    allDay,
    location: ev.location || '',
    description: ev.description || '',
    link: ev.htmlLink || '',
    status: ev.status, // 'confirmed', 'tentative', 'cancelled'
    recurringEventId: ev.recurringEventId || null,
  };
}

// Create an event via the Calendar API
async function createEvent({ calendarId, title, date, startTime, endTime, allDay, location, description }) {
  const token = getAccessToken();
  if (!token) throw new Error('Not signed in');

  let start, end;
  if (allDay) {
    start = { date };
    const nextDay = new Date(date);
    nextDay.setDate(nextDay.getDate() + 1);
    end = { date: nextDay.toISOString().split('T')[0] };
  } else {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    start = { dateTime: `${date}T${startTime || '00:00'}:00`, timeZone: tz };
    end   = { dateTime: `${date}T${endTime || '23:59'}:00`, timeZone: tz };
  }

  const resource = {
    summary: title,
    start,
    end,
    location: location || undefined,
    description: description || undefined,
  };

  const url = `${CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(resource),
  });

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(err.error?.message || `Failed to create event (${resp.status})`);
  }

  return resp.json();
}

// Edit an existing event
async function updateEvent(calendarId, eventId, updates) {
  const token = getAccessToken();
  if (!token) throw new Error('Not signed in');

  const url = `${CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events/${eventId}`;
  const resp = await fetch(url, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(updates),
  });
  if (!resp.ok) throw new Error(`Failed to update event (${resp.status})`);
  return resp.json();
}

// Delete an event
async function deleteEvent(calendarId, eventId) {
  const token = getAccessToken();
  if (!token) throw new Error('Not signed in');

  const url = `${CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events/${eventId}`;
  const resp = await fetch(url, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
  if (!resp.ok) throw new Error(`Failed to delete event (${resp.status})`);
}

// Format time for display
function formatTime(isoString) {
  if (!isoString) return '';
  const d = new Date(isoString);
  let h = d.getHours();
  const m = d.getMinutes();
  const ampm = h >= 12 ? 'PM' : 'AM';
  if (h === 0) h = 12;
  if (h > 12) h -= 12;
  return m === 0 ? `${h} ${ampm}` : `${h}:${String(m).padStart(2, '0')} ${ampm}`;
}
