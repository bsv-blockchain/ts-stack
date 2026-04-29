---
id: wallet-toolbox
title: "@bsv/wallet-toolbox"
kind: package
domain: wallet
npm: "@bsv/wallet-toolbox"
version: "2.1.22"
last_updated: "2026-04-28"
last_verified: "2026-04-28"
status: stable
tags: ["wallet", "brc100"]
github_repo: "https://github.com/bsv-blockchain/ts-stack"
---

# @bsv/wallet-toolbox

The reference implementation of the BRC-100 wallet standard. Connects the SDK's cryptographic primitives to real storage backends (SQLite, MySQL, IndexedDB), network services (ARC, WhatsOnChain, Chaintracks), and signing flows to provide a complete, production-ready wallet that developers can use directly or customize for their own wallet apps.

## Install

```bash
npm install @bsv/wallet-toolbox
```

## Quick start

```typescript
import { SetupWallet } from '@bsv/wallet-toolbox'

const wallet = await SetupWallet({
  env: 'main'  // mainnet
})

// Ready to use immediately
const action = await wallet.createAction({
  description: 'Send payment',
  outputs: [{
    satoshis: 5000,
    lockingScript: '76a914...',
    outputDescription: 'payment'
  }]
})

const signResult = await wallet.signAction({
  actionReference: action.signableTransaction.reference
})
```

## What it provides

- **Setup factories** — `SetupWallet()`, `Setup()`, `SetupClient()` for quick initialization with sensible defaults
- **Wallet class** — `Wallet` implementing full BRC-100 interface: `createAction()`, `signAction()`, `listActions()`, `listOutputs()`, `internalizeAction()`, `getPublicKey()`, etc.
- **Storage backends** — `KnexWalletStorage` (SQLite/MySQL/PostgreSQL), `IndexedDBWalletStorage` (browser), `RemoteWalletStorage` (client/server over HTTPS)
- **Network services** — `Services` container with `ARC`, `WhatsOnChain`, `Chaintracks` integration; `ArcSSEClient` for real-time status. Chain tracker interface exposes `rootForHeight(height)` and `currentHeight()` — wallets call these to validate Merkle paths. <!-- audio: ts-stack.m4a @ 13:00 -->
- **Transaction monitor** — `Monitor` daemon that polls confirmations, acquires merkle proofs, rebroadcasts stalled txs, updates wallet state
- **Key management** — Three wallet manager types: `CWIStyleWalletManager` / `WalletAuthenticationManager` (WAB-based, requires WAB server for OTP auth flow), `SimpleWalletManager` (root-key based, no external server), `ShamirWalletManager` (Shamir secret sharing for backup/recovery). BRC-42/43 key derivation throughout. <!-- audio: ts-stack.m4a @ 14:30 -->
- **Permissions** — `WalletPermissionsManager` for fine-grained per-app, per-protocol access control with permission modules
- **Signing bridge** — `WalletSigner` adapter connecting BRC-100 wallet to SDK's `Transaction.sign()` interface
- **Utilities** — `MessageSigner` (BRC-18), `OutputTracker`, `CertificateManager`, `WalletLogger`, `EntropyCollector`
- **Testing** — `MockChain` simulated blockchain with merkle proof generation without network

## Common patterns

### Create wallet with default SQLite storage (Node.js)

```typescript
import { SetupWallet } from '@bsv/wallet-toolbox'

const wallet = await SetupWallet({
  env: 'main'  // mainnet
})

// Ready to use immediately
const action = await wallet.createAction({
  description: 'Send payment',
  outputs: [{
    satoshis: 5000,
    lockingScript: '76a914...',
    outputDescription: 'payment'
  }]
})
```

### Browser wallet with IndexedDB

```typescript
import { SetupClient } from '@bsv/wallet-toolbox'

const wallet = await SetupClient({
  env: 'test',  // testnet
  storageProvider: 'indexeddb'
})

const utxos = await wallet.listOutputs({
  includeSpent: false,
  basket: 'default'
})
```

### Remote wallet (client/server with HTTPS)

```typescript
const wallet = await SetupClient({
  endpointUrl: 'https://wallet-server.example.com',
  storageProvider: 'remote'
})

// All wallet calls go over HTTPS; keys stay server-side
```

### Monitor for transaction confirmations

```typescript
const monitor = new Monitor(wallet.storage, wallet.services, {
  pollIntervalMs: 10000  // Check every 10 seconds
})

await monitor.startTasks()

// Monitor will automatically:
// - Detect confirmations
// - Acquire merkle proofs
// - Rebroadcast failed txs
// - Update wallet state
```

## Key concepts

- **BRC-100 Wallet Interface** — Standardized interface that all wallet implementations follow. Enables apps to work with any wallet without code changes.
- **Action** — High-level transaction intent created by app. Wallet converts to specific inputs/outputs for privacy and flexibility.
- **SignableTransaction** — Wallet's opaque reference to a created action. App requests wallet to sign this reference.
- **Certificate** — P2P authentication proof. Identity key + signature over challenge.
- **Storage Backend** — Pluggable abstraction. Same `Wallet` code works with SQLite (Node.js), IndexedDB (browser), or remote HTTPS server.
- **Chain Tracker** — Maintains blockchain state (headers, confirmed height) for SPV-based verification.
- **Monitor** — Background daemon that polls wallets' own transactions and updates confirmed status.
- **Key Derivation** — BRC-42/43 protocol-based hierarchical key generation. Each protocol can request keys without exposing root.

## When to use this

- You're building an app that integrates with user wallets
- You need a reference wallet implementation with real storage
- You want BRC-100 compliance for wallet compatibility
- You need background transaction monitoring and confirmation tracking
- You're building a wallet application yourself

## When NOT to use this

- Use [@bsv/sdk](../sdk/bsv-sdk.md) directly if you only need transaction building and signing (no persistent state)
- Use [@bsv/wallet-relay](./wallet-relay.md) if you need mobile-to-desktop pairing without local wallet

## Spec conformance

- **BRC-100** — Wallet interface standard (full implementation)
- **BRC-18** — Signed messages support
- **BRC-42, BRC-43** — Key derivation protocols
- **BRC-62** — BEEF transaction envelope support
- **SPV** — Full merkle proof verification
- **Bitcoin Script** — Full script evaluation

## Common pitfalls

> **Storage backend mismatch** — `SetupClient` excludes SQLite/MySQL. Don't try to use Knex in browser builds. Use IndexedDB or RemoteWalletStorage for client/mobile.

> **Wallet state consistency** — If monitor is not running, wallet won't know about confirmations. Apps must either run monitor or poll `listActions()` manually.

> **Key manager initialization order** — `PrivilegedKeyManager` must be initialized before `Setup`. Initializing after will cause signing to fail silently.

> **Monitor task conflicts** — Don't run multiple monitor instances on the same storage simultaneously. Use a single monitor per wallet.

> **Action reference lifetime** — `SignableTransaction.reference` is valid only for a short window. Don't cache references; create a new action and sign immediately.

## Related packages

- [@bsv/sdk](../sdk/bsv-sdk.md) — Cryptographic primitives and transaction building
- [@bsv/btms](./btms.md) — Token issuance and transfer with wallet integration
- [@bsv/btms-permission-module](./btms-permission-module.md) — Token spend gating
- [@bsv/wallet-relay](./wallet-relay.md) — Mobile wallet pairing

## Reference

- [API reference (TypeDoc)](https://bsv-blockchain.github.io/ts-stack/api/wallet-toolbox/)
- [Source on GitHub](https://github.com/bsv-blockchain/ts-stack)
- [npm](https://www.npmjs.com/package/@bsv/wallet-toolbox)
