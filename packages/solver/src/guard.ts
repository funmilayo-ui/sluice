import { Networks } from "@stellar/stellar-sdk";

/**
 * True for the public (mainnet) network passphrase, however it is spelled.
 *
 * HARD GUARD. The settlement contract is unaudited, so settlement orders refuse to run against the public network
 * until it has been audited. There is deliberately no environment switch to override this: lifting it is a code
 * change that has to be reviewed. It is enforced in the API's configuration loader, when the API builds its service,
 * and again by the solver itself (its configuration, its node, and the network its RPC endpoint reports on first use),
 * so a solver service started by hand on the wrong network refuses too.
 */
export function isPublicNetwork(passphrase: string): boolean {
  const p = passphrase.trim().toLowerCase();
  return p === Networks.PUBLIC.toLowerCase() || p.includes("public global stellar network");
}

export class MainnetRefused extends Error {
  constructor() {
    super("settlement orders are testnet-only: the public network is refused until the contract is audited");
    this.name = "MainnetRefused";
  }
}

export function assertNotMainnet(passphrase: string): void {
  if (isPublicNetwork(passphrase)) throw new MainnetRefused();
}
