import { Account, BASE_FEE, Networks, Operation, TransactionBuilder } from "@stellar/stellar-sdk";
import { formatAmount } from "../amounts.js";
import { parseAsset } from "../assets.js";
import type { Leg } from "../types.js";

export interface ClassicBuildOpts {
  source: string;
  /** Current sequence number of the source account (string, as Horizon returns it). */
  sequence: string;
  destination?: string;
  minOut: bigint;
  passphrase?: string;
  timeoutSec?: number;
  fee?: string;
}

/**
 * Build an unsigned PathPaymentStrictSend transaction for a Classic leg. The path comes from the
 * quote; core still chooses SDEX vs Classic pools per hop at apply time. The caller signs and submits.
 */
export function buildClassicSwap(leg: Leg, o: ClassicBuildOpts): string {
  if (leg.layer !== "classic") throw new Error("not a classic leg");
  const tx = new TransactionBuilder(new Account(o.source, o.sequence), {
    fee: o.fee ?? BASE_FEE,
    networkPassphrase: o.passphrase ?? Networks.PUBLIC,
  })
    .addOperation(
      Operation.pathPaymentStrictSend({
        sendAsset: parseAsset(leg.assetIn),
        sendAmount: formatAmount(leg.amountIn),
        destination: o.destination ?? o.source,
        destAsset: parseAsset(leg.assetOut),
        destMin: formatAmount(o.minOut),
        path: leg.hops.map(parseAsset),
      }),
    )
    .setTimeout(o.timeoutSec ?? 60)
    .build();
  return tx.toXDR();
}

/** Unsigned `changeTrust` (maximum limit) so an account can receive a Classic asset. */
export function buildChangeTrust(asset: string, o: { source: string; sequence: string; passphrase?: string; fee?: string; timeoutSec?: number }): string {
  return new TransactionBuilder(new Account(o.source, o.sequence), {
    fee: o.fee ?? BASE_FEE,
    networkPassphrase: o.passphrase ?? Networks.PUBLIC,
  })
    .addOperation(Operation.changeTrust({ asset: parseAsset(asset) }))
    .setTimeout(o.timeoutSec ?? 60)
    .build()
    .toXDR();
}
