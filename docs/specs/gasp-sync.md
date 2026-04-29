---
id: spec-gasp-sync
title: GASP — Graph Aware Sync Protocol
kind: spec
version: "1.0.0"
last_updated: "2026-04-28"
last_verified: "2026-04-28"
status: stable
tags: ["spec", "sync", "overlay", "gasp"]
---

# GASP — Graph Aware Sync Protocol

> GASP enables two overlay nodes to efficiently synchronize transaction state by walking the transaction graph together. Instead of broadcasting individual transactions, nodes exchange UTXO lists, then request only missing transaction ancestry and descendancy. Merkle proof validation ensures legitimacy without trusting peers.

## At a glance

| Field | Value |
|---|---|
| Format | AsyncAPI 3.0 |
| Version | 1.0.0 |
| Status | stable |
| Implementations | @bsv/gasp-core |

## What problem this solves

**Efficient state sync between overlay nodes**. When two overlay nodes meet, they need to exchange their UTXO sets so they have consistent state. Broadcasting every transaction is slow. GASP exchanges UTXO lists first, then each node requests only the inputs it's missing, walking the transaction graph backward until all dependencies are satisfied.

**Completeness verification**. Nodes can prove they have a complete, unbroken transaction history from some anchor point (e.g., a confirmed block) back to inputs. If a peer claims to have a UTXO but can't provide its full ancestry, the node rejects it.

**Bidirectional and unidirectional modes**. Nodes can sync in both directions (both exchange missing UTXOs) or one-way (only one side sends). This supports various topologies: hub-and-spoke (spoke only receives), peer-to-peer (both ways), etc.

## Protocol overview

**Four-phase synchronization** (if bidirectional):

**Phase 1 — Initial Request/Response**

1. **Initiator → Responder** `GASPInitialRequest`
   - Initiator's UTXO list (everything it knows)
   - Timestamp (`since`) — initiator wants UTXOs from responder created after this time
   - Limit (max UTXOs to return)

2. **Responder → Initiator** `GASPInitialResponse`
   - Responder's UTXO list (what initiator is missing)
   - Responder's `since` timestamp (what it wants from initiator)

**Phase 2 — Initial Reply (bidirectional only)**

3. **Initiator → Responder** `GASPInitialReply`
   - UTXOs that responder is missing (based on responder's `since` timestamp)

**Phase 3 & 4 — Graph Walking**

For each UTXO the peer is missing, request the full transaction and ancestry:

4. **Either party → Peer** `GASPNodeRequest`
   - `graphID` — unique identifier for this sync session
   - `txid`, `outputIndex` — UTXO to request
   - `metadata` — optional custom data

5. **Peer → Requester** `GASPNode`
   - Raw transaction hex
   - Output index
   - Merkle proof (if available)
   - Transaction metadata
   - Input requirements (what inputs does this transaction need?)

If the transaction has inputs the requester doesn't have, it requests those too (recursive graph walk). Continue until all dependencies are satisfied.

6. **Requester → Peer** `GASPNodeResponse`
   - If more inputs are needed: list of input txids to request
   - Or completion signal

## Key types / channels

| Channel | Direction | Message Type | Purpose |
|---------|-----------|--------------|---------|
| `gasp/initialRequest` | Send | `GASPInitialRequest` | Initiator sends UTXO list and `since` timestamp |
| `gasp/initialResponse` | Receive | `GASPInitialResponse` | Responder sends UTXO list and its `since` |
| `gasp/initialReply` | Send | `GASPInitialReply` | Initiator sends missing UTXOs (bidirectional mode) |
| `gasp/requestNode` | Bidirectional | `GASPNodeRequest` | Request a transaction and its inputs |
| `gasp/node` | Bidirectional | `GASPNode` | Respond with transaction data |
| `gasp/nodeResponse` | Bidirectional | `GASPNodeResponse` | Confirm receipt; request more inputs if needed |

## Example: Sync two overlay nodes

```typescript
import { GASP } from '@bsv/gasp-core'

// 1. Implement storage interface
class MyStorage implements GASPStorage {
  async findKnownUTXOs(since: number, limit?: number) {
    // Return all UTXOs created after `since`
    return [
      { txid: 'abc...', outputIndex: 0, score: Date.now() },
      { txid: 'def...', outputIndex: 1, score: Date.now() }
    ]
  }
  
  async hydrateGASPNode(graphID, txid, outputIndex, metadata) {
    // Return the transaction and proof
    return {
      graphID,
      rawTx: await getTransactionHex(txid),
      outputIndex,
      proof: await getMerkleProof(txid),
      txMetadata: {}
    }
  }
  
  // ... implement other methods ...
}

// 2. Implement remote peer interface
class MyRemote implements GASPRemote {
  async getInitialResponse(request: GASPInitialRequest) {
    // Send request to peer, receive response
    const response = await fetch(`https://peer.example.com/gasp/initial`, {
      method: 'POST',
      body: JSON.stringify(request)
    })
    return response.json()
  }
  
  // ... implement other methods ...
}

// 3. Run sync
const storage = new MyStorage()
const remote = new MyRemote()
const gasp = new GASP(storage, remote)

await gasp.sync()
console.log('Sync complete; state is now consistent with peer')
```

## Conformance vectors

GASP conformance is tested in `conformance/vectors/sync/gasp/`:

- UTXO list exchange and deduplication
- Graph walking (recursive input resolution)
- Merkle proof validation
- Phase ordering (initial before graph walk)
- Bidirectional vs. unidirectional modes
- Anchor validation (transactions must connect to confirmed blocks)

## Implementations in ts-stack

| Package | Notes |
|---------|-------|
| @bsv/gasp-core | Core GASP protocol implementation; orchestrates graph walking, validates proofs, manages sync state |
| @bsv/overlay | Integrates GASP for syncing state between overlay nodes |

## Related specs

- [Overlay HTTP](./overlay-http.md) — HTTP surface that can trigger GASP sync
- [BRC-95 / BRC-62](../../../docs/BRCs/transactions/0095.md) — Transaction and proof formats

## Spec artifact

[gasp-asyncapi.yaml](https://github.com/bsv-blockchain/ts-stack/blob/main/specs/sync/gasp-asyncapi.yaml)
