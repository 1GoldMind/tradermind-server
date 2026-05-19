// ─────────────────────────────────────────────
// TraderMind Server — Render.com
// Receives TradingView webhooks → posts to Google Sheets
// Auth: GoldMind
// ─────────────────────────────────────────────

const express = require('express');
const app = express();
app.use(express.json());
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, x-auth');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

const AUTH_KEY   = process.env.AUTH_KEY   || 'GoldMind';
const SHEETS_URL = process.env.SHEETS_URL || '';  // paste Apps Script URL here
const PORT       = process.env.PORT       || 3000;

// ── In-memory signal state (per pair) ────────
const state = {};

// ── Kill zone schedule (GMT) ──────────────────
// Used to write session log at kill zone close
const KILL_ZONES = [
  { name: 'Asia',   start: [0,  0], end: [3,  0] },
  { name: 'London', start: [7,  0], end: [10, 0] },
  { name: 'NY AM',  start: [12, 0], end: [15, 0] },
];

// ── Helpers ───────────────────────────────────
function nowGMT() {
  const d = new Date();
  return { h: d.getUTCHours(), m: d.getUTCMinutes() };
}

function activeKillZone() {
  const { h, m } = nowGMT();
  const mins = h * 60 + m;
  for (const kz of KILL_ZONES) {
    const s = kz.start[0] * 60 + kz.start[1];
    const e = kz.end[0]   * 60 + kz.end[1];
    if (mins >= s && mins < e) return kz.name;
  }
  return null;
}

// Key signals to diff — only POST to Sheets if any change
const DIFF_KEYS = [
  'weekly_trend', 'weekly_wr_signal', 'daily_wr_signal',
  'gap', 'day_bias', 'consec_bias', 'oops', 'bias_score'
];

function hasChanged(pair, incoming) {
  if (!state[pair]) return true;
  return DIFF_KEYS.some(k => String(state[pair][k]) !== String(incoming[k]));
}

// ── POST to Google Sheets ─────────────────────
async function postToSheets(payload) {
  if (!SHEETS_URL) return;
  try {
    await fetch(SHEETS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify(payload)
    });
  } catch (err) {
    console.error('Sheets POST failed:', err.message);
  }
}

// ── Session log tracker (per kill zone per day) ─
const sessionTracker = {};

function sessionKey(pair, kz) {
  const d = new Date();
  return `${pair}_${kz}_${d.toISOString().slice(0,10)}`;
}

// ─────────────────────────────────────────────
// ROUTES
// ─────────────────────────────────────────────

// Health check
app.get('/', (req, res) => res.send('TraderMind server running.'));

// Main webhook receiver
app.post('/webhook', async (req, res) => {
  const data = req.body;

  // Auth check
  if (data.auth !== AUTH_KEY) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }

  const pair = data.pair || 'UNKNOWN';
  const kz   = activeKillZone();

  // Signal state diff
  const changed = hasChanged(pair, data);
  state[pair] = { ...data, lastSeen: new Date().toISOString() };

  // Only POST to Sheets if signal state changed
  if (changed && kz) {
    const key = sessionKey(pair, kz);
    if (!sessionTracker[key]) {
      sessionTracker[key] = {
        pair, kz,
        startTime: new Date().toISOString(),
        signalChanges: 0,
        setupsDetected: 0
      };
    }
    sessionTracker[key].signalChanges++;

    // Detect setup quality (bias_score ≥ 2 = valid setup)
    if (Math.abs(Number(data.bias_score)) >= 2) {
      sessionTracker[key].setupsDetected++;
    }
  }

  console.log(`[${new Date().toISOString()}] ${pair} | KZ: ${kz || 'none'} | Score: ${data.bias_score} | Changed: ${changed}`);

  res.json({ success: true, pair, changed, killZone: kz || 'none' });
});

// Manual session log close (call at kill zone end or end of session)
app.post('/session-close', async (req, res) => {
  const data = req.body;
  if (data.auth !== AUTH_KEY) return res.status(401).json({ success: false });

  const pair = data.pair;
  const kz   = data.killZone || activeKillZone() || 'Unknown';
  const key  = sessionKey(pair, kz);
  const sess = sessionTracker[key] || {};

  const payload = {
    type: 'session_log',
    date: new Date().toISOString().slice(0, 10),
    killZone: kz,
    pairsMonitored: pair,
    startTime: sess.startTime || '',
    endTime: new Date().toISOString(),
    signalChanges: sess.signalChanges || 0,
    notificationsSent: 0,
    setupsDetected: sess.setupsDetected || 0,
    tradesTaken: data.tradesTaken || 0,
    notes: data.notes || ''
  };

  await postToSheets(payload);
  delete sessionTracker[key];

  res.json({ success: true, logged: payload });
});

// Current state snapshot (for TraderMind UI polling)
app.get('/state', (req, res) => {
  const auth = req.headers['x-auth'] || req.query.auth;
  if (auth !== AUTH_KEY) return res.status(401).json({ success: false });
  res.json({ success: true, state });
});

// ─────────────────────────────────────────────
app.listen(PORT, () => console.log(`TraderMind listening on port ${PORT}`));
