-- Enforces the core booking invariant at the database level:
-- at most ONE active (HELD or CONFIRMED) reservation may exist per seat.
-- Prisma's schema cannot express filtered/partial unique indexes, so this is
-- applied idempotently right after `prisma db push`.
CREATE UNIQUE INDEX IF NOT EXISTS reservation_active_seat_ux
  ON "Reservation" ("seatId")
  WHERE status IN ('HELD', 'CONFIRMED');
