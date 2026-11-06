import { describe, expect, it } from "vitest";
import { explainFill, explainSettleCode, settleErrorNumber } from "../src/index.js";

const SETTLE = "CB7JMSNHKR3KL3P6AWJK25VITFIEHBH5LDTBYRKFPS5KUDJFUDLJWC6J";
const OTHER = "CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA";
const log = (contract: string, n: number) => `HostError: Error(Contract, #${n})\n[Diagnostic Event] contract:${contract}, topics:[error, Error(Contract, #${n})], data:["x"]`;

describe("settlement contract errors", () => {
  it.each([[1, "BAD_AMOUNT"], [2, "SAME_TOKEN"], [3, "EXPIRED"], [4, "BAD_SOLVER"], [5, "BELOW_MIN_OUT"]])("number %i is %s in a sentence", (n, code) => {
    const e = explainSettleCode(n)!;
    expect(e.code).toBe(code);
    expect(e.message).toMatch(/Nothing moved\.$/);
    expect(e.detail).toContain(`#${n}`);
  });
  it("knows no other numbers", () => {
    expect(explainSettleCode(0)).toBeNull();
    expect(explainSettleCode(6)).toBeNull();
  });
  it("reads the number only from the settle contract's own error event", () => {
    expect(settleErrorNumber(log(SETTLE, 5), SETTLE)).toBe(5);
    expect(settleErrorNumber(log(OTHER, 5), SETTLE)).toBeNull();
    expect(settleErrorNumber(`${log(OTHER, 3)}\n${log(SETTLE, 4)}`, SETTLE)).toBe(4);
    expect(settleErrorNumber(log(SETTLE, 5))).toBe(5);
    expect(settleErrorNumber("HostError: Error(Contract, #5)")).toBeNull();
  });
  it("explains a failed fill simulation, in order: settle error, authorisation, balances, anything else", () => {
    expect(explainFill(log(SETTLE, 5), SETTLE)).toMatchObject({ code: "BELOW_MIN_OUT", detail: expect.stringContaining("Error(Contract, #5)") });
    expect(explainFill(log(OTHER, 5), SETTLE).code).toBe("SIMULATION_FAILED");
    expect(explainFill("HostError: Error(Auth, ExistingValue)", SETTLE).code).toBe("ALREADY_USED");
    expect(explainFill("HostError: Error(Auth, InvalidAction)", SETTLE).code).toBe("BAD_SIGNATURE");
    expect(explainFill('Error(Contract, #10) "resulting balance is not within the allowed range", 0, -5, 100', SETTLE).code).toBe("INSUFFICIENT_BALANCE");
    expect(explainFill("HostError: Error(WasmVm, InvalidAction)", SETTLE).message).toMatch(/nothing was sent/);
  });
});
