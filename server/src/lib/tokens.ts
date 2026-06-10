import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import { env } from "./env.js";

export interface AccessTokenPayload {
  sub: string;
}

export interface RefreshTokenPayload {
  sub: string;
  jti: string;
}

export function signAccessToken(userId: string): string {
  return jwt.sign({ sub: userId }, env.accessTokenSecret, {
    expiresIn: env.accessTokenTtl as jwt.SignOptions["expiresIn"],
  });
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  return jwt.verify(token, env.accessTokenSecret) as AccessTokenPayload;
}

export function signRefreshToken(userId: string, jti: string): string {
  return jwt.sign({ sub: userId, jti }, env.refreshTokenSecret, {
    expiresIn: `${env.refreshTokenTtlDays}d` as jwt.SignOptions["expiresIn"],
  });
}

export function verifyRefreshToken(token: string): RefreshTokenPayload {
  return jwt.verify(token, env.refreshTokenSecret) as RefreshTokenPayload;
}

// Refresh tokens are stored only as a SHA-256 hash so a DB leak can't be
// replayed. High-entropy JWT input makes a fast hash sufficient here.
export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}
