import express from "express";

const app = express();
app.use(express.json());

// Phase 0 placeholder. Auth, seats, reservations, and payment routes are
// added in later phases (see implementation-plan.md).
app.get("/api/health", (_req, res) => {
  res.json({ status: "ok" });
});

const port = Number(process.env.PORT ?? 4000);
app.listen(port, () => {
  console.log(`API listening on http://localhost:${port}`);
});
