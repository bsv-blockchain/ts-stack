---
id: pkg-gasp
title: "@bsv/gasp"
kind: package
domain: overlays
version: "1.2.2"
source_repo: "bsv-blockchain/gasp"
source_commit: "unknown"
last_updated: "2026-04-28"
last_verified: "2026-04-28"
review_cadence_days: 30
npm: "https://www.npmjs.com/package/@bsv/gasp"
repo: "https://github.com/bsv-blockchain/gasp"
status: stable
tags: [overlay, sync, gasp, graph]
---

# @bsv/gasp

> Graph Aware Sync Protocol — synchronize transaction graphs between overlay nodes with incremental building, SPV validation, and bandwidth efficiency.

## Install

```bash
npm install @bsv/gasp
```

## Quick start

```typescript
import { GASP, LogLevel } from '@bsv/gasp'

// Implement GASPStorage
class MyStorage implements GASPStorage {
  async findKnownUTXOs(since, limit?) {
    return [
      { txid: 'abc...', outputIndex: 0, score: Date.now() },
      { txid: 'def...', outputIndex: 1, score: Date.now() }
    ]
  }

  async hydrateGASPNode(graphID, txid, outputIndex, metadata) {
    return {
      graphID,
      rawTx: '0100...',
      outputIndex,
      proof: 'BUMP_proof...'
    }
  }

  async appendToGraph(tx, spentBy?) {
    // Store node in temporary graph
  }

  async validateGraphAnchor(graphID) {
    // Confirm graph is anchored in blockchain
  }

  async finalizeGraph(graphID) {
    // Finalize into persistent storage
  }
}

// Initialize and sync
const gasp = new GASP(
  new MyStorage(),
  remoteImplementation,
  0,
  '[GASP] ',
  false,
  false,
  LogLevel.INFO,
  false
)

await gasp.sync()
```

## What it provides

- **Graph synchronization** — Recursively fetches transaction ancestors/descendants, building validated graphs
- **SPV validation** — Uses Merkle proofs (BUMP) and script validation to ensure only valid data finalized
- **Incremental sync** — Only fetches data not already known; minimizes bandwidth
- **Completeness** — Recursively requests needed inputs until graph complete or remote exhausted
- **Metadata support** — Each transaction/output carries custom metadata, recursively propagated
- **Unidirectional mode** — "Pull only" sync useful for SPV clients that don't publish
- **Sequential vs Parallel** — Parallel (default) for speed, Sequential for DB-lock safety

## Common patterns

### Implement GASPRemote for HTTP communication

```typescript
class MyRemote implements GASPRemote {
  async getInitialResponse(request) {
    const response = await fetch('https://peer.example.com/gasp/initial', {
      method: 'POST',
      body: JSON.stringify(request)
    })
    return response.json()
  }

  async getInitialReply(response) {
    const reply = await fetch('https://peer.example.com/gasp/reply', {
      method: 'POST',
      body: JSON.stringify(response)
    })
    return reply.json()
  }

  async requestNode(graphID, txid, outputIndex, metadata) {
    const response = await fetch('https://peer.example.com/gasp/node', {
      method: 'POST',
      body: JSON.stringify({ graphID, txid, outputIndex, metadata })
    })
    return response.json()
  }

  async submitNode(node) {
    const response = await fetch('https://peer.example.com/gasp/submit', {
      method: 'POST',
      body: JSON.stringify(node)
    })
    return response.json()
  }
}
```

### Unidirectional (pull-only) sync

```typescript
const gaspPullOnly = new GASP(
  storage,
  remote,
  0,
  '[GASP-Pull] ',
  false,
  true,  // unidirectional = true
  LogLevel.DEBUG,
  false
)

await gaspPullOnly.sync()
// Local storage updated, but remote sees no data from us
```

### Sequential sync for DB safety

```typescript
const gaspSequential = new GASP(
  storage,
  remote,
  0,
  '[GASP-Sequential] ',
  false,
  false,
  LogLevel.WARN,
  true   // sequential = true
)

await gaspSequential.sync()
// One operation at a time to avoid DB locking
```

## Key concepts

- **Graph Aware Sync** — Unlike "UTXO list" sync, GASP recursively fetches transaction ancestors and descendants, building a validated transaction graph
- **Legitimacy** — Uses Merkle proofs (BUMP), script validation, and SPV rules to ensure only valid data finalized
- **Completeness** — Recursively requests needed inputs until graph complete or remote exhausted
- **Efficiency** — Only fetches data not already known; minimizes bandwidth by selective requests
- **Metadata support** — Each transaction/output carries custom metadata; recursively propagated
- **Graph ID** — Unique identifier for a transaction graph (typically TXID.outputIndex of tip UTXO)
- **BUMP proof** — Merkle proof anchoring transaction in block; optional but recommended for SPV validation
- **Unidirectional** — "Pull only" mode useful for SPV clients that don't publish

## When to use this

- Synchronizing transaction state between overlay nodes
- Building decentralized applications that need consistent graph state
- Implementing overlay consensus mechanisms
- Creating federated or sharded overlay networks
- Optimizing bandwidth when syncing large transaction sets

## When NOT to use this

- For simple message passing — use application-level messaging
- If you only need transaction broadcast — use @bsv/teranode-listener
- For non-transaction data — use generic sync protocols
- Without transaction data to sync — GASP is transaction-specific

## Spec conformance

- **Graph Aware Sync Protocol** — GASP version 1
- **Merkle proof integration** — Supports BUMP for SPV validation
- **Transaction format** — Uses raw hex transaction encoding (rawTx field)
- **Metadata extensibility** — txMetadata and outputMetadata are arbitrary strings; protocols define their own formats

## Common pitfalls

1. **Storage method signatures** — All async; must be properly implemented to avoid data races
2. **Graph ID format** — Must be `txid.outputIndex` (colon-separated)
3. **findNeededInputs return** — Return `undefined` if no inputs needed; empty object `{}` may cause issues
4. **Metadata recursion** — If requesting metadata, use carefully to avoid bloat
5. **Version mismatch** — If remote runs different GASP version, sync fails with error
6. **Graph validation must throw** — If invalid, `validateGraphAnchor()` must throw; returning gracefully doesn't stop sync
7. **Unidirectional limitation** — Don't call `submitNode()` in unidirectional mode; remote won't process
8. **Sequential overhead** — Sequential mode slower; use only if parallel causes DB locking

## Related packages

- [@bsv/overlay](./overlay.md) — Uses OverlayGASPStorage and OverlayGASPRemote adapters for GASP integration
- [@bsv/overlay-express](./overlay-express.md) — Configure GASP sync via `configureEnableGASPSync()`
- [@bsv/overlay-discovery-services](./overlay-discovery-services.md) — Can discover remote GASP peers via SHIP/SLAP
- [@bsv/sdk](https://github.com/bsv-blockchain/ts-sdk) — Transaction encoding/decoding

## Reference

- [API reference (TypeDoc)](https://bsv-blockchain.github.io/ts-stack/api/gasp/)
- [Source on GitHub](https://github.com/bsv-blockchain/gasp)
- [npm](https://www.npmjs.com/package/@bsv/gasp)
