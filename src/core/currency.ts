import type { CurrencyCode, CurrencyMeta } from "./types";

/**
 * Multi-currency display metadata. The ledger stores USD notional amounts;
 * the display layer renders them in any supported currency using a fixed
 * (configurable) notional rate — multi-currency presentation, single-unit
 * truth.
 */
export const CURRENCIES: Record<CurrencyCode, CurrencyMeta> = {
  USD: { code: "USD", symbol: "$", usdRate: 1, decimals: 2 },
  USDC: { code: "USDC", symbol: "$", usdRate: 1, decimals: 2 },
  EUR: { code: "EUR", symbol: "€", usdRate: 0.92, decimals: 2 },
  INR: { code: "INR", symbol: "₹", usdRate: 83.2, decimals: 0 },
  ETH: { code: "ETH", symbol: "Ξ", usdRate: 0.00045, decimals: 6 },
};

export const DEFAULT_CURRENCY: CurrencyCode = "USD";

export function currencyMeta(code: string): CurrencyMeta {
  return CURRENCIES[code as CurrencyCode] ?? CURRENCIES[DEFAULT_CURRENCY];
}

/** Converts a USD-notional amount into the display currency. */
export function convertFromUsd(usdAmount: number, code: CurrencyCode): number {
  return usdAmount * CURRENCIES[code].usdRate;
}

export function convertToUsd(amount: number, code: CurrencyCode): number {
  return amount / CURRENCIES[code].usdRate;
}

/** Formats an amount as the display currency (e.g. "$1,250.00" or "Ξ0.0056"). */
export function formatCurrency(
  usdAmount: number,
  code: CurrencyCode = DEFAULT_CURRENCY,
): string {
  const meta = currencyMeta(code);
  const value = convertFromUsd(usdAmount, meta.code);
  return `${meta.symbol}${value.toLocaleString("en-US", {
    minimumFractionDigits: meta.decimals,
    maximumFractionDigits: meta.decimals,
  })} ${code}`;
}

export function listCurrencies(): CurrencyMeta[] {
  return Object.values(CURRENCIES);
}
