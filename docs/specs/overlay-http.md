---
id: spec-overlay-http
title: Overlay HTTP API
kind: spec
version: "1.0.0"
last_updated: "2026-04-28"
last_verified: "2026-04-28"
status: stable
tags: ["spec", "overlay"]
---

# Overlay HTTP API

> The Overlay HTTP API exposes a BSV overlay service engine as REST endpoints. Clients submit tagged BEEF transactions, query the overlay for admitted UTXOs, discover topic managers and lookup services, and optionally sync state with peer overlay nodes using GASP (Graph Aware Sync Protocol).

## At a glance

| Field | Value |
|---|---|
| Format | OpenAPI 3.1 |
| Version | 1.0.0 |
| Status | stable |
| Implementations | @bsv/overlay, @bsv/overlay-express |

## What problem this solves

**Decentralized applications without blockchain validation**. Applications built on BSV need to validate which UTXOs are admissible to their protocol without running a full node. Overlay nodes host topic managers (admission logic) and lookup services (UTXO indexing). Clients submit transactions to the overlay, which validates and indexes them, enabling fast queries and low-latency consensus.

**Multi-topic routing in a single transaction**. A transaction can carry data for multiple protocols (topics). The overlay engine routes outputs to the correct topic manager, records admittance, and notifies corresponding lookup services. This enables composable protocols on a single blockchain transaction.

**Peer-to-peer state synchronization**. Multiple overlay nodes can sync state using GASP so they have consistent UTXO knowledge. This enables horizontal scaling and geographic distribution without central coordination.

## Protocol overview

**Transaction submission and routing**:

1. **Client → Overlay** `POST /submit`
   - Raw BEEF transaction (BRC-62) in request body
   - `x-topics` header: JSON array of topic names (e.g., `["tm_ship", "tm_identity"]`)
   - Optional `x-includes-off-chain-values` for metadata

2. **Overlay Engine**
   - Parses BEEF, extracts PushDrop outputs
   - Routes each output to relevant topic manager's `identifyAdmissibleOutputs()`
   - Topic manager responds with list of admissible output indices
   - Overlap engine records admittance in storage, notifies lookup services

3. **Overlay → Client** `200 OK` with STEAK response
   - STEAK = Structured Transaction Evidence for Admitted Knowledge
   - Lists which outputs were admitted to which topics
   - Contains merkle proof (if available)

**UTXO lookup**:

1. **Client → Overlay** `POST /lookup`
   - Topic and query (e.g., `{ service: "ls_identity", query: { identityKey: "02abc..." } }`)

2. **Overlay** queries the topic's lookup service

3. **Overlay → Client** `200 OK` with lookup results (UTXOs, merkle proofs)

**Service discovery**:

- `GET /listTopicManagers` — Lists all hosted topic managers with metadata
- `GET /listLookupServiceProviders` — Lists all lookup services
- `GET /getDocumentationForTopicManager?topic=tm_ship` — Returns protocol specification

## Key types / endpoints

| Method | Path | Purpose | Request | Response |
|--------|------|---------|---------|----------|
| POST | `/submit` | Submit transaction to topics | BEEF binary + `x-topics` header | STEAK (admitted outputs) |
| POST | `/lookup` | Query admitted UTXOs | `{ service, query }` | Lookup results + proofs |
| GET | `/listTopicManagers` | Discover topics | (none) | `[ { name, version, shortDescription } ]` |
| GET | `/listLookupServiceProviders` | Discover lookup services | (none) | `[ { name, version, admissionMode } ]` |
| GET | `/getDocumentationForTopicManager` | Protocol documentation | `?topic=tm_ship` | Markdown documentation |
| POST | `/admin/registerTopicManager` | Register new topic (admin) | Topic config | OK |
| GET | `/health` | Health check | (none) | OK or error |

## Example: Submit transaction to overlay

```typescript
import { PushDrop, Utils, WalletClient } from '@bsv/sdk'

const wallet = new WalletClient('auto', 'example.com')
const topics = ['tm_identity']

// 1. Create the topic-specific transaction with a wallet.
const lockingScript = await new PushDrop(wallet).lock(
  [
    Utils.toArray('identity', 'utf8'),
    Utils.toArray('myIdentity', 'utf8')
  ],
  [2, 'identity overlay'],
  'demo-identity-token',
  'self',
  true
)

const action = await wallet.createAction({
  description: 'Identity overlay admission',
  outputs: [{
    lockingScript: lockingScript.toHex(),
    satoshis: 1,
    outputDescription: 'identity token'
  }],
  options: { randomizeOutputs: false }
})
if (!action.tx) throw new Error('Wallet did not return AtomicBEEF')

// 2. Submit the AtomicBEEF bytes and topic tags to the overlay.
const response = await fetch('https://overlay.example.com/submit', {
  method: 'POST',
  headers: {
    'content-type': 'application/octet-stream',
    'x-topics': JSON.stringify(topics)
  },
  body: new Uint8Array(action.tx)
})

const steak = await response.json()
console.log(steak)  // STEAK: outputs admitted to tm_identity
```

Example: Query admitted UTXOs

```typescript
const lookupResponse = await fetch('https://overlay.example.com/lookup', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    service: 'ls_identity',
    query: { identityKey: '02abc...' }
  })
})

const results = await lookupResponse.json()
console.log(results.outputs ?? results)
```

## Conformance vectors

Overlay conformance is tested in `conformance/vectors/overlay/`:

- BEEF parsing and PushDrop extraction
- Topic manager admission logic
- Lookup service query functionality
- STEAK response format validation
- GASP synchronization protocol

## Implementations in ts-stack

| Package | Notes |
|---------|-------|
| @bsv/overlay | Core engine; orchestrates topic managers, lookup services, storage |
| @bsv/overlay-express | Express.js HTTP server exposing overlay endpoints |
| @bsv/overlay-topics | Pre-built topic managers and lookup services (identity, tokens, supply chain, etc.) |

## Related specs

- [GASP Sync](./gasp-sync.md) — Peer-to-peer state synchronization between overlay nodes
- [UHRP](./uhrp.md) — Content-addressed file storage topic
- [BRC-62 / BEEF](https://github.com/bitcoin-sv/BRCs/blob/master/transactions/0095.md) — Transaction encoding format

## Spec artifact

[overlay-http.yaml](https://github.com/bsv-blockchain/ts-stack/blob/main/specs/overlay/overlay-http.yaml)
