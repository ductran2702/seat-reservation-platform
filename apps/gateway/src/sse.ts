import { EventEmitter } from "node:events";
import type { Request, RequestHandler, Response } from "express";
import { INTERNAL_SECRET_HEADER, USER_ID_HEADER } from "@srp/linkz-core";

// In-process fan-out bus: seat-svc POSTs every seat state change to
// /internal/events and each connected SSE client gets it pushed.
// TODO(prod): replace with Redis pub/sub on channel 'srp:seat_changes' for
// multi-instance gateways — each gateway pod subscribes, seat-svc publishes
// on every seat state change. Until then, scale-out needs sticky sessions
// (see infra/nginx/nginx.conf).
export const seatEvents = new EventEmitter();
seatEvents.setMaxListeners(0); // one listener per connected SSE client

export interface SeatChangeEvent {
  type: string;
  seatId?: string;
}

// Internal ingestion endpoint handler — seat-svc (and only seat-svc, proven
// by the shared secret) reports seat state mutations here.
export function createInternalEventsHandler(
  internalSecret: string,
): RequestHandler {
  return (req: Request, res: Response): void => {
    if (req.get(INTERNAL_SECRET_HEADER) !== internalSecret) {
      res.status(401).json({ error: "untrusted_caller" });
      return;
    }
    const event: SeatChangeEvent =
      typeof req.body === "object" && req.body !== null && "type" in req.body
        ? (req.body as SeatChangeEvent)
        : { type: "seat_change" };
    seatEvents.emit("seat_change", event);
    res.json({ ok: true });
  };
}

export interface SseOptions {
  seatSvcUrl: string;
  internalSecret: string;
}

// GET /api/seats/stream — long-lived SSE connection pushing live seat
// availability, replacing the client's 3s polling loop. Auth was already
// resolved by attachUser (req.userId).
export function createSseHandler({
  seatSvcUrl,
  internalSecret,
}: SseOptions): RequestHandler {
  return (req: Request, res: Response): void => {
    if (!req.userId) {
      res.status(401).json({ error: "unauthenticated" });
      return;
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    const send = (event: string, data: unknown): void => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    // Initial snapshot via an internal seat-svc call, personalized for the
    // connected user so `mine`/reservation handles are correct.
    fetch(`${seatSvcUrl}/api/seats`, {
      headers: {
        [INTERNAL_SECRET_HEADER]: internalSecret,
        [USER_ID_HEADER]: req.userId,
      },
    })
      .then((r) => r.json())
      .then((data) => send("snapshot", data))
      .catch(() => {
        // Client falls back to fetching the list itself.
      });

    const onChange = (event: SeatChangeEvent): void => {
      send("seat_change", event);
    };
    seatEvents.on("seat_change", onChange);

    // Comment-only frames keep intermediaries (nginx, LBs) from idling out
    // the connection.
    const heartbeat = setInterval(() => res.write(": ping\n\n"), 25_000);

    req.on("close", () => {
      seatEvents.off("seat_change", onChange);
      clearInterval(heartbeat);
    });
  };
}
