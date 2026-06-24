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
const RANGE_DAYS = 1;

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

function buildHTML(sessions, generatedAt) {
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
            <tr>
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
      --muted:      #62627a;
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

    td { padding: 11px 16px; vertical-align: middle; }

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
  </style>
</head>
<body>
  <header class="page-header">
    <div class="wordmark">Belmont University · AET</div>
    <h1>Studio Schedule</h1>
    <div class="meta">Generated ${escapeHtml(generatedAt)} · ${sessions.length} session${sessions.length !== 1 ? 's' : ''}</div>
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

  const html = buildHTML(sessions, generatedAt);
  fs.writeFileSync(OUTPUT_FILE, html, 'utf8');
  console.log(`✓ Schedule written to ${OUTPUT_FILE}`);
}

main().catch(err => {
  console.error('\n✗ Error:', err.message);
  process.exit(1);
});
