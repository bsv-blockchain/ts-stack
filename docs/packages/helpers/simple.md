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

> High-level wallet API for browser and server — manage payments, tokens, inscriptions, DIDs, and credentials without wrestling with private keys or transactions.

## Install

```bash
npm install @bsv/simple
```

## Quick start

```typescript
import { createWallet } from '@bsv/simple/browser'

const wallet = await createWallet()
const recipientIdentityKey = '025706528f0f6894b2ba505007267ccff1133e004452a1f6b72ac716f246216366'

// Send a payment via MessageBox P2P
const result = await wallet.pay({
  to: recipientIdentityKey,
  satoshis: 1000
})

console.log('Paid:', result.txid)
```

## What it provides

- **Browser wallet** — Create and use wallets in-browser
- **Server wallet** — Server-side wallet with private key management
- **Balance queries** — Get wallet balance and per-basket balances
- **Payments** — Send satoshis via MessageBox P2P or direct on-chain
- **Tokens** — Create, list, send, redeem encrypted PushDrop tokens
- **Inscriptions** — Create OP_RETURN inscriptions (text, JSON, file hashes)
- **DID management** — Create, register, and resolve DIDs
- **Credentials** — Issue and verify W3C Verifiable Credentials
- **MessageBox integration** — Handle identity tags, registries, and P2P payments

## Common patterns

### Check wallet balance
```typescript
const balance = await wallet.getBalance()
console.log(`Balance: ${balance.totalSatoshis} satoshis`)

// Per-basket balance
const tokenBalance = await wallet.getBalance('tokens')
console.log(`Spendable: ${tokenBalance.spendableSatoshis}`)
```

### Register for MessageBox and send payment
```typescript
// Register identity handle
await wallet.certifyForMessageBox('@alice', '/api/identity-registry')

// Find recipient and send payment
const results = await wallet.lookupIdentityByTag('bob', '/api/identity-registry')
await wallet.sendMessageBoxPayment(results[0].identityKey, 1000)
```

### Create and transfer tokens
```typescript
// Create token
const token = await wallet.createToken({
  data: { type: 'loyalty', points: 100 },
  basket: 'my-tokens'
})

// List tokens
const tokens = await wallet.listTokenDetails('my-tokens')

// Send token to another key
await wallet.sendToken({
  basket: 'my-tokens',
  outpoint: tokens[0].outpoint,
  to: recipientKey
})
```

### Direct payments (BRC-29 derivation)
```typescript
// Server generates payment request
const request = serverWallet.createPaymentRequest({ satoshis: 2000 })

// Browser creates BRC-29 derived transaction
const payment = await browserWallet.sendDirectPayment(request)

// Server receives and internalizes
await serverWallet.receiveDirectPayment({
  tx: payment.tx,
  senderIdentityKey: payment.senderIdentityKey,
  derivationPrefix: payment.derivationPrefix,
  derivationSuffix: payment.derivationSuffix,
  outputIndex: payment.outputIndex
})
```

## Key concepts

- **Basket** — Logical grouping of outputs for wallet organization
- **Identity key** — Compressed public key hex (66 chars) for P2P messaging
- **BRC-29 derivation** — Automatic hierarchical key derivation without exposing private keys
- **MessageBox** — P2P payment and message transport via a Message Box server
- **Overlay** — SHIP/SLAP network for broadcast and lookup services
- **Verifiable Credentials** — W3C format for attestations with revocation support

## When to use this

- Building BSV web applications with wallets
- Implementing P2P payment systems
- Issuing credentials or DIDs on-chain
- Creating token-based loyalty or reward systems
- Building identity/authentication systems

## When NOT to use this

- For low-level transaction control — use @bsv/sdk
- For lightweight script templates — use @bsv/templates
- When you need the fluent builder pattern — use @bsv/wallet-helper

## Spec conformance

- **BRC-29** — Hierarchical key derivation
- **BRC-42** — Public key derivation
- **BRC-95** — PushDrop tokens
- **BRC-100** — Wallet interface
- **W3C DIDs** — did:bsv: method

## Common pitfalls

- **`basket insertion` vs `wallet payment` are mutually exclusive** — You cannot use both on the same output in a single transaction
- **PeerPayClient swallows errors** — Always check `if (typeof result === 'string') throw new Error(result)`
- **`result.tx` may be undefined** — Check before using for overlay broadcasting
- **FileRevocationStore is server-only** — Import from `@bsv/simple/server`, not browser
- **Overlay topics must start with `tm_`; lookup services with `ls_`** — The Overlay class enforces these prefixes

## Related packages

- [@bsv/wallet-helper](wallet-helper.md) — Fluent transaction builder
- [@bsv/templates](templates.md) — Low-level script templates
- [@bsv/sdk](https://github.com/bsv-blockchain/sdk-ts) — Core transaction building

## Reference

- [API reference (TypeDoc)](https://bsv-blockchain.github.io/ts-stack/api/simple/)
- [Source on GitHub](https://github.com/bsv-blockchain/simple)
- [npm](https://www.npmjs.com/package/@bsv/simple)
