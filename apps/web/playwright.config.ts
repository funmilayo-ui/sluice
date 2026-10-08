import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.E2E_PORT ?? 8799);

/**
 * End-to-end checks against the real thing: the built web app served by the API process, quoting live
 * Stellar mainnet. Nothing is signed (there is no wallet in the test browser), so no funds can move.
 * Run `pnpm build` first. Set PW_CHANNEL=chrome to use an installed Chrome instead of downloading a browser.
 */
export default defineConfig({
  testDir: "e2e",
  testMatch: /.*\.e2e\.ts/,
  timeout: 90_000,
  expect: { timeout: 30_000 },
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: { baseURL: `http://localhost:${PORT}`, channel: process.env.PW_CHANNEL, trace: "retain-on-failure" },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], channel: process.env.PW_CHANNEL } },
    { name: "phone", use: { ...devices["Pixel 7"], channel: process.env.PW_CHANNEL } },
  ],
  webServer: {
    command: "node ../../packages/api/dist/server.js",
    env: { PORT: String(PORT), SLUICE_IPV4_FIRST: process.env.SLUICE_IPV4_FIRST ?? "0" },
    url: `http://localhost:${PORT}/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
