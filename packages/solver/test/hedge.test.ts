import { describe, expect, it } from "vitest";
import { Keypair, Networks, Transaction } from "@stellar/stellar-sdk";
import { parseAmount, sacId } from "@sluice/core";
import { buildHedgeTx, quoteHedge, resolveClassicAssets, type Order } from "../src/index.js";

const issuer = Keypair.random().publicKey();
const A = `SLFA:${issuer}`;
const C = `SLFC:${issuer}`;
const order: Order = { user: Keypair.random().publicKey(), tokenIn: sacId(A, Networks.TESTNET), amountIn: parseAmount("100"), tokenOut: sacId(C, Networks.TESTNET), minOut: parseAmount("90"), deadline: 2e9, createTrustline: true };

const horizon = (body: unknown, status = 200) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

describe("hedge", () => {
  it("maps SAC ids back to Classic assets, and refuses unknown tokens", () => {
    expect(resolveClassicAssets(order, [A, C, "native"], Networks.TESTNET)).toEqual({ tokenIn: A, tokenOut: C });
    expect(resolveClassicAssets(order, [A], Networks.TESTNET)).toBeNull();
  });
  it("turns a Horizon path into a hedge quote", async () => {
    const f = horizon({ _embedded: { records: [{ destination_amount: "96.3800000", path: [] }, { destination_amount: "97.0000000", path: [] }] } });
    const q = await quoteHedge(order, { tokenIn: A, tokenOut: C }, "https://h.test", 5, f);
    expect(q?.quote).toEqual({ amountIn: order.amountIn, amountOut: parseAmount("97"), quotedAtMs: 5 });
  });
  it("returns null when Horizon has no path", async () => {
    expect(await quoteHedge(order, { tokenIn: A, tokenOut: C }, "https://h.test", 5, horizon({ _embedded: { records: [] } }))).toBeNull();
    expect(await quoteHedge(order, { tokenIn: A, tokenOut: C }, "https://h.test", 5, horizon({}, 400))).toBeNull();
  });
  it("builds a strict-send path payment to the solver itself with the buffered minimum", async () => {
    const q = (await quoteHedge(order, { tokenIn: A, tokenOut: C }, "https://h.test", 5, horizon({ _embedded: { records: [{ destination_amount: "97.0000000", path: [] }] } })))!;
    const solver = Keypair.random().publicKey();
    const tx = new Transaction(buildHedgeTx(q.leg, { source: solver, sequence: "1", minOut: parseAmount("96"), passphrase: Networks.TESTNET }), Networks.TESTNET);
    const op = tx.operations[0]! as unknown as { type: string; destination: string; sendAmount: string; destMin: string };
    expect(op).toMatchObject({ type: "pathPaymentStrictSend", destination: solver, sendAmount: "100.0000000", destMin: "96.0000000" });
  });
});
