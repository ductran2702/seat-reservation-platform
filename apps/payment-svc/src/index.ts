import { createApp } from "./app.js";
import { env } from "./env.js";
import { startOutboxWorker } from "./outboxWorker.js";

const app = createApp();

app.listen(env.port, () => {
  console.log(`payment-svc listening on http://localhost:${env.port}`);
});

// Delivers transactional-outbox events (seat state changes) to seat-svc.
startOutboxWorker();
