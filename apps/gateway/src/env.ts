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

export const env = {
  nodeEnv: process.env.NODE_ENV ?? "development",
  isProd,
  port: Number(process.env.GATEWAY_PORT ?? process.env.PORT ?? 3000),
  authSvcUrl: process.env.AUTH_SVC_URL ?? "http://localhost:3001",
  seatSvcUrl: process.env.SEAT_SVC_URL ?? "http://localhost:3002",
  paymentSvcUrl: process.env.PAYMENT_SVC_URL ?? "http://localhost:3003",
  // Forwarded on every proxied request; downstream services only trust
  // X-User-Id when this secret matches.
  internalSecret: requiredInProd("INTERNAL_SECRET", "dev_internal_secret"),
  // Needed to verify access JWTs at the edge (auth-svc signs them).
  accessTokenSecret: required("ACCESS_TOKEN_SECRET"),
  // Public client config served by the gateway itself.
  seatPriceCents: Number(process.env.SEAT_PRICE_CENTS ?? 2500),
  holdTtlSeconds: Number(process.env.HOLD_TTL_SECONDS ?? 30),
  maxActiveReservationsPerUser: Number(
    process.env.MAX_ACTIVE_RESERVATIONS_PER_USER ?? 2,
  ),
};
