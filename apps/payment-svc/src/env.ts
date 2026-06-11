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
  port: Number(process.env.PAYMENT_SVC_PORT ?? process.env.PORT ?? 3003),
  internalSecret: requiredInProd("INTERNAL_SECRET", "dev_internal_secret"),
  seatSvcUrl: process.env.SEAT_SVC_URL ?? "http://localhost:3002",
  webOrigin: process.env.WEB_ORIGIN ?? "http://localhost:5174",
  seatPriceCents: Number(process.env.SEAT_PRICE_CENTS ?? 2500),
};
