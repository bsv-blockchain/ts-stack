# API

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

## Interfaces

| | | |
| --- | --- | --- |
| [ArcConfig](#interface-arcconfig) | [FetchOptions](#interface-fetchoptions) | [TransactionEvidence](#interface-transactionevidence) |
| [BdkVerifierInterface](#interface-bdkverifierinterface) | [HttpClient](#interface-httpclient) | [TransactionEvidenceContext](#interface-transactionevidencecontext) |
| [BdkVerifyScriptsParams](#interface-bdkverifyscriptsparams) | [HttpClientLimits](#interface-httpclientlimits) | [TransactionEvidenceCoordinatorOptions](#interface-transactionevidencecoordinatoroptions) |
| [BroadcastFailure](#interface-broadcastfailure) | [HttpClientRequestOptions](#interface-httpclientrequestoptions) | [TransactionEvidenceLimits](#interface-transactionevidencelimits) |
| [BroadcastResponse](#interface-broadcastresponse) | [HttpsModuleLike](#interface-httpsmodulelike) | [TransactionInput](#interface-transactioninput) |
| [Broadcaster](#interface-broadcaster) | [HttpsNodejs](#interface-httpsnodejs) | [TransactionOutput](#interface-transactionoutput) |
| [ChainTracker](#interface-chaintracker) | [MerklePathLeaf](#interface-merklepathleaf) | [VerifiedTransactionOutput](#interface-verifiedtransactionoutput) |
| [EvidenceCandidate](#interface-evidencecandidate) | [NodejsHttpClientRequest](#interface-nodejshttpclientrequest) | [WhatsOnChainConfig](#interface-whatsonchainconfig) |
| [EvidenceScriptScope](#interface-evidencescriptscope) | [NodejsRequestLike](#interface-nodejsrequestlike) |  |
| [FeeModel](#interface-feemodel) | [NormalizedArcConfig](#interface-normalizedarcconfig) |  |

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---

### Interface: ArcConfig

Configuration options for the ARC broadcaster.

```ts
export interface ArcConfig {
    apiKey?: string;
    httpClient?: HttpClient;
    deploymentId?: string;
    callbackUrl?: string;
    callbackToken?: string;
    headers?: Record<string, string>;
}
```

See also: [HttpClient](./transaction.md#interface-httpclient), [string](./remittance.md#function-string)

#### Property apiKey

Authentication token for the ARC API.

```ts
apiKey?: string
```
See also: [string](./remittance.md#function-string)

#### Property callbackToken

Access token sent to the configured notification callback.

```ts
callbackToken?: string
```
See also: [string](./remittance.md#function-string)

#### Property callbackUrl

Notification callback endpoint for proofs and double-spend notifications.

```ts
callbackUrl?: string
```
See also: [string](./remittance.md#function-string)

#### Property deploymentId

Deployment ID sent in the XDeployment-ID header.

```ts
deploymentId?: string
```
See also: [string](./remittance.md#function-string)

#### Property headers

Additional request headers, snapshotted when the broadcaster is constructed.

```ts
headers?: Record<string, string>
```
See also: [string](./remittance.md#function-string)

#### Property httpClient

The explicitly trusted HTTP adapter used to make provider requests.

```ts
httpClient?: HttpClient
```
See also: [HttpClient](./transaction.md#interface-httpclient)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: BdkVerifierInterface

A pluggable backend that verifies ALL input scripts of a single transaction.

Implementations (e.g.

```ts
export default interface BdkVerifierInterface {
    supportsMemoryLimit?: boolean;
    shouldVerifyScripts?: (params: BdkVerifyScriptsParams) => boolean;
    verifyScripts: (params: BdkVerifyScriptsParams) => Promise<boolean>;
    verifyScriptsBatch?: (params: readonly BdkVerifyScriptsParams[]) => Promise<boolean[]>;
}
```

See also: [BdkVerifyScriptsParams](./transaction.md#interface-bdkverifyscriptsparams)

#### Property shouldVerifyScripts

Optionally decide whether this backend should handle the transaction now.
Returning false preserves the SDK's synchronous JavaScript interpreter path.
Implementations can use this to avoid waiting for a cold optional backend.

```ts
shouldVerifyScripts?: (params: BdkVerifyScriptsParams) => boolean
```
See also: [BdkVerifyScriptsParams](./transaction.md#interface-bdkverifyscriptsparams)

#### Property supportsMemoryLimit

True only when this backend applies `params.memoryLimit` during script
execution. Backends that omit this capability are bypassed for calls with
an explicit memory limit.

```ts
supportsMemoryLimit?: boolean
```

#### Property verifyScripts

Verify all input scripts of `params.tx`.

```ts
verifyScripts: (params: BdkVerifyScriptsParams) => Promise<boolean>
```
See also: [BdkVerifyScriptsParams](./transaction.md#interface-bdkverifyscriptsparams)

#### Property verifyScriptsBatch

Verify several independent transactions in one backend scheduling pass.
Implementations may use packed native calls and worker-level parallelism.

```ts
verifyScriptsBatch?: (params: readonly BdkVerifyScriptsParams[]) => Promise<boolean[]>
```
See also: [BdkVerifyScriptsParams](./transaction.md#interface-bdkverifyscriptsparams)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: BdkVerifyScriptsParams

Parameters shared by script-verifier routing and execution.

```ts
export interface BdkVerifyScriptsParams {
    tx: Transaction;
    blockHeight: number;
    consensus: boolean;
    verifyFlags?: string | string[];
    memoryLimit?: number;
}
```

See also: [Transaction](./transaction.md#class-transaction), [string](./remittance.md#function-string)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: BroadcastFailure

Defines the structure of a failed broadcast response.

```ts
export interface BroadcastFailure {
    status: "error";
    code: string;
    txid?: string;
    description: string;
    more?: object;
}
```

See also: [string](./remittance.md#function-string)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: BroadcastResponse

Defines the structure of a successful broadcast response.

```ts
export interface BroadcastResponse {
    status: "success";
    txid: string;
    message: string;
    competingTxs?: string[];
}
```

See also: [string](./remittance.md#function-string)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: Broadcaster

Represents the interface for a transaction broadcaster.
This interface defines a standard method for broadcasting transactions.

```ts
export interface Broadcaster {
    broadcast: (transaction: Transaction) => Promise<BroadcastResponse | BroadcastFailure>;
    broadcastMany?: (txs: Transaction[]) => Promise<object[]>;
}
```

See also: [BroadcastFailure](./transaction.md#interface-broadcastfailure), [BroadcastResponse](./transaction.md#interface-broadcastresponse), [Transaction](./transaction.md#class-transaction)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: ChainTracker

The Chain Tracker is responsible for verifying the validity of a given Merkle root
for a specific block height within the blockchain.

Chain Trackers ensure the integrity of the blockchain by
validating new headers against the chain's history. They use accumulated
proof-of-work and protocol adherence as metrics to assess the legitimacy of blocks.

Example

```ts
const chainTracker = {
  isValidRootForHeight: async (root, height) => {
    // Implementation to check if the Merkle root is valid for the specified block height.
  }
 currentHeight: async () => {
    // Implementation to get the current block height.
  }
};
```

```ts
export default interface ChainTracker {
    isValidRootForHeight: (root: string, height: number, signal?: AbortSignal) => Promise<boolean>;
    currentHeight: (signal?: AbortSignal) => Promise<number>;
    getVerificationContext?: () => string | number;
    getVerificationContextToken?: (signal?: AbortSignal) => Promise<string>;
}
```

See also: [string](./remittance.md#function-string)

#### Property getVerificationContext

Optional trusted local provider/policy/recovery context. Change this value
when switching sources or resetting their state. It is not a canonical
chain snapshot: consumers must still check current canonical dependencies.
Implementations without cancellable I/O may ignore the optional signals.

```ts
getVerificationContext?: () => string | number
```
See also: [string](./remittance.md#function-string)

#### Property getVerificationContextToken

Optional fresh canonical context token from the trusted chain provider.
Include canonical block/tip identity and any available monotonic reorg or
reset epoch. Consumers compare tokens around asynchronous verification.
Two remote tip observations are not an atomic snapshot and cannot detect
an intervening transition back to the identical tip (ABA).

```ts
getVerificationContextToken?: (signal?: AbortSignal) => Promise<string>
```
See also: [string](./remittance.md#function-string)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: EvidenceCandidate

Internal owned candidate. Never constructed from a host's verification assertion.

```ts
export interface EvidenceCandidate {
    tx: Transaction;
    txid: string;
    receipt: string;
    byteLength: number;
    outputIndex: number;
    graphBinding: string;
}
```

See also: [Transaction](./transaction.md#class-transaction), [string](./remittance.md#function-string)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: EvidenceScriptScope

```ts
export interface EvidenceScriptScope {
    work: EvidenceScriptWork;
    signal: AbortSignal;
    check: () => void;
}
```

See also: [EvidenceScriptWork](./transaction.md#class-evidencescriptwork)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: FeeModel

Represents the interface for a transaction fee model.
This interface defines a standard method for computing a fee when given a transaction.

```ts
export default interface FeeModel {
    computeFee: (transaction: Transaction) => Promise<number>;
}
```

See also: [Transaction](./transaction.md#class-transaction)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: FetchOptions

An interface for configuration of the request to be passed to the fetch method
limited to options needed by ts-sdk.

```ts
export interface FetchOptions {
    method?: string;
    headers?: Record<string, string>;
    body?: string | null;
    redirect?: "error";
    signal?: AbortSignal;
}
```

See also: [string](./remittance.md#function-string)

#### Property body

An object or null to set request's body.

```ts
body?: string | null
```
See also: [string](./remittance.md#function-string)

#### Property headers

An object literal set request's headers.

```ts
headers?: Record<string, string>
```
See also: [string](./remittance.md#function-string)

#### Property method

A string to set request's method.

```ts
method?: string
```
See also: [string](./remittance.md#function-string)

#### Property redirect

Redirects are prohibited so credentials cannot escape the configured endpoint.

```ts
redirect?: "error"
```

#### Property signal

Cancels both the request and response-body read.

```ts
signal?: AbortSignal
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: HttpClient

An interface for HTTP client used to make HTTP requests.

```ts
export interface HttpClient {
    request: <T = any, D = any>(url: string, options: HttpClientRequestOptions<D>) => Promise<HttpClientResponse<T>>;
}
```

See also: [HttpClientRequestOptions](./transaction.md#interface-httpclientrequestoptions), [HttpClientResponse](./transaction.md#type-httpclientresponse), [string](./remittance.md#function-string)

#### Property request

Makes a request to the server.

```ts
request: <T = any, D = any>(url: string, options: HttpClientRequestOptions<D>) => Promise<HttpClientResponse<T>>
```
See also: [HttpClientRequestOptions](./transaction.md#interface-httpclientrequestoptions), [HttpClientResponse](./transaction.md#type-httpclientresponse), [string](./remittance.md#function-string)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: HttpClientLimits

```ts
export interface HttpClientLimits {
    maxResponseBytes?: number;
    timeoutMs?: number;
}
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: HttpClientRequestOptions

An interface for configuration of the request to be passed to the request method.

```ts
export interface HttpClientRequestOptions<Data = any> {
    method?: string;
    headers?: Record<string, string>;
    data?: Data;
    signal?: AbortSignal;
}
```

See also: [string](./remittance.md#function-string)

#### Property data

An object or null to set request's body.

```ts
data?: Data
```

#### Property headers

An object literal set request's headers.

```ts
headers?: Record<string, string>
```
See also: [string](./remittance.md#function-string)

#### Property method

A string to set request's method.

```ts
method?: string
```
See also: [string](./remittance.md#function-string)

#### Property signal

An optional AbortSignal to cancel the request, including by explicit timeout.

```ts
signal?: AbortSignal
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: HttpsModuleLike

Common interface for Node.js https modules

```ts
export interface HttpsModuleLike {
    request: (url: string, options: HttpClientRequestOptions, callback: (res: any) => void) => NodejsRequestLike;
}
```

See also: [HttpClientRequestOptions](./transaction.md#interface-httpclientrequestoptions), [NodejsRequestLike](./transaction.md#interface-nodejsrequestlike), [string](./remittance.md#function-string)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: HttpsNodejs

Node Https module interface limited to options needed by ts-sdk

```ts
export interface HttpsNodejs {
    request: (url: string, options: HttpClientRequestOptions, callback: (res: any) => void) => NodejsHttpClientRequest;
}
```

See also: [HttpClientRequestOptions](./transaction.md#interface-httpclientrequestoptions), [NodejsHttpClientRequest](./transaction.md#interface-nodejshttpclientrequest), [string](./remittance.md#function-string)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: MerklePathLeaf

```ts
export interface MerklePathLeaf {
    offset: number;
    hash?: string;
    txid?: boolean;
    duplicate?: boolean;
}
```

See also: [string](./remittance.md#function-string)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: NodejsHttpClientRequest

Nodejs result of the Node https.request call limited to options needed by ts-sdk

```ts
export interface NodejsHttpClientRequest {
    write: (chunk: string) => void;
    on: (event: string, callback: (data: any) => void) => void;
    end: () => void;
}
```

See also: [string](./remittance.md#function-string)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: NodejsRequestLike

Common interface for Node.js https module request objects

```ts
export interface NodejsRequestLike {
    write: (chunk: any) => void;
    on: (event: string, callback: (data: any) => void) => void;
    end: () => void;
    destroy?: (error?: Error) => void;
    setTimeout?: (milliseconds: number, callback: () => void) => unknown;
}
```

See also: [string](./remittance.md#function-string)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: NormalizedArcConfig

```ts
export interface NormalizedArcConfig {
    apiKey?: string;
    httpClient: HttpClient;
    deploymentId: string;
    callbackUrl?: string;
    callbackToken?: string;
    headers?: Readonly<Record<string, string>>;
}
```

See also: [HttpClient](./transaction.md#interface-httpclient), [string](./remittance.md#function-string)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: TransactionEvidence

Untrusted transaction evidence. The optional txid is only a consistency hint.

```ts
export interface TransactionEvidence {
    beef: number[];
    outputIndex: number;
    txid?: string;
}
```

See also: [string](./remittance.md#function-string)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: TransactionEvidenceContext

Caller-controlled trust configuration; never populate this from lookup metadata.

```ts
export interface TransactionEvidenceContext {
    chainTracker: ChainTracker;
    chainNamespace: string;
    policyId: string;
    verifier?: BdkVerifierInterface;
}
```

See also: [BdkVerifierInterface](./transaction.md#interface-bdkverifierinterface), [ChainTracker](./transaction.md#interface-chaintracker), [string](./remittance.md#function-string)

#### Property chainNamespace

Network/genesis identifier or an explicit application chain namespace.

```ts
chainNamespace: string
```
See also: [string](./remittance.md#function-string)

#### Property policyId

Semantic verification policy/backend version; change it when policy changes.

```ts
policyId: string
```
See also: [string](./remittance.md#function-string)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: TransactionEvidenceCoordinatorOptions

```ts
export interface TransactionEvidenceCoordinatorOptions extends TransactionEvidenceContext {
    limits?: Partial<TransactionEvidenceLimits>;
}
```

See also: [TransactionEvidenceContext](./transaction.md#interface-transactionevidencecontext), [TransactionEvidenceLimits](./transaction.md#interface-transactionevidencelimits)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: TransactionEvidenceLimits

Local admission policy, not consensus limits. Byte limits count serialized bytes.

```ts
export interface TransactionEvidenceLimits {
    candidateBytes: number;
    retainedBytes: number;
    transactions: number;
    inputs: number;
    scriptBytes: number;
    scriptMemoryBytes: number;
    candidatesPerTransaction: number;
    pendingTransactions: number;
    concurrentTransactions: number;
    pendingChainCalls: number;
    consumers: number;
    cacheEntries: number;
    cacheAgeMs: number;
    attemptTimeoutMs: number;
    requestTimeoutMs: number;
}
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: TransactionInput

Represents an input to a Bitcoin transaction.
This interface defines the structure and components required to construct
a transaction input in the Bitcoin blockchain.

Example

```ts
// Creating a simple transaction input
let txInput = {
  sourceTXID: '123abc...',
  sourceOutputIndex: 0,
  sequence: 0xFFFFFFFF
};

// Using an unlocking script template
txInput.unlockingScriptTemplate = {
  sign: async (tx, index) => { ... },
  estimateLength: async (tx, index) => { ... }
};
```

```ts
export default interface TransactionInput {
    sourceTransaction?: Transaction;
    sourceTXID?: string;
    sourceOutputIndex: number;
    unlockingScript?: UnlockingScript;
    unlockingScriptTemplate?: {
        sign: (tx: Transaction, inputIndex: number) => Promise<UnlockingScript>;
        estimateLength: (tx: Transaction, inputIndex: number) => Promise<number>;
    };
    sequence?: number;
}
```

See also: [Transaction](./transaction.md#class-transaction), [UnlockingScript](./script.md#class-unlockingscript), [sign](./compat.md#variable-sign), [string](./remittance.md#function-string)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: TransactionOutput

Represents an output in a Bitcoin transaction.
This interface defines the structure and components necessary to construct
a transaction output, which secures owned Bitcoins to be unlocked later.

Example

```ts
// Creating a simple transaction output
let txOutput = {
  satoshis: 1000,
  lockingScript: LockingScript.fromASM('OP_DUP OP_HASH160 ... OP_EQUALVERIFY OP_CHECKSIG'),
  change: false
};
```

```ts
export default interface TransactionOutput {
    satoshis?: number;
    lockingScript: LockingScript;
    change?: boolean;
}
```

See also: [LockingScript](./script.md#class-lockingscript)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: VerifiedTransactionOutput

Verified transaction inclusion/ancestry; no service relevance or unspentness claim.

```ts
export interface VerifiedTransactionOutput {
    readonly txid: string;
    readonly outputIndex: number;
    readonly outpoint: string;
    readonly lockingScript: LockingScript;
}
```

See also: [LockingScript](./script.md#class-lockingscript), [string](./remittance.md#function-string)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: WhatsOnChainConfig

Configuration options for the WhatsOnChain ChainTracker.

```ts
export interface WhatsOnChainConfig {
    apiKey?: string;
    httpClient?: HttpClient;
}
```

See also: [HttpClient](./transaction.md#interface-httpclient), [string](./remittance.md#function-string)

#### Property apiKey

Authentication token for the WhatsOnChain API

```ts
apiKey?: string
```
See also: [string](./remittance.md#function-string)

#### Property httpClient

The HTTP client used to make requests to the API.

```ts
httpClient?: HttpClient
```
See also: [HttpClient](./transaction.md#interface-httpclient)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
## Classes

| | |
| --- | --- |
| [ARC](#class-arc) | [MerklePath](#class-merklepath) |
| [Beef](#class-beef) | [NodejsHttpClient](#class-nodejshttpclient) |
| [BeefParty](#class-beefparty) | [SatoshisPerKilobyte](#class-satoshisperkilobyte) |
| [BeefTx](#class-beeftx) | [Transaction](#class-transaction) |
| [EvidenceScriptWork](#class-evidencescriptwork) | [TransactionEvidenceCoordinator](#class-transactionevidencecoordinator) |
| [FetchHttpClient](#class-fetchhttpclient) | [TransactionEvidenceError](#class-transactionevidenceerror) |
| [LivePolicy](#class-livepolicy) | [WhatsOnChain](#class-whatsonchain) |

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---

### Class: ARC

Represents an ARC transaction broadcaster.

```ts
export default class ARC implements Broadcaster {
    readonly URL: string;
    readonly apiKey: string | undefined;
    readonly deploymentId: string;
    readonly callbackUrl: string | undefined;
    readonly callbackToken: string | undefined;
    readonly headers: Record<string, string> | undefined;
    readonly #httpClient: HttpClient;
    constructor(URL: string, config?: ArcConfig);
    constructor(URL: string, apiKey?: string);
    constructor(URL: string, config?: string | ArcConfig)
    #requestHeaders(): Record<string, string>
    async broadcast(tx: Transaction): Promise<BroadcastResponse | BroadcastFailure>
    async broadcastMany(txs: Transaction[]): Promise<object[]>
}
```

See also: [ArcConfig](./transaction.md#interface-arcconfig), [BroadcastFailure](./transaction.md#interface-broadcastfailure), [BroadcastResponse](./transaction.md#interface-broadcastresponse), [Broadcaster](./transaction.md#interface-broadcaster), [HttpClient](./transaction.md#interface-httpclient), [Transaction](./transaction.md#class-transaction), [string](./remittance.md#function-string)

#### Constructor

Constructs an instance of the ARC broadcaster.

```ts
constructor(URL: string, config?: ArcConfig)
```
See also: [ArcConfig](./transaction.md#interface-arcconfig), [string](./remittance.md#function-string)

Argument Details

+ **URL**
  + The URL endpoint for the ARC API.
+ **config**
  + Configuration options for the ARC broadcaster.

#### Constructor

Constructs an instance of the ARC broadcaster.

```ts
constructor(URL: string, apiKey?: string)
```
See also: [string](./remittance.md#function-string)

Argument Details

+ **URL**
  + The URL endpoint for the ARC API.
+ **apiKey**
  + The API key used for authorization with the ARC API.

#### Method

Constructs a dictionary of the default & supplied request headers.

```ts
#requestHeaders(): Record<string, string>
```
See also: [string](./remittance.md#function-string)

#### Method broadcast

Broadcasts a transaction via ARC.

```ts
async broadcast(tx: Transaction): Promise<BroadcastResponse | BroadcastFailure>
```
See also: [BroadcastFailure](./transaction.md#interface-broadcastfailure), [BroadcastResponse](./transaction.md#interface-broadcastresponse), [Transaction](./transaction.md#class-transaction)

Returns

A promise that resolves to either a success or failure response.

Argument Details

+ **tx**
  + The transaction to be broadcasted.

#### Method broadcastMany

Broadcasts multiple transactions via ARC.
Handles mixed responses where some transactions succeed and others fail.

```ts
async broadcastMany(txs: Transaction[]): Promise<object[]>
```
See also: [Transaction](./transaction.md#class-transaction)

Returns

A promise that resolves to an array of objects.

Argument Details

+ **txs**
  + Array of transactions to be broadcasted.

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Class: Beef

```ts
export class Beef {
    bumps: MerklePath[] = [];
    txs: BeefTx[] = [];
    version: number = BEEF_V2;
    atomicTxid: string | undefined = undefined;
    #txidIndex: Map<string, BeefTx> | undefined = undefined;
    #txPositionIndex: Map<string, number> | undefined = undefined;
    #bumpIndexesByHeight: Map<number, number[]> | undefined = undefined;
    #bumpIndexByTxid: Map<string, number> | undefined = undefined;
    #rawBytesCache?: Uint8Array;
    #hexCache?: string;
    readonly #atomicBytesCache = new Map<string, Uint8Array>();
    #atomicCacheTxs?: BeefTxSerializationState[];
    #atomicCacheBumps?: MerklePath[];
    #atomicCacheVersion?: number;
    #rawCacheVersion?: number;
    #rawCacheTxs?: BeefTxSerializationState[];
    #rawCacheBumps?: MerklePath[];
    #bumpState?: BeefBumpSerializationState[];
    #needsSort: boolean = true;
    #sortResultCache?: BeefSortResult;
    #sortTxState?: BeefSortTxState[];
    constructor(version: number = BEEF_V2)
    #invalidateSerializationCaches(): void
    #captureSerializationState(): void
    #captureTransactionState(): BeefTxSerializationState[]
    #transactionStateMatches(cachedTxs: BeefTxSerializationState[] | undefined): boolean
    #captureBumpState(): void
    #bumpLeafStateMatches(leaf: MerklePath["path"][number][number], state: BeefBumpLeafSerializationState): boolean
    #bumpLevelStateMatches(level: MerklePath["path"][number], state: BeefBumpLevelSerializationState): boolean
    #singleBumpStateMatches(bump: MerklePath, state: BeefBumpSerializationState): boolean
    #bumpStateMatches(): boolean
    #synchronizeNestedBumpMutations(): void
    #serializationCacheMatchesState(): boolean
    #markMutated(requiresSort: boolean = true): void
    #ensureSerializableState(): void
    #ensureSortedForSerialization(): void
    #getSerializedBytes(): Uint8Array
    #getBeefForAtomic(txid: string): Beef
    #getAtomicSerializedBytes(txid: string): Uint8Array
    #collectAtomicTransactions(subject: BeefTx, txidToTx: Map<string, BeefTx>): Set<BeefTx>
    #hasMatchingBump(tx: BeefTx): boolean
    #copySelectedTransactions(included: Set<BeefTx>): Beef
    isAtomic(txid: string = this.atomicTxid ?? ""): boolean
    findTxid(txid: string): BeefTx | undefined
    #findTxidIndexed(txid: string): BeefTx | undefined
    #ensureTxidIndex(): Map<string, BeefTx>
    #ensureTxPositionIndex(): Map<string, number>
    #rebuildTxIndexes(): void
    #addToIndex(tx: BeefTx, position: number = this.txs.length - 1): void
    #replaceOrAppendTx(tx: BeefTx): void
    makeTxidOnly(txid: string): BeefTx | undefined
    findBump(txid: string): MerklePath | undefined
    #ensureBumpTxidIndex(): Map<string, number>
    #ensureBumpHeightIndex(): Map<number, number[]>
    #invalidateBumpIndexes(): void
    findTransactionForSigning(txid: string): Transaction | undefined
    findAtomicTransaction(txid: string): Transaction | undefined
    #addInputProof(tx: Transaction): void
    #resolveInputSource(i: Transaction["inputs"][number]): void
    mergeBump(bump: MerklePath): number
    mergeProvenTxs(entries: Array<{
        rawTx: number[] | Uint8Array;
        merklePath: MerklePath;
        merkleRoot?: string;
    }>): BeefTx[]
    #combineCompatibleBumps(paths: MerklePath[], validateCombined: boolean = false): MerklePath
    #mergeBumpEntry(bump: MerklePath): number
    #findOrInsertBump(bump: MerklePath): number
    #tryMarkTxProvenByBump(tx: BeefTx, b: MerklePath, bumpIndex: number): void
    mergeRawTx(rawTx: number[] | Uint8Array, bumpIndex?: number): BeefTx
    #mergeRawTxEntry(rawTx: number[] | Uint8Array, bumpIndex?: number): BeefTx
    #mergeTransactionEntry(current: Transaction): BeefTx
    #queueSourceTransactions(current: Transaction, stack: Transaction[]): void
    mergeTransaction(tx: Transaction): BeefTx
    #mergeTransactionGraph(tx: Transaction): BeefTx
    removeExistingTxid(txid: string): void
    mergeTxidOnly(txid: string): BeefTx
    mergeBeefTx(btx: BeefTx): BeefTx
    #mergeBeefTxEntry(btx: BeefTx): BeefTx
    mergeBeef(beef: Beef | number[] | Uint8Array): void
    isValid(allowTxidOnly?: boolean): boolean
    async verify(chainTracker: ChainTracker, allowTxidOnly?: boolean): Promise<boolean>
    verifyValid(allowTxidOnly?: boolean): {
        valid: boolean;
        roots: Record<number, string>;
    }
    #hasDuplicateTxids(): boolean
    #collectTxidOnlyTxids(txids: Record<string, boolean>, allowTxidOnly?: boolean): boolean
    #collectBumpTxids(txids: Record<string, boolean>, r: {
        valid: boolean;
        roots: Record<number, string>;
    }): boolean
    #verifyBumpIndexLeaves(): boolean
    #verifyInputDependencies(txids: Record<string, boolean>): boolean
    #confirmComputedRoot(b: MerklePath, txid: string, r: {
        valid: boolean;
        roots: Record<number, string>;
    }): boolean
    toWriter(writer: Writer | WriterUint8Array): void
    toBinary(): number[]
    toUint8Array(): Uint8Array
    toBinaryAtomic(txid: string): number[]
    toUint8ArrayAtomic(txid: string): Uint8Array
    toHex(): string
    static fromReader(br: Reader | ReaderUint8Array): Beef
    static fromBinary(bin: number[] | Uint8Array): Beef
    static fromBinaryStrict(bin: number[] | Uint8Array): Beef
    static fromBinaryView(bin: Uint8Array): Beef
    static fromString(s: string, enc: "hex" | "utf8" | "base64" = "hex"): Beef
    #tryToValidateBumpIndex(newTx: BeefTx): boolean
    sortTxs(): {
        missingInputs: string[];
        notValid: string[];
        valid: string[];
        withMissingInputs: string[];
        txidOnly: string[];
    }
    #captureSortTxState(): void
    #sortTxStateMatches(): boolean
    #cloneSortResult(result: BeefSortResult): BeefSortResult
    #separateMissingInputs(candidates: BeefTx[], txidToTx: Record<string, BeefTx>): {
        txsMissingInputs: BeefTx[];
        missingInputs: Record<string, boolean>;
        remaining: BeefTx[];
    }
    #topoSort(queue: BeefTx[], validTxids: Record<string, boolean>, result: BeefTx[]): BeefTx[]
    #buildTopoSortGraph(queue: BeefTx[], validTxids: Record<string, boolean>): {
        indegree: Map<string, number>;
        dependents: Map<string, BeefTx[]>;
        originalIndex: Map<string, number>;
        round: Map<string, number>;
    }
    #processTopoSortQueue(queue: BeefTx[], indegree: Map<string, number>, dependents: Map<string, BeefTx[]>, originalIndex: Map<string, number>, round: Map<string, number>): Set<string>
    #appendTopoSortResult(queue: BeefTx[], processed: Set<string>, round: Map<string, number>, validTxids: Record<string, boolean>, result: BeefTx[]): void
    clone(): Beef
    trimKnownTxids(knownTxids: string[]): void
    #removeKnownTxidOnlyTxs(knownTxids: Set<string>): boolean
    #reindexBumps(): boolean
    getValidTxids(): string[]
    toLogString(): string
    addComputedLeaves(): void
    #addComputedLeavesForRow(bump: MerklePath, row: number): void
}
```

See also: [BEEF_V2](./transaction.md#variable-beef_v2), [BeefTx](./transaction.md#class-beeftx), [ChainTracker](./transaction.md#interface-chaintracker), [MerklePath](./transaction.md#class-merklepath), [Reader](./primitives.md#class-reader), [ReaderUint8Array](./primitives.md#class-readeruint8array), [Transaction](./transaction.md#class-transaction), [Writer](./primitives.md#class-writer), [WriterUint8Array](./primitives.md#class-writeruint8array), [string](./remittance.md#function-string), [toHex](./primitives.md#variable-tohex), [toUint8Array](./primitives.md#variable-touint8array), [verify](./compat.md#variable-verify)

#### Method

Iteratively attach merkle paths and source transactions to all inputs.

```ts
#addInputProof(tx: Transaction): void
```
See also: [Transaction](./transaction.md#class-transaction)

#### Method

Combine already root-matched paths while preserving the first path reference.

```ts
#combineCompatibleBumps(paths: MerklePath[], validateCombined: boolean = false): MerklePath
```
See also: [MerklePath](./transaction.md#class-merklepath)

#### Method

Merge one bump after the caller has synchronized and marked the BEEF.

```ts
#mergeBumpEntry(bump: MerklePath): number
```
See also: [MerklePath](./transaction.md#class-merklepath)

#### Method

Find an existing compatible bump or insert a new one; return its index.

```ts
#findOrInsertBump(bump: MerklePath): number
```
See also: [MerklePath](./transaction.md#class-merklepath)

#### Method

If bump's level-0 path contains tx's txid, record the bumpIndex on tx.

```ts
#tryMarkTxProvenByBump(tx: BeefTx, b: MerklePath, bumpIndex: number): void
```
See also: [BeefTx](./transaction.md#class-beeftx), [MerklePath](./transaction.md#class-merklepath)

#### Method

Merge one raw transaction after the caller has synchronized and marked the BEEF.

```ts
#mergeRawTxEntry(rawTx: number[] | Uint8Array, bumpIndex?: number): BeefTx
```
See also: [BeefTx](./transaction.md#class-beeftx)

#### Method

Merge one transaction graph after the caller has synchronized and marked the BEEF.

```ts
#mergeTransactionGraph(tx: Transaction): BeefTx
```
See also: [BeefTx](./transaction.md#class-beeftx), [Transaction](./transaction.md#class-transaction)

#### Method

Merge one BEEF transaction after the caller has synchronized and marked the BEEF.

```ts
#mergeBeefTxEntry(btx: BeefTx): BeefTx
```
See also: [BeefTx](./transaction.md#class-beeftx)

#### Method

Add txidOnly transaction txids; return false if not allowed.

```ts
#collectTxidOnlyTxids(txids: Record<string, boolean>, allowTxidOnly?: boolean): boolean
```
See also: [string](./remittance.md#function-string)

#### Method

Record txids proven by bumps; validate all bump roots agree per block height.
Returns false if any root conflict is detected.

```ts
#collectBumpTxids(txids: Record<string, boolean>, r: {
    valid: boolean;
    roots: Record<number, string>;
}): boolean
```
See also: [string](./remittance.md#function-string)

#### Method

Verify that every tx with a bumpIndex has a matching txid leaf in its bump.

```ts
#verifyBumpIndexLeaves(): boolean
```

#### Method

Verify all input txids appear before the spending tx in sorted order.

```ts
#verifyInputDependencies(txids: Record<string, boolean>): boolean
```
See also: [string](./remittance.md#function-string)

#### Method

Confirm the computed merkle root for txid in bump matches previously accepted root for that height.

```ts
#confirmComputedRoot(b: MerklePath, txid: string, r: {
    valid: boolean;
    roots: Record<number, string>;
}): boolean
```
See also: [MerklePath](./transaction.md#class-merklepath), [string](./remittance.md#function-string)

#### Method

Try to validate newTx.bumpIndex by looking for an existing bump
that proves newTx.txid

```ts
#tryToValidateBumpIndex(newTx: BeefTx): boolean
```
See also: [BeefTx](./transaction.md#class-beeftx)

Returns

true if a bump was found, false otherwise

Argument Details

+ **newTx**
  + A new `BeefTx` that has been added to this.txs

#### Method

Separate queue entries that have at least one input txid not present in txidToTx.

```ts
#separateMissingInputs(candidates: BeefTx[], txidToTx: Record<string, BeefTx>): {
    txsMissingInputs: BeefTx[];
    missingInputs: Record<string, boolean>;
    remaining: BeefTx[];
}
```
See also: [BeefTx](./transaction.md#class-beeftx), [string](./remittance.md#function-string)

#### Method

Topologically sort queue into result; return anything that cannot be sorted.

```ts
#topoSort(queue: BeefTx[], validTxids: Record<string, boolean>, result: BeefTx[]): BeefTx[]
```
See also: [BeefTx](./transaction.md#class-beeftx), [string](./remittance.md#function-string)

#### Method

Remove txidOnly entries that appear in knownTxids; return true if any were removed.

```ts
#removeKnownTxidOnlyTxs(knownTxids: Set<string>): boolean
```
See also: [string](./remittance.md#function-string)

#### Method

Remove bumps that are no longer referenced by any tx and update bumpIndex references.
Returns true if any bumps were removed.

```ts
#reindexBumps(): boolean
```

#### Method

Add any missing computable leaf at `row` derived from two known leaves at `row - 1`.

```ts
#addComputedLeavesForRow(bump: MerklePath, row: number): void
```
See also: [MerklePath](./transaction.md#class-merklepath)

#### Method addComputedLeaves

In some circumstances it may be helpful for the BUMP MerklePaths to include
leaves that can be computed from row zero.

```ts
addComputedLeaves(): void
```

#### Method clone

```ts
clone(): Beef
```
See also: [Beef](./transaction.md#class-beef)

Returns

a shallow copy of this beef

#### Method findAtomicTransaction

Builds the proof tree rooted at a specific `Transaction`.

To succeed, the Beef must contain all the required transaction and merkle path data.

```ts
findAtomicTransaction(txid: string): Transaction | undefined
```
See also: [Transaction](./transaction.md#class-transaction), [string](./remittance.md#function-string)

Returns

Transaction with input `SourceTransaction` and `MerklePath` populated from this Beef.

Argument Details

+ **txid**
  + The id of the target transaction.

#### Method findBump

```ts
findBump(txid: string): MerklePath | undefined
```
See also: [MerklePath](./transaction.md#class-merklepath), [string](./remittance.md#function-string)

Returns

`MerklePath` with level zero hash equal to txid or undefined.

#### Method findTransactionForSigning

Finds a Transaction in this `Beef`
and adds any missing input SourceTransactions from this `Beef`.

The result is suitable for signing.

```ts
findTransactionForSigning(txid: string): Transaction | undefined
```
See also: [Transaction](./transaction.md#class-transaction), [string](./remittance.md#function-string)

Returns

Transaction with all available input `SourceTransaction`s from this Beef.

Argument Details

+ **txid**
  + The id of the target transaction.

#### Method findTxid

```ts
findTxid(txid: string): BeefTx | undefined
```
See also: [BeefTx](./transaction.md#class-beeftx), [string](./remittance.md#function-string)

Returns

`BeefTx` in `txs` with `txid`.

Argument Details

+ **txid**
  + of `beefTx` to find

#### Method fromBinary

```ts
static fromBinary(bin: number[] | Uint8Array): Beef
```
See also: [Beef](./transaction.md#class-beef)

Returns

An instance of the Beef class constructed from the binary data

Argument Details

+ **bin**
  + The binary array or Uint8Array from which to construct BEEF

#### Method fromBinaryStrict

Parses one complete BEEF object from an isolated copy of `bin` and rejects
any trailing bytes. Use this for data received across a trust boundary.

```ts
static fromBinaryStrict(bin: number[] | Uint8Array): Beef
```
See also: [Beef](./transaction.md#class-beef)

#### Method fromBinaryView

Parses BEEF while retaining zero-copy views over `bin`. The caller must not
mutate the buffer for the lifetime of the returned object.

```ts
static fromBinaryView(bin: Uint8Array): Beef
```
See also: [Beef](./transaction.md#class-beef)

#### Method fromString

Constructs an instance of the Beef class based on the provided string

```ts
static fromString(s: string, enc: "hex" | "utf8" | "base64" = "hex"): Beef
```
See also: [Beef](./transaction.md#class-beef), [string](./remittance.md#function-string)

Returns

An instance of the Beef class constructed from the string

Argument Details

+ **s**
  + The string value from which to construct BEEF
+ **enc**
  + The encoding of the string value from which BEEF should be constructed

#### Method getValidTxids

```ts
getValidTxids(): string[]
```
See also: [string](./remittance.md#function-string)

Returns

array of transaction txids that either have a proof or whose inputs chain back to a proven transaction.

#### Method isAtomic

Checks the BRC-95 transaction-inclusion rule without requiring header-root
validation: the subject must exist and every included transaction must be
in its recursive dependency graph.

```ts
isAtomic(txid: string = this.atomicTxid ?? ""): boolean
```
See also: [string](./remittance.md#function-string)

#### Method isValid

Sorts `txs` and checks structural validity of beef.

Does NOT verify merkle roots.

Validity requirements:
1. No 'known' txids, unless `allowTxidOnly` is true.
2. All transactions have bumps or their inputs chain back to bumps (or are known).
3. Order of transactions satisfies dependencies before dependents.
4. No transactions with duplicate txids.

```ts
isValid(allowTxidOnly?: boolean): boolean
```

Argument Details

+ **allowTxidOnly**
  + optional. If true, transaction txid only is assumed valid

#### Method makeTxidOnly

Replaces `BeefTx` for this txid with txidOnly.

Replacement is done so that a `clone()` can be
updated by this method without affecting the
original.

```ts
makeTxidOnly(txid: string): BeefTx | undefined
```
See also: [BeefTx](./transaction.md#class-beeftx), [string](./remittance.md#function-string)

Returns

undefined if txid is unknown.

#### Method mergeBump

Merge a MerklePath that is assumed to be fully valid.

```ts
mergeBump(bump: MerklePath): number
```
See also: [MerklePath](./transaction.md#class-merklepath)

Returns

index of merged bump

#### Method mergeProvenTxs

Merge several independently proven transactions in one mutation pass.

This is equivalent to calling `mergeRawTx` followed by `mergeBump` for
every entry, but synchronizes nested BEEF state only once. That distinction
matters for wallets assembling a BEEF from a fragmented UTXO set because
proof paths are otherwise re-scanned after every input.

```ts
mergeProvenTxs(entries: Array<{
    rawTx: number[] | Uint8Array;
    merklePath: MerklePath;
    merkleRoot?: string;
}>): BeefTx[]
```
See also: [BeefTx](./transaction.md#class-beeftx), [MerklePath](./transaction.md#class-merklepath), [string](./remittance.md#function-string)

#### Method mergeRawTx

Merge a serialized transaction.

Checks that a transaction with the same txid hasn't already been merged.

Replaces existing transaction with same txid.

```ts
mergeRawTx(rawTx: number[] | Uint8Array, bumpIndex?: number): BeefTx
```
See also: [BeefTx](./transaction.md#class-beeftx)

Returns

txid of rawTx

Argument Details

+ **bumpIndex**
  + Optional. If a number, must be valid index into bumps array.

#### Method mergeTransaction

Merge a `Transaction` and any referenced `merklePath` and `sourceTransaction`, recursifely.

Replaces existing transaction with same txid.

Attempts to match an existing bump to the new transaction.

```ts
mergeTransaction(tx: Transaction): BeefTx
```
See also: [BeefTx](./transaction.md#class-beeftx), [Transaction](./transaction.md#class-transaction)

Returns

txid of tx

#### Method removeExistingTxid

Removes an existing transaction from the BEEF, given its TXID

```ts
removeExistingTxid(txid: string): void
```
See also: [string](./remittance.md#function-string)

Argument Details

+ **txid**
  + TXID of the transaction to remove

#### Method sortTxs

Sort the `txs` by input txid dependency order:
- Oldest Tx Anchored by Path or txid only
- Newer Txs depending on Older parents
- Newest Tx

with proof (MerklePath) last, longest chain of dependencies first

```ts
sortTxs(): {
    missingInputs: string[];
    notValid: string[];
    valid: string[];
    withMissingInputs: string[];
    txidOnly: string[];
}
```
See also: [string](./remittance.md#function-string)

Returns

`{ missingInputs, notValid, valid, withMissingInputs }`

#### Method toBinary

Returns a binary array representing the serialized BEEF

```ts
toBinary(): number[]
```

Returns

A binary array representing the BEEF

An array of byte values containing binary serialization of the BEEF

#### Method toBinaryAtomic

Serialize this Beef as AtomicBEEF.

`txid` must exist

includes exactly the subject transaction and its recursive dependencies

```ts
toBinaryAtomic(txid: string): number[]
```
See also: [string](./remittance.md#function-string)

Returns

serialized contents of this Beef with AtomicBEEF prefix.

#### Method toHex

Returns a hex string representing the serialized BEEF

```ts
toHex(): string
```
See also: [string](./remittance.md#function-string)

Returns

A hex string representing the BEEF

#### Method toLogString

```ts
toLogString(): string
```
See also: [string](./remittance.md#function-string)

Returns

Summary of `Beef` contents as multi-line string.

#### Method toUint8Array

Returns a binary array representing the serialized BEEF

```ts
toUint8Array(): Uint8Array
```

Returns

A Uint8Array containing binary serialization of the BEEF

#### Method toUint8ArrayAtomic

Serialize this Beef as AtomicBEEF.

`txid` must exist

includes exactly the subject transaction and its recursive dependencies

```ts
toUint8ArrayAtomic(txid: string): Uint8Array
```
See also: [string](./remittance.md#function-string)

Returns

serialized contents of this Beef with AtomicBEEF prefix.

#### Method toWriter

Serializes this data to `writer`

```ts
toWriter(writer: Writer | WriterUint8Array): void
```
See also: [Writer](./primitives.md#class-writer), [WriterUint8Array](./primitives.md#class-writeruint8array)

#### Method trimKnownTxids

Ensure that all the txids in `knownTxids` are txidOnly

```ts
trimKnownTxids(knownTxids: string[]): void
```
See also: [string](./remittance.md#function-string)

#### Method verify

Sorts `txs` and confirms validity of transaction data contained in beef
by validating structure of this beef and confirming computed merkle roots
using `chainTracker`.

Validity requirements:
1. No 'known' txids, unless `allowTxidOnly` is true.
2. All transactions have bumps or their inputs chain back to bumps (or are known).
3. Order of transactions satisfies dependencies before dependents.
4. No transactions with duplicate txids.

```ts
async verify(chainTracker: ChainTracker, allowTxidOnly?: boolean): Promise<boolean>
```
See also: [ChainTracker](./transaction.md#interface-chaintracker)

Argument Details

+ **chainTracker**
  + Used to verify computed merkle path roots for all bump txids.
+ **allowTxidOnly**
  + optional. If true, transaction txid is assumed valid

#### Method verifyValid

Sorts `txs` and confirms validity of transaction data contained in beef
by validating structure of this beef.

Returns block heights and merkle root values to be confirmed by a chaintracker.

Validity requirements:
1. No 'known' txids, unless `allowTxidOnly` is true.
2. All transactions have bumps or their inputs chain back to bumps (or are known).
3. Order of transactions satisfies dependencies before dependents.
4. No transactions with duplicate txids.

```ts
verifyValid(allowTxidOnly?: boolean): {
    valid: boolean;
    roots: Record<number, string>;
}
```
See also: [string](./remittance.md#function-string)

Returns

`valid` is true iff this Beef is structuraly valid.
`roots` is a record where keys are block heights and values are the corresponding merkle roots to be validated.

Argument Details

+ **allowTxidOnly**
  + optional. If true, transaction txid is assumed valid

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Class: BeefParty

Extends `Beef` that is used to exchange transaction validity data with more than one external party.

Use `addKnownTxidsForParty` to keep track of who knows what to reduce re-transmission of potentially large transactions.

Use `getTrimmedBeefForParty` to obtain a `Beef` trimmed of transaction validity data known to a specific party.

Typical usage scenario:

1. Query a wallet storage provider for spendable outputs.
2. The provider replies with a Beef validating the returned outputs.
3. Construct a new transaction using some of the queried outputs as inputs, including Beef validating all the inputs.
4. Receive new valid raw transaction after processing and Beef validating change outputs added to original inputs.
5. Return to step 1, continuing to build on old and new spendable outputs.

By default, each Beef is required to be complete and valid: All transactions appear as full serialized bitcoin transactions and
each transaction either has a merkle path proof (it has been mined) or all of its input transactions are included.

The size and redundancy of these Beefs becomes a problem when chained transaction creation out-paces the block mining rate.

```ts
export class BeefParty extends Beef {
    knownTo: Record<string, Record<string, boolean>> = Object.create(null) as Record<string, Record<string, boolean>>;
    constructor(parties?: string[])
    isParty(party: string): boolean
    addParty(party: string): void
    getKnownTxidsForParty(party: string): string[]
    getTrimmedBeefForParty(party: string): Beef
    addKnownTxidsForParty(party: string, knownTxids: string[]): void
    mergeBeefFromParty(party: string, beef: number[] | Uint8Array | Beef): void
}
```

See also: [Beef](./transaction.md#class-beef), [string](./remittance.md#function-string)

#### Constructor

```ts
constructor(parties?: string[])
```
See also: [string](./remittance.md#function-string)

Argument Details

+ **parties**
  + Optional array of initial unique party identifiers.

#### Property knownTo

keys are party identifiers.
values are records of txids with truthy value for which the party already has validity proof.

```ts
knownTo: Record<string, Record<string, boolean>> = Object.create(null) as Record<string, Record<string, boolean>>
```
See also: [string](./remittance.md#function-string)

#### Method addKnownTxidsForParty

Make note of additional txids "known" to `party`.

```ts
addKnownTxidsForParty(party: string, knownTxids: string[]): void
```
See also: [string](./remittance.md#function-string)

Argument Details

+ **party**
  + unique identifier, added if new.

#### Method addParty

Adds a new unique party identifier to this `BeefParty`.

```ts
addParty(party: string): void
```
See also: [string](./remittance.md#function-string)

#### Method getKnownTxidsForParty

```ts
getKnownTxidsForParty(party: string): string[]
```
See also: [string](./remittance.md#function-string)

Returns

Array of txids "known" to `party`.

#### Method getTrimmedBeefForParty

```ts
getTrimmedBeefForParty(party: string): Beef
```
See also: [Beef](./transaction.md#class-beef), [string](./remittance.md#function-string)

Returns

trimmed beef of unknown transactions and proofs for `party`

#### Method isParty

```ts
isParty(party: string): boolean
```
See also: [string](./remittance.md#function-string)

Returns

`true` if `party` has already been added to this `BeefParty`.

#### Method mergeBeefFromParty

Merge a `beef` received from a specific `party`.

Updates this `BeefParty` to track all the txids
corresponding to transactions for which `party`
has raw transaction and validity proof data.

```ts
mergeBeefFromParty(party: string, beef: number[] | Uint8Array | Beef): void
```
See also: [Beef](./transaction.md#class-beef), [string](./remittance.md#function-string)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Class: BeefTx

A single bitcoin transaction associated with a `Beef` validity proof set.

Simple case is transaction data included directly, either as raw bytes or fully parsed data, or both.

Supports 'known' transactions which are represented by just their txid.
It is assumed that intended consumer of this beef already has validity proof for such a transaction,
which they can merge if necessary to create a valid beef.

```ts
export default class BeefTx {
    _bumpIndex?: number;
    _tx?: Transaction;
    _rawTx?: Uint8Array;
    _txid?: string;
    inputTxids: string[] = [];
    isValid?: boolean = undefined;
    get bumpIndex(): number | undefined
    set bumpIndex(v: number | undefined)
    get hasProof(): boolean
    get isTxidOnly(): boolean
    get txid(): string
    get tx(): Transaction | undefined
    get rawTx(): number[] | undefined
    get rawTxUint8Array(): Uint8Array | undefined
    syncRawTxFromTransaction(): boolean
    constructor(tx: Transaction | Uint8Array | number[] | string, bumpIndex?: number, inputTxids?: string[], retainRawView: boolean = false)
    static fromTx(tx: Transaction, bumpIndex?: number): BeefTx
    static fromRawTx(rawTx: Uint8Array | number[], bumpIndex?: number): BeefTx
    static fromTxid(txid: string, bumpIndex?: number): BeefTx
    toWriter(writer: Writer | WriterUint8Array, version: number): void
    static fromReader(br: Reader | ReaderUint8Array, version: number): BeefTx
}
```

See also: [Reader](./primitives.md#class-reader), [ReaderUint8Array](./primitives.md#class-readeruint8array), [Transaction](./transaction.md#class-transaction), [Writer](./primitives.md#class-writer), [WriterUint8Array](./primitives.md#class-writeruint8array), [string](./remittance.md#function-string)

#### Constructor

```ts
constructor(tx: Transaction | Uint8Array | number[] | string, bumpIndex?: number, inputTxids?: string[], retainRawView: boolean = false)
```
See also: [Transaction](./transaction.md#class-transaction), [string](./remittance.md#function-string)

Argument Details

+ **tx**
  + If string, must be a valid txid. If `number[]` must be a valid serialized transaction.
+ **bumpIndex**
  + If transaction already has a proof in the beef to which it will be added.

#### Property isValid

true if `hasProof` or all inputs chain to `hasProof`.

Typically set by sorting transactions by proven dependency chains.

```ts
isValid?: boolean = undefined
```

#### Method syncRawTxFromTransaction

Synchronizes a nested transaction after mutation through the normal
Transaction APIs. Returns true when its serialized identity or dependencies
changed.

```ts
syncRawTxFromTransaction(): boolean
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Class: EvidenceScriptWork

Internal cache. Only coordinator-owned transactions are bound to its scope below.

```ts
export class EvidenceScriptWork {
    constructor(private readonly limits: Readonly<TransactionEvidenceLimits>)
    clear(): void
    inputs(scope: EvidenceScriptScope, params: BdkVerifyScriptsParams, verify: (skipScripts: boolean) => InputResult): InputResult
    async batch(scope: EvidenceScriptScope, params: readonly BdkVerifyScriptsParams[], backend: BdkVerifierInterface): Promise<boolean[]>
}
```

See also: [BdkVerifierInterface](./transaction.md#interface-bdkverifierinterface), [BdkVerifyScriptsParams](./transaction.md#interface-bdkverifyscriptsparams), [EvidenceScriptScope](./transaction.md#interface-evidencescriptscope), [TransactionEvidenceLimits](./transaction.md#interface-transactionevidencelimits), [verify](./compat.md#variable-verify)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Class: FetchHttpClient

Adapter for Node Https module to be used as HttpClient

```ts
export class FetchHttpClient implements HttpClient {
    constructor(private readonly fetch: Fetch, limits: HttpClientLimits = {})
    async request<D>(url: string, options: HttpClientRequestOptions): Promise<HttpClientResponse<D>>
}
```

See also: [Fetch](./transaction.md#type-fetch), [HttpClient](./transaction.md#interface-httpclient), [HttpClientLimits](./transaction.md#interface-httpclientlimits), [HttpClientRequestOptions](./transaction.md#interface-httpclientrequestoptions), [HttpClientResponse](./transaction.md#type-httpclientresponse), [string](./remittance.md#function-string)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Class: LivePolicy

Represents a live fee policy that fetches current rates from ARC GorillaPool.
Extends SatoshisPerKilobyte to reuse transaction size calculation logic.

```ts
export default class LivePolicy extends SatoshisPerKilobyte {
    constructor(cacheValidityMs: number = 5 * 60 * 1000)
    static getInstance(cacheValidityMs: number = 5 * 60 * 1000): LivePolicy
    override async computeFee(tx: Transaction): Promise<number>
}
```

See also: [SatoshisPerKilobyte](./transaction.md#class-satoshisperkilobyte), [Transaction](./transaction.md#class-transaction)

#### Constructor

Constructs an instance of the live policy fee model.

```ts
constructor(cacheValidityMs: number = 5 * 60 * 1000)
```

Argument Details

+ **cacheValidityMs**
  + How long to cache the fee rate in milliseconds (default: 5 minutes)

#### Method computeFee

Computes the fee for a given transaction using the current live rate.
Overrides the parent method to use dynamic rate fetching.

```ts
override async computeFee(tx: Transaction): Promise<number>
```
See also: [Transaction](./transaction.md#class-transaction)

Returns

The fee in satoshis for the transaction.

Argument Details

+ **tx**
  + The transaction for which a fee is to be computed.

#### Method getInstance

Gets the singleton instance of LivePolicy to ensure cache sharing across the application.

```ts
static getInstance(cacheValidityMs: number = 5 * 60 * 1000): LivePolicy
```
See also: [LivePolicy](./transaction.md#class-livepolicy)

Returns

The singleton LivePolicy instance

Argument Details

+ **cacheValidityMs**
  + How long to cache the fee rate in milliseconds (default: 5 minutes)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Class: MerklePath

Represents a Merkle Path, which is used to provide a compact proof of inclusion for a
transaction in a block. This class encapsulates all the details required for creating
and verifying Merkle Proofs.

Example

```ts
// Creating and verifying a Merkle Path
const merklePath = MerklePath.fromHex('...');
const isValid = merklePath.verify(txid, chainTracker);
```

```ts
export default class MerklePath {
    blockHeight: number;
    path: Array<Array<{
        offset: number;
        hash?: string;
        txid?: boolean;
        duplicate?: boolean;
    }>>;
    static fromHex(hex: string): MerklePath
    static fromReader(reader: Reader | ReaderUint8Array, legalOffsetsOnly: boolean = true, validateRoots: boolean = true): MerklePath
    static fromBinary(bump: number[] | Uint8Array, legalOffsetsOnly: boolean = true, validateRoots: boolean = true): MerklePath
    static fromCoinbaseTxidAndHeight(txid: string, height: number): MerklePath
    constructor(blockHeight: number, path: Array<Array<{
        offset: number;
        hash?: string;
        txid?: boolean;
        duplicate?: boolean;
    }>>, legalOffsetsOnly: boolean = true, validateRoots: boolean = true)
    toWriter(writer: Writer | WriterUint8Array): void
    toBinary(): number[]
    toBinaryUint8Array(): Uint8Array
    toHex(): string
    indexOf(txid: string): number
    computeRootCached(txid: string | undefined, sourceIndex: Array<Map<number, MerklePathLeaf>>, hashCache: Map<string, MerklePathLeaf | undefined>, nodeHashCache: Map<string, string>, maxOffset: number): string
    computeRoot(txid?: string): string
    findOrComputeLeaf(height: number, offset: number): MerklePathLeaf | undefined
    async verify(txid: string, chainTracker: ChainTracker): Promise<boolean>
    combine(other: MerklePath): void
    trim(): void
    cachedFindLeaf(height: number, offset: number, sourceIndex: Array<Map<number, MerklePathLeaf>>, hashCache: Map<string, MerklePathLeaf | undefined>, maxOffset: number): MerklePathLeaf | undefined
    extract(txids: string[]): MerklePath
    createSourceLeafIndex(): Array<Map<number, MerklePathLeaf>>
    createTxidToOffsetIndex(): Map<string, number>
    createNeededLeafLevels(treeHeight: number): Array<Map<number, MerklePathLeaf>>
    collectExtractedLeaves(txid: string, txidToOffset: Map<string, number>, neededPerLevel: Array<Map<number, MerklePathLeaf>>, sourceIndex: Array<Map<number, MerklePathLeaf>>, hashCache: Map<string, MerklePathLeaf | undefined>, maxOffset: number, treeHeight: number): void
    buildExtractedPath(neededPerLevel: Array<Map<number, MerklePathLeaf>>): MerklePathLeaf[][]
}
```

See also: [ChainTracker](./transaction.md#interface-chaintracker), [MerklePathLeaf](./transaction.md#interface-merklepathleaf), [Reader](./primitives.md#class-reader), [ReaderUint8Array](./primitives.md#class-readeruint8array), [Writer](./primitives.md#class-writer), [WriterUint8Array](./primitives.md#class-writeruint8array), [string](./remittance.md#function-string), [toHex](./primitives.md#variable-tohex), [verify](./compat.md#variable-verify)

#### Method cachedFindLeaf

Cached leaf finder for extract(). Uses Map-based indexes for O(1) lookups
and caches computed intermediate hashes to avoid redundant work.

```ts
cachedFindLeaf(height: number, offset: number, sourceIndex: Array<Map<number, MerklePathLeaf>>, hashCache: Map<string, MerklePathLeaf | undefined>, maxOffset: number): MerklePathLeaf | undefined
```
See also: [MerklePathLeaf](./transaction.md#interface-merklepathleaf), [string](./remittance.md#function-string)

#### Method combine

Combines this MerklePath with another to create a compound proof.

```ts
combine(other: MerklePath): void
```
See also: [MerklePath](./transaction.md#class-merklepath)

Argument Details

+ **other**
  + Another MerklePath to combine with this path.

Throws

- If the paths have different block heights or roots.

#### Method computeRoot

Computes the Merkle root from the provided transaction ID.

```ts
computeRoot(txid?: string): string
```
See also: [string](./remittance.md#function-string)

Returns

- The computed Merkle root as a hexadecimal string.

Argument Details

+ **txid**
  + The transaction ID to compute the Merkle root for. If not provided, the root will be computed from an unspecified branch, and not all branches will be validated!

Throws

- If the transaction ID is not part of the Merkle Path.

#### Method extract

Extracts a minimal compound MerklePath covering only the specified transaction IDs.

Given a compound MerklePath (e.g. all block txids at level 0, or a trimmed
compound path), this method reconstructs the sibling hashes at each tree level
for every requested txid using cached Map-indexed lookups, then assembles them
into a single trimmed compound path.

The extracted path is verified to compute the same Merkle root as the source.

```ts
extract(txids: string[]): MerklePath
```
See also: [MerklePath](./transaction.md#class-merklepath), [string](./remittance.md#function-string)

Returns

- A new trimmed compound MerklePath covering only the requested txids.

Argument Details

+ **txids**
  + Transaction IDs to extract proofs for.

Throws

- If no txids are provided, a txid is not found, or the roots do not match.

Example

```ts
// Full block compound path (all txids at level 0)
const fullBlock = new MerklePath(height, [allTxidsAtLevel0])
// Extract a smaller compound proof covering just two transactions
const twoTxProof = fullBlock.extract([txid1, txid2])
twoTxProof.computeRoot(txid1) // === fullBlock.computeRoot()
```

#### Method findOrComputeLeaf

Find leaf with `offset` at `height` or compute from level below, recursively.

Does not add computed leaves to path.

```ts
findOrComputeLeaf(height: number, offset: number): MerklePathLeaf | undefined
```
See also: [MerklePathLeaf](./transaction.md#interface-merklepathleaf)

#### Method fromBinary

Creates a MerklePath instance from a binary array.

```ts
static fromBinary(bump: number[] | Uint8Array, legalOffsetsOnly: boolean = true, validateRoots: boolean = true): MerklePath
```
See also: [MerklePath](./transaction.md#class-merklepath)

Returns

- A new MerklePath instance.

Argument Details

+ **bump**
  + The binary array representation of the Merkle Path.

#### Method fromCoinbaseTxidAndHeight

```ts
static fromCoinbaseTxidAndHeight(txid: string, height: number): MerklePath
```
See also: [MerklePath](./transaction.md#class-merklepath), [string](./remittance.md#function-string)

Returns

- A new MerklePath instance which assumes the tx is in a block with no other transactions.

Argument Details

+ **txid**
  + The coinbase txid.
+ **height**
  + The height of the block.

#### Method fromHex

Creates a MerklePath instance from a hexadecimal string.

```ts
static fromHex(hex: string): MerklePath
```
See also: [MerklePath](./transaction.md#class-merklepath), [string](./remittance.md#function-string)

Returns

- A new MerklePath instance.

Argument Details

+ **hex**
  + The hexadecimal string representation of the Merkle Path.

#### Method toBinary

Converts the MerklePath to a binary array format.

```ts
toBinary(): number[]
```

Returns

- The binary array representation of the Merkle Path.

#### Method toBinaryUint8Array

Converts the MerklePath to a binary array format.

```ts
toBinaryUint8Array(): Uint8Array
```

Returns

- The binary array representation of the Merkle Path.

#### Method toHex

Converts the MerklePath to a hexadecimal string format.

```ts
toHex(): string
```
See also: [string](./remittance.md#function-string)

Returns

- The hexadecimal string representation of the Merkle Path.

#### Method toWriter

Serializes the MerklePath to the writer provided.

```ts
toWriter(writer: Writer | WriterUint8Array): void
```
See also: [Writer](./primitives.md#class-writer), [WriterUint8Array](./primitives.md#class-writeruint8array)

Argument Details

+ **writer**
  + The writer to which the Merkle Path will be serialized.

#### Method trim

Remove all internal nodes that are not required by level zero txid nodes.
Assumes that at least all required nodes are present.
Leaves all levels sorted by increasing offset.

```ts
trim(): void
```

#### Method verify

Verifies if the given transaction ID is part of the Merkle tree at the specified block height.

```ts
async verify(txid: string, chainTracker: ChainTracker): Promise<boolean>
```
See also: [ChainTracker](./transaction.md#interface-chaintracker), [string](./remittance.md#function-string)

Returns

- True if the transaction ID is valid within the Merkle Path at the specified block height.

Argument Details

+ **txid**
  + The transaction ID to verify.
+ **chainTracker**
  + The ChainTracker instance used to verify the Merkle root.

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Class: NodejsHttpClient

Adapter for Node Https module to be used as HttpClient

```ts
export class NodejsHttpClient implements HttpClient {
    constructor(private readonly https: HttpsNodejs)
    async request(url: string, requestOptions: HttpClientRequestOptions): Promise<HttpClientResponse>
}
```

See also: [HttpClient](./transaction.md#interface-httpclient), [HttpClientRequestOptions](./transaction.md#interface-httpclientrequestoptions), [HttpClientResponse](./transaction.md#type-httpclientresponse), [HttpsNodejs](./transaction.md#interface-httpsnodejs), [string](./remittance.md#function-string)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Class: SatoshisPerKilobyte

Represents the "satoshis per kilobyte" transaction fee model.

```ts
export default class SatoshisPerKilobyte implements FeeModel {
    value: number;
    constructor(value: number)
    async computeFee(tx: Transaction): Promise<number>
}
```

See also: [FeeModel](./transaction.md#interface-feemodel), [Transaction](./transaction.md#class-transaction)

#### Constructor

Constructs an instance of the sat/kb fee model.

```ts
constructor(value: number)
```

Argument Details

+ **value**
  + The number of satoshis per kilobyte to charge as a fee.

#### Method computeFee

Computes the fee for a given transaction.

```ts
async computeFee(tx: Transaction): Promise<number>
```
See also: [Transaction](./transaction.md#class-transaction)

Returns

The fee in satoshis for the transaction, as a BigNumber.

Argument Details

+ **tx**
  + The transaction for which a fee is to be computed.

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Class: Transaction

Represents a complete Bitcoin transaction. This class encapsulates all the details
required for creating, signing, and processing a Bitcoin transaction, including
inputs, outputs, and various transaction-related methods.

Example

```ts
// Creating a new transaction
let tx = new Transaction();
tx.addInput(...);
tx.addOutput(...);
await tx.fee();
await tx.sign();
await tx.broadcast();
```

```ts
export default class Transaction {
    version: number;
    inputs: TransactionInput[];
    outputs: TransactionOutput[];
    lockTime: number;
    metadata: Record<string, any>;
    merklePath?: MerklePath;
    #cachedHash?: number[];
    #cachedIdHex?: string;
    #rawBytesCache?: Uint8Array;
    #efBytesCache?: Uint8Array;
    #hexCache?: string;
    #activeSignatureHashCache?: SignatureHashCache;
    #rawCacheState?: {
        version: number;
        lockTime: number;
        inputs: Array<{
            ref: TransactionInput;
            sourceTXID: string | undefined;
            sourceTransactionId: string | undefined;
            sourceOutputIndex: number;
            sequence: number | undefined;
            unlockingScript: TransactionInput["unlockingScript"];
            unlockingScriptBytes: Uint8Array | undefined;
            sourceOutput: TransactionOutput | undefined;
            sourceSatoshis: number | undefined;
            sourceLockingScript: TransactionOutput["lockingScript"] | undefined;
            sourceLockingScriptBytes: Uint8Array | undefined;
        }>;
        outputs: Array<{
            ref: TransactionOutput;
            satoshis: number | undefined;
            lockingScript: TransactionOutput["lockingScript"];
            lockingScriptBytes: Uint8Array;
        }>;
    };
    getSignatureHashCache(): SignatureHashCache
    #completeSourceTransaction(tx: Transaction, visiting: Set<Transaction>, complete: Set<Transaction>): void
    #scheduleSourceTransactions(tx: Transaction, visiting: Set<Transaction>, complete: Set<Transaction>, stack: Array<{
        tx: Transaction;
        expanded: boolean;
    }>): void
    materializeSourceTXIDs(): void
    static fromBEEF(beef: number[] | Uint8Array, txid?: string): Transaction
    static fromBEEFView(beef: Uint8Array, txid?: string): Transaction
    static fromAtomicBEEF(beef: number[] | Uint8Array): Transaction
    static fromAtomicBEEFView(beef: Uint8Array): Transaction
    static #fromAnyBeef(beef: number[] | Uint8Array, txid?: string, zeroCopy: boolean = false): {
        tx: Transaction;
        beef: Beef;
        txid: string;
    }
    static fromEF(ef: number[] | Uint8Array): Transaction
    static parseScriptOffsets(bin: number[] | Uint8Array): {
        inputs: Array<{
            vin: number;
            offset: number;
            length: number;
        }>;
        outputs: Array<{
            vout: number;
            offset: number;
            length: number;
        }>;
    }
    static fromReader(br: Reader | ReaderUint8Array): Transaction
    static #fromReaderInternal(br: Reader | ReaderUint8Array, zeroCopyScripts: boolean): Transaction
    static fromBinary(bin: number[] | Uint8Array): Transaction
    static fromBinaryView(bin: Uint8Array): Transaction
    static fromHex(hex: string): Transaction
    static fromHexEF(hex: string): Transaction
    static fromHexBEEF(hex: string, txid?: string): Transaction
    constructor(version: number = 1, inputs: TransactionInput[] = [], outputs: TransactionOutput[] = [], lockTime: number = 0, metadata: Record<string, any> = new Map(), merklePath?: MerklePath)
    #invalidateSerializationCaches(): void
    #sourceTransactionId(input: TransactionInput): string | undefined
    #captureSerializationState(): void
    #serializationCacheMatchesState(): boolean
    addInput(input: TransactionInput): void
    addOutput(output: TransactionOutput): void
    addP2PKHOutput(address: number[] | string, satoshis?: number): void
    updateMetadata(metadata: Record<string, any>): void
    async fee(modelOrFee: FeeModel | number = LivePolicy.getInstance(), changeDistribution: "equal" | "random" = "equal"): Promise<void>
    #calculateChange(fee: number): number
    #distributeChange(change: number, changeDistribution: "equal" | "random"): void
    #distributeRandomChange(change: number, changeOutputs: TransactionOutput[]): void
    #distributeEqualChange(change: number, changeOutputs: TransactionOutput[]): void
    #benfordNumber(min: number, max: number): number
    getFee(): number
    async sign(options: {
        skipExistingSignatures?: boolean;
    } = {}): Promise<void>
    async broadcast(broadcaster: Broadcaster = defaultBroadcaster()): Promise<BroadcastResponse | BroadcastFailure>
    #writeTransactionBody(writer: Writer | WriterUint8Array): void
    #buildSerializedBytes(): Uint8Array
    #getSerializedBytes(): Uint8Array
    [serializedBytes](): Uint8Array
    [knownId](txid: string): void
    toBinary(): number[]
    toUint8Array(): Uint8Array
    #writeEF(writer: Writer | WriterUint8Array): void
    toEF(): number[]
    toEFUint8Array(): Uint8Array
    #getEFBytes(): Uint8Array
    toEFBinary(): Uint8Array
    toHexEF(): string
    toHex(): string
    toHexBEEF(): string
    toHexAtomicBEEF(): string
    hash(enc?: "hex"): number[] | string
    id(): number[];
    id(enc: "hex"): string;
    id(enc?: "hex"): number[] | string
    async #completeVerificationFromMerklePath(tx: Transaction, scriptsOnly: boolean, chainTracker: ChainTracker | "scripts only", getTxid: () => string, verifiedTransactions: Set<Transaction>, verifiedTxids: Set<string>): Promise<boolean>
    #validateUnminedTransactionStructure(tx: Transaction, getTxid: () => string): void
    #queueSourceTransactionForVerification(sourceTransaction: Transaction, sourceTxid: string, state: TransactionVerificationState): void
    #verifyTransactionInputs(tx: Transaction, useVerifier: boolean, getTxid: () => string, state: TransactionVerificationState): {
        valid: boolean;
        inputTotal: number;
    }
    #totalVerifiedOutputs(tx: Transaction): number
    async #verifyQueuedScripts(verifierQueue: QueuedScriptVerification[], selectedVerifier: BdkVerifierInterface | undefined): Promise<void>
    #isTransactionAlreadyVerified(tx: Transaction, getTxid: () => string, state: TransactionVerificationState): boolean
    #snapshotTransactionGraph(includeTemplates: boolean = false): Transaction
    #signingStateMatches(snapshot: Transaction, inputRefs: TransactionInput[], sourceRefs: Array<Transaction | undefined>, templateRefs: Array<TransactionInput["unlockingScriptTemplate"]>, outputRefs: TransactionOutput[]): boolean
    async #verifyUnminedTransaction(tx: Transaction, getTxid: () => string, context: UnminedTransactionVerificationContext): Promise<boolean>
    async verify(chainTracker: ChainTracker | "scripts only" = defaultChainTracker(), feeModel?: FeeModel, memoryLimit?: number, verifier?: BdkVerifierInterface): Promise<boolean>
    async #verifySnapshot(chainTracker: ChainTracker | "scripts only", feeModel?: FeeModel, memoryLimit?: number, verifier?: BdkVerifierInterface, scriptWork?: EvidenceScriptScope): Promise<boolean>
    writeSerializedBEEF(writer: Writer | WriterUint8Array, allowPartial?: boolean): void
    #collectBEEFTransactions(allowPartial?: boolean): {
        bumps: MerklePath[];
        txs: Array<{
            tx: Transaction;
            pathIndex?: number;
        }>;
    }
    #appendBEEFTransaction(tx: Transaction, seenTxids: Set<string>, txs: Array<{
        tx: Transaction;
        pathIndex?: number;
    }>, bumps: MerklePath[], bumpIndexByInstance: Map<MerklePath, number>, bumpIndexByRoot: Map<string, number>): void
    #scheduleBEEFTransaction(tx: Transaction, allowPartial: boolean | undefined, scheduledTxids: Set<string>, stack: Array<{
        tx: Transaction;
        expanded: boolean;
    }>): void
    #getBEEFPathIndex(merklePath: MerklePath, bumps: MerklePath[], bumpIndexByInstance: Map<MerklePath, number>, bumpIndexByRoot: Map<string, number>): number
    #reserveBEEFWriter(writer: Writer | WriterUint8Array, bumps: MerklePath[], txs: Array<{
        tx: Transaction;
        pathIndex?: number;
    }>): Uint8Array[] | undefined
    toBEEF(allowPartial?: boolean): number[]
    toBEEFUint8Array(allowPartial?: boolean): Uint8Array
    toBEEFBytes(allowPartial?: boolean): Uint8Array
    toAtomicBEEF(allowPartial?: boolean): number[]
    toAtomicBEEFUint8Array(allowPartial?: boolean): Uint8Array
    async completeWithWallet(wallet: WalletInterface, actionDescription?: DescriptionString5to50Bytes, originator?: string, options?: CreateActionOptions): Promise<void>
    async #buildWalletActionArgs(description: DescriptionString5to50Bytes, hasTemplates: boolean): Promise<CreateActionArgs>
    async #buildWalletInputArg(input: TransactionInput, index: number, hasTemplates: boolean): Promise<any>
    preimage(inputIndex?: number, signatureScope?: number, subscript?: LockingScript): number[]
}
```

See also: [BdkVerifierInterface](./transaction.md#interface-bdkverifierinterface), [Beef](./transaction.md#class-beef), [BroadcastFailure](./transaction.md#interface-broadcastfailure), [BroadcastResponse](./transaction.md#interface-broadcastresponse), [Broadcaster](./transaction.md#interface-broadcaster), [ChainTracker](./transaction.md#interface-chaintracker), [CreateActionArgs](./wallet.md#interface-createactionargs), [CreateActionOptions](./wallet.md#interface-createactionoptions), [DescriptionString5to50Bytes](./wallet.md#type-descriptionstring5to50bytes), [EvidenceScriptScope](./transaction.md#interface-evidencescriptscope), [FeeModel](./transaction.md#interface-feemodel), [LivePolicy](./transaction.md#class-livepolicy), [LockingScript](./script.md#class-lockingscript), [MerklePath](./transaction.md#class-merklepath), [Reader](./primitives.md#class-reader), [ReaderUint8Array](./primitives.md#class-readeruint8array), [SignatureHashCache](./primitives.md#interface-signaturehashcache), [TransactionInput](./transaction.md#interface-transactioninput), [TransactionOutput](./transaction.md#interface-transactionoutput), [WalletInterface](./wallet.md#interface-walletinterface), [Writer](./primitives.md#class-writer), [WriterUint8Array](./primitives.md#class-writeruint8array), [defaultBroadcaster](./transaction.md#function-defaultbroadcaster), [defaultChainTracker](./transaction.md#function-defaultchaintracker), [sign](./compat.md#variable-sign), [string](./remittance.md#function-string), [toHex](./primitives.md#variable-tohex), [toUint8Array](./primitives.md#variable-touint8array), [verify](./compat.md#variable-verify)

#### Method addInput

Adds a new input to the transaction.

```ts
addInput(input: TransactionInput): void
```
See also: [TransactionInput](./transaction.md#interface-transactioninput)

Argument Details

+ **input**
  + The TransactionInput object to add to the transaction.

Throws

- If the input does not have a sourceTXID or sourceTransaction defined.

#### Method addOutput

Adds a new output to the transaction.

```ts
addOutput(output: TransactionOutput): void
```
See also: [TransactionOutput](./transaction.md#interface-transactionoutput)

Argument Details

+ **output**
  + The TransactionOutput object to add to the transaction.

#### Method addP2PKHOutput

Adds a new P2PKH output to the transaction.

```ts
addP2PKHOutput(address: number[] | string, satoshis?: number): void
```
See also: [string](./remittance.md#function-string)

Argument Details

+ **address**
  + The P2PKH address of the output.
+ **satoshis**
  + The number of satoshis to send to the address - if not provided, the output is considered a change output.

#### Method broadcast

Broadcasts a transaction.

```ts
async broadcast(broadcaster: Broadcaster = defaultBroadcaster()): Promise<BroadcastResponse | BroadcastFailure>
```
See also: [BroadcastFailure](./transaction.md#interface-broadcastfailure), [BroadcastResponse](./transaction.md#interface-broadcastresponse), [Broadcaster](./transaction.md#interface-broadcaster), [defaultBroadcaster](./transaction.md#function-defaultbroadcaster)

Returns

A BroadcastResponse or BroadcastFailure from the Broadcaster

Argument Details

+ **broadcaster**
  + The Broadcaster instance wwhere the transaction will be sent

#### Method completeWithWallet

Completes the transaction using a wallet interface, which will handle
signing and transaction finalization. This method converts the current
transaction into a format that can be processed by the wallet, and then
updates this transaction object with the result from the wallet.

```ts
async completeWithWallet(wallet: WalletInterface, actionDescription?: DescriptionString5to50Bytes, originator?: string, options?: CreateActionOptions): Promise<void>
```
See also: [CreateActionOptions](./wallet.md#interface-createactionoptions), [DescriptionString5to50Bytes](./wallet.md#type-descriptionstring5to50bytes), [WalletInterface](./wallet.md#interface-walletinterface), [string](./remittance.md#function-string)

Argument Details

+ **wallet**
  + The BRC-100 compliant wallet to use for completing the transaction
+ **actionDescription**
  + Optional description for the action
+ **originator**
  + Optional originator domain name
+ **options**
  + Optional settings for transaction creation (e.g., acceptDelayedBroadcast, trustSelf, noSend, etc.)

#### Method fee

Computes fees prior to signing.
If no fee model is provided, uses a LivePolicy fee model that fetches current rates from ARC.
If fee is a number, the transaction uses that value as fee.

```ts
async fee(modelOrFee: FeeModel | number = LivePolicy.getInstance(), changeDistribution: "equal" | "random" = "equal"): Promise<void>
```
See also: [FeeModel](./transaction.md#interface-feemodel), [LivePolicy](./transaction.md#class-livepolicy)

Argument Details

+ **modelOrFee**
  + The initialized fee model to use or fixed fee for the transaction
+ **changeDistribution**
  + Specifies how the change should be distributed
amongst the change outputs

#### Method fromAtomicBEEF

Creates a new transaction from an Atomic BEEF (BRC-95) structure.
Extracts the subject transaction and supporting merkle path and source transactions contained in the BEEF data

```ts
static fromAtomicBEEF(beef: number[] | Uint8Array): Transaction
```
See also: [Transaction](./transaction.md#class-transaction)

Returns

The subject transaction, linked to its associated inputs populated with merkle paths.

Argument Details

+ **beef**
  + A binary representation of an Atomic BEEF structure.

#### Method fromBEEF

Creates a new transaction, linked to its inputs and their associated merkle paths, from a BEEF V1, V2 or Atomic.
Optionally, you can provide a specific TXID to retrieve a particular transaction from the BEEF data.
If the TXID is provided but not found in the BEEF data, an error will be thrown.
If no TXID is provided, the last transaction in the BEEF data is returned, or the atomic txid.

```ts
static fromBEEF(beef: number[] | Uint8Array, txid?: string): Transaction
```
See also: [Transaction](./transaction.md#class-transaction), [string](./remittance.md#function-string)

Returns

An anchored transaction, linked to its associated inputs populated with merkle paths.

Argument Details

+ **beef**
  + A binary representation of transactions in BEEF format.
+ **txid**
  + Optional TXID of the transaction to retrieve from the BEEF data.

#### Method fromBinary

Creates a Transaction instance from a binary array.

```ts
static fromBinary(bin: number[] | Uint8Array): Transaction
```
See also: [Transaction](./transaction.md#class-transaction)

Returns

- A new Transaction instance.

Argument Details

+ **bin**
  + The binary array representation of the transaction.

#### Method fromBinaryView

Parses a transaction while retaining zero-copy views over `bin` for the raw
transaction and its scripts. The caller must not mutate `bin`.

```ts
static fromBinaryView(bin: Uint8Array): Transaction
```
See also: [Transaction](./transaction.md#class-transaction)

#### Method fromEF

Creates a new transaction, linked to its inputs and their associated merkle paths, from a EF (BRC-30) structure.

EF source descriptors contain only a claimed source TXID, locking script,
and amount. They do not authenticate the complete source transaction or
prove that the described output exists or remains spendable. In an
adversarial environment the recipient must already be familiar with the
source information or independently verify it through trusted full
transaction and chain-state evidence before signing or authorizing value.

```ts
static fromEF(ef: number[] | Uint8Array): Transaction
```
See also: [Transaction](./transaction.md#class-transaction)

Returns

An extended transaction, linked to its associated inputs by locking script and satoshis amounts only.

Argument Details

+ **ef**
  + A binary representation of a transaction in EF format.

#### Method fromHex

Creates a Transaction instance from a hexadecimal string.

```ts
static fromHex(hex: string): Transaction
```
See also: [Transaction](./transaction.md#class-transaction), [string](./remittance.md#function-string)

Returns

- A new Transaction instance.

Argument Details

+ **hex**
  + The hexadecimal string representation of the transaction.

#### Method fromHexBEEF

Creates a Transaction instance from a hexadecimal string encoded BEEF.
Optionally, you can provide a specific TXID to retrieve a particular transaction from the BEEF data.
If the TXID is provided but not found in the BEEF data, an error will be thrown.
If no TXID is provided, the last transaction in the BEEF data is returned.

```ts
static fromHexBEEF(hex: string, txid?: string): Transaction
```
See also: [Transaction](./transaction.md#class-transaction), [string](./remittance.md#function-string)

Returns

- A new Transaction instance.

Argument Details

+ **hex**
  + The hexadecimal string representation of the transaction BEEF.
+ **txid**
  + Optional TXID of the transaction to retrieve from the BEEF data.

#### Method fromHexEF

Creates a Transaction instance from a hexadecimal string encoded EF.

```ts
static fromHexEF(hex: string): Transaction
```
See also: [Transaction](./transaction.md#class-transaction), [string](./remittance.md#function-string)

Returns

- A new Transaction instance.

Argument Details

+ **hex**
  + The hexadecimal string representation of the transaction EF.

#### Method getFee

Utility method that returns the current fee based on inputs and outputs

```ts
getFee(): number
```

Returns

The current transaction fee

#### Method getSignatureHashCache

Returns the transaction-wide signature hash cache active during signing.
Callers outside a signing operation receive an isolated cache.

```ts
getSignatureHashCache(): SignatureHashCache
```
See also: [SignatureHashCache](./primitives.md#interface-signaturehashcache)

#### Method hash

Calculates the transaction's hash.

```ts
hash(enc?: "hex"): number[] | string
```
See also: [string](./remittance.md#function-string)

Returns

- The hash of the transaction in the specified format.

Argument Details

+ **enc**
  + The encoding to use for the hash. If 'hex', returns a hexadecimal string; otherwise returns a binary array.

#### Method id

Calculates the transaction's ID in binary array.

```ts
id(): number[]
```

Returns

- The ID of the transaction in the binary array format.

#### Method id

Calculates the transaction's ID in hexadecimal format.

```ts
id(enc: "hex"): string
```
See also: [string](./remittance.md#function-string)

Returns

- The ID of the transaction in the hex format.

Argument Details

+ **enc**
  + The encoding to use for the ID. If 'hex', returns a hexadecimal string.

#### Method id

Calculates the transaction's ID.

```ts
id(enc?: "hex"): number[] | string
```
See also: [string](./remittance.md#function-string)

Returns

- The ID of the transaction in the specified format.

Argument Details

+ **enc**
  + The encoding to use for the ID. If 'hex', returns a hexadecimal string; otherwise returns a binary array.

#### Method materializeSourceTXIDs

Iteratively materializes source transaction IDs so deep spend chains do not
recurse through `hash()` while serializing their parents.

```ts
materializeSourceTXIDs(): void
```

#### Method parseScriptOffsets

Since the validation of blockchain data is atomically transaction data validation,
any application seeking to validate data in output scripts must store the entire transaction as well.
Since the transaction data includes the output script data, saving a second copy of potentially
large scripts can bloat application storage requirements.

This function efficiently parses binary transaction data to determine the offsets and lengths of each script.
This supports the efficient retreival of script data from transaction data.

```ts
static parseScriptOffsets(bin: number[] | Uint8Array): {
    inputs: Array<{
        vin: number;
        offset: number;
        length: number;
    }>;
    outputs: Array<{
        vout: number;
        offset: number;
        length: number;
    }>;
}
```

Returns

inputs: { vin: number, offset: number, length: number }[]
outputs: { vout: number, offset: number, length: number }[]
}

Argument Details

+ **bin**
  + binary transaction data

#### Method preimage

Returns the formatted preimage of a transaction for the requested input index, signature scope (default SIGHASH_FORKID | SIGHASH_ALL), and optional subscript.

```ts
preimage(inputIndex?: number, signatureScope?: number, subscript?: LockingScript): number[]
```
See also: [LockingScript](./script.md#class-lockingscript)

Returns

The formatted preimage

Argument Details

+ **inputIndex**
  + The index of the input to generate the preimage for
+ **signatureScope**
  + The signature scope to use for the preimage
+ **subscript**
  + The subscript to use for the preimage (optional)

#### Method sign

Signs a transaction, hydrating all its unlocking scripts based on the provided script templates where they are available.

```ts
async sign(options: {
    skipExistingSignatures?: boolean;
} = {}): Promise<void>
```

Argument Details

+ **options**
  + Signing behavior. Set `skipExistingSignatures` to preserve inputs that already have an unlocking script.

#### Method toAtomicBEEF

Serializes this transaction and its inputs into the Atomic BEEF (BRC-95) format.
The Atomic BEEF format starts with a 4-byte prefix `0x01010101`, followed by the TXID of the subject transaction,
and then the BEEF data containing only the subject transaction and its dependencies.
This format ensures that the BEEF structure is atomic and contains no unrelated transactions.

```ts
toAtomicBEEF(allowPartial?: boolean): number[]
```

Returns

- The serialized Atomic BEEF structure.

Argument Details

+ **allowPartial**
  + If true, error will not be thrown if there are any missing sourceTransactions.

Throws

Error if there are any missing sourceTransactions unless `allowPartial` is true.

#### Method toAtomicBEEFUint8Array

Serializes this transaction and its inputs into the Atomic BEEF (BRC-95) format.
The Atomic BEEF format starts with a 4-byte prefix `0x01010101`, followed by the TXID of the subject transaction,
and then the BEEF data containing only the subject transaction and its dependencies.
This format ensures that the BEEF structure is atomic and contains no unrelated transactions.

```ts
toAtomicBEEFUint8Array(allowPartial?: boolean): Uint8Array
```

Returns

- The serialized Atomic BEEF structure.

Argument Details

+ **allowPartial**
  + If true, error will not be thrown if there are any missing sourceTransactions.

Throws

Error if there are any missing sourceTransactions unless `allowPartial` is true.

#### Method toBEEF

Serializes this transaction, together with its inputs and the respective merkle proofs, into the BEEF (BRC-62) format. This enables efficient verification of its compliance with the rules of SPV.

```ts
toBEEF(allowPartial?: boolean): number[]
```

Returns

The serialized BEEF structure

Argument Details

+ **allowPartial**
  + If true, error will not be thrown if there are any missing sourceTransactions.

Throws

Error if there are any missing sourceTransactions unless `allowPartial` is true.

#### Method toBEEFBytes

Serializes BEEF to a real typed byte array.

```ts
toBEEFBytes(allowPartial?: boolean): Uint8Array
```

#### Method toBEEFUint8Array

Serializes this transaction, together with its inputs and the respective merkle proofs, into the BEEF (BRC-62) format. This enables efficient verification of its compliance with the rules of SPV.

```ts
toBEEFUint8Array(allowPartial?: boolean): Uint8Array
```

Returns

The serialized BEEF structure

Argument Details

+ **allowPartial**
  + If true, error will not be thrown if there are any missing sourceTransactions.

Throws

Error if there are any missing sourceTransactions unless `allowPartial` is true.

#### Method toBinary

Converts the transaction to a binary array format.

```ts
toBinary(): number[]
```

Returns

- The binary array representation of the transaction.

#### Method toEF

Converts the transaction to a BRC-30 EF format.

```ts
toEF(): number[]
```

Returns

- The BRC-30 EF representation of the transaction.

#### Method toEFBinary

Converts the transaction to an independently owned BRC-30 EF byte array.

```ts
toEFBinary(): Uint8Array
```

Returns

The cached BRC-30 EF representation.

#### Method toEFUint8Array

Converts the transaction to a BRC-30 EF format.

```ts
toEFUint8Array(): Uint8Array
```

Returns

- The BRC-30 EF representation of the transaction.

#### Method toHex

Converts the transaction to a hexadecimal string format.

```ts
toHex(): string
```
See also: [string](./remittance.md#function-string)

Returns

- The hexadecimal string representation of the transaction.

#### Method toHexAtomicBEEF

Converts the transaction to a hexadecimal string Atomic BEEF.

```ts
toHexAtomicBEEF(): string
```
See also: [string](./remittance.md#function-string)

Returns

- The hexadecimal string representation of the transaction Atomic BEEF.

#### Method toHexBEEF

Converts the transaction to a hexadecimal string BEEF.

```ts
toHexBEEF(): string
```
See also: [string](./remittance.md#function-string)

Returns

- The hexadecimal string representation of the transaction BEEF.

#### Method toHexEF

Converts the transaction to a hexadecimal string EF.

```ts
toHexEF(): string
```
See also: [string](./remittance.md#function-string)

Returns

- The hexadecimal string representation of the transaction EF.

#### Method updateMetadata

Updates the transaction's metadata.

```ts
updateMetadata(metadata: Record<string, any>): void
```
See also: [string](./remittance.md#function-string)

Argument Details

+ **metadata**
  + The metadata object to merge into the existing metadata.

#### Method verify

Verifies the legitimacy of the Bitcoin transaction according to the rules of SPV by ensuring all the input transactions link back to valid block headers, the chain of spends for all inputs are valid, and the sum of inputs is not less than the sum of outputs.

```ts
async verify(chainTracker: ChainTracker | "scripts only" = defaultChainTracker(), feeModel?: FeeModel, memoryLimit?: number, verifier?: BdkVerifierInterface): Promise<boolean>
```
See also: [BdkVerifierInterface](./transaction.md#interface-bdkverifierinterface), [ChainTracker](./transaction.md#interface-chaintracker), [FeeModel](./transaction.md#interface-feemodel), [defaultChainTracker](./transaction.md#function-defaultchaintracker)

Returns

Whether the transaction is valid according to the rules of SPV.

Argument Details

+ **chainTracker**
  + An instance of ChainTracker, a Bitcoin block header tracker. If the value is set to 'scripts only', headers will not be verified. If not provided then the default chain tracker will be used.
+ **feeModel**
  + An instance of FeeModel, a fee model to use for fee calculation. If not provided then the default fee model will be used.
+ **memoryLimit**
  + Optional caller-supplied local script-interpreter
memory budget. If omitted, post-Genesis validation does not impose an
arbitrary SDK memory cap.
+ **verifier**
  + An optional asynchronous script backend. Adaptive backends may decline before execution to preserve the JavaScript path.

Example

```ts
tx.verify(new WhatsOnChain(), LivePolicy.getInstance())
```

#### Method writeSerializedBEEF

Serializes this transaction, together with its inputs and the respective merkle proofs, into the BEEF (BRC-62) format. This enables efficient verification of its compliance with the rules of SPV.

```ts
writeSerializedBEEF(writer: Writer | WriterUint8Array, allowPartial?: boolean): void
```
See also: [Writer](./primitives.md#class-writer), [WriterUint8Array](./primitives.md#class-writeruint8array)

Returns

The serialized BEEF structure

Argument Details

+ **writer**
  + The writer to serialize to
+ **allowPartial**
  + If true, error will not be thrown if there are any missing sourceTransactions.

Throws

Error if there are any missing sourceTransactions unless `allowPartial` is true.

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Class: TransactionEvidenceCoordinator

Bounded, process-local transaction evidence work sharing. This is independent of
lookup services, certificates and trust ratings. Positive reuse always checks
canonical anchors again; ChainTracker remains the caller's trusted chain source.
Synchronous parsing/script execution is byte/memory bounded, not preemptible.

```ts
export class TransactionEvidenceCoordinator {
    readonly limits: Readonly<TransactionEvidenceLimits>;
    constructor(options: TransactionEvidenceCoordinatorOptions)
    setContext(context: TransactionEvidenceContext): void
    dispose(): void
    async verify(evidence: TransactionEvidence, options: {
        signal?: AbortSignal;
    } = {}): Promise<VerifiedTransactionOutput>
    getStats(): {
        pendingTransactions: number;
        consumers: number;
        cachedTransactions: number;
        retainedBytes: number;
        pendingChainCalls: number;
        activeAttempts: number;
    }
}
```

See also: [TransactionEvidence](./transaction.md#interface-transactionevidence), [TransactionEvidenceContext](./transaction.md#interface-transactionevidencecontext), [TransactionEvidenceCoordinatorOptions](./transaction.md#interface-transactionevidencecoordinatoroptions), [TransactionEvidenceLimits](./transaction.md#interface-transactionevidencelimits), [VerifiedTransactionOutput](./transaction.md#interface-verifiedtransactionoutput), [verify](./compat.md#variable-verify)

#### Method getStats

Payload-free local diagnostics; pending calls include abandoned, non-abortable I/O.

```ts
getStats(): {
    pendingTransactions: number;
    consumers: number;
    cachedTransactions: number;
    retainedBytes: number;
    pendingChainCalls: number;
    activeAttempts: number;
}
```

#### Method setContext

Explicit session/network/policy change. Stale in-flight work cannot publish.

```ts
setContext(context: TransactionEvidenceContext): void
```
See also: [TransactionEvidenceContext](./transaction.md#interface-transactionevidencecontext)

#### Method verify

Snapshot intake is synchronous up to the returned Promise's first await.

```ts
async verify(evidence: TransactionEvidence, options: {
    signal?: AbortSignal;
} = {}): Promise<VerifiedTransactionOutput>
```
See also: [TransactionEvidence](./transaction.md#interface-transactionevidence), [VerifiedTransactionOutput](./transaction.md#interface-verifiedtransactionoutput)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Class: TransactionEvidenceError

Bounded, payload-free outcome; rejected receipts never permanently reject a txid.

```ts
export class TransactionEvidenceError extends Error {
    constructor(public readonly code: TransactionEvidenceErrorCode)
}
```

See also: [TransactionEvidenceErrorCode](./transaction.md#type-transactionevidenceerrorcode)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Class: WhatsOnChain

Represents a chain tracker based on What's On Chain .

```ts
export default class WhatsOnChain implements ChainTracker {
    readonly network: string;
    readonly apiKey: string;
    protected readonly URL: string;
    protected readonly httpClient: HttpClient;
    constructor(network: "main" | "test" | "stn" = "main", config: WhatsOnChainConfig = {})
    async isValidRootForHeight(root: string, height: number): Promise<boolean>
    async currentHeight(): Promise<number>
    protected getHttpHeaders(): Record<string, string>
}
```

See also: [ChainTracker](./transaction.md#interface-chaintracker), [HttpClient](./transaction.md#interface-httpclient), [WhatsOnChainConfig](./transaction.md#interface-whatsonchainconfig), [string](./remittance.md#function-string)

#### Constructor

Constructs an instance of the WhatsOnChain ChainTracker.

```ts
constructor(network: "main" | "test" | "stn" = "main", config: WhatsOnChainConfig = {})
```
See also: [WhatsOnChainConfig](./transaction.md#interface-whatsonchainconfig)

Argument Details

+ **network**
  + The BSV network to use when calling the WhatsOnChain API.
+ **config**
  + Configuration options for the WhatsOnChain ChainTracker.

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
## Functions

| | | |
| --- | --- | --- |
| [assertEvidenceUnchanged](#function-assertevidenceunchanged) | [isBroadcastResponse](#function-isbroadcastresponse) | [scopedScriptBackend](#function-scopedscriptbackend) |
| [cacheKnownTransactionId](#function-cacheknowntransactionid) | [isChainTracker](#function-ischaintracker) | [scriptVerificationBackend](#function-scriptverificationbackend) |
| [defaultBroadcaster](#function-defaultbroadcaster) | [lockConfiguration](#function-lockconfiguration) | [timedRequestSignal](#function-timedrequestsignal) |
| [defaultChainTracker](#function-defaultchaintracker) | [normalizeArcConfig](#function-normalizearcconfig) | [transactionSerializationIdentity](#function-transactionserializationidentity) |
| [defaultHttpClient](#function-defaulthttpclient) | [normalizeArcUrl](#function-normalizearcurl) | [unregisterScriptVerificationBackend](#function-unregisterscriptverificationbackend) |
| [evidenceError](#function-evidenceerror) | [normalizeHttpClientLimits](#function-normalizehttpclientlimits) | [validateBroadcastResult](#function-validatebroadcastresult) |
| [evidenceScriptScope](#function-evidencescriptscope) | [parseEvidence](#function-parseevidence) | [withEvidenceScriptWork](#function-withevidencescriptwork) |
| [executeNodejsRequest](#function-executenodejsrequest) | [readFetchResponseText](#function-readfetchresponsetext) |  |
| [isBroadcastFailure](#function-isbroadcastfailure) | [registerScriptVerificationBackend](#function-registerscriptverificationbackend) |  |

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---

### Function: assertEvidenceUnchanged

Fence all owned transaction/proof bytes, including backend readiness callbacks.

```ts
export function assertEvidenceUnchanged(candidate: EvidenceCandidate): void
```

See also: [EvidenceCandidate](./transaction.md#interface-evidencecandidate)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Function: cacheKnownTransactionId

```ts
export function cacheKnownTransactionId(transaction: Transaction, txid: string): void
```

See also: [Transaction](./transaction.md#class-transaction), [string](./remittance.md#function-string)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Function: defaultBroadcaster

```ts
export function defaultBroadcaster(isTestnet: boolean = false, config: ArcConfig = {}): Broadcaster
```

See also: [ArcConfig](./transaction.md#interface-arcconfig), [Broadcaster](./transaction.md#interface-broadcaster)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Function: defaultChainTracker

```ts
export function defaultChainTracker(): ChainTracker
```

See also: [ChainTracker](./transaction.md#interface-chaintracker)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Function: defaultHttpClient

Returns a default HttpClient implementation based on the environment that it is run on.
This method will attempt to use `window.fetch` if available (in browser environments),
then `globalThis.fetch` (service workers, Deno, Node 18+), then the Node `https` module.

```ts
export function defaultHttpClient(): HttpClient
```

See also: [HttpClient](./transaction.md#interface-httpclient)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Function: evidenceError

Keep bounded-work outcomes distinct without exposing errors containing evidence.

```ts
export function evidenceError(error: unknown): TransactionEvidenceError
```

See also: [TransactionEvidenceError](./transaction.md#class-transactionevidenceerror)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Function: evidenceScriptScope

```ts
export function evidenceScriptScope(tx: Transaction): EvidenceScriptScope | undefined
```

See also: [EvidenceScriptScope](./transaction.md#interface-evidencescriptscope), [Transaction](./transaction.md#class-transaction)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Function: executeNodejsRequest

Shared implementation for handling Node.js HTTP requests.
Used by both NodejsHttpClient and BinaryNodejsHttpClient.

```ts
export function executeNodejsRequest(https: HttpsModuleLike, url: string, requestOptions: HttpClientRequestOptions, serializeData: (data: any) => any): Promise<HttpClientResponse>
```

See also: [HttpClientRequestOptions](./transaction.md#interface-httpclientrequestoptions), [HttpClientResponse](./transaction.md#type-httpclientresponse), [HttpsModuleLike](./transaction.md#interface-httpsmodulelike), [string](./remittance.md#function-string)

Argument Details

+ **https**
  + The Node.js https module (or compatible)
+ **url**
  + The URL to make the request to
+ **requestOptions**
  + The request configuration
+ **serializeData**
  + Function to serialize the request data for writing

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Function: isBroadcastFailure

Convenience type guard for response from `Broadcaster.broadcast`

```ts
export function isBroadcastFailure(r: BroadcastResponse | BroadcastFailure): r is BroadcastFailure
```

See also: [BroadcastFailure](./transaction.md#interface-broadcastfailure), [BroadcastResponse](./transaction.md#interface-broadcastresponse)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Function: isBroadcastResponse

Convenience type guard for response from `Broadcaster.broadcast`

```ts
export function isBroadcastResponse(r: BroadcastResponse | BroadcastFailure): r is BroadcastResponse
```

See also: [BroadcastFailure](./transaction.md#interface-broadcastfailure), [BroadcastResponse](./transaction.md#interface-broadcastresponse)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Function: isChainTracker

Convenience type guard for a `ChainTracker` implementation.
Optional verification-context methods are not required.

```ts
export function isChainTracker(value: unknown): value is ChainTracker
```

See also: [ChainTracker](./transaction.md#interface-chaintracker)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Function: lockConfiguration

Makes constructor-owned configuration effective at runtime as well as at
compile time. TypeScript's `readonly` modifier alone does not prevent a
JavaScript caller from replacing a provider URL, credential, or client.

```ts
export function lockConfiguration(target: object, names: string[]): void
```

See also: [string](./remittance.md#function-string)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Function: normalizeArcConfig

Snapshot security-relevant ARC constructor configuration exactly once.

```ts
export function normalizeArcConfig(config: string | ArcConfig | undefined, defaultDeploymentId: () => string): NormalizedArcConfig
```

See also: [ArcConfig](./transaction.md#interface-arcconfig), [NormalizedArcConfig](./transaction.md#interface-normalizedarcconfig), [string](./remittance.md#function-string)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Function: normalizeArcUrl

Require a stable, bounded primitive URL without changing caller-selected endpoint authority.

```ts
export function normalizeArcUrl(value: unknown): string
```

See also: [string](./remittance.md#function-string)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Function: normalizeHttpClientLimits

```ts
export function normalizeHttpClientLimits(limits: HttpClientLimits = {}): Required<HttpClientLimits>
```

See also: [HttpClientLimits](./transaction.md#interface-httpclientlimits)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Function: parseEvidence

```ts
export function parseEvidence(evidence: TransactionEvidence, limits: TransactionEvidenceLimits): EvidenceCandidate
```

See also: [EvidenceCandidate](./transaction.md#interface-evidencecandidate), [TransactionEvidence](./transaction.md#interface-transactionevidence), [TransactionEvidenceLimits](./transaction.md#interface-transactionevidencelimits)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Function: readFetchResponseText

```ts
export async function readFetchResponseText(response: Response, maximumBytes: number): Promise<string>
```

See also: [string](./remittance.md#function-string)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Function: registerScriptVerificationBackend

Installs a process/page-wide optional script backend.

```ts
export function registerScriptVerificationBackend(backend: ScriptVerificationBackend): void
```

See also: [ScriptVerificationBackend](./transaction.md#type-scriptverificationbackend)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Function: scopedScriptBackend

```ts
export function scopedScriptBackend(scope: EvidenceScriptScope, backend: BdkVerifierInterface): BdkVerifierInterface
```

See also: [BdkVerifierInterface](./transaction.md#interface-bdkverifierinterface), [EvidenceScriptScope](./transaction.md#interface-evidencescriptscope)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Function: scriptVerificationBackend

Returns the currently registered optional script backend, if any.

```ts
export function scriptVerificationBackend(): ScriptVerificationBackend | undefined
```

See also: [ScriptVerificationBackend](./transaction.md#type-scriptverificationbackend)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Function: timedRequestSignal

```ts
export function timedRequestSignal(parent: AbortSignal | undefined, timeoutMs: number): {
    signal: AbortSignal;
    dispose(): void;
}
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Function: transactionSerializationIdentity

```ts
export function transactionSerializationIdentity(transaction: Transaction): Uint8Array
```

See also: [Transaction](./transaction.md#class-transaction)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Function: unregisterScriptVerificationBackend

Removes `backend` if it is still the active optional implementation.

```ts
export function unregisterScriptVerificationBackend(backend: ScriptVerificationBackend): void
```

See also: [ScriptVerificationBackend](./transaction.md#type-scriptverificationbackend)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Function: validateBroadcastResult

Validates and owns the security-relevant fields returned by a broadcaster.
A success is accepted only when it acknowledges the exact submitted transaction.

```ts
export function validateBroadcastResult(result: unknown, expectedTxid: string): BroadcastResponse | BroadcastFailure
```

See also: [BroadcastFailure](./transaction.md#interface-broadcastfailure), [BroadcastResponse](./transaction.md#interface-broadcastresponse), [string](./remittance.md#function-string)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Function: withEvidenceScriptWork

```ts
export async function withEvidenceScriptWork<T>(tx: Transaction, scope: EvidenceScriptScope, verify: () => Promise<T>): Promise<T>
```

See also: [EvidenceScriptScope](./transaction.md#interface-evidencescriptscope), [Transaction](./transaction.md#class-transaction), [verify](./compat.md#variable-verify)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
## Types

| |
| --- |
| [Fetch](#type-fetch) |
| [HttpClientResponse](#type-httpclientresponse) |
| [ScriptVerificationBackend](#type-scriptverificationbackend) |
| [TransactionEvidenceErrorCode](#type-transactionevidenceerrorcode) |

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---

### Type: Fetch

fetch function interface limited to options needed by ts-sdk

Makes a request to the server.

```ts
export type Fetch = (url: string, options: FetchOptions) => Promise<Response>
```

See also: [FetchOptions](./transaction.md#interface-fetchoptions), [string](./remittance.md#function-string)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Type: HttpClientResponse

An interface for the response returned by the request method.

```ts
export type HttpClientResponse<T = any> = {
    data: T;
    status: number;
    statusText: string;
    ok: true;
} | {
    data: any;
    status: number;
    statusText: string;
    ok: false;
}
```

See also: [string](./remittance.md#function-string)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Type: ScriptVerificationBackend

Backend shape shared by transaction-graph and individual-Spend routing.

```ts
export type ScriptVerificationBackend = BdkVerifierInterface & SpendVerifierInterface
```

See also: [BdkVerifierInterface](./transaction.md#interface-bdkverifierinterface), [SpendVerifierInterface](./script.md#interface-spendverifierinterface)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Type: TransactionEvidenceErrorCode

```ts
export type TransactionEvidenceErrorCode = "invalid-evidence" | "limit" | "cancelled" | "timeout" | "context-changed" | "disposed"
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
## Enums

### Enum: TX_DATA_FORMAT

```ts
export enum TX_DATA_FORMAT {
    RAWTX = 0,
    RAWTX_AND_BUMP_INDEX = 1,
    TXID_ONLY = 2
}
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
## Variables

| |
| --- |
| [ATOMIC_BEEF](#variable-atomic_beef) |
| [BEEF_V1](#variable-beef_v1) |
| [BEEF_V2](#variable-beef_v2) |
| [DEFAULT_HTTP_CLIENT_MAX_RESPONSE_BYTES](#variable-default_http_client_max_response_bytes) |
| [DEFAULT_HTTP_CLIENT_TIMEOUT_MS](#variable-default_http_client_timeout_ms) |
| [defaultTransactionEvidenceLimits](#variable-defaulttransactionevidencelimits) |

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---

### Variable: ATOMIC_BEEF

```ts
ATOMIC_BEEF = 16843009
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Variable: BEEF_V1

```ts
BEEF_V1 = 4022206465
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Variable: BEEF_V2

```ts
BEEF_V2 = 4022206466
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Variable: DEFAULT_HTTP_CLIENT_MAX_RESPONSE_BYTES

```ts
DEFAULT_HTTP_CLIENT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Variable: DEFAULT_HTTP_CLIENT_TIMEOUT_MS

```ts
DEFAULT_HTTP_CLIENT_TIMEOUT_MS = 30000
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Variable: defaultTransactionEvidenceLimits

```ts
defaultTransactionEvidenceLimits: Readonly<TransactionEvidenceLimits> = Object.freeze({
    candidateBytes: 1024 * 1024,
    retainedBytes: 16 * 1024 * 1024,
    transactions: 256,
    inputs: 4096,
    scriptBytes: 256 * 1024,
    scriptMemoryBytes: 16 * 1024 * 1024,
    candidatesPerTransaction: 8,
    pendingTransactions: 32,
    concurrentTransactions: 4,
    pendingChainCalls: 8,
    consumers: 128,
    cacheEntries: 128,
    cacheAgeMs: 60000,
    attemptTimeoutMs: 5000,
    requestTimeoutMs: 15000
})
```

See also: [TransactionEvidenceLimits](./transaction.md#interface-transactionevidencelimits)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
