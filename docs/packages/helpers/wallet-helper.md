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

> Fluent transaction builder and wallet-compatible script templates for BSV — construct multi-output transactions (P2PKH, ordinals, custom) with method chaining, BRC-29 key derivation, and no private key exposure.

## Install

```bash
npm install @bsv/wallet-helper
```

## Quick start

```typescript
import { TransactionBuilder } from '@bsv/wallet-helper'

const result = await new TransactionBuilder(wallet, "Payment with metadata")
  .addP2PKHOutput({
    publicKey: recipientKey,
    satoshis: 5000,
    description: "Payment to Bob"
  })
  .addOpReturn(['APP_ID', JSON.stringify({ memo: 'Thanks!' })])
  .build()

console.log(`Sent: ${result.txid}`)
```

## What it provides

- **TransactionBuilder** — Fluent API for multi-output transactions
- **P2PKH outputs** — Pay-to-pubkey-hash with automatic or derived keys
- **Ordinal outputs** — 1-sat ordinals with inscription and MAP metadata
- **OP_RETURN** — Data inscriptions with automatic unlocking
- **Custom scripts** — Add arbitrary locking scripts
- **Change output** — Auto-calculate change with fee deduction
- **Input spending** — Consume P2PKH, ordinal, and custom UTXOs
- **BRC-29 derivation** — Automatic hierarchical key derivation
- **Script validation** — Identify and classify script types

## Common patterns

### Multi-output transaction with auto-calculated change
```typescript
await new TransactionBuilder(wallet, "Multi-output with change")
  .addP2PKHOutput({ publicKey: alice, satoshis: 1000 })
  .addP2PKHOutput({ publicKey: bob, satoshis: 2000 })
  .addChangeOutput({ description: "Change" })
  .build()
```

### Transaction with BRC-29 automatic derivation (no public key)
```typescript
await new TransactionBuilder(wallet, "Auto-derived")
  .addP2PKHOutput({ satoshis: 1000 })  // Uses automatic derivation
    .basket("my-basket")
    .customInstructions("app-data")
  .build()
```

### Spend UTXOs and send to recipient
```typescript
await new TransactionBuilder(wallet, "Spend UTXO")
  .addP2PKHInput({ sourceTransaction, sourceOutputIndex: 0, description: "UTXO" })
  .addP2PKHOutput({ publicKey: recipient, satoshis: 500 })
  .build()
```

### Create 1-sat ordinal with inscription and metadata
```typescript
const ordResult = await new TransactionBuilder(wallet, "Mint ordinal")
  .addOrdinalP2PKHOutput({
    walletParams: { protocolID: [2, 'p2pkh'], keyID: '0', counterparty: 'self' },
    satoshis: 1,
    inscription: {
      dataB64: Buffer.from('Hello ordinals').toString('base64'),
      contentType: 'text/plain'
    },
    metadata: { app: 'gallery', type: 'greeting', author: 'Alice' }
  })
  .build()
```

## Key concepts

- **Fluent API** — Method chaining for readable transaction construction
- **BRC-29 Derivation** — Automatic hierarchical key derivation; omit publicKey to enable
- **Wallet-Compatible** — Never exposes private keys; uses wallet's `createAction` / `signAction`
- **Basket** — Logical grouping of outputs for wallet organization
- **CustomInstructions** — JSON metadata per output; auto-includes derivation info
- **BEEF** — Broadcast-Everything-BEEF transaction format for secure input proofs
- **MAP Metadata** — Magic Attribute Protocol for ordinal inscriptions
- **Output randomization** — Improves privacy; disable with `options({ randomizeOutputs: false })`

## When to use this

- Building transactions with method chaining
- Creating complex multi-output transactions readably
- Working with ordinals and inscriptions
- Leveraging wallet derivation without exposing keys
- Reducing boilerplate in transaction construction

## When NOT to use this

- For ultra-simple single payments — use @bsv/simple
- When you need full low-level control — use @bsv/sdk
- For completely custom script logic — use @bsv/templates directly

## Spec conformance

- **BRC-29** — Hierarchical key derivation
- **BRC-42** — Public key derivation
- **BRC-100** — Wallet interface
- **BRC-95** — PushDrop tokens
- **MAP** — Magic Attribute Protocol for ordinal metadata
- **1-sat Ordinals** — Inscription format

## Common pitfalls

- **Lock/Unlock key mismatch** — If you lock with `walletParams` but try to unlock with `publicKey`, it fails
- **Omitting satoshis on P2PKH** — Without satoshis and no changeOutput, transaction will fail during build
- **UTXO input without outputs** — If you add inputs, you must add outputs; builder doesn't auto-create them
- **publicKey vs walletParams** — Choose one per output; don't mix. Wallet derivation is preferred for security
- **MAP metadata encoding** — Fields must be key-value strings; nested objects are not standard

## Related packages

- [@bsv/simple](simple.md) — High-level wallet operations
- [@bsv/templates](templates.md) — Low-level script templates
- [@bsv/sdk](https://github.com/bsv-blockchain/sdk-ts) — Core transaction building

## Reference

- [API reference (TypeDoc)](https://bsv-blockchain.github.io/ts-stack/api/wallet-helper/)
- [Source on GitHub](https://github.com/bsv-blockchain/wallet-helper)
- [npm](https://www.npmjs.com/package/@bsv/wallet-helper)
