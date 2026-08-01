import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  addMoney,
  cmpMoney,
  fromMoney,
  isZeroMoney,
  money,
  moneyFromUnits,
  mulMoney,
  subMoney,
  unitsFromFloat,
} from "./money";

describe("money: integer arithmetic is exact", () => {
  it("round-trips display floats through integer units", () => {
    fc.assert(
      fc.property(fc.float({ min: 0, max: 1e6 }), (n) => {
        const m = money(n);
        expect(m.units).toBe(unitsFromFloat(n, 2));
        // Re-quantizing the display value lands on the same units (stable).
        expect(unitsFromFloat(fromMoney(m), 2)).toBe(m.units);
      }),
    );
  });

  it("add/sub never lose cents", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1e9 }),
        fc.integer({ min: 0, max: 1e9 }),
        (a, b) => {
          const x = moneyFromUnits(BigInt(a));
          const y = moneyFromUnits(BigInt(b));
          expect(addMoney(x, y).units).toBe(BigInt(a) + BigInt(b));
          expect(subMoney(addMoney(x, y), y).units).toBe(BigInt(a));
        },
      ),
    );
  });

  it("cmp and zero behave sanely", () => {
    const a = moneyFromUnits(100n);
    const b = moneyFromUnits(200n);
    expect(cmpMoney(a, b)).toBe(-1);
    expect(cmpMoney(b, a)).toBe(1);
    expect(cmpMoney(a, a)).toBe(0);
    expect(isZeroMoney(moneyFromUnits(0n))).toBe(true);
    expect(isZeroMoney(a)).toBe(false);
  });

  it("mulMoney scales units deterministically", () => {
    const a = moneyFromUnits(100n);
    expect(mulMoney(a, 0.5).units).toBe(50n);
    expect(mulMoney(a, 1.25).units).toBe(125n);
  });

  it("rejects cross-currency arithmetic", () => {
    const usd = moneyFromUnits(100n, "USD");
    const eth = moneyFromUnits(1n, "ETH");
    expect(() => addMoney(usd, eth)).toThrow("currency mismatch");
  });

  it("handles ETH precision", () => {
    const tiny = money(0.000001, "ETH");
    expect(tiny.units).toBe(1n);
    expect(fromMoney(tiny)).toBe(0.000001);
  });
});
