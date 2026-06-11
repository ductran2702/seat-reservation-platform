const isProd = process.env.NODE_ENV === "production";

function requiredInProd(name: string, devFallback: string): string {
  const value = process.env[name];
  if (value) return value;
  if (isProd) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return devFallback;
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

export const env = {
  nodeEnv: process.env.NODE_ENV ?? "development",
  isProd,
  port: positiveInt("SEAT_SVC_PORT", positiveInt("PORT", 3002)),
  // Shared secret authenticating gateway → service (and service → service)
  // calls; the X-User-Id header is only trusted alongside it.
  internalSecret: requiredInProd("INTERNAL_SECRET", "dev_internal_secret"),
  gatewayUrl: process.env.GATEWAY_URL ?? "http://localhost:3000",
  holdTtlSeconds: positiveInt("HOLD_TTL_SECONDS", 30),
  maxActiveReservationsPerUser: positiveInt(
    "MAX_ACTIVE_RESERVATIONS_PER_USER",
    2,
  ),
  // Optional — seat cache is a no-op (always miss) when unset.
  redisUrl: process.env.REDIS_URL ?? "",
  sweepIntervalMs: positiveInt("SWEEP_INTERVAL_MS", 10_000),
};
