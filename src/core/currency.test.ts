import { describe, expect, it } from "vitest";
import { convertFromUsd, convertToUsd, formatCurrency, listCurrencies } from "@/core/currency";

describe("currency conversions", () => {
  it("USD is identity", () => {
    expect(convertFromUsd(1250, "USD")).toBe(1250);
  });

  it("converts to INR and back", () => {
    const inr = convertFromUsd(100, "INR");
    expect(inr).toBeCloseTo(8320, 5);
    expect(convertToUsd(inr, "INR")).toBeCloseTo(100, 5);
  });

  it("converts to ETH", () => {
    const eth = convertFromUsd(1000, "ETH");
    expect(eth).toBeCloseTo(0.45, 5);
  });

  it("formats with symbol and code", () => {
    expect(formatCurrency(1250, "USD")).toContain("$");
    expect(formatCurrency(1250, "USD")).toContain("USD");
    expect(formatCurrency(100, "INR")).toContain("₹");
  });

  it("lists all supported currencies", () => {
    const codes = listCurrencies().map((c) => c.code);
    expect(codes).toEqual(expect.arrayContaining(["USD", "USDC", "EUR", "INR", "ETH"]));
  });

  it("falls back to USD for unknown codes", () => {
    expect(formatCurrency(5, "XYZ" as never)).toContain("$");
  });
});
