# Quick Start

Get a BSV wallet connected and send your first payment in under 5 minutes.

## Prerequisites

- Node.js 18+
- A BSV wallet browser extension (such as MetaNet Client)
- A funded BSV wallet (mainnet or testnet)

## 1. Install

```bash
npm install @bsv/simple @bsv/sdk
```

## 2. Connect a Wallet

```typescript
import { createWallet } from '@bsv/simple/browser'

const wallet = await createWallet()
console.log('Connected:', wallet.getIdentityKey())
console.log('Address:', wallet.getAddress())
```

`createWallet()` prompts the user to approve the connection via their browser wallet extension. Once approved, you have a fully functional wallet instance with access to all modules.

## 3. Send a Payment

```typescript
const result = await wallet.pay({
  to: '02abc123...',   // recipient's identity key
  satoshis: 1000,
  memo: 'My first payment'
})

console.log('Transaction ID:', result.txid)
```

## 4. Create a Token

```typescript
const token = await wallet.createToken({
  data: { type: 'reward', points: 100 },
  basket: 'my-tokens'
})

console.log('Token created:', token.txid)
```

## 5. List Your Tokens

```typescript
const tokens = await wallet.listTokenDetails('my-tokens')

for (const t of tokens) {
  console.log(t.outpoint, t.data)
  // "abc123.0" { type: 'reward', points: 100 }
}
```

## 6. Inscribe Data On-Chain

```typescript
const inscription = await wallet.inscribeText('Hello blockchain!')
console.log('Inscribed:', inscription.txid)
```

## What's Next?

| Guide | What you'll learn |
|-------|-------------------|
| [Browser Wallet](guides/browser-wallet.md) | Full wallet setup, wallet info, key derivation |
| [Payments](guides/payments.md) | Simple payments, multi-output sends, BRC-29 payments |
| [Tokens](guides/tokens.md) | Create, list, send, redeem, and transfer tokens via MessageBox |
| [Server Wallet](guides/server-wallet.md) | Run a backend wallet, accept funding from browser wallets |
| [Next.js Integration](guides/nextjs-integration.md) | Set up a full-stack BSV app with Next.js |
