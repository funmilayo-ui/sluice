import { describe, expect, it } from "vitest";
import { assertSigner, WalletError } from "./wallet";

const A = "GDZZR6UBK5TWJ5AXFX74N442RLEAEERYUSP7JHMXAHUAMGEGZSC3ZAVT";
const B = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";

describe("assertSigner", () => {
  it("accepts a signature from the connected account, or a wallet that does not say who signed", () => {
    expect(() => assertSigner(A, A)).not.toThrow();
    expect(() => assertSigner(A, undefined)).not.toThrow();
    expect(() => assertSigner(undefined, B)).not.toThrow();
  });
  it("refuses a signature from another account and says which, so it is never submitted", () => {
    expect(() => assertSigner(A, B)).toThrow(WalletError);
    expect(() => assertSigner(A, B)).toThrow(/different account \(GA5Z…KZVN\).*back to GDZZ…ZAVT/);
  });
});
