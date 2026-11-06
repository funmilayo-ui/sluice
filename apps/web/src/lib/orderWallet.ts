/**
 * Which wallets can sign a settlement order, and what a failed signature request means.
 *
 * A settlement order is signed as a Soroban authorisation entry (SEP-43 `signAuthEntry`), not as a transaction.
 * Few wallets implement that. The list below is what has been checked in the wallet kit's source (v2.7.0), not
 * what wallets claim:
 *
 *  - Freighter (extension, and Freighter Mobile through WalletConnect) implements it.
 *  - xBull, Albedo, LOBSTR and Rabet modules reject with error code -3 ("does not support signAuthEntry").
 *  - Hana's module forwards the call to the extension; whether the extension signs the same bytes is unverified.
 *  - WalletConnect depends on the wallet on the other end.
 *
 * Anything not on a list is treated as unsupported, because the alternative is to let an unknown wallet show a
 * request nobody has checked. When a wallet is verified, add it here and in docs/WALLET_TEST_PASS.md.
 * The kit renamed Freighter's module in 2.8.0 ("Varial"); check its id when upgrading.
 */

export type SigningSupport = "supported" | "unsupported" | "unknown";

const SUPPORTED = new Set(["freighter"]);
/** Plausible but unverified: the app offers the flow, says so, and handles the wallet refusing. */
const UNKNOWN = new Set(["wallet_connect", "hana"]);

/** Whether the wallet module with this kit id can sign authorisation entries. No module id at all is `unknown`. */
export function signingSupport(moduleId: string | undefined): SigningSupport {
  if (moduleId === undefined) return "unknown";
  if (SUPPORTED.has(moduleId)) return "supported";
  if (UNKNOWN.has(moduleId)) return "unknown";
  return "unsupported";
}

export const UNSUPPORTED_WALLET_TITLE = "Your wallet cannot sign this kind of order yet";
export const UNSUPPORTED_WALLET_MESSAGE =
  "Your wallet cannot sign this kind of order yet. Use Freighter, or the standard swap. Nothing was signed or sent.";
export const UNKNOWN_WALLET_NOTE =
  "This wallet has not been confirmed to sign orders. You can try: if it cannot, it will say so and nothing is sent.";

/** Raised by the app when the user stops waiting for a wallet that never answers. */
export class SigningAborted extends Error {
  constructor() {
    super("You stopped waiting for the wallet.");
    this.name = "SigningAborted";
  }
}

export type WalletFailure =
  /** The wallet has no signAuthEntry (kit code -3). Retrying will not help. */
  | { kind: "unsupported"; message: string }
  /** The user said no in the wallet (kit code -4), or stopped waiting. Nothing was signed. */
  | { kind: "rejected"; message: string; stopped: boolean }
  /** Anything else: the wallet failed, or returned something the app refuses. */
  | { kind: "other"; message: string };

const codeOf = (e: unknown): number | undefined => {
  const o = e as { code?: unknown; error?: { code?: unknown } } | null;
  const c = o?.code ?? o?.error?.code;
  return typeof c === "number" ? c : undefined;
};
const messageOf = (e: unknown): string => {
  const o = e as { message?: unknown; error?: { message?: unknown } } | string | null;
  if (typeof o === "string") return o;
  const m = (typeof o === "object" && o && (o.error?.message ?? o.message)) || "";
  return typeof m === "string" ? m : "";
};

/** WalletConnect reports a refusal as 5000; the kit and Freighter use -4. The kit's catch-all code is -1: only then is the wording consulted. */
const REJECTED_CODES = new Set([-4, 5000]);
const REJECTED_WORDS = /\b(reject(ed)?|declin(e|ed)|denied|cancel(l)?ed|refused by (the )?user)\b/i;

/** Tell "this wallet cannot do it" from "the user said no" from "something broke", from what the wallet threw. */
export function classifyWalletFailure(e: unknown): WalletFailure {
  if (e instanceof SigningAborted) return { kind: "rejected", message: e.message, stopped: true };
  const code = codeOf(e);
  const message = messageOf(e);
  if (code === -3) return { kind: "unsupported", message: UNSUPPORTED_WALLET_MESSAGE };
  if ((code !== undefined && REJECTED_CODES.has(code)) || ((code === undefined || code === -1) && REJECTED_WORDS.test(message))) {
    return { kind: "rejected", message: "You declined the request in your wallet. Nothing was signed or sent.", stopped: false };
  }
  return { kind: "other", message: message || "The wallet did not respond." };
}
