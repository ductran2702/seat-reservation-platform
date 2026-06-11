import express, { type Express } from "express";
import { errorHandler, notFound } from "@srp/linkz-core";
import { paymentsRouter } from "./routes/payments.js";

export function createApp(): Express {
  const app = express();
  app.set("trust proxy", 1);
  app.use(express.json());

  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok", service: "payment-svc" });
  });

  app.use("/api/payments", paymentsRouter);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}
