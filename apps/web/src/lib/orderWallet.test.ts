import { describe, expect, it } from "vitest";
import { classifyWalletFailure, SigningAborted, signingSupport, UNSUPPORTED_WALLET_MESSAGE } from "./orderWallet";

describe("signingSupport", () => {
  it("allows Freighter, which implements signAuthEntry", () => {
    expect(signingSupport("freighter")).toBe("supported");
  });
  it("says unknown for wallets that may or may not, so the app tries and handles a refusal", () => {
    expect(signingSupport("wallet_connect")).toBe("unknown");
    expect(signingSupport("hana")).toBe("unknown");
    expect(signingSupport(undefined)).toBe("unknown");
  });
  it("says unsupported for the modules that hard-reject, and for anything it has not checked", () => {
    for (const id of ["xbull", "albedo", "lobstr", "rabet", "ledger", "trezor", "some-future-wallet", ""]) {
      expect(signingSupport(id), id).toBe("unsupported");
    }
  });
});

describe("classifyWalletFailure", () => {
  it("reads the kit's code -3 as 'this wallet cannot do it', with the honest message", () => {
    const f = classifyWalletFailure({ code: -3, message: 'Albedo does not support the "signAuthEntry" function' });
    expect(f).toEqual({ kind: "unsupported", message: UNSUPPORTED_WALLET_MESSAGE });
    expect(UNSUPPORTED_WALLET_MESSAGE).toMatch(/cannot sign this kind of order yet.*Freighter.*standard swap/);
  });
  it("finds the code inside the wrapper some wallets use", () => {
    expect(classifyWalletFailure({ error: { code: -3, message: "x" } }).kind).toBe("unsupported");
    expect(classifyWalletFailure({ error: { code: -4, message: "x" } }).kind).toBe("rejected");
  });
  it("reads code -4 (and WalletConnect's 5000) as the user saying no, not as a failure", () => {
    for (const code of [-4, 5000]) {
      const f = classifyWalletFailure({ code, message: "The user rejected this request." });
      expect(f.kind).toBe("rejected");
      expect(f).toMatchObject({ stopped: false });
    }
  });
  it("uses the wording of a refusal only when the code says nothing (the kit's catch-all is -1)", () => {
    expect(classifyWalletFailure({ code: -1, message: "User declined access" }).kind).toBe("rejected");
    expect(classifyWalletFailure(new Error("The user rejected the request")).kind).toBe("rejected");
    // A specific code that is neither -3 nor -4 is a failure even if the text mentions rejection.
    expect(classifyWalletFailure({ code: -2, message: "request rejected by network" }).kind).toBe("other");
  });
  it("tells stopping the wait apart from declining", () => {
    expect(classifyWalletFailure(new SigningAborted())).toMatchObject({ kind: "rejected", stopped: true });
  });
  it("keeps the wallet's own words for anything else, and never invents a verdict", () => {
    expect(classifyWalletFailure({ code: -1, message: "Extension is locked" })).toEqual({ kind: "other", message: "Extension is locked" });
    expect(classifyWalletFailure("boom")).toEqual({ kind: "other", message: "boom" });
    expect(classifyWalletFailure(undefined)).toEqual({ kind: "other", message: "The wallet did not respond." });
  });
  it("treats an error from the app's own signature checks as a failure, not as a refusal", () => {
    const f = classifyWalletFailure(new Error("the wallet's signature does not verify against the order's preimage"));
    expect(f.kind).toBe("other");
  });
});
