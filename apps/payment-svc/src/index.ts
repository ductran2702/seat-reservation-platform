import { prisma } from "@srp/db";
import { createApp } from "./app.js";
import { env } from "./env.js";
import { startOutboxWorker } from "./outboxWorker.js";

const app = createApp();

const server = app.listen(env.port, () => {
  console.log(
    JSON.stringify({
      action: "server_started",
      service: "payment-svc",
      port: env.port,
      nodeEnv: env.nodeEnv,
    }),
  );
});

// Delivers transactional-outbox events (seat state changes) to seat-svc.
const outboxWorker = startOutboxWorker();

// Graceful shutdown: stop the outbox timer, stop accepting connections,
// drain in-flight requests (a payment-confirm TX is never killed mid-flight),
// then disconnect. Undelivered outbox events simply stay PENDING and are
// picked up on the next boot — that's the point of the outbox.
// Force-exit after 10s if requests don't drain.
function shutdown(signal: string): void {
  console.log(
    JSON.stringify({
      action: "shutdown_started",
      service: "payment-svc",
      signal,
    }),
  );
  clearInterval(outboxWorker);
  server.close(() => {
    prisma
      .$disconnect()
      .catch(() => undefined)
      .finally(() => process.exit(0));
  });
  server.closeIdleConnections();
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
