---
id: pkg-did-client
title: "@bsv/did-client"
kind: package
domain: helpers
version: "1.1.2"
source_repo: "bsv-blockchain/did-client"
source_commit: "unknown"
last_updated: "2026-04-28"
last_verified: "2026-04-28"
review_cadence_days: 30
npm: "https://www.npmjs.com/package/@bsv/did-client"
repo: "https://github.com/bsv-blockchain/did-client"
status: stable
tags: [did, identity, helpers]
---

# @bsv/did-client

> DID (Decentralized Identifier) client for BSV blockchain — creates, revokes, and queries `did:bsv:` tokens stored as PushDrop outputs on-chain, with overlay broadcast and lookup service integration.

## Install

```bash
npm install @bsv/did-client
```

## Quick start

```typescript
import { DIDClient } from '@bsv/did-client'
import { WalletClient } from '@bsv/sdk'

// Initialize client
const wallet = new WalletClient()
const didClient = new DIDClient({
  wallet,
  networkPreset: 'mainnet',
  overlayTopic: 'tm_did',
  overlayService: 'ls_did'
})

// Create a DID token
const subjectPublicKey = '02abc123...'  // Public key of identity subject
const createResult = await didClient.createDID(
  'sn-12345-abc',  // Serial number
  subjectPublicKey,
  {
    derivationPrefix: Utils.toBase64(Random(10)),
    derivationSuffix: Utils.toBase64(Random(10))
  }
)

if (createResult.status === 'success') {
  console.log(`DID created: ${createResult.txid}`)
}
```

## What it provides

- **DIDClient** — Main class for DID creation, revocation, and querying
- **Create DIDs** — Mint new DID tokens as PushDrop outputs on-chain
- **Revoke DIDs** — Spend DID token to mark as revoked
- **Find DIDs** — Query overlay lookup service by serial number or outpoint
- **Broadcast** — Publish DIDs to SHIP/SLAP overlay network for discoverability
- **Configuration** — Custom overlay topics and lookup services
- **Pagination** — Filter by date range, limit, skip

## Common patterns

### Create a DID token with derivation params
```typescript
const createResult = await didClient.createDID(
  'sn-12345-abc',  // Serial number (Base64-encoded identifier)
  '02abc123...',   // Subject public key
  {
    derivationPrefix: Utils.toBase64(Random(10)),
    derivationSuffix: Utils.toBase64(Random(10))
  }
)

if (createResult.status === 'success') {
  console.log(`DID created: ${createResult.txid}`)
} else {
  console.error(`Broadcast failed: ${createResult.description}`)
}
```

### Find DID tokens on overlay
```typescript
const foundDIDs = await didClient.findDID(
  {
    serialNumber: 'sn-12345-abc',
    limit: 10
  },
  { includeBeef: true }
)

console.log(`Found ${foundDIDs.length} DID records`)
foundDIDs.forEach(did => {
  console.log(`  txid: ${did.txid}, output: ${did.outputIndex}`)
})
```

### Query by outpoint
```typescript
const byOutpoint = await didClient.findDID({
  outpoint: 'abc123def456.0'
})
```

### Revoke DID by serial number
```typescript
const revokeResult = await didClient.revokeDID({
  serialNumber: 'sn-12345-abc'
})

if (revokeResult.status === 'success') {
  console.log(`DID revoked in tx ${revokeResult.txid}`)
}
```

### Pagination and filtering
```typescript
const page1 = await didClient.findDID({
  limit: 50,
  skip: 0,
  sortOrder: 'desc',
  startDate: '2024-01-01',
  endDate: '2024-12-31'
})
```

## Key concepts

- **DID Token** — PushDrop output containing serialNumber, subject, and derivation params
- **Serial Number** — Arbitrary Base64-encoded identifier for the DID
- **Subject** — Public key of the entity the DID represents
- **Derivation Prefix/Suffix** — Random values used in PushDrop key derivation; must be preserved to revoke
- **BEEF** — Complete transaction chain for proof; required for revocation
- **Overlay Broadcast** — Publish DID tokens to SHIP/SLAP overlay network for discoverability
- **Lookup Service** — Query indexed overlay for DIDs by serialNumber or outpoint
- **Revocation** — Spending the DID output burns it (marks as revoked)

## When to use this

- Creating on-chain DIDs with overlay discoverability
- Building identity systems with revocation support
- Querying DIDs from the overlay network
- Storing derivation params for later revocation
- Integrating DID-based identity into applications

## When NOT to use this

- For simple identity without DID — use raw addresses
- For centralized identity management — use traditional databases
- For paymail-style address resolution — use @bsv/paymail
- If you don't need revocation — consider simpler identity schemes

## Spec conformance

- **did:bsv** — DID method specification (draft)
- **BRC-95** — PushDrop token format (key derivation, encryption)
- **BRC-29** — Hierarchical key derivation
- **SHIP/SLAP** — Overlay network for broadcast and lookup
- **BEEF** — Transaction proof format

## Common pitfalls

- **Derivation params not preserved** — If you don't store derivationPrefix and derivationSuffix, you cannot revoke the DID later
- **Serial number encoding** — Serial number must be Base64-encoded string; UTF-8 strings won't work
- **Subject public key format** — Must be valid public key hex; invalid format causes lock script failure
- **No wallet storage** — DIDs are broadcast to overlay but NOT automatically stored in wallet; create your own tracking
- **Revoke requires BEEF** — To revoke, the output's complete transaction chain is fetched; if wallet doesn't have it, revoke fails

## Related packages

- [@bsv/simple](/docs/packages/helpers/simple.md) — High-level wallet with DID support
- [@bsv/templates](/docs/packages/helpers/ts-templates.md) — PushDrop script implementation
- [@bsv/sdk](https://github.com/bsv-blockchain/sdk-ts) — Core transaction and wallet utilities

## Reference

- [API reference (TypeDoc)](https://bsv-blockchain.github.io/ts-stack/api/did-client/)
- [Source on GitHub](https://github.com/bsv-blockchain/did-client)
- [npm](https://www.npmjs.com/package/@bsv/did-client)
