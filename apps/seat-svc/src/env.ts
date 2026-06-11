const isProd = process.env.NODE_ENV === "production";

function requiredInProd(name: string, devFallback: string): string {
  const value = process.env[name];
  if (value) return value;
  if (isProd) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return devFallback;
}

export const env = {
  nodeEnv: process.env.NODE_ENV ?? "development",
  isProd,
  port: Number(process.env.SEAT_SVC_PORT ?? process.env.PORT ?? 3002),
  // Shared secret authenticating gateway → service (and service → service)
  // calls; the X-User-Id header is only trusted alongside it.
  internalSecret: requiredInProd("INTERNAL_SECRET", "dev_internal_secret"),
  gatewayUrl: process.env.GATEWAY_URL ?? "http://localhost:3000",
  holdTtlSeconds: Number(process.env.HOLD_TTL_SECONDS ?? 30),
  maxActiveReservationsPerUser: Number(
    process.env.MAX_ACTIVE_RESERVATIONS_PER_USER ?? 2,
  ),
  // Optional — seat cache is a no-op (always miss) when unset.
  redisUrl: process.env.REDIS_URL ?? "",
  sweepIntervalMs: Number(process.env.SWEEP_INTERVAL_MS ?? 10_000),
};
