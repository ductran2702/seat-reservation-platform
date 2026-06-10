function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

export const env = {
  nodeEnv: process.env.NODE_ENV ?? "development",
  isProd: process.env.NODE_ENV === "production",
  port: Number(process.env.PORT ?? 4001),
  webOrigin: process.env.WEB_ORIGIN ?? "http://localhost:5174",
  accessTokenSecret: required("ACCESS_TOKEN_SECRET"),
  refreshTokenSecret: required("REFRESH_TOKEN_SECRET"),
  accessTokenTtl: process.env.ACCESS_TOKEN_TTL ?? "15m",
  refreshTokenTtlDays: Number(process.env.REFRESH_TOKEN_TTL_DAYS ?? 90),
  holdTtlSeconds: Number(process.env.HOLD_TTL_SECONDS ?? 300),
  seatPriceCents: Number(process.env.SEAT_PRICE_CENTS ?? 2500),
  maxActiveReservationsPerUser: Number(
    process.env.MAX_ACTIVE_RESERVATIONS_PER_USER ?? 2,
  ),
};

export const ACCESS_COOKIE_MAX_AGE_MS = 15 * 60 * 1000;
export const REFRESH_COOKIE_MAX_AGE_MS = env.refreshTokenTtlDays * 24 * 60 * 60 * 1000;
