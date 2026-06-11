import express, { json, type Express } from "express";
import cookieParser from "cookie-parser";
import type { NextFunction, Request, Response } from "express";
import { readPool } from "@srp/db";
import {
  ACCESS_COOKIE,
  INTERNAL_SECRET_HEADER,
  USER_ID_HEADER,
  checkTokenVersion,
  verifyAccessToken,
} from "@srp/linkz-core";
import { env } from "./env.js";
import { serviceProxy } from "./proxy.js";
import { authLimiter } from "./rateLimit.js";
import { createInternalEventsHandler, createSseHandler } from "./sse.js";

export interface GatewayConfig {
  authSvcUrl: string;
  seatSvcUrl: string;
  paymentSvcUrl: string;
  internalSecret: string;
  accessTokenSecret: string;
}

// Resolves the caller's identity once, at the edge. Permissive by design:
// requests with a missing/invalid/version-bumped token continue as anonymous
// and the downstream service decides whether auth is required — this keeps
// public endpoints (seat listing) working with a stale cookie.
function createAttachUser(config: GatewayConfig) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    // Never trust client-supplied copies of the internal headers.
    delete req.headers[USER_ID_HEADER];
    delete req.headers[INTERNAL_SECRET_HEADER];

    const token = req.cookies?.[ACCESS_COOKIE];
    if (!token) {
      next();
      return;
    }
    let payload;
    try {
      payload = verifyAccessToken(token, config.accessTokenSecret);
    } catch {
      next();
      return;
    }
    // tokenVersion check: a logout (or refresh-token reuse burn) bumps the
    // user's version, killing this access token before its 15m expiry.
    checkTokenVersion(readPool, payload.sub, payload.ver)
      .then((valid) => {
        if (valid) req.userId = payload.sub;
        next();
      })
      .catch(next);
  };
}

// Builds the gateway without binding a port. Tests inject the ephemeral URLs
// of in-process service instances (see tests/e2e/helpers.ts).
export function createApp(overrides: Partial<GatewayConfig> = {}): Express {
  const config: GatewayConfig = {
    authSvcUrl: env.authSvcUrl,
    seatSvcUrl: env.seatSvcUrl,
    paymentSvcUrl: env.paymentSvcUrl,
    internalSecret: env.internalSecret,
    accessTokenSecret: env.accessTokenSecret,
    ...overrides,
  };

  const app = express();
  app.set("trust proxy", 1);
  // No global body parser: proxied requests must stream through untouched.
  app.use(cookieParser());
  app.use(createAttachUser(config));

  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok", service: "gateway" });
  });

  // Public client config (e.g. seat price for the payment summary).
  app.get("/api/config", (_req, res) => {
    res.json({
      seatPriceCents: env.seatPriceCents,
      holdTtlSeconds: env.holdTtlSeconds,
      maxActiveReservationsPerUser: env.maxActiveReservationsPerUser,
    });
  });

  // SSE fan-out: seat-svc reports changes in, browsers stream them out.
  app.post(
    "/internal/events",
    json(),
    createInternalEventsHandler(config.internalSecret),
  );
  app.get(
    "/api/seats/stream",
    createSseHandler({
      seatSvcUrl: config.seatSvcUrl,
      internalSecret: config.internalSecret,
    }),
  );

  // Defense in depth on credential endpoints (nginx rate-limits these too).
  app.use(
    ["/api/auth/login", "/api/auth/register", "/api/auth/refresh"],
    authLimiter,
  );

  app.use(serviceProxy("/api/auth", config.authSvcUrl, config.internalSecret));
  app.use(
    serviceProxy(
      ["/api/seats", "/api/reservations"],
      config.seatSvcUrl,
      config.internalSecret,
    ),
  );
  app.use(
    serviceProxy("/api/payments", config.paymentSvcUrl, config.internalSecret),
  );

  app.use((_req, res) => {
    res.status(404).json({ error: "not_found" });
  });

  return app;
}
