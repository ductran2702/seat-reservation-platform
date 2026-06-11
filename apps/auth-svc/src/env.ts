function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

// Fail fast at startup instead of letting NaN propagate silently into
// queries/timeouts (e.g. HOLD_TTL_SECONDS='abc' → holds that never expire).
function positiveInt(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (!raw) return defaultValue;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`Env var ${name} must be a positive integer, got: ${raw}`);
  }
  return n;
}

const isProd = process.env.NODE_ENV === "production";

export const env = {
  nodeEnv: process.env.NODE_ENV ?? "development",
  isProd,
  port: positiveInt("AUTH_SVC_PORT", positiveInt("PORT", 3001)),
  // Secure cookies require HTTPS. Defaults to NODE_ENV, but the local docker
  // stack (nginx without TLS) sets COOKIE_SECURE=false explicitly — flip it
  // back on the moment TLS terminates at nginx (see infra/nginx/nginx.conf).
  cookieSecure: process.env.COOKIE_SECURE
    ? process.env.COOKIE_SECURE === "true"
    : isProd,
  accessTokenSecret: required("ACCESS_TOKEN_SECRET"),
  accessTokenTtl: process.env.ACCESS_TOKEN_TTL ?? "15m",
  refreshTokenTtlDays: positiveInt("REFRESH_TOKEN_TTL_DAYS", 90),
};

export const ACCESS_COOKIE_MAX_AGE_MS = 15 * 60 * 1000;
export const REFRESH_COOKIE_MAX_AGE_MS =
  env.refreshTokenTtlDays * 24 * 60 * 60 * 1000;
