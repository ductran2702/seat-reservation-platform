import { prisma } from "@srp/db";
import { publishSeatChange } from "./events.js";

// Per-hold expiry timers: fire `hold_expired` the moment a hold's countdown
// hits 0 instead of waiting for the next sweeper tick (sweeper.ts stays as
// the backstop for missed timers, restarts, and clock drift).
//
// Safe under races and horizontal scaling: the flip is a guarded UPDATE
// (status='HELD' AND holdExpiresAt <= now), so a hold that was cancelled,
// confirmed, or already expired by another instance/the sweeper matches zero
// rows and no event is published.

// Fire slightly after the stored expiry so the guard comparison passes even
// with minor clock differences between app and DB.
const FIRE_BUFFER_MS = 250;

const timers = new Map<string, NodeJS.Timeout>();

async function expireHold(reservationId: string, seatId: string): Promise<void> {
  timers.delete(reservationId);
  try {
    const { count } = await prisma.reservation.updateMany({
      where: {
        id: reservationId,
        status: "HELD",
        holdExpiresAt: { lte: new Date() },
      },
      data: { status: "EXPIRED" },
    });
    if (count > 0) {
      publishSeatChange({ type: "hold_expired", seatId });
    }
  } catch (err) {
    // Best-effort — the sweeper will pick this hold up on its next tick.
    console.error("[expiry-scheduler] failed to expire hold", reservationId, err);
  }
}

export function scheduleHoldExpiry(reservation: {
  id: string;
  seatId: string;
  holdExpiresAt: Date;
}): void {
  cancelHoldExpiry(reservation.id);
  const delay = Math.max(
    0,
    reservation.holdExpiresAt.getTime() - Date.now() + FIRE_BUFFER_MS,
  );
  const timer = setTimeout(() => {
    void expireHold(reservation.id, reservation.seatId);
  }, delay);
  timer.unref();
  timers.set(reservation.id, timer);
}

// Clears the timer when a hold leaves HELD early (cancel). Letting a stale
// timer fire is harmless (guarded UPDATE), this just avoids the wasted query.
export function cancelHoldExpiry(reservationId: string): void {
  const timer = timers.get(reservationId);
  if (timer) {
    clearTimeout(timer);
    timers.delete(reservationId);
  }
}

// On boot, re-arm timers for holds created before this process started (or by
// another instance); duplicates across instances are deduped by the guarded
// UPDATE — only the winner publishes the event.
export async function scheduleExistingHolds(): Promise<void> {
  try {
    const holds = await prisma.reservation.findMany({
      where: { status: "HELD" },
      select: { id: true, seatId: true, holdExpiresAt: true },
    });
    for (const hold of holds) {
      scheduleHoldExpiry(hold);
    }
    if (holds.length > 0) {
      console.log(`[expiry-scheduler] re-armed ${holds.length} hold timer(s)`);
    }
  } catch (err) {
    console.error("[expiry-scheduler] failed to schedule existing holds", err);
  }
}
