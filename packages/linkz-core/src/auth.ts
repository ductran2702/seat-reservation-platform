import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import type pg from "pg";

declare global {
  namespace Express {
    interface Request {
      userId?: string;
    }
  }
}

export const ACCESS_COOKIE = "access_token";

// Internal headers used for service-to-service trust. The gateway is the only
// component allowed to assert a user identity; downstream services accept the
// X-User-Id header only when X-Internal-Secret matches.
export const INTERNAL_SECRET_HEADER = "x-internal-secret";
export const USER_ID_HEADER = "x-user-id";

export interface AccessTokenPayload {
  sub: string;
  // tokenVersion at signing time — compared against the User row on every
  // authenticated request so logout/reuse-burn kills outstanding access JWTs.
  ver: number;
}

export function verifyAccessToken(
  token: string,
  secret: string,
): AccessTokenPayload {
  const payload = jwt.verify(token, secret) as jwt.JwtPayload;
  if (typeof payload.sub !== "string" || typeof payload.ver !== "number") {
    throw new Error("malformed access token payload");
  }
  return { sub: payload.sub, ver: payload.ver };
}

// TODO(prod): cache token_version in Redis with a ~30s TTL to avoid a
// per-request DB round trip; bump-on-logout then also deletes the cache key.
export async function checkTokenVersion(
  pool: pg.Pool,
  userId: string,
  ver: number,
): Promise<boolean> {
  const { rows } = await pool.query<{ tokenVersion: number }>(
    'SELECT "tokenVersion" FROM "User" WHERE id = $1',
    [userId],
  );
  return rows.length > 0 && rows[0].tokenVersion === ver;
}

export interface CookieAuthOptions {
  accessTokenSecret: string;
  // Read pool is acceptable here in general; services that need a hard
  // guarantee (auth-svc) pass the write/primary pool.
  pool: pg.Pool;
}

/**
 * Cookie-based auth for edge components that see the browser directly
 * (gateway, auth-svc). Verifies the access JWT *and* its tokenVersion.
 */
export function createCookieAuth({ accessTokenSecret, pool }: CookieAuthOptions) {
  async function resolveUserId(req: Request): Promise<string | null> {
    const token = req.cookies?.[ACCESS_COOKIE];
    if (!token) return null;
    let payload: AccessTokenPayload;
    try {
      payload = verifyAccessToken(token, accessTokenSecret);
    } catch {
      return null;
    }
    const valid = await checkTokenVersion(pool, payload.sub, payload.ver);
    return valid ? payload.sub : null;
  }

  return {
    requireAuth(req: Request, res: Response, next: NextFunction): void {
      resolveUserId(req)
        .then((userId) => {
          if (!userId) {
            res.status(401).json({ error: "unauthenticated" });
            return;
          }
          req.userId = userId;
          next();
        })
        .catch(next);
    },
    // Attaches req.userId when a valid access cookie is present, never blocks.
    optionalAuth(req: Request, _res: Response, next: NextFunction): void {
      resolveUserId(req)
        .then((userId) => {
          if (userId) req.userId = userId;
          next();
        })
        .catch(next);
    },
  };
}

/**
 * Header-based auth for internal services behind the gateway (seat-svc,
 * payment-svc). They never see cookies or JWTs — the gateway has already
 * verified the user and forwards the identity via X-User-Id, authenticated
 * with the shared X-Internal-Secret.
 */
export function createInternalAuth(internalSecret: string) {
  function fromGateway(req: Request): boolean {
    return req.get(INTERNAL_SECRET_HEADER) === internalSecret;
  }

  return {
    requireAuth(req: Request, res: Response, next: NextFunction): void {
      if (!fromGateway(req)) {
        res.status(401).json({ error: "untrusted_caller" });
        return;
      }
      const userId = req.get(USER_ID_HEADER);
      if (!userId) {
        res.status(401).json({ error: "unauthenticated" });
        return;
      }
      req.userId = userId;
      next();
    },
    optionalAuth(req: Request, res: Response, next: NextFunction): void {
      if (!fromGateway(req)) {
        res.status(401).json({ error: "untrusted_caller" });
        return;
      }
      const userId = req.get(USER_ID_HEADER);
      if (userId) req.userId = userId;
      next();
    },
  };
}
