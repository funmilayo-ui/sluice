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
  // TEST-ONLY wallet shim (src/lib/testWallet.ts). A build-time constant, false unless SLUICE_TEST_WALLET=1 is set
  // for the build, so the shim is removed from every normal and production build. See docs/WALLET_TEST_PASS.md.
  define: { __SLUICE_TEST_WALLET__: JSON.stringify(process.env.SLUICE_TEST_WALLET === "1") },
  build: { target: "es2022", sourcemap: true },
});
