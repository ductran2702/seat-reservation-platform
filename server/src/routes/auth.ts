import crypto from "node:crypto";
import { Router } from "express";
import type { Response } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { hashPassword, verifyPassword } from "../lib/password.js";
import {
  hashToken,
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
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

// Issues a fresh access token + a DB-tracked refresh token and sets cookies.
async function issueSession(res: Response, userId: string): Promise<void> {
  const jti = crypto.randomUUID();
  const refreshToken = signRefreshToken(userId, jti);
  const accessToken = signAccessToken(userId);
  await prisma.refreshToken.create({
    data: {
      id: jti,
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

    let payload;
    try {
      payload = verifyRefreshToken(token);
    } catch {
      clearAuthCookies(res);
      throw new ApiError(401, "invalid_refresh_token");
    }

    const record = await prisma.refreshToken.findUnique({
      where: { id: payload.jti },
    });
    const valid =
      record &&
      !record.revokedAt &&
      record.expiresAt > new Date() &&
      record.tokenHash === hashToken(token);
    if (!valid) {
      clearAuthCookies(res);
      throw new ApiError(401, "invalid_refresh_token");
    }

    // Rotate: revoke the presented token and issue a new one atomically.
    const newJti = crypto.randomUUID();
    const newRefresh = signRefreshToken(payload.sub, newJti);
    const newAccess = signAccessToken(payload.sub);
    await prisma.$transaction([
      prisma.refreshToken.update({
        where: { id: payload.jti },
        data: { revokedAt: new Date(), replacedById: newJti },
      }),
      prisma.refreshToken.create({
        data: {
          id: newJti,
          userId: payload.sub,
          tokenHash: hashToken(newRefresh),
          expiresAt: new Date(Date.now() + REFRESH_COOKIE_MAX_AGE_MS),
        },
      }),
    ]);

    setAuthCookies(res, newAccess, newRefresh);
    res.json({ ok: true });
  }),
);

authRouter.post(
  "/logout",
  asyncHandler(async (req, res) => {
    const token = req.cookies?.[REFRESH_COOKIE] as string | undefined;
    if (token) {
      try {
        const payload = verifyRefreshToken(token);
        await prisma.refreshToken.updateMany({
          where: { id: payload.jti, revokedAt: null },
          data: { revokedAt: new Date() },
        });
      } catch {
        // Ignore invalid tokens on logout; we still clear cookies.
      }
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
