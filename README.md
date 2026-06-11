# Seat Reservation Platform

A small public seat reservation platform: **3 seats**, authenticated users, mock
payment, and a hold-based concurrency model that prevents double-booking under
races. Built as a technical assessment — see `DECISIONS.md` for architecture
choices and trade-offs.

The backend is a **microservices skeleton**: an HTTP gateway in front of three
domain services (auth, seat, payment) sharing one Postgres database, with
Redis caching, an SSE stream for live seat availability, and an nginx edge.

## Architecture

```
  ┌──────────────────────────────────────────┐
  │              nginx :80                   │
  │     rate limits · security headers       │
  └─────┬─────────────────────┬──────────────┘
        │                     │ /api
        ▼                     ▼
  ┌───────────┐     ┌──────────────────────────────────────┐
  │   web     │     │           gateway :3000              │
  │  (React)  │     │  auth proxy · rate limit · SSE       │
  └───────────┘     └───┬──────────────┬───────────────────┘
                        │ X-User-Id    │ + X-Internal-Secret
              ┌─────────┤              ├─────────┐
              ▼         ▼              ▼         ▼
        ┌──────────┐ ┌──────────┐ ┌──────────┐
        │ auth-svc │ │ seat-svc │ │payment-  │
        │  :3001   │ │  :3002   │ │  svc     │
        └──────────┘ └─────┬────┘ │  :3003   │
                       sweeper    └──────────┘
                    (advisory lock)

  ┌─────────────────────────┐   ┌─────────────────────┐
  │ PostgreSQL (+PgBouncer) │   │   Redis (optional)  │
  │     (primary store)     │   │  seat cache · TODO: │
  │                         │   │  pub/sub, ratelimit │
  └─────────────────────────┘   └─────────────────────┘
         ▲ all services connect ▲
```

- **gateway** — single entry point: verifies the access JWT (incl.
  `tokenVersion`), forwards identity via `X-User-Id` + `X-Internal-Secret`
  internal headers, rate-limits auth endpoints, serves the SSE stream
  (`/api/seats/stream`) and `/api/config`.
- **auth-svc** — sessions, tokens, users. Opaque rotated refresh tokens,
  reuse detection, timing-safe login.
- **seat-svc** — write authority for seat state: holds/reservations, the
  partial-unique-index invariant, the background hold-expiry **sweeper**
  (Postgres advisory lock), and the Redis seat cache.
- **payment-svc** — mock two-step payment; reports seat-state changes back to
  seat-svc so cache invalidation + SSE fan-out stay centralized.
- **packages/linkz-core** — shared middleware (internal-header auth, cookie
  JWT verification, error handling).
- **packages/db** — shared Prisma schema + raw `pg` pools with a read/write
  split (`DATABASE_READ_URL`-ready).

## Prerequisites

- **Node.js** ≥ 20
- **Docker** (for PostgreSQL via `docker-compose`)
- **npm** (workspaces monorepo)

## Quick start

### Local development (services on the host)

```bash
cp .env.example .env
npm install
npm run db:up      # start Postgres (host port 5434) + Redis
npm run db:push    # push schema, apply partial unique index, seed 3 seats + demo user
npm run dev        # gateway (:3000) + auth (:3001) + seat (:3002) + payment (:3003) + web (:5174)
```

Open **http://localhost:5174** and sign in with the demo account (printed by
`db:seed`, defaults below).

### Full stack in Docker (nginx edge)

```bash
cp .env.example .env
make up            # builds all images; db-init pushes schema + seeds automatically
```

Open **http://localhost** (nginx :80 → web SPA + gateway API). `make down`
tears it down, `make logs` tails everything.

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

Seat availability updates **live over SSE** (`/api/seats/stream`), with
polling as fallback.

## Environment configuration

Copy `.env.example` to `.env` and adjust as needed:

| Variable | Purpose |
| -------- | ------- |
| `DATABASE_URL` | Postgres connection (matches `infra/docker-compose.yml`, host port **5434**) |
| `DATABASE_READ_URL` | Optional read-replica URL for non-critical SELECTs (falls back to `DATABASE_URL`) |
| `SWEEPER_DATABASE_URL` | Optional direct-to-primary URL for the sweeper's session-level advisory lock (bypasses PgBouncer) |
| `POSTGRES_PASSWORD` | Postgres password used by docker compose |
| `GATEWAY_PORT` / `AUTH_SVC_PORT` / `SEAT_SVC_PORT` / `PAYMENT_SVC_PORT` | Service ports (defaults `3000`/`3001`/`3002`/`3003`) |
| `AUTH_SVC_URL` / `SEAT_SVC_URL` / `PAYMENT_SVC_URL` / `GATEWAY_URL` | Service discovery for local dev (compose overrides with container DNS) |
| `INTERNAL_SECRET` | Authenticates gateway → service traffic; services only trust `X-User-Id` with it |
| `WEB_ORIGIN` | Vite dev origin (default `http://localhost:5174`) |
| `ACCESS_TOKEN_SECRET` | Access-JWT signing secret — change in any real environment (refresh tokens are opaque DB-tracked values; no secret needed) |
| `ACCESS_TOKEN_TTL` | Short-lived access token (default `15m`) |
| `REFRESH_TOKEN_TTL_DAYS` | Refresh token lifetime / session length (default `90`) |
| `HOLD_TTL_SECONDS` | How long a seat hold lasts (default `30` — set low to test expiry) |
| `SWEEP_INTERVAL_MS` | Background hold-expiry sweeper interval (default `10000`) |
| `SEAT_PRICE_CENTS` | Mock payment amount per seat (default `2500` = $25.00) |
| `MAX_ACTIVE_RESERVATIONS_PER_USER` | Max simultaneous **held** seats per user (default `2`) |
| `REDIS_URL` | Optional — seat-list cache no-ops when unset |
| `DEMO_USER_EMAIL` / `DEMO_USER_PASSWORD` | Seeded demo account |

> **Port note:** Postgres is mapped to host port **5434** (not 5432) to avoid
> conflicts with other local databases. Update `DATABASE_URL` if you change the
> compose mapping.

## Scripts

| Command | Description |
| ------- | ----------- |
| `npm run dev` | Start all services (gateway, auth, seat, payment) + web dev server |
| `npm run dev:web` | Web only |
| `npm run build` | Typecheck every workspace + build the web bundle |
| `npm run db:up` | Start Postgres + Redis containers |
| `npm run db:down` | Stop the compose stack |
| `npm run db:push` | Push Prisma schema, apply partial index, seed |
| `npm run db:seed` | Re-run seed only |
| `npm run db:studio` | Open Prisma Studio |
| `npm test` | Run automated tests (see below) |
| `make up` / `make down` / `make logs` | Full dockerized stack behind nginx :80 |

## Testing

### Automated: concurrency (double-booking race)

Requires Postgres running (`npm run db:up`). Tests boot the **full service
topology in-process** (auth-svc, seat-svc, payment-svc on ephemeral ports
behind a real gateway) and call everything through the gateway URL:

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
├── apps/
│   ├── gateway/          # HTTP edge :3000 — auth proxy, rate limiting, SSE fan-out
│   │   └── src/          #   proxy.ts · sse.ts · app.ts · rateLimit.ts
│   ├── auth-svc/         # Auth :3001 — sessions, tokens, users
│   │   └── src/          #   routes/auth.ts · lib/{tokens,cookies,password}.ts
│   ├── seat-svc/         # Seat reservation :3002 — write authority for seat state
│   │   └── src/          #   routes/{seats,reservations}.ts · sweeper.ts
│   │                     #   infrastructure/seatCache.ts (Redis) · events.ts
│   ├── payment-svc/      # Payment :3003 — mock PSP, PCI-scope isolation
│   │   └── src/          #   routes/payments.ts
│   └── web/              # Vite + React SPA (SSE + polling fallback)
├── packages/
│   ├── linkz-core/       # Shared middleware: internal-header auth, JWT verify, errors
│   └── db/               # Prisma schema + seed + raw pg pools (read/write split)
├── infra/
│   ├── docker-compose.yml  # postgres + pgbouncer + redis + nginx + all services
│   └── nginx/nginx.conf    # rate limits, security headers, SSE proxying
├── tests/e2e/            # Vitest integration tests (run through the gateway)
├── Makefile              # make up / down / logs / db-up / db-push
├── DECISIONS.md          # Architecture decisions and trade-offs
└── implementation-plan.md
```

## Architecture (summary)

- **Topology:** nginx edge → gateway → auth/seat/payment services. The gateway
  verifies cookies once and forwards identity via internal headers
  (`X-User-Id`, authenticated by `X-Internal-Secret`).
- **Auth:** cookie-based — short-lived access JWT (with a `tokenVersion` claim
  revoked on logout/reuse) + opaque, DB-tracked refresh token (90-day session
  via atomic rotation, with reuse detection that burns all sessions on replay).
- **DB:** PostgreSQL behind PgBouncer; holds are `Reservation` rows with
  expiry; a **partial unique index** enforces at most one active (`HELD` or
  `CONFIRMED`) reservation per seat. Read/write pool split is replica-ready.
- **Scaling skeleton:** SSE seat stream with gateway fan-out, background
  hold-expiry sweeper guarded by a Postgres advisory lock, Redis seat cache
  with invalidation on every mutation.
- **Web:** Vite + React; dev proxy keeps cookies first-party for
  `SameSite=Strict`.
- **Payment:** Two-step mock provider (`/intent` → `/confirm?outcome=`) invoked
  inline from the seats page.

For the full decision log, security notes, and intentional omissions, see
`DECISIONS.md`.
