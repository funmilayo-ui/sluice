#!/usr/bin/env node
import { serve } from "@hono/node-server";
import { preferIpv4 } from "@sluice/core";
import { createSolverNode, loadSolverServiceConfig, storeFromEnv } from "./env.js";
import { createSolverApp } from "./service.js";

/**
 * The standalone solver service: owns the solver key, runs fills and hedges, retries failed hedges, keeps its state on disk.
 * `SOLVER_*` variables, documented in .env.example. Fails to start, loudly, on a bad configuration or on the public network.
 */
const setup = loadSolverServiceConfig(process.env);
if (!setup.ok) {
  console.error(`solver service not started: ${setup.reason}`);
  process.exit(1);
}
const { config } = setup;
if (process.env.SLUICE_IPV4_FIRST === "1") preferIpv4();

const { store, memory } = storeFromEnv(process.env);
if (memory) console.warn("WARNING: SOLVER_ALLOW_MEMORY_STATE=1, so open positions are forgotten on restart. Never run like this with real funds.");
const node = createSolverNode(config.node, store, { log: (m, d) => console.log(`[solver] ${m}${d === undefined ? "" : ` ${typeof d === "string" ? d : JSON.stringify(d)}`}`) });
try {
  await node.restore();
} catch (e) {
  console.error(`solver service not started: ${(e as Error).message}`);
  process.exit(1);
}
node.start();
const app = createSolverApp(node, { token: config.token });
const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host });
console.log(`sluice solver ${node.address} on ${config.host}:${config.port} (state: ${store.describe()}); open positions: ${node.ledger.list().length}`);

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  console.log(`${signal}: stopping`);
  server.close();
  await node.close();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
