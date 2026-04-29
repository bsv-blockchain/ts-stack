---
id: spec-brc-100-wallet
title: BRC-100 Wallet Interface
kind: spec
version: "1.0.0"
last_updated: "2026-04-28"
last_verified: "2026-04-28"
status: stable
tags: ["spec", "wallet", "brc-100"]
---

# BRC-100 Wallet Interface

> BRC-100 defines a standardized interface that all wallet implementations follow. This enables applications to work with any wallet (BSV Desktop, BSV Browser, custom wallets) without code changes, treating the wallet as an opaque transaction signing and key management service.

## At a glance

| Field | Value |
|---|---|
| Format | JSON Schema 2020-12 |
| Version | 1.0.0 |
| Status | stable |
| Implementations | @bsv/wallet-toolbox, @bsv/sdk |

## What problem this solves

**Wallet proliferation without interoperability**. Different wallets (desktop, mobile, browser extensions, hardware) use incompatible signing protocols. Applications must write custom code for each wallet, creating lock-in and friction. BRC-100 defines a common interface so applications can request signing operations from any compliant wallet without knowing implementation details.

**Privacy via opacity**. Applications should not see which specific UTXOs a wallet chooses to spend. BRC-100's "action" model lets apps describe what they want to accomplish (e.g., "send 10,000 satoshis") without revealing address details. The wallet internally selects coins, builds the transaction, and returns a signable reference. This enables privacy and flexibility.

**Key derivation and multi-signature support**. Different protocols need different keys from a single root without exposing the root itself. BRC-100 supports protocol-based key derivation (BRC-42/43) so wallets can issue protocol-specific keys on demand. This supports multi-party signing orchestration and advanced cryptography.

## Protocol overview

**Wallet as a service**. BRC-100 defines a request/response interface:

1. **App calls `wallet.createAction(outputs[])`** — App specifies desired outputs (recipient, satoshis, metadata). Wallet internally selects UTXOs, builds a transaction, and returns an opaque `SignableTransaction` reference.

2. **App calls `wallet.signAction(reference)`** — App signs the reference (which the wallet has locked away internally). Wallet performs ECDSA signing and returns a signature list.

3. **App submits the signed transaction to network** — Wallet doesn't broadcast; app decides when and where to submit.

4. **Wallet tracks outputs via `listOutputs()` and `listActions()`** — Apps poll or listen for transaction status (pending, confirmed, spent).

**Certificate and permission system**. Beyond signing, wallets maintain:

- **Certificates** — Identity proofs for peer-to-peer authentication (BRC-100 model: identity key + signature over a challenge)
- **Permissions** — Fine-grained grants (e.g., "App A can spend from Token Protocol B but not from Protocol C")
- **Topics and discovery** — Overlay service resolution for protocol-specific endpoints

## Key types / endpoints

| Method | Signature | Purpose | Request | Response |
|--------|-----------|---------|---------|----------|
| `createAction` | `async (args: CreateActionArgs)` | Create unsigned transaction | `description, outputs, optionallySignedMetadata` | `signableTransaction: { reference }` |
| `signAction` | `async (args: SignActionArgs)` | Sign a created action | `actionReference, optionallyProveWithCertificates` | `signatures: Signature[]` |
| `listOutputs` | `async (args: ListOutputsArgs)` | Query UTXO state | `basket, includeSpent, limit` | `outputs: Output[]` |
| `listActions` | `async (args: ListActionsArgs)` | Query transaction history | `basket, limit, includedMetadata` | `actions: Action[]` |
| `internalizeAction` | `async (args)` | Import external transaction | `tx: Beef, description` | `{ isMerge: boolean }` |
| `getPublicKey` | `async (args: GetPublicKeyArgs)` | Retrieve identity or derivation key | `protocol?, keyId?` | `publicKey: string` |
| `listCertificates` | `async (args?)` | List installed certificates | (none) | `certificates: Certificate[]` |
| `proveCertificate` | `async (args: ProveCertificateArgs)` | Generate certificate proof | `certificate, challengeData` | `proof: string` |
| `discoverByTopic` | `async (args: DiscoverByTopicArgs)` | Resolve identity/protocol from overlay | `topic` | `results: DiscoveryResult[]` |
| `listPermissions` | `async (args: ListPermissionsArgs)` | Query app permissions | `appId, protocolId?` | `permissions: Permission[]` |

## Example: Create and sign a transaction

```typescript
import { SetupWallet } from '@bsv/wallet-toolbox'

// 1. Create a wallet (in-process or remote)
const wallet = await SetupWallet({ env: 'main' })

// 2. App specifies what it wants to send
const action = await wallet.createAction({
  description: 'Send 5000 sats to recipient',
  outputs: [
    {
      satoshis: 5000,
      lockingScript: '76a914...', // P2PKH script for recipient
      outputDescription: 'payment to alice'
    }
  ]
})

// 3. App requests signature (wallet decides which UTXOs and private keys to use)
const signed = await wallet.signAction({
  reference: action.signableTransaction.reference
})

// 4. App receives signatures and submits transaction to network
// (Wallet doesn't broadcast; app chooses the broadcast service)
const broadcastResult = await submitToARC(signed.tx)
```

Example: Retrieve public key for peer authentication

```typescript
// Get the wallet's identity key for BRC-103 mutual auth
const identityKeyResult = await wallet.getPublicKey({
  // If undefined, returns default identity key
})

const identityKey = identityKeyResult.publicKey
// Use for signing/verifying in peer-to-peer handshakes
```

## Labels vs. Tags

BRC-100 uses two distinct metadata mechanisms that operate at different granularities:

| Concept | Scope | Purpose | Query method |
|---------|-------|---------|--------------|
| **Labels** | Transaction (Action) | Categorize whole transactions | `listActions({ label })` |
| **Tags** | Output (UTXO) | Track specific assets in a basket | `listOutputs({ tags })` |

Labels and tags are mutually independent. An Action may carry labels without any of its outputs having tags, and vice versa.

## Batching Workflows

`createAction` supports two chaining options for constructing coordinated multi-transaction sequences:

**`noSend: true`** — Prepare and sign a transaction without broadcasting. Returns a `signableTransaction.txid` handle for later use.

```typescript
const prepared = await wallet.createAction({
  description: 'Token mint',
  outputs: [...],
  options: { noSend: true }
})
const preparedTxid = prepared.signableTransaction.txid
```

**`sendWith: [txid, ...]`** — Couple the current action with previously `noSend` transactions and broadcast all atomically.

```typescript
await wallet.createAction({
  description: 'Final step — broadcast all',
  outputs: [...],
  options: { sendWith: [preparedTxid] }
})
```

## Privileged Mode

All keys are derived from the wallet's root using BRC-42 (BKDS). BRC-100 additionally reserves a **Privileged Mode** keyring for highly sensitive operations:

- Identity key signing
- Certificate issuance
- High-trust transaction authorization

Privileged-mode operations require explicit wallet UX approval. The privileged keyring is isolated from application keys — privileged key material is never accessible to application code.

## Conformance vectors

BRC-100 defines the wallet interface contract. Conformance vectors exist in `conformance/vectors/wallet/` and test:

- Correct action creation from output specifications
- Correct signing with proper ECDSA signatures
- UTXO and action tracking (spent vs. unspent states)
- Certificate storage and proof generation
- Permission gating of operations

## Implementations in ts-stack

| Package | Notes |
|---------|-------|
| @bsv/wallet-toolbox | Reference implementation with SQLite/MySQL/IndexedDB storage, ARC/WhatsOnChain integration, transaction monitoring |
| @bsv/sdk | ProtoWallet (minimal in-memory), WalletClient (factory for connecting to standard wallets), Transaction signing adapter |

## Related specs

- [BRC-42/43](https://github.com/bitcoin-sv/BRCs/blob/master/wallet/0042.md) — Key derivation for protocol-specific keys
- [BRC-18](https://github.com/bitcoin-sv/BRCs/blob/master/wallet/0018.md) — Signed messages
- [BRC-31 Auth](./brc-31-auth.md) — Mutual authentication (uses wallet identity keys)
- [Storage Adapter](./storage-adapter.md) — Remote wallet storage backend interface

## Spec artifact

[brc-100-wallet.json](https://github.com/bsv-blockchain/ts-stack/blob/main/specs/sdk/brc-100-wallet.json)
