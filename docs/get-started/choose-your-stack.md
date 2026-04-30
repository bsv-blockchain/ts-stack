---
id: choose-your-stack
title: Choose Your Stack
kind: meta
version: "n/a"
last_updated: "2026-04-30"
last_verified: "2026-04-30"
review_cadence_days: 30
status: stable
tags: ["decision-guide"]
---

# Choose Your Stack

Start from who controls the keys and how close you need to be to the protocol.

```text
Browser app using a user's wallet?
  -> @bsv/simple/browser

Backend agent with its own key?
  -> @bsv/simple/server

Wallet implementation or wallet infrastructure?
  -> @bsv/wallet-toolbox + BRC-100 spec

Protocol, crypto, scripts, transactions, BEEF, or conformance?
  -> @bsv/sdk
```

## Browser App

Use this when the user already has a local BRC-100 wallet such as BSV Desktop or BSV Browser.

```bash
npm install @bsv/simple
```

```typescript
import { createWallet } from '@bsv/simple/browser'

const wallet = await createWallet()
const recipientIdentityKey = '025706528f0f6894b2ba505007267ccff1133e004452a1f6b72ac716f246216366'
const result = await wallet.pay({
  to: recipientIdentityKey,
  satoshis: 1000
})

console.log(result.txid)
```

The web app does not hold private keys. The wallet client finds an available substrate and forwards BRC-100 calls to the user's wallet application.

## Server Agent

Use this for automated services, bots, funding agents, or test harnesses where the service owns a key.

```bash
npm install @bsv/simple
```

```typescript
import { ServerWallet } from '@bsv/simple/server'

const wallet = await ServerWallet.create({
  privateKey: process.env.SERVER_PRIVATE_KEY!,
  network: 'main',
  storageUrl: 'https://store-us-1.bsvb.tech'
})
```

Use a secret manager for `SERVER_PRIVATE_KEY`. Use a region-specific Wallet Infra endpoint when you operate your own deployment.

## Wallet Builder

Use `@bsv/wallet-toolbox` when you are building a BRC-100 wallet, extending wallet storage, implementing permission UX, or porting the model to another language.

```bash
npm install @bsv/wallet-toolbox
```

The toolbox contains the reference pieces: `Wallet`, `WalletStorageManager`, storage providers, `WalletSigner`, `Services`, `Monitor`, key managers, permissions, and test utilities such as `MockChain`.

Read these together:

- [@bsv/wallet-toolbox](../packages/wallet/wallet-toolbox.md)
- [BRC-100 Wallet Interface](../specs/brc-100-wallet.md)
- [Wallet action examples](../packages/wallet/wallet-toolbox-examples.md)

## Protocol Engineer

Use `@bsv/sdk` for direct access to the core primitives.

```bash
npm install @bsv/sdk
```

The SDK provides secp256k1/r1 cryptography, hashing, scripts, transactions, BEEF (BRC-62), BUMP/Merkle paths (BRC-74), BRC-42 key derivation, ARC broadcasting, Chaintracks clients, BRC-100 interfaces, and wallet substrates.

## Service Operator

Use the infrastructure docs when you need shared services rather than npm packages.

| Service | First page |
|---------|------------|
| Wallet state and UTXO storage | [Wallet Infra](../infrastructure/wallet-infra.md) |
| Store-and-forward encrypted messages | [Message Box Server](../infrastructure/message-box-server.md) |
| Shared on-chain topic lookup | [Overlay Server](../infrastructure/overlay-server.md) |
| Content-addressed files | [UHRP servers](../infrastructure/uhrp-server-basic.md) |
| Wallet authentication backend | [WAB](../infrastructure/wab.md) |
| Block headers and Merkle roots | [Chaintracks Server](../infrastructure/chaintracks-server.md) |

## Decision Matrix

| What you're building | Start with | Usually adds |
|----------------------|------------|--------------|
| Browser app | `@bsv/simple/browser` | `@bsv/message-box-client`, overlays |
| Server agent | `@bsv/simple/server` | `@bsv/402-pay`, Message Box |
| BRC-100 wallet | `@bsv/wallet-toolbox` | Wallet Infra, WAB, Chaintracks |
| Protocol library | `@bsv/sdk` | Conformance vectors |
| Overlay node | `@bsv/overlay`, `@bsv/overlay-express` | `@bsv/overlay-topics`, GASP |
| Token system | `@bsv/btms`, `@bsv/btms-permission-module` | Overlay topics, wallet permissions |
| Authenticated API | `@bsv/auth-express-middleware` | BRC-100 wallet |
| Payment-gated API | `@bsv/402-pay` | `@bsv/payment-express-middleware` |
| File storage | `@bsv/overlay-topics` | UHRP server |

See [Packages](../packages/index.md) for the complete package list.
