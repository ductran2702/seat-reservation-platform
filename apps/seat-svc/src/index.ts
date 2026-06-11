import { directPool, prisma } from "@srp/db";
import { createApp } from "./app.js";
import { env } from "./env.js";
import { startSweeper } from "./sweeper.js";

const app = createApp();

const server = app.listen(env.port, () => {
  console.log(
    JSON.stringify({
      action: "server_started",
      service: "seat-svc",
      port: env.port,
      nodeEnv: env.nodeEnv,
    }),
  );
});

// Advisory-locked background job — needs a direct (non-PgBouncer) connection.
const sweeper = startSweeper(directPool);

// Graceful shutdown: stop the sweeper, stop accepting connections, drain
// in-flight requests (no Prisma TX killed mid-flight), then disconnect.
// Force-exit after 10s if requests don't drain.
function shutdown(signal: string): void {
  console.log(
    JSON.stringify({ action: "shutdown_started", service: "seat-svc", signal }),
  );
  clearInterval(sweeper);
  server.close(() => {
    Promise.allSettled([prisma.$disconnect(), directPool.end()]).finally(() =>
      process.exit(0),
    );
  });
  server.closeIdleConnections();
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
