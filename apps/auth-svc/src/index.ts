import { prisma } from "@srp/db";
import { createApp } from "./app.js";
import { env } from "./env.js";

const app = createApp();

const server = app.listen(env.port, () => {
  console.log(
    JSON.stringify({
      action: "server_started",
      service: "auth-svc",
      port: env.port,
      nodeEnv: env.nodeEnv,
    }),
  );
});

// Graceful shutdown: stop accepting connections, drain in-flight requests
// (so a Prisma transaction is never killed mid-flight), then disconnect.
// Force-exit after 10s if requests don't drain.
function shutdown(signal: string): void {
  console.log(
    JSON.stringify({ action: "shutdown_started", service: "auth-svc", signal }),
  );
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
