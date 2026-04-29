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

Satoshi ↔ BSV conversion utilities and amount formatting helpers — handle currency conversions and display formatting.

## Install

```bash
npm install @bsv/amountinator
```

## Quick start

```typescript
import { satoshisToBSV, bsvToSatoshis, formatAmount } from '@bsv/amountinator';

// Convert satoshis to BSV
const bsvAmount = satoshisToBSV(100000000); // 1.0 BSV
console.log('Amount:', bsvAmount);

// Convert BSV to satoshis
const satoshis = bsvToSatoshis(1.5); // 150000000 satoshis
console.log('Satoshis:', satoshis);

// Format for display
const formatted = formatAmount(12345678, { decimals: 8, symbol: 'BSV' });
console.log('Formatted:', formatted); // "0.12345678 BSV"
```

## What it provides

- **Unit conversion** — Convert between satoshis and BSV
- **Parsing** — Parse user-entered amounts with validation
- **Formatting** — Format amounts for display with locales
- **Rounding** — Handle floating-point precision safely
- **Validation** — Validate amount inputs
- **Symbols** — Support multiple currency representations
- **Localization** — Format amounts in different locales
- **Types** — TypeScript types for amounts

## When to use

- Displaying satoshi amounts to users in BSV
- Parsing user input for payment amounts
- Storing amounts safely without floating-point errors
- Formatting amounts in different locales
- Currency conversion in applications

## When not to use

- For mathematical operations — use BigInt directly
- If you only use satoshis internally — skip conversion
- For financial calculations — use proper BigDecimal library
- For exchange rate conversion — use price feed APIs

## API reference

Full TypeScript API documentation: [TypeDoc](https://bsv-blockchain.github.io/ts-stack/api/amountinator/)

## Related packages

- @bsv/sdk — Transaction building with satoshis
- @bsv/wallet-toolbox — Wallet operations with amounts
- @bsv/simple — Simplified payment operations
