import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // Only backend APIs and media are proxied; /admin/* belongs to the SPA.
      "/api": "http://127.0.0.1:8010",
      "/media": "http://127.0.0.1:8010",
    },
  },
});
