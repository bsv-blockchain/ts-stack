---
id: bsv-sdk
title: "@bsv/sdk"
kind: package
domain: sdk
version: "2.0.14"
npm: "@bsv/sdk"
last_updated: "2026-04-28"
last_verified: "2026-04-28"
review_cadence_days: 30
status: stable
tags: ["sdk", "crypto", "transactions"]
github_repo: "https://github.com/bsv-blockchain/ts-stack"
---

# @bsv/sdk

The foundational cryptographic and transaction library for the BSV blockchain. Zero external dependencies — all cryptographic primitives have been validated by a third-party auditor. Every other library in the ts-stack builds on top of `@bsv/sdk`. <!-- audio: ts-stack.m4a @ 27:00 -->

Provides low-level primitives (keys, signatures, hashing), script construction and execution, transaction creation and signing, and integration interfaces for wallets and overlay networks.

## Install

```bash
npm install @bsv/sdk
```

## Quick start

```typescript
import { PrivateKey, P2PKH, Transaction } from '@bsv/sdk'

const privKey = PrivateKey.fromWif('L5EY1SbTvvPNSdCYQe1EJHfXCBBT4PmnF6CDbzCm9iifZptUvDGB')
const sourceTransaction = Transaction.fromHex('0200000001...')  // Previous tx hex

const tx = new Transaction(1, [
  {
    sourceTransaction,
    sourceOutputIndex: 0,
    unlockingScriptTemplate: new P2PKH().unlock(privKey)
  }
], [
  {
    lockingScript: new P2PKH().lock(privKey.toAddress()),
    satoshis: 5000,
    change: true
  }
])

await tx.fee()
await tx.sign()
const broadcast = await tx.broadcast()
```

## What it provides

- **Cryptographic primitives** — `PrivateKey`, `PublicKey`, `Hash`, `Signature`, `Entropy`, `Curve` (secp256k1)
- **Script building** — `Script`, `LockingScript`, `UnlockingScript`, `ScriptChunk`, `OP` codes
- **Script templates** — `P2PKH` (Pay-to-Public-Key-Hash), `P2PK`, `P2SH`, `PushDrop` for overlay protocols
- **Transaction building** — `Transaction`, `Input`, `Output`, complete builder with signing and broadcasting
- **Fee models** — `SatoshisPerKilobyte`, `LivePolicy` for network-aware fee estimation
- **Network integration** — `ARC`, `WhatsOnChainBroadcaster`, `Teranode` broadcasters; `DefaultChainTracker`, `WhatsOnChainChainTracker`
- **SPV verification** — `MerklePath` for merkle inclusion proofs
- **BEEF envelopes** — `Beef` (BRC-62) for atomic transaction batches with proofs
- **Message signing** — BRC-18 signed messages
- **Wallet interface** — `WalletInterface` (BRC-100), `WalletClient()` factory, `ProtoWallet` for testing
- **Auth & identity** — `Certificate`, `IdentityKey`, `AuthModule` for peer authentication
- **Storage & KV** — `Storage` interface with `LocalStorageAdapter`, `InMemoryStorage`; `KVStore` for distributed data
- **Overlay integration** — `TopicBroadcaster`, `TopicListener`, `RemittanceProtocol`, `IdentityResolver`, `Registry`
- **2FA** — `generateTOTP()`, `verifyTOTP()` for time-based one-time passwords

## Common patterns

### Build a P2PKH transaction

```typescript
import { PrivateKey, P2PKH, Transaction } from '@bsv/sdk'

const privKey = PrivateKey.fromWif('L5EY1SbTvvPNSdCYQe1EJHfXCBBT4PmnF6CDbzCm9iifZptUvDGB')
const sourceTransaction = Transaction.fromHex('0200000001...')

const tx = new Transaction(1, [
  {
    sourceTransaction,
    sourceOutputIndex: 0,
    unlockingScriptTemplate: new P2PKH().unlock(privKey)
  }
], [
  {
    lockingScript: new P2PKH().lock(privKey.toAddress()),
    satoshis: 5000,
    change: true
  }
])

await tx.sign()
```

### Use wallet interface for multi-signature or hardware signing

```typescript
import { WalletClient, Transaction, CreateActionArgs } from '@bsv/sdk'

const wallet = WalletClient()  // Connect to browser/desktop wallet
const tx = new Transaction()
tx.addOutput({ satoshis: 1000, ... })

// Use wallet for signing instead of local key
const actionResult = await wallet.createAction({
  description: 'Payment transaction',
  outputs: tx.outputs.map(o => ({ ...o, outputDescription: 'payment' }))
})

const signResult = await wallet.signAction({
  actionReference: actionResult.signableTransaction.reference
})
```

### Verify SPV with merkle proof

```typescript
import { MerklePath, Transaction } from '@bsv/sdk'

const tx = Transaction.fromHex('...')
const merklePath = MerklePath.fromHex('...')

if (merklePath.verify(tx.id, blockHeight, blockHeaderHash)) {
  console.log('Transaction is SPV-proven')
}
```

### Encode data on-chain with PushDrop

```typescript
import { PushDrop, Script } from '@bsv/sdk'

const tokenFields = ['myAssetId', '100', JSON.stringify({ name: 'MyToken' })]
const tokenScript = PushDrop.createFromFields(tokenFields)
const output = { lockingScript: tokenScript, satoshis: 1 }
```

## Key concepts

- **Private Key** — 256-bit value from which all wallet operations derive. Never exposed in network traffic.
- **Public Key** — Elliptic curve point derived from private key; used for address generation and signature verification.
- **Script** — Combination of operation codes and data that define spending conditions. Locking scripts constrain outputs; unlocking scripts unlock them.
- **Transaction** — Atomic unit of blockchain state change. Inputs reference previous outputs (UTXOs); outputs create new UTXOs.
- **UTXO** — Unspent Transaction Output; identified by (txid, outputIndex). Spending requires a valid unlocking script.
- **Signature** — ECDSA signature with sighash byte indicating which transaction fields are committed to.
- **Merkle Proof** — Proof of inclusion in a block; enables SPV without downloading full blocks.
- **BEEF** — BRC-62 envelope; atomic bundle of transactions with merkle proofs for offline verification.
- **Wallet Interface (BRC-100)** — Standardized interface for wallet RPC between apps and wallet services. Abstracts away key management.
- **Overlay** — Second-layer protocol using on-chain anchors (PushDrop) to build services without blockchain modifications.

## When to use this

- You're building any BSV application that needs to create, sign, or verify transactions
- You need to work with Bitcoin Script or transaction primitives
- You're implementing key management or cryptographic operations
- You want to build SPV-based light clients
- You need to integrate with overlay protocols using PushDrop

## When NOT to use this

- Use [@bsv/wallet-toolbox](../wallet/wallet-toolbox.md) instead if you need full wallet functionality with persistent storage and signing management
- Use [@bsv/btms](../wallet/btms.md) if you're building token issuance/transfer (it abstracts the Script encoding)
- Use [@bsv/wallet-relay](../wallet/wallet-relay.md) if you need mobile-to-desktop wallet pairing

## Spec conformance

- **BRC-18** — Signed messages
- **BRC-29** — Bitcoin Envelope (UTXO-addressed messages)
- **BRC-42, BRC-43** — Key derivation protocols
- **BRC-62** — BEEF (transaction envelope format)
- **BRC-100** — Wallet interface standard
- **SPV** — Full merkle proof verification support
- **Bitcoin Script** — Full consensus-rule-compliant interpreter

## Common pitfalls

> **Sighash commit mismatch** — Unlocking script hash commits only to parts of the transaction. If you modify tx after signing, signature becomes invalid. Always sign last.

> **Fee estimation timing** — `tx.fee()` may vary if mempool conditions change. Estimate early and buffer for volatility, or use live fee trackers.

> **UTXO reuse across parallel transactions** — If two transactions reference the same UTXO, only one will confirm. Wallet implementations must track pending outputs.

> **Script evaluation order** — Unlocking script is evaluated first, then locking script. Stack must be left with true atop for success.

> **Broadcast endpoint differences** — ARC, WhatsOnChain, Teranode have different response formats and rate limits. Implement retry logic and fallback chains.

## Related packages

- [@bsv/wallet-toolbox](../wallet/wallet-toolbox.md) — Complete wallet implementation with storage and signing
- [@bsv/btms](../wallet/btms.md) — Token issuance and transfer
- [@bsv/wallet-relay](../wallet/wallet-relay.md) — Mobile wallet pairing

## Reference

- [API reference (TypeDoc)](https://bsv-blockchain.github.io/ts-stack/api/sdk/)
- [Source on GitHub](https://github.com/bsv-blockchain/ts-stack)
- [npm](https://www.npmjs.com/package/@bsv/sdk)
