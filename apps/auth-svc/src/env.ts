function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

const isProd = process.env.NODE_ENV === "production";

export const env = {
  nodeEnv: process.env.NODE_ENV ?? "development",
  isProd,
  port: Number(process.env.AUTH_SVC_PORT ?? process.env.PORT ?? 3001),
  // Secure cookies require HTTPS. Defaults to NODE_ENV, but the local docker
  // stack (nginx without TLS) sets COOKIE_SECURE=false explicitly — flip it
  // back on the moment TLS terminates at nginx (see infra/nginx/nginx.conf).
  cookieSecure: process.env.COOKIE_SECURE
    ? process.env.COOKIE_SECURE === "true"
    : isProd,
  accessTokenSecret: required("ACCESS_TOKEN_SECRET"),
  accessTokenTtl: process.env.ACCESS_TOKEN_TTL ?? "15m",
  refreshTokenTtlDays: Number(process.env.REFRESH_TOKEN_TTL_DAYS ?? 90),
};

export const ACCESS_COOKIE_MAX_AGE_MS = 15 * 60 * 1000;
export const REFRESH_COOKIE_MAX_AGE_MS =
  env.refreshTokenTtlDays * 24 * 60 * 60 * 1000;
