# Seat Reservation Platform

A small public seat reservation platform: **3 seats**, authenticated users, mock
payment, and a hold-based concurrency model that prevents double-booking under
races. Built as a technical assessment — see `DECISIONS.md` for architecture
choices and trade-offs.

## Prerequisites

- **Node.js** ≥ 20
- **Docker** (for PostgreSQL via `docker-compose`)
- **npm** (workspaces monorepo)

## Quick start

```bash
cp .env.example .env
npm install
npm run db:up      # start Postgres (host port 5434)
npm run db:push    # push schema, apply partial unique index, seed 3 seats + demo user
npm run dev        # API (:4001) + web (:5174) concurrently
```

Open **http://localhost:5174** and sign in with the demo account (printed by
`db:seed`, defaults below).

### Demo login

| Field    | Value              |
| -------- | ------------------ |
| Email    | `demo@example.com` |
| Password | `password123`      |

## How to use the app

1. **Sign in** (or register a new account).
2. **Click seat cards** to select up to **2** available seats (green ring =
   selected). Confirmed reservations do not count toward the hold limit.
3. Click **Hold** — selected seats are held for `HOLD_TTL_SECONDS` (default
   **30s**, configurable in `.env`).
4. The **Payment** section appears with a shared **Expires in** countdown,
   total, and:
   - **Pay all (success)** — confirms all held seats
   - **Simulate failure** — releases holds (`FAILED`)
   - **Simulate timeout** — payment times out; holds stay retryable
   - **Cancel** — releases all held seats at once
5. On success, seats show **Reserved by you ✓** inline.

The seat list polls every ~3 seconds for live availability.

## Environment configuration

Copy `.env.example` to `.env` and adjust as needed:

| Variable | Purpose |
| -------- | ------- |
| `DATABASE_URL` | Postgres connection (matches `docker-compose.yml`, port **5434**) |
| `PORT` | API port (default `4001`) |
| `WEB_ORIGIN` | Vite dev origin (default `http://localhost:5174`) |
| `ACCESS_TOKEN_SECRET` | Access-JWT signing secret — change in any real environment (refresh tokens are opaque DB-tracked values; no secret needed) |
| `ACCESS_TOKEN_TTL` | Short-lived access token (default `15m`) |
| `REFRESH_TOKEN_TTL_DAYS` | Refresh token lifetime / session length (default `90`) |
| `HOLD_TTL_SECONDS` | How long a seat hold lasts (default `30` — set low to test expiry) |
| `SEAT_PRICE_CENTS` | Mock payment amount per seat (default `2500` = $25.00) |
| `MAX_ACTIVE_RESERVATIONS_PER_USER` | Max simultaneous **held** seats per user (default `2`) |
| `DEMO_USER_EMAIL` / `DEMO_USER_PASSWORD` | Seeded demo account |

> **Port note:** Postgres is mapped to host port **5434** (not 5432) to avoid
> conflicts with other local databases. Update `DATABASE_URL` if you change the
> compose mapping.

## Scripts

| Command | Description |
| ------- | ----------- |
| `npm run dev` | Start API + web dev servers |
| `npm run dev:server` | API only |
| `npm run dev:web` | Web only |
| `npm run build` | Build server + web for production |
| `npm run db:up` | Start Postgres container |
| `npm run db:down` | Stop Postgres container |
| `npm run db:push` | Push Prisma schema, apply partial index, seed |
| `npm run db:seed` | Re-run seed only |
| `npm run db:studio` | Open Prisma Studio |
| `npm test` | Run automated tests (see below) |

## Testing

### Automated: concurrency (double-booking race)

Requires Postgres running (`npm run db:up`):

```bash
npm test
```

| Test | What it validates |
| ---- | ----------------- |
| Concurrent holds on one seat | Exactly one `201` + one `409 seat_unavailable`; DB has one active row |
| Refresh after logout | `401` — sessions are revoked server-side, not just cookie-cleared |
| Rotated refresh token replayed | `401 refresh_token_reused`; all of the user's sessions are burned |
| Two concurrent refreshes | Exactly one wins (atomic CAS rotation) |
| Payment `?outcome=fail` | Reservation `FAILED`; seat bookable again |
| Payment `?outcome=timeout` → `success` | Stays `HELD` after timeout; retry confirms |
| Expired hold + intent | `409 hold_expired` |
| `DELETE` held reservation | `CANCELLED`; seat freed |
| Confirmed + two new holds | CONFIRMED does not count toward hold limit |
| Third hold (same user) | `409 reservation_limit` |

### Manual: failure paths

See `DECISIONS.md` §8 for the full list. Quick checks in the UI:

| Scenario | How to trigger | Expected |
| -------- | -------------- | -------- |
| Payment success | Hold seat(s) → **Pay all (success)** | Seats become **Reserved ✓** |
| Payment failure | Hold → **Simulate failure** | Holds released, seats available again |
| Payment timeout | Hold → **Simulate timeout** → **Pay all** again | First timeout keeps hold; retry can confirm |
| Hold expiry | Hold a seat, wait past `HOLD_TTL_SECONDS` | Seat returns to available; payment section disappears |
| Cancel holds | Hold → **Cancel** | All holds released immediately |
| Double-booking | Open two browsers, two users, race for the same seat | One succeeds, the other gets an error |

## Project structure

```
├── server/          Express + TypeScript API, Prisma ORM
│   ├── prisma/      Schema, partial unique index SQL, seed
│   ├── src/         Routes, middleware, lib
│   └── test/        Vitest integration tests
├── web/             Vite + React SPA (proxies /api → server in dev)
├── docker-compose.yml
├── DECISIONS.md     Architecture decisions and trade-offs
└── implementation-plan.md
```

## Architecture (summary)

- **API:** Express + TypeScript, cookie-based auth — short-lived access JWT +
  opaque, DB-tracked refresh token (90-day session via atomic rotation, with
  reuse detection that burns all sessions on replay).
- **DB:** PostgreSQL; holds are `Reservation` rows with expiry; a **partial
  unique index** enforces at most one active (`HELD` or `CONFIRMED`) reservation
  per seat.
- **Web:** Vite + React; dev proxy keeps cookies first-party for
  `SameSite=Strict`.
- **Payment:** Two-step mock provider (`/intent` → `/confirm?outcome=`) invoked
  inline from the seats page.

For the full decision log, security notes, and intentional omissions, see
`DECISIONS.md`.
