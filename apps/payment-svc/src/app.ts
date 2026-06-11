import express, { type Express } from "express";
import { prisma } from "@srp/db";
import { asyncHandler, errorHandler, notFound } from "@srp/linkz-core";
import { paymentsRouter } from "./routes/payments.js";

export function createApp(): Express {
  const app = express();
  app.set("trust proxy", 1);
  app.use(express.json());

  // Liveness: process is up.
  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok", service: "payment-svc" });
  });

  // Readiness: dependencies reachable — orchestrators must not route traffic
  // here before the DB connection works (throws → 500 → probe fails).
  app.get(
    "/api/ready",
    asyncHandler(async (_req, res) => {
      await prisma.$queryRaw`SELECT 1`;
      res.json({ status: "ready", service: "payment-svc" });
    }),
  );

  app.use("/api/payments", paymentsRouter);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}
