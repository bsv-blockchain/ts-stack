---
id: pkg-did-client
title: '@bsv/did-client'
kind: package
domain: helpers
version: '1.3.3'
source_repo: 'bsv-blockchain/ts-stack'
last_updated: '2026-09-23'
last_verified: '2026-09-23'
review_cadence_days: 30
npm: 'https://www.npmjs.com/package/@bsv/did-client'
repo: 'https://github.com/bsv-blockchain/ts-stack/tree/main/packages/helpers/did-client'
status: stable
tags: [did, identity, helpers]
---

# @bsv/did-client

> Client for the legacy BSV DID PushDrop overlay, including bounded creation,
> revocation, and lookup flows.

The 1.3.3 source candidate fixes the CommonJS build: `require()` consumers no longer fail with `.default is not a constructor` when `DIDClient` constructs SDK objects. No API migration is required.

## Trust model and wire limitation

The v1 token wire format contains a serial number and counterparty-derived
signature, but no issuer or subject identifier. A canonical overlay result
therefore proves the token/outpoint structure, not an issuer-to-subject identity
claim. Relying applications must bind the result to an authenticated enrollment
record, certificate, explicit local trust decision, or another independent
source. Do not use an uncorroborated lookup result as an identity credential.

Current clients lock newly created tokens to the issuer's derived key, allowing
that wallet to revoke a token whose named subject is different. Older
distinct-subject outputs used a subject-owned lock while retaining the
derivation metadata only in the issuer wallet. The missing public identities
make those historical outputs impossible to repair locally without a
coordinated protocol migration.

## Install

```bash
npm install @bsv/did-client
```

## Quick start

```typescript
import { DIDClient } from '@bsv/did-client'
import { Utils, WalletClient } from '@bsv/sdk'

// Initialize client
const wallet = new WalletClient()
const didClient = new DIDClient({
  wallet,
  networkPreset: 'mainnet',
  overlayTopic: 'tm_did',
  overlayService: 'ls_did'
})

// Create a DID token
const subjectPublicKey = '025706528f0f6894b2ba505007267ccff1133e004452a1f6b72ac716f246216366'
const serialNumber = Utils.toBase64(Utils.toArray('sn-12345-abc', 'utf8'))
const createResult = await didClient.createDID(serialNumber, subjectPublicKey)

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
- **Configuration** — Custom overlay topics, lookup services, and explicit
  `mainnet`, `testnet`, `teratestnet`, or `local` routing
- **Pagination** — Filter by date range, limit, skip

## Common patterns

### Create a DID token

```typescript
const createResult = await didClient.createDID(
  Utils.toBase64(Utils.toArray('sn-12345-abc', 'utf8')),
  '025706528f0f6894b2ba505007267ccff1133e004452a1f6b72ac716f246216366'
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
    serialNumber: Utils.toBase64(Utils.toArray('sn-12345-abc', 'utf8')),
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
  serialNumber: Utils.toBase64(Utils.toArray('sn-12345-abc', 'utf8'))
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

- **DID Token** — Public PushDrop output containing a serial number and opaque signature; issuer and subject are not wire fields
- **Serial Number** — Arbitrary Base64-encoded identifier for the DID
- **Subject** — Public key supplied during creation and retained in authenticated issuer-wallet metadata; applications establish its public association separately
- **Derivation Prefix/Suffix** — Random values used in PushDrop key derivation; must be preserved to revoke
- **BEEF** — Complete transaction chain for proof; required for revocation
- **Overlay Broadcast** — Publish DID tokens to SHIP/SLAP overlay network for discoverability
- **Lookup Service** — Query indexed overlay for DIDs by serialNumber or outpoint
- **Revocation** — Spending the issuer-owned DID output removes it from the overlay

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
- **No independent identity proof** — Overlay lookup does not authenticate an issuer or subject; retain an independent trusted binding
- **Revoke requires BEEF** — To revoke, the output's complete transaction chain is fetched; if wallet doesn't have it, revoke fails

## Related packages

- [@bsv/simple](simple.md) — High-level wallet with DID support
- [@bsv/templates](templates.md) — PushDrop script implementation
- [@bsv/sdk](https://github.com/bsv-blockchain/ts-stack/tree/main/packages/sdk) — Core transaction and wallet utilities

## Reference

- [API reference (TypeDoc)](https://bsv-blockchain.github.io/ts-stack/api/did-client/)
- [Source on GitHub](https://github.com/bsv-blockchain/ts-stack/tree/main/packages/helpers/did-client)
- [npm](https://www.npmjs.com/package/@bsv/did-client)
