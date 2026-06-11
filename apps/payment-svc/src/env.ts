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
// queries/timeouts (e.g. SEAT_PRICE_CENTS='abc' → NaN amounts).
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
  port: positiveInt("PAYMENT_SVC_PORT", positiveInt("PORT", 3003)),
  internalSecret: requiredInProd("INTERNAL_SECRET", "dev_internal_secret"),
  seatSvcUrl: process.env.SEAT_SVC_URL ?? "http://localhost:3002",
  webOrigin: process.env.WEB_ORIGIN ?? "http://localhost:5174",
  seatPriceCents: positiveInt("SEAT_PRICE_CENTS", 2500),
  outboxPollIntervalMs: positiveInt("OUTBOX_POLL_INTERVAL_MS", 1000),
};
