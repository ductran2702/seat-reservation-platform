import rateLimit from "express-rate-limit";

// Centralized at the gateway: blunts credential stuffing / brute force on the
// auth endpoints before traffic ever reaches auth-svc. nginx adds a second,
// coarser per-IP layer in front (see infra/nginx/nginx.conf).
// TODO(prod): back this with a shared Redis store — the in-memory counter
// resets on restart and is per-instance, so limits don't hold once the
// gateway scales past one pod.
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "too_many_requests" },
});
