# Family Hub — Shared Calendar & Notes PWA

A free, no-server Progressive Web App that syncs family calendars and notes through Google's APIs.

**One codebase. Works on Android (Add to Home Screen) and Windows/Mac desktop.**

## How It Works (No Server)

```
Your Google account ─── Google Calendar API ─── All shared calendars
                    └── Google Sheets API  ─── Shared notes database
```

Every device signs in with ONE Google account (yours). Other family members' calendars are shared into your account. Notes live in a shared Google Sheet.

**Zero infrastructure:** No VPS, no database, no Docker, no monthly bill.

## Setup (10 min, one-time)

### 1. Google Cloud Project
1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a project → Enable **Calendar API** and **Sheets API**
3. OAuth consent screen → "Web application" → Add `https://<your-username>.github.io/family-hub/` as authorized redirect URI
4. Create OAuth client ID → Web application → copy the Client ID

### 2. Calendars
1. Each person shares their Google Calendar with your account ("See all event details" + "Make changes to events")
2. Note each calendar ID (usually their email)

### 3. Notes Sheet
1. Create a Google Sheet with these headers in row 1:
   `id | author | date | time | importance | color | category | note | created_at | updated_at | status`
2. Name the first tab `Notes`
3. Copy the sheet ID from the URL

### 4. Configure the App
1. Open the app → Settings gear
2. Enter your OAuth client ID
3. Enter each person's name, calendar ID, and color
4. Enter the Sheets ID
5. Sign in with Google (one-time per device)

## Install on Devices

- **Android:** Open in Chrome → menu → "Add to Home Screen"
- **Windows/Mac:** Open in Chrome/Edge → address bar install icon → "Install"
- Updates auto-deploy when you push to GitHub

## Project Structure

```
family-hub/
├── index.html          # The entire app (SPA)
├── manifest.json       # PWA manifest
├── sw.js               # Service Worker (offline)
├── css/app.css         # All styles (mobile-first, dark mode)
├── js/
│   ├── config.js       # People, colors, calendars
│   ├── app.js          # Entry point, lifecycle, event wiring
│   ├── auth.js         # Google OAuth PKCE flow
│   ├── calendar.js     # Calendar API wrapper
│   ├── notes.js        # Sheets API wrapper
│   ├── cache.js        # IndexedDB cache layer
│   └── ui.js           # DOM rendering
└── icons/              # PWA icons
```

## Features

- 📅 **My Day** — one person's agenda, pick who to view
- 👥 **Everyone** — combined calendar, color-coded by person
- ➕ **Add Events** — directly from the app, no google.com needed
- 📋 **Notes** — structured notes with date, time, importance, categories
- 🌙 **Dark mode** — default, with light mode toggle
- 📱 **Mobile-first** — works great on phones and desktop
- 🔌 **Offline** — cached data via IndexedDB, offline write queue
- 🔄 **Auto-sync** — refreshes every 5 minutes

## Free Tier Limits (ample for family use)

- Calendar API: 1,000,000 requests/day (you'll use ~500)
- Sheets API: 60 requests/minute (you'll use ~4)
- GitHub Pages: unlimited bandwidth for small sites
