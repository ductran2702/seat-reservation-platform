import crypto from "node:crypto";
import { Router } from "express";
import type { Response } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { hashPassword, verifyPassword } from "../lib/password.js";
import {
  generateRefreshToken,
  hashToken,
  signAccessToken,
} from "../lib/tokens.js";
import {
  REFRESH_COOKIE,
  clearAuthCookies,
  setAuthCookies,
} from "../lib/cookies.js";
import { REFRESH_COOKIE_MAX_AGE_MS } from "../lib/env.js";
import { ApiError, asyncHandler } from "../middleware/errors.js";
import { requireAuth } from "../middleware/auth.js";
import { authLimiter } from "../middleware/rateLimit.js";

export const authRouter = Router();

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(200),
  name: z.string().min(1).max(120),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

interface PublicUser {
  id: string;
  email: string;
  name: string;
  createdAt: Date;
}

function toPublicUser(user: {
  id: string;
  email: string;
  name: string;
  createdAt: Date;
}): PublicUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    createdAt: user.createdAt,
  };
}

// Issues a fresh access token + a DB-tracked opaque refresh token and sets
// cookies. Only the SHA-256 hash of the refresh token is persisted.
async function issueSession(res: Response, userId: string): Promise<void> {
  const refreshToken = generateRefreshToken();
  const accessToken = signAccessToken(userId);
  await prisma.refreshToken.create({
    data: {
      userId,
      tokenHash: hashToken(refreshToken),
      expiresAt: new Date(Date.now() + REFRESH_COOKIE_MAX_AGE_MS),
    },
  });
  setAuthCookies(res, accessToken, refreshToken);
}

authRouter.post(
  "/register",
  authLimiter,
  asyncHandler(async (req, res) => {
    const { email, password, name } = registerSchema.parse(req.body);
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      throw new ApiError(409, "email_taken", "Email is already registered");
    }
    const user = await prisma.user.create({
      data: { email, name, passwordHash: await hashPassword(password) },
    });
    await issueSession(res, user.id);
    res.status(201).json({ user: toPublicUser(user) });
  }),
);

authRouter.post(
  "/login",
  authLimiter,
  asyncHandler(async (req, res) => {
    const { email, password } = loginSchema.parse(req.body);
    const user = await prisma.user.findUnique({ where: { email } });
    // Same error for unknown email and wrong password to avoid user enumeration.
    if (!user || !(await verifyPassword(password, user.passwordHash))) {
      throw new ApiError(401, "invalid_credentials", "Invalid email or password");
    }
    await issueSession(res, user.id);
    res.json({ user: toPublicUser(user) });
  }),
);

authRouter.post(
  "/refresh",
  authLimiter,
  asyncHandler(async (req, res) => {
    const token = req.cookies?.[REFRESH_COOKIE] as string | undefined;
    if (!token) {
      throw new ApiError(401, "no_refresh_token");
    }

    const record = await prisma.refreshToken.findUnique({
      where: { tokenHash: hashToken(token) },
    });
    if (!record) {
      clearAuthCookies(res);
      throw new ApiError(401, "invalid_refresh_token");
    }

    // Reuse detection: an already-rotated/revoked token being presented again
    // is a theft signal — burn every active session for this user so a stolen
    // cookie can't keep a session alive.
    if (record.revokedAt) {
      await prisma.refreshToken.updateMany({
        where: { userId: record.userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      clearAuthCookies(res);
      throw new ApiError(401, "refresh_token_reused");
    }
    if (record.expiresAt <= new Date()) {
      clearAuthCookies(res);
      throw new ApiError(401, "refresh_token_expired");
    }

    // Rotate atomically: CAS-revoke the presented token (guarded on
    // revokedAt IS NULL) and issue the replacement in the SAME transaction.
    // If two requests race with the same token, exactly one wins the CAS;
    // the loser gets a 401 instead of a second valid token pair.
    const newId = crypto.randomUUID();
    const newRefresh = generateRefreshToken();
    const newAccess = signAccessToken(record.userId);
    const rotated = await prisma.$transaction(async (tx) => {
      const revoked = await tx.refreshToken.updateMany({
        where: { id: record.id, revokedAt: null },
        data: { revokedAt: new Date(), replacedById: newId },
      });
      if (revoked.count === 0) {
        return false;
      }
      await tx.refreshToken.create({
        data: {
          id: newId,
          userId: record.userId,
          tokenHash: hashToken(newRefresh),
          expiresAt: new Date(Date.now() + REFRESH_COOKIE_MAX_AGE_MS),
        },
      });
      return true;
    });
    if (!rotated) {
      clearAuthCookies(res);
      throw new ApiError(401, "invalid_refresh_token");
    }

    setAuthCookies(res, newAccess, newRefresh);
    res.json({ ok: true });
  }),
);

authRouter.post(
  "/logout",
  asyncHandler(async (req, res) => {
    const token = req.cookies?.[REFRESH_COOKIE] as string | undefined;
    if (token) {
      // Server-side revocation is mandatory: clearing the cookie alone would
      // leave a stolen copy of the token usable until it expires.
      await prisma.refreshToken.updateMany({
        where: { tokenHash: hashToken(token), revokedAt: null },
        data: { revokedAt: new Date() },
      });
    }
    clearAuthCookies(res);
    res.json({ ok: true });
  }),
);

authRouter.get(
  "/me",
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = await prisma.user.findUnique({ where: { id: req.userId! } });
    if (!user) {
      throw new ApiError(401, "unauthenticated");
    }
    res.json({ user: toPublicUser(user) });
  }),
);
