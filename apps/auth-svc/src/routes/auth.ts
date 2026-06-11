import crypto from "node:crypto";
import { Router } from "express";
import type { Response } from "express";
import { z } from "zod";
import { prisma, writePool } from "@srp/db";
import { ApiError, asyncHandler, createCookieAuth } from "@srp/linkz-core";
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
import { REFRESH_COOKIE_MAX_AGE_MS, env } from "../env.js";

export const authRouter = Router();

// auth-svc verifies cookies itself (it owns tokens); tokenVersion is checked
// against the primary — a stale replica read here would defeat revocation.
const { requireAuth } = createCookieAuth({
  accessTokenSecret: env.accessTokenSecret,
  pool: writePool,
});

// Real bcrypt hash (same cost as user hashes) computed once at startup. Used
// when the email is unknown so login always pays the full bcrypt cost —
// otherwise response time (~1ms vs ~200ms) leaks which emails exist, despite
// the identical error message (timing oracle / user enumeration).
const DUMMY_HASH = await hashPassword(crypto.randomBytes(16).toString("hex"));

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
async function issueSession(
  res: Response,
  user: { id: string; tokenVersion: number },
): Promise<void> {
  const refreshToken = generateRefreshToken();
  const accessToken = signAccessToken(user.id, user.tokenVersion);
  await prisma.refreshToken.create({
    data: {
      userId: user.id,
      tokenHash: hashToken(refreshToken),
      expiresAt: new Date(Date.now() + REFRESH_COOKIE_MAX_AGE_MS),
    },
  });
  setAuthCookies(res, accessToken, refreshToken);
}

authRouter.post(
  "/register",
  asyncHandler(async (req, res) => {
    const { email, password, name } = registerSchema.parse(req.body);
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      throw new ApiError(409, "email_taken", "Email is already registered");
    }
    const user = await prisma.user.create({
      data: { email, name, passwordHash: await hashPassword(password) },
    });
    await issueSession(res, user);
    res.status(201).json({ user: toPublicUser(user) });
  }),
);

authRouter.post(
  "/login",
  asyncHandler(async (req, res) => {
    const { email, password } = loginSchema.parse(req.body);
    const user = await prisma.user.findUnique({ where: { email } });
    // Always run bcrypt — comparing against DUMMY_HASH for unknown emails
    // keeps the response time constant (no enumeration via timing), and the
    // error stays identical for unknown email vs wrong password.
    const valid = await verifyPassword(
      password,
      user?.passwordHash ?? DUMMY_HASH,
    );
    if (!user || !valid) {
      throw new ApiError(401, "invalid_credentials", "Invalid email or password");
    }
    await issueSession(res, user);
    res.json({ user: toPublicUser(user) });
  }),
);

authRouter.post(
  "/refresh",
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
    // cookie can't keep a session alive. Bumping tokenVersion also kills any
    // outstanding access tokens immediately (not just at their 15m expiry).
    if (record.revokedAt) {
      await prisma.$transaction([
        prisma.refreshToken.updateMany({
          where: { userId: record.userId, revokedAt: null },
          data: { revokedAt: new Date() },
        }),
        prisma.user.update({
          where: { id: record.userId },
          data: { tokenVersion: { increment: 1 } },
        }),
      ]);
      clearAuthCookies(res);
      throw new ApiError(401, "refresh_token_reused");
    }
    if (record.expiresAt <= new Date()) {
      clearAuthCookies(res);
      throw new ApiError(401, "refresh_token_expired");
    }

    const user = await prisma.user.findUnique({
      where: { id: record.userId },
    });
    if (!user) {
      clearAuthCookies(res);
      throw new ApiError(401, "invalid_refresh_token");
    }

    // Rotate atomically: CAS-revoke the presented token (guarded on
    // revokedAt IS NULL) and issue the replacement in the SAME transaction.
    // If two requests race with the same token, exactly one wins the CAS;
    // the loser gets a 401 instead of a second valid token pair.
    const newId = crypto.randomUUID();
    const newRefresh = generateRefreshToken();
    const newAccess = signAccessToken(user.id, user.tokenVersion);
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
      const record = await prisma.refreshToken.findUnique({
        where: { tokenHash: hashToken(token) },
      });
      if (record) {
        // Server-side revocation is mandatory: clearing the cookie alone would
        // leave a stolen copy of the token usable until it expires. Bumping
        // tokenVersion additionally invalidates the (still unexpired) access
        // JWT — without it a stolen AT stays valid for up to 15 minutes.
        await prisma.$transaction([
          prisma.refreshToken.updateMany({
            where: { id: record.id, revokedAt: null },
            data: { revokedAt: new Date() },
          }),
          prisma.user.update({
            where: { id: record.userId },
            data: { tokenVersion: { increment: 1 } },
          }),
        ]);
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
