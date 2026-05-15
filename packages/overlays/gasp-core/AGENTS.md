# CLAUDE.md — @bsv/gasp

## Purpose

Graph Aware Sync Protocol (GASP) — a powerful protocol for synchronizing BSV transaction data between two or more parties. Enables incremental building of transaction ancestry/descendancy graphs, ensuring legitimacy via SPV, completeness through recursive input fetching, and efficiency by minimizing bandwidth.

## Public API surface

From `mod.ts` (re-exports from `src/GASP.ts`):

**Main class:**
- `GASP` — Orchestrator for graph-aware sync
  - Constructor: `new GASP(storage, remote, lastInteraction?, logPrefix?, log?, unidirectional?, logLevel?, sequential?)`
  - Methods: `sync()` → `Promise<void>`

**Interfaces:**
- `GASPStorage` — Local database layer for UTXOs, transactions, metadata, graph management
  - `findKnownUTXOs(since, limit?)` → `Promise<GASPOutput[]>`
  - `hydrateGASPNode(graphID, txid, outputIndex, metadata)` → `Promise<GASPNode>`
  - `findNeededInputs(tx)` → `Promise<GASPNodeResponse | void>`
  - `appendToGraph(tx, spentBy?)` → `Promise<void>`
  - `validateGraphAnchor(graphID)` → `Promise<void>`
  - `discardGraph(graphID)` → `Promise<void>`
  - `finalizeGraph(graphID)` → `Promise<void>`

- `GASPRemote` — Communication with remote GASP peers
  - `getInitialResponse(request)` → `Promise<GASPInitialResponse>`
  - `getInitialReply(response)` → `Promise<GASPInitialReply>`
  - `requestNode(graphID, txid, outputIndex, metadata)` → `Promise<GASPNode>`
  - `submitNode(node)` → `Promise<GASPNodeResponse | void>`

**Types:**
- `GASPInitialRequest` — { version, since, limit? }
- `GASPInitialResponse` — { UTXOList, since }
- `GASPInitialReply` — { UTXOList }
- `GASPOutput` — { txid, outputIndex, score }
- `GASPNode` — { graphID, rawTx, outputIndex, proof?, txMetadata?, outputMetadata?, inputs? }
- `GASPNodeResponse` — { requestedInputs: { txid.index: { metadata: boolean } } }

**Enums/Constants:**
- `LogLevel` — { ERROR, WARN, INFO, DEBUG }
- `GASPVersionMismatchError` — Custom error for version conflicts

## Real usage patterns

From README examples:

```typescript
// 1. Implement GASPStorage
import { GASPStorage, GASPNode, GASPNodeResponse } from '@bsv/gasp'

class MyCustomStorage implements GASPStorage {
  async findKnownUTXOs(since: number, limit?: number) {
    // Return array of unspent TXID-outputIndices since timestamp
    return [
      { txid: 'abc...', outputIndex: 0, score: Date.now() },
      { txid: 'def...', outputIndex: 1, score: Date.now() }
    ]
  }

  async hydrateGASPNode(graphID, txid, outputIndex, metadata) {
    // Return the GASPNode with rawTx, proof, metadata, etc.
    return {
      graphID,
      rawTx: '0100...', // hex-encoded transaction
      outputIndex,
      proof: 'BUMP_proof...', // optional Merkle proof
      txMetadata: 'custom_tx_data',
      outputMetadata: 'custom_output_data'
    }
  }

  async findNeededInputs(tx: GASPNode): Promise<GASPNodeResponse | void> {
    // Optionally request more inputs if needed
    if (tx.outputMetadata?.includes('magic')) {
      return {
        requestedInputs: {
          'some_txid.0': { metadata: true },
          'some_txid.1': { metadata: false }
        }
      }
    }
    // If none needed, return undefined
  }

  async appendToGraph(tx, spentBy?) {
    // Store node in temporary graph structure
  }

  async validateGraphAnchor(graphID) {
    // Confirm graph is anchored in blockchain or otherwise valid
    // Throw if validation fails
  }

  async discardGraph(graphID) {
    // Discard invalid graph
  }

  async finalizeGraph(graphID) {
    // Finalize validated graph into persistent storage
  }
}

// 2. Implement GASPRemote
import { GASPRemote, GASPInitialRequest, GASPInitialResponse } from '@bsv/gasp'

class MyRemote implements GASPRemote {
  async getInitialResponse(request: GASPInitialRequest) {
    // Call remote peer via HTTP/WS and return their UTXO list
    const response = await fetch('https://peer.example.com/gasp/initial', {
      method: 'POST',
      body: JSON.stringify(request)
    })
    return response.json()
  }

  async getInitialReply(response: GASPInitialResponse) {
    // Bidirectional sync: get reply from remote
    const reply = await fetch('https://peer.example.com/gasp/reply', {
      method: 'POST',
      body: JSON.stringify(response)
    })
    return reply.json()
  }

  async requestNode(graphID, txid, outputIndex, metadata) {
    // Request a specific node from remote
    const response = await fetch('https://peer.example.com/gasp/node', {
      method: 'POST',
      body: JSON.stringify({ graphID, txid, outputIndex, metadata })
    })
    return response.json()
  }

  async submitNode(node) {
    // Push node to remote; remote may request additional inputs
    const response = await fetch('https://peer.example.com/gasp/submit', {
      method: 'POST',
      body: JSON.stringify(node)
    })
    return response.json()
  }
}

// 3. Initialize and sync
import { GASP, LogLevel } from '@bsv/gasp'

const myStorage = new MyCustomStorage()
const myRemote = new MyRemote()

const gasp = new GASP(
  myStorage,
  myRemote,
  0,                    // lastInteraction (UNIX seconds)
  '[GASP] ',            // logPrefix
  false,                // legacy log toggle
  false,                // unidirectional? false = bidirectional
  LogLevel.INFO,        // logLevel
  false                 // sequential? false = parallel operations
)

await gasp.sync()
console.log('GASP sync complete!')

// 4. Unidirectional (pull-only) sync
const gaspPullOnly = new GASP(
  myStorage,
  myRemote,
  0,
  '[GASP-Pull] ',
  false,
  true,  // unidirectional = true (pull only, no push)
  LogLevel.DEBUG,
  false
)

await gaspPullOnly.sync()
// Local storage updated with remote UTXOs, but remote sees no data from us

// 5. Sequential (DB-lock-safe) sync
const gaspSequential = new GASP(
  myStorage,
  myRemote,
  0,
  '[GASP-Sequential] ',
  false,
  false,
  LogLevel.WARN,
  true   // sequential = true (one operation at a time)
)

await gaspSequential.sync()
```

## Key concepts

- **Graph Aware Sync**: Unlike "UTXO list" sync, GASP recursively fetches transaction ancestors and descendants, building a validated transaction graph
- **Legitimacy**: Uses Merkle proofs (BUMP), script validation, and SPV rules to ensure only valid data is finalized
- **Completeness**: Recursively requests needed inputs until graph is complete or remote has no more data
- **Efficiency**: Only fetches data not already known; minimizes bandwidth by selective requests
- **Metadata support**: Each transaction/output can carry custom metadata (e.g., invoice data, topical membership); recursively propagated
- **Unidirectional mode**: "Pull only" from remote; useful for SPV clients that don't publish data
- **Sequential vs Parallel**: Parallel (default) uses Promise.all for speed; Sequential uses one-at-a-time to avoid DB locking
- **Graph ID**: Unique identifier for a transaction graph; typically TXID.outputIndex of the tip UTXO
- **BUMP proof**: Merkle proof anchoring a transaction in a block; optional but recommended for SPV validation

## Dependencies

**Runtime:**
- `@bsv/sdk` — Transaction, utils for encoding/decoding

**Dev:**
- jest, ts-jest, typescript, ts-standard

## Common pitfalls / gotchas

1. **Storage method signatures**: All async; must be properly implemented to avoid data races
2. **Graph ID format**: Must be `txid.outputIndex` (36-byte format, colon-separated)
3. **findNeededInputs return**: Return `undefined` if no inputs needed; returning empty object `{}` may cause unexpected behavior
4. **Metadata recursion**: If you request metadata, inputs' metadata hashes are returned; use carefully to avoid bloat
5. **Version mismatch**: If remote runs different GASP version, sync fails with GASPVersionMismatchError
6. **Graph validation must throw**: If graph is invalid, `validateGraphAnchor()` must throw; returning gracefully doesn't stop sync
7. **Unidirectional limitation**: In unidirectional mode, don't call `submitNode()`; remote won't receive or process it
8. **Sequential overhead**: Sequential mode is slower; use only if parallel operations cause DB locking

## Spec conformance

- **Graph Aware Sync Protocol**: GASP version 1 (from mod.ts)
- **Merkle proof integration**: Supports BUMP (Merkle proof) for SPV validation
- **Transaction format**: Uses raw hex transaction encoding (rawTx field)
- **Metadata extensibility**: txMetadata and outputMetadata are arbitrary strings; protocols can define their own formats

## File map

```
src/
└── GASP.ts              — Main GASP class and type definitions
    ├── GASPInitialRequest
    ├── GASPInitialResponse
    ├── GASPInitialReply
    ├── GASPOutput
    ├── GASPNode
    ├── GASPNodeResponse
    ├── GASPStorage (interface)
    ├── GASPRemote (interface)
    ├── GASP (class)
    ├── LogLevel (enum)
    └── GASPVersionMismatchError
```

## Integration points

- **@bsv/overlay Engine**: Uses OverlayGASPStorage and OverlayGASPRemote (adapters) to sync with other overlay services
- **@bsv/overlay-express**: Can configure GASP sync via `configureEnableGASPSync()`; disabled by default in development
- **Custom storage backends**: Implement GASPStorage for any persistence layer (SQL, NoSQL, files, etc.)
- **Custom remotes**: Implement GASPRemote for any transport (HTTP, WebSocket, in-process, etc.)
- **SHIP/SLAP discovery**: Can discover remote GASP peers via SHIP/SLAP before initiating sync
