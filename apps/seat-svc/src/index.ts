import { directPool } from "@srp/db";
import { createApp } from "./app.js";
import { env } from "./env.js";
import { scheduleExistingHolds } from "./expiryScheduler.js";
import { startSweeper } from "./sweeper.js";

const app = createApp();

app.listen(env.port, () => {
  console.log(`seat-svc listening on http://localhost:${env.port}`);
});

// Advisory-locked background job — needs a direct (non-PgBouncer) connection.
startSweeper(directPool);

// Re-arm precise per-hold expiry timers for holds created before this boot.
void scheduleExistingHolds();
