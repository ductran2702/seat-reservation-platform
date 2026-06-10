import express from "express";
import cookieParser from "cookie-parser";
import { env } from "./lib/env.js";
import { authRouter } from "./routes/auth.js";
import { seatsRouter } from "./routes/seats.js";
import { reservationsRouter } from "./routes/reservations.js";
import { paymentsRouter } from "./routes/payments.js";
import { errorHandler, notFound } from "./middleware/errors.js";

const app = express();
app.set("trust proxy", 1);
app.use(express.json());
app.use(cookieParser());

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok" });
});

// Public client config (e.g. seat price for the payment summary).
app.get("/api/config", (_req, res) => {
  res.json({
    seatPriceCents: env.seatPriceCents,
    holdTtlSeconds: env.holdTtlSeconds,
    maxActiveReservationsPerUser: env.maxActiveReservationsPerUser,
  });
});

app.use("/api/auth", authRouter);
app.use("/api/seats", seatsRouter);
app.use("/api/reservations", reservationsRouter);
app.use("/api/payments", paymentsRouter);

app.use(notFound);
app.use(errorHandler);

app.listen(env.port, () => {
  console.log(`API listening on http://localhost:${env.port}`);
});
