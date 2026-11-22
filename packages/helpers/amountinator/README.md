# @bsv/amountinator

Release candidate `2.1.11`. Converts BSV and satoshis directly without fiat rates. A whole-satoshi amount expressed in BSV preserves its integer amount, and fractional satoshis still round up when converted for payment. No API, wire or data migration is required.

[![npm version](https://img.shields.io/npm/v/@bsv/amountinator)](https://www.npmjs.com/package/@bsv/amountinator)
[![npm downloads](https://img.shields.io/npm/dm/@bsv/amountinator)](https://www.npmjs.com/package/@bsv/amountinator)

Currency amount conversion and display for BSV wallet UIs. Convert between satoshis, BSV, and fiat currencies (USD, EUR, GBP, JPY, and more) using live exchange rates, and format amounts for human-readable display with proper thousands separators, currency symbols, and adaptive precision.

## Install

```bash
npm install @bsv/amountinator
```

Use Node.js 22 or later and a supported `@bsv/sdk` peer version. Wallet Toolbox provides wallet settings and fiat exchange rates.

## Quick start

```ts
import { CurrencyConverter, formatAmountWithCurrency } from '@bsv/amountinator'

const converter = new CurrencyConverter()
await converter.initialize()

// User's preferred currency from wallet settings (e.g. 'USD', 'EUR', 'BSV', 'SATS').
const preferred = converter.preferredCurrency

// Convert 50,000 satoshis to the user's preferred currency.
const amount = converter.convertCurrency(50_000, 'SATS', preferred)

const { formattedAmount } = formatAmountWithCurrency(amount, preferred)
console.log(formattedAmount) // e.g. "$0.04"
```

## Use cases

### Display a transaction value in the user's preferred currency

```ts
const converter = new CurrencyConverter()
await converter.initialize()

const value = converter.convertCurrency(txOutput.satoshis, 'SATS', converter.preferredCurrency)
const { formattedAmount, hoverText } = formatAmountWithCurrency(value, converter.preferredCurrency)
// `hoverText` is set for very small amounts (e.g. "< $0.01" / "$0.001").
```

### Accept fiat input, send satoshis

```ts
const sats = converter.convertCurrency(9.99, 'USD', 'SATS')
// pass `sats` to a wallet action / payment output
```

### Work in BSV or satoshis without an exchange rate

Use the BSV and SATS units directly when a user enters a cryptocurrency amount.
Fiat conversion requires a successful rate refresh. For payment amounts,
`convertToSatoshis` preserves a whole satoshi and rounds up a genuine fraction.

```ts
const converter = new CurrencyConverter(0)
converter.preferredCurrency = 'BSV'

console.log(converter.convertCurrency(7, 'SATS', 'BSV')) // 0.00000007
console.log(await converter.convertToSatoshis(0.00000007)) // 7
console.log(await converter.convertToSatoshis(0.000000075)) // 8
```

A payment UI should show the final whole-satoshi amount before the user approves.

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

| Export                                                 | Purpose                                                                                                                        |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `CurrencyConverter`                                    | Fetches exchange rates, reads the wallet's preferred currency, and converts between satoshis and fiat                          |
| `formatAmountWithCurrency(amount, currency, options?)` | Formats a number with currency symbol, thousands separators, and adaptive precision; returns `{ formattedAmount, hoverText? }` |

Supported currencies: `BSV`, `SATS`, `USD`, `EUR`, `GBP`, `JPY`, `CNY`, `INR`, `AUD`, `CAD`, `CHF`, `HKD`, `SGD`, `NZD`, `SEK`, `NOK`, `MXN`.

## License

This package is released under the [Apache License 2.0](./LICENSE).

## SDK4 hotfix peer requirement

The SDK4 peer alternative starts at `@bsv/sdk ^4.0.1`, which restores numeric
wallet results and legacy wire compatibility. Existing SDK2/3 alternatives and
lower bounds remain unchanged. SDK4 users should install the 4.0.1 hotfix; no
application-wallet wire or data migration is required.
