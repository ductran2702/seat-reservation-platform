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
npm run dev       # gateway + auth/seat/payment services + Vite/React client
npm test          # automated integration tests through the gateway (requires db:up)
make up           # alternatively: the full dockerized stack behind nginx :80
```

> `npm run db:up` starts Postgres (host port **5434**) and Redis in Docker.
> Demo login is seeded and printed by the seed script. See `README.md` for full
> setup and test instructions.

## 3. Architecture

- **Topology:** microservices skeleton — an HTTP **gateway** (:3000) in front
  of **auth-svc** (:3001), **seat-svc** (:3002) and **payment-svc** (:3003),
  fronted by **nginx** (:80) in the dockerized stack. The gateway verifies the
  access cookie once (JWT + `tokenVersion`) and forwards the identity to
  services via the `X-User-Id` header, authenticated with a shared
  `X-Internal-Secret` — services never parse cookies or JWTs themselves.
- **Service boundaries:**

| Service | Why separate |
| --- | --- |
| `auth-svc` | Isolated blast radius for credentials; bcrypt is CPU-bound → scale independently |
| `seat-svc` | Write authority for seat state; owns the partial-unique-index invariant, the expiry sweeper, and the seat cache; no schema shared with payment logic |
| `payment-svc` | PCI scope isolation; payment secrets not exposed to other services |
| `gateway` | Single entry point; centralized rate limiting; SSE fan-out; auth context attached once |

- **Client:** Vite + React talks only to `/api`, which Vite proxies to the
  gateway in dev — so the browser sees one origin and cookies stay first-party.
- **Services:** Express + TypeScript, organized into `routes / lib`, sharing
  middleware via `packages/linkz-core`.
- **DB:** PostgreSQL (docker-compose, behind PgBouncer in the full stack)
  accessed via Prisma, plus raw `pg` pools with a read/write split
  (`packages/db`). One shared database in this skeleton — each service owns
  its tables logically; the physical split (DB per service) is deferred.
- **Ops:** every service exposes `/api/health` (liveness) and `/api/ready`
  (DB-ping readiness, wired into compose healthchecks), drains in-flight
  requests on SIGTERM/SIGINT (10s force-exit; background timers stopped, pools
  disconnected), validates env vars at startup (presence + positive-integer),
  and logs structured JSON with an `action` field (`payment_success`,
  `payment_failure`, `unhandled_error`, `outbox_event_dead`, …).
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
React ──▶ nginx :80 ──▶ gateway :3000 ──▶ auth-svc :3001 / seat-svc :3002 / payment-svc :3003
                                              │                 │
                                              └── Postgres (+PgBouncer) ── Redis (cache)
```

(See `README.md` for the full architecture diagram.)

## 4. Key decisions

| Decision | Alternatives | Why | With more time |
| --- | --- | --- | --- |
| Microservices (gateway + auth + seat + payment) | Express monolith | Isolated blast radius per domain; auth-svc scales independently (bcrypt is CPU-bound); PCI scope isolation for payment; seat-svc is the single write authority for seat state | Kafka/async messaging between services; dedicated DB per service; Kubernetes HPA per pod |
| Shared `packages/linkz-core` for auth middleware | Duplicate per service | Auth logic must be identical everywhere; one security fix propagates to every service | Pin to semver, test in CI before updating |
| Gateway as single entry point (`X-User-Id` + `X-Internal-Secret` internal headers) | Direct client → service; mTLS between services | Centralized rate limiting; one TLS termination; auth context verified once at the edge; services stay cookie/JWT-free | Service mesh (Istio) for mTLS; distributed tracing; per-service authz policies |
| Express + TS services, separate Vite/React client | Next.js full-stack, tRPC | Clear server/client split; explicit control over cookies, middleware, and the concurrency code | Shared types package between client/server |
| PostgreSQL via docker-compose | SQLite, hosted Postgres | Real transactional + partial-index semantics; reproducible for reviewers | Managed Postgres + connection pooling (PgBouncer) |
| Access JWT + **opaque** refresh token, both in httpOnly+Secure+SameSite=Strict cookies | Refresh-token-as-JWT; localStorage; server sessions | A signed/stateless refresh token contradicts "90-day **revocable** session" — opaque + DB hash keeps revocation authoritative. XSS-safe (no JS access), CSRF-resistant (Strict); rotation is an atomic CAS; reuse of a rotated token revokes every session (theft detection) | Grace window to distinguish legit network retries from theft; device binding (DPoP); CSRF double-submit token |
| Client `Idempotency-Key` (UUID header) on hold creation, UNIQUE in DB | Rely only on natural keys (user+seat) | Retried POSTs (double-click, network blip) replay the original reservation instead of duplicating; UNIQUE constraint backstops concurrent retries | Same pattern on payment confirm against a real PSP (`payment_intent_id` as the natural key) |
| Hold-with-expiry + partial unique index | `SELECT ... FOR UPDATE`, optimistic version check | DB is the single source of truth for "one active row per seat"; survives races without app-level locking | Redis ZSET hold TTLs to take expiry pressure off Postgres |
| Background sweeper with `pg_try_advisory_lock` (seat-svc) | Lazy expiry only; cron container; Redis ZSET | Seats free up on a clock, not on the next write; the advisory lock makes the sweep single-flight across scaled instances; lazy expiry stays as backstop | Redis ZSET + keyspace notifications; emit per-seat metrics |
| SSE (`/api/seats/stream`) with in-process fan-out at the gateway + polling fallback | WebSockets; polling only | One-way availability push fits SSE exactly (auto-reconnect for free, plain HTTP through nginx); polling fallback keeps the UI correct if the stream drops | Redis pub/sub (`srp:seat_changes`) so fan-out works across multiple gateway pods (until then: sticky sessions, see nginx.conf) |
| Redis seat cache (10s TTL, invalidated on every mutation) + read/write pool split | Always hit primary | Seat list is the hottest read; cache + replica-ready `readPool` keep the primary for race-critical writes; both degrade to no-op/primary when unset — zero regression | Read-your-writes guards per user; cache stampede protection (single-flight) |
| Two-step mock payment (intent → checkout URL → confirm callback) with `?outcome=` | Single synchronous endpoint; Stripe test mode | Mirrors a real redirect/callback flow and deterministically exercises success / fail / timeout without external deps | Real provider webhook + idempotency keys + signature verification |
| Payment events: **Pattern B** — transactional outbox + DB poll worker | Pattern A (internet-facing webhook, HMAC `timingSafeEqual` + outbox); fire-and-forget HTTP | Mock provider has no real webhook to verify, so an internal event flow is the honest fit. Outbox row commits in the **same TX** as the payment/reservation flip (crash can't confirm without enqueueing); worker acks **only after** successful delivery (at-least-once; consumer idempotent); bounded retries → DEAD letter so a poison event never blocks the queue. Trade-off: DB polling adds ~1s latency and load vs a broker. Switching to a real PSP (Stripe) means Pattern A: HMAC-verified webhook as source of truth, deduped on `payment_intent_id`, same outbox underneath | Kafka/RabbitMQ consumer instead of the poll loop; `SELECT … FOR UPDATE SKIP LOCKED` claiming; refunds as compensating events; DEAD-letter alerting |
| Layered rate limiting: nginx per-IP zones + gateway express-rate-limit on auth | Rate limit everything; none | Credential endpoints are the highest-value target; two independent layers (edge + app) survive either being bypassed | Redis-backed shared counters (limits currently reset per instance/restart), per-account limits, lockout |
| Vite/React SPA, plain CSS, React Router, native fetch, SSE + polling fallback | Next.js, Tailwind, TanStack Query, WebSockets | Few deps, fast to build, clearly demonstrates the flow; SSE pushes availability live, polling guards drift/disconnects | Optimistic UI, component/e2e tests |
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
- **Access-token revocation (`tokenVersion`):** every access JWT embeds the
  user's `tokenVersion` (`ver` claim); `requireAuth` compares it against the
  User row, and logout / refresh-token reuse **increments** it — so a stolen
  access token dies immediately instead of staying valid until its 15m expiry.
  (TODO(prod): cache the version in Redis ~30s to avoid the per-request read.)
- **Timing-safe login:** when the email is unknown, login still runs bcrypt
  against a precomputed dummy hash — the unknown-email and wrong-password
  paths cost the same ~200ms, closing the user-enumeration timing oracle.
- **Service-to-service trust:** internal services only accept a user identity
  (`X-User-Id`) when the request carries the shared `X-Internal-Secret`; the
  gateway strips both headers from inbound client traffic so they can't be
  spoofed.
- **Reuse detection:** presenting an already-rotated/revoked refresh token is
  treated as theft — every active session for that user is revoked. (No grace
  window for lost-response retries; the cost is a forced re-login.)
- **Logout** revokes the session server-side (`revokedAt`), not just the
  cookie — a stolen copy of the token dies too.
- **Passwords:** bcrypt cost 12 (~150–250ms per hash — deliberate; it
  CPU-rate-limits login attempts); never logged or returned.
- **Rate limiting:** two layers — nginx per-IP zones (auth 10r/m, api 300r/m)
  at the edge, plus express-rate-limit on the credential endpoints in the
  gateway. Both are per-instance in-memory; production would back them with
  Redis so limits hold across replicas and restarts.

## 7. What's intentionally missing

- **No real payment integration** — mock provider only (no webhooks or
  signature verification). The flow is still idempotent end-to-end
  (`Idempotency-Key` on holds; one-Payment-per-reservation UNIQUE + a
  CONFIRMED no-op on confirm); with a real PSP the **webhook** would be the
  source of truth, deduped on `payment_intent_id` (see `TODO(prod)` in
  `payments.ts`).
- **One shared Postgres database** across services — each service owns its
  tables logically, but there is no physical isolation; a dedicated DB (or at
  least schema) per service is the production follow-up, together with async
  messaging (e.g. Kafka) instead of the current synchronous HTTP hops.
- **SSE fan-out is in-process** at the gateway — scaling the gateway past one
  pod needs either sticky sessions (stubbed in `nginx.conf`) or the
  `TODO(prod)` Redis pub/sub channel.
- **Per-user reservation limit is best-effort** — enforced via a count inside the
  hold transaction, not a lock; under extreme concurrency a user could briefly
  exceed it. The *seat* double-booking guarantee is the hard, DB-enforced one.
- **No email verification, password reset, or MFA.**
- **No grace window on refresh-token reuse** — a legitimate client that lost
  the rotation response and retries will burn its own sessions and must log in
  again. Acceptable trade-off here; production would allow a short (~10s)
  window keyed on the replaced token.
- **No CSRF double-submit token** — relying on `SameSite=Strict` for this scope.
- **No CSP / Helmet hardening, no audit logging** (nginx adds
  `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`).
- **Observability is logs-only** — structured JSON with `action` fields
  (payment success/failure, dead outbox events, unhandled errors) that an
  aggregator can alert on; no metrics endpoint, tracing, or dashboards.
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
