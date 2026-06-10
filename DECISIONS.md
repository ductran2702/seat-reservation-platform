# DECISIONS

## 1. What this is

A small public seat reservation platform with **3 seats**. Authenticated users
log in (session lasting 90 days via refresh-token rotation), select a seat, pay
through a mock payment provider, and have the seat confirmed only after a
successful payment. The interesting engineering lives in the **concurrency
model** (no double-booking under races) and the **failure-path handling**
(payment failure, payment timeout, and expired holds). This document records the
deliberate trade-offs made under a ~2-hour budget.

## 2. Run it

```bash
cp .env.example .env && npm install && npm run db:up
npm run db:push   # prisma db push + partial unique index + seed (3 seats, demo user)
npm run dev       # Express API + Vite/React client
```

> `npm run db:up` starts Postgres in Docker. Demo login is seeded and printed by
> the seed script.

## 3. Architecture

- **Client:** Vite + React talks only to `/api`, which Vite proxies to Express in
  dev — so the browser sees one origin and cookies stay first-party.
- **API:** Express + TypeScript, organized into `routes / middleware / lib`.
- **DB:** PostgreSQL (docker-compose) accessed via Prisma.
- **Auth:** short-lived access JWT + long-lived (90d) refresh JWT, both in
  httpOnly + Secure + SameSite=Strict cookies; refresh tokens are hashed and
  rotated in the DB so they can be revoked.
- **Booking core:** a reservation row *is* a hold with an expiry; a **partial
  unique index** enforces "one active reservation per seat" at the database level.

```
React (Vite :5174) ──/api proxy──▶ Express (:4001) ──Prisma──▶ Postgres (:5434, Docker)
```

## 4. Key decisions

| Decision | Alternatives | Why | With more time |
| --- | --- | --- | --- |
| Express + TS API, separate Vite/React client | Next.js full-stack, tRPC | Clear server/client split; explicit control over cookies, middleware, and the concurrency code | Shared types package between client/server |
| PostgreSQL via docker-compose | SQLite, hosted Postgres | Real transactional + partial-index semantics; reproducible for reviewers | Managed Postgres + connection pooling (PgBouncer) |
| Access + refresh JWT in httpOnly+Secure+SameSite=Strict cookies | Single 90d token; server sessions | XSS-safe (no JS access), CSRF-resistant (Strict), revocable via DB-stored refresh tokens; 90d session via refresh rotation | Token theft detection (reuse → revoke family), CSRF double-submit token |
| Hold-with-expiry + partial unique index | `SELECT ... FOR UPDATE`, optimistic version check | DB is the single source of truth for "one active row per seat"; survives races without app-level locking | Background sweeper job + Redis-backed hold TTL, websockets for live seat updates |
| Two-step mock payment (intent → checkout URL → confirm callback) with `?outcome=` | Single synchronous endpoint; Stripe test mode | Mirrors a real redirect/callback flow and deterministically exercises success / fail / timeout without external deps | Real provider webhook + idempotency keys + signature verification |
| Basic rate limit on auth only | Rate limit everything; none | Highest-value target (credential stuffing) within time budget | Distributed rate limiting (Redis), per-IP + per-account limits, lockout |
| Vite/React SPA, plain CSS, React Router, native fetch + 3s polling | Next.js, Tailwind, TanStack Query | Few deps, fast to build, clearly demonstrates the flow; polling keeps seat availability + hold countdown live | Realtime via WebSocket/SSE, optimistic UI, component/e2e tests |
| Single seats page: multi-select (≤2) → Hold → inline "Pay all" section | Per-seat checkout pages; per-seat payment outcomes | Matches the booking mental model (pick basket, then pay) and keeps the whole flow on one screen | Per-seat outcome control, cart persistence, seat map layout |

## 5. Concurrency model

A seat reservation *is* the hold: creating a reservation inserts a `HELD` row
with `holdExpiresAt = now() + HOLD_TTL`. A **partial unique index** on
`("seatId") WHERE status IN ('HELD','CONFIRMED')` guarantees at most one active
row per seat — the database, not application code, is the arbiter. Creating a
hold runs in a transaction that (1) lazily expires stale holds
(`status='HELD' AND holdExpiresAt < now()` → `EXPIRED`), (2) returns the existing
reservation if the caller already holds that seat (idempotent), (3) enforces a
per-user active limit (`MAX_ACTIVE_RESERVATIONS_PER_USER`, default 2), then
(4) inserts the new hold; a unique-violation (Prisma `P2002`) means another
request already holds the seat, returned as `409 Conflict`. The seat-level
guarantee is hard (DB-enforced); the per-user limit is best-effort (a count, not
lock-serialized). Payment confirmation re-checks ownership and hold-expiry inside
a transaction before flipping `HELD → CONFIRMED` (so an expired hold can never be
paid into a confirmation); `fail` releases the seat (`FAILED`), `timeout` leaves
it `HELD` and retryable until expiry. A user can also voluntarily release a hold
via `DELETE /api/reservations/:id` (→ `CANCELLED`).

## 6. Security notes

- **Cookies:** `httpOnly` (no JS access → XSS-resistant), `Secure` (HTTPS only),
  `SameSite=Strict` (CSRF-resistant), scoped `Path`, explicit `Max-Age`.
- **Tokens:** access ~15m, refresh 90d; refresh tokens stored **hashed** and
  **rotated** on each use so they can be revoked (logout, theft).
- **Passwords:** hashed with bcrypt; never logged or returned.
- **Rate limiting:** applied to login/auth endpoints to blunt credential
  stuffing/brute force. Broader rate limiting is **deferred — because** the 2h
  budget prioritizes the booking-correctness core; in production this would be
  Redis-backed and applied to all mutating routes.

## 7. What's intentionally missing

- **No real payment integration** — mock provider only (no webhooks, idempotency
  keys, or signature verification).
- **No background job** to expire holds — expiry is **lazy** (computed on read /
  on next hold attempt) instead of a scheduled sweeper.
- **Per-user reservation limit is best-effort** — enforced via a count inside the
  hold transaction, not a lock; under extreme concurrency a user could briefly
  exceed it. The *seat* double-booking guarantee is the hard, DB-enforced one.
- **No email verification, password reset, or MFA.**
- **No CSRF double-submit token** — relying on `SameSite=Strict` for this scope.
- **No realtime seat updates** (websockets/SSE) — client refetches availability.
- **No CSP / Helmet hardening, no audit logging, no observability/metrics.**
- **Minimal automated tests** — failure paths are exercised manually (see §8).
- **No production deployment / CI** — local-first per the assessment.

## 8. How to test failure paths

The payment flow is two-step: `POST /api/payments/:id/intent` (returns a mock
`checkoutUrl`) then `POST /api/payments/:id/confirm?outcome=...` (the provider
callback).

- **Payment failure:** confirm with `?outcome=fail` → payment `FAILED`,
  reservation `FAILED`, seat returns to available.
- **Payment timeout:** `?outcome=timeout` → payment `TIMEOUT` returned
  immediately; reservation stays `HELD` and is retryable (re-confirm with
  `?outcome=success` confirms it).
- **Expired hold:** create a hold, wait past `HOLD_TTL` (configurable via env;
  set it low to test), then refetch — the hold shows `EXPIRED` and the seat is
  bookable again. The next reservation attempt lazily expires the stale hold, and
  `intent`/`confirm` on an expired hold return `409 hold_expired`.
- **Double-booking race:** fire two concurrent `POST /api/reservations` for the
  same seat — exactly one succeeds, the other gets `409 Conflict`.
- **Voluntary cancel:** `DELETE /api/reservations/:id` on your own `HELD` seat
  frees it immediately (`CANCELLED`); confirmed seats return `409`.
