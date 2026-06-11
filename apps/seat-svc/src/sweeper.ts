import type pg from "pg";
import { env } from "./env.js";
import { publishSeatChange } from "./events.js";

// Stable numeric key identifying this job across all seat-svc instances.
const LOCK_KEY = 1_001;

// Background hold-expiry sweeper: flips stale HELD rows to EXPIRED so seats
// free up on a clock instead of waiting for the next write (the lazy expiry
// inside the hold transaction remains as a correctness backstop).
//
// pg_try_advisory_lock makes the sweep single-flight across horizontally
// scaled seat-svc instances: whoever grabs the lock sweeps, everyone else
// skips the tick — no duplicate UPDATEs, no thundering herd.
//
// NOTE: advisory locks are session-level. This MUST run on a pool that
// connects directly to Postgres (SWEEPER_DATABASE_URL), bypassing PgBouncer:
// transaction-mode pooling reassigns the session between queries, which would
// orphan the lock.
export function startSweeper(pool: pg.Pool): NodeJS.Timeout {
  const tick = async (): Promise<void> => {
    const client = await pool.connect();
    let acquired = false;
    try {
      const { rows } = await client.query<{ acquired: boolean }>(
        "SELECT pg_try_advisory_lock($1) AS acquired",
        [LOCK_KEY],
      );
      acquired = Boolean(rows[0]?.acquired);
      if (!acquired) return; // another instance holds the lock — skip

      // "holdExpiresAt" is a tz-less timestamp holding UTC wall time (Prisma
      // convention) — compare against UTC NOW() so the result doesn't depend
      // on the session/server timezone.
      const expired = await client.query<{ seatId: string }>(
        `UPDATE "Reservation"
            SET status = 'EXPIRED', "updatedAt" = (NOW() AT TIME ZONE 'UTC')
          WHERE status = 'HELD'
            AND "holdExpiresAt" < (NOW() AT TIME ZONE 'UTC')
          RETURNING "seatId"`,
      );
      for (const row of expired.rows) {
        publishSeatChange({ type: "hold_expired", seatId: row.seatId });
      }
    } catch (err) {
      console.error("[sweeper] tick failed", err);
    } finally {
      if (acquired) {
        await client
          .query("SELECT pg_advisory_unlock($1)", [LOCK_KEY])
          .catch(() => undefined);
      }
      client.release();
    }
  };

  const interval = setInterval(tick, env.sweepIntervalMs);
  interval.unref();
  return interval;
}
