// config.js — People, calendars, and app defaults
// Edit these or configure via the Settings UI

const CONFIG = {
  // OAuth client ID from Google Cloud Console (Web application, PKCE)
  clientId: '251957454378-5sp17im5fa0d8vu5c13h4dsg32gdk6b3.apps.googleusercontent.com',

  // Google Sheets spreadsheet ID for notes (from the sheet URL)
  // Replace with your real sheet ID after creating the notes sheet
  notesSheetId: '1PWanUi3v_o9cK6q7RjvTlFKP-O3ncKJr9JRjZ__BfGc',

  // People and their calendars
  // calendarId: the Google Calendar ID (usually their email, or the
  //   calendar-scoped email like "xxx@group.calendar.google.com")
  // color: the accent color for this person in combined view
  // default: this person is shown in "My Day" by default on this device
  people: [
    { name: 'Mike',    calendarId: 'primary',                          color: '#7c5cfc', default: true },
    { name: 'Charlie', calendarId: 'charles.amadeus.clark@gmail.com',  color: '#5cc9fc', default: false },
    { name: 'Avery',   calendarId: 'agranney@gmail.com',               color: '#fcd45c', default: false },
  ],

  // Refresh interval in milliseconds (5 min)
  refreshInterval: 5 * 60 * 1000,

  // Default tab on load
  defaultTab: 'myday',
};

// Notes categories (editable in settings)
const NOTE_CATEGORIES = ['General', 'Shopping', 'Medical', 'School', 'Chores', 'Work'];
