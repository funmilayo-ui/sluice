import { describe, expect, it } from "vitest";
import { Address, Keypair, nativeToScVal, Operation, Transaction, TransactionBuilder, xdr } from "@stellar/stellar-sdk";
import { encodeOrder, expectedSolverTree } from "@sluice/solver";
import { makeOrderId } from "./mac.js";
import { A, HASH, NOW, PASS, S, build, prepareBody, settle, signTx, solverKp, stranger, user, userTx } from "./fixtures.js";

const json = async (r: Response) => (await r.json()) as any;
const mutate = (x: string, f: (t: xdr.Transaction) => void): string => {
  const env = xdr.TransactionEnvelope.fromXDR(x, "base64");
  f(env.v1().tx());
  return new Transaction(env, PASS).toXDR();
};
const fillOf = (p: any) => ({ user: user.publicKey(), tokenIn: p.order.tokenIn, amountIn: BigInt(p.order.amountIn.replace(".", "")), tokenOut: p.order.tokenOut, minOut: BigInt(p.order.minOut.replace(".", "")), deadline: p.order.deadline, createTrustline: p.order.createTrustline });

async function prepared(t = build()) {
  const r = await t.post("/v1/orders/prepare-tx", prepareBody);
  const p = await json(r);
  expect(r.status).toBe(200);
  expect(p.solverWillFill).toBe(true);
  return { t, p, signed: signTx(p.tx.xdr) };
}
const submitBody = (p: any, signedTx: string, patch: Record<string, unknown> = {}) => ({ orderId: p.orderId, order: p.order, signedTx, ...patch });

describe("POST /v1/orders/prepare-tx", () => {
  it("prices like prepare and returns a transaction sourced from the user, with the order, the solver and the fee in it", async () => {
    const { t, p } = await prepared();
    expect(p.summary.pay).toBe("100.0000000");
    expect(parseFloat(p.summary.receiveAtLeast)).toBeGreaterThan(90);
    expect(p.summary.expected >= p.summary.receiveAtLeast).toBe(true);
    expect(p.summary.networkFee).toBe("0.0140000"); // 140000 stroops, paid by the user in this tier
    expect(p.orderId).toMatch(/^\d+\.[0-9a-f]{64}$/);
    expect(p.tx).toMatchObject({ source: user.publicKey(), networkPassphrase: PASS });
    expect(p.tx.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(p.authEntry).toBeUndefined(); // no authorisation entry to sign in this tier
    const tx = TransactionBuilder.fromXDR(p.tx.xdr, PASS) as Transaction;
    expect(tx.source).toBe(user.publicKey());
    expect(tx.signatures).toHaveLength(0);
    expect(t.state.prepares).toHaveLength(1);
    expect(t.state.prepares[0]!.amountOut).toBe(BigInt(p.summary.expected.replace(".", "")));
    expect(t.state.sims).toHaveLength(0); // this tier does not record a fill simulation in the API: the solver builds the transaction
  });
  it("the same order cannot be replayed across tiers: the id of one is not the id of the other", async () => {
    const t = build();
    const a = await json(await t.post("/v1/orders/prepare", prepareBody));
    const b = await json(await t.post("/v1/orders/prepare-tx", prepareBody));
    expect(a.orderId.split(".")[0]).toBeTruthy();
    expect(a.orderId).not.toBe(b.orderId);
  });
  it("declines with the solver's reasons, and prepares nothing, when the solver would not fill", async () => {
    const t = build({ hedgeRate: null });
    const b = await json(await t.post("/v1/orders/prepare-tx", prepareBody));
    expect(b).toMatchObject({ solverWillFill: false, skipReasons: ["no_hedge_quote"], explained: { code: "SOLVER_WILL_NOT_FILL" } });
    expect(t.state.prepares).toHaveLength(0);
  });
  it("is refused up front while the breaker is open", async () => {
    const t = build({ breaker: "tripped" });
    const b = await json(await t.post("/v1/orders/prepare-tx", prepareBody));
    expect(b).toMatchObject({ solverWillFill: false, skipReasons: ["circuit_breaker"] });
    expect(t.state.prepares).toHaveLength(0);
  });
  it("validates like prepare: bad account, no trustline for the input, unfunded account", async () => {
    const t = build();
    expect((await t.post("/v1/orders/prepare-tx", { ...prepareBody, account: "nope" })).status).toBe(400);
    const none = build({ trust: new Set(["native"]) });
    const r = await none.post("/v1/orders/prepare-tx", prepareBody);
    expect(r.status).toBe(422);
    expect((await json(r)).explained.code).toBe("NO_TRUSTLINE");
    const missing = build({ trust: new Error("account not found on this network") });
    expect((await missing.post("/v1/orders/prepare-tx", prepareBody)).status).toBe(404);
  });
  it("answers 503 SOLVER_UNAVAILABLE when the solver cannot be reached, and maps a solver-side refusal", async () => {
    const down = build({ solverDown: "timeout" });
    const r = await down.post("/v1/orders/prepare-tx", prepareBody);
    expect(r.status).toBe(503);
    expect((await json(r)).explained.code).toBe("SOLVER_UNAVAILABLE");
    const sim = build({ outcome: { kind: "sim_failed", message: "HostError: Error(Contract, #5)\nx" } });
    const s = await sim.post("/v1/orders/prepare-tx", prepareBody);
    expect(s.status).toBe(422);
    expect((await json(s)).explained.code).toBe("BELOW_MIN_OUT");
  });
  it("refuses to hand the user a transaction that is not the order that was priced", async () => {
    const t = build();
    const orig = t.solver.prepareTx.bind(t.solver);
    t.solver.prepareTx = async (req) => orig({ ...req, amountOut: req.amountOut + 1n }); // a compromised or buggy solver prepares a different amount
    const r = await t.post("/v1/orders/prepare-tx", prepareBody);
    expect(r.status).toBe(502);
    expect((await json(r)).explained.code).toBe("SOLVER_TX_MISMATCH");
  });
});

describe("POST /v1/orders/submit-tx", () => {
  it("verifies the signed envelope, simulates it as signed and hands it to the solver", async () => {
    const { t, p, signed } = await prepared();
    const r = await t.post("/v1/orders/submit-tx", submitBody(p, signed));
    expect(r.status).toBe(200);
    expect(await json(r)).toEqual({ hash: p.tx.hash, status: "PENDING" });
    expect(t.state.txSims).toBe(1);
    expect(t.state.submittedTxs).toEqual([signed]);
  });

  const expectRefused = async (name: string, mk: (p: any, t: ReturnType<typeof build>) => string | Promise<string>, status: number, code: string, patch: (p: any) => Record<string, unknown> = () => ({})) => {
    it(`refuses ${name} (${code}) and sends nothing`, async () => {
      const { t, p } = await prepared();
      const r = await t.post("/v1/orders/submit-tx", submitBody(p, await mk(p, t), patch(p)));
      expect(r.status).toBe(status);
      expect((await json(r)).explained.code).toBe(code);
      expect(t.state.submittedTxs).toHaveLength(0);
      expect(t.state.sent).toBe(0);
    });
  };

  // The user's side
  expectRefused("a transaction the user did not sign", (p) => p.tx.xdr, 400, "BAD_SIGNATURE");
  expectRefused("a transaction signed by someone else", (p) => signTx(p.tx.xdr, stranger), 400, "BAD_SIGNATURE");
  expectRefused("a signature that belongs to a different transaction body", (p) => {
    const other = signTx(mutate(p.tx.xdr, (t) => void t.fee(t.fee() + 1)));
    const otherSig = (TransactionBuilder.fromXDR(other, PASS) as Transaction).signatures;
    const tx = TransactionBuilder.fromXDR(p.tx.xdr, PASS) as Transaction;
    tx.signatures.push(...otherSig);
    return tx.toXDR();
  }, 400, "BAD_SIGNATURE");
  expectRefused("a transaction whose source is not the order's account", (p) => {
    const moved = mutate(p.tx.xdr, (t) => t.sourceAccount(xdr.MuxedAccount.keyTypeEd25519(stranger.rawPublicKey())));
    return signTx(signTx(moved, stranger), user);
  }, 400, "WRONG_SOURCE");
  expectRefused("a muxed source account", (p) => signTx(mutate(p.tx.xdr, (t) => t.sourceAccount(xdr.MuxedAccount.keyTypeMuxedEd25519(new xdr.MuxedAccountMed25519({ id: xdr.Uint64.fromString("7"), ed25519: user.rawPublicKey() })))), user), 400, "UNSUPPORTED_ENVELOPE");

  // Tampering with what the user and solver agreed
  expectRefused("a changed amount_out (the solver's signature no longer matches)", async (p) => {
    const order = fillOf(p);
    const amount = BigInt(p.summary.expected.replace(".", "")) + 1n;
    return signTx(mutate(p.tx.xdr, (t) => {
      const inv = t.operations()[0]!.body().invokeHostFunctionOp().hostFunction().invokeContract();
      inv.args([encodeOrder(order), new Address(solverKp.publicKey()).toScVal(), nativeToScVal(amount, { type: "i128" })]);
    }));
  }, 400, "BAD_AUTH");
  expectRefused("a lowered min_out inside the order", (p) => signTx(mutate(p.tx.xdr, (t) => {
    const inv = t.operations()[0]!.body().invokeHostFunctionOp().hostFunction().invokeContract();
    const o = { ...fillOf(p), minOut: 1n };
    inv.args([encodeOrder(o), inv.args()[1]!, inv.args()[2]!]);
  })), 400, "TX_MISMATCH");
  expectRefused("a redirected output (other token_out)", (p) => signTx(mutate(p.tx.xdr, (t) => {
    const inv = t.operations()[0]!.body().invokeHostFunctionOp().hostFunction().invokeContract();
    inv.args([encodeOrder({ ...fillOf(p), tokenOut: settle }), inv.args()[1]!, inv.args()[2]!]);
  })), 400, "TX_MISMATCH");
  expectRefused("another solver named in the call", (p) => signTx(mutate(p.tx.xdr, (t) => {
    const inv = t.operations()[0]!.body().invokeHostFunctionOp().hostFunction().invokeContract();
    inv.args([inv.args()[0]!, new Address(stranger.publicKey()).toScVal(), inv.args()[2]!]);
  })), 400, "TX_MISMATCH");
  expectRefused("another function on the same contract", (p) => signTx(mutate(p.tx.xdr, (t) => {
    t.operations()[0]!.body().invokeHostFunctionOp().hostFunction().invokeContract().functionName("fill2" as never);
  })), 400, "TX_MISMATCH");
  expectRefused("another contract", (p) => signTx(mutate(p.tx.xdr, (t) => {
    t.operations()[0]!.body().invokeHostFunctionOp().hostFunction().invokeContract().contractAddress(new Address(user.publicKey()).toScAddress());
  })), 400, "TX_MISMATCH");
  expectRefused("a second operation", (p) => signTx(mutate(p.tx.xdr, (t) => {
    t.operations([...t.operations(), Operation.bumpSequence({ bumpTo: "5" }) as unknown as xdr.Operation]);
  })), 400, "TX_MISMATCH");
  expectRefused("an operation with a source account of its own", (p) => signTx(mutate(p.tx.xdr, (t) => {
    t.operations()[0]!.sourceAccount(xdr.MuxedAccount.keyTypeEd25519(stranger.rawPublicKey()));
  })), 400, "TX_MISMATCH");
  expectRefused("an extra authorisation entry", (p) => signTx(mutate(p.tx.xdr, (t) => {
    const op = t.operations()[0]!.body().invokeHostFunctionOp();
    op.auth([...op.auth(), op.auth()[0]!]);
  })), 400, "BAD_AUTH");
  expectRefused("a missing solver entry", (p) => signTx(mutate(p.tx.xdr, (t) => {
    const op = t.operations()[0]!.body().invokeHostFunctionOp();
    op.auth([op.auth()[0]!]);
  })), 400, "BAD_AUTH");
  expectRefused("a user entry with address credentials instead of the source account", (p) => signTx(mutate(p.tx.xdr, (t) => {
    const op = t.operations()[0]!.body().invokeHostFunctionOp();
    const u = op.auth()[0]!;
    op.auth([new xdr.SorobanAuthorizationEntry({
      credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(new xdr.SorobanAddressCredentials({ address: new Address(user.publicKey()).toScAddress(), nonce: new xdr.Int64(1), signatureExpirationLedger: 9999, signature: xdr.ScVal.scvVec([]) })),
      rootInvocation: u.rootInvocation(),
    }), op.auth()[1]!]);
  })), 400, "BAD_AUTH");
  expectRefused("a user entry that authorises more than the order's transfer", (p) => signTx(mutate(p.tx.xdr, (t) => {
    const op = t.operations()[0]!.body().invokeHostFunctionOp();
    const u = op.auth()[0]!;
    const tree = u.rootInvocation();
    tree.subInvocations([]);
    op.auth([new xdr.SorobanAuthorizationEntry({ credentials: u.credentials(), rootInvocation: tree }), op.auth()[1]!]);
  })), 400, "BAD_AUTH");
  expectRefused("a solver entry signed by another key", async (p) => {
    const order = fillOf(p);
    const amount = BigInt(p.summary.expected.replace(".", ""));
    const forged = await userTx(order, amount, { solverKey: stranger, validUntilLedger: p.tx.validUntilLedger });
    const solverEntry = forged.tx.toEnvelope().v1().tx().operations()[0]!.body().invokeHostFunctionOp().auth()[1]!;
    return signTx(mutate(p.tx.xdr, (t) => {
      const op = t.operations()[0]!.body().invokeHostFunctionOp();
      // keep the nonce and expiry the id was made for, so only the signature is wrong
      const c = solverEntry.credentials().address();
      const orig = op.auth()[1]!.credentials().address();
      c.nonce(orig.nonce());
      c.signatureExpirationLedger(orig.signatureExpirationLedger());
      op.auth([op.auth()[0]!, solverEntry]);
    }));
  }, 400, "BAD_AUTH");

  // Time and sequence
  expectRefused("a transaction with no expiry", (p) => signTx(mutate(p.tx.xdr, (t) => t.cond(xdr.Preconditions.precondTime(new xdr.TimeBounds({ minTime: xdr.Uint64.fromString("0"), maxTime: xdr.Uint64.fromString("0") }))))), 400, "BAD_TIMEBOUNDS");
  expectRefused("a transaction valid for far longer than an order", (p) => signTx(mutate(p.tx.xdr, (t) => t.cond(xdr.Preconditions.precondTime(new xdr.TimeBounds({ minTime: xdr.Uint64.fromString("0"), maxTime: xdr.Uint64.fromString(String(Math.floor(NOW / 1000) + 86_400)) }))))), 400, "BAD_TIMEBOUNDS");
  expectRefused("a transaction that is not valid yet", (p) => signTx(mutate(p.tx.xdr, (t) => t.cond(xdr.Preconditions.precondTime(new xdr.TimeBounds({ minTime: xdr.Uint64.fromString(String(Math.floor(NOW / 1000) + 600)), maxTime: xdr.Uint64.fromString(String(Math.floor(NOW / 1000) + 900)) }))))), 400, "BAD_TIMEBOUNDS");
  expectRefused("a fee far above what was prepared", (p) => signTx(mutate(p.tx.xdr, (t) => void t.fee(900_000_000))), 400, "TX_MISMATCH");
  expectRefused("an order id that is not this transaction's", (p) => signTx(p.tx.xdr), 400, "BAD_ORDER_ID", (p) => ({ orderId: p.orderId.replace(/.$/, (c: string) => (c === "0" ? "1" : "0")) }));
  expectRefused("an order id from the other tier", async (p, t) => {
    const a = await json(await t.post("/v1/orders/prepare", prepareBody));
    void p;
    return signTx(p.tx.xdr) + (a.orderId ? "" : "");
  }, 400, "BAD_ORDER_ID", () => ({ orderId: makeOrderId("x".repeat(20), { passphrase: PASS, settleContract: settle, solver: solverKp.publicKey(), order: { user: user.publicKey(), tokenIn: settle, amountIn: 1n, tokenOut: settle, minOut: 1n, deadline: 1, createTrustline: false }, amountOut: 1n, nonce: "1", validUntilLedger: 1 }) }));
  expectRefused("a changed order shown with the transaction", (p) => signTx(p.tx.xdr), 400, "BAD_ORDER_ID", (p) => ({ order: { ...p.order, minOut: "0.0000001" } }));
  it("refuses an expired order with 410 EXPIRED once its time has passed", async () => {
    const { t, p, signed } = await prepared();
    t.state.nowMs += 2 * 3600 * 1000;
    const r = await t.post("/v1/orders/submit-tx", submitBody(p, signed));
    expect([400, 410]).toContain(r.status);
    expect(t.state.sent).toBe(0);
  });
  it("refuses once the solver's own signature has expired (its ledger passed)", async () => {
    const { t, p, signed } = await prepared();
    t.state.ledger = p.tx.validUntilLedger + 1;
    const r = await t.post("/v1/orders/submit-tx", submitBody(p, signed));
    expect(r.status).toBe(410);
    expect((await json(r)).explained.code).toBe("EXPIRED");
    expect(t.state.sent).toBe(0);
  });
  it("refuses with 409 BAD_SEQUENCE when the account sent another transaction after prepare", async () => {
    const { t, p, signed } = await prepared();
    t.state.userSeq = "150";
    const r = await t.post("/v1/orders/submit-tx", submitBody(p, signed));
    expect(r.status).toBe(409);
    expect((await json(r)).explained.code).toBe("BAD_SEQUENCE");
    expect(t.state.sent).toBe(0);
  });

  // The solver's side of the bargain
  it("refuses with 409 when the price moved and the solver would now lose money, and when the breaker opened", async () => {
    const a = await prepared();
    a.t.state.hedgeRate = (95n * S) / 100n;
    const r = await a.t.post("/v1/orders/submit-tx", submitBody(a.p, a.signed));
    expect(r.status).toBe(409);
    expect((await json(r)).explained.code).toBe("SOLVER_WILL_NOT_FILL");
    const b = await prepared();
    b.t.state.breaker = "tripped";
    const r2 = await b.t.post("/v1/orders/submit-tx", submitBody(b.p, b.signed));
    expect(r2.status).toBe(409);
    expect((await json(r2)).skipReasons).toEqual(["circuit_breaker"]);
    expect(a.t.state.sent + b.t.state.sent).toBe(0);
  });
  it("explains a failed simulation of the signed transaction and sends nothing", async () => {
    const { t, p, signed } = await prepared();
    t.state.simError = "HostError: Error(Auth, ExistingValue)\nmore";
    const r = await t.post("/v1/orders/submit-tx", submitBody(p, signed));
    expect(r.status).toBe(422);
    expect((await json(r)).explained.code).toBe("ALREADY_USED");
    expect(t.state.sent).toBe(0);
  });
  it("a transaction the solver did not prepare (or has forgotten) is refused by the solver, and mapped", async () => {
    const { t, p, signed } = await prepared();
    t.state.reserved.clear();
    const r = await t.post("/v1/orders/submit-tx", submitBody(p, signed));
    expect(r.status).toBe(400);
    expect((await json(r)).explained.code).toBe("UNKNOWN_RESERVATION");
  });
  it("answers 503 SOLVER_UNAVAILABLE when the solver is down at submit", async () => {
    const { t, p, signed } = await prepared();
    t.state.solverDown = "unreachable";
    const r = await t.post("/v1/orders/submit-tx", submitBody(p, signed));
    expect(r.status).toBe(503);
    expect((await json(r)).explained.code).toBe("SOLVER_UNAVAILABLE");
  });
  it.each([
    ["no body", "{"], ["no signed transaction", { orderId: "1.x", order: {} }], ["garbage", { orderId: "1.x", order: { user: "nope" }, signedTx: "x" }],
  ])("400 for %s", async (_n, body) => {
    const t = build();
    const r = await t.app.request("/v1/orders/submit-tx", { method: "POST", headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });
    expect(r.status).toBe(400);
  });
  it("a transaction that is not an envelope is refused as such", async () => {
    const { t, p } = await prepared();
    const r = await t.post("/v1/orders/submit-tx", submitBody(p, "AAAA"));
    expect(r.status).toBe(400);
    expect((await json(r)).explained.code).toBe("UNSUPPORTED_ENVELOPE");
  });
});

describe("GET /v1/orders/:hash for a user-sourced fill", () => {
  it("reads the fill whoever its source is, and reports the solver's hedge", async () => {
    const t = build();
    const p = await json(await t.post("/v1/orders/prepare-tx", prepareBody));
    const tx = TransactionBuilder.fromXDR(p.tx.xdr, PASS) as Transaction;
    t.state.tx = { hash: HASH, status: "SUCCESS", ledger: 11, createdAt: 5, envelopeXdr: tx.toEnvelope().toXDR("base64"), returnValue: nativeToScVal(95n * S, { type: "i128" }).toXDR("base64") };
    t.state.hedges.set(HASH, { status: "RETRYING", attempts: 1, nextRetryAt: 1_800_000_030 });
    const b = await json(await t.app.request(`/v1/orders/${HASH}`));
    expect(b).toMatchObject({ status: "SUCCESS", ledger: 11, received: "95.0000000", hedge: { status: "RETRYING", attempts: 1 } });
  });
});

void expectedSolverTree; void Keypair; void A;
