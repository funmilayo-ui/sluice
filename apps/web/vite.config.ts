import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// In development the API runs separately (`pnpm --filter @sluice/api dev`); in production one origin serves both.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: { "/v1": process.env.SLUICE_API ?? "http://localhost:8787", "/health": process.env.SLUICE_API ?? "http://localhost:8787" },
  },
  build: { target: "es2022", sourcemap: true },
});
