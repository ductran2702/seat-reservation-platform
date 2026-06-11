import { INTERNAL_SECRET_HEADER } from "@srp/linkz-core";
import { env } from "./env.js";
import { invalidateSeatCache } from "./infrastructure/seatCache.js";

export interface SeatChangeEvent {
  type: string;
  seatId?: string;
}

// Called after EVERY seat state mutation (hold created, hold cancelled, hold
// expired, reservation confirmed/failed — payment-svc reports its mutations
// via POST /internal/seat-changed). Invalidates the Redis seat cache and fans
// the event out to connected SSE clients through the gateway.
//
// TODO(prod): replace the HTTP hop with Redis pub/sub on channel
// 'srp:seat_changes' — seat-svc publishes, every gateway pod subscribes, so
// SSE fan-out keeps working when the gateway scales horizontally.
export function publishSeatChange(event: SeatChangeEvent): void {
  void invalidateSeatCache();
  fetch(`${env.gatewayUrl}/internal/events`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      [INTERNAL_SECRET_HEADER]: env.internalSecret,
    },
    body: JSON.stringify(event),
  }).catch(() => {
    // Fire-and-forget: SSE clients keep a polling fallback, so a missed
    // event only delays the UI by one poll interval.
  });
}
