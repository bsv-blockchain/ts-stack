# API

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Types](#types)

## Interfaces

| |
| --- |
| [GASPRemote](#interface-gaspremote) |
| [GASPStorage](#interface-gaspstorage) |

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Types](#types)

---

### Interface: GASPRemote

The communications mechanism between a local GASP instance and a foreign GASP instance.

```ts
export interface GASPRemote {
    getInitialResponse: (request: GASPInitialRequest) => Promise<GASPInitialResponse>;
    getInitialReply: (response: GASPInitialResponse) => Promise<GASPInitialReply>;
    requestNode: (graphID: string, txid: string, outputIndex: number, metadata: boolean) => Promise<GASPNode>;
    submitNode: (node: GASPNode) => Promise<GASPNodeResponse | void>;
}
```

See also: [GASPInitialReply](#type-gaspinitialreply), [GASPInitialRequest](#type-gaspinitialrequest), [GASPInitialResponse](#type-gaspinitialresponse), [GASPNode](#type-gaspnode), [GASPNodeResponse](#type-gaspnoderesponse)

<details>

<summary>Interface GASPRemote Details</summary>

#### Property getInitialReply

Given an outgoing initial response, obtain the reply from the foreign instance.

```ts
getInitialReply: (response: GASPInitialResponse) => Promise<GASPInitialReply>
```
See also: [GASPInitialReply](#type-gaspinitialreply), [GASPInitialResponse](#type-gaspinitialresponse)

#### Property getInitialResponse

Given an outgoing initial request, send the request to the foreign instance and obtain their initial response.

```ts
getInitialResponse: (request: GASPInitialRequest) => Promise<GASPInitialResponse>
```
See also: [GASPInitialRequest](#type-gaspinitialrequest), [GASPInitialResponse](#type-gaspinitialresponse)

#### Property requestNode

Given an outgoing txid, outputIndex and optional metadata, request the associated GASP node from the foreign instane.

```ts
requestNode: (graphID: string, txid: string, outputIndex: number, metadata: boolean) => Promise<GASPNode>
```
See also: [GASPNode](#type-gaspnode)

#### Property submitNode

Given an outgoing node, send the node to the foreign instance and determine which additional inputs (if any) they request in response.

```ts
submitNode: (node: GASPNode) => Promise<GASPNodeResponse | void>
```
See also: [GASPNode](#type-gaspnode), [GASPNodeResponse](#type-gaspnoderesponse)

</details>

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Types](#types)

---
### Interface: GASPStorage

Facilitates the finding of UTXOs, determination of needed inputs, temporary graph management, and eventual graph finalization.

```ts
export interface GASPStorage {
    findKnownUTXOs: (since: number) => Promise<Array<{
        txid: string;
        outputIndex: number;
    }>>;
    hydrateGASPNode: (graphID: string, txid: string, outputIndex: number, metadata: boolean) => Promise<GASPNode>;
    findNeededInputs: (tx: GASPNode) => Promise<GASPNodeResponse | void>;
    appendToGraph: (tx: GASPNode, spentBy?: string) => Promise<void>;
    validateGraphAnchor: (graphID: string) => Promise<void>;
    discardGraph: (graphID: string) => Promise<void>;
    finalizeGraph: (graphID: string) => Promise<void>;
}
```

See also: [GASPNode](#type-gaspnode), [GASPNodeResponse](#type-gaspnoderesponse)

<details>

<summary>Interface GASPStorage Details</summary>

#### Property appendToGraph

Appends a new node to a temporary graph.

```ts
appendToGraph: (tx: GASPNode, spentBy?: string) => Promise<void>
```
See also: [GASPNode](#type-gaspnode)

#### Property discardGraph

Deletes all data associated with a temporary graph that has failed to sync, if the graph exists.

```ts
discardGraph: (graphID: string) => Promise<void>
```

#### Property finalizeGraph

Finalizes a graph, solidifying the new UTXO and its ancestors so that it will appear in the list of known UTXOs.

```ts
finalizeGraph: (graphID: string) => Promise<void>
```

#### Property findKnownUTXOs

Returns an array of transaction outpoints that are currently known to be unspent (given an optional timestamp).
Non-confirmed (non-timestamped) outputs should always be returned, regardless of the timestamp.

```ts
findKnownUTXOs: (since: number) => Promise<Array<{
    txid: string;
    outputIndex: number;
}>>
```

#### Property findNeededInputs

For a given node, returns the inputs needed to complete the graph, including whether updated metadata is requested for those inputs.

```ts
findNeededInputs: (tx: GASPNode) => Promise<GASPNodeResponse | void>
```
See also: [GASPNode](#type-gaspnode), [GASPNodeResponse](#type-gaspnoderesponse)

#### Property hydrateGASPNode

For a given txid and output index, returns the associated transaction, a merkle proof if the transaction is in a block, and metadata if if requested. If no metadata is requested, metadata hashes on inputs are not returned.

```ts
hydrateGASPNode: (graphID: string, txid: string, outputIndex: number, metadata: boolean) => Promise<GASPNode>
```
See also: [GASPNode](#type-gaspnode)

#### Property validateGraphAnchor

Checks whether the given graph, in its current state, makes reference only to transactions that are proven in the blockchain, or already known by the recipient to be valid.

```ts
validateGraphAnchor: (graphID: string) => Promise<void>
```

</details>

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Types](#types)

---
## Classes

| |
| --- |
| [GASP](#class-gasp) |
| [GASPVersionMismatchError](#class-gaspversionmismatcherror) |

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Types](#types)

---

### Class: GASP

Main class implementing the Graph Aware Sync Protocol.

```ts
export class GASP implements GASPRemote {
    version: number;
    storage: GASPStorage;
    remote: GASPRemote;
    lastInteraction: number;
    logPrefix: string;
    log: boolean;
    unidirectional: boolean;
    constructor(storage: GASPStorage, remote: GASPRemote, lastInteraction = 0, logPrefix = "[GASP] ", log = false, unidirectional = false) 
    async sync(): Promise<void> 
    async buildInitialRequest(since: number): Promise<GASPInitialRequest> 
    async getInitialResponse(request: GASPInitialRequest): Promise<GASPInitialResponse> 
    async getInitialReply(response: GASPInitialResponse): Promise<GASPInitialReply> 
    async requestNode(graphID: string, txid: string, outputIndex: number, metadata: boolean): Promise<GASPNode> 
    async submitNode(node: GASPNode): Promise<GASPNodeResponse | void> 
    async completeGraph(graphID: string): Promise<void> 
}
```

See also: [GASPInitialReply](#type-gaspinitialreply), [GASPInitialRequest](#type-gaspinitialrequest), [GASPInitialResponse](#type-gaspinitialresponse), [GASPNode](#type-gaspnode), [GASPNodeResponse](#type-gaspnoderesponse), [GASPRemote](#interface-gaspremote), [GASPStorage](#interface-gaspstorage)

<details>

<summary>Class GASP Details</summary>

#### Constructor

```ts
constructor(storage: GASPStorage, remote: GASPRemote, lastInteraction = 0, logPrefix = "[GASP] ", log = false, unidirectional = false) 
```
See also: [GASPRemote](#interface-gaspremote), [GASPStorage](#interface-gaspstorage)

Argument Details

+ **storage**
  + The GASP Storage interface to use
+ **remote**
  + The GASP Remote interface to use
+ **lastInteraction**
  + The timestamp when we last interacted with this remote party
+ **logPrefix**
  + Optional prefix for log messages
+ **log**
  + Whether to log messages
+ **unidirectional**
  + Whether to disable the "reply" side and do pull-only

#### Method buildInitialRequest

Builds the initial request for the sync process.

```ts
async buildInitialRequest(since: number): Promise<GASPInitialRequest> 
```
See also: [GASPInitialRequest](#type-gaspinitialrequest)

Returns

A promise for the initial request object.

#### Method completeGraph

Handles the completion of a newly-synced graph

```ts
async completeGraph(graphID: string): Promise<void> 
```

Argument Details

+ **graphID**
  + The ID of the newly-synced graph

#### Method getInitialReply

Builds the initial reply based on the received response.

```ts
async getInitialReply(response: GASPInitialResponse): Promise<GASPInitialReply> 
```
See also: [GASPInitialReply](#type-gaspinitialreply), [GASPInitialResponse](#type-gaspinitialresponse)

Returns

A promise for an initial reply

Argument Details

+ **response**
  + The initial response object.

#### Method getInitialResponse

Builds the initial response based on the received request.

```ts
async getInitialResponse(request: GASPInitialRequest): Promise<GASPInitialResponse> 
```
See also: [GASPInitialRequest](#type-gaspinitialrequest), [GASPInitialResponse](#type-gaspinitialresponse)

Returns

A promise for an initial response

Argument Details

+ **request**
  + The initial request object.

#### Method requestNode

Provides a requested node to a foreign instance who requested it.

```ts
async requestNode(graphID: string, txid: string, outputIndex: number, metadata: boolean): Promise<GASPNode> 
```
See also: [GASPNode](#type-gaspnode)

#### Method submitNode

Provides a set of inputs we care about after processing a new incoming node.
Also finalizes or discards a graph if no additional data is requested from the foreign instance.

```ts
async submitNode(node: GASPNode): Promise<GASPNodeResponse | void> 
```
See also: [GASPNode](#type-gaspnode), [GASPNodeResponse](#type-gaspnoderesponse)

#### Method sync

Synchronizes the transaction data between the local and remote participants.

```ts
async sync(): Promise<void> 
```

</details>

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Types](#types)

---
### Class: GASPVersionMismatchError

```ts
export class GASPVersionMismatchError extends Error {
    code: "ERR_GASP_VERSION_MISMATCH";
    currentVersion: number;
    foreignVersion: number;
    constructor(message: string, currentVersion: number, foreignVersion: number) 
}
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Types](#types)

---
## Types

| |
| --- |
| [GASPInitialReply](#type-gaspinitialreply) |
| [GASPInitialRequest](#type-gaspinitialrequest) |
| [GASPInitialResponse](#type-gaspinitialresponse) |
| [GASPNode](#type-gaspnode) |
| [GASPNodeResponse](#type-gaspnoderesponse) |

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Types](#types)

---

### Type: GASPInitialReply

Represents the subsequent message sent in reply to the initial response.

```ts
export type GASPInitialReply = {
    UTXOList: Array<{
        txid: string;
        outputIndex: number;
    }>;
}
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Types](#types)

---
### Type: GASPInitialRequest

Represents the initial request made under the Graph Aware Sync Protocol.

```ts
export type GASPInitialRequest = {
    version: number;
    since: number;
}
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Types](#types)

---
### Type: GASPInitialResponse

Represents the initial response made under the Graph Aware Sync Protocol.

```ts
export type GASPInitialResponse = {
    UTXOList: Array<{
        txid: string;
        outputIndex: number;
    }>;
    since: number;
}
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Types](#types)

---
### Type: GASPNode

Represents an output, its encompassing transaction, and the associated metadata, together with references to inputs and their metadata.

```ts
export type GASPNode = {
    graphID: string;
    rawTx: string;
    outputIndex: number;
    proof?: string;
    txMetadata?: string;
    outputMetadata?: string;
    inputs?: Record<string, {
        hash: string;
    }>;
}
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Types](#types)

---
### Type: GASPNodeResponse

Denotes which input transactions are requested, and whether metadata needs to be sent.

```ts
export type GASPNodeResponse = {
    requestedInputs: Record<string, {
        metadata: boolean;
    }>;
}
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Types](#types)

---
