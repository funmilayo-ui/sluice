import { serve } from "@hono/node-server";
import { builtWebDir, createSluice } from "./bootstrap.js";

// One process serves the API and, when it has been built, the web app.
const webDir = builtWebDir();
const { app, warm } = createSluice(process.env, { webDir });
const port = Number(process.env.PORT ?? 8787);
serve({ fetch: app.fetch, port });
console.log(`sluice listening on :${port}${webDir ? " (API and web app)" : " (API only: run `pnpm build` to serve the web app)"}`);
void warm();
