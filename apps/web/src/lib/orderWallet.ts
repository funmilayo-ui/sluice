/**
 * Which wallets can sign a settlement order, and what a failed signature request means.
 *
 * A settlement order is signed as a Soroban authorisation entry (SEP-43 `signAuthEntry`), not as a transaction.
 * Few wallets implement that. The list below is what has been checked in the wallet kit's source (v2.7.0 and
 * v2.8.0), not what wallets claim:
 *
 *  - Freighter (extension, and Freighter Mobile through WalletConnect) implements it. Kit 2.8.0 renamed the
 *    module to "Varial" and changed its id from "freighter" to "varial"; it calls the same Freighter API.
 *    Both ids (and both display names) are accepted here, so the app works on either kit version and with a
 *    session stored by the other one.
 *  - xBull, Albedo, LOBSTR, Rabet, Ledger and Trezor modules reject with error code -3 ("does not support
 *    signAuthEntry").
 *  - Hana's module forwards the call to the extension; whether the extension signs the same bytes is unverified.
 *  - WalletConnect depends on the wallet on the other end.
 *
 * Anything not on a list is treated as unsupported, because the alternative is to let an unknown wallet show a
 * request nobody has checked. When a wallet is verified, add it here and in docs/WALLET_TEST_PASS.md.
 */

import type { SigningTier } from "@sluice/sdk";

export type SigningSupport = "supported" | "unsupported" | "unknown";

/** The same wallet under both of the names the kit has given it: "freighter" up to 2.7, "varial" from 2.8.0. */
const FREIGHTER_FAMILY = ["freighter", "varial"] as const;
const SUPPORTED = new Set<string>(FREIGHTER_FAMILY);
/** Plausible but unverified: the app offers the flow, says so, and handles the wallet refusing. */
const UNKNOWN = new Set(["wallet_connect", "walletconnect", "hana"]);

/**
 * A kit module id or display name in one comparable shape: "Freighter", " varial ", "Wallet Connect" and
 * "wallet-connect" all compare equal to the ids above. Empty or missing is `undefined`.
 */
export function normalizeModuleId(idOrName: string | undefined | null): string | undefined {
  const v = typeof idOrName === "string" ? idOrName.trim().toLowerCase().replace(/[\s-]+/g, "_") : "";
  return v === "" ? undefined : v;
}

/**
 * Whether the wallet module with this kit id (or display name) can sign authorisation entries. No module at all
 * is `unknown`; an id that is present but not on a list is `unsupported`.
 */
export function signingSupport(moduleId: string | undefined): SigningSupport {
  if (moduleId === undefined) return "unknown";
  const id = normalizeModuleId(moduleId);
  if (id === undefined) return "unsupported";
  if (SUPPORTED.has(id)) return "supported";
  if (UNKNOWN.has(id)) return "unknown";
  return "unsupported";
}

/**
 * A session stored by another kit version names a module the current kit does not have ("freighter" after the
 * upgrade to 2.8.0, "varial" after a rollback). Returns the id the current kit calls the same wallet, or
 * `undefined` when the stored id is unknown to it. A stored id the kit already has is returned unchanged.
 */
export function resolveStoredModuleId(stored: string | null | undefined, knownIds: readonly string[]): string | undefined {
  const id = normalizeModuleId(stored);
  if (id === undefined) return undefined;
  const exact = knownIds.find((k) => k === stored);
  if (exact !== undefined) return exact;
  if (FREIGHTER_FAMILY.includes(id as (typeof FREIGHTER_FAMILY)[number])) {
    return knownIds.find((k) => FREIGHTER_FAMILY.includes(k as (typeof FREIGHTER_FAMILY)[number]));
  }
  return knownIds.find((k) => normalizeModuleId(k) === id);
}

/**
 * How a wallet is asked to sign an order.
 *
 *  - "auth-entry" (tier 1): the Soroban authorisation entry (SEP-43 `signAuthEntry`). The solver sends the fill and pays the fee.
 *  - "transaction" (tier 2): SEP-43 `signTransaction` on a transaction the server prepares, with the user's account as its
 *    source. The user sends it (the solver submits it for them) and pays the network fee. It is the same atomic fill; only the
 *    signing step differs. Every wallet module in the kit implements `signTransaction` (checked in kit 2.8.0's source for xBull,
 *    Albedo, LOBSTR, Rabet, Ledger, Trezor and Hana), which is why a wallet that cannot sign an entry can still take this route.
 *  - "none": the wallet cannot take any route this deployment offers.
 *
 * Which routes a deployment offers comes from `GET /v1/orders/config` (`signing.tiers`); a server that predates tiers offers
 * only "auth-entry". A wallet that can sign an entry uses tier 1 (no fee for the user); one known not to uses tier 2 when the
 * server has it, and has no route otherwise.
 */
export type { SigningTier };
export type SigningRoute = "auth-entry" | "transaction" | "none";
/** What a server that does not say offers. */
export const DEFAULT_TIERS: readonly SigningTier[] = ["auth-entry"];

export function signingRoute(moduleId: string | undefined, tiers: readonly SigningTier[] | undefined = DEFAULT_TIERS): SigningRoute {
  const entry = tiers.includes("auth-entry");
  const tx = tiers.includes("tx");
  if (signingSupport(moduleId) !== "unsupported" && entry) return "auth-entry";
  return tx ? "transaction" : "none";
}

export const UNSUPPORTED_WALLET_TITLE = "Your wallet cannot sign this kind of order yet";
export const NO_WALLET_SELECTED_MESSAGE =
  "Your wallet connection is out of date. Disconnect and connect your wallet again. Nothing was signed or sent.";
export const UNSUPPORTED_WALLET_MESSAGE =
  "Your wallet cannot sign this kind of order yet. Use Freighter (listed as Varial in newer wallet pickers), or the standard swap. Nothing was signed or sent.";
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

/** The kit's wording when no wallet is selected (a stored session whose wallet the kit no longer has). */
export const NO_MODULE_WORDS = /set the wallet first|not an? existing module/i;
/** The kit's wording when a module lacks a function: 'X does not support the "signAuthEntry" function', 'Ledger Wallets do not support ...'. */
const NOT_SUPPORTED_WORDS = /\b(?:does|do) not support|\b(?:doesn't|don't) support|\bnot supported\b|\bunsupported\b/i;

/** Tell "this wallet cannot do it" from "the user said no" from "something broke", from what the wallet threw. */
export function classifyWalletFailure(e: unknown): WalletFailure {
  if (e instanceof SigningAborted) return { kind: "rejected", message: e.message, stopped: true };
  const code = codeOf(e);
  const message = messageOf(e);
  if (code === -3) {
    // The kit uses -3 for several unrelated things. Only the kit's own wording for "this wallet has no such
    // function" (and a bare -3 with no wording) means unsupported; the rest are failures with a different cure.
    if (NO_MODULE_WORDS.test(message)) return { kind: "other", message: NO_WALLET_SELECTED_MESSAGE };
    if (message === "" || NOT_SUPPORTED_WORDS.test(message)) return { kind: "unsupported", message: UNSUPPORTED_WALLET_MESSAGE };
    return { kind: "other", message };
  }
  if ((code !== undefined && REJECTED_CODES.has(code)) || ((code === undefined || code === -1) && REJECTED_WORDS.test(message))) {
    return { kind: "rejected", message: "You declined the request in your wallet. Nothing was signed or sent.", stopped: false };
  }
  return { kind: "other", message: message || "The wallet did not respond." };
}
