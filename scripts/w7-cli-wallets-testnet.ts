/**
 * TESTNET ONLY. The settlement flows driven by Stellar CLI wallets instead of in-memory throwaway keys.
 *
 * The parties are identities in the local `stellar keys` keystore (created and friendbot-funded on testnet when missing):
 * sluice-issuer, sluice-user, sluice-solver, sluice-maker. The stack is as in production: the API in REMOTE solver mode
 * calling the standalone solver service (a child process that owns the solver key).
 *
 *   tier 2  the user's wallet is the CLI: prepare-tx -> `stellar tx sign --sign-with-key sluice-user` -> submit-tx.
 *           The CLI sees the transaction envelope and nothing else, which is what a transaction-signing wallet sees.
 *   tier 1  the user signs one authorisation entry. The CLI has no command that signs a bare auth entry, so the callback
 *           reads the user's key from the keystore (`stellar keys secret`) and signs sha256(preimage), exactly the
 *           operation a SEP-43 signAuthEntry wallet performs.
 *
 * Re-runnable: asset codes are fresh each run (a Stellar Asset Contract can only be created once per asset).
 * Prerequisites: `stellar` CLI, `pnpm build`, and the contract: cd contracts && stellar contract build --manifest-path settle/Cargo.toml
 * Usage: SLUICE_IPV4_FIRST=1 pnpm w7:cli-wallets-testnet
 */
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { preferIpv4, Router, simulateView } from "../packages/core/src/index.js";
import { createApp } from "../packages/api/src/app.js";
import { loadOrdersConfig } from "../packages/api/src/orders/config.js";
import { defaultOrdersDeps } from "../packages/api/src/orders/deps.js";
import { createOrdersService } from "../packages/api/src/orders/service.js";
import { Sluice, signOrder, signOrderTx, type SignAuthEntry, type SignTransaction } from "../packages/sdk/src/index.js";
import { RemoteSolver } from "../packages/solver/dist/index.js";
import { Address, Asset, hash as sha256, Keypair, StrKey, xdr } from "../packages/api/node_modules/@stellar/stellar-sdk/lib/index.js";
import {
  apiServer, Book, BASE_TIERS, check, failureCount, fmt, friendbot, HORIZON, PASS, retry, retryingFetch, RPC, setupMarket, sleep, spawnSolver, timedFetch, waitFor, waitSolverUp,
  type Market, type SolverProc,
} from "./lib/testnet.js";

if (process.env.SLUICE_IPV4_FIRST === "1") preferIpv4();
const t0 = Date.now();
const log = (msg: string) => console.log(`  [+${Math.round((Date.now() - t0) / 1000)}s] ${msg}`);

// --- The Stellar CLI as the wallet -----------------------------------------------------------------------------------------
const cli = (args: string[], input?: string): string => execFileSync("stellar", args, { encoding: "utf8", input, stdio: ["pipe", "pipe", "pipe"] }).trim();
function identity(name: string): Keypair {
  let address: string | undefined;
  try {
    address = cli(["keys", "address", name]);
  } catch {
    log(`creating CLI identity ${name} (testnet, friendbot)`);
    cli(["keys", "generate", name, "--network", "testnet", "--fund"]);
    address = cli(["keys", "address", name]);
  }
  const kp = Keypair.fromSecret(cli(["keys", "secret", name]));
  if (kp.publicKey() !== address) throw new Error(`keystore mismatch for ${name}`);
  return kp;
}
const NAMES = { issuer: "sluice-issuer", user: "sluice-user", solver: "sluice-solver", maker: "sluice-maker", stranger: "sluice-stranger" } as const;
const keys = Object.fromEntries(Object.entries(NAMES).map(([role, name]) => [role, identity(name)])) as Record<keyof typeof NAMES, Keypair>;
// A key created in an earlier run (or whose `--fund` call failed on this flaky network) may have no account yet: only a clear 404 means "unfunded".
for (const [role, kp] of Object.entries(keys)) {
  const status = await retry("horizon", async () => {
    const r = await timedFetch(`${HORIZON}/accounts/${kp.publicKey()}`);
    if (r.status !== 200 && r.status !== 404) throw new Error(`horizon ${r.status}`);
    return r.status;
  });
  if (status === 404) {
    log(`${NAMES[role as keyof typeof NAMES]} has no account on this testnet: friendbot`);
    await friendbot(kp);
  }
}

const suffix = Array.from(randomBytes(4), (b) => "ABCDEFGHJKLMNPQRSTUVWXYZ"[b % 24]).join("");
const m: Market = await setupMarket({ keys, funded: true, codes: [`CLA${suffix}`, `CLC${suffix}`] });
const book = new Book(m);
const sacBal = async (token: string, g: string) => (await retry("balance", () => simulateView(RPC, token, "balance", [new Address(g).toScVal()], { passphrase: PASS }))) as bigint;
const tokenA = m.A.contractId(PASS), tokenC = m.C.contractId(PASS), tokenX = Asset.native().contractId(PASS);
const stateDir = await mkdtemp(join(tmpdir(), "sluice-w7-"));
const SOLVER_PORT = 18913;
const token = randomBytes(32).toString("hex");
const solver: SolverProc = spawnSolver({ port: SOLVER_PORT, token, secret: m.solver.secret(), settle: m.settleId, horizonUrl: HORIZON, stateDir, extraEnv: { SOLVER_RETRY_TICK_MS: "3000" } });

try {
  await book.set(BASE_TIERS);
  log("maker posted 60 C @ 1.03 A and 200 C @ 1.05 A");
  await waitSolverUp(solver);

  const env = {
    ORDERS_SETTLE_CONTRACT: m.settleId, ORDERS_RPC_URL: RPC, ORDERS_HORIZON_URL: HORIZON, ORDERS_NETWORK_PASSPHRASE: PASS,
    ORDERS_MAC_SECRET: createHash("sha256").update(m.issuer.secret()).digest("hex"),
    ORDERS_SOLVER_MODE: "remote", ORDERS_SOLVER_URL: `http://127.0.0.1:${SOLVER_PORT}`, ORDERS_SOLVER_TOKEN: token, ORDERS_SOLVER_ADDRESS: m.solver.publicKey(),
  };
  const setup = loadOrdersConfig(env);
  if (!setup.enabled) throw new Error(`orders config rejected: ${setup.reason}`);
  const service = createOrdersService(setup.config, defaultOrdersDeps(setup.config, { server: apiServer, fetchImpl: retryingFetch }), new RemoteSolver({ url: env.ORDERS_SOLVER_URL, token, address: m.solver.publicKey(), writeTimeoutMs: 90_000 }));
  const app = createApp(new Router({ sources: [], hubs: [] }), {}, { orders: { enabled: true, service } });
  const sluice = new Sluice("http://sluice.test", async (input, init) => app.fetch(new Request(input, init)));
  const cfg = await sluice.ordersConfig();
  if (!cfg.enabled) throw new Error(`orders disabled: ${cfg.reason}`);
  const opts = { settleContract: cfg.settleContract, solver: cfg.solver };
  check("config: both signing tiers advertised, solver and contract as deployed", cfg.signing.tiers?.join() === "auth-entry,tx" && cfg.solver === m.solver.publicKey() && cfg.settleContract === m.settleId, JSON.stringify(cfg.signing));

  const prep = async <T extends { solverWillFill: boolean; skipReasons?: string[] }>(go: () => Promise<T>): Promise<Extract<T, { solverWillFill: true }>> => {
    for (let i = 0; i < 30; i++) {
      const r = await go();
      if (r.solverWillFill) return r as Extract<T, { solverWillFill: true }>;
      log(`book not visible yet (${r.skipReasons?.join(", ")})`);
      await sleep(3000);
    }
    throw new Error("the solver never agreed to fill the order");
  };
  const hedged = async (hash: string) => {
    let h = (await sluice.order(hash)).hedge;
    for (let i = 0; i < 80 && h?.status !== "HEDGED" && h?.status !== "ABANDONED" && h?.status !== "UNHEDGED"; i++) {
      await sleep(3000);
      h = (await sluice.order(hash)).hedge;
    }
    return h;
  };

  // ============================= TIER 2: `stellar tx sign` is the wallet =============================
  console.log("\n--- tier 2: the Stellar CLI signs the transaction ---");
  let cliSignCalls = 0;
  const cliWallet: SignTransaction = async (txXdr, o) => {
    cliSignCalls++;
    if (o.networkPassphrase !== PASS) throw new Error("wrong network handed to the wallet");
    const signed = cli(["tx", "sign", "--sign-with-key", NAMES.user, "--network", "testnet"], txXdr);
    return { signedTxXdr: signed, signerAddress: m.user.publicKey() };
  };
  const a0 = await sacBal(tokenA, m.user.publicKey());
  const x0 = await sacBal(tokenX, m.user.publicKey());
  const P = await prep(() => sluice.prepareOrderTx({ account: m.user.publicKey(), assetIn: m.idA, assetOut: m.idC, amount: "50" }));
  log(`prepared ${P.tx.hash}: pay ${P.summary.pay} A, receive at least ${P.summary.receiveAtLeast} C (expected ${P.summary.expected}); fee shown at most ${P.summary.networkFee} XLM, paid by the user`);
  const signedTx = await signOrderTx(P, cliWallet, opts);
  check("the CLI signed the transaction it was shown (`stellar tx sign`), and the SDK verified hash and signature", cliSignCalls === 1, `CLI sign calls ${cliSignCalls}`);
  const sent2 = await sluice.submitOrderTx({ orderId: P.orderId, order: P.order, signedTx });
  log(`submitted ${sent2.hash}`);
  const done2 = await sluice.waitForOrder(sent2.hash, { timeoutMs: 180_000 });
  check("tier 2: the fill settles", done2.status === "SUCCESS", `${done2.status} ledger ${done2.ledger}`);
  check("tier 2: received equals the amount the solver agreed to", done2.received === P.summary.expected, `${done2.received} vs ${P.summary.expected}`);
  const env2 = ((await waitFor(sent2.hash)) as { envelopeXdr: xdr.TransactionEnvelope }).envelopeXdr.v1().tx();
  const a1 = await sacBal(tokenA, m.user.publicKey()), x1 = await sacBal(tokenX, m.user.publicKey()), c1 = await sacBal(tokenC, m.user.publicKey());
  check("tier 2: sourced from the CLI user's account, which paid the fee", StrKey.encodeEd25519PublicKey(env2.sourceAccount().ed25519()) === m.user.publicKey() && x0 - x1 > 0n, `user XLM -${fmt(x0 - x1)}`);
  check("tier 2: the user paid exactly 50 A and got the C, trustline created inside the fill", a0 - a1 === 50n * 10_000_000n && fmt(c1) === P.summary.expected, `A ${fmt(a1)}, C ${fmt(c1)}`);
  const h2 = await hedged(sent2.hash);
  check("tier 2: the solver's hedge", h2?.status === "HEDGED", JSON.stringify(h2));

  // ============================= TIER 1: one authorisation entry, the solver pays the fee =============================
  console.log("\n--- tier 1: the user signs one authorisation entry (key from the CLI keystore) ---");
  await book.set(BASE_TIERS);
  let entryCalls = 0;
  const userKp = Keypair.fromSecret(cli(["keys", "secret", NAMES.user]));
  const entryWallet: SignAuthEntry = async (preimageBase64, o) => {
    entryCalls++;
    if (o.networkPassphrase !== PASS) throw new Error("wrong network handed to the wallet");
    return { signedAuthEntry: userKp.sign(sha256(Buffer.from(preimageBase64, "base64"))).toString("base64"), signerAddress: userKp.publicKey() };
  };
  const a2 = await sacBal(tokenA, m.user.publicKey()), x2 = await sacBal(tokenX, m.user.publicKey()), c2 = await sacBal(tokenC, m.user.publicKey());
  const Q = await prep(() => sluice.prepareOrder({ account: m.user.publicKey(), assetIn: m.idA, assetOut: m.idC, amount: "40" }));
  log(`prepared order ${Q.orderId.slice(0, 20)}…: pay ${Q.summary.pay} A, receive at least ${Q.summary.receiveAtLeast} C (expected ${Q.summary.expected})`);
  const signedEntry = await signOrder(Q, entryWallet, { settleContract: cfg.settleContract });
  const sent1 = await sluice.submitOrder({ orderId: Q.orderId, order: Q.order, signedAuthEntry: signedEntry });
  log(`submitted ${sent1.hash}`);
  const done1 = await sluice.waitForOrder(sent1.hash, { timeoutMs: 180_000 });
  check("tier 1: the fill settles", done1.status === "SUCCESS", `${done1.status} ledger ${done1.ledger}`);
  const env1 = ((await waitFor(sent1.hash)) as { envelopeXdr: xdr.TransactionEnvelope }).envelopeXdr.v1().tx();
  const a3 = await sacBal(tokenA, m.user.publicKey()), x3 = await sacBal(tokenX, m.user.publicKey()), c3 = await sacBal(tokenC, m.user.publicKey());
  check("tier 1: sourced from the SOLVER; the user signed only an auth entry and paid no fee", StrKey.encodeEd25519PublicKey(env1.sourceAccount().ed25519()) === m.solver.publicKey() && x3 === x2 && entryCalls === 1, `user XLM change ${fmt(x3 - x2)}, entry-sign calls ${entryCalls}`);
  check("tier 1: the user paid exactly 40 A and received the agreed C", a2 - a3 === 40n * 10_000_000n && fmt(c3 - c2) === Q.summary.expected, `A -${fmt(a2 - a3)}, C +${fmt(c3 - c2)} (expected ${Q.summary.expected})`);
  const h1 = await hedged(sent1.hash);
  check("tier 1: the solver's hedge", h1?.status === "HEDGED", JSON.stringify(h1));
  const heldA = await sacBal(tokenA, m.solver.publicKey());
  check("the solver holds no leftover A after both hedges", heldA === 0n, `solver A ${fmt(heldA)}`);

  console.log(`\nidentities: ${Object.values(NAMES).join(", ")} (stellar keys ls)\nuser ${m.user.publicKey()}\nsettle ${m.settleId}\ntier-2 fill ${sent2.hash}  hedge ${h2?.status === "HEDGED" ? h2.hash : "-"}\ntier-1 fill ${sent1.hash}  hedge ${h1?.status === "HEDGED" ? h1.hash : "-"}`);
} finally {
  await solver.kill().catch(() => undefined);
  await rm(stateDir, { recursive: true, force: true });
}
console.log(failureCount() ? `\n${failureCount()} check(s) FAILED` : "\nall checks passed");
process.exit(failureCount() ? 1 : 0);
