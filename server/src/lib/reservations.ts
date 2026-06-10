import type { Payment, Reservation, Seat } from "@prisma/client";

export const ACTIVE_STATUSES = ["HELD", "CONFIRMED"] as const;

// A HELD reservation past its expiry is effectively gone even if a sweep
// hasn't yet flipped it to EXPIRED in the DB.
export function isActive(reservation: Reservation, now = new Date()): boolean {
  if (reservation.status === "CONFIRMED") return true;
  if (reservation.status === "HELD") return reservation.holdExpiresAt > now;
  return false;
}

export function effectiveStatus(
  reservation: Reservation,
  now = new Date(),
): Reservation["status"] {
  if (reservation.status === "HELD" && reservation.holdExpiresAt <= now) {
    return "EXPIRED";
  }
  return reservation.status;
}

export interface ReservationView {
  id: string;
  seatId: string;
  seatLabel: string | null;
  status: Reservation["status"];
  holdExpiresAt: string;
  confirmedAt: string | null;
  paymentStatus: Payment["status"] | null;
  createdAt: string;
}

export function toReservationView(
  reservation: Reservation & { seat?: Seat | null; payment?: Payment | null },
  now = new Date(),
): ReservationView {
  return {
    id: reservation.id,
    seatId: reservation.seatId,
    seatLabel: reservation.seat?.label ?? null,
    status: effectiveStatus(reservation, now),
    holdExpiresAt: reservation.holdExpiresAt.toISOString(),
    confirmedAt: reservation.confirmedAt?.toISOString() ?? null,
    paymentStatus: reservation.payment?.status ?? null,
    createdAt: reservation.createdAt.toISOString(),
  };
}
