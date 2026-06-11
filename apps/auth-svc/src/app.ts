import express, { type Express } from "express";
import cookieParser from "cookie-parser";
import { errorHandler, notFound } from "@srp/linkz-core";
import { authRouter } from "./routes/auth.js";

// Builds the Express app without binding a port, so tests can mount it on an
// ephemeral port behind a test gateway (see tests/e2e/helpers.ts).
export function createApp(): Express {
  const app = express();
  app.set("trust proxy", 1);
  app.use(express.json());
  app.use(cookieParser());

  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok", service: "auth-svc" });
  });

  app.use("/api/auth", authRouter);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}
