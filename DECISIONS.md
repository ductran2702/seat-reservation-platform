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
npm test          # automated integration tests (requires db:up)
```

> `npm run db:up` starts Postgres in Docker (host port **5434**). Demo login is
> seeded and printed by the seed script. See `README.md` for full setup and test
> instructions.

## 3. Architecture

- **Client:** Vite + React talks only to `/api`, which Vite proxies to Express in
  dev — so the browser sees one origin and cookies stay first-party.
- **API:** Express + TypeScript, organized into `routes / middleware / lib`.
- **DB:** PostgreSQL (docker-compose) accessed via Prisma.
- **Auth:** short-lived access JWT + long-lived (90d) **opaque** refresh token
  (48 random bytes — deliberately *not* a JWT, so the DB record is the single
  source of truth and the session is always revocable), both in httpOnly +
  Secure + SameSite=Strict cookies. Refresh tokens are stored **hashed**,
  **rotated atomically** (CAS inside a transaction) on every refresh, and
  **reuse of a rotated token burns all of the user's sessions** (theft signal).
- **Booking core:** a reservation row *is* a hold with an expiry; a **partial
  unique index** enforces "one active reservation per seat" at the database level.
- **UI flow:** single seats page — multi-select (≤2) → **Hold** → inline payment
  section (shared countdown, **Pay all** / failure / timeout, one **Cancel** for
  all holds). Confirmed seats do not count toward the hold limit.

```
React (Vite :5174) ──/api proxy──▶ Express (:4001) ──Prisma──▶ Postgres (:5434, Docker)
```

## 4. Key decisions

| Decision | Alternatives | Why | With more time |
| --- | --- | --- | --- |
| Express + TS API, separate Vite/React client | Next.js full-stack, tRPC | Clear server/client split; explicit control over cookies, middleware, and the concurrency code | Shared types package between client/server |
| PostgreSQL via docker-compose | SQLite, hosted Postgres | Real transactional + partial-index semantics; reproducible for reviewers | Managed Postgres + connection pooling (PgBouncer) |
| Access JWT + **opaque** refresh token, both in httpOnly+Secure+SameSite=Strict cookies | Refresh-token-as-JWT; localStorage; server sessions | A signed/stateless refresh token contradicts "90-day **revocable** session" — opaque + DB hash keeps revocation authoritative. XSS-safe (no JS access), CSRF-resistant (Strict); rotation is an atomic CAS; reuse of a rotated token revokes every session (theft detection) | Grace window to distinguish legit network retries from theft; device binding (DPoP); CSRF double-submit token |
| Client `Idempotency-Key` (UUID header) on hold creation, UNIQUE in DB | Rely only on natural keys (user+seat) | Retried POSTs (double-click, network blip) replay the original reservation instead of duplicating; UNIQUE constraint backstops concurrent retries | Same pattern on payment confirm against a real PSP (`payment_intent_id` as the natural key) |
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
per-user **hold** limit (`MAX_ACTIVE_RESERVATIONS_PER_USER`, default 2) by
counting only `status='HELD'` rows — **CONFIRMED reservations do not count**,
then (4) inserts the new hold; a unique-violation (Prisma `P2002`) means another
request already holds the seat, returned as `409 Conflict`. Hold creation also
accepts a client-generated **`Idempotency-Key`** (UNIQUE column): a retried
POST — double-click, network blip — returns the reservation created by the
first attempt instead of failing or duplicating. The seat-level
guarantee is hard (DB-enforced); the per-user hold limit is best-effort (a count,
not lock-serialized). Payment confirmation re-checks ownership and hold-expiry inside
a transaction before flipping `HELD → CONFIRMED` (so an expired hold can never be
paid into a confirmation); `fail` releases the seat (`FAILED`), `timeout` leaves
it `HELD` and retryable until expiry. A user can also voluntarily release a hold
via `DELETE /api/reservations/:id` (→ `CANCELLED`).

## 6. Security notes

- **Cookies:** `httpOnly` (no JS access → XSS-resistant), `Secure` (HTTPS only),
  `SameSite=Strict` (CSRF-resistant), refresh cookie `Path`-scoped to
  `/api/auth` (smaller attack surface), explicit `Max-Age`. The access token
  also lives in an httpOnly cookie (rather than response body + JS memory): no
  token is ever readable by script, at the cost of leaning on
  `SameSite=Strict` for CSRF.
- **Tokens:** access ~15m (JWT), refresh 90d (**opaque**, 48 random bytes);
  refresh tokens stored only as SHA-256 **hashes** (a DB leak exposes nothing
  replayable) and **rotated atomically** on each use — the revoke-old +
  issue-new happens in one transaction with a `revokedAt IS NULL` CAS guard,
  so two concurrent refreshes with the same token can never both win.
- **Reuse detection:** presenting an already-rotated/revoked refresh token is
  treated as theft — every active session for that user is revoked. (No grace
  window for lost-response retries; the cost is a forced re-login.)
- **Logout** revokes the session server-side (`revokedAt`), not just the
  cookie — a stolen copy of the token dies too.
- **Passwords:** bcrypt cost 12 (~150–250ms per hash — deliberate; it
  CPU-rate-limits login attempts); never logged or returned.
- **Rate limiting:** applied to login/auth endpoints to blunt credential
  stuffing/brute force. Broader rate limiting is **deferred — because** the 2h
  budget prioritizes the booking-correctness core; in production this would be
  Redis-backed and applied to all mutating routes.

## 7. What's intentionally missing

- **No real payment integration** — mock provider only (no webhooks or
  signature verification). The flow is still idempotent end-to-end
  (`Idempotency-Key` on holds; one-Payment-per-reservation UNIQUE + a
  CONFIRMED no-op on confirm); with a real PSP the **webhook** would be the
  source of truth, deduped on `payment_intent_id` (see `TODO(prod)` in
  `payments.ts`).
- **No background job** to expire holds — expiry is **lazy** (computed on read /
  on next hold attempt) instead of a scheduled sweeper.
- **Per-user reservation limit is best-effort** — enforced via a count inside the
  hold transaction, not a lock; under extreme concurrency a user could briefly
  exceed it. The *seat* double-booking guarantee is the hard, DB-enforced one.
- **No email verification, password reset, or MFA.**
- **No grace window on refresh-token reuse** — a legitimate client that lost
  the rotation response and retries will burn its own sessions and must log in
  again. Acceptable trade-off here; production would allow a short (~10s)
  window keyed on the replaced token.
- **No CSRF double-submit token** — relying on `SameSite=Strict` for this scope.
- **No realtime seat updates** (websockets/SSE) — client refetches availability.
- **No CSP / Helmet hardening, no audit logging, no observability/metrics.**
- **Limited automated test coverage** — `npm test` runs Vitest integration tests
  for the concurrency race, key failure paths (payment fail/timeout, expired
  hold, cancel, hold limit), and the auth session lifecycle (refresh-after-logout,
  rotation reuse → family burn, concurrent refresh race); the UI itself remains
  manually tested (see §8).
- **No production deployment / CI** — local-first per the assessment.

## 8. How to test failure paths

The payment API is two-step (`POST /api/payments/:id/intent` then
`POST /api/payments/:id/confirm?outcome=...`); the SPA calls both inline from
the seats page (no separate checkout route).

### Automated (`npm test`, requires `npm run db:up`)

| Test | Asserts |
| ---- | ------- |
| Concurrent holds on one seat | Exactly one `201` + one `409 seat_unavailable`; DB has one active row |
| Refresh after logout | `401` — logout revokes server-side, not just the cookie |
| Rotated token replayed | `401 refresh_token_reused`; **all** of the user's sessions revoked |
| Two concurrent refreshes, same token | Exactly one `200` — atomic CAS rotation |
| Payment `?outcome=fail` | Reservation `FAILED`; seat bookable by another user |
| Payment `?outcome=timeout` then `success` | Stays `HELD` after timeout; retry confirms |
| Expired hold + intent | `409 hold_expired` |
| `DELETE` held reservation | `CANCELLED`; seat freed |
| Confirmed + two new holds | CONFIRMED does not count toward hold limit |
| Third hold same user | `409 reservation_limit` |

### Manual (UI)

- **Hold expiry:** wait past `HOLD_TTL_SECONDS` (default **30s** in `.env`) —
  payment section disappears, seat returns to available.
- **Pay all success / failure / timeout:** use the inline payment buttons on the
  seats page.
- **Cancel all holds:** single **Cancel** button in the payment section.
