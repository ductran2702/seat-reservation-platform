import express, { type Express } from "express";
import cookieParser from "cookie-parser";
import { prisma } from "@srp/db";
import { asyncHandler, errorHandler, notFound } from "@srp/linkz-core";
import { authRouter } from "./routes/auth.js";

// Builds the Express app without binding a port, so tests can mount it on an
// ephemeral port behind a test gateway (see tests/e2e/helpers.ts).
export function createApp(): Express {
  const app = express();
  app.set("trust proxy", 1);
  app.use(express.json());
  app.use(cookieParser());

  // Liveness: process is up.
  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok", service: "auth-svc" });
  });

  // Readiness: dependencies reachable — orchestrators must not route traffic
  // here before the DB connection works (throws → 500 → probe fails).
  app.get(
    "/api/ready",
    asyncHandler(async (_req, res) => {
      await prisma.$queryRaw`SELECT 1`;
      res.json({ status: "ready", service: "auth-svc" });
    }),
  );

  app.use("/api/auth", authRouter);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}
