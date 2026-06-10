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
└── web/                        # Vite + React client
    ├── vite.config.ts          # dev proxy /api → :4001
    └── src/ (pages, api client, components)
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
| GET    | `/api/seats`                 | List seats + live availability (optional auth → `mine`) |
| POST   | `/api/reservations`          | Hold a seat (auth; idempotent, limit-checked, race-safe) |
| GET    | `/api/reservations/:id`      | Hold/reservation status, owner-only (auth)           |
| POST   | `/api/payments/:reservationId` | Start mock payment; honors `?outcome=`             |

## 6. Mock payment flow

`POST /api/payments/:reservationId?outcome=success|fail|timeout`
- `success` → mark Payment `SUCCEEDED`, Reservation `CONFIRMED` (in a tx).
- `fail` → Payment `FAILED`, Reservation `FAILED` (seat freed).
- `timeout` → simulated provider delay then Payment `TIMEOUT`; reservation stays
  `HELD` until its hold expires (demonstrates the expiry path).

## 7. Build order (phases)

- [x] **Phase 0 — Foundation (this step):** monorepo init, docker-compose,
      `.env.example`, Prisma schema, partial index, seed 3 seats + demo user,
      `db:push` verified.
- [ ] **Phase 1 — Auth:** password hashing, JWT issue/verify, cookie helpers,
      register/login/refresh/logout/me, auth middleware, auth rate limiter.
- [x] **Phase 2 — Seats & holds:** `GET /seats` (optional-auth availability +
      `mine`), `POST /reservations` (transactional sweep + idempotent re-hold +
      per-user limit + P2002 → 409), owner-only status endpoint. Verified incl.
      cross-user conflict, limit, lazy expiry, and a double-booking race.
- [ ] **Phase 3 — Payment:** mock payment route with outcome simulation,
      transactional confirmation.
- [ ] **Phase 4 — Frontend:** login page, seat picker (live availability),
      payment page with outcome selector, confirmation/expired states.
- [ ] **Phase 5 — Polish:** README run instructions, error handling, edge-case
      pass, final DECISIONS.md review.

## 8. Run commands (target)

```bash
cp .env.example .env
npm install
npm run db:up      # start Postgres container
npm run db:push    # prisma db push + apply partial index + seed
npm run dev        # server + web concurrently
```
