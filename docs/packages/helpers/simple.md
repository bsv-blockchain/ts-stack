---
id: pkg-simple
title: "@bsv/simple"
kind: package
domain: helpers
version: "0.3.0"
source_repo: "bsv-blockchain/simple"
source_commit: "unknown"
last_updated: "2026-04-28"
last_verified: "2026-04-28"
review_cadence_days: 30
npm: "https://www.npmjs.com/package/@bsv/simple"
repo: "https://github.com/bsv-blockchain/simple"
status: stable
tags: [helpers, simple, payments]
---

# @bsv/simple

Simplified high-level API for common BSV operations — send payments, query balances, without wallet complexity.

## Install

```bash
npm install @bsv/simple
```

## Quick start

```typescript
import { sendPayment, getBalance } from '@bsv/simple';

// Send a payment
const txid = await sendPayment({
  from: 'your-wif-or-mnemonic',
  to: 'recipient-address',
  amount: 1000 // satoshis
});

console.log('Sent transaction:', txid);

// Query balance
const balance = await getBalance('your-address');
console.log('Balance:', balance, 'satoshis');
```

## What it provides

- **Send payments** — Simple function to send satoshis
- **Query balance** — Get address balance easily
- **List UTXOs** — Get unspent outputs for an address
- **Transaction history** — Query recent transactions
- **Fee estimation** — Estimate transaction fees
- **Broadcast** — Submit transactions to the network
- **Key generation** — Generate new private keys
- **Address derivation** — Derive addresses from keys

## When to use

- Quick prototyping of BSV applications
- Simple payment functionality without full wallet
- Learning BSV development
- Building CLI tools for BSV operations
- One-off transactions or queries

## When not to use

- For production wallet applications — use @bsv/wallet-toolbox
- For complex multi-input transactions — use @bsv/sdk
- For enterprise key management — use proper wallet
- When you need full control over transactions — use @bsv/sdk

## API reference

Full TypeScript API documentation: [TypeDoc](https://bsv-blockchain.github.io/ts-stack/api/simple/)

## Related packages

- @bsv/wallet-toolbox — Full wallet for production use
- @bsv/sdk — Low-level transaction building
- @bsv/templates — Script templates for payments
- @bsv/teranode-listener — Network broadcasting
