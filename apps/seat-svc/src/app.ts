import express, { type Express } from "express";
import { prisma } from "@srp/db";
import {
  INTERNAL_SECRET_HEADER,
  asyncHandler,
  errorHandler,
  notFound,
} from "@srp/linkz-core";
import { env } from "./env.js";
import { publishSeatChange } from "./events.js";
import { reservationsRouter } from "./routes/reservations.js";
import { seatsRouter } from "./routes/seats.js";

export function createApp(): Express {
  const app = express();
  app.set("trust proxy", 1);
  app.use(express.json());

  // Liveness: process is up.
  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok", service: "seat-svc" });
  });

  // Readiness: dependencies reachable — orchestrators must not route traffic
  // here before the DB connection works (throws → 500 → probe fails).
  app.get(
    "/api/ready",
    asyncHandler(async (_req, res) => {
      await prisma.$queryRaw`SELECT 1`;
      res.json({ status: "ready", service: "seat-svc" });
    }),
  );

  // Internal: payment-svc reports the seat-state mutations it performed
  // (confirm → CONFIRMED, fail → released) so cache invalidation and SSE
  // fan-out always flow through seat-svc, the write authority for seat state.
  app.post("/internal/seat-changed", (req, res) => {
    if (req.get(INTERNAL_SECRET_HEADER) !== env.internalSecret) {
      res.status(401).json({ error: "untrusted_caller" });
      return;
    }
    publishSeatChange(
      typeof req.body === "object" && req.body !== null && "type" in req.body
        ? req.body
        : { type: "seat_change" },
    );
    res.json({ ok: true });
  });

  app.use("/api/seats", seatsRouter);
  app.use("/api/reservations", reservationsRouter);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}
