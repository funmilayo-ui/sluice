import { Account, BASE_FEE, Contract, Keypair, Networks, rpc, scValToNative, TransactionBuilder, xdr } from "@stellar/stellar-sdk";

/**
 * Read-only contract call via simulateTransaction. Nothing is signed or submitted, and the source
 * account does not need to exist for view functions that do not require auth.
 * Returns the decoded return value (bigint for integers).
 */
// A view call needs some source account in the envelope; any key will do and it never signs. Generating a
// fresh keypair per call cost real CPU in bursts, so one is made per process.
const VIEW_SOURCE = Keypair.random().publicKey();

const servers = new Map<string, rpc.Server>();
/** One RPC client per endpoint for the process. */
export function rpcServer(rpcUrl: string): rpc.Server {
  let s = servers.get(rpcUrl);
  if (!s) servers.set(rpcUrl, (s = new rpc.Server(rpcUrl)));
  return s;
}

/**
 * A gate that lets at most `max` tasks run at once and queues the rest in arrival order.
 * Measured on mainnet 2026-10-08: 26 contract reads fired at once on a cold process took 5.3s and delayed an
 * unrelated Horizon request by 5.6s, because each one opened its own connection; 8 at a time took 1.8s and
 * 1.4s, because connections were reused.
 */
export function createGate(max: number) {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async function run<T>(task: () => Promise<T>): Promise<T> {
    if (active >= max) await new Promise<void>((resolve) => waiting.push(resolve));
    else active++;
    try {
      return await task();
    } finally {
      // Hand the slot straight to the next waiter, or free it.
      const next = waiting.shift();
      if (next) next();
      else active--;
    }
  };
}

const RPC_MAX_IN_FLIGHT = 8;
const gates = new Map<string, ReturnType<typeof createGate>>();
/** Run a call to `rpcUrl` under that endpoint's shared concurrency gate. */
export function viaRpc<T>(rpcUrl: string, task: () => Promise<T>): Promise<T> {
  let gate = gates.get(rpcUrl);
  if (!gate) gates.set(rpcUrl, (gate = createGate(RPC_MAX_IN_FLIGHT)));
  return gate(task);
}

export async function simulateView(
  rpcUrl: string,
  contractId: string,
  fn: string,
  args: xdr.ScVal[] = [],
  opts: { passphrase?: string; source?: string } = {},
): Promise<unknown> {
  const server = rpcServer(rpcUrl);
  const source = opts.source ?? VIEW_SOURCE;
  const tx = new TransactionBuilder(new Account(source, "0"), {
    fee: BASE_FEE,
    networkPassphrase: opts.passphrase ?? Networks.PUBLIC,
  })
    .addOperation(new Contract(contractId).call(fn, ...args))
    .setTimeout(30)
    .build();
  const sim = await viaRpc(rpcUrl, () => server.simulateTransaction(tx));
  if (rpc.Api.isSimulationError(sim)) throw new Error(`${fn} simulation failed: ${sim.error}`);
  if (!sim.result) throw new Error(`${fn} returned no value`);
  return scValToNative(sim.result.retval);
}
