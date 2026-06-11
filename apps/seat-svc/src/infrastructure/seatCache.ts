import { createClient } from "redis";
import { env } from "../env.js";

const KEY = "srp:seats:all";
const TTL_S = 10;

type RedisClient = ReturnType<typeof createClient>;

let client: RedisClient | null = null;
let connecting: Promise<unknown> | null = null;

// Lazily connects on first use. When REDIS_URL is unset (local dev, tests) or
// Redis is down, every operation degrades to a cache miss / no-op — the seat
// listing then falls through to readPool with zero regression.
async function getClient(): Promise<RedisClient | null> {
  if (!env.redisUrl) return null;
  if (!client) {
    client = createClient({ url: env.redisUrl });
    client.on("error", () => {
      // Swallow — a Redis outage must never break the seat listing.
    });
    connecting = client.connect().catch(() => {
      client = null;
    });
  }
  await connecting;
  return client && client.isOpen ? client : null;
}

export async function getCachedSeats<T>(): Promise<T[] | null> {
  try {
    const redis = await getClient();
    if (!redis) return null;
    const raw = await redis.get(KEY);
    return raw ? (JSON.parse(raw) as T[]) : null;
  } catch {
    return null;
  }
}

export async function setCachedSeats<T>(seats: T[]): Promise<void> {
  try {
    const redis = await getClient();
    if (redis) await redis.setEx(KEY, TTL_S, JSON.stringify(seats));
  } catch {
    // Best-effort cache write.
  }
}

// Called after every seat state mutation (hold/confirm/cancel/expire) so the
// next read repopulates from the database instead of serving a stale list.
export async function invalidateSeatCache(): Promise<void> {
  try {
    const redis = await getClient();
    if (redis) await redis.del(KEY);
  } catch {
    // Worst case the entry ages out via its 10s TTL.
  }
}
