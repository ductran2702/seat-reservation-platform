import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The dev server proxies /api to the gateway so the browser sees a single
// origin — which keeps the SameSite=Strict auth cookies first-party.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    strictPort: true,
    proxy: {
      "/api": {
        target: "http://localhost:3000",
        changeOrigin: true,
      },
    },
  },
});
