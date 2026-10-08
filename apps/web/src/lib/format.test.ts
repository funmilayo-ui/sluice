import { describe, expect, it } from "vitest";
import { fmt, fmtCompact, fromStroops, isAmount, pct, relDiff, shortKey, toStroops, versusBest } from "./format";

describe("amounts", () => {
  it("accepts what the network can represent and nothing else", () => {
    for (const ok of ["1", "0.0000001", "12.5", "1000000"]) expect(isAmount(ok), ok).toBe(true);
    for (const bad of ["", "0", "0.0", "1.12345678", "-1", "1e3", ".5", "1.", "abc", "1,5"]) expect(isAmount(bad), bad).toBe(false);
  });
  it("converts to stroops and back exactly", () => {
    expect(toStroops("12.3456789")).toBe(123456789n);
    expect(toStroops("5")).toBe(50_000_000n);
    expect(toStroops("0.0000001")).toBe(1n);
    expect(fromStroops(123456789n)).toBe("12.3456789");
    expect(fromStroops(toStroops("49.9737981") - 5_000_000n)).toBe("49.4737981");
  });
  it("formats for reading: grouped, trimmed, fewer decimals for big numbers, never rounded up", () => {
    expect(fmt("19.7227301")).toBe("19.7227301");
    expect(fmt("288998.3745704")).toBe("288,998.37");
    expect(fmt("226.7796999")).toBe("226.7796");
    expect(fmt("0.9500000")).toBe("0.95");
    expect(fmt("5.0000000")).toBe("5");
    expect(fmt("0.9999999", 2)).toBe("0.99");
    expect(fmt(undefined)).toBe("0");
  });
  it("shortens large totals without rounding up", () => {
    expect(fmtCompact("699481160.5953690")).toBe("699.4M");
    expect(fmtCompact("54944629.0")).toBe("54.9M");
    expect(fmtCompact("166551.87")).toBe("166.5K");
    expect(fmtCompact("9999.5")).toBe("9,999");
    expect(fmtCompact("3200000000")).toBe("3.2B");
  });
});

describe("percentages and comparisons", () => {
  it("does not print a real tiny rate as zero", () => {
    expect(pct(0.0668)).toBe("6.68%");
    expect(pct(0.000001)).toBe("<0.01%");
    expect(pct(0)).toBe("0.00%");
    expect(pct(0.0004, 1)).toBe("<0.1%");
  });
  it("words a route against the best one truthfully", () => {
    expect(versusBest(relDiff("47.0938", "47.1232"))).toBe("0.06% less");
    expect(versusBest(relDiff("47.12319", "47.1232"))).toBe("under 0.01% less");
    // A two-transaction route can quote more and still rank lower.
    expect(versusBest(relDiff("22879.38", "22851.68"))).toBe("0.12% more, ranked lower for risk");
  });
  it("shortens keys", () => expect(shortKey("GDZZR6UBK5TWJ5AXFX74N442RLEAEERYUSP7JHMXAHUAMGEGZSC3ZAVT")).toBe("GDZZ…ZAVT"));
});
