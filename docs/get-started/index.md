---
id: get-started
title: Get Started
kind: meta
version: "n/a"
last_updated: "2026-04-30"
last_verified: "2026-04-30"
review_cadence_days: 30
status: stable
tags: ["onboarding"]
---

# Get Started

Most application developers should start above the BRC-100 boundary. Your app asks a wallet to do something; the wallet keeps keys, output selection, signing, and storage under its control.

## Step 1: Install

```bash
npm install @bsv/simple
```

Use `@bsv/sdk` directly only when you need protocol-level control over keys, scripts, transactions, BEEF, BUMP, or the raw BRC-100 `WalletClient`.

## Step 2: Connect to a User Wallet

Browser apps use `@bsv/simple/browser`. Under the hood it creates a BRC-100 wallet client and discovers an available wallet substrate such as BSV Desktop over localhost or BSV Browser over a postMessage bridge.

```typescript
import { createWallet } from '@bsv/simple/browser'

const wallet = await createWallet()

console.log(wallet.getIdentityKey())
console.log(wallet.getAddress())
```

Private keys stay in the user's wallet application. The web app receives method results such as transaction IDs, AtomicBEEF bytes, public keys, signatures, or listed outputs depending on the method called.

## Step 3: Do Something Useful

Send a peer-to-peer payment to an identity key:

```typescript
const recipientIdentityKey = '025706528f0f6894b2ba505007267ccff1133e004452a1f6b72ac716f246216366'
const result = await wallet.pay({
  to: recipientIdentityKey,
  satoshis: 1000
})

console.log(result.txid)
```

Create and inspect an encrypted PushDrop token in a basket:

```typescript
const created = await wallet.createToken({
  data: { type: 'reward', points: 100 },
  basket: 'rewards'
})

const tokens = await wallet.listTokenDetails('rewards')
console.log(created.txid, tokens[0]?.outpoint)
```

Get the raw BRC-100 wallet client when you need the method-level interface:

```typescript
const client = wallet.getClient()

const { outputs } = await client.listOutputs({
  basket: 'rewards',
  include: 'locking scripts',
  includeCustomInstructions: true
})

console.log(outputs.length)
```

## Server Agents

Server-side agents use `@bsv/simple/server`. They manage their own key and can connect to Wallet Infra for storage.

```typescript
import { ServerWallet } from '@bsv/simple/server'

const wallet = await ServerWallet.create({
  privateKey: process.env.SERVER_PRIVATE_KEY!,
  network: 'main',
  storageUrl: 'https://store-us-1.bsvb.tech'
})

console.log(wallet.getIdentityKey())
```

Do not generate and discard a production private key at runtime. Persist it in your secret manager and pass it as `SERVER_PRIVATE_KEY`.

## What to Read Next

| Need | Read |
|------|------|
| Pick packages by use case | [Choose Your Stack](./choose-your-stack.md) |
| Understand BEEF, wallets, overlays, and BRC-100 | [Key Concepts](./concepts.md) |
| See every BRC-100 method shape | [BRC-100 Wallet Interface](../specs/brc-100-wallet.md) |
| Build a wallet or wallet-like implementation | [@bsv/wallet-toolbox](../packages/wallet/wallet-toolbox.md) |
| Test another implementation against this repo | [Conformance](../conformance/index.md) |
