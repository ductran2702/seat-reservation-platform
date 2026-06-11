const isProd = process.env.NODE_ENV === "production";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

function requiredInProd(name: string, devFallback: string): string {
  const value = process.env[name];
  if (value) return value;
  if (isProd) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return devFallback;
}

// Fail fast at startup instead of letting NaN propagate silently into
// the public /api/config payload or timeouts.
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
  port: positiveInt("GATEWAY_PORT", positiveInt("PORT", 3000)),
  authSvcUrl: process.env.AUTH_SVC_URL ?? "http://localhost:3001",
  seatSvcUrl: process.env.SEAT_SVC_URL ?? "http://localhost:3002",
  paymentSvcUrl: process.env.PAYMENT_SVC_URL ?? "http://localhost:3003",
  // Forwarded on every proxied request; downstream services only trust
  // X-User-Id when this secret matches.
  internalSecret: requiredInProd("INTERNAL_SECRET", "dev_internal_secret"),
  // Needed to verify access JWTs at the edge (auth-svc signs them).
  accessTokenSecret: required("ACCESS_TOKEN_SECRET"),
  // Public client config served by the gateway itself.
  seatPriceCents: positiveInt("SEAT_PRICE_CENTS", 2500),
  holdTtlSeconds: positiveInt("HOLD_TTL_SECONDS", 30),
  maxActiveReservationsPerUser: positiveInt(
    "MAX_ACTIVE_RESERVATIONS_PER_USER",
    2,
  ),
};
