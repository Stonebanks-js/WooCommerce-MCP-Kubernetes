/**
 * Static currency table for the utils server's `convert_currency` tool.
 * Rates are units of each currency per 1 USD and are deliberately fixed (this is a demo
 * upstream, not a market data feed); the tool result says so via `rates_as_of: 'static table'`.
 */

export const RATES_PER_USD: Readonly<Record<string, number>> = Object.freeze({
  USD: 1,
  EUR: 0.92,
  GBP: 0.79,
  INR: 83.5,
  JPY: 150,
  AUD: 1.52,
  CAD: 1.36,
  SGD: 1.34,
});

export const SUPPORTED_CURRENCIES: readonly string[] = Object.freeze(Object.keys(RATES_PER_USD));

export const RATES_AS_OF = 'static table' as const;

export class CurrencyError extends Error {
  override readonly name = 'CurrencyError';
}

export interface Conversion {
  amount: number;
  from: string;
  to: string;
  rate: number;
  converted: number;
  rates_as_of: typeof RATES_AS_OF;
}

/** Human-readable description of the table, embedded in the tool description. */
export function describeRates(): string {
  const parts = SUPPORTED_CURRENCIES.filter((code) => code !== 'USD').map(
    (code) => `${RATES_PER_USD[code]} ${code}`,
  );
  return `1 USD = ${parts.join(', ')}`;
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function normaliseCode(code: string): string {
  const upper = code.trim().toUpperCase();
  if (!Object.hasOwn(RATES_PER_USD, upper)) {
    throw new CurrencyError(
      `Unknown currency code "${code}". Supported: ${SUPPORTED_CURRENCIES.join(', ')}`,
    );
  }
  return upper;
}

/**
 * Convert `amount` from one currency to another using the static table.
 * Codes are case-insensitive. `rate` is rounded to 6 decimals, `converted` to 2.
 */
export function convertCurrency(amount: number, from: string, to: string): Conversion {
  if (!Number.isFinite(amount) || amount < 0) {
    throw new CurrencyError('Amount must be a finite, non-negative number');
  }
  const fromCode = normaliseCode(from);
  const toCode = normaliseCode(to);
  const rate = (RATES_PER_USD[toCode] as number) / (RATES_PER_USD[fromCode] as number);
  return {
    amount,
    from: fromCode,
    to: toCode,
    rate: round(rate, 6),
    converted: round(amount * rate, 2),
    rates_as_of: RATES_AS_OF,
  };
}
