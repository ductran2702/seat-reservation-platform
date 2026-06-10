# Implementation Plan — Seat Reservation Platform

> Living document. Tracks scope, architecture, schema, API surface, and the
> phased build order. Decisions and trade-offs are recorded in `DECISIONS.md`.

## 1. Goal

A small public seat reservation platform: **3 seats**, authenticated users can
log in (session lasting 90 days), select a seat, pay via a mock provider, and
have the seat confirmed on successful payment. Must correctly handle
concurrency (no double-booking) and common failure paths.

## 2. Chosen stack

| Concern        | Choice                                                                 |
| -------------- | ---------------------------------------------------------------------- |
| API            | Express + TypeScript                                                   |
| Frontend       | Vite + React (separate dev server, proxies `/api` → Express)           |
| Database       | PostgreSQL via `docker-compose`                                        |
| ORM            | Prisma                                                                 |
| Auth           | Access (~15m) + refresh (90d) JWTs; httpOnly + Secure + SameSite=Strict cookies; refresh tokens hashed + rotated in DB |
| Payment        | In-app mock provider honoring `?outcome=success\|fail\|timeout`        |
| Concurrency    | Seat **hold with expiry** + **partial unique index** (one active row per seat) |
| Rate limiting  | Basic limiter on auth endpoints; rest documented as deferred           |

## 3. Repository layout (npm workspaces monorepo)

```
seat-reservation-platform-1/
├── docker-compose.yml          # Postgres 16
├── .env.example                # copied to .env
├── package.json                # root: workspaces + orchestration scripts
├── server/                     # Express + Prisma API
│   ├── prisma/
│   │   ├── schema.prisma
│   │   ├── partial-index.sql   # partial unique index (db push can't express it)
│   │   └── seed.ts             # 3 seats + demo user
│   └── src/
│       ├── index.ts            # app bootstrap
│       ├── lib/ (prisma, jwt, cookies, password)
│       ├── middleware/ (auth, rateLimit, errors)
│       └── routes/ (auth, seats, reservations, payment)
└── web/                        # Vite + React client (port 5174)
    ├── vite.config.ts          # dev proxy /api → :4001
    └── src/
        ├── api.ts              # fetch client (refresh-on-401), typed responses
        ├── auth.tsx            # auth context (/me on load, login/register/logout)
        ├── hooks.ts            # useCountdown for hold expiry
        ├── App.tsx             # routes + Protected wrapper
        └── pages/ (Login, Seats)   # Seats = multi-select + Hold + inline Pay-all
```

## 4. Data model

- **User** — `id`, `email` (unique), `passwordHash`, `name`, timestamps.
- **Seat** — `id`, `label` (unique, e.g. `A1`), timestamps. Exactly 3 seeded.
- **Reservation** — `id`, `seatId`, `userId`, `status`
  (`HELD | CONFIRMED | EXPIRED | CANCELLED | FAILED`), `holdExpiresAt`,
  `confirmedAt`, timestamps. The reservation row *is* the hold.
- **Payment** — `id`, `reservationId` (unique), `amountCents`, `status`
  (`PENDING | SUCCEEDED | FAILED | TIMEOUT`), `outcome`, timestamps.
- **RefreshToken** — `id`, `userId`, `tokenHash`, `expiresAt`, `revokedAt`,
  `replacedById` (rotation chain), timestamps.

### Concurrency invariant

Partial unique index guarantees **at most one active reservation per seat**:

```sql
CREATE UNIQUE INDEX IF NOT EXISTS reservation_active_seat_ux
  ON "Reservation" ("seatId")
  WHERE status IN ('HELD', 'CONFIRMED');
```

Prisma `db push` cannot express filtered indexes, so `npm run db:push` applies
`partial-index.sql` immediately after pushing the schema (idempotent).

Hold lifecycle (race-safe, done in a transaction):
1. Lazily expire stale holds: `UPDATE ... SET status='EXPIRED' WHERE status='HELD' AND holdExpiresAt < now()`.
2. Idempotency: if the caller already actively holds/owns this seat, return that reservation.
3. Enforce the per-user active limit (`MAX_ACTIVE_RESERVATIONS_PER_USER`, default 2) — best-effort (not lock-serialized).
4. Insert new `HELD` row with `holdExpiresAt = now() + HOLD_TTL`.
5. If the partial unique index throws (P2002), the seat is already taken → return `409 Conflict`.

## 5. API surface

| Method | Path                         | Purpose                                              |
| ------ | ---------------------------- | ---------------------------------------------------- |
| POST   | `/api/auth/register`         | Create account (demo convenience)                    |
| POST   | `/api/auth/login`            | Set access + refresh cookies (rate limited)          |
| POST   | `/api/auth/refresh`          | Rotate refresh token, issue new access cookie        |
| POST   | `/api/auth/logout`           | Revoke refresh token, clear cookies                  |
| GET    | `/api/auth/me`               | Current user                                         |
| GET    | `/api/config`                | Public client config (seat price, hold TTL, max seats) |
| GET    | `/api/seats`                 | List seats + live availability (optional auth → `mine`) |
| POST   | `/api/reservations`          | Hold a seat (auth; idempotent, limit-checked, race-safe) |
| GET    | `/api/reservations/:id`      | Hold/reservation status, owner-only (auth)           |
| DELETE | `/api/reservations/:id`      | Cancel own HELD reservation → CANCELLED (auth)       |
| POST   | `/api/payments/:reservationId/intent`  | Create payment intent, return mock checkout URL (auth) |
| POST   | `/api/payments/:reservationId/confirm` | Mock provider callback; honors `?outcome=` (auth)  |

## 6. Mock payment flow (two-step provider simulation)

1. **Intent** — `POST /api/payments/:reservationId/intent`: validates ownership +
   live hold (expired → `409 hold_expired`), upserts a `PENDING` Payment
   (`amountCents = SEAT_PRICE_CENTS`), and returns a `checkoutUrl`
   (`${WEB_ORIGIN}/checkout/:reservationId`) — mirroring a redirect to a hosted
   page. (The SPA now completes payment inline rather than navigating to this
   URL; the field is retained to reflect real provider semantics.)
2. **Confirm (callback)** — `POST /api/payments/:reservationId/confirm?outcome=success|fail|timeout`,
   all in a transaction with ownership + hold-expiry re-checks:
   - `success` → Payment `SUCCEEDED`, Reservation `CONFIRMED` (sets `confirmedAt`).
   - `fail` → Payment `FAILED`, Reservation `FAILED` (seat freed; user may re-hold).
   - `timeout` → Payment `TIMEOUT` (returned immediately, no delay); reservation
     stays `HELD` and is retryable until the hold expires.
   - Confirming an already-`CONFIRMED` reservation is idempotent (`200`).

## 7. Build order (phases)

- [x] **Phase 0 — Foundation (this step):** monorepo init, docker-compose,
      `.env.example`, Prisma schema, partial index, seed 3 seats + demo user,
      `db:push` verified.
- [x] **Phase 1 — Auth:** password hashing, JWT issue/verify, cookie helpers,
      register/login/refresh/logout/me, auth middleware, auth rate limiter.
- [x] **Phase 2 — Seats & holds:** `GET /seats` (optional-auth availability +
      `mine`), `POST /reservations` (transactional sweep + idempotent re-hold +
      per-user limit + P2002 → 409), owner-only status endpoint. Verified incl.
      cross-user conflict, limit, lazy expiry, and a double-booking race.
- [x] **Phase 3 — Payment:** two-step mock payment (intent → checkout URL →
      confirm callback) with transactional confirmation, hold-expiry re-checks,
      idempotency, and a cancel-hold endpoint. Verified success / fail (seat
      freed) / timeout (retryable) / expired-hold / cancel / invalid-outcome.
- [x] **Phase 4 — Frontend:** Vite + React SPA — login/register and a single
      seats page: click to **multi-select up to 2 seats**, a **Hold** button
      creates the holds, then an **inline payment section** (single shared
      "Expires in" countdown + total + one **Cancel** button that releases all
      holds) offers **Pay all / Simulate failure / Simulate timeout** in a
      3-column row; success flips seats to "Reserved ✓" in place. Confirmed
      seats don't count toward the hold limit. 3s polling, refresh-on-401 in the
      API client. Build + proxy + end-to-end verified. (The standalone
      `/checkout` + `/confirmation` routes were replaced by this inline flow; the
      `/intent` + `/confirm` API endpoints are unchanged.)
- [x] **Phase 5 — Polish:** testable `createApp()` bootstrap, **README.md**
      (setup/env/scripts), Vitest integration suite (`npm test` — concurrency
      race + payment fail/timeout, expired hold, cancel, hold limit, confirmed
      seats excluded from limit), and final **DECISIONS.md** review.

## 8. Run commands (target)

```bash
cp .env.example .env
npm install
npm run db:up      # start Postgres container
npm run db:push    # prisma db push + apply partial index + seed
npm run dev        # server + web concurrently
npm test           # concurrency test (requires db:up; asserts only one hold wins)
```
