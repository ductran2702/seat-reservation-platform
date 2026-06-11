import { Router } from "express";
import { readPool } from "@srp/db";
import { asyncHandler, createInternalAuth } from "@srp/linkz-core";
import { env } from "../env.js";
import {
  getCachedSeats,
  setCachedSeats,
} from "../infrastructure/seatCache.js";

const { optionalAuth } = createInternalAuth(env.internalSecret);

export const seatsRouter = Router();

// Raw row shape shared by the readPool query and the Redis cache. Dates
// become ISO strings after a cache round-trip, hence string | Date.
interface SeatRow {
  id: string;
  label: string;
  reservation_id: string | null;
  reservation_status: "HELD" | "CONFIRMED" | null;
  reservation_user_id: string | null;
  hold_expires_at: string | Date | null;
}

// Public listing with live availability. Personalized (`mine`) when the
// gateway forwarded a verified user identity.
//
// Read path: Redis seat cache (10s TTL) → readPool (replica when
// DATABASE_READ_URL is set). ~100ms replica lag is acceptable for a listing;
// race-critical reads (hold creation) stay on the primary via Prisma.
seatsRouter.get(
  "/",
  optionalAuth,
  asyncHandler(async (req, res) => {
    const now = new Date();

    let rows = await getCachedSeats<SeatRow>();
    if (!rows) {
      // At most one HELD/CONFIRMED row per seat (partial unique index).
      // Prisma stores DateTime as `timestamp` (no tz) holding UTC wall time;
      // node-postgres would parse that as LOCAL time. AT TIME ZONE 'UTC'
      // converts it to timestamptz so the driver yields the correct instant.
      const result = await readPool.query<SeatRow>(
        `SELECT s.id,
                s.label,
                r.id           AS reservation_id,
                r.status::text AS reservation_status,
                r."userId"     AS reservation_user_id,
                r."holdExpiresAt" AT TIME ZONE 'UTC' AS hold_expires_at
           FROM "Seat" s
           LEFT JOIN "Reservation" r
             ON r."seatId" = s.id
            AND r.status IN ('HELD', 'CONFIRMED')
          ORDER BY s.label ASC`,
      );
      rows = result.rows;
      await setCachedSeats(rows);
    }

    const view = rows.map((row) => {
      const holdExpiresAt = row.hold_expires_at
        ? new Date(row.hold_expires_at)
        : null;
      // A HELD row past its expiry is effectively gone even if the sweeper
      // hasn't flipped it to EXPIRED yet.
      const active =
        row.reservation_status === "CONFIRMED" ||
        (row.reservation_status === "HELD" &&
          holdExpiresAt !== null &&
          holdExpiresAt > now);
      const mine = Boolean(
        active && req.userId && row.reservation_user_id === req.userId,
      );
      return {
        id: row.id,
        label: row.label,
        status: active ? row.reservation_status! : "AVAILABLE",
        mine,
        // Only expose the reservation handle/expiry to its owner.
        reservationId: mine ? row.reservation_id : null,
        holdExpiresAt:
          mine && row.reservation_status === "HELD"
            ? holdExpiresAt!.toISOString()
            : null,
      };
    });

    res.json({ seats: view });
  }),
);
