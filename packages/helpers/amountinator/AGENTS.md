# CLAUDE.md — @bsv/amountinator

## Purpose (1-2 sentences)

Satoshi/BSV/USD and multi-fiat currency conversion with exchange rate caching and wallet settings integration. Converts amounts between crypto (SATS, BSV) and 15+ fiat currencies with auto-refresh and user preference persistence.

## Public API surface

### CurrencyConverter
- `constructor(refreshInterval?: number, settingsManager?: WalletSettingsManager)` — Create converter; refreshInterval in ms (default: 5 min), 0 = no auto-refresh
- `async initialize(): Promise<void>` — Fetch exchange rates and preferred currency; start auto-refresh timer if enabled
- `dispose(): void` — Stop auto-refresh timer (cleanup)
- `async fetchExchangeRates(force?: boolean): Promise<ExchangeRates>` — Get USD/BSV and fiat rates
- `getCurrencySymbol(): string` — Return symbol for preferred currency (e.g., "$", "€", "¥")
- `async convertAmount(amount: number | string, formatOptions?: FormatOptions): Promise<FormattedAmount>` — Parse amount string (auto-detect currency), convert to preferred currency, format
- `async convertToSatoshis(amount: number): Promise<number | null>` — Convert from preferred currency to satoshis (rounded up)
- `convertCurrency(amount: number, fromCurrency: string, toCurrency: string): number | null` — Low-level conversion (no async, no formatting)
- `exchangeRates: ExchangeRates` (property) — Current rates { usdPerBsv, fiatPerUsd: {USD, GBP, EUR, ...} }
- `preferredCurrency: SupportedCurrencyCode` (property) — User's preferred currency

### Utilities
- `formatAmountWithCurrency(amount: number, currency: SupportedCurrencyCode, options?: FormatOptions): FormattedAmount` — Format with symbol, decimals, hover text

### Types
- `SupportedCurrencyCode` — 'SATS' | 'BSV' | FiatCurrencyCode
- `FiatCurrencyCode` — 'USD' | 'GBP' | 'EUR' | 'JPY' | 'CNY' | 'INR' | 'AUD' | 'CAD' | 'CHF' | 'HKD' | 'SGD' | 'NZD' | 'SEK' | 'NOK' | 'MXN'
- `ExchangeRates` — { usdPerBsv: number, fiatPerUsd: Record<FiatCurrencyCode, number> }
- `FormatOptions` — { decimals?: number, grouping?: boolean }
- `FormattedAmount` — { display: string, hoverText: string, value: number }

## Real usage patterns

```typescript
// 1. Initialize and convert using preferred currency
import { CurrencyConverter } from '@bsv/amountinator'

const converter = new CurrencyConverter()  // 5-min auto-refresh
await converter.initialize()

// Auto-detect input currency, convert to user's preference
const formatted = await converter.convertAmount('5000')  // "5000" -> assumes SATS or BSV
console.log(formatted.display)   // e.g. "£3.10"
console.log(formatted.hoverText) // e.g. "0.00005000 BSV"

// 2. Convert to specific currency
const usdAmount = converter.convertCurrency(0.1, 'BSV', 'USD')  // 6.2 (if usdPerBsv = 62)

// 3. Get currency symbol
const symbol = converter.getCurrencySymbol()  // "$" if USD, "€" if EUR, etc.

// 4. Fetch fresh rates on demand
const rates = await converter.fetchExchangeRates(true)  // force = true
console.log(rates.usdPerBsv)

// 5. Convert from user's preferred currency to satoshis
const sats = await converter.convertToSatoshis(10)  // If preferred = 'USD', converts USD→SATS
console.log(sats)  // e.g. 1610000

// 6. Cleanup (stop auto-refresh)
converter.dispose()

// 7. No auto-refresh variant
const staticConverter = new CurrencyConverter(0)  // refreshInterval = 0
await staticConverter.initialize()
const amount = await staticConverter.convertAmount('100')
// Rates will not auto-update
```

## Key concepts

- **Exchange Rates** — Two-tier: USD/BSV (from external service), then USD↔fiat (15+ currencies)
- **Preferred Currency** — User's chosen display currency; persisted in wallet settings
- **Auto-Refresh** — Rates updated on interval; caches within window to avoid redundant fetches
- **Currency Detection** — `convertAmount()` auto-detects if input is "100" (SATS) vs "0.1" (BSV) vs "10 USD" (includes currency suffix)
- **Wallet Settings Integration** — Reads/writes preferred currency to wallet's settings manager
- **Fiat Conversion** — Single conversion path: SATS ↔ USD ↔ Fiat (via usdPerBsv and fiatPerUsd)
- **Rounding** — `convertToSatoshis()` rounds up (Math.ceil) to ensure sufficient payment

## Dependencies

**Runtime:**
- `@bsv/sdk` ^2.0.14
- `@bsv/wallet-toolbox-client` ^2.1.18 (Services, WalletSettingsManager)

**Dev:**
- TypeScript, Jest, ts-jest

## Common pitfalls / gotchas

1. **Rates not available** — `convertCurrency()` throws if `usdPerBsv <= 0` or fiat rate is missing; call `initialize()` first
2. **Preferred currency not set** — If settings fetch fails, defaults to 'SATS'; user can manually set `converter.preferredCurrency`
3. **Auto-refresh timer not stopped** — Always call `dispose()` before component unmount to prevent memory leaks
4. **String parsing ambiguity** — "100.5" is parsed as BSV, "100" as SATS (heuristic: decimal point = BSV)
5. **Rounding behavior** — `convertToSatoshis()` always rounds UP; use `convertCurrency()` directly for exact values
6. **Promise caching** — If two calls to `fetchExchangeRates()` happen simultaneously, both await the same promise (deduplication)
7. **Wallet settings manager required** — If you don't provide `settingsManager` in constructor, it creates one internally; ensure wallet client is available

## Spec conformance

- **Currency codes** — ISO 4217 (e.g., USD, GBP, EUR)
- **Satoshi/BSV units** — 1 BSV = 100,000,000 SATS
- **Fiat conversion** — Generic multi-currency (no BRC reference)

## File map

```
amountinator/
  src/
    index.ts                         # Exports
    utils/
      currencyConverter.ts           # CurrencyConverter class
      amountFormatHelpers.ts         # formatAmountWithCurrency function
      types.ts (implied)             # Type definitions (ExchangeRates, SupportedCurrencyCode, etc.)
  tests/
    currencyConverterCache.test.ts   # Cache behavior, rate updates
    formatAmountWithCurrency.test.ts # Formatting and display logic
```

## Integration points

- **Depends on:** `@bsv/sdk` (WalletClient), `@bsv/wallet-toolbox-client` (Services for rate fetch, WalletSettingsManager for preferences)
- **Used by:** UI applications needing multi-currency display (React, Vue, etc.), wallets, faucets, payment forms
- **Complements:** `@bsv/fund-wallet` (faucet may display amounts in user's preferred currency), any app showing BSV amounts to users
