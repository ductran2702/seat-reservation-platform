import { readPool, writePool } from "@srp/db";
import { createApp } from "./app.js";
import { env } from "./env.js";

const app = createApp();

const server = app.listen(env.port, () => {
  console.log(
    JSON.stringify({
      action: "server_started",
      service: "gateway",
      port: env.port,
      nodeEnv: env.nodeEnv,
    }),
  );
});

// Graceful shutdown: stop accepting connections and drain. Long-lived SSE
// streams won't drain on their own — the 10s force-exit cuts them; clients
// auto-reconnect (EventSource) to a healthy instance.
function shutdown(signal: string): void {
  console.log(
    JSON.stringify({ action: "shutdown_started", service: "gateway", signal }),
  );
  server.close(() => {
    Promise.allSettled([readPool.end(), writePool.end()]).finally(() =>
      process.exit(0),
    );
  });
  server.closeIdleConnections();
  setTimeout(() => {
    server.closeAllConnections(); // cut remaining SSE streams
    process.exit(1);
  }, 10_000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
