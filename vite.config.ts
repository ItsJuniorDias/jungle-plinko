import { defineConfig } from "vite";

export default defineConfig({
  server: {
    host: true,
    // Dev tools may hand out a port through PORT (another app can hold 5173).
    port: Number(process.env.PORT) || 5173,
    proxy: { "/api": "http://localhost:8787" },
  },
});
