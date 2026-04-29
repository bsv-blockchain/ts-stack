---
id: pkg-wallet-helper
title: "@bsv/wallet-helper"
kind: package
domain: helpers
version: "0.0.6"
source_repo: "bsv-blockchain/wallet-helper"
source_commit: "unknown"
last_updated: "2026-04-28"
last_verified: "2026-04-28"
review_cadence_days: 30
npm: "https://www.npmjs.com/package/@bsv/wallet-helper"
repo: "https://github.com/bsv-blockchain/wallet-helper"
status: beta
tags: [helpers, wallet, transaction-builder]
---

# @bsv/wallet-helper

Transaction builder helpers for wallet-toolbox — fluent API for constructing P2PKH outputs and custom scripts with less boilerplate.

## Install

```bash
npm install @bsv/wallet-helper
```

## Quick start

```typescript
import { WalletBuilder } from '@bsv/wallet-helper';
import { WalletToolbox } from '@bsv/wallet-toolbox';

const wallet = new WalletToolbox();
const builder = new WalletBuilder(wallet);

// Fluent API for building transactions
const tx = builder
  .addOutput().p2pkh(recipientAddress, 1000)
  .addOutput().opReturn(['data1', 'data2'])
  .addOutput().custom(customScript, 0)
  .build();

console.log('Transaction:', tx.txid);
```

## What it provides

- **Fluent builder pattern** — Chain method calls for readable code
- **P2PKH helper** — Easy P2PKH output construction
- **P2PK helper** — Simple P2PK outputs
- **Multisig helper** — Build multisig outputs
- **Custom script helper** — Add arbitrary scripts
- **Change management** — Automatic change calculation
- **Fee estimation** — Built-in fee estimation
- **Validation** — Validate outputs before building

## When to use

- Building transactions with wallet-toolbox
- Creating complex multi-output transactions readably
- Rapid prototyping of transaction flows
- Reducing boilerplate in transaction construction
- Teaching transaction building patterns

## When not to use

- For ultra-simple single payments — use @bsv/simple
- When you need full low-level control — use @bsv/sdk
- For completely custom script logic — use templates directly
- When performance is critical — use @bsv/sdk directly

## API reference

Full TypeScript API documentation: [TypeDoc](https://bsv-blockchain.github.io/ts-stack/api/wallet-helper/)

## Related packages

- @bsv/wallet-toolbox — Wallet implementation
- @bsv/templates — Script templates used internally
- @bsv/sdk — Underlying transaction implementation
- @bsv/simple — For simpler use cases
