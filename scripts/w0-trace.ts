/**
 * W0-2 helper (read-only, needs no funds): inspect a mainnet transaction and say whether it mixes
 * Classic and Soroban work. Run it on swaps you make yourself, or on public StellarBroker /
 * Soroswap / LumAgg transactions, to see how each product splits cross-layer routes.
 * Usage: pnpm w0:trace <txHash> [<txHash> ...]
 */
const HORIZON = process.env.HORIZON_URL ?? "https://horizon.stellar.org";

interface Op {
  type: string;
  function?: string;
  path?: unknown[];
  asset_type?: string;
}

for (const hash of process.argv.slice(2)) {
  const tx = await fetch(`${HORIZON}/transactions/${hash}`);
  if (!tx.ok) {
    console.log(`${hash}: HTTP ${tx.status}`);
    continue;
  }
  const t = (await tx.json()) as { successful: boolean; operation_count: number; ledger: number; source_account: string };
  const ops = (await (await fetch(`${HORIZON}/transactions/${hash}/operations?limit=200`)).json()) as { _embedded: { records: Op[] } };
  const types = ops._embedded.records.map((o) => o.type);
  const soroban = types.filter((x) => x === "invoke_host_function").length;
  const classic = types.filter((x) => x.startsWith("path_payment") || x.startsWith("manage_")).length;
  console.log(`\n${hash}\n  ledger ${t.ledger}  successful=${t.successful}  ops=${t.operation_count}`);
  console.log(`  op types: ${types.join(", ")}`);
  console.log(`  soroban invokes=${soroban}  classic swap ops=${classic}  mixed-in-one-tx=${soroban > 0 && classic > 0}`);
  if (soroban > 0 && classic > 0) console.log("  !! mixed: contradicts the single-operation Soroban rule; re-check the PRD assumption");
}
