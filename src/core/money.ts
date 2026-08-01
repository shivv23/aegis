import type { CurrencyCode } from "./types";
import { CURRENCIES } from "./currency";

/**
 * Integer money: amounts are stored as integer `units` in the currency's
 * smallest display unit (e.g. USDC cents at 2 decimals). No floats on the
 * money path — arithmetic is exact and provable.
 */
export interface Money {
  units: bigint;
  currency: CurrencyCode;
  decimals: number;
}

export function decimalsOf(currency: CurrencyCode): number {
  return CURRENCIES[currency].decimals;
}

/**
 * Rounds a display float into integer units. The round-trip
 * units → float → units is exact for any float that represents a valid
 * decimal at the currency's precision, and deterministic for the rest.
 */
export function unitsFromFloat(n: number, decimals: number): bigint {
  if (!Number.isFinite(n)) return 0n;
  return BigInt(Math.round(n * 10 ** decimals));
}

export function money(amount: number, currency: CurrencyCode = "USD"): Money {
  const decimals = decimalsOf(currency);
  return { units: unitsFromFloat(amount, decimals), currency, decimals };
}

export function fromMoney(m: Money): number {
  return Number(m.units) / 10 ** m.decimals;
}

export function moneyFromUnits(units: bigint, currency: CurrencyCode = "USD"): Money {
  return { units, currency, decimals: decimalsOf(currency) };
}

export function addMoney(a: Money, b: Money): Money {
  if (a.currency !== b.currency) throw new Error("currency mismatch in addMoney");
  return { ...a, units: a.units + b.units };
}

export function subMoney(a: Money, b: Money): Money {
  if (a.currency !== b.currency) throw new Error("currency mismatch in subMoney");
  return { ...a, units: a.units - b.units };
}

export function mulMoney(a: Money, b: number): Money {
  const dec = a.decimals;
  const units = BigInt(Math.round(Number(a.units) * b));
  return { units, currency: a.currency, decimals: dec };
}

export function cmpMoney(a: Money, b: Money): number {
  if (a.currency !== b.currency) throw new Error("currency mismatch in cmpMoney");
  return a.units < b.units ? -1 : a.units > b.units ? 1 : 0;
}

export function isZeroMoney(m: Money): boolean {
  return m.units === 0n;
}

/** Integer unit string, safe for TEXT storage and hash chaining. */
export function unitsString(m: Money): string {
  return m.units.toString();
}

/** Pretty display of a Money value (e.g. "$1,250.00" / "Ξ0.0056"). */
export function fmt(m: Money): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: m.currency === "USDC" ? "USD" : m.currency,
    minimumFractionDigits: m.decimals,
    maximumFractionDigits: m.decimals,
  }).format(fromMoney(m));
}
