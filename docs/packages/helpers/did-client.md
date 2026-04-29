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

DID (Decentralized Identifier) client for resolving and managing BSV DIDs — query DID documents, verify identity, and manage public keys.

## Install

```bash
npm install @bsv/did-client
```

## Quick start

```typescript
import { DIDClient } from '@bsv/did-client';

const client = new DIDClient();

// Resolve a DID
const did = 'did:bsv:123abc...';
const document = await client.resolveDID(did);

console.log('Public Keys:', document.publicKeys);
console.log('Service Endpoints:', document.serviceEndpoints);

// Verify a DID signature
const isValid = await client.verify(did, message, signature);
console.log('Valid:', isValid);
```

## What it provides

- **DID resolution** — Resolve BSV DIDs to documents
- **Document retrieval** — Get full DID document with keys and endpoints
- **Signature verification** — Verify signatures from DID identities
- **Key management** — Query public keys from DID document
- **Service endpoints** — Retrieve service URLs from DID
- **Caching** — Cache resolved DIDs for performance
- **History** — Track DID document changes over time
- **Integration** — Works with @bsv/overlay DID topic

## When to use

- Verifying user identities via DIDs
- Building DID-based authentication systems
- Resolving service endpoints from identities
- Querying public keys for signature verification
- Integrating DID-based identity into applications

## When not to use

- For paymail-style address resolution — use @bsv/paymail
- If you only need simple public keys — use key exchange directly
- For on-chain identity without DID — use raw addresses
- For centralized user management — use traditional databases

## API reference

Full TypeScript API documentation: [TypeDoc](https://bsv-blockchain.github.io/ts-stack/api/did-client/)

## Related packages

- @bsv/overlay-topics — DID topic manager implementation
- @bsv/paymail — Identity and address discovery
- @bsv/sdk — Signature verification primitives
- @bsv/wallet-toolbox — Wallet for signing DID operations
