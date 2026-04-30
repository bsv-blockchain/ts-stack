---
id: btms
title: "@bsv/btms"
kind: package
domain: wallet
npm: "@bsv/btms"
version: "1.0.1"
last_updated: "2026-04-28"
last_verified: "2026-04-28"
status: stable
tags: ["tokens", "protocol"]
github_repo: "https://github.com/bsv-blockchain/ts-stack"
---

# @bsv/btms

BTMS — Basic Token Management System — is a modular library for issuing, sending, receiving, and burning UTXO-based tokens on the BSV blockchain. <!-- audio: Btms.m4a @ 00:00 -->

## The wallet context

BSV Desktop and BSV Browser present a **spend authorization modal** whenever BSV is spent from the default basket. Without token context, this modal shows only the raw satoshi amount of the UTXO — typically 1 satoshi for a BTMS token output. That's misleading: the real value is the token embedded in the output's locking script, not the sats funding it. <!-- audio: Btms.m4a @ 00:20 -->

BTMS solves this per-token. A token issuer (e.g. a USD stablecoin issuer) ships a **BTMS module** — a small piece of code that:

- retrieves any additional metadata needed to represent the token's true value (from a server or wallet storage)
- defines how the wallet UX should display and gate authorization for that specific token type
- integrates with the BRC-100 wallet permission system so users see "$1.00 USD" rather than "1 satoshi"

This modular approach means no single token specification is hardcoded. Any token implementation can provide a BTMS module, and it automatically works with every BRC-100-compatible wallet in the ecosystem. <!-- audio: Btms.m4a @ 01:10 -->

See [@bsv/btms-permission-module](./btms-permission-module.md) for the permission hook interface wallet builders register.

---

`@bsv/btms` handles the on-chain side: token lifecycle, UTXO selection, PushDrop encoding, and overlay service integration. Tokens are first-class on-chain objects identified by canonical asset IDs derived from transaction output references.

## Install

```bash
npm install @bsv/btms
```

## Quick start

```typescript
import { BTMS } from '@bsv/btms'

const btms = new BTMS({ networkPreset: 'mainnet' })

// Issue a new token
const result = await btms.issue(1000000, {
  name: 'GOLD',
  description: 'Represents 1 gram of gold',
  iconURL: 'https://example.com/gold.png'
})

console.log('Asset ID:', result.assetId)  // 'abc123...def.0'

// Check balance
const balance = await btms.getBalance(result.assetId)
console.log('Balance:', balance)

// List all owned assets
const assets = await btms.listAssets()
for (const asset of assets) {
  console.log(`${asset.name}: ${asset.balance}`)
}
```

## What it provides

- **Token operations** — `issue()`, `send()`, `accept()`, `burn()` for complete token lifecycle
- **Balance queries** — `getBalance()`, `listAssets()`, `getSpendableTokens()`, `listIncoming()`
- **Ownership proof** — `proveOwnership()`, `verifyOwnership()` for collateral and escrow operations
- **Token encoding** — `BTMSToken.decode()` for extracting token data from locking scripts
- **Asset validation** — `isValidAssetId()`, `isIssuance()` for token identification and verification
- **Configuration** — Wallet integration via `WalletInterface`, network preset selection, optional comms layer

## Common patterns

### Send tokens to recipient

```typescript
const recipientIdentityKey = '025706528f0f6894b2ba505007267ccff1133e004452a1f6b72ac716f246216366'
const sendResult = await btms.send(
  'abc123...def.0',  // Asset ID from issuance
  recipientIdentityKey,
  100  // Amount
)

console.log('Txid:', sendResult.txid)
console.log('Change:', sendResult.changeAmount)
```

### Accept incoming token payment

```typescript
const incoming = await btms.listIncoming()
for (const payment of incoming) {
  console.log(`Incoming: ${payment.amount} of ${payment.assetId}`)
  const result = await btms.accept(payment)
  console.log(`Accepted ${result.amount} tokens`)
}
```

### Burn tokens (permanent destruction)

```typescript
// Burn specific amount
const result = await btms.burn('abc123...def.0', 100)
console.log('Burned:', result.amountBurned)

// Burn entire balance
const resultAll = await btms.burn('abc123...def.0')
```

### Prove token ownership for collateral or escrow

```typescript
const verifierKey = '02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5'
const proof = await btms.proveOwnership(
  'abc123...def.0',
  500,  // Amount to prove
  verifierKey
)

// Send proof to verifier...
// Verifier validates:
const verified = await btms.verifyOwnership(proof)
if (verified.valid) {
  console.log(`Verified ${verified.amount} tokens from ${verified.prover}`)
}
```

## Key concepts

- **Asset ID** — Canonical token identifier: `{txid}.{vout}` where output 0 of the issuance tx is the first token mint.
- **UTXO-based tokens** — Each token lives as a separate output on-chain. Spending a token UTXO is like spending Bitcoin.
- **PushDrop Schema** — 3-field encoding in locking script: Field 0 (asset ID or "ISSUE"), Field 1 (amount), Field 2 (metadata as JSON).
- **Issuance** — When field 0 is `"ISSUE"`, the output is a new token mint. Asset ID becomes txid and vout after confirmation.
- **Transfer** — When field 0 contains an asset ID, tokens are being moved. Amounts must be conserved.
- **Metadata** — JSON object with asset properties (name, description, icon URL, custom fields). Carried through all operations.
- **Incoming Token** — Pending receipt from another user. Must be explicitly accepted to add to wallet balance.
- **Ownership Proof** — Cryptographic proof that prover owns a given amount without revealing private key.

## When to use this

- You're building a token issuance and transfer system
- You need UTXO-based tokens with on-chain metadata
- You're creating a token marketplace or exchange
- You need to prove token ownership without revealing keys
- You're building protocols that use tokens as primitives

## When NOT to use this

- Use [@bsv/sdk](../sdk/bsv-sdk.md) directly if you need low-level Script control and don't want token abstractions
- Use [@bsv/wallet-toolbox](./wallet-toolbox.md) if you need wallet functionality without token support

## Spec conformance

- **PushDrop** — 3-field token encoding per spec
- **BTMSTopicManager** — Validates token transactions on overlay
- **BTMSLookupService** — Indexes tokens for discovery
- **BRC-100** — Uses standard wallet interface for signing
- **BRC-98/99** — Permission hooks for wallet integration

## Common pitfalls

> **Asset ID format** — Asset IDs must be in format `{txid}.{vout}` (lowercase hex txid, dot, vout number). Typos will cause asset not found.

> **Issuance not confirmed** — Immediately after `issue()`, the asset ID returned uses the pending txid. Canonical asset ID is only guaranteed after the tx is mined.

> **Incoming not auto-accepted** — Received tokens stay in `listIncoming()` until explicitly `accept()`ed. Apps must prompt users or auto-accept based on policy.

> **Metadata changes not tracked** — If you transfer tokens with different metadata than the original issuance, the TopicManager may reject the transaction.

> **Burn is permanent** — Once burned, tokens cannot be recovered. Apps should confirm with users before burning.

## Related packages

- [@bsv/sdk](../sdk/bsv-sdk.md) — Script construction, transaction building, and cryptographic primitives
- [@bsv/wallet-toolbox](./wallet-toolbox.md) — Wallet implementation for signing token operations
- [@bsv/btms-permission-module](./btms-permission-module.md) — Permission gating for token spending

## Reference

- [API reference (TypeDoc)](https://bsv-blockchain.github.io/ts-stack/api/btms/)
- [Source on GitHub](https://github.com/bsv-blockchain/ts-stack)
- [npm](https://www.npmjs.com/package/@bsv/btms)
