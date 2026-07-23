import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The Go backend does not send CORS headers yet, so in dev we proxy REST +
// WebSocket traffic through Vite to sidestep cross-origin blocking entirely.
// The app talks to "/api/*" and "/ws"; both are forwarded to :8080 below.
const BACKEND = process.env.BACKEND_URL || "http://localhost:8080";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: BACKEND,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
      "/ws": {
        target: BACKEND.replace(/^http/, "ws"),
        ws: true,
      },
    },
  },
});
