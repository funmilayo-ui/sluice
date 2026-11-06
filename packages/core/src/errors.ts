import { SOROSWAP_ROUTER } from "./execute/soroban.js";

export interface Explained {
  /** Stable machine code, e.g. INSUFFICIENT_BALANCE. */
  code: string;
  /** One sentence a user can act on. */
  message: string;
  /** The original first line or result codes, for a "details" disclosure and for bug reports. */
  detail: string;
}

const FEE_ONLY = "Only the network fee was charged.";

/** Result code names as the Stellar SDK spells them (checked against the SDK's enums in the tests). */
const BY_CODE: Record<string, [code: string, message: string]> = {
  txBadSeq: ["STALE_SEQUENCE", "This account sent another transaction after this one was built. Build it again."],
  txTooLate: ["EXPIRED", "This transaction expired before it reached the network. Build it again."],
  txTooEarly: ["TOO_EARLY", "This transaction is not valid yet. Check the clock on this device and build it again."],
  txInsufficientBalance: ["FEE_BALANCE", "Not enough XLM to pay the network fee."],
  txInsufficientFee: ["FEE_TOO_LOW", "The network is busy and the fee was too low. Try again in a moment."],
  txBadAuth: ["BAD_SIGNATURE", "The signature does not match this account. Check that the wallet is on Mainnet and on the connected account."],
  txBadAuthExtra: ["BAD_SIGNATURE", "The transaction carries a signature it does not need. Sign with the connected account only."],
  txNoAccount: ["NO_ACCOUNT", "This account does not exist on Mainnet yet. Fund it with XLM first."],
  txSorobanInvalid: ["STALE_SIMULATION", "The network rejected the simulated resources. Build it again."],
  pathPaymentStrictSendUnderDestmin: ["SLIPPAGE", `The price moved past your slippage limit, so the swap did not execute. ${FEE_ONLY}`],
  pathPaymentStrictSendUnderfunded: ["INSUFFICIENT_BALANCE", `This account does not hold enough of the asset being sold. ${FEE_ONLY}`],
  pathPaymentStrictSendSrcNoTrust: ["NO_TRUSTLINE", `This account has no trustline for the asset being sold. ${FEE_ONLY}`],
  pathPaymentStrictSendNoTrust: ["NO_TRUSTLINE", `This account has no trustline for the asset being bought. Add the trustline first. ${FEE_ONLY}`],
  pathPaymentStrictSendSrcNotAuthorized: ["NOT_AUTHORIZED", `The issuer has not authorised this account to hold the asset being sold. ${FEE_ONLY}`],
  pathPaymentStrictSendNotAuthorized: ["NOT_AUTHORIZED", `The issuer has not authorised this account to hold the asset being bought. ${FEE_ONLY}`],
  pathPaymentStrictSendLineFull: ["LINE_FULL", `The trustline limit for the asset being bought is too low for this amount. ${FEE_ONLY}`],
  pathPaymentStrictSendTooFewOffers: ["NO_LIQUIDITY", `The offers this route relied on are gone. Quote again. ${FEE_ONLY}`],
  pathPaymentStrictSendOfferCrossSelf: ["CROSS_SELF", `This swap would trade against this account's own offer. ${FEE_ONLY}`],
  changeTrustLowReserve: ["LOW_RESERVE", `A trustline locks 0.5 XLM as reserve and this account does not have it spare. ${FEE_ONLY}`],
  invokeHostFunctionTrapped: ["CONTRACT_REJECTED", `The venue contract rejected the swap, usually because the price moved past your minimum. ${FEE_ONLY}`],
  invokeHostFunctionResourceLimitExceeded: ["STALE_SIMULATION", `The swap needed more resources than were simulated. Build it again. ${FEE_ONLY}`],
  invokeHostFunctionEntryArchived: ["STALE_SIMULATION", `Contract state this swap touches was archived after simulation. Build it again. ${FEE_ONLY}`],
  invokeHostFunctionInsufficientRefundableFee: ["STALE_SIMULATION", `The simulated fee no longer covers this swap. Build it again. ${FEE_ONLY}`],
  opNoAccount: ["NO_ACCOUNT", "This account does not exist on Mainnet yet. Fund it with XLM first."],
  opBadAuth: ["BAD_SIGNATURE", "The signature does not match this account. Check that the wallet is on Mainnet and on the connected account."],
};
export const EXPLAINED_RESULT_CODES = Object.keys(BY_CODE);

/** Explain a rejected or failed transaction from its result codes (transaction code first, then operation codes). */
export function explainCodes(codes: string[]): Explained {
  const detail = codes.join(", ");
  // The operation code is the specific cause; "txFailed" only says that some operation failed.
  for (const c of [...codes].reverse()) {
    const hit = BY_CODE[c];
    if (hit) return { code: hit[0], message: hit[1], detail };
  }
  return { code: "FAILED", message: "The network did not accept this transaction.", detail };
}

/** Blend pool error numbers that a supply or withdrawal can hit (blend-contracts-v2 `pool/src/errors.rs`). */
const BLEND: Record<number, [code: string, message: string]> = {
  1205: ["HEALTH_FACTOR", "This would leave the account's Blend borrowing under-collateralised."],
  1206: ["POOL_STATUS", "The pool is frozen and is not accepting deposits right now. Withdrawals stay open."],
  1207: ["UTILIZATION", "The pool does not have enough idle funds for this amount right now. Try a smaller amount."],
  1216: ["AMOUNT_TOO_SMALL", "This amount is too small for the pool to credit."],
  1217: ["NOTHING_TO_WITHDRAW", "There is nothing supplied to withdraw for this asset."],
  1220: ["SUPPLY_CAP", "This deposit would exceed the pool's supply cap for this asset. Try a smaller amount."],
  1223: ["RESERVE_DISABLED", "The pool has disabled this asset."],
};

/**
 * Explain a failed simulation. The patterns are the strings the network actually returns (captured from
 * mainnet simulations on 2026-10-08), matched on the full event log because the first line alone is only
 * "Error(Contract, #n)" and the same number means different things in different contracts. Pass `venue` when
 * the call was to a contract whose own error numbers are known.
 */
export function explainSimulation(raw: string, venue?: "blend"): Explained {
  const detail = (raw.split("\n")[0] ?? "").slice(0, 200);
  if (venue === "blend") {
    const hit = BLEND[Number(/Error\(Contract, #(\d+)\)/.exec(detail)?.[1])];
    if (hit) return { code: hit[0], message: `${hit[1]} Nothing was signed or sent.`, detail };
  }
  // Asset contract: data is ["resulting balance is not within the allowed range", min, resulting, max].
  const range = /resulting balance is not within the allowed range",\s*(-?\d+),\s*(-?\d+),\s*(-?\d+)/.exec(raw);
  if (range) {
    const [min, resulting, max] = [BigInt(range[1]!), BigInt(range[2]!), BigInt(range[3]!)];
    if (resulting < min) {
      return { code: "INSUFFICIENT_BALANCE", message: "This account does not hold enough of the asset being sold (XLM also keeps a locked reserve). Nothing was signed or sent.", detail };
    }
    if (resulting > max) {
      return { code: "LINE_FULL", message: "The trustline limit for the asset being bought is too low for this amount. Nothing was signed or sent.", detail };
    }
  }
  if (/trustline entry is missing/i.test(raw)) {
    return { code: "NO_TRUSTLINE", message: "This account has no trustline for one of the assets in this swap. Nothing was signed or sent.", detail };
  }
  // Soroswap router raises #507 when the output would be below amount_out_min.
  if (new RegExp(`contract:${SOROSWAP_ROUTER}, topics:\\[error, Error\\(Contract, #507\\)\\]`).test(raw)) {
    return { code: "SLIPPAGE", message: "The price moved past your slippage limit. Quote again. Nothing was signed or sent.", detail };
  }
  if (/timed out|ETIMEDOUT|ECONNRESET|fetch failed/i.test(raw)) {
    return { code: "NETWORK", message: "The Stellar network endpoint did not answer in time. Try again.", detail };
  }
  return { code: "SIMULATION_FAILED", message: "The venue rejected this swap in simulation, so it was not offered for signing. Nothing was sent.", detail };
}

/** Settlement contract error numbers (`contracts/settle/src/lib.rs`, enum `Error`), in words a user can act on. */
const SETTLE: Record<number, [code: string, message: string]> = {
  1: ["BAD_AMOUNT", "The order has a zero or negative amount, or the solver offered less than the minimum you signed for."],
  2: ["SAME_TOKEN", "The order sells and buys the same asset."],
  3: ["EXPIRED", "The order's deadline has passed. Prepare a new order."],
  4: ["BAD_SOLVER", "The order cannot be filled by the account that tried to fill it."],
  5: ["BELOW_MIN_OUT", "The solver's payment would leave you with less than the minimum you signed for, so the contract refused it."],
};

/** The contract's own explanation for a settlement error number, or null for a number it does not define. */
export function explainSettleCode(n: number): Explained | null {
  const hit = SETTLE[n];
  return hit ? { code: hit[0], message: `${hit[1]} Nothing moved.`, detail: `settle contract error #${n}` } : null;
}

/** The settle contract error number in a diagnostic log, taking only errors raised by `settleContract` when it is given. */
export function settleErrorNumber(raw: string, settleContract?: string): number | null {
  for (const m of raw.matchAll(/contract:(C[A-Z2-7]{55}), topics:\[error, Error\(Contract, #(\d+)\)\]/g)) {
    if (!settleContract || m[1] === settleContract) return Number(m[2]);
  }
  // Without events, the first line is all there is ("HostError: Error(Contract, #5)"), and only the caller knows whose it is.
  if (!settleContract) return null;
  const first = /Error\(Contract, #(\d+)\)/.exec(raw.split("\n")[0] ?? "");
  return first && SETTLE[Number(first[1])] && !/contract:C/.test(raw) ? Number(first[1]) : null;
}

/**
 * Explain a failed simulation of `settle.fill`. Settlement contract errors first, then authorization errors
 * (a signature that does not cover this order, one already used, one that has expired), then the token
 * balance errors `explainSimulation` knows.
 */
export function explainFill(raw: string, settleContract?: string): Explained {
  const detail = (raw.split("\n")[0] ?? "").slice(0, 200);
  const n = settleErrorNumber(raw, settleContract);
  const settle = n === null ? null : explainSettleCode(n);
  if (settle) return { ...settle, detail };
  if (/Error\(Auth, ExistingValue\)/.test(raw)) {
    return { code: "ALREADY_USED", message: "This signed order has already been used. Prepare a new one. Nothing moved.", detail };
  }
  if (/Error\(Auth, InvalidAction\)|signature expired|Error\(Auth, InvalidInput\)/i.test(raw)) {
    return { code: "BAD_SIGNATURE", message: "The signature does not match this order, or it has expired. Prepare a new order and sign again. Nothing moved.", detail };
  }
  const generic = explainSimulation(raw);
  if (generic.code === "SIMULATION_FAILED") {
    return { code: "SIMULATION_FAILED", message: "The settlement was rejected in simulation, so nothing was sent.", detail };
  }
  return generic;
}
