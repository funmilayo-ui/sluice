// Vercel function: the whole Sluice API as one Node.js function. The web app is static and served by the
// CDN; `vercel.json` rewrites /v1/* and /health here. Locally and on any long-running host the same app is
// served by `packages/api/src/server.ts` instead, so nothing in the API depends on Vercel.
import { getCache } from "@vercel/functions";
import { createSluice } from "../packages/api/dist/bootstrap.js";

// A function instance starts cold often. The Phoenix pool list (two contract reads per pool) is the slow
// part of a first quote, so it is kept in the Runtime Cache, which outlives instances and deployments.
const runtimeCache = getCache({ namespace: "sluice" });
const { app, warm } = createSluice(process.env, {
  cache: {
    get: (key) => runtimeCache.get(key),
    set: (key, value, ttlSec) => runtimeCache.set(key, value, { ttl: ttlSec, name: key }),
  },
});
void warm();

export default {
  /** @param {Request} request */
  fetch(request) {
    // The rewrite carries the path the client asked for in `__path`, so routing does not depend on how the
    // platform presents a rewritten URL to the function.
    const url = new URL(request.url);
    const original = url.searchParams.get("__path");
    if (!original) return app.fetch(request);
    url.pathname = original;
    url.searchParams.delete("__path");
    const hasBody = request.method !== "GET" && request.method !== "HEAD";
    return app.fetch(new Request(url, { method: request.method, headers: request.headers, body: hasBody ? request.body : undefined, duplex: hasBody ? "half" : undefined }));
  },
};
