import { PrismaClient } from "@prisma/client";
import pg from "pg";

// All services share one Postgres database in this skeleton. Each service
// still owns its tables logically (auth-svc: User/RefreshToken, seat-svc:
// Seat/Reservation, payment-svc: Payment) — see DECISIONS.md for why the
// physical split is deferred.
export const prisma = new PrismaClient();

// ---------------------------------------------------------------------------
// Raw connection pools with a read/write split (SCALE: DB scaling skeleton).
// ---------------------------------------------------------------------------

// All INSERT/UPDATE/DELETE and race-critical SELECTs → primary.
export const writePool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
});

// Non-critical SELECTs → replica when DATABASE_READ_URL is set; falls back to
// the primary so there is zero regression without a replica.
// TODO(prod): set DATABASE_READ_URL to a Postgres read replica URL
// (AWS RDS read replica, Supabase replica, etc.) — no code change needed.
export const readPool = new pg.Pool({
  connectionString: process.env.DATABASE_READ_URL || process.env.DATABASE_URL,
});

// Session-level features (pg advisory locks used by the seat-svc sweeper) are
// NOT compatible with PgBouncer transaction-mode pooling — this pool must
// connect directly to the primary, bypassing any pooler.
export const directPool = new pg.Pool({
  connectionString:
    process.env.SWEEPER_DATABASE_URL || process.env.DATABASE_URL,
  max: 2,
});

export type { Payment, Reservation, Seat, User } from "@prisma/client";
export { Prisma } from "@prisma/client";
