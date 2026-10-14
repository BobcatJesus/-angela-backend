# Angela backend

Scheduling server for Angela's Mobile Bartending: booking requests,
Angela's confirmations, and calendar block-outs, shared by all devices.

## Run locally

```
npm install
npm start
```

Runs on http://localhost:8787 with a local `data.json` store (created
on first write) — no database setup needed for a trial. Owner PIN
defaults to **1234** locally; the server prints a warning about it.

## API

| Method | Path | Who | What |
|---|---|---|---|
| GET | /api/health | public | `{ ok: true }` |
| GET | /api/availability | public | block-outs + confirmed dates (no customer details) |
| POST | /api/requests | public | submit a booking request |
| POST | /api/owner/login | owner | `{ pin }` → `{ token }` (12h) |
| GET | /api/requests | owner | full request list (Bearer token) |
| PATCH | /api/requests/:id | owner | `{ status }` — pending/confirmed/declined |
| POST | /api/blockouts | owner | `{ date, note }` |
| DELETE | /api/blockouts/:date | owner | remove a block-out |

## Deploy on Railway

1. Put this folder in a GitHub repo and create a Railway service from
   it (same flow as location-chat's backend).
2. Add a **PostgreSQL** database to the project — Railway sets
   `DATABASE_URL` on the service automatically, and the server
   switches from the JSON file to Postgres on its own (tables are
   created at boot).
3. Set a service variable **OWNER_PIN** to a PIN Angela chooses —
   not the default.
4. Generate a domain for the service and note the URL
   (e.g. `https://angela-backend-production.up.railway.app`).
5. Put that URL in the app's `src/api-config.js` (`API_URL`) and
   rebuild the app. Until then the app stays in local demo mode.

## Env vars

- `PORT` — set by Railway automatically.
- `DATABASE_URL` — set by Railway's Postgres; absent = JSON file.
- `OWNER_PIN` — Angela's owner PIN (default 1234, local trial only).
