import { prisma } from "@srp/db";
import { INTERNAL_SECRET_HEADER } from "@srp/linkz-core";
import { env } from "./env.js";

// Transactional outbox worker (payment pattern B): events are inserted in the
// SAME Prisma transaction as the payment/reservation mutation (see
// routes/payments.ts), then delivered here at-least-once by a DB poll worker.
// A mock provider has no webhook to verify, so Pattern A (HMAC-verified
// webhook + outbox) is not applicable — see DECISIONS.md.
//
// Delivery target: seat-svc /internal/seat-changed (cache invalidation + SSE
// fan-out). The consumer side is idempotent, so duplicate delivery is safe.
// TODO(prod): swap the poll loop for a Kafka/RabbitMQ producer-consumer pair;
// the outbox table and ack semantics stay identical.

const MAX_ATTEMPTS = 5;
const BATCH_SIZE = 20;

interface SeatChangePayload {
  seatId?: string;
}

async function deliver(type: string, payload: SeatChangePayload): Promise<void> {
  const res = await fetch(`${env.seatSvcUrl}/internal/seat-changed`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      [INTERNAL_SECRET_HEADER]: env.internalSecret,
    },
    body: JSON.stringify({ type, seatId: payload.seatId }),
  });
  if (!res.ok) {
    throw new Error(`seat-svc responded ${res.status}`);
  }
}

export function startOutboxWorker(): NodeJS.Timeout {
  let running = false;

  const tick = async (): Promise<void> => {
    if (running) return; // never overlap a slow tick
    running = true;
    try {
      const events = await prisma.outboxEvent.findMany({
        where: { status: "PENDING" },
        orderBy: { createdAt: "asc" },
        take: BATCH_SIZE,
      });

      for (const event of events) {
        // Claim via CAS on (status, attempts): if another worker instance
        // already bumped attempts or finished the event, we skip it.
        // TODO(prod): SELECT ... FOR UPDATE SKIP LOCKED for stricter
        // single-flight claiming under many worker instances.
        const claimed = await prisma.outboxEvent.updateMany({
          where: { id: event.id, status: "PENDING", attempts: event.attempts },
          data: { attempts: { increment: 1 } },
        });
        if (claimed.count === 0) continue;

        try {
          // External call FIRST, ack AFTER — an event is only marked
          // PROCESSED once delivery actually succeeded. A crash between the
          // two redelivers (at-least-once); the consumer is idempotent.
          // (Never ack in a finally block — a failed delivery must stay
          // PENDING for retry, not silently leave the queue.)
          await deliver(event.type, event.payload as SeatChangePayload);
          await prisma.outboxEvent.update({
            where: { id: event.id },
            data: { status: "PROCESSED", processedAt: new Date() },
          });
        } catch (err) {
          // Bounded retries → DEAD letter, so a poison event can't block the
          // queue forever. DEAD rows are kept for inspection/alerting.
          const dead = event.attempts + 1 >= MAX_ATTEMPTS;
          await prisma.outboxEvent.update({
            where: { id: event.id },
            data: {
              status: dead ? "DEAD" : "PENDING",
              lastError: err instanceof Error ? err.message : String(err),
            },
          });
          if (dead) {
            console.error(
              JSON.stringify({
                action: "outbox_event_dead",
                eventId: event.id,
                type: event.type,
                attempts: event.attempts + 1,
                lastError: err instanceof Error ? err.message : String(err),
              }),
            );
          }
        }
      }
    } catch (err) {
      console.error(
        JSON.stringify({
          action: "outbox_tick_failed",
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    } finally {
      running = false;
    }
  };

  const interval = setInterval(tick, env.outboxPollIntervalMs);
  interval.unref();
  return interval;
}
