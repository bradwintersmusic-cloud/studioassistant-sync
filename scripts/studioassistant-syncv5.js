#!/usr/bin/env node
// studioassistant-sync.js
// Fetches session data from StudioAssistant and generates a styled HTML schedule.
// Run: node studioassistant-sync.js
// Requires: STUDIOASSISTANT_API_TOKEN in your .env file

require('dotenv').config();

const fs   = require('fs');
const path = require('path');

// ─── Config ────────────────────────────────────────────────────────────────────

const BASE_URL     = 'https://app.studioassistant.io';
const FACILITY_IDS = [7807, 7808];    // 34MSE, BMRC
const TIMEZONE     = 'America/Chicago';
const OUTPUT_FILE  = path.join(__dirname, '../index.html');

// Date window: pulls sessions starting today (UTC midnight) for the next N days.
// Increase RANGE_DAYS if you want a wider lookahead.
const RANGE_DAYS = 2;

// ─── Helpers ───────────────────────────────────────────────────────────────────

function getDateRange() {
  const now = new Date();
  const dateStr = now.toLocaleDateString('en-CA', { timeZone: TIMEZONE }); // "2026-06-24"

  // Get Chicago's actual UTC offset for today (handles CDT vs CST automatically)
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TIMEZONE,
    timeZoneName: 'shortOffset'
  }).formatToParts(now);
  const offsetStr = parts.find(p => p.type === 'timeZoneName').value; // "GMT-5" or "GMT-6"
  const offsetHours = parseInt(offsetStr.replace('GMT', '')) || -5;
  const offsetFormatted = offsetHours >= 0
    ? `+${String(offsetHours).padStart(2, '0')}:00`
    : `-${String(Math.abs(offsetHours)).padStart(2, '0')}:00`;

  const start = new Date(`${dateStr}T00:00:00${offsetFormatted}`);
  const end = new Date(start);
  end.setDate(end.getDate() + RANGE_DAYS);
  return { start: start.toISOString(), end: end.toISOString() };
}

function formatTime(iso) {
  return new Date(iso).toLocaleTimeString('en-US', {
    timeZone: TIMEZONE,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

function formatDate(iso) {
  return new Date(iso).toLocaleDateString('en-US', {
    timeZone: TIMEZONE,
    weekday: 'short',
    month:   'short',
    day:     'numeric',
  });
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─── API ───────────────────────────────────────────────────────────────────────

async function login() {
  const token = process.env.STUDIOASSISTANT_API_TOKEN;
  if (!token) throw new Error('STUDIOASSISTANT_API_TOKEN is not set in .env');

  const res  = await fetch(`${BASE_URL}/api/auth/api-login`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ apiToken: token }),
  });
  const data = await res.json();
  if (!data.success) throw new Error(`Login failed: ${JSON.stringify(data.message)}`);
  console.log('✓ Authenticated');
  return data.accessToken;
}

async function fetchFacilitySessions(accessToken, facilityId, start, end) {
  const url = `${BASE_URL}/api/studio/${facilityId}/session/calendar?start=${start}&end=${end}`;
  const res  = await fetch(url, {
    headers: { 'Authorization': `Bearer ${accessToken}` },
  });
  const data = await res.json();
  if (!data.success) {
    console.warn(`  ⚠ Facility ${facilityId} returned an error — skipping`);
    return [];
  }
  const sessions = Object.values(data.data?.items ?? {});
  console.log(`  Facility ${facilityId}: ${sessions.length} raw sessions`);
  return sessions;
}

// ─── Data processing ───────────────────────────────────────────────────────────

function processSessions(raw, start, end) {
  return raw
    // Drop anything without a booking (blackouts, placeholders, etc.)
    .filter(s => {
  if (s.type === 'i' && !s.stamp?.contact_name) return false;
  if (new Date(s.start) < new Date(start)) return false;
  if (new Date(s.start) >= new Date(end)) return false;
  return s.stamp?.contact_name || s.stamp?.service === 'Class' || s.snippet;
})
    // Shape each session into what we need
    .map(s => ({
      id:             s.id,
      facility:       s.stamp.studio   ?? 'Unknown Facility',
      studio:         s.stamp.room     ?? 'Unknown Room',
      student:        s.stamp.contact_name || s.snippet || '—',
      start:          s.start,
      end:            s.end,
      dateKey:        new Date(s.start).toLocaleDateString('en-CA', { timeZone: TIMEZONE }),
      sessionType:    s.stamp?.project || s.stamp?.service || '',
      dateLabel:      formatDate(s.start),
      startLabel:     formatTime(s.start),
      endLabel:       formatTime(s.end),
    }))
    // Sort: 1) Facility  2) Studio  3) Start time
    .sort((a, b) => {
      if (a.facility !== b.facility) return a.facility.localeCompare(b.facility);
      if (a.studio   !== b.studio)   return a.studio.localeCompare(b.studio);
      return new Date(a.start) - new Date(b.start);
    });
}

// ─── HTML generation ──────────────────────────────────────────────────────────

function buildHTML(sessions, generatedAt, todayKey, tomorrowKey) {
  // Group: facility → studio → sessions[]
  const byFacility = {};
  for (const s of sessions) {
    if (!byFacility[s.facility]) byFacility[s.facility] = {};
    if (!byFacility[s.facility][s.studio]) byFacility[s.facility][s.studio] = [];
    byFacility[s.facility][s.studio].push(s);
  }

  const facilityHTML = Object.entries(byFacility).map(([facility, studios]) => {
    const studiosHTML = Object.entries(studios).map(([studio, items]) => {
      const rowsHTML = items.map(s => `
            <tr data-date="${s.dateKey}">
              <td class="col-date">${escapeHtml(s.dateLabel)}</td>
              <td class="col-name">${escapeHtml(s.student)}</td>
              <td class="col-type">${escapeHtml(s.sessionType)}</td>
              <td class="col-time">${escapeHtml(s.startLabel)}</td>
              <td class="col-time">${escapeHtml(s.endLabel)}</td>
            </tr>`).join('');

      return `
            <div class="studio-block">
        <div class="studio-header">${escapeHtml(studio)}</div>
        <div class="table-scroll">
        <table>
            <thead>
            <tr>
                <th>Date</th>
                <th>Name</th>
                <th>Type</th>
                <th>Start</th>
                <th>End</th>
            </tr>
            </thead>
            <tbody>${rowsHTML}
            </tbody>
        </table>
        </div>
    </div>`;
    }).join('');

    return `
      <section class="facility-block">
        <div class="facility-header" onclick="toggleFacility(this)" style="cursor:pointer;">
          <span class="dot"></span>${escapeHtml(facility)}
          <span class="toggle-icon">▾</span>
        </div>
        <div class="facility-content">
        ${studiosHTML}
        </div>
      </section>`;
  }).join('');

  const body = sessions.length === 0
    ? '<p class="empty">No sessions found for this date range.</p>'
    : facilityHTML;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Studio Schedule — Belmont AET</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=Inter:wght@300;400;500;600&display=swap" rel="stylesheet">
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    :root {
      --bg:         #0b0b0f;
      --surface:    #13131b;
      --surface2:   #1b1b26;
      --border:     #252533;
      --accent:     #c8a86b;
      --accent-bg:  rgba(200, 168, 107, 0.10);
      --text:       #e6e2d9;
      --muted:      #8f8e9d;
      --blue:       #5b9cf6;
    }

    body {
      background: var(--bg);
      color: var(--text);
      font-family: 'Inter', system-ui, sans-serif;
      font-size: 14px;
      line-height: 1.5;
      padding: 48px 28px 100px;
    }

    /* ── Page header ── */
    .page-header {
      max-width: 920px;
      margin: 0 auto 52px;
      padding-bottom: 28px;
      border-bottom: 1px solid var(--border);
    }

    .wordmark {
      font-family: 'IBM Plex Mono', monospace;
      font-size: 13px;
      letter-spacing: 0.18em;
      text-transform: uppercase;
      color: var(--accent);
      margin-bottom: 14px;
    }

    h1 {
      font-size: 30px;
      font-weight: 600;
      letter-spacing: -0.025em;
      color: var(--text);
      margin-bottom: 6px;
    }

    .meta {
      font-family: 'IBM Plex Mono', monospace;
      font-size: 11px;
      color: var(--muted);
      letter-spacing: 0.04em;
    }

    /* ── Content ── */
    .content { max-width: 920px; margin: 0 auto; }

    /* ── Facility ── */
    .facility-block { margin-bottom: 52px; }

    .facility-header {
      display: flex;
      align-items: center;
      gap: 9px;
      font-family: 'IBM Plex Mono', monospace;
      font-size: 13px;
      font-weight: 500;
      letter-spacing: 0.14em;
      text-transform: uppercase;
      color: var(--accent);
      margin-bottom: 18px;
      user-select: none;
    }

    .toggle-icon {
      margin-left: auto;
      font-size: 12px;
      transition: transform 0.2s;
    }

    .toggle-icon.collapsed {
      transform: rotate(-90deg);
    }

    .dot {
      width: 5px;
      height: 5px;
      border-radius: 50%;
      background: var(--accent);
      flex-shrink: 0;
    }

    /* ── Studio ── */
    .studio-block {
      margin-bottom: 20px;
      border: 1px solid var(--border);
      border-radius: 5px;
      overflow: hidden;
      background: var(--surface);
    }

    .table-scroll {
        overflow-x: auto;
        -webkit-overflow-scrolling: touch;
    }

    .studio-header {
      padding: 9px 16px;
      background: var(--surface2);
      border-bottom: 1px solid var(--border);
      font-family: 'IBM Plex Mono', monospace;
      font-size: 13px;
      font-weight: 600;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--muted);
    }

    .tabs {
        display: flex;
        gap: 8px;
        margin-top: 16px;
    }

    .tab-btn {
        padding: 6px 18px;
        border-radius: 4px;
        border: 1px solid var(--border);
        background: transparent;
        color: var(--muted);
        font-family: 'IBM Plex Mono', monospace;
        font-size: 11px;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        cursor: pointer;
        transition: all 0.15s;
    }

    .tab-btn.active {
        background: var(--accent-bg);
        border-color: var(--accent);
        color: var(--accent);
    }

    .tab-btn:hover:not(.active) {
        border-color: var(--muted);
        color: var(--text);
    }

    /* ── Table ── */
    table {
      width: 100%;
      border-collapse: collapse;
    }

    thead th {
      padding: 7px 16px;
      text-align: left;
      font-family: 'IBM Plex Mono', monospace;
      font-size: 10px;
      font-weight: 500;
      letter-spacing: 0.10em;
      text-transform: uppercase;
      color: var(--muted);
      background: var(--surface);
      border-bottom: 1px solid var(--border);
    }

    tbody tr {
      border-bottom: 1px solid var(--border);
      transition: background 0.12s;
    }

    tbody tr:last-child { border-bottom: none; }
    tbody tr:hover { background: var(--accent-bg); }

    td { padding: 9px 12px; vertical-align: middle; }

    .col-date {
      color: var(--muted);
      font-size: 12px;
      white-space: nowrap;
      width: 130px;
    }

    .col-name { font-weight: 500; }

    .col-type {
        color: var(--muted);
        font-size: 13px;
        width: 220px;
    }

    .col-time {
      font-family: 'IBM Plex Mono', monospace;
      font-size: 12px;
      color: var(--blue);
      white-space: nowrap;
      width: 100px;
    }

    .empty {
      text-align: center;
      padding: 72px 0;
      color: var(--muted);
      font-style: italic;
    }

    .belmont-nav {
    position: fixed;
    z-index: 200;
    top: 24px;
    left: 24px;
  }
 
  @media (max-width: 560px) {
    .belmont-nav {
      top: auto;
      left: auto;
      bottom: 20px;
      right: 20px;
    }
  }
 
  .belmont-nav-toggle {
    width: 38px;
    height: 38px;
    background: var(--surface, #13131b);
    border: 1.5px solid var(--accent, #c8a86b);
    border-radius: 6px;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    transition: background 0.15s, box-shadow 0.15s;
    box-shadow: 0 4px 14px rgba(0,0,0,0.35);
  }
 
  .belmont-nav-toggle:hover {
    background: var(--surface2, #1b1b26);
  }
 
  .belmont-nav-toggle svg {
    width: 16px;
    height: 16px;
  }
 
  .belmont-nav-toggle svg rect {
    fill: var(--accent, #c8a86b);
  }
 
  /* ── Menu panel ── */
  .belmont-nav-menu {
    position: absolute;
    top: 46px;
    left: 0;
    min-width: 196px;
    background: var(--surface, #13131b);
    border: 1px solid var(--border, #252533);
    border-radius: 6px;
    overflow: hidden;
    box-shadow: 0 16px 44px rgba(0,0,0,0.5);
    opacity: 0;
    transform: translateY(-6px);
    pointer-events: none;
    transition: opacity 0.15s ease, transform 0.15s ease;
  }
 
  @media (max-width: 560px) {
    .belmont-nav-menu {
      top: auto;
      bottom: 46px;
      left: auto;
      right: 0;
      transform: translateY(6px);
    }
  }
 
  .belmont-nav.open .belmont-nav-menu {
    opacity: 1;
    transform: translateY(0);
    pointer-events: auto;
  }
 
  .belmont-nav-link {
    display: flex;
    align-items: center;
    gap: 11px;
    padding: 11px 14px;
    text-decoration: none;
    border-bottom: 1px solid var(--border, #252533);
    transition: background 0.12s;
    position: relative;
  }
 
  .belmont-nav-link:last-child { border-bottom: none; }
 
  .belmont-nav-link:hover {
    background: var(--surface2, #1b1b26);
  }
 
  .belmont-nav-link-icon {
    width: 28px;
    height: 28px;
    border-radius: 5px;
    background: var(--surface2, #1b1b26);
    border: 1px solid var(--border, #252533);
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    color: var(--accent, #c8a86b); /* icons use currentColor via SVG */
  }
 
  .belmont-nav-link-icon svg {
    width: 15px;
    height: 15px;
  }
 
  .belmont-nav-link-label {
    font-family: 'IBM Plex Mono', monospace;
    font-size: 11px;
    font-weight: 500;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--accent, #c8a86b);
  }
 
  /* ── Current page state: blue halo + blue text ── */
  .belmont-nav-link.is-current .belmont-nav-link-icon {
    color: var(--blue, #5b9cf6);
    border-color: var(--blue, #5b9cf6);
    box-shadow: 0 0 0 3px rgba(91, 156, 246, 0.18), 0 0 14px rgba(91, 156, 246, 0.35);
  }
 
  .belmont-nav-link.is-current .belmont-nav-link-label {
    color: var(--blue, #5b9cf6);
  }

  /* ── Animated background ── */
.hero-bg {
  position: fixed;
  inset: 0;
  z-index: 0;
  pointer-events: none;
  overflow: hidden;
}

.hero-orb {
  position: absolute;
  border-radius: 50%;
  filter: blur(80px);
  opacity: 0.28;
  animation: drift 18s ease-in-out infinite alternate;
}

.hero-orb-1 {
  width: 600px;
  height: 600px;
  background: radial-gradient(circle, #c8a86b 0%, transparent 70%);
  top: -180px;
  left: -140px;
  animation-duration: 20s;
}

.hero-orb-2 {
  width: 500px;
  height: 500px;
  background: radial-gradient(circle, #5b9cf6 0%, transparent 70%);
  top: 60px;
  right: -160px;
  animation-duration: 16s;
  animation-delay: -6s;
  opacity: 0.18;
}

.hero-orb-3 {
  width: 400px;
  height: 400px;
  background: radial-gradient(circle, #c8a86b 0%, transparent 70%);
  bottom: 20%;
  left: 30%;
  animation-duration: 24s;
  animation-delay: -10s;
  opacity: 0.12;
}

@keyframes drift {
  0%   { transform: translate(0, 0) scale(1); }
  33%  { transform: translate(30px, -20px) scale(1.05); }
  66%  { transform: translate(-20px, 30px) scale(0.97); }
  100% { transform: translate(15px, 10px) scale(1.03); }
}
  </style>
</head>
<div class="belmont-nav" id="belmontNav" data-current="schedule">
  <!--
    data-current options: "home" | "schedule" | "videos" | "policies" | "tools" | "musicians" | "resources"
    Set this manually per page, e.g. data-current="videos" on the video library page.
  -->
 
  <button class="belmont-nav-toggle" id="belmontNavToggle" aria-label="Open navigation" aria-expanded="false">
    <svg viewBox="0 0 16 16">
      <rect x="2" y="4" width="12" height="1.6" rx="0.8"/>
      <rect x="2" y="7.2" width="12" height="1.6" rx="0.8"/>
      <rect x="2" y="10.4" width="12" height="1.6" rx="0.8"/>
    </svg>
  </button>
 
  <nav class="belmont-nav-menu">

    <a class="belmont-nav-link" data-page="home" href="https://bradwintersmusic-cloud.github.io/studio-home/">
  <span class="belmont-nav-link-icon">
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
      <path d="M3 9.5L12 3l9 6.5V20a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z"/>
      <path d="M9 21V12h6v9"/>
    </svg>
  </span>
  <span class="belmont-nav-link-label">Studio Hub</span>
</a>
 
    <!-- Studio Schedule -->
    <a class="belmont-nav-link" data-page="schedule" href="https://bradwintersmusic-cloud.github.io/studioassistant-sync/">
      <span class="belmont-nav-link-icon">
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
          <path fill="none" stroke="currentColor" stroke-width="1.5" d="M2 4h20v18H2zm5-3v3m10-3v3M2 8h20M5 12.5h3m-3 5h3m2.5-5h3m2.5 0h3m-8.5 5h3" />
        </svg>
      </span>
      <span class="belmont-nav-link-label">Studio Schedule</span>
    </a>
 
    <!-- Video Library -->
    <a class="belmont-nav-link" data-page="videos" href="https://bradwintersmusic-cloud.github.io/studio-videos/">
      <span class="belmont-nav-link-icon">
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
          <g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-miterlimit="10">
            <path d="M3.5 5.5h-3v18h18v-3" />
            <path d="M22.5 1.5h-19v19h19z" />
            <path d="M10.5 7v8l7-4z" />
          </g>
        </svg>
      </span>
      <span class="belmont-nav-link-label">Video Library</span>
    </a>
 
    <!-- Policies -->
    <a class="belmont-nav-link" data-page="policies" href="https://bradwintersmusic-cloud.github.io/studio-policies/">
      <span class="belmont-nav-link-icon">
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
          <path fill="currentColor" d="m2.3 20.28l9.6-9.6l-1.4-1.42l-.72.71a.996.996 0 0 1-1.41 0l-.71-.71a.996.996 0 0 1 0-1.41l5.66-5.66a.996.996 0 0 1 1.41 0l.71.71c.39.39.39 1.02 0 1.41l-.71.69l1.42 1.43a.996.996 0 0 1 1.41 0c.39.39.39 1.03 0 1.42l1.41 1.41l.71-.71c.39-.39 1.03-.39 1.42 0l.7.71c.39.39.39 1.03 0 1.42l-5.65 5.65c-.39.39-1.03.39-1.42 0l-.7-.7a.99.99 0 0 1 0-1.42l.7-.71l-1.41-1.41l-9.61 9.61a.996.996 0 0 1-1.41 0c-.39-.39-.39-1.03 0-1.42M20 19a2 2 0 0 1 2 2v1H12v-1a2 2 0 0 1 2-2z" />
        </svg>
      </span>
      <span class="belmont-nav-link-label">Policies</span>
    </a>

    <!-- Tools -->
    <a class="belmont-nav-link" data-page="tools" href="https://bradwintersmusic-cloud.github.io/studio-tools/">
        <span class="belmont-nav-link-icon">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
            <path fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>
          </svg>
        </span>
        <span class="belmont-nav-link-label">Studio Tools</span>
      </a>

    <a class="belmont-nav-link" data-page="musicians" href="https://bradwintersmusic-cloud.github.io/studio-musicians/">
        <span class="belmont-nav-link-icon">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"><path d="m42.31 13.38l-25.1 3.48V7.98l25.1-3.48zm0 0v17.15m-25.1-13.67v20.88"/><circle cx="11.45" cy="37.74" r="5.76"/><circle cx="36.55" cy="30.53" r="5.76"/></svg>
        </span>
        <span class="belmont-nav-link-label">Session Musicians</span>
      </a>

    <a class="belmont-nav-link" data-page="resources" href="https://bradwintersmusic-cloud.github.io/studio-resources/">
  <span class="belmont-nav-link-icon">
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
      <polyline points="14 2 14 8 20 8"/>
      <line x1="16" y1="13" x2="8" y2="13"/>
      <line x1="16" y1="17" x2="8" y2="17"/>
      <polyline points="10 9 9 9 8 9"/>
    </svg>
  </span>
  <span class="belmont-nav-link-label">Resources</span>
</a>
 
  </nav>
</div>
 
<script>
(function() {
  var nav = document.getElementById('belmontNav');
  var toggle = document.getElementById('belmontNavToggle');
 
  var current = nav.getAttribute('data-current');
  var links = nav.querySelectorAll('.belmont-nav-link');
  for (var i = 0; i < links.length; i++) {
    if (links[i].getAttribute('data-page') === current) {
      links[i].classList.add('is-current');
    }
  }
 
  toggle.addEventListener('click', function(e) {
    e.stopPropagation();
    var isOpen = nav.classList.toggle('open');
    toggle.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
  });
 
  document.addEventListener('click', function(e) {
    if (!nav.contains(e.target)) {
      nav.classList.remove('open');
      toggle.setAttribute('aria-expanded', 'false');
    }
  });
 
  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') {
      nav.classList.remove('open');
      toggle.setAttribute('aria-expanded', 'false');
    }
  });
})();
</script>
<body>
  <div class="hero-bg" aria-hidden="true">
  <div class="hero-orb hero-orb-1"></div>
  <div class="hero-orb hero-orb-2"></div>
  <div class="hero-orb hero-orb-3"></div>
</div>
  <header class="page-header">
    <div class="wordmark">Belmont University · AET</div>
    <h1>Studio Schedule</h1>
    <div class="meta">Generated ${escapeHtml(generatedAt)} · <span id="session-count"></span></div>
    <div class="tabs">
  <button class="tab-btn active" data-date="${todayKey}" onclick="filterByDate('${todayKey}')">Today</button>
  <button class="tab-btn" data-date="${tomorrowKey}" onclick="filterByDate('${tomorrowKey}')">Tomorrow</button>
</div>
  </header>
  <main class="content">
    ${body}
  </main>
  <script>
    function toggleFacility(header) {
      const content = header.nextElementSibling;
      const icon = header.querySelector('.toggle-icon');
      const isHidden = content.style.display === 'none';
      content.style.display = isHidden ? 'block' : 'none';
      icon.classList.toggle('collapsed', !isHidden);
    }
  </script>
  <script>
  function filterByDate(dateKey) {
    document.querySelectorAll('tbody tr').forEach(row => {
      row.style.display = row.dataset.date === dateKey ? '' : 'none';
    });
    document.querySelectorAll('.studio-block').forEach(block => {
      const visible = block.querySelectorAll('tbody tr:not([style*="display: none"])').length;
      block.style.display = visible === 0 ? 'none' : '';
    });
    document.querySelectorAll('.facility-content').forEach(content => {
      const visible = content.querySelectorAll('.studio-block:not([style*="display: none"])').length;
      content.parentElement.style.display = visible === 0 ? 'none' : '';
    });
    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.date === dateKey);
    });
    const count = document.querySelectorAll('tbody tr:not([style*="display: none"])').length;
    document.getElementById('session-count').textContent = count + ' session' + (count !== 1 ? 's' : '');
  }

  filterByDate(document.querySelector('.tab-btn.active').dataset.date);
</script>
</body>
</html>`;
}

// ─── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const { start, end } = getDateRange();
  console.log(`\nFetching sessions: ${start}  →  ${end}`);

  const accessToken = await login();

  const allRaw = [];
  for (const id of FACILITY_IDS) {
    const sessions = await fetchFacilitySessions(accessToken, id, start, end);
    allRaw.push(...sessions);
  }

  const sessions = processSessions(allRaw, start, end);
  console.log(`✓ ${sessions.length} sessions after filtering\n`);

  const generatedAt = new Date().toLocaleString('en-US', {
    timeZone: TIMEZONE,
    weekday: 'short',
    month:   'short',
    day:     'numeric',
    hour:    'numeric',
    minute:  '2-digit',
    hour12:  true,
  });

  const todayKey = new Date().toLocaleDateString('en-CA', { timeZone: TIMEZONE });
  const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowKey = tomorrow.toLocaleDateString('en-CA', { timeZone: TIMEZONE });

  const html = buildHTML(sessions, generatedAt, todayKey, tomorrowKey);
    fs.writeFileSync(OUTPUT_FILE, html, 'utf8');
  console.log(`✓ Schedule written to ${OUTPUT_FILE}`);
}

main().catch(err => {
  console.error('\n✗ Error:', err.message);
  process.exit(1);
});
