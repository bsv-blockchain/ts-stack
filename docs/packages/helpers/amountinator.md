---
id: pkg-amountinator
title: "@bsv/amountinator"
kind: package
domain: helpers
version: "2.0.1"
source_repo: "bsv-blockchain/amountinator"
source_commit: "unknown"
last_updated: "2026-04-28"
last_verified: "2026-04-28"
review_cadence_days: 30
npm: "https://www.npmjs.com/package/@bsv/amountinator"
repo: "https://github.com/bsv-blockchain/amountinator"
status: stable
tags: [helpers, amounts, satoshis]
---

# @bsv/amountinator

> Satoshi/BSV/USD and multi-fiat currency conversion with exchange rate caching and wallet settings integration — convert between crypto (SATS, BSV) and 15+ fiat currencies with auto-refresh.

## Install

```bash
npm install @bsv/amountinator
```

## Quick start

```typescript
import { CurrencyConverter } from '@bsv/amountinator'

const converter = new CurrencyConverter()  // 5-min auto-refresh
await converter.initialize()

// Auto-detect input currency, convert to user's preference
const formatted = await converter.convertAmount('5000')
console.log(formatted.display)   // e.g. "£3.10"
console.log(formatted.hoverText) // e.g. "0.00005000 BSV"

// Cleanup (stop auto-refresh)
converter.dispose()
```

## What it provides

- **CurrencyConverter** — Main class for conversions with auto-refresh
- **Multi-currency support** — 15+ fiat currencies (USD, GBP, EUR, JPY, CNY, INR, etc.)
- **Crypto conversion** — SATS ↔ BSV ↔ Fiat via USD
- **Exchange rate caching** — Configurable auto-refresh interval (default: 5 min)
- **Auto-detection** — Parse "100" (SATS), "0.1" (BSV), or "10 USD" from user input
- **Settings integration** — Read/write preferred currency to wallet settings
- **Formatted output** — Display string with symbol, decimals, and hover text
- **Satoshi rounding** — `convertToSatoshis()` rounds up to ensure sufficient payment

## Common patterns

### Initialize with auto-refresh
```typescript
const converter = new CurrencyConverter()  // 5-min interval
await converter.initialize()
```

### Convert with auto-detection
```typescript
const formatted = await converter.convertAmount('5000')  // "5000" or "0.1" or "10 USD"
console.log(formatted.display)   // formatted for display
console.log(formatted.value)     // numeric value
```

### Convert between specific currencies
```typescript
const usdAmount = converter.convertCurrency(0.1, 'BSV', 'USD')  // 6.2 (if rate = 62)
```

### Get preferred currency symbol
```typescript
const symbol = converter.getCurrencySymbol()  // "$" if USD, "€" if EUR
```

### Convert user currency to satoshis
```typescript
const sats = await converter.convertToSatoshis(10)  // If preferred = 'USD', USD→SATS
console.log(sats)  // e.g. 1610000 (rounded up)
```

### Static converter (no auto-refresh)
```typescript
const staticConverter = new CurrencyConverter(0)  // refreshInterval = 0
await staticConverter.initialize()
const amount = await staticConverter.convertAmount('100')
// Rates will not auto-update
```

## Key concepts

- **Exchange Rates** — Two-tier: USD/BSV (external service), then USD↔fiat (15+ currencies)
- **Preferred Currency** — User's chosen display currency; persisted in wallet settings
- **Auto-Refresh** — Rates updated on interval; caches within window to avoid redundant fetches
- **Currency Detection** — `convertAmount()` auto-detects if input is SATS, BSV, or fiat (via suffix)
- **Wallet Settings Integration** — Reads/writes preferred currency from wallet manager
- **Fiat Conversion** — Single path: SATS ↔ USD ↔ Fiat (via usdPerBsv and fiatPerUsd)
- **Rounding** — `convertToSatoshis()` rounds up (Math.ceil) for payment safety

## When to use this

- Displaying satoshi amounts to users in their preferred currency
- Parsing user input for payment amounts with auto-detection
- Multi-currency applications with live exchange rates
- Formatting amounts for UI display with hover details
- Converting between SATS, BSV, and fiat in wallets or faucets

## When NOT to use this

- For mathematical operations on amounts — use conversions separately
- If you only use satoshis internally — skip conversion entirely
- For financial calculations requiring precision — use BigDecimal library
- For static amounts without live rates — skip auto-refresh

## Spec conformance

- **Currency codes** — ISO 4217 (e.g., USD, GBP, EUR)
- **Satoshi/BSV units** — 1 BSV = 100,000,000 SATS
- **Fiat conversion** — Generic multi-currency (no BRC reference)

## Common pitfalls

- **Rates not available** — `convertCurrency()` throws if `usdPerBsv <= 0`; call `initialize()` first
- **Preferred currency not set** — If settings fetch fails, defaults to 'SATS'
- **Auto-refresh timer not stopped** — Always call `dispose()` before component unmount
- **String parsing ambiguity** — "100.5" is parsed as BSV, "100" as SATS (heuristic: decimal = BSV)
- **Rounding behavior** — `convertToSatoshis()` always rounds UP; use `convertCurrency()` for exact values

## Related packages

- [@bsv/simple](/docs/packages/helpers/simple.md) — Wallet with payment operations
- [@bsv/fund-wallet](/docs/packages/helpers/fund-wallet.md) — Faucet that may display amounts
- [@bsv/sdk](https://github.com/bsv-blockchain/sdk-ts) — Transaction building with satoshis

## Reference

- [API reference (TypeDoc)](https://bsv-blockchain.github.io/ts-stack/api/amountinator/)
- [Source on GitHub](https://github.com/bsv-blockchain/amountinator)
- [npm](https://www.npmjs.com/package/@bsv/amountinator)
