import {
  Account,
  Address,
  BASE_FEE,
  Contract,
  Networks,
  rpc,
  TransactionBuilder,
  nativeToScVal,
  xdr,
} from "@stellar/stellar-sdk";
import { rpcServer, viaRpc } from "../rpc.js";

/** Aquarius router on mainnet. Interface verified on-chain 2026-10-08 with `stellar contract info interface`. */
export const AQUARIUS_ROUTER = "CBQDHNBFBZYE4MKPWBSJOPIYLW4SFSXAXUTSXJN76GNKYVYPCKWC6QUK";
/** Soroswap router on mainnet (from soroswap/core public/mainnet.contracts.json). ABI verified on-chain 2026-10-08. */
export const SOROSWAP_ROUTER = "CAG5LRYQ5JVEUI5TEID72EYOVX44TTUJT5BQR2J6J77FH65PCCFAJDDH";

interface BaseOpts {
  /** G... account that will sign. */
  source: string;
  sequence: string;
  passphrase?: string;
  fee?: string;
  timeoutSec?: number;
}

function build(o: BaseOpts, contractId: string, method: string, args: xdr.ScVal[]): string {
  return new TransactionBuilder(new Account(o.source, o.sequence), {
    fee: o.fee ?? BASE_FEE,
    networkPassphrase: o.passphrase ?? Networks.PUBLIC,
  })
    .addOperation(new Contract(contractId).call(method, ...args))
    .setTimeout(o.timeoutSec ?? 60)
    .build()
    .toXDR();
}

/**
 * Atomic Aquarius swap. `swapChainXdr` is the `swap_chain_xdr` field returned by Aquarius find-path,
 * which is already the ScVal for `swaps_chain`. Unsigned and unsimulated: call `prepare` next.
 */
export function buildAquariusSwap(
  o: BaseOpts & {
    router?: string;
    swapChainXdr: string;
    /** SAC contract id (C...) of the input asset. */
    tokenIn: string;
    amountIn: bigint;
    minOut: bigint;
  },
): string {
  return build(o, o.router ?? AQUARIUS_ROUTER, "swap_chained", [
    new Address(o.source).toScVal(),
    xdr.ScVal.fromXDR(o.swapChainXdr, "base64"),
    new Address(o.tokenIn).toScVal(),
    nativeToScVal(o.amountIn, { type: "u128" }),
    nativeToScVal(o.minOut, { type: "u128" }),
  ]);
}

export type VenueKind = "Soroswap" | "Phoenix" | "Comet";

export interface RouterLeg {
  /** Mirrors the contract's VenueKind enum. */
  kind: VenueKind;
  /** Allowlisted venue: a Soroswap-style router, or a Phoenix/Comet pool. */
  venue: string;
  /** Token contract ids, first = input, last = output. */
  path: string[];
}

/** Multi-leg atomic swap through the Sluice router contract (Soroswap-style venues only). */
export function buildSluiceRouterSwap(
  o: BaseOpts & {
    routerContract: string;
    legs: RouterLeg[];
    amountIn: bigint;
    minOut: bigint;
    /** Unix seconds. */
    deadline: bigint;
  },
): string {
  const legs = xdr.ScVal.scvVec(
    o.legs.map((l) =>
      xdr.ScVal.scvMap([
        // Soroban structs are maps with keys sorted alphabetically: kind, path, venue.
        // A unit enum variant is a one-element vec holding the variant name as a symbol.
        new xdr.ScMapEntry({ key: nativeToScVal("kind", { type: "symbol" }), val: xdr.ScVal.scvVec([nativeToScVal(l.kind, { type: "symbol" })]) }),
        new xdr.ScMapEntry({ key: nativeToScVal("path", { type: "symbol" }), val: xdr.ScVal.scvVec(l.path.map((t) => new Address(t).toScVal())) }),
        new xdr.ScMapEntry({ key: nativeToScVal("venue", { type: "symbol" }), val: new Address(l.venue).toScVal() }),
      ]),
    ),
  );
  return build(o, o.routerContract, "swap_exact_in", [
    new Address(o.source).toScVal(),
    legs,
    nativeToScVal(o.amountIn, { type: "i128" }),
    nativeToScVal(o.minOut, { type: "i128" }),
    nativeToScVal(o.deadline, { type: "u64" }),
  ]);
}

export interface Prepared {
  /** Unsigned transaction with footprint, auth and resource fee from simulation. */
  xdr: string;
  minResourceFee: string;
  /** Simulated return value, base64 ScVal. */
  returnValue?: string;
}

/**
 * Simulate against Stellar RPC and assemble the transaction. Throws with the simulation error text on
 * failure, so a route that would revert never reaches a signature prompt.
 */
export async function prepare(rpcUrl: string, txXdr: string, passphrase: string = Networks.PUBLIC): Promise<Prepared> {
  const tx = TransactionBuilder.fromXDR(txXdr, passphrase);
  const sim = await viaRpc(rpcUrl, () => rpcServer(rpcUrl).simulateTransaction(tx));
  if (rpc.Api.isSimulationError(sim)) throw new Error(`simulation failed: ${sim.error}`);
  const assembled = rpc.assembleTransaction(tx, sim).build();
  return {
    xdr: assembled.toXDR(),
    minResourceFee: sim.minResourceFee,
    returnValue: sim.result?.retval.toXDR("base64"),
  };
}

/**
 * Direct Phoenix pool swap. Option params are None (void) so the pool applies its defaults; real protection
 * is `ask_asset_min_amount`. Verified by simulation on mainnet: a holder swapping 10 XLM returned exactly the
 * pool's simulate_swap ask_amount.
 */
export function buildPhoenixSwap(
  o: BaseOpts & { pool: string; offerAsset: string; amountIn: bigint; minOut: bigint },
): string {
  const none = xdr.ScVal.scvVoid();
  return build(o, o.pool, "swap", [
    new Address(o.source).toScVal(),
    new Address(o.offerAsset).toScVal(),
    nativeToScVal(o.amountIn, { type: "i128" }),
    nativeToScVal(o.minOut, { type: "i128" }), // Some(min) is encoded as the bare value
    none, // max_spread_bps
    none, // deadline
    none, // max_allowed_fee_bps
  ]);
}

/** Largest price Comet accepts, same sentinel StellarBroker uses; min-out is the real guard. */
export const COMET_MAX_PRICE = 18_446_744_073_709_551_615n;

/** Direct Comet pool swap (swap_exact_amount_in). Needs the output asset trustline on the account. */
export function buildCometSwap(
  o: BaseOpts & { pool: string; tokenIn: string; tokenOut: string; amountIn: bigint; minOut: bigint },
): string {
  return build(o, o.pool, "swap_exact_amount_in", [
    new Address(o.tokenIn).toScVal(),
    nativeToScVal(o.amountIn, { type: "i128" }),
    new Address(o.tokenOut).toScVal(),
    nativeToScVal(o.minOut, { type: "i128" }),
    nativeToScVal(COMET_MAX_PRICE, { type: "i128" }),
    new Address(o.source).toScVal(),
  ]);
}

/**
 * Direct Soroswap router swap by the user (`to` = user). amount_out_min is the real slippage guard. Signature
 * checked on-chain 2026-10-08.
 */
export function buildSoroswapSwap(
  o: BaseOpts & { router?: string; path: string[]; amountIn: bigint; minOut: bigint; deadline?: bigint },
): string {
  const deadline = o.deadline ?? BigInt(Math.floor(Date.now() / 1000) + 300);
  return build(o, o.router ?? SOROSWAP_ROUTER, "swap_exact_tokens_for_tokens", [
    nativeToScVal(o.amountIn, { type: "i128" }),
    nativeToScVal(o.minOut, { type: "i128" }),
    xdr.ScVal.scvVec(o.path.map((p) => new Address(p).toScVal())),
    new Address(o.source).toScVal(),
    nativeToScVal(deadline, { type: "u64" }),
  ]);
}
