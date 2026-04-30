---
id: sdk-domain
title: SDK
kind: meta
domain: sdk
version: "n/a"
last_updated: "2026-04-28"
last_verified: "2026-04-28"
review_cadence_days: 30
status: stable
tags: ["domain", "sdk"]
---

# SDK Domain

The foundation of ts-stack. Contains core cryptographic primitives, Bitcoin Script execution, transaction building and signing, network broadcasting, and lightweight SPV verification. This is the base layer that all other ts-stack packages build on top of.

The SDK is intentionally standalone with zero runtime dependencies — it works in both Node.js and modern browsers using native crypto APIs. It provides both low-level primitives (for fine-grained control) and high-level helpers (for common workflows).

## Packages in this Domain

| Package | Purpose |
|---------|---------|
| [@bsv/sdk](./bsv-sdk.md) | Cryptographic primitives, script building, transactions, BEEF, SPV, wallet interface types, broadcasting, and overlay tools |

## Common Use Cases

### I'm building an application that needs to handle Bitcoin transactions
Start with [@bsv/sdk](./bsv-sdk.md) for transaction building, signing, and broadcasting. If you need persistent state and balance tracking, layer [@bsv/wallet-toolbox](../wallet/wallet-toolbox.md) on top.

### I'm building a wallet application
Use [@bsv/sdk](./bsv-sdk.md) for cryptographic operations and [@bsv/wallet-toolbox](../wallet/wallet-toolbox.md) for the full BRC-100 wallet implementation with storage and signing.

### I'm working with tokens
Use [@bsv/sdk](./bsv-sdk.md) for low-level script control, or [@bsv/btms](../wallet/btms.md) for higher-level token abstraction.

### I need to verify a transaction (SPV)
[@bsv/sdk](./bsv-sdk.md) provides full SPV support with `MerklePath` for merkle proof verification without downloading full blocks.

### I need to encode data on-chain
[@bsv/sdk](./bsv-sdk.md)'s `PushDrop` class encodes multi-field data in locking scripts, used by overlay protocols like BTMS.

## Key Concepts

- **Private Key** — 256-bit secret that controls UTXOs and signs transactions. Must never be exposed.
- **Public Key** — Elliptic curve point derived from private key. Used for address generation and signature verification.
- **Script** — Bitcoin Script bytecode that defines spending conditions. Locking scripts (on outputs) constrain who can spend; unlocking scripts (in inputs) prove authorization.
- **Transaction** — Atomic unit of blockchain state change. Contains inputs (references to previous outputs) and outputs (new UTXOs).
- **UTXO** — Unspent Transaction Output. Identified by (txid, outputIndex). Spending requires a valid unlocking script.
- **Signature** — ECDSA signature with sighash byte indicating which transaction fields are committed to. Used to prove authorization.
- **Merkle Proof** — Cryptographic proof that a transaction is included in a specific block. Enables SPV without full chain download.
- **BEEF** — BRC-62 envelope format. Bundles transaction(s) with merkle proofs for offline verification and atomic transmission.
- **Wallet Interface (BRC-100)** — Standardized interface that all wallets implement. Apps can work with any wallet without code changes.
- **Overlay** — Layer-2 protocol using on-chain anchors (PushDrop) to build services without modifying Bitcoin consensus.

## Quick Example

```typescript
import { PrivateKey, P2PKH, Transaction } from '@bsv/sdk'

// Create a private key
const key = PrivateKey.fromRandom()
const recipientAddress = '1EvmsbpAY7nESLkN4ajLTMbvsaQ1HpJPGX'

// Build and sign a transaction
const tx = new Transaction(1, [
  {
    sourceTransaction: Transaction.fromHex('...'),
    sourceOutputIndex: 0,
    unlockingScriptTemplate: new P2PKH().unlock(key)
  }
], [
  {
    lockingScript: new P2PKH().lock(recipientAddress),
    satoshis: 5000
  },
  {
    lockingScript: new P2PKH().lock(key.toAddress()),
    change: true
  }
])

// Sign and broadcast
await tx.fee()
await tx.sign()
const response = await tx.broadcast()
console.log('Broadcasted:', response.txid)
```

## What Each Package Provides

### @bsv/sdk
- Elliptic curve cryptography (secp256k1), ECDSA signatures, key derivation (BRC-42/43)
- 20+ script templates and Bitcoin Script interpreter
- Transaction builder with fee estimation and broadcasting
- Network integration (ARC, WhatsOnChain, Teranode)
- SPV merkle proof verification
- BRC-100 wallet interface types and WalletClient factory
- Message signing (BRC-18), TOTP, BEEF encoding/decoding
- Storage and KV store abstractions
- Overlay protocol integration (topics, remittance, identity, registry)

## When to Use SDK vs. Higher Layers

- **Use SDK directly** if: You're building a stateless app, you only need transaction building, you want fine-grained Script control, you're implementing a custom wallet
- **Use Wallet Toolbox** if: You need persistent storage, background monitoring, full BRC-100 wallet, Shamir key sharing, permission management
- **Use BTMS** if: You're working with tokens, you want token-specific abstractions like issuance/transfer/burn
- **Use Wallet Relay** if: You need mobile-to-desktop wallet pairing without local key storage

## Next Steps

- **[@bsv/sdk](./bsv-sdk.md)** — Full API reference and code examples
- **[Wallet Domain](../wallet/index.md)** — Higher-layer packages for persistence and key management
- **Guides** — Hands-on examples (coming soon)
