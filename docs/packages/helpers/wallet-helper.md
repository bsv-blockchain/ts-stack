---
id: pkg-wallet-helper
title: "@bsv/wallet-helper"
kind: package
domain: helpers
version: "0.0.6"
source_repo: "bsv-blockchain/wallet-helper"
source_commit: "unknown"
last_updated: "2026-04-30"
last_verified: "2026-04-30"
review_cadence_days: 30
npm: "https://www.npmjs.com/package/@bsv/wallet-helper"
repo: "https://github.com/bsv-blockchain/wallet-helper"
status: beta
tags: [helpers, wallet, transaction-builder]
---

# @bsv/wallet-helper

> Fluent transaction builder and wallet-compatible script templates for BSV — construct multi-output transactions (P2PKH, ordinals, custom) with method chaining, BRC-29 key derivation, and no private key exposure.

`@bsv/wallet-helper` is a good starting point for developers coming from other blockchain ecosystems who expect to build transactions explicitly. It gives you a transaction-builder shape for outputs, scripts, ordinals, metadata, inputs, and explicit change destinations, while still delegating keys and signing to a BRC-100 wallet.

Use it when `@bsv/simple` feels too task-oriented, but raw `@bsv/sdk` `WalletClient.createAction` / `signAction` calls are more protocol surface than you want to handle directly.

## Install

```bash
npm install @bsv/wallet-helper
```

## Quick start

```typescript
import { TransactionBuilder } from '@bsv/wallet-helper'

const recipientAddress = '1EvmsbpAY7nESLkN4ajLTMbvsaQ1HpJPGX'

const result = await new TransactionBuilder(wallet, "Payment with metadata")
  .addP2PKHOutput({
    address: recipientAddress,
    satoshis: 5000,
    description: "Payment to Bob"
  })
    // Appends data to this output's locking script; it is not a separate output.
    .addOpReturn(['APP_ID', JSON.stringify({ memo: 'Thanks!' })])
  .build()

console.log(`Sent: ${result.txid}`)
```

## What it provides

- **TransactionBuilder** — Fluent API for multi-output transactions
- **P2PKH outputs** — Pay-to-pubkey-hash with addresses, public keys, or wallet derivation
- **Ordinal outputs** — 1-sat ordinals with inscription and MAP metadata
- **OP_RETURN data** — Attach data to the current output's locking script
- **Custom scripts** — Add arbitrary locking scripts
- **Explicit change destinations** — Override where wallet change is sent when you need that control
- **Input spending** — Consume P2PKH, ordinal, and custom UTXOs
- **BRC-29 derivation** — Self-controlled wallet derivation for outputs this wallet will later unlock
- **Script validation** — Identify and classify script types

## Common patterns

### Multi-output payment with wallet-managed change
```typescript
const aliceAddress = '1EvmsbpAY7nESLkN4ajLTMbvsaQ1HpJPGX'
const bobAddress = '1BoatSLRHtKNngkdXEeobR76b53LETtpyT'

await new TransactionBuilder(wallet, "Multi-output payment")
  .addP2PKHOutput({ address: aliceAddress, satoshis: 1000 })
  .addP2PKHOutput({ address: bobAddress, satoshis: 2000 })
  .build()
```

The wallet still calculates funding and normal change through `createAction` / `signAction`. Use `addChangeOutput` only when you need to specify the change locking script yourself.

### Self-controlled output with BRC-29 automatic derivation
Omitting `address`, `publicKey`, and `walletParams` derives with counterparty `self`. Use this for outputs the same wallet should unlock later, not for sending to another user.

```typescript
await new TransactionBuilder(wallet, "Self-controlled output")
  .addP2PKHOutput({ satoshis: 1000, description: "Output for this wallet" })
    .basket("my-basket")
    .customInstructions("app-data")
  .build()
```

### Spend UTXOs and send to recipient
```typescript
const recipientAddress = '1EvmsbpAY7nESLkN4ajLTMbvsaQ1HpJPGX'

await new TransactionBuilder(wallet, "Spend UTXO")
  .addP2PKHInput({ sourceTransaction, sourceOutputIndex: 0, description: "UTXO" })
  .addP2PKHOutput({ address: recipientAddress, satoshis: 500 })
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
- **BRC-29 Derivation** — Automatic self-derivation; omit `address`, `publicKey`, and `walletParams` only for outputs this wallet should control
- **Wallet-Compatible** — Never exposes private keys; uses wallet's `createAction` / `signAction`
- **Basket** — Logical grouping of outputs for wallet organization
- **CustomInstructions** — JSON metadata per output; wallet-derived outputs can include derivation info
- **BEEF** — Broadcast-Everything-BEEF transaction format for secure input proofs
- **MAP Metadata** — Magic Attribute Protocol for ordinal inscriptions
- **Output randomization** — Improves privacy; disable with `options({ randomizeOutputs: false })`

## When to use this

- You are coming from another blockchain stack and want an explicit transaction-building workflow
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
- **Recipient identity keys** — Use a payment address or payment public key for recipient outputs; auto-derivation uses counterparty `self`
- **OP_RETURN is not its own output** — `addOpReturn` appends OP_RETURN data to the output returned by the previous `add...Output` call
- **Explicit change outputs** — `addChangeOutput` is for controlling where change goes; normal wallet-managed change is handled by `createAction` / `signAction`
- **Omitting satoshis on P2PKH** — Non-change P2PKH outputs need a satoshi amount
- **UTXO input without outputs** — If you add inputs, you must add outputs; builder doesn't auto-create them
- **publicKey vs walletParams** — Choose one per output; don't mix lock types unless you know how that output will be unlocked
- **MAP metadata encoding** — Fields must be key-value strings; nested objects are not standard

## Related packages

- [@bsv/simple](simple.md) — High-level wallet operations
- [@bsv/templates](templates.md) — Low-level script templates
- [@bsv/sdk](../sdk/bsv-sdk.md) — Core primitives, raw transactions, and the BRC-100 `WalletClient`

## Reference

- [API reference (TypeDoc)](https://bsv-blockchain.github.io/ts-stack/api/wallet-helper/)
- [Source on GitHub](https://github.com/bsv-blockchain/wallet-helper)
- [npm](https://www.npmjs.com/package/@bsv/wallet-helper)
