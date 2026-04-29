---
id: get-started
title: Get Started
kind: meta
version: "n/a"
last_updated: "2026-04-29"
last_verified: "2026-04-29"
review_cadence_days: 30
status: stable
tags: ["onboarding"]
---

# Get Started

Most apps on ts-stack start with `@bsv/simple` — one import, full access to payments, tokens, identity, and messaging. This guide gets you from zero to your first on-chain action in three steps.

## Step 1: Install

```bash
npm install @bsv/simple @bsv/sdk
```

`@bsv/sdk` is a required peer dependency. It provides the cryptographic primitives and transaction engine that `@bsv/simple` builds on.

## Step 2: Connect a Wallet

### Browser app (user's wallet)

Your app connects to the user's BSV wallet extension over `localhost` or `window.postMessage`. Your code never holds private keys.

```typescript
import { createWallet } from '@bsv/simple/browser'

const wallet = await createWallet()
console.log('Connected:', wallet.getIdentityKey())
```

`createWallet()` prompts the user to approve the connection via their browser wallet. Once approved, all wallet methods are available.

### Server agent (self-custodial)

A server wallet manages its own keys with file-based persistence — suitable for bots, automated agents, and backend funding.

```typescript
import { ServerWallet } from '@bsv/simple/server'

const wallet = await ServerWallet.create({ storageDir: './wallet-data' })
console.log('Ready:', wallet.getIdentityKey())
```

## Step 3: Do Something Useful

### Send a payment

```typescript
const result = await wallet.pay({
  to: '02abc123...',   // recipient identity key
  satoshis: 1000,
  memo: 'Hello BSV'
})
console.log('txid:', result.txid)
```

### Create and query a token

```typescript
const token = await wallet.createToken({
  data: { type: 'reward', points: 100 },
  basket: 'my-tokens'
})

const tokens = await wallet.listTokenDetails('my-tokens')
for (const t of tokens) {
  console.log(t.outpoint, t.data)
}
```

### Inscribe data on-chain

```typescript
const inscription = await wallet.inscribeText('Hello blockchain!')
console.log('txid:', inscription.txid)
```

## What to Read Next

| Guide | What you'll learn |
|-------|-------------------|
| [Install](./install.md) | Entry points, framework setup, TypeScript config |
| [Choose Your Stack](./choose-your-stack.md) | Pick the right packages for what you're building |
| [Key Concepts](./concepts.md) | BEEF, BRC-100, wallets, overlays, identity |
| [Guides](../guides/index.md) | Wallets, overlays, messaging, HTTP 402 payments |
