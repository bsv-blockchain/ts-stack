# @bsv/amountinator

[![npm version](https://img.shields.io/npm/v/@bsv/amountinator)](https://www.npmjs.com/package/@bsv/amountinator)
[![npm downloads](https://img.shields.io/npm/dm/@bsv/amountinator)](https://www.npmjs.com/package/@bsv/amountinator)

Currency amount conversion and display for BSV wallet UIs. Convert between satoshis, BSV, and fiat currencies (USD, EUR, GBP, JPY, and more) using live exchange rates, and format amounts for human-readable display with proper thousands separators, currency symbols, and adaptive precision.

## Install

```bash
npm install @bsv/amountinator
```

Peer dependencies: `@bsv/sdk`, `@bsv/wallet-toolbox-client`.

## Quick start

```ts
import { CurrencyConverter, formatAmountWithCurrency } from '@bsv/amountinator'

const converter = new CurrencyConverter()
await converter.initialize()

// User's preferred currency from wallet settings (e.g. 'USD', 'EUR', 'BSV', 'SATS').
const preferred = converter.preferredCurrency

// Convert 50,000 satoshis to the user's preferred currency.
const amount = await converter.convertSatoshisToCurrency(50_000, preferred)

const { formattedAmount } = formatAmountWithCurrency(amount, preferred)
console.log(formattedAmount) // e.g. "$0.04"
```

## Use cases

### Display a transaction value in the user's preferred currency

```ts
const converter = new CurrencyConverter()
await converter.initialize()

const value = await converter.convertSatoshisToCurrency(txOutput.satoshis, converter.preferredCurrency)
const { formattedAmount, hoverText } = formatAmountWithCurrency(value, converter.preferredCurrency)
// `hoverText` is set for very small amounts (e.g. "< $0.01" / "$0.001").
```

### Accept fiat input, send satoshis

```ts
const sats = await converter.convertCurrencyToSatoshis(9.99, 'USD')
// pass `sats` to a wallet action / payment output
```

### Format with custom separators

```ts
formatAmountWithCurrency(1234567.89, 'BSV', { useUnderscores: true })
// { formattedAmount: '1_234_567.89 BSV' }
```

### Live-refreshing prices in a dashboard

```ts
const converter = new CurrencyConverter(60_000) // refresh every 60s
await converter.initialize()
// converter.exchangeRates is kept up-to-date by an internal timer
// call converter.dispose() to stop the timer on unmount
```

## API

| Export | Purpose |
|--------|---------|
| `CurrencyConverter` | Fetches exchange rates, reads the wallet's preferred currency, and converts between satoshis and fiat |
| `formatAmountWithCurrency(amount, currency, options?)` | Formats a number with currency symbol, thousands separators, and adaptive precision; returns `{ formattedAmount, hoverText? }` |

Supported currencies: `BSV`, `SATS`, `USD`, `EUR`, `GBP`, `JPY`, `CNY`, `INR`, `AUD`, `CAD`, `CHF`, `HKD`, `SGD`, `NZD`, `SEK`, `NOK`, `MXN`.

## License

Open BSV License — see [LICENSE.txt](./LICENSE.txt).
