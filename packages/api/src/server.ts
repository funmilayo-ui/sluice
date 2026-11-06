import { serve } from "@hono/node-server";
import { builtWebDir, createSluice } from "./bootstrap.js";

// One process serves the API and, when it has been built, the web app.
const webDir = builtWebDir();
const { app, warm, start, stop } = createSluice(process.env, { webDir });
// With an in-process solver this reloads its stored positions and starts the recovery loop before any order arrives.
await start();
const port = Number(process.env.PORT ?? 8787);
const server = serve({ fetch: app.fetch, port });
console.log(`sluice listening on :${port}${webDir ? " (API and web app)" : " (API only: run `pnpm build` to serve the web app)"}`);
void warm();

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  console.log(`${signal}: stopping`);
  server.close();
  await stop();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
