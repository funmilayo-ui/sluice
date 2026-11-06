import { describe, expect, it } from "vitest";
import {
  classifyWalletFailure, NO_WALLET_SELECTED_MESSAGE, normalizeModuleId, resolveStoredModuleId, SigningAborted,
  signingRoute, signingSupport, UNSUPPORTED_WALLET_MESSAGE,
} from "./orderWallet";

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

describe("Freighter / Varial naming (kit 2.7 vs 2.8)", () => {
  it("treats the kit 2.8.0 id 'varial' exactly like the older 'freighter'", () => {
    expect(signingSupport("varial")).toBe("supported");
    expect(signingSupport("freighter")).toBe("supported");
  });
  it("also accepts the display names, in any case or spacing", () => {
    for (const n of ["Freighter", "Varial", " VARIAL ", "FREIGHTER"]) expect(signingSupport(n), n).toBe("supported");
    for (const n of ["Wallet Connect", "wallet-connect", "WalletConnect", "Hana"]) expect(signingSupport(n), n).toBe("unknown");
  });
  it("does not let the new name leak support to look-alikes", () => {
    for (const id of ["varial_mobile", "freighter2", "xbull", "Albedo", "LOBSTR", "Rabet", "Ledger", "Trezor"]) {
      expect(signingSupport(id), id).toBe("unsupported");
    }
  });
  it("normalizes ids and names, and reads empty input as nothing", () => {
    expect(normalizeModuleId(" Wallet Connect ")).toBe("wallet_connect");
    expect(normalizeModuleId("")).toBeUndefined();
    expect(normalizeModuleId("  ")).toBeUndefined();
    expect(normalizeModuleId(null)).toBeUndefined();
    expect(normalizeModuleId(undefined)).toBeUndefined();
  });
  it("maps a session stored under the other kit version's id onto the module the current kit has", () => {
    const kit28 = ["varial", "xbull", "albedo", "lobstr", "rabet", "hana"];
    const kit27 = ["freighter", "xbull", "albedo", "lobstr", "rabet", "hana"];
    expect(resolveStoredModuleId("freighter", kit28)).toBe("varial"); // upgrade
    expect(resolveStoredModuleId("varial", kit27)).toBe("freighter"); // rollback
    expect(resolveStoredModuleId("varial", kit28)).toBe("varial");
    expect(resolveStoredModuleId("xbull", kit28)).toBe("xbull");
  });
  it("does not invent a wallet for an id the kit does not have", () => {
    expect(resolveStoredModuleId("freighter", ["xbull", "albedo"])).toBeUndefined();
    expect(resolveStoredModuleId("metamask", ["varial", "xbull"])).toBeUndefined();
    expect(resolveStoredModuleId("", ["varial"])).toBeUndefined();
    expect(resolveStoredModuleId(null, ["varial"])).toBeUndefined();
  });
});

describe("signingRoute", () => {
  const BOTH = ["auth-entry", "tx"] as const;
  const NO_ENTRY = ["xbull", "albedo", "lobstr", "rabet", "ledger", "trezor"];
  it("uses the authorisation entry for every wallet that is not known to lack it, whatever else the server offers", () => {
    for (const id of ["freighter", "varial", "Freighter", "hana", "wallet_connect", undefined]) {
      expect(signingRoute(id), String(id)).toBe("auth-entry");
      expect(signingRoute(id, BOTH), String(id)).toBe("auth-entry");
      expect(signingRoute(id, ["auth-entry"]), String(id)).toBe("auth-entry");
    }
  });
  it("has no route for a wallet that cannot sign entries when the server does not offer transactions (and on a server that predates tiers)", () => {
    for (const id of NO_ENTRY) {
      expect(signingRoute(id), id).toBe("none");
      expect(signingRoute(id, ["auth-entry"]), id).toBe("none");
      expect(signingRoute(id, []), id).toBe("none");
    }
  });
  it("sends xBull, Albedo, LOBSTR, Rabet, Ledger and Trezor to the transaction route when the server offers it", () => {
    for (const id of NO_ENTRY) expect(signingRoute(id, BOTH), id).toBe("transaction");
    for (const id of NO_ENTRY) expect(signingRoute(id, ["tx"]), id).toBe("transaction");
  });
  it("a transaction-only server takes the transaction route for every wallet, and an unknown id is not trusted with an entry", () => {
    expect(signingRoute("varial", ["tx"])).toBe("transaction");
    expect(signingRoute("some-future-wallet", BOTH)).toBe("transaction");
    expect(signingRoute("some-future-wallet", ["auth-entry"])).toBe("none");
  });
});

describe("classifyWalletFailure", () => {
  it("reads the kit's code -3 as 'this wallet cannot do it', with the honest message", () => {
    const f = classifyWalletFailure({ code: -3, message: 'Albedo does not support the "signAuthEntry" function' });
    expect(f).toEqual({ kind: "unsupported", message: UNSUPPORTED_WALLET_MESSAGE });
    expect(UNSUPPORTED_WALLET_MESSAGE).toMatch(/cannot sign this kind of order yet.*Freighter.*standard swap/);
  });
  it("reads the kit's wording for every module that lacks signAuthEntry (xBull, Albedo, LOBSTR, Rabet, Ledger, Trezor)", () => {
    for (const message of [
      'xBull does not support the "signAuthEntry" function', 'Albedo does not support the "signAuthEntry" function',
      'Lobstr does not support the "signAuthEntry" function', 'Rabet does not support the "signAuthEntry" function',
      'Ledger Wallets do not support the "signAuthEntry" function', 'Trezor Wallets do not support the "signAuthEntry" method',
    ]) expect(classifyWalletFailure({ code: -3, message }), message).toEqual({ kind: "unsupported", message: UNSUPPORTED_WALLET_MESSAGE });
    expect(classifyWalletFailure({ code: -3 }).kind).toBe("unsupported"); // a bare -3 keeps its old meaning
  });
  it("does not call a stale or empty wallet session 'unsupported': the cure is to reconnect", () => {
    const f = classifyWalletFailure({ code: -3, message: "Please set the wallet first" });
    expect(f).toEqual({ kind: "other", message: NO_WALLET_SELECTED_MESSAGE });
    expect(NO_WALLET_SELECTED_MESSAGE).not.toMatch(/Error|\{|code/);
  });
  it("does not call a wallet that returned nothing 'unsupported' either; the wallet's own words stand", () => {
    expect(classifyWalletFailure({ code: -3, message: "signedAuthEntry returned from Varial is undefined." }))
      .toEqual({ kind: "other", message: "signedAuthEntry returned from Varial is undefined." });
  });
  it("finds the code inside the wrapper some wallets use", () => {
    expect(classifyWalletFailure({ error: { code: -3, message: 'Rabet does not support the "signAuthEntry" function' } }).kind).toBe("unsupported");
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
