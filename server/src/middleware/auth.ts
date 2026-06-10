import type { NextFunction, Request, Response } from "express";
import { ACCESS_COOKIE } from "../lib/cookies.js";
import { verifyAccessToken } from "../lib/tokens.js";

export function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const token = req.cookies?.[ACCESS_COOKIE];
  if (!token) {
    res.status(401).json({ error: "unauthenticated" });
    return;
  }
  try {
    const payload = verifyAccessToken(token);
    req.userId = payload.sub;
    next();
  } catch {
    res.status(401).json({ error: "invalid_token" });
  }
}

// Attaches req.userId when a valid access cookie is present, but never blocks.
// Used by public endpoints that personalize their response when logged in.
export function optionalAuth(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  const token = req.cookies?.[ACCESS_COOKIE];
  if (token) {
    try {
      req.userId = verifyAccessToken(token).sub;
    } catch {
      // Ignore invalid/expired tokens for optional auth.
    }
  }
  next();
}
