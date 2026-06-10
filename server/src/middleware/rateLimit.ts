import rateLimit from "express-rate-limit";

// Blunts credential stuffing / brute force on the auth endpoints. Broader
// rate limiting across mutating routes is deferred (see DECISIONS.md).
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "too_many_requests" },
});
