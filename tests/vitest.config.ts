import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["e2e/**/*.test.ts"],
    testTimeout: 20000,
    hookTimeout: 20000,
    // The concurrency test relies on real DB ordering; keep files serial.
    fileParallelism: false,
  },
});
