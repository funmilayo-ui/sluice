import { Account, Address, BASE_FEE, nativeToScVal, Operation, rpc, Transaction, TransactionBuilder, xdr } from "@stellar/stellar-sdk";
import { viaRpc } from "@sluice/core";
import { isAddressEntry } from "./auth.js";
import { encodeOrder, type Order } from "./order.js";

/** Thrown when the network refuses a simulation. `message` is the raw RPC error (all lines). */
export class FillSimulationError extends Error {}

export interface FillCtx {
  settleContract: string;
  passphrase: string;
  /** The solver's public address: the `solver` argument of `fill`, and the source of a tier-1 transaction. */
  solverId: string;
}

export const fillOp = (ctx: FillCtx, order: Order, amountOut: bigint) =>
  Operation.invokeContractFunction({
    contract: ctx.settleContract,
    function: "fill",
    args: [encodeOrder(order), new Address(ctx.solverId).toScVal(), nativeToScVal(amountOut, { type: "i128" })],
  });

/**
 * A `fill` transaction whose source is `account` (which advances its sequence: pass a fresh `Account` each time).
 * With `auth` the authorisation entries are set as given, so a simulation enforces them.
 */
export function fillTx(ctx: FillCtx, account: Account, order: Order, amountOut: bigint, auth?: xdr.SorobanAuthorizationEntry[], timeoutSec = 300): Transaction {
  const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: ctx.passphrase }).addOperation(fillOp(ctx, order, amountOut)).setTimeout(timeoutSec).build();
  if (!auth) return tx;
  return withAuth(tx, auth, ctx.passphrase);
}

/** The same transaction with its operation's authorisation entries replaced. */
export function withAuth(tx: Transaction, auth: xdr.SorobanAuthorizationEntry[], passphrase: string): Transaction {
  const env = tx.toEnvelope();
  env.v1().tx().operations()[0]!.body().invokeHostFunctionOp().auth(auth);
  return new Transaction(env, passphrase);
}

export interface FillAuthSimulation {
  /** The user's entry: as recorded (unsigned) or as given. */
  userEntry: xdr.SorobanAuthorizationEntry;
  minResourceFee: bigint;
  /** Every entry the transaction needs, with the user's replaced by the signed one when given. */
  auth: xdr.SorobanAuthorizationEntry[];
  /** The enforcing simulation, when a signed user entry was given. */
  enforced?: rpc.Api.SimulateTransactionSuccessResponse;
}

/**
 * Simulate a tier-1 `fill` (the solver is the source). Without `signedUser` the network RECORDS the authorisation the
 * user must give; with it the network ENFORCES it, so the signature, the nonce and the contract's rules are really checked.
 * Needs only the solver's public address: nothing here signs.
 */
export async function simulateFillAuth(server: rpc.Server, rpcUrl: string, ctx: FillCtx, order: Order, amountOut: bigint, signedUser?: xdr.SorobanAuthorizationEntry): Promise<FillAuthSimulation> {
  const solverAccount = async () => new Account(ctx.solverId, (await viaRpc(rpcUrl, () => server.getAccount(ctx.solverId))).sequenceNumber());
  const sim = (tx: Transaction) => viaRpc(rpcUrl, () => server.simulateTransaction(tx));
  const rec = await sim(fillTx(ctx, await solverAccount(), order, amountOut));
  if (rpc.Api.isSimulationError(rec)) throw new FillSimulationError(rec.error);
  const recorded = rec.result?.auth ?? [];
  const mine = recorded.find((e) => isAddressEntry(e) && Address.fromScAddress(e.credentials().address().address()).toString() === order.user);
  if (!mine) throw new FillSimulationError("simulation asked for no authorisation from the user");
  if (!signedUser) return { userEntry: mine, minResourceFee: BigInt(rec.minResourceFee), auth: recorded };
  const auth = recorded.map((e) => (e === mine ? signedUser : e));
  const enforced = await sim(fillTx(ctx, await solverAccount(), order, amountOut, auth));
  if (rpc.Api.isSimulationError(enforced)) throw new FillSimulationError(enforced.error);
  return { userEntry: signedUser, minResourceFee: BigInt(enforced.minResourceFee), auth, enforced };
}
