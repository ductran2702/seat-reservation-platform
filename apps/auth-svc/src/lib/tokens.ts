import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import { env } from "../env.js";

// `ver` is the user's tokenVersion at signing time. requireAuth compares it
// against the User row, so bumping tokenVersion (logout, refresh-token reuse)
// invalidates every outstanding access token immediately.
export function signAccessToken(userId: string, tokenVersion: number): string {
  return jwt.sign({ sub: userId, ver: tokenVersion }, env.accessTokenSecret, {
    expiresIn: env.accessTokenTtl as jwt.SignOptions["expiresIn"],
  });
}

// Refresh tokens are deliberately OPAQUE (48 random bytes), not JWTs: the DB
// record is the single source of truth, so a session can always be revoked.
// A stateless/signed refresh token would contradict "90-day revocable session".
export function generateRefreshToken(): string {
  return crypto.randomBytes(48).toString("base64url");
}

// Refresh tokens are stored only as a SHA-256 hash so a DB leak can't be
// replayed. High-entropy random input makes a fast hash sufficient here
// (no need for bcrypt-style stretching).
export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}
