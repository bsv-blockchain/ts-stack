# GASP — Graph Aware Sync Protocol

The **Graph Aware Sync Protocol** (GASP) is a powerful protocol for synchronizing BSV transaction data between two or more parties. Unlike simplistic “UTXO list” or “transaction pushing” mechanisms, GASP allows each participant to incrementally build a *graph* of transaction ancestors and descendants. This ensures:

1. **Legitimacy**: Parties only finalize data they can validate, using Merkle proofs, script evaluation, and the other rules of SPV.  
2. **Completeness**: Recursively, each party pulls in the inputs needed to prove correctness—avoiding partial or “broken” transaction data.  
3. **Efficiency**: Each participant only fetches and transmits data it *doesn’t* already have, minimizing bandwidth.  
4. **Flexibility**: Custom storage, custom remote mechanisms, **unidirectional** sync, concurrency options, and more.

## Table of Contents

- [Key Features](#key-features)  
- [How it Works](#how-it-works)  
- [Installation](#installation)  
- [Quick Start](#quick-start)  
  - [1. Implement the \`GASPStorage\` Interface](#1-implement-the-gaspstorage-interface)  
  - [2. Implement (or Obtain) a \`GASPRemote\`](#2-implement-or-obtain-a-gaspremote)  
  - [3. Initialize and Sync](#3-initialize-and-sync)  
- [Examples](#examples)  
  - [Minimal Example](#minimal-example)  
  - [Advanced Example: \`sequential\` and Log Levels](#advanced-example-sequential-and-log-levels)  
  - [Unidirectional Pull-Only Sync](#unidirectional-pull-only-sync)  
  - [Dealing With “Deep” Transactions and Metadata](#dealing-with-deep-transactions-and-metadata)  
- [Testing and Verification](#testing-and-verification)  
- [Useful Links](#useful-links)  
- [License](#license)  

---

## Key Features

- **Recursive Sync**: Fetches only the needed transaction outputs and *recursively* fetches input data on demand.  
- **Metadata Support**: Optionally exchange metadata (e.g., invoice data, descriptions, basket or topical membership, etc.) for each transaction or output.  
- **Proof Anchoring**: Merkle proofs can be attached to each transaction, ensuring on-chain verifiability.  
- **Unidirectional**: If desired, you can configure “pull only” mode—where you fetch data from a remote but never push your own.  
- **Selective Concurrency**: Use fully parallel fetches (`Promise.all`) or sequential fetches (one at a time) to avoid potential DB locking.  
- **Flexible Integration**: The `GASPStorage` and `GASPRemote` interfaces let you integrate with your own storage logic or remote transport.

---

## How it Works

1. **Initial Request**: One peer initiates a request, including a timestamp for when the two parties last synchronized.  
2. **Initial Response**: The other peer returns a set of UTXOs that it has observed since that timestamp, plus a “since” timestamp for a potential “reply.”  
3. **Recursive Graph Building**:  
   - Each side requests the transaction data (optionally including metadata) for each unknown UTXO.  
   - Each newly-received transaction might contain additional unknown inputs, which triggers further fetches.  
4. **Graph Finalization**: Once all required inputs are fetched, each peer finalizes the newly-validated transaction data into its own store.  
5. **Optional “Reply”**: In a **bidirectional** scenario, the second peer then does the same, ensuring both end up with a consistent set of data.  

If you set GASP to **unidirectional**, step 5 is skipped: your local node simply pulls data from the remote, but never sends data back.

---

## Installation

```bash
npm i @bsv/gasp
```

Or, if you use `yarn`:

```bash
yarn add @bsv/gasp
```

---

## Quick Start

Below is a bare-bones recipe to get GASP up and running.

### 1. Implement the `GASPStorage` Interface

The **GASPStorage** interface is your local “database layer.” It controls how you store UTXOs, how you retrieve them, and how you handle partial transaction graphs.

```ts
import { GASPNode, GASPNodeResponse, GASPStorage } from '@bsv/gasp'

export class MyCustomStorage implements GASPStorage {
  async findKnownUTXOs(since: number) { /* return an array of unspent TXID-outputIndices since `since` timestamp */ }
  async hydrateGASPNode(graphID: string, txid: string, outputIndex: number, metadata: boolean) { /* return the GASPNode with rawTx, proof, metadata, etc. */ }
  async findNeededInputs(tx: GASPNode): Promise<GASPNodeResponse | void> { /* optionally request more inputs if needed*/ }
  async appendToGraph(tx: GASPNode, spentBy?: string) { /* store the node in some temporary graph structure*/ }
  async validateGraphAnchor(graphID: string) { /* confirm the graph is anchored in the blockchain or otherwise valid*/ }
  async discardGraph(graphID: string) { /* if invalid, discard it */ }
  async finalizeGraph(graphID: string) { /* finalize the validated graph into local storage*/ }
}
```

### 2. Implement (or Obtain) a `GASPRemote`

A **GASPRemote** is how you communicate with a **remote** GASP peer. You can implement your own HTTP fetch logic, use a WebSocket-based approach, or even run everything in the same process for testing.

```ts
import { GASPRemote, GASPNode, GASPInitialRequest, GASPInitialResponse } from '@bsv/gasp'

export class MyRemote implements GASPRemote {
  async getInitialResponse(request: GASPInitialRequest): Promise<GASPInitialResponse> {
    // Call remote peer and return their data
    // ...
  }
  async getInitialReply(response: GASPInitialResponse) {
    // Only needed if doing bidirectional sync
    // ...
  }
  async requestNode(graphID: string, txid: string, outputIndex: number, metadata: boolean): Promise<GASPNode> {
    // Request a node from the remote
    // ...
  }
  async submitNode(node: GASPNode) {
    // In a bidirectional sync, we push our node to the remote
    // ...
  }
}
```

### 3. Initialize and Sync

Finally, create the GASP instance, and call `sync()`:

```ts
import { GASP, LogLevel } from '@bsv/gasp'

// 1. Create your storage
const myStorage = new MyCustomStorage()

// 2. Create your remote (or re-use an existing GASP instance as the remote)
const myRemote = new MyRemote()

// 3. Instantiate GASP
const gasp = new GASP(
  myStorage,
  myRemote,
  /* lastInteraction= */ 0,
  /* logPrefix= */ '[GASP] ',
  /* log= */ false,            // legacy logging toggle
  /* unidirectional= */ false, // if true, we only fetch from the remote, never push data
  /* logLevel= */ LogLevel.INFO,
  /* sequential= */ false      // if true, tasks run one-at-a-time rather than in parallel
)

// 4. Trigger the sync
gasp.sync()
  .then(() => console.log('GASP sync complete!'))
  .catch(err => console.error('GASP sync error:', err))
```

---

## Examples

### Minimal Example

If you just want a quick demonstration of pulling data from a remote, you can see a short example **[in our tests](./src/__tests/GASP.test.ts)**. This code snippet demonstrates a super-simplified approach:

```ts
import { GASP } from '@bsv/gasp'

// ...Suppose we have minimal storage and remote classes from above...
const aliceStorage = new MyCustomStorage()
const bobRemote = new MyRemote()

// Create GASP instance
const aliceGASP = new GASP(aliceStorage, bobRemote)

// Run the sync
await aliceGASP.sync()
```

### Advanced Example: `sequential` and Log Levels

Sometimes, performing too many concurrent operations (e.g., writes to a database) can lead to locking issues. Also, you might want to control the verbosity of logs.

```ts
import { GASP, LogLevel } from '@bsv/gasp'

const gasp = new GASP(
  myStorage,                     // Implementation of GASPStorage
  myRemote,                      // Implementation of GASPRemote
  0,                             // lastInteraction timestamp
  '[GASP Demo] ',                // logPrefix
  false,                         // old boolean log toggle, for backwards-compat
  false,                         // unidirectional? No, do full sync
  LogLevel.DEBUG,                // Use DEBUG or WARN/ERROR
  true                           // sequential? If true, GASP will do tasks in sequence
)
await gasp.sync()
```

### Unidirectional Pull-Only Sync

You may only want to “pull” data from a remote server without uploading your own. This is common in “SPV client” use-cases.

```ts
// Alice sets unidirectional = true
// She only wants to receive data from Bob, not share her own data
const gaspAlice = new GASP(
  aliceStorage,
  bobRemote,
  0,
  '[GASP-Alice] ',
  false,
  true  // unidirectional is set to true
)
await gaspAlice.sync()

// Alice's local store is updated with Bob's UTXOs, but Bob sees no new data from Alice
```

### Dealing With “Deep” Transactions and Metadata

When a new transaction is received, GASP calls your `findNeededInputs(...)` method. If you require further data (e.g., to verify a scriptSig or a custom metadata field), simply return a `requestedInputs` object indicating which inputs you need. GASP will request them from the remote automatically.

```ts
async findNeededInputs(tx: GASPNode): Promise<GASPNodeResponse | void> {
  // Suppose any transaction with "magic" in the outputMetadata needs further inputs
  if (tx.outputMetadata?.includes('magic')) {
    return {
      requestedInputs: {
        // outpoint -> { metadata: boolean }
        'some_txid.0': { metadata: true },
        'some_txid.1': { metadata: false }
      }
    }
  }
  // If none needed, return undefined
}
```

Your remote peer’s `requestNode(...)` method will deliver these missing pieces, if they exist, ensuring a “deep” transaction graph is built.

---

## Useful Links

- **Comprehensive Tests**: The [test suite](./src/__tests/GASP.test.ts) covers everything from version mismatches to recursion edge cases.  
- **Real-World Integrations**: See the “OverlayGASPStorage” and “OverlayGASPRemote” classes (in the [Overlay Services](https://github.com/bitcoin-sv/overlay-services/tree/master/src/GASP) repo) for a real-world application.

---

## FAQ

1. **Does GASP handle conflicting transactions?**  
   GASP is *agnostic* about conflicts. It’s up to your `GASPStorage` implementation to decide how to handle double spends or conflicting states.

3. **How do I do only pure “SPV proof” validation?**  
   GASP includes optional Merkle proofs via the `proof` field. If your `validateGraphAnchor(...)` checks them, you effectively get SPV-level validation.

4. **What about specialized metadata or policies?**  
   GASP was *built* for that. Use `txMetadata`, `outputMetadata`, or `inputs` to store and propagate any custom data. Your code can then gather additional inputs if needed.

5. **What if a remote fails to provide data?**  
   GASP’s recursion stops. If you never receive inputs you request, you never finalize that transaction. This ensures consistent partial or full finalization.

---

## License

The license for the code in this repository is the Open BSV License.