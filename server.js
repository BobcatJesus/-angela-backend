// Angela's Mobile Bartending — scheduling backend.
//
// A small Express server that holds the shared scheduling data:
//   - booking requests (customers submit, Angela confirms/declines)
//   - block-outs (Angela's days off / holds)
//
// Storage: Postgres when DATABASE_URL is set (Railway), otherwise a
// local data.json file next to this file (zero-setup local trial).
//
// Owner access: a PIN checked ON THE SERVER (env OWNER_PIN, default
// 1234 for local trial only). A successful login returns a random
// token that expires after 12 hours; owner endpoints require it.

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 8787;
const OWNER_PIN = process.env.OWNER_PIN || '1234';
const TOKEN_TTL_MS = 12 * 60 * 60 * 1000;

// ─── Storage ────────────────────────────────────────────────────────

function makeJsonStore() {
  const file = path.join(__dirname, 'data.json');
  let data = { requests: [], blockouts: [] };
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (raw && Array.isArray(raw.requests) && Array.isArray(raw.blockouts)) data = raw;
  } catch { /* first run — start empty */ }
  const save = () => fs.writeFileSync(file, JSON.stringify(data, null, 2));
  return {
    mode: 'json-file',
    async listRequests() { return [...data.requests]; },
    async createRequest(req) { data.requests.push(req); save(); return req; },
    async setRequestStatus(id, status) {
      const r = data.requests.find((x) => x.id === id);
      if (!r) return false;
      r.status = status; save(); return true;
    },
    async listBlockouts() { return [...data.blockouts]; },
    async upsertBlockout(date, note) {
      data.blockouts = data.blockouts.filter((b) => b.date !== date);
      data.blockouts.push({ date, note }); save();
    },
    async deleteBlockout(date) {
      data.blockouts = data.blockouts.filter((b) => b.date !== date); save();
    },
  };
}

async function makePgStore() {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  await pool.query(`
    CREATE TABLE IF NOT EXISTS requests (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      phone TEXT NOT NULL,
      date TEXT NOT NULL,
      time TEXT,
      hours INT,
      guests INT,
      party_type TEXT,
      drinks TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at BIGINT
    );
    CREATE TABLE IF NOT EXISTS blockouts (
      date TEXT PRIMARY KEY,
      note TEXT
    );
  `);
  const rowToReq = (r) => ({
    id: r.id, name: r.name, phone: r.phone, date: r.date, time: r.time,
    hours: r.hours, guests: r.guests, partyType: r.party_type,
    drinks: r.drinks, status: r.status, createdAt: Number(r.created_at),
  });
  return {
    mode: 'postgres',
    async listRequests() {
      const { rows } = await pool.query('SELECT * FROM requests ORDER BY created_at ASC');
      return rows.map(rowToReq);
    },
    async createRequest(req) {
      await pool.query(
        `INSERT INTO requests (id, name, phone, date, time, hours, guests, party_type, drinks, status, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [req.id, req.name, req.phone, req.date, req.time, req.hours, req.guests, req.partyType, req.drinks, req.status, req.createdAt],
      );
      return req;
    },
    async setRequestStatus(id, status) {
      const res = await pool.query('UPDATE requests SET status = $2 WHERE id = $1', [id, status]);
      return res.rowCount > 0;
    },
    async listBlockouts() {
      const { rows } = await pool.query('SELECT date, note FROM blockouts ORDER BY date ASC');
      return rows;
    },
    async upsertBlockout(date, note) {
      await pool.query(
        'INSERT INTO blockouts (date, note) VALUES ($1,$2) ON CONFLICT (date) DO UPDATE SET note = EXCLUDED.note',
        [date, note],
      );
    },
    async deleteBlockout(date) {
      await pool.query('DELETE FROM blockouts WHERE date = $1', [date]);
    },
  };
}

// ─── App ────────────────────────────────────────────────────────────

const app = express();
app.use(express.json({ limit: '100kb' }));
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

const tokens = new Map(); // token -> expiresAt
function requireOwner(req, res, next) {
  const header = req.get('Authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  const expiresAt = tokens.get(token);
  if (!token || !expiresAt || expiresAt < Date.now()) {
    if (token) tokens.delete(token);
    return res.status(401).json({ error: 'Owner sign-in required.' });
  }
  next();
}

const isDateStr = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
const clean = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

let store;
async function init() {
  store = process.env.DATABASE_URL ? await makePgStore() : makeJsonStore();

  app.get('/', (req, res) => res.json({ service: 'angela-backend', ok: true, storage: store.mode }));
  app.get('/api/health', (req, res) => res.json({ ok: true }));

  // Public: what a customer needs to pick a date — block-outs + dates
  // already held by confirmed bookings. No customer details leak here.
  app.get('/api/availability', async (req, res, next) => {
    try {
      const [blockouts, requests] = await Promise.all([store.listBlockouts(), store.listRequests()]);
      const confirmedDates = requests.filter((r) => r.status === 'confirmed').map((r) => r.date);
      res.json({ blockouts, confirmedDates });
    } catch (e) { next(e); }
  });

  // Public: submit a booking request.
  app.post('/api/requests', async (req, res, next) => {
    try {
      const b = req.body || {};
      const name = clean(b.name, 80);
      const phone = clean(b.phone, 40);
      const date = clean(b.date, 10);
      const guests = Math.max(1, Math.min(500, parseInt(b.guests, 10) || 0));
      const hours = Math.max(4, Math.min(12, parseInt(b.hours, 10) || 4));
      if (!name) return res.status(400).json({ error: 'Name is required.' });
      if (!phone) return res.status(400).json({ error: 'Phone is required.' });
      if (!isDateStr(date)) return res.status(400).json({ error: 'A valid date is required.' });
      if (!guests) return res.status(400).json({ error: 'Guest count is required.' });
      // One booking per date: reject if the date is blocked/confirmed.
      const [blockouts, requests] = await Promise.all([store.listBlockouts(), store.listRequests()]);
      if (blockouts.some((x) => x.date === date)
        || requests.some((r) => r.date === date && r.status === 'confirmed')) {
        return res.status(409).json({ error: 'That date is no longer available.' });
      }
      const request = {
        id: `r-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`,
        name, phone, date,
        time: clean(b.time, 10) || '18:00',
        hours, guests,
        partyType: clean(b.partyType, 40) || 'Other',
        drinks: clean(b.drinks, 500),
        status: 'pending',
        createdAt: Date.now(),
      };
      await store.createRequest(request);
      res.status(201).json({ ok: true, id: request.id });
    } catch (e) { next(e); }
  });

  // Owner: sign in with the PIN, get a token.
  app.post('/api/owner/login', (req, res) => {
    const pin = (req.body && typeof req.body.pin === 'string') ? req.body.pin : '';
    if (pin !== OWNER_PIN) return res.status(401).json({ error: 'Wrong PIN.' });
    const token = crypto.randomUUID();
    tokens.set(token, Date.now() + TOKEN_TTL_MS);
    res.json({ ok: true, token });
  });

  // Owner: full request list (includes customer phone numbers).
  app.get('/api/requests', requireOwner, async (req, res, next) => {
    try { res.json({ requests: await store.listRequests() }); } catch (e) { next(e); }
  });

  // Owner: confirm / decline / cancel a request.
  app.patch('/api/requests/:id', requireOwner, async (req, res, next) => {
    try {
      const status = clean(req.body && req.body.status, 20);
      if (!['pending', 'confirmed', 'declined'].includes(status)) {
        return res.status(400).json({ error: 'Invalid status.' });
      }
      const ok = await store.setRequestStatus(req.params.id, status);
      if (!ok) return res.status(404).json({ error: 'Request not found.' });
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  // Owner: block / unblock a date.
  app.post('/api/blockouts', requireOwner, async (req, res, next) => {
    try {
      const date = clean(req.body && req.body.date, 10);
      const note = clean(req.body && req.body.note, 120) || 'Unavailable';
      if (!isDateStr(date)) return res.status(400).json({ error: 'A valid date is required.' });
      await store.upsertBlockout(date, note);
      res.json({ ok: true });
    } catch (e) { next(e); }
  });
  app.delete('/api/blockouts/:date', requireOwner, async (req, res, next) => {
    try {
      if (!isDateStr(req.params.date)) return res.status(400).json({ error: 'A valid date is required.' });
      await store.deleteBlockout(req.params.date);
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).json({ error: 'Server error.' });
  });

  app.listen(PORT, () => {
    console.log(`angela-backend listening on :${PORT} (storage: ${store.mode})`);
    if (OWNER_PIN === '1234') {
      console.log('WARNING: OWNER_PIN is the default 1234 — set a real one before real use.');
    }
  });
}

init().catch((e) => { console.error('Failed to start:', e); process.exit(1); });
