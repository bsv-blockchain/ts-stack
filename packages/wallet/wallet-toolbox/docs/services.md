# SERVICES: BSV Wallet Toolbox API Documentation

The documentation is split into various pages, this page covers the [Services](#class-services) and related API.

To function properly, a wallet makes use of a variety of services provided by the network:

1. Broadcast new transactions.
1. Verify the validity of unspent outputs.
1. Obtain mined transaction proofs.
2. Obtain block headers for proof validation.
3. Obtain exchange rates for UI and fee calculations.

These tasks are the responsibility of the [Services](#class-services) class.

[Return To Top](./README.md)

<!--#region ts2md-api-merged-here-->
### API

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

#### Interfaces

| | | |
| --- | --- | --- |
| [ArcConfig](#interface-arcconfig) | [ChaintracksBulkDataStatsApi](#interface-chaintracksbulkdatastatsapi) | [GetHeaderByteFileLinksResult](#interface-getheaderbytefilelinksresult) |
| [ArcMinerGetTxData](#interface-arcminergettxdata) | [ChaintracksChainTrackerOptions](#interface-chaintrackschaintrackeroptions) | [GoChaintracksServiceClientOptions](#interface-gochaintracksserviceclientoptions) |
| [ArcSSEClientOptions](#interface-arcsseclientoptions) | [ChaintracksClientApi](#interface-chaintracksclientapi) | [HeightRangeApi](#interface-heightrangeapi) |
| [ArcSSEEvent](#interface-arcsseevent) | [ChaintracksDownloadOptions](#interface-chaintracksdownloadoptions) | [HeightRanges](#interface-heightranges) |
| [ArcadeLifecycleStatus](#interface-arcadelifecyclestatus) | [ChaintracksFetchApi](#interface-chaintracksfetchapi) | [LiveBlockHeader](#interface-liveblockheader) |
| [ArcadeRejectionClassification](#interface-arcaderejectionclassification) | [ChaintracksFetchOptions](#interface-chaintracksfetchoptions) | [LiveIngestorApi](#interface-liveingestorapi) |
| [BitailsConfig](#interface-bitailsconfig) | [ChaintracksFsApi](#interface-chaintracksfsapi) | [LiveIngestorBaseOptions](#interface-liveingestorbaseoptions) |
| [BitailsMerkleProof](#interface-bitailsmerkleproof) | [ChaintracksInfoApi](#interface-chaintracksinfoapi) | [LiveIngestorChaintracksSSEOptions](#interface-liveingestorchaintrackssseoptions) |
| [BulkFileDataCacheApi](#interface-bulkfiledatacacheapi) | [ChaintracksIngestorParams](#interface-chaintracksingestorparams) | [LiveIngestorWhatsOnChainOptions](#interface-liveingestorwhatsonchainoptions) |
| [BulkFileDataCacheFsOptions](#interface-bulkfiledatacachefsoptions) | [ChaintracksManagementApi](#interface-chaintracksmanagementapi) | [LocalChainTrackerOptions](#interface-localchaintrackeroptions) |
| [BulkFileDataManagerMergeResult](#interface-bulkfiledatamanagermergeresult) | [ChaintracksOptions](#interface-chaintracksoptions) | [LocalChainTrackerRecoveryEvidence](#interface-localchaintrackerrecoveryevidence) |
| [BulkFileDataManagerOptions](#interface-bulkfiledatamanageroptions) | [ChaintracksPackageInfoApi](#interface-chaintrackspackageinfoapi) | [LocalChainTrackerStatus](#interface-localchaintrackerstatus) |
| [BulkFileDataManagerStats](#interface-bulkfiledatamanagerstats) | [ChaintracksReadableFileApi](#interface-chaintracksreadablefileapi) | [MerklePathNote](#interface-merklepathnote) |
| [BulkFileDataValidationRequest](#interface-bulkfiledatavalidationrequest) | [ChaintracksServiceClientOptions](#interface-chaintracksserviceclientoptions) | [MerkleRootValidator](#interface-merklerootvalidator) |
| [BulkFileDataValidationResult](#interface-bulkfiledatavalidationresult) | [ChaintracksServiceOptions](#interface-chaintracksserviceoptions) | [NodeBulkFileDataValidatorOptions](#interface-nodebulkfiledatavalidatoroptions) |
| [BulkFileDataValidatorApi](#interface-bulkfiledatavalidatorapi) | [ChaintracksSourceOptions](#interface-chaintrackssourceoptions) | [NormalizedArcProviderConfig](#interface-normalizedarcproviderconfig) |
| [BulkFileDataValidatorStats](#interface-bulkfiledatavalidatorstats) | [ChaintracksSourceStatusApi](#interface-chaintrackssourcestatusapi) | [OutputUtxoClassification](#interface-outpututxoclassification) |
| [BulkFileDownloadBudgetApi](#interface-bulkfiledownloadbudgetapi) | [ChaintracksStorageApi](#interface-chaintracksstorageapi) | [ResolvedDefaultChaintracksParams](#interface-resolveddefaultchaintracksparams) |
| [BulkFileDownloadBudgetSnapshot](#interface-bulkfiledownloadbudgetsnapshot) | [ChaintracksStorageBaseOptions](#interface-chaintracksstoragebaseoptions) | [ResolvedDefaultKnexChaintracksParams](#interface-resolveddefaultknexchaintracksparams) |
| [BulkHeaderFileInfo](#interface-bulkheaderfileinfo) | [ChaintracksStorageBulkFileApi](#interface-chaintracksstoragebulkfileapi) | [ScriptHashHistoryResponse](#interface-scripthashhistoryresponse) |
| [BulkHeaderFilesInfo](#interface-bulkheaderfilesinfo) | [ChaintracksStorageIdbOptions](#interface-chaintracksstorageidboptions) | [ServiceCall](#interface-servicecall) |
| [BulkIngestorApi](#interface-bulkingestorapi) | [ChaintracksStorageIdbSchema](#interface-chaintracksstorageidbschema) | [ServiceToCall](#interface-servicetocall) |
| [BulkIngestorBaseOptions](#interface-bulkingestorbaseoptions) | [ChaintracksStorageIngestApi](#interface-chaintracksstorageingestapi) | [SnapshotMerklePathResult](#interface-snapshotmerklepathresult) |
| [BulkIngestorCDNOptions](#interface-bulkingestorcdnoptions) | [ChaintracksStorageKnexOptions](#interface-chaintracksstorageknexoptions) | [StopListenerToken](#interface-stoplistenertoken) |
| [BulkIngestorChaintracksOptions](#interface-bulkingestorchaintracksoptions) | [ChaintracksStorageMemoryOptions](#interface-chaintracksstoragememoryoptions) | [ValidatedMerklePathResult](#interface-validatedmerklepathresult) |
| [BulkIngestorWhatsOnChainOptions](#interface-bulkingestorwhatsonchainoptions) | [ChaintracksStorageNoDbOptions](#interface-chaintracksstoragenodboptions) | [ValidatedPostBeefRequest](#interface-validatedpostbeefrequest) |
| [BulkStorageApi](#interface-bulkstorageapi) | [ChaintracksStorageQueryApi](#interface-chaintracksstoragequeryapi) | [WalletToolboxWhatsOnChainConfig](#interface-wallettoolboxwhatsonchainconfig) |
| [BulkStorageBaseOptions](#interface-bulkstoragebaseoptions) | [ChaintracksWritableFileApi](#interface-chaintrackswritablefileapi) | [WhatsOnChainServicesOptions](#interface-whatsonchainservicesoptions) |
| [BulkSyncResult](#interface-bulksyncresult) | [CreatedChaintracks](#interface-createdchaintracks) | [WocChainInfo](#interface-wocchaininfo) |
| [ChaintracksApi](#interface-chaintracksapi) | [DurableFileBulkFileDownloadBudgetOptions](#interface-durablefilebulkfiledownloadbudgetoptions) | [WocGetHeaderByteFileLinks](#interface-wocgetheaderbytefilelinks) |
| [ChaintracksAppendableFileApi](#interface-chaintracksappendablefileapi) | [ExchangeRatesIoApi](#interface-exchangeratesioapi) | [WocGetHeadersHeader](#interface-wocgetheadersheader) |
| [ChaintracksAvailabilitySnapshotApi](#interface-chaintracksavailabilitysnapshotapi) | [FixedWindowBulkFileDownloadBudgetOptions](#interface-fixedwindowbulkfiledownloadbudgetoptions) | [WocHeader](#interface-wocheader) |

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---

##### Interface: ArcConfig

Configuration options shared by ARC-compatible broadcasters.

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

###### Property apiKey

Authentication token for the ARC API.

```ts
apiKey?: string
```

###### Property callbackToken

Access token sent to the configured notification callback.

```ts
callbackToken?: string
```

###### Property callbackUrl

Notification callback endpoint for proofs and double-spend notifications.

```ts
callbackUrl?: string
```

###### Property deploymentId

Deployment id sent in the XDeployment-ID header.

```ts
deploymentId?: string
```

###### Property headers

Additional request headers, snapshotted when the provider is constructed.

```ts
headers?: Record<string, string>
```

###### Property httpClient

The explicitly trusted HTTP adapter used to make provider requests.

```ts
httpClient?: HttpClient
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: ArcMinerGetTxData

```ts
export interface ArcMinerGetTxData {
    status: number;
    title: string;
    blockHash: string;
    blockHeight: number;
    competingTxs: null | string[];
    extraInfo: string;
    merklePath: string;
    timestamp: string;
    txid: string;
    txStatus: string;
}
```

See also: [blockHash](./services.md#function-blockhash)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: ArcSSEClientOptions

```ts
export interface ArcSSEClientOptions {
    baseUrl: string;
    callbackToken: string;
    arcApiKey?: string;
    onEvent: (event: ArcSSEEvent) => void | Promise<void>;
    onError?: (error: Error) => void | Promise<void>;
    lastEventId?: string;
    onLastEventIdChanged?: (lastEventId: string) => void | Promise<void>;
    maxEventBytes?: number;
    maxPendingEvents?: number;
    maxPendingBytes?: number;
    log?: (message: string) => void;
    EventSourceClass: any;
}
```

See also: [ArcSSEEvent](./services.md#interface-arcsseevent)

###### Property EventSourceClass

The react-native-sse EventSource class — passed in to avoid import from wallet-toolbox

```ts
EventSourceClass: any
```

###### Property arcApiKey

Server-level API key for Authorization header (from ArcConfig.apiKey)

```ts
arcApiKey?: string
```

###### Property baseUrl

Base URL of the Arcade instance (e.g. "https://arcade-us-1.bsvb.tech")

```ts
baseUrl: string
```

###### Property callbackToken

Stable per-wallet token matching the X-CallbackToken sent on broadcast

```ts
callbackToken: string
```

###### Property lastEventId

Initial lastEventId for catchup

```ts
lastEventId?: string
```

###### Property log

Optional fixed-message operational logger. The client is silent by default.

```ts
log?: (message: string) => void
```

###### Property maxEventBytes

Maximum UTF-8 bytes admitted for one status event. Default: 262144; maximum: 8388608.

```ts
maxEventBytes?: number
```

###### Property maxPendingBytes

Maximum aggregate bytes retained while earlier work commits. Default: 4194304; maximum: 67108864.

```ts
maxPendingBytes?: number
```

###### Property maxPendingEvents

Maximum received events retained while earlier work commits. Default: 64; maximum: 4096.

```ts
maxPendingEvents?: number
```

###### Property onError

Called when a connection or processing error occurs. Callback failures are contained.

```ts
onError?: (error: Error) => void | Promise<void>
```

###### Property onEvent

Called for each status event received; resolution acknowledges durable processing.

```ts
onEvent: (event: ArcSSEEvent) => void | Promise<void>
```
See also: [ArcSSEEvent](./services.md#interface-arcsseevent)

###### Property onLastEventIdChanged

Called after event processing and before lastEventId advances.

```ts
onLastEventIdChanged?: (lastEventId: string) => void | Promise<void>
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: ArcSSEEvent

```ts
export interface ArcSSEEvent {
    txid: string;
    txStatus: string;
    timestamp: string;
    eventId?: string;
    status?: number;
    extraInfo?: string;
    blockHash?: string;
    blockHeight?: number;
    merklePath?: string;
}
```

See also: [blockHash](./services.md#function-blockhash)

###### Property eventId

Transport cursor attached by ArcSSEClient; not part of Arcade's JSON payload.

```ts
eventId?: string
```

###### Property extraInfo

Arcade's validator or network rejection detail.

```ts
extraInfo?: string
```

###### Property status

ARC rejection code supplied by Arcade for classifiable REJECTED events.

```ts
status?: number
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: ArcadeLifecycleStatus

```ts
export interface ArcadeLifecycleStatus {
    txStatus: string;
    status?: number;
    extraInfo?: string;
}
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: ArcadeRejectionClassification

```ts
export interface ArcadeRejectionClassification {
    terminal: boolean;
    inputConflict: boolean;
    reqStatus: "invalid" | "doubleSpend";
    reason: string;
}
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: BitailsConfig

```ts
export interface BitailsConfig {
    apiKey?: string;
    httpClient?: HttpClient;
    requestTimeoutMsecs?: number;
}
```

###### Property apiKey

Authentication token for BitTails API

```ts
apiKey?: string
```

###### Property httpClient

The HTTP client used to make requests to the API.

```ts
httpClient?: HttpClient
```

###### Property requestTimeoutMsecs

Whole-request deadline applied to Bitails calls. Defaults to 30 seconds.

```ts
requestTimeoutMsecs?: number
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: BitailsMerkleProof

```ts
export interface BitailsMerkleProof {
    index: number;
    txOrId: string;
    target: string;
    nodes: string[];
}
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: BulkFileDataCacheApi

Persistent backing cache for immutable bulk-header objects.

Implementations may read packaged checkpoint assets, application storage,
or a filesystem. The manager validates the byte length and SHA-256 digest
before using any returned value or persisting a downloaded value.

```ts
export interface BulkFileDataCacheApi {
    get(file: Readonly<BulkHeaderFileInfo>): Promise<Uint8Array | undefined>;
    set(file: Readonly<BulkHeaderFileInfo>, data: Uint8Array): Promise<void>;
    quarantine?(file: Readonly<BulkHeaderFileInfo>, reason: string, rejectedData?: Uint8Array): Promise<void>;
    promoteValidated?(file: Readonly<BulkHeaderFileInfo>, data: Uint8Array): Promise<void>;
    delete?(file: Readonly<BulkHeaderFileInfo>): Promise<void>;
}
```

See also: [BulkHeaderFileInfo](./services.md#interface-bulkheaderfileinfo)

###### Method promoteValidated

Promote a validated legacy entry into the implementation's preferred
immutable namespace. Implementations should make this idempotent.

```ts
promoteValidated?(file: Readonly<BulkHeaderFileInfo>, data: Uint8Array): Promise<void>
```
See also: [BulkHeaderFileInfo](./services.md#interface-bulkheaderfileinfo)

###### Method quarantine

Preserve a rejected object outside the active cache namespace. The manager
calls this before attempting a replacement and never removes a last-good
object merely because a newer source is unavailable.

```ts
quarantine?(file: Readonly<BulkHeaderFileInfo>, reason: string, rejectedData?: Uint8Array): Promise<void>
```
See also: [BulkHeaderFileInfo](./services.md#interface-bulkheaderfileinfo)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: BulkFileDataCacheFsOptions

```ts
export interface BulkFileDataCacheFsOptions {
    rootFolder: string;
    legacyRoots?: string[];
    lockTimeoutMsecs?: number;
    lockRetryMsecs?: number;
}
```

###### Property legacyRoots

Read-only legacy locations consulted during in-place migration.

```ts
legacyRoots?: string[]
```

###### Property lockRetryMsecs

Delay between lock attempts. Default: 25 milliseconds.

```ts
lockRetryMsecs?: number
```

###### Property lockTimeoutMsecs

Maximum wait for a per-object cross-process mutation lock. Default: 30 seconds.

```ts
lockTimeoutMsecs?: number
```

###### Property rootFolder

Root for immutable content-addressed cache objects.

```ts
rootFolder: string
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: BulkFileDataManagerMergeResult

```ts
export interface BulkFileDataManagerMergeResult {
    unchanged: BulkHeaderFileInfo[];
    inserted: BulkHeaderFileInfo[];
    updated: BulkHeaderFileInfo[];
    dropped: BulkHeaderFileInfo[];
}
```

See also: [BulkHeaderFileInfo](./services.md#interface-bulkheaderfileinfo)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: BulkFileDataManagerOptions

```ts
export interface BulkFileDataManagerOptions {
    chain: Chain;
    maxPerFile: number;
    maxRetained?: number;
    fetch?: ChaintracksFetchApi;
    fromKnownSourceUrl?: string;
    cache?: BulkFileDataCacheApi;
    downloadBudget?: BulkFileDownloadBudgetApi;
    validator?: BulkFileDataValidatorApi;
    failedLoadRetryMsecs?: number;
}
```

See also: [BulkFileDataCacheApi](./services.md#interface-bulkfiledatacacheapi), [BulkFileDataValidatorApi](./services.md#interface-bulkfiledatavalidatorapi), [BulkFileDownloadBudgetApi](./services.md#interface-bulkfiledownloadbudgetapi), [Chain](./client.md#type-chain), [ChaintracksFetchApi](./services.md#interface-chaintracksfetchapi)

###### Property cache

Persistent cache consulted before any remote bulk-file download.

```ts
cache?: BulkFileDataCacheApi
```
See also: [BulkFileDataCacheApi](./services.md#interface-bulkfiledatacacheapi)

###### Property downloadBudget

Optional process-local or shared reservation budget for remote bytes.

```ts
downloadBudget?: BulkFileDownloadBudgetApi
```
See also: [BulkFileDownloadBudgetApi](./services.md#interface-bulkfiledownloadbudgetapi)

###### Property failedLoadRetryMsecs

Cooldown after a failed load before the same immutable object can retry.

```ts
failedLoadRetryMsecs?: number
```

###### Property validator

Complete-object validator. Node services should inject a worker-backed implementation.

```ts
validator?: BulkFileDataValidatorApi
```
See also: [BulkFileDataValidatorApi](./services.md#interface-bulkfiledatavalidatorapi)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: BulkFileDataManagerStats

```ts
export interface BulkFileDataManagerStats {
    memoryHits: number;
    storageHits: number;
    persistentCacheHits: number;
    persistentCacheMisses: number;
    persistentCacheRejects: number;
    coalescedLoads: number;
    downloads: number;
    downloadedBytes: number;
    loadBackoffs: number;
    validation?: BulkFileDataValidatorStats;
    downloadBudget?: BulkFileDownloadBudgetSnapshot;
}
```

See also: [BulkFileDataValidatorStats](./services.md#interface-bulkfiledatavalidatorstats), [BulkFileDownloadBudgetSnapshot](./services.md#interface-bulkfiledownloadbudgetsnapshot)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: BulkFileDataValidationRequest

Complete immutable bulk-header object supplied to a validator.

Implementations must validate the exact byte length and digest as well as
every header's linkage, chain work, genesis, and proof of work.

```ts
export interface BulkFileDataValidationRequest {
    fileName: string;
    data: Uint8Array;
    count: number;
    fileHash?: string;
    firstHeight: number;
    prevHash: string;
    prevChainWork: string;
    lastHash?: string | null;
    lastChainWork?: string | null;
    chain?: Chain;
}
```

See also: [Chain](./client.md#type-chain)

###### Property fileHash

Expected base64 SHA-256 digest. Omit only while producing a new export.

```ts
fileHash?: string
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: BulkFileDataValidationResult

```ts
export interface BulkFileDataValidationResult {
    data: Uint8Array;
    fileHash: string;
    lastHeaderHash: string;
    lastChainWork: string;
}
```

###### Property data

The validated bytes. Worker implementations may transfer ownership.

```ts
data: Uint8Array
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: BulkFileDataValidatorApi

Asynchronous validation boundary for immutable bulk-header objects.

Portable runtimes may validate in-process. Node services can inject a
worker-backed implementation so proof-of-work validation never blocks the
request event loop.

```ts
export interface BulkFileDataValidatorApi {
    validate(request: BulkFileDataValidationRequest): Promise<BulkFileDataValidationResult>;
    getStats?(): BulkFileDataValidatorStats;
    destroy?(): Promise<void>;
}
```

See also: [BulkFileDataValidationRequest](./services.md#interface-bulkfiledatavalidationrequest), [BulkFileDataValidationResult](./services.md#interface-bulkfiledatavalidationresult), [BulkFileDataValidatorStats](./services.md#interface-bulkfiledatavalidatorstats)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: BulkFileDataValidatorStats

```ts
export interface BulkFileDataValidatorStats {
    submitted: number;
    completed: number;
    failed: number;
    rejected: number;
    workerRestarts: number;
    inFlight: number;
    queued: number;
    maxQueueDepth: number;
    totalValidationMsecs: number;
    maxValidationMsecs: number;
}
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: BulkFileDownloadBudgetApi

A deployment-defined budget for remote bulk-header downloads.
Implementations should throw before the request when the requested byte
reservation would exceed the configured budget.

```ts
export interface BulkFileDownloadBudgetApi {
    consume(byteCount: number): void | Promise<void>;
    snapshot?(): BulkFileDownloadBudgetSnapshot;
}
```

See also: [BulkFileDownloadBudgetSnapshot](./services.md#interface-bulkfiledownloadbudgetsnapshot)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: BulkFileDownloadBudgetSnapshot

```ts
export interface BulkFileDownloadBudgetSnapshot {
    maxBytes: number;
    consumedBytes: number;
    remainingBytes: number;
    windowStartedAt: number;
    windowMsecs: number;
}
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: BulkHeaderFileInfo

Descriptive information about a single bulk header file.

```ts
export interface BulkHeaderFileInfo {
    fileName: string;
    firstHeight: number;
    count: number;
    prevChainWork: string;
    lastChainWork: string;
    prevHash: string;
    lastHash: string | null;
    fileHash: string | null;
    chain?: Chain;
    data?: Uint8Array;
    validated?: boolean;
    fileId?: number;
    sourceUrl?: string;
}
```

See also: [Chain](./client.md#type-chain)

###### Property chain

Which chain: 'main' or 'test'

```ts
chain?: Chain
```
See also: [Chain](./client.md#type-chain)

###### Property count

count of how many headers the file contains. File size must be 80 * count.

```ts
count: number
```

###### Property fileHash

file contents single sha256 hash as base64 string

```ts
fileHash: string | null
```

###### Property fileId

optional, used for database storage

```ts
fileId?: number
```

###### Property fileName

filename and extension, no path

```ts
fileName: string
```

###### Property firstHeight

chain height of first header in file

```ts
firstHeight: number
```

###### Property lastChainWork

lastChainWork is the cummulative chain work including the last header in this file's data, as a hex string.

```ts
lastChainWork: string
```

###### Property lastHash

block hash of last header in the file in standard hex string block hash encoding

```ts
lastHash: string | null
```

###### Property prevChainWork

prevChainWork is the cummulative chain work up to the first header in this file's data, as a hex string.

```ts
prevChainWork: string
```

###### Property prevHash

previousHash of first header in file in standard hex string block hash encoding

```ts
prevHash: string
```

###### Property sourceUrl

optional, if valid `${sourceUrl}/${fileName}` is the source of this data.

```ts
sourceUrl?: string
```

###### Property validated

Advisory process-local validation state. Never trust this value after it
crosses a network or storage boundary; revalidate the object bytes.

```ts
validated?: boolean
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: BulkHeaderFilesInfo

Describes a collection of bulk block header files.

```ts
export interface BulkHeaderFilesInfo {
    rootFolder: string;
    jsonFilename: string;
    files: BulkHeaderFileInfo[];
    headersPerFile: number;
}
```

See also: [BulkHeaderFileInfo](./services.md#interface-bulkheaderfileinfo)

###### Property files

Array of information about each bulk block header file.

```ts
files: BulkHeaderFileInfo[]
```
See also: [BulkHeaderFileInfo](./services.md#interface-bulkheaderfileinfo)

###### Property headersPerFile

Maximum number of headers in a single file in this collection of files.

```ts
headersPerFile: number
```

###### Property jsonFilename

Sub-path to this resource on rootFolder

```ts
jsonFilename: string
```

###### Property rootFolder

Where this file was fetched or read from.

```ts
rootFolder: string
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: BulkIngestorApi

```ts
export interface BulkIngestorApi {
    shutdown(): Promise<void>;
    getPresentHeight(): Promise<number | undefined>;
    fetchHeaders(before: HeightRanges, fetchRange: HeightRange, bulkRange: HeightRange, priorLiveHeaders: BlockHeader[]): Promise<BlockHeader[]>;
    synchronize(presentHeight: number, before: HeightRanges, priorLiveHeaders: BlockHeader[]): Promise<BulkSyncResult>;
    setStorage(storage: ChaintracksStorageApi, log: (...args: any[]) => void): Promise<void>;
    storage(): ChaintracksStorageApi;
}
```

See also: [BlockHeader](./client.md#interface-blockheader), [BulkSyncResult](./services.md#interface-bulksyncresult), [ChaintracksStorageApi](./services.md#interface-chaintracksstorageapi), [HeightRange](./services.md#class-heightrange), [HeightRanges](./services.md#interface-heightranges)

###### Method fetchHeaders

A BulkIngestor fetches and updates storage with bulk headers in bulkRange.

If it can, it must also fetch live headers in fetch range that are not in bulkRange and return them as an array.

The storage methods `insertBulkFile`, `updateBulkFile`, and `addBulkHeaders` should be used to add bulk headers to storage.

```ts
fetchHeaders(before: HeightRanges, fetchRange: HeightRange, bulkRange: HeightRange, priorLiveHeaders: BlockHeader[]): Promise<BlockHeader[]>
```
See also: [BlockHeader](./client.md#interface-blockheader), [HeightRange](./services.md#class-heightrange), [HeightRanges](./services.md#interface-heightranges)

Returns

new live headers: headers in fetchRange but not in bulkRange

Argument Details

+ **before**
  + bulk and live range of headers before ingesting any new headers.
+ **fetchRange**
  + range of headers still needed, includes both missing bulk and live headers.
+ **bulkRange**
  + range of bulk headers still needed
+ **priorLiveHeaders**
  + any headers accumulated by prior bulk ingestor(s) that are too recent for bulk storage.

###### Method getPresentHeight

If the bulk ingestor is capable, return the approximate
present height of the actual chain being tracked.
Otherwise, return undefined.

May not assume that setStorage has been called.

```ts
getPresentHeight(): Promise<number | undefined>
```

###### Method setStorage

Called before first Synchronize with reference to storage.
Components requiring asynchronous setup can override base class implementation.

```ts
setStorage(storage: ChaintracksStorageApi, log: (...args: any[]) => void): Promise<void>
```
See also: [ChaintracksStorageApi](./services.md#interface-chaintracksstorageapi)

###### Method shutdown

Close and release all resources.

```ts
shutdown(): Promise<void>
```

###### Method synchronize

A BulkIngestor has two potential goals:
1. To source missing bulk headers and include them in bulk storage.
2. To source missing live headers to be forwarded to live storage.

```ts
synchronize(presentHeight: number, before: HeightRanges, priorLiveHeaders: BlockHeader[]): Promise<BulkSyncResult>
```
See also: [BlockHeader](./client.md#interface-blockheader), [BulkSyncResult](./services.md#interface-bulksyncresult), [HeightRanges](./services.md#interface-heightranges)

Returns

updated priorLiveHeaders including any accumulated by this ingestor

Argument Details

+ **presentHeight**
  + current height of the active chain tip, may lag the true value.
+ **before**
  + current bulk and live storage height ranges, either may be empty.
+ **priorLiveHeaders**
  + any headers accumulated by prior bulk ingestor(s) that are too recent for bulk storage.

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: BulkIngestorBaseOptions

```ts
export interface BulkIngestorBaseOptions {
    chain: Chain;
    jsonResource: string | undefined;
}
```

See also: [Chain](./client.md#type-chain)

###### Property chain

The target chain.

```ts
chain: Chain
```
See also: [Chain](./client.md#type-chain)

###### Property jsonResource

Required.

The name of the JSON resource to request from CDN which describes currently
available bulk block header resources.

```ts
jsonResource: string | undefined
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: BulkIngestorCDNOptions

```ts
export interface BulkIngestorCDNOptions extends BulkIngestorBaseOptions {
    jsonResource: string | undefined;
    cdnUrl: string | undefined;
    maxPerFile: number | undefined;
    fetch: ChaintracksFetchApi;
}
```

See also: [BulkIngestorBaseOptions](./services.md#interface-bulkingestorbaseoptions), [ChaintracksFetchApi](./services.md#interface-chaintracksfetchapi)

###### Property cdnUrl

Required.

URL to CDN implementing the bulk ingestor CDN service protocol

```ts
cdnUrl: string | undefined
```

###### Property jsonResource

Required.

The name of the JSON resource to request from CDN which describes currently
available bulk block header resources.

```ts
jsonResource: string | undefined
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: BulkIngestorChaintracksOptions

```ts
export interface BulkIngestorChaintracksOptions extends BulkIngestorBaseOptions {
    chain: Chain;
    chaintracks: ChaintracksClientApi;
    maxHeadersPerRequest?: number;
}
```

See also: [BulkIngestorBaseOptions](./services.md#interface-bulkingestorbaseoptions), [Chain](./client.md#type-chain), [ChaintracksClientApi](./services.md#interface-chaintracksclientapi)

###### Property maxHeadersPerRequest

Maximum headers requested from the upstream service at once.

```ts
maxHeadersPerRequest?: number
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: BulkIngestorWhatsOnChainOptions

```ts
export interface BulkIngestorWhatsOnChainOptions extends BulkIngestorBaseOptions, WhatsOnChainServicesOptions {
    idleWait: number | undefined;
    chain: Chain;
    apiKey?: string;
    timeout: number;
    userAgent: string;
    enableCache: boolean;
    chainInfoMsecs: number;
    fetch?: ChaintracksFetchApi;
    maxHeadersPerRequest?: number;
}
```

See also: [BulkIngestorBaseOptions](./services.md#interface-bulkingestorbaseoptions), [Chain](./client.md#type-chain), [ChaintracksFetchApi](./services.md#interface-chaintracksfetchapi), [WhatsOnChainServicesOptions](./services.md#interface-whatsonchainservicesoptions)

###### Property apiKey

WhatsOnChain.com API Key
https://docs.taal.com/introduction/get-an-api-key
If unknown or empty, maximum request rate is limited.
https://developers.whatsonchain.com/#rate-limits

```ts
apiKey?: string
```

###### Property chain

Which chain is being tracked: main, test, or stn.

```ts
chain: Chain
```
See also: [Chain](./client.md#type-chain)

###### Property chainInfoMsecs

How long chainInfo is considered still valid before updating (msecs).

```ts
chainInfoMsecs: number
```

###### Property enableCache

Enable WhatsOnChain client cache option.

```ts
enableCache: boolean
```

###### Property idleWait

Maximum msecs of "normal" pause with no new data arriving.

```ts
idleWait: number | undefined
```

###### Property maxHeadersPerRequest

Maximum headers retained from one legacy WebSocket history request.

```ts
maxHeadersPerRequest?: number
```

###### Property timeout

Request timeout for GETs to https://api.whatsonchain.com/v1/bsv

```ts
timeout: number
```

###### Property userAgent

User-Agent header value for requests to https://api.whatsonchain.com/v1/bsv

```ts
userAgent: string
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: BulkStorageApi

Handles block header storage and retrieval older than the "live" portion of the chain.
Height is the primary and only indexing field required.
Only stores headers on the active chain; no orphans, no forks, no reorgs.

```ts
export interface BulkStorageApi {
    shutdown(): Promise<void>;
    getMaxHeight(): Promise<number>;
    getHeightRange(): Promise<HeightRange>;
    appendHeaders(minHeight: number, count: number, headers: Uint8Array): Promise<void>;
    findHeaderForHeightOrUndefined(height: number): Promise<BlockHeader | undefined>;
    findHeaderForHeight(height: number): Promise<BlockHeader>;
    headersToBuffer(height: number, count: number): Promise<Uint8Array>;
    exportBulkHeaders(rootFolder: string, jsonFilename: string, maxPerFile: number): Promise<void>;
    setStorage(storage: ChaintracksStorageApi, log: (...args: any[]) => void): Promise<void>;
}
```

See also: [BlockHeader](./client.md#interface-blockheader), [ChaintracksStorageApi](./services.md#interface-chaintracksstorageapi), [HeightRange](./services.md#class-heightrange)

###### Method appendHeaders

Append new Block Headers to BulkStorage.
Requires that these headers directly extend existing headers.
maxHeight of existing plus one equals minHeight of `headers`.
hash of last existing equals previousHash of first in `headers`.
Checks that all `headers` are valid (hash, previousHash)

Duplicate headers must be ignored.

```ts
appendHeaders(minHeight: number, count: number, headers: Uint8Array): Promise<void>
```

Argument Details

+ **minHeight**
  + must match height of first header in buffer
+ **count**
  + times 80 must equal headers.length
+ **headers**
  + encoded as packed array of 80 byte serialized block headers

###### Method exportBulkHeaders

Exports current bulk headers, including all ingests, excluding live headers to static header files.

```ts
exportBulkHeaders(rootFolder: string, jsonFilename: string, maxPerFile: number): Promise<void>
```

Argument Details

+ **rootFolder**
  + Where the json and headers files will be written
+ **jsonFilename**
  + The name of the json file.
+ **maxPerFile**
  + The maximum headers per file.

###### Method findHeaderForHeight

Returns block header for a given block height on active chain.
Throws if not found.

```ts
findHeaderForHeight(height: number): Promise<BlockHeader>
```
See also: [BlockHeader](./client.md#interface-blockheader)

Argument Details

+ **hash**
  + block hash

###### Method findHeaderForHeightOrUndefined

Returns block header for a given block height on active chain.

```ts
findHeaderForHeightOrUndefined(height: number): Promise<BlockHeader | undefined>
```
See also: [BlockHeader](./client.md#interface-blockheader)

Argument Details

+ **hash**
  + block hash

###### Method getHeightRange

```ts
getHeightRange(): Promise<HeightRange>
```
See also: [HeightRange](./services.md#class-heightrange)

Returns

available bulk block header height range: `(0, getMaxHeight())`

###### Method getMaxHeight

```ts
getMaxHeight(): Promise<number>
```

Returns

the height of the most recent header in bulk storage or -1 if empty.

###### Method headersToBuffer

Adds headers in 80 byte serialized format to a buffer.
Only adds active headers.
returned array length divided by 80 is the actual number returned.

Returns the buffer.

```ts
headersToBuffer(height: number, count: number): Promise<Uint8Array>
```

Argument Details

+ **height**
  + of first header
+ **count**
  + of headers

###### Method setStorage

Called before first Synchronize with reference to storage.
Components requiring asynchronous setup can override base class implementation.

```ts
setStorage(storage: ChaintracksStorageApi, log: (...args: any[]) => void): Promise<void>
```
See also: [ChaintracksStorageApi](./services.md#interface-chaintracksstorageapi)

###### Method shutdown

Close and release all resources.

```ts
shutdown(): Promise<void>
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: BulkStorageBaseOptions

```ts
export interface BulkStorageBaseOptions {
    chain: Chain;
    fs: ChaintracksFsApi;
}
```

See also: [Chain](./client.md#type-chain), [ChaintracksFsApi](./services.md#interface-chaintracksfsapi)

###### Property chain

The target chain: "main" or "test"

```ts
chain: Chain
```
See also: [Chain](./client.md#type-chain)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: BulkSyncResult

```ts
export interface BulkSyncResult {
    liveHeaders: BlockHeader[];
    liveRange: HeightRange;
    done: boolean;
    log: string;
}
```

See also: [BlockHeader](./client.md#interface-blockheader), [HeightRange](./services.md#class-heightrange)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: ChaintracksApi

Full Chaintracks API including startListening with callbacks

```ts
export interface ChaintracksApi extends ChaintracksClientApi {
    startListening(listening?: () => void): Promise<void>;
}
```

See also: [ChaintracksClientApi](./services.md#interface-chaintracksclientapi)

###### Method startListening

Start or resume listening for new headers.

Calls `synchronize` to catch up on headers that were found while not listening.

Begins listening to any number of configured new header notification services.

Begins sending notifications to subscribed listeners only after processing any
previously found headers.

May be called if already listening or synchronizing to listen.

`listening` callback will be called after listening for new live headers has begun.
Alternatively, the `listening` API function which returns a Promise can be awaited.

```ts
startListening(listening?: () => void): Promise<void>
```

Argument Details

+ **listening**
  + callback indicates when listening for new headers has started.

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: ChaintracksAppendableFileApi

Supports access and appending data to new or existing named data storage.
New data is always appended to the end of existing data.

```ts
export interface ChaintracksAppendableFileApi extends ChaintracksReadableFileApi {
    append(data: Uint8Array): Promise<void>;
}
```

See also: [ChaintracksReadableFileApi](./services.md#interface-chaintracksreadablefileapi)

###### Method append

```ts
append(data: Uint8Array): Promise<void>
```

Argument Details

+ **data**
  + data to add to the end of existing data.

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: ChaintracksAvailabilitySnapshotApi

Constant-time, local-only process state for probes and operators.

```ts
export interface ChaintracksAvailabilitySnapshotApi {
    available: boolean;
    startupError?: string;
    presentHeight?: number;
    presentHeightUpdatedAt?: string;
    presentHeightRefreshInFlight: boolean;
    mainLoopHeartbeatAt?: string;
    sources: ChaintracksSourceStatusApi[];
    bulkData: ChaintracksBulkDataStatsApi;
}
```

See also: [ChaintracksBulkDataStatsApi](./services.md#interface-chaintracksbulkdatastatsapi), [ChaintracksSourceStatusApi](./services.md#interface-chaintrackssourcestatusapi)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: ChaintracksBulkDataStatsApi

```ts
export interface ChaintracksBulkDataStatsApi {
    memoryHits: number;
    storageHits: number;
    persistentCacheHits: number;
    persistentCacheMisses: number;
    persistentCacheRejects: number;
    coalescedLoads: number;
    downloads: number;
    downloadedBytes: number;
    loadBackoffs: number;
    validation?: {
        submitted: number;
        completed: number;
        failed: number;
        rejected: number;
        workerRestarts: number;
        inFlight: number;
        queued: number;
        maxQueueDepth: number;
        totalValidationMsecs: number;
        maxValidationMsecs: number;
    };
    downloadBudget?: {
        maxBytes: number;
        consumedBytes: number;
        remainingBytes: number;
        windowStartedAt: number;
        windowMsecs: number;
    };
}
```

###### Property downloadBudget

Durable download reservation state when configured.

```ts
downloadBudget?: {
    maxBytes: number;
    consumedBytes: number;
    remainingBytes: number;
    windowStartedAt: number;
    windowMsecs: number;
}
```

###### Property validation

Worker or portable validator statistics when the implementation exposes them.

```ts
validation?: {
    submitted: number;
    completed: number;
    failed: number;
    rejected: number;
    workerRestarts: number;
    inFlight: number;
    queued: number;
    maxQueueDepth: number;
    totalValidationMsecs: number;
    maxValidationMsecs: number;
}
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: ChaintracksChainTrackerOptions

```ts
export interface ChaintracksChainTrackerOptions {
    maxRetries?: number;
    retryDelayMs?: number;
    telemetry?: TelemetryConfig;
}
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: ChaintracksClientApi

Chaintracks client API excluding events and callbacks

```ts
export interface ChaintracksClientApi extends ChainTracker {
    getChain(): Promise<Chain>;
    getInfo(): Promise<ChaintracksInfoApi>;
    getPresentHeight(): Promise<number>;
    getHeaders(height: number, count: number): Promise<string>;
    findChainTipHeader(): Promise<BlockHeader>;
    findChainTipHash(): Promise<string>;
    findHeaderForHeight(height: number): Promise<BlockHeader | undefined>;
    findHeaderForBlockHash(hash: string): Promise<BlockHeader | undefined>;
    addHeader(header: BaseBlockHeader): Promise<void>;
    startListening(): Promise<void>;
    listening(): Promise<void>;
    isListening(): Promise<boolean>;
    isSynchronized(): Promise<boolean>;
    subscribeHeaders(listener: HeaderListener): Promise<string>;
    subscribeReorgs(listener: ReorgListener): Promise<string>;
    unsubscribe(subscriptionId: string): Promise<boolean>;
    isValidRootForHeight(root: string, height: number): Promise<boolean>;
    currentHeight: () => Promise<number>;
}
```

See also: [BaseBlockHeader](./client.md#interface-baseblockheader), [BlockHeader](./client.md#interface-blockheader), [Chain](./client.md#type-chain), [ChaintracksInfoApi](./services.md#interface-chaintracksinfoapi), [HeaderListener](./services.md#type-headerlistener), [ReorgListener](./services.md#type-reorglistener)

###### Method addHeader

Submit a possibly new header for adding

If the header is invalid or a duplicate it will not be added.

This header will be ignored if the previous header has not already been inserted when this header
is considered for insertion.

```ts
addHeader(header: BaseBlockHeader): Promise<void>
```
See also: [BaseBlockHeader](./client.md#interface-baseblockheader)

Returns

immediately

###### Method findChainTipHash

Returns the block hash of the active chain tip.

```ts
findChainTipHash(): Promise<string>
```

###### Method findChainTipHeader

Returns the active chain tip header

```ts
findChainTipHeader(): Promise<BlockHeader>
```
See also: [BlockHeader](./client.md#interface-blockheader)

###### Method findHeaderForBlockHash

Returns block header for a given recent block hash or undefined.

```ts
findHeaderForBlockHash(hash: string): Promise<BlockHeader | undefined>
```
See also: [BlockHeader](./client.md#interface-blockheader)

###### Method findHeaderForHeight

Returns block header for a given block height on active chain.

```ts
findHeaderForHeight(height: number): Promise<BlockHeader | undefined>
```
See also: [BlockHeader](./client.md#interface-blockheader)

###### Method getChain

Confirms the chain

```ts
getChain(): Promise<Chain>
```
See also: [Chain](./client.md#type-chain)

###### Method getHeaders

Adds headers in 80 byte serialized format to an array.
Only adds active headers.
array length divided by 80 is the actual number returned.

```ts
getHeaders(height: number, count: number): Promise<string>
```

Returns

array of headers as serialized hex string

Argument Details

+ **height**
  + of first header
+ **count**
  + of headers, maximum

###### Method getInfo

```ts
getInfo(): Promise<ChaintracksInfoApi>
```
See also: [ChaintracksInfoApi](./services.md#interface-chaintracksinfoapi)

Returns

Summary of configuration and state.

###### Method getPresentHeight

Return the latest chain height from configured bulk ingestors.

```ts
getPresentHeight(): Promise<number>
```

###### Method isListening

Returns true if actively listening for new headers and client api is enabled.

```ts
isListening(): Promise<boolean>
```

###### Method isSynchronized

Returns true if `synchronize` has completed at least once.

```ts
isSynchronized(): Promise<boolean>
```

###### Method listening

Returns a Promise that will resolve when the previous call to startListening
enters the listening-for-new-headers state.

```ts
listening(): Promise<void>
```

###### Method startListening

Start or resume listening for new headers.

Calls `synchronize` to catch up on headers that were found while not listening.

Begins listening to any number of configured new header notification services.

Begins sending notifications to subscribed listeners only after processing any
previously found headers.

May be called if already listening or synchronizing to listen.

The `listening` API function which returns a Promise can be awaited.

```ts
startListening(): Promise<void>
```

###### Method subscribeHeaders

Subscribe to "header" events.

```ts
subscribeHeaders(listener: HeaderListener): Promise<string>
```
See also: [HeaderListener](./services.md#type-headerlistener)

Returns

identifier for this subscription

Throws

ERR_NOT_IMPLEMENTED if callback events are not supported

###### Method subscribeReorgs

Subscribe to "reorganization" events.

```ts
subscribeReorgs(listener: ReorgListener): Promise<string>
```
See also: [ReorgListener](./services.md#type-reorglistener)

Returns

identifier for this subscription

Throws

ERR_NOT_IMPLEMENTED if callback events are not supported

###### Method unsubscribe

Cancels all subscriptions with the given `subscriptionId` which was previously returned
by a `subscribe` method.

```ts
unsubscribe(subscriptionId: string): Promise<boolean>
```

Returns

true if a subscription was canceled

Argument Details

+ **subscriptionId**
  + value previously returned by subscribeToHeaders or subscribeToReorgs

Throws

ERR_NOT_IMPLEMENTED if callback events are not supported

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: ChaintracksDownloadOptions

```ts
export interface ChaintracksDownloadOptions {
    beforeRetry?: (attempt: number) => void | Promise<void>;
    publicNetworkOnly?: boolean;
}
```

###### Property beforeRetry

Called immediately before each retry after the initial request.

```ts
beforeRetry?: (attempt: number) => void | Promise<void>
```

###### Property publicNetworkOnly

Resolve, approve, and DNS-pin only public HTTPS destinations.

```ts
publicNetworkOnly?: boolean
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: ChaintracksFetchApi

Provides a simplified interface based on the

```ts
export interface ChaintracksFetchApi {
    httpClient: HttpClient;
    download(url: string, maxResponseBytes?: number, options?: ChaintracksDownloadOptions): Promise<Uint8Array>;
    fetchJson<R>(url: string): Promise<R>;
    pathJoin(baseUrl: string, subpath: string): string;
}
```

See also: [ChaintracksDownloadOptions](./services.md#interface-chaintracksdownloadoptions)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: ChaintracksFetchOptions

```ts
export interface ChaintracksFetchOptions {
    maxRetries?: number;
    timeoutMsecs?: number;
    maxResponseBytes?: number;
    retryMsecs?: number;
    maxRetryMsecs?: number;
    random?: () => number;
    fetch?: typeof fetch;
    publicNetworkFetch?: typeof fetch;
}
```

###### Property fetch

Fetch implementation for operator-configured sources.

```ts
fetch?: typeof fetch
```

###### Property maxResponseBytes

Maximum materialized response size for binary and JSON requests.

```ts
maxResponseBytes?: number
```

###### Property maxRetries

Number of retries after the initial request. Defaults to three.

```ts
maxRetries?: number
```

###### Property publicNetworkFetch

Public-network fetch implementation; injectable for deterministic tests.

```ts
publicNetworkFetch?: typeof fetch
```

###### Property random

Testable jitter source in the inclusive range 0..1.

```ts
random?: () => number
```

###### Property timeoutMsecs

Deadline covering connection, headers, and response body.

```ts
timeoutMsecs?: number
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: ChaintracksFsApi

Supports file-like access to named data storage.

Only minimal functionality required by Chaintracks is supported.

```ts
export interface ChaintracksFsApi {
    delete(path: string): Promise<void>;
    writeFile(path: string, data: Uint8Array): Promise<void>;
    readFile(path: string): Promise<Uint8Array>;
    openReadableFile(path: string): Promise<ChaintracksReadableFileApi>;
    openWritableFile(path: string): Promise<ChaintracksWritableFileApi>;
    openAppendableFile(path: string): Promise<ChaintracksAppendableFileApi>;
    pathJoin(...parts: string[]): string;
}
```

See also: [ChaintracksAppendableFileApi](./services.md#interface-chaintracksappendablefileapi), [ChaintracksReadableFileApi](./services.md#interface-chaintracksreadablefileapi), [ChaintracksWritableFileApi](./services.md#interface-chaintrackswritablefileapi)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: ChaintracksInfoApi

```ts
export interface ChaintracksInfoApi {
    chain: Chain;
    heightBulk: number;
    heightLive: number;
    storage: string;
    bulkIngestors: string[];
    liveIngestors: string[];
    packages: ChaintracksPackageInfoApi[];
    sources?: ChaintracksSourceStatusApi[];
    bulkData?: ChaintracksBulkDataStatsApi;
}
```

See also: [Chain](./client.md#type-chain), [ChaintracksBulkDataStatsApi](./services.md#interface-chaintracksbulkdatastatsapi), [ChaintracksPackageInfoApi](./services.md#interface-chaintrackspackageinfoapi), [ChaintracksSourceStatusApi](./services.md#interface-chaintrackssourcestatusapi)

###### Property bulkData

Local bulk-header retrieval counters. Additive and omitted by older services.

```ts
bulkData?: ChaintracksBulkDataStatsApi
```
See also: [ChaintracksBulkDataStatsApi](./services.md#interface-chaintracksbulkdatastatsapi)

###### Property sources

Last observed source state. Additive and omitted by older services.

```ts
sources?: ChaintracksSourceStatusApi[]
```
See also: [ChaintracksSourceStatusApi](./services.md#interface-chaintrackssourcestatusapi)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: ChaintracksIngestorParams

Shared parameters for configuring Chaintracks ingestors.

```ts
export interface ChaintracksIngestorParams {
    chain: Chain;
    whatsonchainApiKey: string;
    maxPerFile: number;
    fetch: ChaintracksFetchApi;
    cdnUrl: string;
    addLiveRecursionLimit: number;
    sources: ChaintracksSourceOptions;
}
```

See also: [Chain](./client.md#type-chain), [ChaintracksFetchApi](./services.md#interface-chaintracksfetchapi), [ChaintracksSourceOptions](./services.md#interface-chaintrackssourceoptions)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: ChaintracksManagementApi

```ts
export interface ChaintracksManagementApi extends ChaintracksApi {
    destroy(): Promise<void>;
    validate(): Promise<boolean>;
    exportBulkHeaders(toFolder: string, toFs: ChaintracksFsApi, sourceUrl?: string, toHeadersPerFile?: number, maxHeight?: number): Promise<void>;
}
```

See also: [ChaintracksApi](./services.md#interface-chaintracksapi), [ChaintracksFsApi](./services.md#interface-chaintracksfsapi)

###### Method destroy

close and release all resources

```ts
destroy(): Promise<void>
```

###### Method exportBulkHeaders

Exports current bulk headers, including all ingests, excluding live headers to static header files.

Useful for bulk ingestors such as those derived from BulkIngestorCDN.

```ts
exportBulkHeaders(toFolder: string, toFs: ChaintracksFsApi, sourceUrl?: string, toHeadersPerFile?: number, maxHeight?: number): Promise<void>
```
See also: [ChaintracksFsApi](./services.md#interface-chaintracksfsapi)

Argument Details

+ **toFolder**
  + Where the json and headers files will be written
+ **toFs**
  + The ChaintracksFsApi to use for writing files. If not provided, the default file system will be used.
+ **sourceUrl**
  + Optional source URL to include in the exported files. Set if exported files will be transferred to a CDN.
+ **toHeadersPerFile**
  + The maximum headers per file. Default is 100,000 (8MB)
+ **maxHeight**
  + The maximum height to export. Default is the current bulk storage max height.

###### Method validate

Verifies that all headers from the tip back to genesis can be retrieved, in order,
by height, and that they obey previousHash constraint.

Additional validations may be addeded.

This is a slow operation.

```ts
validate(): Promise<boolean>
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: ChaintracksOptions

```ts
export interface ChaintracksOptions {
    chain: Chain;
    storage?: ChaintracksStorageApi;
    bulkIngestors: BulkIngestorApi[];
    liveIngestors: LiveIngestorApi[];
    addLiveRecursionLimit: number;
    maxQueuedBaseHeaders?: number;
    logging?: (...args: any[]) => void;
    readonly: boolean;
}
```

See also: [BulkIngestorApi](./services.md#interface-bulkingestorapi), [Chain](./client.md#type-chain), [ChaintracksStorageApi](./services.md#interface-chaintracksstorageapi), [LiveIngestorApi](./services.md#interface-liveingestorapi)

###### Property addLiveRecursionLimit

Maximum number of missing headers to pursue when listening for new headers.
Normally, large numbers of missing headers are handled by bulk ingestors.

```ts
addLiveRecursionLimit: number
```

###### Property logging

Optional logging method

```ts
logging?: (...args: any[]) => void
```

###### Property maxQueuedBaseHeaders

Maximum number of externally submitted base headers awaiting validation.
Duplicate pending headers do not consume additional capacity.

```ts
maxQueuedBaseHeaders?: number
```

###### Property readonly

If true, this chaintracks instance will only service read requests for existing data.
Shared storage only requires one readonly false instance to manage and update storage.

```ts
readonly: boolean
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: ChaintracksPackageInfoApi

```ts
export interface ChaintracksPackageInfoApi {
    name: string;
    version: string;
}
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: ChaintracksReadableFileApi

Supports access to named data storage (file like).

```ts
export interface ChaintracksReadableFileApi {
    path: string;
    close(): Promise<void>;
    getLength(): Promise<number>;
    read(length?: number, offset?: number): Promise<Uint8Array>;
}
```

###### Method getLength

Returns the length of the data storage in bytes.

```ts
getLength(): Promise<number>
```

###### Method read

```ts
read(length?: number, offset?: number): Promise<Uint8Array>
```

Argument Details

+ **length**
  + requested length to be returned, may return less than requested.
+ **offset**
  + starting offset in the existing data storage to read from, defaults to 0.

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: ChaintracksServiceClientOptions

```ts
export interface ChaintracksServiceClientOptions {
    useAuthrite?: false;
    fetch?: typeof fetch;
    requestTimeoutMsecs?: number;
    maxResponseBytes?: number;
    maxRequestBytes?: number;
}
```

###### Property maxRequestBytes

Maximum JSON request size. Default: 256 KiB.

```ts
maxRequestBytes?: number
```

###### Property maxResponseBytes

Maximum JSON response size. Default: 4 MiB.

```ts
maxResponseBytes?: number
```

###### Property requestTimeoutMsecs

Whole-request deadline, including response-body consumption. Default: 30 seconds.

```ts
requestTimeoutMsecs?: number
```

###### Property useAuthrite

Retained for compatibility with historical callers; this client does not use Authrite.

```ts
useAuthrite?: false
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: ChaintracksServiceOptions

```ts
export interface ChaintracksServiceOptions {
    chain: Chain;
    routingPrefix: string;
    chaintracks?: Chaintracks;
    services?: Services;
    port?: number;
    allowedOrigins?: string[];
    maxConcurrentRequests?: number;
    http?: Partial<HttpServerPolicyDefaults>;
    maxRequestsPerMinute?: number;
    maxHeaderSubmissionsPerMinute?: number;
    maxHeadersPerRequest?: number;
    maxWaitMsecs?: number;
    logRequests?: boolean;
}
```

See also: [Chain](./client.md#type-chain), [Chaintracks](./services.md#class-chaintracks), [HttpServerPolicyDefaults](./storage.md#interface-httpserverpolicydefaults), [Services](./services.md#class-services)

###### Property allowedOrigins

Exact browser origins allowed to use the service. Omit for public CORS.

```ts
allowedOrigins?: string[]
```

###### Property chaintracks

Defaults to default configured Chaintracks instance with NoDb storage.

```ts
chaintracks?: Chaintracks
```
See also: [Chaintracks](./services.md#class-chaintracks)

###### Property logRequests

Opt in to per-request path logging. Response bodies and query values are never logged.

```ts
logRequests?: boolean
```

###### Property maxHeaderSubmissionsPerMinute

Process-global header submissions allowed per minute. Defaults to 120.

```ts
maxHeaderSubmissionsPerMinute?: number
```

###### Property maxHeadersPerRequest

Maximum header count returned by one request. Defaults to 10,000; hard maximum 100,000.

```ts
maxHeadersPerRequest?: number
```

###### Property maxRequestsPerMinute

Process-global request starts allowed per minute. Defaults to 3,000.

```ts
maxRequestsPerMinute?: number
```

###### Property maxWaitMsecs

Maximum supported getInfo diagnostic wait. Defaults to 1 second; hard maximum 30 seconds.

```ts
maxWaitMsecs?: number
```

###### Property routingPrefix

prepended to the path of each registered service endpoint

```ts
routingPrefix: string
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: ChaintracksSourceOptions

```ts
export interface ChaintracksSourceOptions {
    chaintracks?: ChaintracksClientApi;
    disableChaintracks?: boolean;
    remoteMaxHeadersPerRequest?: number;
    disableCdn?: boolean;
    disableWhatsOnChain?: boolean;
    bulkFileCache?: BulkFileDataCacheApi;
    bulkFileDownloadBudget?: BulkFileDownloadBudgetApi;
    bulkFileDataValidator?: BulkFileDataValidatorApi;
}
```

See also: [BulkFileDataCacheApi](./services.md#interface-bulkfiledatacacheapi), [BulkFileDataValidatorApi](./services.md#interface-bulkfiledatavalidatorapi), [BulkFileDownloadBudgetApi](./services.md#interface-bulkfiledownloadbudgetapi), [ChaintracksClientApi](./services.md#interface-chaintracksclientapi)

###### Property bulkFileCache

Persistent checkpoint/cache storage used before any remote bulk download.

```ts
bulkFileCache?: BulkFileDataCacheApi
```
See also: [BulkFileDataCacheApi](./services.md#interface-bulkfiledatacacheapi)

###### Property bulkFileDataValidator

Optional complete-object validator; Node services should use a bounded worker implementation.

```ts
bulkFileDataValidator?: BulkFileDataValidatorApi
```
See also: [BulkFileDataValidatorApi](./services.md#interface-bulkfiledatavalidatorapi)

###### Property bulkFileDownloadBudget

Optional byte budget applied before remote bulk-file downloads.

```ts
bulkFileDownloadBudget?: BulkFileDownloadBudgetApi
```
See also: [BulkFileDownloadBudgetApi](./services.md#interface-bulkfiledownloadbudgetapi)

###### Property chaintracks

Preferred go-chaintracks or Arcade source.

```ts
chaintracks?: ChaintracksClientApi
```
See also: [ChaintracksClientApi](./services.md#interface-chaintracksclientapi)

###### Property disableCdn

Disable the configured CDN source without changing its URL.

```ts
disableCdn?: boolean
```

###### Property disableChaintracks

Disable the credential-free public Arcade default.

```ts
disableChaintracks?: boolean
```

###### Property disableWhatsOnChain

Disable the keyless WhatsOnChain fallback on mainnet/testnet.

```ts
disableWhatsOnChain?: boolean
```

###### Property remoteMaxHeadersPerRequest

Maximum number of headers requested from the remote source at once.

```ts
remoteMaxHeadersPerRequest?: number
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: ChaintracksSourceStatusApi

```ts
export interface ChaintracksSourceStatusApi {
    name: string;
    role: "bulk" | "live";
    state: "unknown" | "healthy" | "degraded";
    lastSuccess?: string;
    lastFailure?: string;
    error?: string;
}
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: ChaintracksStorageApi

```ts
export interface ChaintracksStorageApi extends ChaintracksStorageQueryApi, ChaintracksStorageIngestApi {
    log: (...args: any[]) => void;
    bulkManager: BulkFileDataManager;
    destroy(): Promise<void>;
}
```

See also: [BulkFileDataManager](./services.md#class-bulkfiledatamanager), [ChaintracksStorageIngestApi](./services.md#interface-chaintracksstorageingestapi), [ChaintracksStorageQueryApi](./services.md#interface-chaintracksstoragequeryapi)

###### Method destroy

Close and release all resources.

```ts
destroy(): Promise<void>
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: ChaintracksStorageBaseOptions

```ts
export interface ChaintracksStorageBaseOptions {
    chain: Chain;
    liveHeightThreshold: number;
    reorgHeightThreshold: number;
    bulkMigrationChunkSize: number;
    batchInsertLimit: number;
    bulkFileDataManager: BulkFileDataManager | undefined;
}
```

See also: [BulkFileDataManager](./services.md#class-bulkfiledatamanager), [Chain](./client.md#type-chain)

###### Property batchInsertLimit

Maximum number of headers per call to batchInsert

```ts
batchInsertLimit: number
```

###### Property bulkFileDataManager

Controls in memory caching and retrieval of missing bulk header data.

```ts
bulkFileDataManager: BulkFileDataManager | undefined
```
See also: [BulkFileDataManager](./services.md#class-bulkfiledatamanager)

###### Property bulkMigrationChunkSize

How many excess "live" headers to accumulate before migrating them as a chunk to the
bulk header storage.

```ts
bulkMigrationChunkSize: number
```

###### Property chain

Which chain is being tracked: main, test, or stn.

```ts
chain: Chain
```
See also: [Chain](./client.md#type-chain)

###### Property liveHeightThreshold

How much of recent history is required to be kept in "live" block header storage.

Headers with height less than active chain tip height minus `liveHeightThreshold`
are not required to be kept in "live" storage and may be migrated to "bulk" storage.

As no forks, orphans, or reorgs can affect "bulk" block header storage, an
aggressively high number is recommended: At least an order of magnitude more than
the deepest actual reorg you can imagine.

```ts
liveHeightThreshold: number
```

###### Property reorgHeightThreshold

How much of recent history must be processed with full validation and reorg support.

Must be less than or equal to `liveHeightThreshold`.

Headers with height older than active chain tip height minus `reorgHeightThreshold`
may use batch processing when ingesting headers.

```ts
reorgHeightThreshold: number
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: ChaintracksStorageBulkFileApi

```ts
export interface ChaintracksStorageBulkFileApi {
    insertBulkFile(file: BulkHeaderFileInfo): Promise<number>;
    updateBulkFile(fileId: number, file: BulkHeaderFileInfo): Promise<number>;
    deleteBulkFile(fileId: number): Promise<number>;
    getBulkFiles(): Promise<BulkHeaderFileInfo[]>;
    getBulkFileData(fileId: number, offset?: number, length?: number): Promise<Uint8Array | undefined>;
    replaceBulkFiles?(files: BulkHeaderFileInfo[]): Promise<BulkHeaderFileInfo[]>;
}
```

See also: [BulkHeaderFileInfo](./services.md#interface-bulkheaderfileinfo)

###### Method replaceBulkFiles

Atomically replace the complete bulk-file metadata set and return the
committed records, including identities allocated to new records.

Implementations must preserve existing stored data when a record with a
`fileId` omits `data`, and must leave the prior set unchanged on failure.
Managers require this capability for updates that affect multiple records.

```ts
replaceBulkFiles?(files: BulkHeaderFileInfo[]): Promise<BulkHeaderFileInfo[]>
```
See also: [BulkHeaderFileInfo](./services.md#interface-bulkheaderfileinfo)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: ChaintracksStorageIdbOptions

```ts
export interface ChaintracksStorageIdbOptions extends ChaintracksStorageBaseOptions {
}
```

See also: [ChaintracksStorageBaseOptions](./services.md#interface-chaintracksstoragebaseoptions)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: ChaintracksStorageIdbSchema

```ts
export interface ChaintracksStorageIdbSchema {
    liveHeaders: {
        key: number;
        value: LiveBlockHeader;
        indexes: {
            hash: string;
            previousHash: string;
            previousHeaderId: number | null;
            isActive: boolean;
            activeTip: [
                boolean,
                boolean
            ];
            height: number;
        };
    };
    bulkHeaders: {
        key: number;
        value: BulkHeaderFileInfo;
        indexes: {
            firstHeight: number;
        };
    };
}
```

See also: [BulkHeaderFileInfo](./services.md#interface-bulkheaderfileinfo), [LiveBlockHeader](./services.md#interface-liveblockheader)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: ChaintracksStorageIngestApi

```ts
export interface ChaintracksStorageIngestApi {
    log: (...args: any[]) => void;
    insertHeader(header: BlockHeader, prev?: LiveBlockHeader): Promise<InsertHeaderResult>;
    pruneLiveBlockHeaders(activeTipHeight: number): Promise<void>;
    migrateLiveToBulk(count: number): Promise<void>;
    deleteOlderLiveBlockHeaders(maxHeight: number): Promise<number>;
    makeAvailable(): Promise<void>;
    migrateLatest(): Promise<void>;
    dropAllData(): Promise<void>;
    destroy(): Promise<void>;
}
```

See also: [BlockHeader](./client.md#interface-blockheader), [InsertHeaderResult](./services.md#type-insertheaderresult), [LiveBlockHeader](./services.md#interface-liveblockheader)

###### Method deleteOlderLiveBlockHeaders

Delete live headers with height less or equal to `maxHeight`
after they have been migrated to bulk storage.

```ts
deleteOlderLiveBlockHeaders(maxHeight: number): Promise<number>
```

Argument Details

+ **maxHeight**
  + delete all records with less or equal `height`

###### Method destroy

Release all resources. Makes the instance unusable.

```ts
destroy(): Promise<void>
```

###### Method insertHeader

Attempts to insert a block header into the chain.

Returns 'added' false and 'dupe' true if header's hash already exists in the live database
Returns 'added' false and 'dupe' false if header's previousHash wasn't found in the live database, or height doesn't increment previous' height.

Computes the header's chainWork from its bits and the previous header's chainWork.

Returns 'added' true if the header was added to the live database.
Returns 'isActiveTip' true if header's chainWork is greater than current active chain tip's chainWork.

If the addition of this header caused a reorg (did not directly extend old active chain tip):
Returns 'reorgDepth' the minimum height difference of the common ancestor to the two chain tips.
Returns 'priorTip' the old active chain tip.
If not a reorg:
Returns 'reorgDepth' of zero.
Returns 'priorTip' the active chain tip before this insert. May be unchanged.

Implementation must call `pruneLiveBlockHeaders` after adding new header.

```ts
insertHeader(header: BlockHeader, prev?: LiveBlockHeader): Promise<InsertHeaderResult>
```
See also: [BlockHeader](./client.md#interface-blockheader), [InsertHeaderResult](./services.md#type-insertheaderresult), [LiveBlockHeader](./services.md#interface-liveblockheader)

Argument Details

+ **header**
  + to insert
+ **prev**
  + if not undefined, the last bulk storage header with total bulk chainWork

###### Method makeAvailable

Async initialization method.

May be called prior to other async methods to control when initialization occurs.

```ts
makeAvailable(): Promise<void>
```

###### Method migrateLatest

Migrate storage schema to latest schema changes.

Typically invoked automatically by `makeAvailable`.

```ts
migrateLatest(): Promise<void>
```

###### Method migrateLiveToBulk

Migrates the oldest `count` LiveBlockHeaders to BulkStorage.
BulkStorage must be configured.
`count` must not exceed `bulkMigrationChunkSize`.
`count` must leave at least `liveHeightThreshold` LiveBlockHeaders.

```ts
migrateLiveToBulk(count: number): Promise<void>
```

Argument Details

+ **count**
  + Steps:
- Copy count oldest active LiveBlockHeaders from live database to buffer.
- Append the buffer of headers to BulkStorage
- Add the buffer's BlockHash, Height pairs to corresponding index table.
- Add the buffer's MerkleRoot, Height pairs to corresponding index table.
- Delete the records from the live database.

###### Method pruneLiveBlockHeaders

Must be called after the addition of new LiveBlockHeaders.

Checks the `StorageEngine` configuration options to see
if BulkStorage is configured and if there is at least one
`bulkMigrationChunkSize` woth of headers in excess of
`liveHeightThreshold` available.

If yes, then calls `migrateLiveToBulk` one or more times.

```ts
pruneLiveBlockHeaders(activeTipHeight: number): Promise<void>
```

Argument Details

+ **activeTipHeight**
  + height of active tip after adds

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: ChaintracksStorageKnexOptions

```ts
export interface ChaintracksStorageKnexOptions extends ChaintracksStorageBaseOptions {
    knex: Knex | undefined;
}
```

See also: [ChaintracksStorageBaseOptions](./services.md#interface-chaintracksstoragebaseoptions)

###### Property knex

Required.

Knex.js database interface initialized with valid connection configuration.

```ts
knex: Knex | undefined
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: ChaintracksStorageMemoryOptions

```ts
export interface ChaintracksStorageMemoryOptions extends ChaintracksStorageKnexOptions {
    sqliteClient: "sqlite3" | "better-sqlite3" | undefined;
}
```

See also: [ChaintracksStorageKnexOptions](./services.md#interface-chaintracksstorageknexoptions)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: ChaintracksStorageNoDbOptions

```ts
export interface ChaintracksStorageNoDbOptions extends ChaintracksStorageBaseOptions {
}
```

See also: [ChaintracksStorageBaseOptions](./services.md#interface-chaintracksstoragebaseoptions)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: ChaintracksStorageQueryApi

```ts
export interface ChaintracksStorageQueryApi {
    log: (...args: any[]) => void;
    findChainTipHeader(): Promise<LiveBlockHeader>;
    findChainTipHash(): Promise<string>;
    findChainTipHeaderOrUndefined(): Promise<LiveBlockHeader | undefined>;
    findChainTipWork(): Promise<string>;
    findHeaderForHeight(height: number): Promise<LiveBlockHeader | BlockHeader>;
    findHeaderForHeightOrUndefined(height: number): Promise<LiveBlockHeader | BlockHeader | undefined>;
    findCommonAncestor(header1: LiveBlockHeader, header2: LiveBlockHeader): Promise<LiveBlockHeader>;
    findReorgDepth(header1: LiveBlockHeader, header2: LiveBlockHeader): Promise<number>;
    isMerkleRootActive(merkleRoot: string): Promise<boolean>;
    getHeadersUint8Array(height: number, count: number): Promise<Uint8Array>;
    getHeaders(height: number, count: number): Promise<BaseBlockHeader[]>;
    getLiveHeaders(range: HeightRange): Promise<LiveBlockHeader[]>;
    getBulkHeaders(range: HeightRange): Promise<Uint8Array>;
    findLiveHeaderForHeight(height: number): Promise<LiveBlockHeader | null>;
    findLiveHeaderForHeaderId(headerId: number): Promise<LiveBlockHeader>;
    findLiveHeaderForBlockHash(hash: string): Promise<LiveBlockHeader | null>;
    findLiveHeaderForMerkleRoot(merkleRoot: string): Promise<LiveBlockHeader | null>;
    getAvailableHeightRanges(): Promise<{
        bulk: HeightRange;
        live: HeightRange;
    }>;
    findLiveHeightRange(): Promise<HeightRange>;
    findMaxHeaderId(): Promise<number>;
    chain: Chain;
    liveHeightThreshold: number;
    reorgHeightThreshold: number;
    bulkMigrationChunkSize: number;
    batchInsertLimit: number;
}
```

See also: [BaseBlockHeader](./client.md#interface-baseblockheader), [BlockHeader](./client.md#interface-blockheader), [Chain](./client.md#type-chain), [HeightRange](./services.md#class-heightrange), [LiveBlockHeader](./services.md#interface-liveblockheader)

###### Property batchInsertLimit

Maximum number of headers per call to batchInsert

```ts
batchInsertLimit: number
```

###### Property bulkMigrationChunkSize

How many excess "live" headers to accumulate before migrating them as a chunk to the
bulk header storage.

```ts
bulkMigrationChunkSize: number
```

###### Property chain

Which chain is being tracked: "main" or "test".

```ts
chain: Chain
```
See also: [Chain](./client.md#type-chain)

###### Property liveHeightThreshold

How much of recent history is required to be kept in "live" block header storage.

Headers with height older than active chain tip height minus `liveHeightThreshold`
are not required to be kept in "live" storage and may be migrated to "bulk" storage.

```ts
liveHeightThreshold: number
```

###### Property reorgHeightThreshold

How much of recent history must be processed with full validation and reorg support.

May be less than `liveHeightThreshold`.

Headers with height older than active chain tip height minus ``
may use batch processing when ingesting headers.

```ts
reorgHeightThreshold: number
```

###### Method findChainTipHash

Returns the block hash of the active chain tip.

```ts
findChainTipHash(): Promise<string>
```

###### Method findChainTipHeader

Returns the active chain tip header
Throws an error if there is no tip.

```ts
findChainTipHeader(): Promise<LiveBlockHeader>
```
See also: [LiveBlockHeader](./services.md#interface-liveblockheader)

###### Method findChainTipHeaderOrUndefined

Returns the active chain tip header or undefined if there is no tip.

```ts
findChainTipHeaderOrUndefined(): Promise<LiveBlockHeader | undefined>
```
See also: [LiveBlockHeader](./services.md#interface-liveblockheader)

###### Method findChainTipWork

Returns the chainWork value of the active chain tip

```ts
findChainTipWork(): Promise<string>
```

###### Method findCommonAncestor

Given two chain tip headers in a chain reorg scenario,
return their common ancestor header.

```ts
findCommonAncestor(header1: LiveBlockHeader, header2: LiveBlockHeader): Promise<LiveBlockHeader>
```
See also: [LiveBlockHeader](./services.md#interface-liveblockheader)

Argument Details

+ **header1**
  + First header in live part of the chain.
+ **header2**
  + Second header in live part of the chain.

###### Method findHeaderForHeight

Returns block header for a given block height on active chain.

```ts
findHeaderForHeight(height: number): Promise<LiveBlockHeader | BlockHeader>
```
See also: [BlockHeader](./client.md#interface-blockheader), [LiveBlockHeader](./services.md#interface-liveblockheader)

Argument Details

+ **hash**
  + block hash

###### Method findHeaderForHeightOrUndefined

Returns block header for a given block height on active chain.

```ts
findHeaderForHeightOrUndefined(height: number): Promise<LiveBlockHeader | BlockHeader | undefined>
```
See also: [BlockHeader](./client.md#interface-blockheader), [LiveBlockHeader](./services.md#interface-liveblockheader)

Argument Details

+ **hash**
  + block hash

###### Method findLiveHeaderForBlockHash

Returns block header for a given block hash.
Only from the "live" portion of the chain.
Returns null if not found.

```ts
findLiveHeaderForBlockHash(hash: string): Promise<LiveBlockHeader | null>
```
See also: [LiveBlockHeader](./services.md#interface-liveblockheader)

Argument Details

+ **hash**
  + block hash

###### Method findLiveHeaderForHeaderId

Returns block header for a given headerId.

Only from the "live" portion of the chain.

```ts
findLiveHeaderForHeaderId(headerId: number): Promise<LiveBlockHeader>
```
See also: [LiveBlockHeader](./services.md#interface-liveblockheader)

###### Method findLiveHeaderForHeight

Returns block header for a given block height on active chain.

```ts
findLiveHeaderForHeight(height: number): Promise<LiveBlockHeader | null>
```
See also: [LiveBlockHeader](./services.md#interface-liveblockheader)

Argument Details

+ **hash**
  + block hash

###### Method findLiveHeaderForMerkleRoot

Returns block header for a given merkleRoot.
Only from the "live" portion of the chain.

```ts
findLiveHeaderForMerkleRoot(merkleRoot: string): Promise<LiveBlockHeader | null>
```
See also: [LiveBlockHeader](./services.md#interface-liveblockheader)

###### Method findLiveHeightRange

```ts
findLiveHeightRange(): Promise<HeightRange>
```
See also: [HeightRange](./services.md#class-heightrange)

Returns

The current minimum and maximum height active LiveBlockHeaders in the "live" database.

###### Method findMaxHeaderId

```ts
findMaxHeaderId(): Promise<number>
```

Returns

The maximum headerId value used by existing records or -1 if there are none.

###### Method findReorgDepth

This is an original API. Proposed deprecation in favor of `findCommonAncestor`
Given two headers that are both chain tips in a reorg scenario, returns
the depth of the reorg (the greater of the heights of the two provided
headers, minus the height of their last common ancestor)

```ts
findReorgDepth(header1: LiveBlockHeader, header2: LiveBlockHeader): Promise<number>
```
See also: [LiveBlockHeader](./services.md#interface-liveblockheader)

###### Method getAvailableHeightRanges

Returns the height range of both bulk and live storage.
Verifies that the ranges meet these requirements:
- Both may be empty.
- If bulk is empty, live must be empty or start with height zero.
- If bulk is not empty it must start with height zero.
- If bulk is not empty and live is not empty, live must start with the height after bulk.

```ts
getAvailableHeightRanges(): Promise<{
    bulk: HeightRange;
    live: HeightRange;
}>
```
See also: [HeightRange](./services.md#class-heightrange)

###### Method getBulkHeaders

Returns serialized bulk headers in the given range.

```ts
getBulkHeaders(range: HeightRange): Promise<Uint8Array>
```
See also: [HeightRange](./services.md#class-heightrange)

Returns

serialized headers as a Uint8Array.

###### Method getHeaders

Returns an array of deserialized headers.
Only adds bulk and active live headers.

```ts
getHeaders(height: number, count: number): Promise<BaseBlockHeader[]>
```
See also: [BaseBlockHeader](./client.md#interface-baseblockheader)

Returns

array of deserialized headers

Argument Details

+ **height**
  + is the minimum header height to return, must be >= zero.
+ **count**
  + height + count - 1 is the maximum header height to return.

###### Method getHeadersUint8Array

Returns serialized headers as a Uint8Array.
Only adds bulk and active live headers.

```ts
getHeadersUint8Array(height: number, count: number): Promise<Uint8Array>
```

Returns

serialized headers as a Uint8Array.

Argument Details

+ **height**
  + is the minimum header height to return, must be >= zero.
+ **count**
  + height + count - 1 is the maximum header height to return.

###### Method getLiveHeaders

Returns active `LiveBlockHeaders` with height in the given range.

```ts
getLiveHeaders(range: HeightRange): Promise<LiveBlockHeader[]>
```
See also: [HeightRange](./services.md#class-heightrange), [LiveBlockHeader](./services.md#interface-liveblockheader)

Returns

array of active `LiveBlockHeaders`

###### Method isMerkleRootActive

Returns true if the given merkleRoot is found in a block header on the active chain.

```ts
isMerkleRootActive(merkleRoot: string): Promise<boolean>
```

Argument Details

+ **merkleRoot**
  + of block header

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: ChaintracksWritableFileApi

Supports creation or re-creation of named data storage from position 0.
Any pre-existing data is initially removed.
Does not support reading existing data.

```ts
export interface ChaintracksWritableFileApi {
    path: string;
    close(): Promise<void>;
    append(data: Uint8Array): Promise<void>;
}
```

###### Method append

```ts
append(data: Uint8Array): Promise<void>
```

Argument Details

+ **data**
  + data to add to the end of existing data.

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: CreatedChaintracks

```ts
export interface CreatedChaintracks<TStorage extends ChaintracksOptions["storage"]> {
    chain: Chain;
    maxPerFile: number;
    fetch: ChaintracksFetchApi;
    storage: TStorage;
    chaintracks: Chaintracks;
    available: Promise<void>;
}
```

See also: [Chain](./client.md#type-chain), [Chaintracks](./services.md#class-chaintracks), [ChaintracksFetchApi](./services.md#interface-chaintracksfetchapi), [ChaintracksOptions](./services.md#interface-chaintracksoptions)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: DurableFileBulkFileDownloadBudgetOptions

```ts
export interface DurableFileBulkFileDownloadBudgetOptions {
    maxBytes: number;
    stateFile: string;
    windowMsecs?: number;
    now?: () => number;
    lockTimeoutMsecs?: number;
    lockRetryMsecs?: number;
}
```

###### Property lockRetryMsecs

Delay between cross-process lock attempts. Default: 25 milliseconds.

```ts
lockRetryMsecs?: number
```

###### Property lockTimeoutMsecs

Maximum wait for the cross-process state lock. Default: 30 seconds.

```ts
lockTimeoutMsecs?: number
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: ExchangeRatesIoApi

```ts
export interface ExchangeRatesIoApi {
    success: true;
    timestamp: number;
    base: "EUR" | "USD";
    date: string;
    rates: Record<string, number>;
}
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: FixedWindowBulkFileDownloadBudgetOptions

```ts
export interface FixedWindowBulkFileDownloadBudgetOptions {
    maxBytes: number;
    windowMsecs?: number;
    now?: () => number;
}
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: GetHeaderByteFileLinksResult

```ts
export interface GetHeaderByteFileLinksResult {
    sourceUrl: string;
    fileName: string;
    range: HeightRange;
    data: Uint8Array | undefined;
    publicNetworkOnly: true;
}
```

See also: [HeightRange](./services.md#class-heightrange)

###### Property publicNetworkOnly

The URL came from a remote resource manifest and must remain public HTTPS.

```ts
publicNetworkOnly: true
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: GoChaintracksServiceClientOptions

```ts
export interface GoChaintracksServiceClientOptions {
    apiPrefix?: string;
    fetch?: typeof fetch;
    requestTimeoutMsecs?: number;
    reconnectWaitMsecs?: number;
    reconnectWaitMaxMsecs?: number;
    maxJsonResponseBytes?: number;
    maxBinaryResponseBytes?: number;
    maxSseEventBytes?: number;
    maxReorgHeaders?: number;
    streamIdleTimeoutMsecs?: number;
}
```

###### Property apiPrefix

Path prefix for the go-chaintracks HTTP API.
Arcade exposes this at `/chaintracks/v2`.

```ts
apiPrefix?: string
```

###### Property maxBinaryResponseBytes

Maximum binary header response size. Default: 32 MiB.

```ts
maxBinaryResponseBytes?: number
```

###### Property maxJsonResponseBytes

Maximum decoded JSON response size. Default: 1 MiB.

```ts
maxJsonResponseBytes?: number
```

###### Property maxReorgHeaders

Maximum number of deactivated headers accepted in one reorg event. Default: 4096.

```ts
maxReorgHeaders?: number
```

###### Property maxSseEventBytes

Maximum size of one incomplete or complete SSE event. Default: 1 MiB.

```ts
maxSseEventBytes?: number
```

###### Property reconnectWaitMaxMsecs

Maximum SSE reconnect delay.

```ts
reconnectWaitMaxMsecs?: number
```

###### Property reconnectWaitMsecs

Initial delay before reconnecting a closed or failed SSE stream.

```ts
reconnectWaitMsecs?: number
```

###### Property requestTimeoutMsecs

Timeout for HTTP requests and the initial SSE handshake.

```ts
requestTimeoutMsecs?: number
```

###### Property streamIdleTimeoutMsecs

Maximum delay between SSE chunks before reconnecting. Default: 45 seconds.

```ts
streamIdleTimeoutMsecs?: number
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: HeightRangeApi

```ts
export interface HeightRangeApi {
    minHeight: number;
    maxHeight: number;
}
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: HeightRanges

```ts
export interface HeightRanges {
    bulk: HeightRange;
    live: HeightRange;
}
```

See also: [HeightRange](./services.md#class-heightrange)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: LiveBlockHeader

The "live" portion of the block chain is recent history that can conceivably be subject to reorganizations.
The additional fields support tracking orphan blocks, chain forks, and chain reorgs.

```ts
export interface LiveBlockHeader extends BlockHeader {
    chainWork: string;
    isChainTip: boolean;
    isActive: boolean;
    headerId: number;
    previousHeaderId: number | null;
}
```

See also: [BlockHeader](./client.md#interface-blockheader)

###### Property chainWork

The cumulative chainwork achieved by the addition of this block to the chain.
Chainwork only matters in selecting the active chain.

```ts
chainWork: string
```

###### Property headerId

As there may be more than one header with identical height values due to orphan tracking,
headers are assigned a unique headerId while part of the "live" portion of the block chain.

```ts
headerId: number
```

###### Property isActive

True only if this header is currently on the active chain.

```ts
isActive: boolean
```

###### Property isChainTip

True only if this header is currently a chain tip. e.g. There is no header that follows it by previousHash or previousHeaderId.

```ts
isChainTip: boolean
```

###### Property previousHeaderId

Every header in the "live" portion of the block chain is linked to an ancestor header through
both its previousHash and previousHeaderId properties.

Due to forks, there may be multiple headers with identical `previousHash` and `previousHeaderId` values.
Of these, only one (the header on the active chain) will have `isActive` === true.

```ts
previousHeaderId: number | null
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: LiveIngestorApi

```ts
export interface LiveIngestorApi {
    shutdown(): Promise<void>;
    getHeaderByHash(hash: string): Promise<BlockHeader | undefined>;
    setStorage(storage: ChaintracksStorageApi, log: (...args: any[]) => void): Promise<void>;
    storage(): ChaintracksStorageApi;
    startListening(liveHeaders: BlockHeader[]): Promise<void>;
    stopListening(): void;
}
```

See also: [BlockHeader](./client.md#interface-blockheader), [ChaintracksStorageApi](./services.md#interface-chaintracksstorageapi)

###### Method setStorage

Called before first Synchronize with reference to storage.
Components requiring asynchronous setup can override base class implementation.

```ts
setStorage(storage: ChaintracksStorageApi, log: (...args: any[]) => void): Promise<void>
```
See also: [ChaintracksStorageApi](./services.md#interface-chaintracksstorageapi)

###### Method shutdown

Close and release all resources.

```ts
shutdown(): Promise<void>
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: LiveIngestorBaseOptions

```ts
export interface LiveIngestorBaseOptions {
    chain: Chain;
}
```

See also: [Chain](./client.md#type-chain)

###### Property chain

The target chain: "main" or "test"

```ts
chain: Chain
```
See also: [Chain](./client.md#type-chain)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: LiveIngestorChaintracksSSEOptions

```ts
export interface LiveIngestorChaintracksSSEOptions extends LiveIngestorBaseOptions {
    chaintracks: ChaintracksClientApi;
    maxQueuedHeaders?: number;
}
```

See also: [ChaintracksClientApi](./services.md#interface-chaintracksclientapi), [LiveIngestorBaseOptions](./services.md#interface-liveingestorbaseoptions)

###### Property maxQueuedHeaders

Maximum number of remote events retained for local processing. Default: 4096.

```ts
maxQueuedHeaders?: number
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: LiveIngestorWhatsOnChainOptions

```ts
export interface LiveIngestorWhatsOnChainOptions extends LiveIngestorBaseOptions, WhatsOnChainServicesOptions {
    idleWait: number | undefined;
    chain: Chain;
    apiKey?: string;
    timeout: number;
    userAgent: string;
    enableCache: boolean;
    chainInfoMsecs: number;
    retryWait?: number;
    retryWaitMax?: number;
    maxQueuedHeaders?: number;
}
```

See also: [Chain](./client.md#type-chain), [LiveIngestorBaseOptions](./services.md#interface-liveingestorbaseoptions), [WhatsOnChainServicesOptions](./services.md#interface-whatsonchainservicesoptions)

###### Property apiKey

WhatsOnChain.com API Key
https://docs.taal.com/introduction/get-an-api-key
If unknown or empty, maximum request rate is limited.
https://developers.whatsonchain.com/#rate-limits

```ts
apiKey?: string
```

###### Property chain

Which chain is being tracked: main, test, or stn.

```ts
chain: Chain
```
See also: [Chain](./client.md#type-chain)

###### Property chainInfoMsecs

How long chainInfo is considered still valid before updating (msecs).

```ts
chainInfoMsecs: number
```

###### Property enableCache

Enable WhatsOnChain client cache option.

```ts
enableCache: boolean
```

###### Property idleWait

Maximum msces of "normal" time with no ping received from connected WoC service.

```ts
idleWait: number | undefined
```

###### Property maxQueuedHeaders

Maximum number of validated headers retained for the consumer. Defaults to 4096.

```ts
maxQueuedHeaders?: number
```

###### Property retryWait

Initial delay before retrying a failed polling request.

```ts
retryWait?: number
```

###### Property retryWaitMax

Maximum delay before retrying repeated failed polling requests.

```ts
retryWaitMax?: number
```

###### Property timeout

Request timeout for GETs to https://api.whatsonchain.com/v1/bsv

```ts
timeout: number
```

###### Property userAgent

User-Agent header value for requests to https://api.whatsonchain.com/v1/bsv

```ts
userAgent: string
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: LocalChainTrackerOptions

```ts
export interface LocalChainTrackerOptions {
    local: ChaintracksClientApi;
    fallbacks?: ChaintracksClientApi[];
    mode?: LocalChainTrackerMode;
    fallbackOnLocalError?: boolean;
    requiredFallbackAgreement?: number;
    requiredConsistencyAgreement?: number;
    maxHeightLag?: number;
    autoRecover?: boolean;
    recoverLocal?: (evidence: LocalChainTrackerRecoveryEvidence) => Promise<ChaintracksClientApi>;
    clearLocal?: () => Promise<ChaintracksClientApi>;
    now?: () => Date;
}
```

See also: [ChaintracksClientApi](./services.md#interface-chaintracksclientapi), [LocalChainTrackerMode](./services.md#type-localchaintrackermode), [LocalChainTrackerRecoveryEvidence](./services.md#interface-localchaintrackerrecoveryevidence)

###### Property clearLocal

Clears local state and returns a fresh local client.

```ts
clearLocal?: () => Promise<ChaintracksClientApi>
```
See also: [ChaintracksClientApi](./services.md#interface-chaintracksclientapi)

###### Property fallbacks

Independent references used for diagnostics and exceptional fallback.

```ts
fallbacks?: ChaintracksClientApi[]
```
See also: [ChaintracksClientApi](./services.md#interface-chaintracksclientapi)

###### Property local

Locally persisted, proof-of-work-validating ChainTracks client.

```ts
local: ChaintracksClientApi
```
See also: [ChaintracksClientApi](./services.md#interface-chaintracksclientapi)

###### Property maxHeightLag

Quorum-backed height lag tolerated before local state is considered stuck.

```ts
maxHeightLag?: number
```

###### Property recoverLocal

Clears/reseeds local state and returns the replacement local client.

```ts
recoverLocal?: (evidence: LocalChainTrackerRecoveryEvidence) => Promise<ChaintracksClientApi>
```
See also: [ChaintracksClientApi](./services.md#interface-chaintracksclientapi), [LocalChainTrackerRecoveryEvidence](./services.md#interface-localchaintrackerrecoveryevidence)

###### Property requiredConsistencyAgreement

Number of matching references needed to declare local divergence.

```ts
requiredConsistencyAgreement?: number
```

###### Property requiredFallbackAgreement

Number of matching references needed for a fallback validation result.

```ts
requiredFallbackAgreement?: number
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: LocalChainTrackerRecoveryEvidence

```ts
export interface LocalChainTrackerRecoveryEvidence {
    reason: "lagging" | "diverged";
    localHeight: number;
    referenceHeight: number;
    heightLag: number;
    comparisonHeight: number;
    expectedHash: string;
    referenceAgreement: number;
}
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: LocalChainTrackerStatus

```ts
export interface LocalChainTrackerStatus {
    mode: LocalChainTrackerMode;
    activeSource: string;
    consistency: LocalChainTrackerConsistency;
    localHeight?: number;
    localTipHash?: string;
    referenceHeight?: number;
    heightLag?: number;
    comparisonHeight?: number;
    expectedHash?: string;
    referenceAgreement?: number;
    checkedAt?: string;
    recoveredAt?: string;
    lastFallbackAt?: string;
    lastError?: string;
}
```

See also: [LocalChainTrackerConsistency](./services.md#type-localchaintrackerconsistency), [LocalChainTrackerMode](./services.md#type-localchaintrackermode)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: MerklePathNote

```ts
export interface MerklePathNote {
    what: MerklePathNoteWhat;
    name: string;
    status?: number;
    statusText?: string;
    target?: string;
    code?: string;
    description?: string;
    [key: string]: boolean | string | number | undefined;
}
```

See also: [MerklePathNoteWhat](./services.md#type-merklepathnotewhat)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: MerkleRootValidator

```ts
export interface MerkleRootValidator {
    isValidRootForHeight(root: string, height: number): Promise<boolean>;
}
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: NodeBulkFileDataValidatorOptions

```ts
export interface NodeBulkFileDataValidatorOptions {
    maxWorkers?: number;
    maxQueue?: number;
    taskTimeoutMsecs?: number;
    workerPath?: string;
}
```

###### Property maxQueue

Maximum number of waiting validations. Defaults to eight.

```ts
maxQueue?: number
```

###### Property maxWorkers

Number of validation workers. Defaults to one to bound CPU usage.

```ts
maxWorkers?: number
```

###### Property taskTimeoutMsecs

Per-object validation deadline. Defaults to two minutes.

```ts
taskTimeoutMsecs?: number
```

###### Property workerPath

Test-only worker entry override.

```ts
workerPath?: string
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: NormalizedArcProviderConfig

```ts
export interface NormalizedArcProviderConfig {
    apiKey?: string;
    httpClient: HttpClient;
    deploymentId: string;
    callbackUrl?: string;
    callbackToken?: string;
    headers?: Readonly<Record<string, string>>;
}
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: OutputUtxoClassification

```ts
export interface OutputUtxoClassification {
    verdict: OutputUtxoVerdict;
    provider: string;
    error?: unknown;
}
```

See also: [OutputUtxoVerdict](./services.md#type-outpututxoverdict)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: ResolvedDefaultChaintracksParams

```ts
export interface ResolvedDefaultChaintracksParams extends ChaintracksIngestorParams {
    maxRetained: number;
    liveHeightThreshold: number;
    reorgHeightThreshold: number;
    bulkMigrationChunkSize: number;
    batchInsertLimit: number;
}
```

See also: [ChaintracksIngestorParams](./services.md#interface-chaintracksingestorparams)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: ResolvedDefaultKnexChaintracksParams

```ts
export interface ResolvedDefaultKnexChaintracksParams extends ResolvedDefaultChaintracksParams {
    rootFolder: string;
    knexConfig?: Knex.Config;
}
```

See also: [ResolvedDefaultChaintracksParams](./services.md#interface-resolveddefaultchaintracksparams)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: ScriptHashHistoryResponse

```ts
export interface ScriptHashHistoryResponse {
    ok: boolean;
    status: number;
    statusText: string;
    data?: {
        result: Array<{
            tx_hash: string;
            height?: number;
        }>;
        error?: string;
    };
}
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: ServiceCall

```ts
export interface ServiceCall {
    when: Date | string;
    msecs: number;
    success: boolean;
    result?: string;
    error?: {
        message: string;
        code: string;
    };
}
```

###### Property error

Error code and message iff success is false and a exception was thrown.

```ts
error?: {
    message: string;
    code: string;
}
```

###### Property result

Simple text summary of result. e.g. `not a valid utxo` or `valid utxo`

```ts
result?: string
```

###### Property success

true iff service provider successfully processed the request
false iff service provider failed to process the request which includes thrown errors.

```ts
success: boolean
```

###### Property when

string value must be Date's toISOString format.

```ts
when: Date | string
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: ServiceToCall

```ts
export interface ServiceToCall<T> {
    providerName: string;
    serviceName: string;
    service: T;
    call: ServiceCall;
}
```

See also: [ServiceCall](./services.md#interface-servicecall)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: SnapshotMerklePathResult

```ts
export interface SnapshotMerklePathResult extends Omit<GetMerklePathResult, "merklePath"> {
    merklePath?: MerklePath | MerklePath[];
}
```

See also: [GetMerklePathResult](./client.md#interface-getmerklepathresult)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: StopListenerToken

```ts
export interface StopListenerToken {
    stop: (() => void) | undefined;
}
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: ValidatedMerklePathResult

```ts
export interface ValidatedMerklePathResult {
    merklePath: MerklePath;
    header: BlockHeader;
    root: string;
    index: number;
}
```

See also: [BlockHeader](./client.md#interface-blockheader)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: ValidatedPostBeefRequest

```ts
export interface ValidatedPostBeefRequest {
    beefBytes: number[];
    txids: string[];
}
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: WalletToolboxWhatsOnChainConfig

```ts
export interface WalletToolboxWhatsOnChainConfig extends WhatsOnChainConfig {
    requestGate?: () => Promise<void>;
    requestTimeoutMsecs?: number;
}
```

###### Property requestGate

Optional request-start gate used by ChainTracks' shared public-rate scheduler.

```ts
requestGate?: () => Promise<void>
```

###### Property requestTimeoutMsecs

Whole-request deadline applied to every explorer call. Defaults to 30 seconds.

```ts
requestTimeoutMsecs?: number
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: WhatsOnChainServicesOptions

```ts
export interface WhatsOnChainServicesOptions {
    chain: Chain;
    apiKey?: string;
    timeout: number;
    userAgent: string;
    enableCache: boolean;
    chainInfoMsecs: number;
    minRequestIntervalMsecs?: number;
}
```

See also: [Chain](./client.md#type-chain)

###### Property apiKey

Optional WhatsOnChain API key. ChainTracks works without one and limits
anonymous traffic to the documented public rate.
https://docs.whatsonchain.com/

```ts
apiKey?: string
```

###### Property chain

Which chain is being tracked. The public WhatsOnChain fallback is only
configured automatically for mainnet and testnet.

```ts
chain: Chain
```
See also: [Chain](./client.md#type-chain)

###### Property chainInfoMsecs

How long chainInfo is considered still valid before updating (msecs).

```ts
chainInfoMsecs: number
```

###### Property enableCache

Enable WhatsOnChain client cache option.

```ts
enableCache: boolean
```

###### Property minRequestIntervalMsecs

Minimum interval between keyless API request starts. Defaults below 3 requests/second.

```ts
minRequestIntervalMsecs?: number
```

###### Property timeout

Request timeout for GETs to https://api.whatsonchain.com/v1/bsv

```ts
timeout: number
```

###### Property userAgent

User-Agent header value for requests to https://api.whatsonchain.com/v1/bsv

```ts
userAgent: string
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: WocChainInfo

```ts
export interface WocChainInfo {
    chain: string;
    blocks: number;
    headers: number;
    bestblockhash: string;
    difficulty: number;
    mediantime: number;
    verificationprogress: number;
    pruned: boolean;
    chainwork: string;
}
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: WocGetHeaderByteFileLinks

```ts
export interface WocGetHeaderByteFileLinks {
    files: string[];
}
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: WocGetHeadersHeader

```ts
export interface WocGetHeadersHeader {
    hash: string;
    confirmations: number;
    size: number;
    height: number;
    version: number;
    versionHex: string;
    merkleroot: string;
    time: number;
    mediantime: number;
    nonce: number;
    bits: string;
    difficulty: number;
    chainwork: string;
    previousblockhash: string;
    nextblockhash: string;
    nTx: number;
    num_tx: number;
}
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: WocHeader

```ts
export interface WocHeader {
    hash: string;
    size: number;
    height: number;
    version: number;
    versionHex: string;
    merkleroot: string;
    time: number;
    mediantime: number;
    nonce: number;
    bits: number | string;
    difficulty: number;
    chainwork: string;
    previousblockhash: string;
    confirmations: number;
    txcount: number;
    nextblockhash: string;
}
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
#### Classes

| | | |
| --- | --- | --- |
| [ARC](#class-arc) | [BulkIngestorChaintracks](#class-bulkingestorchaintracks) | [DurableFileBulkFileDownloadBudget](#class-durablefilebulkfiledownloadbudget) |
| [ArcSSEClient](#class-arcsseclient) | [BulkIngestorWhatsOnChainCdn](#class-bulkingestorwhatsonchaincdn) | [FixedWindowBulkFileDownloadBudget](#class-fixedwindowbulkfiledownloadbudget) |
| [Arcade](#class-arcade) | [BulkIngestorWhatsOnChainWs](#class-bulkingestorwhatsonchainws) | [GoChaintracksServiceClient](#class-gochaintracksserviceclient) |
| [BHServiceClient](#class-bhserviceclient) | [BulkStorageBase](#class-bulkstoragebase) | [HeightRange](#class-heightrange) |
| [Bitails](#class-bitails) | [Chaintracks](#class-chaintracks) | [InlineBulkFileDataValidator](#class-inlinebulkfiledatavalidator) |
| [BulkFileDataCacheFs](#class-bulkfiledatacachefs) | [ChaintracksAppendableFile](#class-chaintracksappendablefile) | [LiveIngestorBase](#class-liveingestorbase) |
| [BulkFileDataManager](#class-bulkfiledatamanager) | [ChaintracksChainTracker](#class-chaintrackschaintracker) | [LiveIngestorChaintracksSSE](#class-liveingestorchaintrackssse) |
| [BulkFileDataReader](#class-bulkfiledatareader) | [ChaintracksFetch](#class-chaintracksfetch) | [LiveIngestorWhatsOnChainPoll](#class-liveingestorwhatsonchainpoll) |
| [BulkFileDataValidationError](#class-bulkfiledatavalidationerror) | [ChaintracksFetchError](#class-chaintracksfetcherror) | [LiveIngestorWhatsOnChainWs](#class-liveingestorwhatsonchainws) |
| [BulkFilesReader](#class-bulkfilesreader) | [ChaintracksFsStatics](#class-chaintracksfsstatics) | [LocalChainTracker](#class-localchaintracker) |
| [BulkFilesReaderFs](#class-bulkfilesreaderfs) | [ChaintracksKnexMigrations](#class-chaintracksknexmigrations) | [NodeBulkFileDataValidator](#class-nodebulkfiledatavalidator) |
| [BulkFilesReaderStorage](#class-bulkfilesreaderstorage) | [ChaintracksReadableFile](#class-chaintracksreadablefile) | [SdkWhatsOnChain](#class-sdkwhatsonchain) |
| [BulkHeaderFile](#class-bulkheaderfile) | [ChaintracksService](#class-chaintracksservice) | [ServiceCollection](#class-servicecollection) |
| [BulkHeaderFileFs](#class-bulkheaderfilefs) | [ChaintracksServiceClient](#class-chaintracksserviceclient) | [Services](#class-services) |
| [BulkHeaderFileStorage](#class-bulkheaderfilestorage) | [ChaintracksStorageBase](#class-chaintracksstoragebase) | [SingleWriterMultiReaderLock](#class-singlewritermultireaderlock) |
| [BulkHeaderFiles](#class-bulkheaderfiles) | [ChaintracksStorageIdb](#class-chaintracksstorageidb) | [WhatsOnChain](#class-whatsonchain) |
| [BulkIngestorBase](#class-bulkingestorbase) | [ChaintracksStorageKnex](#class-chaintracksstorageknex) | [WhatsOnChainNoServices](#class-whatsonchainnoservices) |
| [BulkIngestorCDN](#class-bulkingestorcdn) | [ChaintracksStorageNoDb](#class-chaintracksstoragenodb) | [WhatsOnChainServices](#class-whatsonchainservices) |
| [BulkIngestorCDNBabbage](#class-bulkingestorcdnbabbage) | [ChaintracksWritableFile](#class-chaintrackswritablefile) |  |

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---

##### Class: ARC

Represents an ARC transaction broadcaster.

```ts
export class ARC {
    readonly name: string;
    readonly URL: string;
    readonly apiKey: string | undefined;
    readonly deploymentId: string;
    readonly callbackUrl: string | undefined;
    readonly callbackToken: string | undefined;
    readonly headers: Record<string, string> | undefined;
    constructor(URL: string, config?: ArcConfig, name?: string);
    constructor(URL: string, apiKey?: string, name?: string);
    constructor(URL: string, config?: string | ArcConfig, name?: string)
    async postRawTx(rawTx: HexString, txids?: string[]): Promise<PostTxResultForTxid>
    async postBeef(beef: Beef, txids: string[]): Promise<PostBeefResult>
    async getTxData(txid: string): Promise<ArcMinerGetTxData>
}
```

See also: [ArcConfig](./services.md#interface-arcconfig), [ArcMinerGetTxData](./services.md#interface-arcminergettxdata), [PostBeefResult](./client.md#interface-postbeefresult), [PostTxResultForTxid](./client.md#interface-posttxresultfortxid)

###### Constructor

Constructs an instance of the ARC broadcaster.

```ts
constructor(URL: string, config?: ArcConfig, name?: string)
```
See also: [ArcConfig](./services.md#interface-arcconfig)

Argument Details

+ **URL**
  + The URL endpoint for the ARC API.
+ **config**
  + Configuration options for the ARC broadcaster.

###### Constructor

Constructs an instance of the ARC broadcaster.

```ts
constructor(URL: string, apiKey?: string, name?: string)
```

Argument Details

+ **URL**
  + The URL endpoint for the ARC API.
+ **apiKey**
  + The API key used for authorization with the ARC API.

###### Method getTxData

This seems to only work for recently submitted txids...but that's all we need to complete postBeef!

```ts
async getTxData(txid: string): Promise<ArcMinerGetTxData>
```
See also: [ArcMinerGetTxData](./services.md#interface-arcminergettxdata)

###### Method postBeef

ARC does not natively support a postBeef end-point aware of multiple txids of interest in the Beef.

It does process multiple new transactions, however, which allows results for all txids of interest
to be collected by the `/v1/tx/${txid}` endpoint.

```ts
async postBeef(beef: Beef, txids: string[]): Promise<PostBeefResult>
```
See also: [PostBeefResult](./client.md#interface-postbeefresult)

###### Method postRawTx

The ARC '/v1/tx' endpoint, as of 2025-02-17 supports all of the following hex string formats:
  1. Single serialized raw transaction.
  2. Single EF serialized raw transaction (untested).
  3. V1 serialized Beef (results returned reflect only the last transaction in the beef)

The ARC '/v1/tx' endpoint, as of 2025-02-17 DOES NOT support the following hex string formats:
  1. V2 serialized Beef

```ts
async postRawTx(rawTx: HexString, txids?: string[]): Promise<PostTxResultForTxid>
```
See also: [PostTxResultForTxid](./client.md#interface-posttxresultfortxid)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Class: ArcSSEClient

```ts
export class ArcSSEClient {
    constructor(options: ArcSSEClientOptions)
    get lastEventId(): string | undefined
    connect(): void
    close(): void
    async fetchEvents(): Promise<number>
}
```

See also: [ArcSSEClientOptions](./services.md#interface-arcsseclientoptions)

###### Method close

Close the connection, discard unacknowledged network events, and reset lifecycle state.

```ts
close(): void
```

###### Method connect

Open the SSE connection. Events are processed serially in exact arrival order.

```ts
connect(): void
```

###### Method fetchEvents

Ensure a connection is open; events still commit asynchronously in arrival order.

```ts
async fetchEvents(): Promise<number>
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Class: Arcade

```ts
export class Arcade {
    readonly name: string;
    readonly URL: string;
    readonly apiKey: string | undefined;
    readonly deploymentId: string;
    readonly callbackUrl: string | undefined;
    readonly callbackToken: string | undefined;
    readonly headers: Record<string, string> | undefined;
    constructor(URL: string, config?: ArcConfig, name?: string);
    constructor(URL: string, apiKey?: string, name?: string);
    constructor(URL: string, config?: string | ArcConfig, name?: string)
    async postRawTx(rawTx: HexString, txids?: string[]): Promise<PostTxResultForTxid>
    async postBeef(beef: Beef, txids: string[]): Promise<PostBeefResult>
    async getTxData(txid: string): Promise<ArcMinerGetTxData>
    async getStatusForTxids(txids: string[]): Promise<GetStatusForTxidsResult>
    async getMerklePath(txid: string, services: WalletServices): Promise<GetMerklePathResult>
}
```

See also: [ArcConfig](./services.md#interface-arcconfig), [ArcMinerGetTxData](./services.md#interface-arcminergettxdata), [GetMerklePathResult](./client.md#interface-getmerklepathresult), [GetStatusForTxidsResult](./client.md#interface-getstatusfortxidsresult), [PostBeefResult](./client.md#interface-postbeefresult), [PostTxResultForTxid](./client.md#interface-posttxresultfortxid), [WalletServices](./client.md#interface-walletservices)

###### Constructor

```ts
constructor(URL: string, config?: ArcConfig, name?: string)
```
See also: [ArcConfig](./services.md#interface-arcconfig)

Argument Details

+ **URL**
  + The Arcade endpoint base URL.

###### Method getStatusForTxids

Adapt Arcade's lifecycle endpoint to the shared transaction-status
provider contract. This lets monitor reconciliation remain operational
when an explorer such as WhatsOnChain is absent. Only network-observed
states count as known; RECEIVED/PENDING_RETRY and terminal rejection
states remain unknown, while MINED/IMMUTABLE are authoritative mined
observations whose proof is validated separately.

```ts
async getStatusForTxids(txids: string[]): Promise<GetStatusForTxidsResult>
```
See also: [GetStatusForTxidsResult](./client.md#interface-getstatusfortxidsresult)

###### Method getTxData

Look up a transaction's current status (and merkle path once mined) via `GET /tx/{txid}`.

```ts
async getTxData(txid: string): Promise<ArcMinerGetTxData>
```
See also: [ArcMinerGetTxData](./services.md#interface-arcminergettxdata)

###### Method postRawTx

Submit a single transaction to Arcade's `POST /tx` endpoint.

`rawTx` must be a single (raw or Extended Format) transaction hex — NOT BEEF. The canonical
txid is taken from `txids` when supplied (Arcade derives the same txid from the parsed tx).

```ts
async postRawTx(rawTx: HexString, txids?: string[]): Promise<PostTxResultForTxid>
```
See also: [PostTxResultForTxid](./client.md#interface-posttxresultfortxid)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Class: BHServiceClient

```ts
export class BHServiceClient implements ChaintracksClientApi {
    bhs: BlockHeadersService;
    cache: Record<number, string>;
    chain: Chain;
    serviceUrl: string;
    options: ChaintracksServiceClientOptions;
    apiKey: string;
    constructor(chain: Chain, url: string, apiKey: string, options: ChaintracksServiceClientOptions = {})
    async currentHeight(): Promise<number>
    async isValidRootForHeight(root: string, height: number): Promise<boolean>
    async getPresentHeight(): Promise<number>
    async findHeaderForHeight(height: number): Promise<BlockHeader | undefined>
    async findHeaderForBlockHash(hash: string): Promise<BlockHeader | undefined>
    async getHeaders(height: number, count: number): Promise<string>
    async findChainWorkForBlockHash(_hash: string): Promise<string | undefined>
    async findChainTipHeader(): Promise<BlockHeader>
    async getJsonOrUndefined<T>(path: string): Promise<T | undefined>
    async getJson<T>(path: string): Promise<T>
    async postJsonVoid<T>(_path: string, _params: T): Promise<void>
    async addHeader(_header: any): Promise<void>
    async findHeaderForMerkleRoot(_merkleRoot: string, _height?: number): Promise<undefined>
    async startListening(): Promise<void>
    async listening(): Promise<void>
    async isSynchronized(): Promise<boolean>
    async getChain(): Promise<Chain>
    async isListening(): Promise<boolean>
    async getChainTipHeader(): Promise<BlockHeader>
    async findChainTipHash(): Promise<string>
    async subscribeHeaders(_listener: HeaderListener): Promise<string>
    async subscribeReorgs(_listener: ReorgListener): Promise<string>
    async unsubscribe(_subscriptionId: string): Promise<boolean>
    async getInfo(): Promise<ChaintracksInfoApi>
}
```

See also: [BlockHeader](./client.md#interface-blockheader), [Chain](./client.md#type-chain), [ChaintracksClientApi](./services.md#interface-chaintracksclientapi), [ChaintracksInfoApi](./services.md#interface-chaintracksinfoapi), [ChaintracksServiceClientOptions](./services.md#interface-chaintracksserviceclientoptions), [HeaderListener](./services.md#type-headerlistener), [ReorgListener](./services.md#type-reorglistener)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Class: Bitails

```ts
export class Bitails {
    readonly chain: Chain;
    readonly apiKey: string;
    readonly URL: string;
    readonly httpClient: HttpClient;
    readonly requestTimeoutMsecs: number;
    constructor(chain: Chain = "main", config: BitailsConfig = {})
    getHttpHeaders(): Record<string, string>
    async postBeef(beef: Beef, txids: string[]): Promise<PostBeefResult>
    async postRaws(raws: HexString[], txids?: string[]): Promise<PostBeefResult>
    async getMerklePath(txid: string, services: WalletServices): Promise<GetMerklePathResult>
}
```

See also: [BitailsConfig](./services.md#interface-bitailsconfig), [Chain](./client.md#type-chain), [GetMerklePathResult](./client.md#interface-getmerklepathresult), [PostBeefResult](./client.md#interface-postbeefresult), [WalletServices](./client.md#interface-walletservices)

###### Method postBeef

Bitails does not natively support a postBeef end-point aware of multiple txids of interest in the Beef.

Send rawTx in `txids` order from beef.

```ts
async postBeef(beef: Beef, txids: string[]): Promise<PostBeefResult>
```
See also: [PostBeefResult](./client.md#interface-postbeefresult)

###### Method postRaws

```ts
async postRaws(raws: HexString[], txids?: string[]): Promise<PostBeefResult>
```
See also: [PostBeefResult](./client.md#interface-postbeefresult)

Argument Details

+ **raws**
  + Array of raw transactions to broadcast as hex strings
+ **txids**
  + Array of txids for transactions in raws for which results are requested, remaining raws are supporting only.

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Class: BulkFileDataCacheFs

Atomic filesystem implementation of the bulk-header cache contract.

This Node-only export is intentionally absent from browser and mobile entry
points. Cache contents are untrusted until the manager verifies their exact
byte length and SHA-256 digest.

```ts
export class BulkFileDataCacheFs implements BulkFileDataCacheApi {
    constructor(rootFolderOrOptions: string | BulkFileDataCacheFsOptions)
    async get(file: Readonly<BulkHeaderFileInfo>): Promise<Uint8Array | undefined>
    async set(file: Readonly<BulkHeaderFileInfo>, data: Uint8Array): Promise<void>
    async promoteValidated(file: Readonly<BulkHeaderFileInfo>, data: Uint8Array): Promise<void>
    async quarantine(file: Readonly<BulkHeaderFileInfo>, reason: string, rejectedData?: Uint8Array): Promise<void>
    async delete(file: Readonly<BulkHeaderFileInfo>): Promise<void>
}
```

See also: [BulkFileDataCacheApi](./services.md#interface-bulkfiledatacacheapi), [BulkFileDataCacheFsOptions](./services.md#interface-bulkfiledatacachefsoptions), [BulkHeaderFileInfo](./services.md#interface-bulkheaderfileinfo)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Class: BulkFileDataManager

Manages bulk file data (typically 8MB chunks of 100,000 headers each).

If not cached in memory,
optionally fetches data by `sourceUrl` from CDN on demand,
optionally finds data by `fileId` in a database on demand,
and retains a limited number of files in memory,
subject to the optional `maxRetained` limit.

```ts
export class BulkFileDataManager {
    static createDefaultOptions(chain: Chain): BulkFileDataManagerOptions
    readonly chain: Chain;
    readonly maxPerFile: number;
    readonly fetch?: ChaintracksFetchApi;
    readonly maxRetained?: number;
    readonly fromKnownSourceUrl?: string;
    readonly cache?: BulkFileDataCacheApi;
    readonly downloadBudget?: BulkFileDownloadBudgetApi;
    readonly validator: BulkFileDataValidatorApi;
    readonly failedLoadRetryMsecs: number;
    constructor(options: BulkFileDataManagerOptions | Chain)
    getStats(): BulkFileDataManagerStats
    async deleteBulkFiles(): Promise<void>
    async setStorage(storage: ChaintracksStorageBulkFileApi, log: (...args: any[]) => void): Promise<void>
    heightRangesFromBulkFiles(files: BulkHeaderFileInfo[]): {
        all: HeightRange;
        cdn: HeightRange;
        incremental: HeightRange;
    }
    async createReader(range?: HeightRange, maxBufferSize?: number): Promise<BulkFileDataReader>
    async updateFromUrl(cdnUrl: string): Promise<void>
    async merge(files: BulkHeaderFileInfo[]): Promise<BulkFileDataManagerMergeResult>
    toLogString(what?: BulkFileDataManagerMergeResult | BulkFileData[] | BulkHeaderFileInfo[]): string
    async mergeIncrementalBlockHeaders(newBulkHeaders: BlockHeader[], incrementalChainWork?: string): Promise<void>
    async getBulkFiles(keepData?: boolean): Promise<BulkHeaderFileInfo[]>
    async getHeightRange(): Promise<HeightRange>
    async getDataFromFile(file: BulkHeaderFileInfo, offset?: number, length?: number): Promise<Uint8Array | undefined>
    async findHeaderForHeightOrUndefined(height: number): Promise<BlockHeader | undefined>
    async getFileForHeight(height: number): Promise<BulkHeaderFileInfo | undefined>
    async getLastFile(fromEnd = 1): Promise<BulkHeaderFileInfo | undefined>
    async ReValidate(): Promise<void>
    async exportHeadersToFs(toFs: ChaintracksFsApi, toHeadersPerFile: number, toFolder: string, sourceUrl?: string, maxHeight?: number): Promise<void>
    async destroy(): Promise<void>
}
```

See also: [BlockHeader](./client.md#interface-blockheader), [BulkFileDataCacheApi](./services.md#interface-bulkfiledatacacheapi), [BulkFileDataManagerMergeResult](./services.md#interface-bulkfiledatamanagermergeresult), [BulkFileDataManagerOptions](./services.md#interface-bulkfiledatamanageroptions), [BulkFileDataManagerStats](./services.md#interface-bulkfiledatamanagerstats), [BulkFileDataReader](./services.md#class-bulkfiledatareader), [BulkFileDataValidatorApi](./services.md#interface-bulkfiledatavalidatorapi), [BulkFileDownloadBudgetApi](./services.md#interface-bulkfiledownloadbudgetapi), [BulkHeaderFileInfo](./services.md#interface-bulkheaderfileinfo), [Chain](./client.md#type-chain), [ChaintracksFetchApi](./services.md#interface-chaintracksfetchapi), [ChaintracksFsApi](./services.md#interface-chaintracksfsapi), [ChaintracksStorageBulkFileApi](./services.md#interface-chaintracksstoragebulkfileapi), [HeightRange](./services.md#class-heightrange)

###### Method setStorage

If `bfds` are going to be backed by persistent storage,
must be called before making storage available.

Synchronizes bfds and storage files, after which this manager maintains sync.
There should be no changes to bulk files by direct access to storage bulk file methods.

```ts
async setStorage(storage: ChaintracksStorageBulkFileApi, log: (...args: any[]) => void): Promise<void>
```
See also: [ChaintracksStorageBulkFileApi](./services.md#interface-chaintracksstoragebulkfileapi)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Class: BulkFileDataReader

```ts
export class BulkFileDataReader {
    readonly manager: BulkFileDataManager;
    readonly range: HeightRange;
    readonly maxBufferSize: number;
    nextHeight: number;
    constructor(manager: BulkFileDataManager, range: HeightRange, maxBufferSize: number)
    async read(): Promise<Uint8Array | undefined>
}
```

See also: [BulkFileDataManager](./services.md#class-bulkfiledatamanager), [HeightRange](./services.md#class-heightrange)

###### Method read

```ts
async read(): Promise<Uint8Array | undefined>
```

Returns

an array containing the next `maxBufferSize` bytes of headers from the files.

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Class: BulkFileDataValidationError

Identifies deterministic rejection of the supplied immutable bytes.
Operational failures such as worker crashes and queue saturation deliberately
use ordinary errors so callers preserve the cache entry and avoid downloading
a replacement that cannot be validated.

```ts
export class BulkFileDataValidationError extends Error {
    constructor(message: string, public readonly data?: Uint8Array)
}
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Class: BulkFilesReader

Breaks available bulk headers stored in multiple files into a sequence of buffers with
limited maximum size.

```ts
export class BulkFilesReader {
    files: BulkHeaderFile[];
    range: HeightRange;
    maxBufferSize = 400 * 80;
    nextHeight: number | undefined;
    constructor(files: BulkHeaderFile[], range?: HeightRange, maxBufferSize?: number)
    protected setRange(range?: HeightRange)
    setMaxBufferSize(maxBufferSize: number | undefined)
    get heightRange(): HeightRange
    async readBufferForHeightOrUndefined(height: number): Promise<Uint8Array | undefined>
    async readBufferForHeight(height: number): Promise<Uint8Array>
    async readHeaderForHeight(height: number): Promise<BaseBlockHeader>
    async readHeaderForHeightOrUndefined(height: number): Promise<BaseBlockHeader | undefined>
    async read(): Promise<Uint8Array | undefined>
    resetRange(range: HeightRange, maxBufferSize?: number)
    async validateFiles(): Promise<void>
    async exportHeadersToFs(toFs: ChaintracksFsApi, toHeadersPerFile: number, toFolder: string): Promise<void>
}
```

See also: [BaseBlockHeader](./client.md#interface-baseblockheader), [BulkHeaderFile](./services.md#class-bulkheaderfile), [ChaintracksFsApi](./services.md#interface-chaintracksfsapi), [HeightRange](./services.md#class-heightrange)

###### Property files

Previously validated bulk header files which may pull data from backing storage on demand.

```ts
files: BulkHeaderFile[]
```
See also: [BulkHeaderFile](./services.md#class-bulkheaderfile)

###### Property maxBufferSize

Maximum buffer size returned from `read()` in bytes.

```ts
maxBufferSize = 400 * 80
```

###### Property nextHeight

"Read pointer", the next height to be "read".

```ts
nextHeight: number | undefined
```

###### Property range

Subset of headers currently being "read".

```ts
range: HeightRange
```
See also: [HeightRange](./services.md#class-heightrange)

###### Method read

```ts
async read(): Promise<Uint8Array | undefined>
```

Returns

an array containing the next `maxBufferSize` bytes of headers from the files.

###### Method resetRange

Reset the reading process and adjust the range to be read to a new subset of what's available...

```ts
resetRange(range: HeightRange, maxBufferSize?: number)
```
See also: [HeightRange](./services.md#class-heightrange)

Argument Details

+ **range**
  + new range for subsequent `read` calls to return.
+ **maxBufferSize**
  + optionally update largest buffer size for `read` to return

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Class: BulkFilesReaderFs

```ts
export class BulkFilesReaderFs extends BulkFilesReader {
    constructor(public fs: ChaintracksFsApi, files: BulkHeaderFileFs[], range?: HeightRange, maxBufferSize?: number)
    static async fromFs(fs: ChaintracksFsApi, rootFolder: string, jsonFilename: string, range?: HeightRange, maxBufferSize?: number): Promise<BulkFilesReaderFs>
    static async writeEmptyJsonFile(fs: ChaintracksFsApi, rootFolder: string, jsonFilename: string): Promise<string>
    static async readJsonFile(fs: ChaintracksFsApi, rootFolder: string, jsonFilename: string, failToEmptyRange: boolean = true): Promise<BulkHeaderFilesInfo>
}
```

See also: [BulkFilesReader](./services.md#class-bulkfilesreader), [BulkHeaderFileFs](./services.md#class-bulkheaderfilefs), [BulkHeaderFilesInfo](./services.md#interface-bulkheaderfilesinfo), [ChaintracksFsApi](./services.md#interface-chaintracksfsapi), [HeightRange](./services.md#class-heightrange)

###### Method fromFs

Return a BulkFilesReader configured to access the intersection of `range` and available headers.

```ts
static async fromFs(fs: ChaintracksFsApi, rootFolder: string, jsonFilename: string, range?: HeightRange, maxBufferSize?: number): Promise<BulkFilesReaderFs>
```
See also: [BulkFilesReaderFs](./services.md#class-bulkfilesreaderfs), [ChaintracksFsApi](./services.md#interface-chaintracksfsapi), [HeightRange](./services.md#class-heightrange)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Class: BulkFilesReaderStorage

```ts
export class BulkFilesReaderStorage extends BulkFilesReader {
    constructor(storage: ChaintracksStorageBase, files: BulkHeaderFileStorage[], range?: HeightRange, maxBufferSize?: number)
    static async fromStorage(storage: ChaintracksStorageBase, fetch?: ChaintracksFetchApi, range?: HeightRange, maxBufferSize?: number): Promise<BulkFilesReaderStorage>
}
```

See also: [BulkFilesReader](./services.md#class-bulkfilesreader), [BulkHeaderFileStorage](./services.md#class-bulkheaderfilestorage), [ChaintracksFetchApi](./services.md#interface-chaintracksfetchapi), [ChaintracksStorageBase](./services.md#class-chaintracksstoragebase), [HeightRange](./services.md#class-heightrange)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Class: BulkHeaderFile

```ts
export abstract class BulkHeaderFile implements BulkHeaderFileInfo {
    chain?: Chain;
    count: number;
    data?: Uint8Array<ArrayBufferLike>;
    fileHash: string | null;
    fileId?: number;
    fileName: string;
    firstHeight: number;
    lastChainWork: string;
    lastHash: string | null;
    prevChainWork: string;
    prevHash: string;
    sourceUrl?: string;
    validated?: boolean;
    constructor(info: BulkHeaderFileInfo)
    abstract readDataFromFile(length: number, offset: number): Promise<Uint8Array | undefined>;
    protected validateReadBounds(length: number, offset: number): void
    get heightRange(): HeightRange
    async ensureData(): Promise<Uint8Array>
    async computeFileHash(): Promise<string>
    async releaseData(): Promise<void>
    toCdnInfo(): BulkHeaderFileInfo
    toStorageInfo(): BulkHeaderFileInfo
}
```

See also: [BulkHeaderFileInfo](./services.md#interface-bulkheaderfileinfo), [Chain](./client.md#type-chain), [HeightRange](./services.md#class-heightrange)

###### Method computeFileHash

Whenever reloading data from a backing store, validated fileHash must be re-verified

```ts
async computeFileHash(): Promise<string>
```

Returns

the sha256 hash of the file's data as base64 string.

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Class: BulkHeaderFileFs

```ts
export class BulkHeaderFileFs extends BulkHeaderFile {
    constructor(info: BulkHeaderFileInfo, public fs: ChaintracksFsApi, public rootFolder: string)
    override async readDataFromFile(length: number, offset: number): Promise<Uint8Array | undefined>
    override async ensureData(): Promise<Uint8Array>
}
```

See also: [BulkHeaderFile](./services.md#class-bulkheaderfile), [BulkHeaderFileInfo](./services.md#interface-bulkheaderfileinfo), [ChaintracksFsApi](./services.md#interface-chaintracksfsapi)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Class: BulkHeaderFileStorage

```ts
export class BulkHeaderFileStorage extends BulkHeaderFile {
    constructor(info: BulkHeaderFileInfo, public storage: ChaintracksStorageBase, public fetch?: ChaintracksFetchApi)
    override async readDataFromFile(length: number, offset: number): Promise<Uint8Array | undefined>
    override async ensureData(): Promise<Uint8Array>
}
```

See also: [BulkHeaderFile](./services.md#class-bulkheaderfile), [BulkHeaderFileInfo](./services.md#interface-bulkheaderfileinfo), [ChaintracksFetchApi](./services.md#interface-chaintracksfetchapi), [ChaintracksStorageBase](./services.md#class-chaintracksstoragebase)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Class: BulkHeaderFiles

```ts
export abstract class BulkHeaderFiles implements BulkHeaderFilesInfo {
    constructor(public rootFolder: string, public jsonFilename: string, public files: BulkHeaderFileInfo[], public headersPerFile: number)
}
```

See also: [BulkHeaderFileInfo](./services.md#interface-bulkheaderfileinfo), [BulkHeaderFilesInfo](./services.md#interface-bulkheaderfilesinfo)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Class: BulkIngestorBase

```ts
export abstract class BulkIngestorBase implements BulkIngestorApi {
    static createBulkIngestorBaseOptions(chain: Chain)
    chain: Chain;
    jsonFilename: string;
    log: (...args: any[]) => void = () => { };
    constructor(options: BulkIngestorBaseOptions)
    async setStorage(storage: ChaintracksStorageBase, log: (...args: any[]) => void): Promise<void>
    async shutdown(): Promise<void>
    storageOrUndefined(): ChaintracksStorageApi | undefined
    storage(): ChaintracksStorageBase
    filesInfo: BulkHeaderFilesInfo | undefined;
    async getPresentHeight(): Promise<number | undefined>
    abstract fetchHeaders(before: HeightRanges, fetchRange: HeightRange, bulkRange: HeightRange, priorLiveHeaders: BlockHeader[]): Promise<BlockHeader[]>;
    async synchronize(presentHeight: number, before: HeightRanges, priorLiveHeaders: BlockHeader[]): Promise<BulkSyncResult>
}
```

See also: [BlockHeader](./client.md#interface-blockheader), [BulkHeaderFilesInfo](./services.md#interface-bulkheaderfilesinfo), [BulkIngestorApi](./services.md#interface-bulkingestorapi), [BulkIngestorBaseOptions](./services.md#interface-bulkingestorbaseoptions), [BulkSyncResult](./services.md#interface-bulksyncresult), [Chain](./client.md#type-chain), [ChaintracksStorageApi](./services.md#interface-chaintracksstorageapi), [ChaintracksStorageBase](./services.md#class-chaintracksstoragebase), [HeightRange](./services.md#class-heightrange), [HeightRanges](./services.md#interface-heightranges)

###### Property filesInfo

information about locally cached bulk header files managed by this bulk ingestor

```ts
filesInfo: BulkHeaderFilesInfo | undefined
```
See also: [BulkHeaderFilesInfo](./services.md#interface-bulkheaderfilesinfo)

###### Method createBulkIngestorBaseOptions

```ts
static createBulkIngestorBaseOptions(chain: Chain)
```
See also: [Chain](./client.md#type-chain)

Argument Details

+ **localCachePath**
  + defaults to './data/ingest_headers/'

###### Method fetchHeaders

A BulkIngestor fetches and updates storage with bulk headers in bulkRange.

If it can, it must also fetch live headers in fetch range that are not in bulkRange and return them as an array.

The storage methods `insertBulkFile`, `updateBulkFile`, and `addBulkHeaders` should be used to add bulk headers to storage.

```ts
abstract fetchHeaders(before: HeightRanges, fetchRange: HeightRange, bulkRange: HeightRange, priorLiveHeaders: BlockHeader[]): Promise<BlockHeader[]>
```
See also: [BlockHeader](./client.md#interface-blockheader), [HeightRange](./services.md#class-heightrange), [HeightRanges](./services.md#interface-heightranges)

Returns

new live headers: headers in fetchRange but not in bulkRange

Argument Details

+ **before**
  + bulk and live range of headers before ingesting any new headers.
+ **fetchRange**
  + range of headers still needed, includes both missing bulk and live headers.
+ **bulkRange**
  + range of bulk headers still needed
+ **priorLiveHeaders**
  + any headers accumulated by prior bulk ingestor(s) that are too recent for bulk storage.

###### Method getPresentHeight

At least one derived BulkIngestor must override this method to provide the current height of the active chain tip.

```ts
async getPresentHeight(): Promise<number | undefined>
```

Returns

undefined unless overridden

###### Method synchronize

A BulkIngestor has two potential goals:
1. To source missing bulk headers and include them in bulk storage.
2. To source missing live headers to be forwarded to live storage.

```ts
async synchronize(presentHeight: number, before: HeightRanges, priorLiveHeaders: BlockHeader[]): Promise<BulkSyncResult>
```
See also: [BlockHeader](./client.md#interface-blockheader), [BulkSyncResult](./services.md#interface-bulksyncresult), [HeightRanges](./services.md#interface-heightranges)

Returns

updated priorLiveHeaders including any accumulated by this ingestor

Argument Details

+ **presentHeight**
  + current height of the active chain tip, may lag the true value.
+ **before**
  + current bulk and live storage height ranges, either may be empty.
+ **priorLiveHeaders**
  + any headers accumulated by prior bulk ingestor(s) that are too recent for bulk storage.

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Class: BulkIngestorCDN

```ts
export class BulkIngestorCDN extends BulkIngestorBase {
    static createBulkIngestorCDNOptions(chain: Chain, cdnUrl: string, fetch: ChaintracksFetchApi, maxPerFile?: number): BulkIngestorCDNOptions
    fetch: ChaintracksFetchApi;
    jsonResource: string;
    cdnUrl: string;
    maxPerFile: number | undefined;
    availableBulkFiles: BulkHeaderFilesInfo | undefined;
    selectedFiles: BulkHeaderFileInfo[] | undefined;
    currentRange: HeightRange | undefined;
    constructor(options: BulkIngestorCDNOptions)
    override async getPresentHeight(): Promise<number | undefined>
    getJsonHttpHeaders(): Record<string, string>
    async fetchHeaders(before: HeightRanges, fetchRange: HeightRange, bulkRange: HeightRange, priorLiveHeaders: BlockHeader[]): Promise<BlockHeader[]>
}
```

See also: [BlockHeader](./client.md#interface-blockheader), [BulkHeaderFileInfo](./services.md#interface-bulkheaderfileinfo), [BulkHeaderFilesInfo](./services.md#interface-bulkheaderfilesinfo), [BulkIngestorBase](./services.md#class-bulkingestorbase), [BulkIngestorCDNOptions](./services.md#interface-bulkingestorcdnoptions), [Chain](./client.md#type-chain), [ChaintracksFetchApi](./services.md#interface-chaintracksfetchapi), [HeightRange](./services.md#class-heightrange), [HeightRanges](./services.md#interface-heightranges)

###### Method createBulkIngestorCDNOptions

```ts
static createBulkIngestorCDNOptions(chain: Chain, cdnUrl: string, fetch: ChaintracksFetchApi, maxPerFile?: number): BulkIngestorCDNOptions
```
See also: [BulkIngestorCDNOptions](./services.md#interface-bulkingestorcdnoptions), [Chain](./client.md#type-chain), [ChaintracksFetchApi](./services.md#interface-chaintracksfetchapi)

Argument Details

+ **localCachePath**
  + defaults to './data/bulk_cdn_headers/'

###### Method fetchHeaders

A BulkFile CDN serves a JSON BulkHeaderFilesInfo resource which lists all the available binary bulk header files available and associated metadata.

The term "CDN file" is used for a local bulk file that has a sourceUrl. (Not undefined)
The term "incremental file" is used for the local bulk file that holds all the non-CDN bulk headers and must chain to the live headers if there are any.

Bulk ingesting from a CDN happens in one of three contexts:

1. Cold Start: No local bulk or live headers.
2. Incremental: Available CDN files extend into an existing incremental file but not into the live headers.
3. Replace: Available CDN files extend into live headers.

Context Cold Start:
- The CDN files are selected in height order, starting at zero, always choosing the largest count less than the local maximum (maxPerFile).

Context Incremental:
- Last existing CDN file is updated if CDN now has a higher count.
- Additional CDN files are added as in Cold Start.
- The existing incremental file is truncated or deleted.

Context Replace:
- Existing live headers are truncated or deleted.
- Proceed as context Incremental.

```ts
async fetchHeaders(before: HeightRanges, fetchRange: HeightRange, bulkRange: HeightRange, priorLiveHeaders: BlockHeader[]): Promise<BlockHeader[]>
```
See also: [BlockHeader](./client.md#interface-blockheader), [HeightRange](./services.md#class-heightrange), [HeightRanges](./services.md#interface-heightranges)

Argument Details

+ **before**
  + bulk and live range of headers before ingesting any new headers.
+ **fetchRange**
  + total range of header heights needed including live headers
+ **bulkRange**
  + range of missing bulk header heights required.

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Class: BulkIngestorCDNBabbage

```ts
export class BulkIngestorCDNBabbage extends BulkIngestorCDN {
    static createBulkIngestorCDNBabbageOptions(chain: Chain, fetch: ChaintracksFetchApi): BulkIngestorCDNOptions
}
```

See also: [BulkIngestorCDN](./services.md#class-bulkingestorcdn), [BulkIngestorCDNOptions](./services.md#interface-bulkingestorcdnoptions), [Chain](./client.md#type-chain), [ChaintracksFetchApi](./services.md#interface-chaintracksfetchapi)

###### Method createBulkIngestorCDNBabbageOptions

```ts
static createBulkIngestorCDNBabbageOptions(chain: Chain, fetch: ChaintracksFetchApi): BulkIngestorCDNOptions
```
See also: [BulkIngestorCDNOptions](./services.md#interface-bulkingestorcdnoptions), [Chain](./client.md#type-chain), [ChaintracksFetchApi](./services.md#interface-chaintracksfetchapi)

Argument Details

+ **rootFolder**
  + defaults to './data/bulk_cdn_babbage_headers/'

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Class: BulkIngestorChaintracks

Uses a go-chaintracks/Arcade-compatible service as a validated bulk source.
Retrieved bytes still pass through ChainTracks' local serialization, hash,
continuity, and genesis checks before storage.

```ts
export class BulkIngestorChaintracks extends BulkIngestorBase {
    constructor(options: BulkIngestorChaintracksOptions)
    override async getPresentHeight(): Promise<number>
    async fetchHeaders(_before: HeightRanges, fetchRange: HeightRange, bulkRange: HeightRange, priorLiveHeaders: BlockHeader[]): Promise<BlockHeader[]>
}
```

See also: [BlockHeader](./client.md#interface-blockheader), [BulkIngestorBase](./services.md#class-bulkingestorbase), [BulkIngestorChaintracksOptions](./services.md#interface-bulkingestorchaintracksoptions), [HeightRange](./services.md#class-heightrange), [HeightRanges](./services.md#interface-heightranges)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Class: BulkIngestorWhatsOnChainCdn

```ts
export class BulkIngestorWhatsOnChainCdn extends BulkIngestorBase {
    static createBulkIngestorWhatsOnChainOptions(chain: Chain): BulkIngestorWhatsOnChainOptions
    fetch: ChaintracksFetchApi;
    idleWait: number;
    woc: WhatsOnChainServices;
    stopOldListenersToken: StopListenerToken = { stop: undefined };
    constructor(options: BulkIngestorWhatsOnChainOptions)
    override async getPresentHeight(): Promise<number | undefined>
    async fetchHeaders(before: HeightRanges, fetchRange: HeightRange, bulkRange: HeightRange, priorLiveHeaders: BlockHeader[]): Promise<BlockHeader[]>
}
```

See also: [BlockHeader](./client.md#interface-blockheader), [BulkIngestorBase](./services.md#class-bulkingestorbase), [BulkIngestorWhatsOnChainOptions](./services.md#interface-bulkingestorwhatsonchainoptions), [Chain](./client.md#type-chain), [ChaintracksFetchApi](./services.md#interface-chaintracksfetchapi), [HeightRange](./services.md#class-heightrange), [HeightRanges](./services.md#interface-heightranges), [StopListenerToken](./services.md#interface-stoplistenertoken), [WhatsOnChainServices](./services.md#class-whatsonchainservices)

###### Method createBulkIngestorWhatsOnChainOptions

```ts
static createBulkIngestorWhatsOnChainOptions(chain: Chain): BulkIngestorWhatsOnChainOptions
```
See also: [BulkIngestorWhatsOnChainOptions](./services.md#interface-bulkingestorwhatsonchainoptions), [Chain](./client.md#type-chain)

Argument Details

+ **localCachePath**
  + defaults to './data/ingest_whatsonchain_headers'

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Class: BulkIngestorWhatsOnChainWs

```ts
export class BulkIngestorWhatsOnChainWs extends BulkIngestorBase {
    static createBulkIngestorWhatsOnChainOptions(chain: Chain): BulkIngestorWhatsOnChainOptions
    idleWait: number;
    maxHeadersPerRequest: number;
    woc: WhatsOnChainServices;
    stopOldListenersToken: StopListenerToken = { stop: undefined };
    constructor(options: BulkIngestorWhatsOnChainOptions)
    override async getPresentHeight(): Promise<number | undefined>
    async fetchHeaders(before: HeightRanges, fetchRange: HeightRange, bulkRange: HeightRange, priorLiveHeaders: BlockHeader[]): Promise<BlockHeader[]>
}
```

See also: [BlockHeader](./client.md#interface-blockheader), [BulkIngestorBase](./services.md#class-bulkingestorbase), [BulkIngestorWhatsOnChainOptions](./services.md#interface-bulkingestorwhatsonchainoptions), [Chain](./client.md#type-chain), [HeightRange](./services.md#class-heightrange), [HeightRanges](./services.md#interface-heightranges), [StopListenerToken](./services.md#interface-stoplistenertoken), [WhatsOnChainServices](./services.md#class-whatsonchainservices)

###### Method createBulkIngestorWhatsOnChainOptions

```ts
static createBulkIngestorWhatsOnChainOptions(chain: Chain): BulkIngestorWhatsOnChainOptions
```
See also: [BulkIngestorWhatsOnChainOptions](./services.md#interface-bulkingestorwhatsonchainoptions), [Chain](./client.md#type-chain)

Argument Details

+ **localCachePath**
  + defaults to './data/ingest_whatsonchain_headers'

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Class: BulkStorageBase

```ts
export abstract class BulkStorageBase implements BulkStorageApi {
    static createBulkStorageBaseOptions(chain: Chain, fs: ChaintracksFsApi): BulkStorageBaseOptions
    chain: Chain;
    fs: ChaintracksFsApi;
    log: (...args: any[]) => void = () => { };
    constructor(options: BulkStorageBaseOptions)
    async shutdown(): Promise<void>
    abstract appendHeaders(minHeight: number, count: number, newBulkHeaders: Uint8Array): Promise<void>;
    abstract getMaxHeight(): Promise<number>;
    abstract headersToBuffer(height: number, count: number): Promise<Uint8Array>;
    abstract findHeaderForHeightOrUndefined(height: number): Promise<BlockHeader | undefined>;
    async findHeaderForHeight(height: number): Promise<BlockHeader>
    async getHeightRange(): Promise<HeightRange>
    async setStorage(storage: ChaintracksStorageBase, log: (...args: any[]) => void): Promise<void>
    async exportBulkHeaders(rootFolder: string, jsonFilename: string, maxPerFile: number): Promise<void>
}
```

See also: [BlockHeader](./client.md#interface-blockheader), [BulkStorageApi](./services.md#interface-bulkstorageapi), [BulkStorageBaseOptions](./services.md#interface-bulkstoragebaseoptions), [Chain](./client.md#type-chain), [ChaintracksFsApi](./services.md#interface-chaintracksfsapi), [ChaintracksStorageBase](./services.md#class-chaintracksstoragebase), [HeightRange](./services.md#class-heightrange)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Class: Chaintracks

```ts
export class Chaintracks implements ChaintracksManagementApi {
    static createOptions(chain: Chain): ChaintracksOptions
    log: (...args: any[]) => void = () => { };
    readonly chain: Chain;
    readonly readonly: boolean;
    constructor(public options: ChaintracksOptions)
    async getChain(): Promise<Chain>
    async getPresentHeight(): Promise<number>
    async currentHeight(): Promise<number>
    getAvailabilitySnapshot(): ChaintracksAvailabilitySnapshotApi
    async subscribeHeaders(listener: HeaderListener): Promise<string>
    async subscribeReorgs(listener: ReorgListener): Promise<string>
    async unsubscribe(subscriptionId: string): Promise<boolean>
    async addHeader(header: BaseBlockHeader): Promise<void>
    async makeAvailable(): Promise<void>
    async startPromises(): Promise<void>
    async destroy(): Promise<void>
    async listening(): Promise<void>
    async isListening(): Promise<boolean>
    async isSynchronized(): Promise<boolean>
    async findHeaderForHeight(height: number): Promise<BlockHeader | undefined>
    async findHeaderForBlockHash(hash: string): Promise<BlockHeader | undefined>
    async isValidRootForHeight(root: string, height: number): Promise<boolean>
    async getInfo(): Promise<ChaintracksInfoApi>
    async getHeaders(height: number, count: number): Promise<string>
    async findChainTipHeader(): Promise<BlockHeader>
    async findChainTipHash(): Promise<string>
    async findLiveHeaderForBlockHash(hash: string): Promise<LiveBlockHeader | undefined>
    async findChainWorkForBlockHash(hash: string): Promise<string | undefined>
    async validate(): Promise<boolean>
    async exportBulkHeaders(toFolder: string, toFs: ChaintracksFsApi, sourceUrl?: string, toHeadersPerFile?: number, maxHeight?: number): Promise<void>
    async startListening(): Promise<void>
    private async syncBulkStorageNoLock(presentHeight: number, initialRanges: HeightRanges): Promise<void> {
        let newLiveHeaders: BlockHeader[] = [];
        let before = initialRanges;
        let after = before;
        let added = HeightRange.empty;
        const maxSyncRounds = Math.max(1, this.bulkIngestors.length * 2);
        for (let round = 1; round <= maxSyncRounds; round++) {
            const result = await this.runBulkSyncRound(before, presentHeight, newLiveHeaders);
            after = result.after;
            newLiveHeaders = result.newLiveHeaders;
            added = after.bulk.above(before.bulk);
            before = after;
            if (this.startupError != null)
                break;
            if (result.done)
                break;
            if (!result.madeProgress) {
                this.log(`Bulk sync stalled after round ${round}. Deferring further bulk sync attempts to continue live header processing.`);
                break;
            }
            if (round === maxSyncRounds) {
                this.log(`Bulk sync paused after ${maxSyncRounds} rounds to avoid runaway retries. Will retry in a later sync cycle.`);
            }
        }
        if (this.startupError == null) {
            if (this.liveHeaders.length + newLiveHeaders.length > Chaintracks.maxBulkLiveHeaders) {
                throw new Error(`Bulk sync cannot queue more than ${Chaintracks.maxBulkLiveHeaders} live headers.`);
            }
            for (let end = newLiveHeaders.length; end > 0; end -= 10000) {
                const start = Math.max(0, end - 10000);
                this.liveHeaders.unshift(...newLiveHeaders.slice(start, end));
            }
            added = after.bulk.above(initialRanges.bulk);
            this.log(`syncBulkStorage done
  Before sync: bulk ${initialRanges.bulk}, live ${initialRanges.live}
   After sync: bulk ${after.bulk}, live ${after.live}
  ${added.length} headers added to bulk storage
  ${this.liveHeaders.length} headers forwarded to live header storage
`);
        }
    }
    private async runBulkSyncIfNeeded(now: number, lastBulkSync: number, cdnSyncRepeatMsecs: number): Promise<number> {
        const presentHeight = await this.refreshPresentHeight();
        const before = await this.storage.getAvailableHeightRanges();
        let skipBulkSync = !before.live.isEmpty && before.live.maxHeight >= presentHeight - this.addLiveRecursionLimit / 2;
        if (skipBulkSync && now - lastBulkSync > cdnSyncRepeatMsecs)
            skipBulkSync = false;
        this.log(`Chaintracks Update Services: Bulk Header Sync Review
  presentHeight=${presentHeight}   addLiveRecursionLimit=${this.addLiveRecursionLimit}
  Before synchronize: bulk ${before.bulk}, live ${before.live}
  ${skipBulkSync ? "Skipping" : "Starting"} syncBulkStorage.
`);
        if (!skipBulkSync) {
            if (this.available)
                await this.syncBulkStorage(presentHeight, before);
            else
                await this.syncBulkStorageNoLock(presentHeight, before);
            if (this.startupError != null)
                throw this.startupError;
            return now;
        }
        return lastBulkSync;
    }
}
```

See also: [BaseBlockHeader](./client.md#interface-baseblockheader), [BlockHeader](./client.md#interface-blockheader), [Chain](./client.md#type-chain), [ChaintracksAvailabilitySnapshotApi](./services.md#interface-chaintracksavailabilitysnapshotapi), [ChaintracksFsApi](./services.md#interface-chaintracksfsapi), [ChaintracksInfoApi](./services.md#interface-chaintracksinfoapi), [ChaintracksManagementApi](./services.md#interface-chaintracksmanagementapi), [ChaintracksOptions](./services.md#interface-chaintracksoptions), [HeaderListener](./services.md#type-headerlistener), [HeightRange](./services.md#class-heightrange), [HeightRanges](./services.md#interface-heightranges), [LiveBlockHeader](./services.md#interface-liveblockheader), [ReorgListener](./services.md#type-reorglistener), [Services](./services.md#class-services)

###### Method addHeader

Queues a potentially new, unknown header for consideration as an addition to the chain.
When the header is considered, if the prior header is unknown, recursive calls to the
bulk ingestors will be attempted to resolve the linkage up to a depth of `addLiveRecursionLimit`.

Headers are considered in the order they were added.

```ts
async addHeader(header: BaseBlockHeader): Promise<void>
```
See also: [BaseBlockHeader](./client.md#interface-baseblockheader)

###### Method getAvailabilitySnapshot

Returns local process state without locks, storage reads, or network I/O.

```ts
getAvailabilitySnapshot(): ChaintracksAvailabilitySnapshotApi
```
See also: [ChaintracksAvailabilitySnapshotApi](./services.md#interface-chaintracksavailabilitysnapshotapi)

###### Method getPresentHeight

Returns the last known valid height immediately and refreshes stale state
once in the background. Cold start waits for the single shared refresh.

```ts
async getPresentHeight(): Promise<number>
```

###### Method makeAvailable

If not already available, takes a writer lock to queue calls until available.
Becoming available starts by initializing ingestors and main thread,
and ends when main thread sets `available`.
Note that the main thread continues running and takes additional write locks
itself when already available.

```ts
async makeAvailable(): Promise<void>
```

Returns

when available for client requests

###### Method validate

```ts
async validate(): Promise<boolean>
```

Returns

true iff all headers from height zero through current chainTipHeader height can be retreived and form a valid chain.

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Class: ChaintracksAppendableFile

```ts
export class ChaintracksAppendableFile extends ChaintracksFolderAwareFile implements ChaintracksAppendableFileApi {
    static async openAsAppendable(path: string): Promise<ChaintracksAppendableFile>
    async append(data: Uint8Array): Promise<void>
}
```

See also: [ChaintracksAppendableFileApi](./services.md#interface-chaintracksappendablefileapi)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Class: ChaintracksChainTracker

```ts
export class ChaintracksChainTracker implements ChainTracker {
    chaintracks: ChaintracksClientApi;
    cache: Record<number, string>;
    options: ChaintracksChainTrackerOptions;
    readonly telemetry: Telemetry;
    constructor(chain?: Chain, chaintracks?: ChaintracksClientApi, options?: ChaintracksChainTrackerOptions)
    async currentHeight(): Promise<number>
    async isValidRootForHeight(root: string, height: number): Promise<boolean>
}
```

See also: [Chain](./client.md#type-chain), [ChaintracksChainTrackerOptions](./services.md#interface-chaintrackschaintrackeroptions), [ChaintracksClientApi](./services.md#interface-chaintracksclientapi)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Class: ChaintracksFetch

Bounded fetch implementation shared by ChainTracks sources.

Retry policy lives here so callers never multiply attempts. Every attempt
has a deadline that remains active while the response body is consumed, and
every materialized response has an explicit byte ceiling.

```ts
export class ChaintracksFetch implements ChaintracksFetchApi {
    httpClient: HttpClient = defaultHttpClient();
    constructor(options: ChaintracksFetchOptions = {})
    async download(url: string, maxResponseBytes?: number, options?: ChaintracksDownloadOptions): Promise<Uint8Array>
    async fetchJson<R>(url: string): Promise<R>
    pathJoin(baseUrl: string, subpath: string): string
}
```

See also: [ChaintracksDownloadOptions](./services.md#interface-chaintracksdownloadoptions), [ChaintracksFetchApi](./services.md#interface-chaintracksfetchapi), [ChaintracksFetchOptions](./services.md#interface-chaintracksfetchoptions)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Class: ChaintracksFetchError

```ts
export class ChaintracksFetchError extends Error {
    constructor(message: string, public readonly url: string, public readonly status: number, public readonly statusText: string, public readonly retryAfterMsecs?: number)
    get retryable(): boolean
}
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Class: ChaintracksFsStatics

```ts
export abstract class ChaintracksFsStatics {
    static async delete(path: string): Promise<void>
    static async writeFile(path: string, data: Uint8Array): Promise<void>
    static async readFile(path: string): Promise<Uint8Array>
    static async openReadableFile(path: string): Promise<ChaintracksReadableFileApi>
    static async openWritableFile(path: string): Promise<ChaintracksWritableFileApi>
    static async openAppendableFile(path: string): Promise<ChaintracksAppendableFileApi>
    static async ensureFoldersExist(path: string): Promise<void>
    static pathJoin(...parts: string[]): string
}
```

See also: [ChaintracksAppendableFileApi](./services.md#interface-chaintracksappendablefileapi), [ChaintracksReadableFileApi](./services.md#interface-chaintracksreadablefileapi), [ChaintracksWritableFileApi](./services.md#interface-chaintrackswritablefileapi)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Class: ChaintracksKnexMigrations

```ts
export class ChaintracksKnexMigrations implements MigrationSource<string> {
    migrations: Record<string, Migration> = {};
    constructor(public chain: Chain)
    async getMigrations(): Promise<string[]>
    getMigrationName(migration: string)
    async getMigration(migration: string): Promise<Migration>
    async getLatestMigration(): Promise<string>
    static async latestMigration(): Promise<string>
    setupMigrations(): Record<string, Migration>
}
```

See also: [Chain](./client.md#type-chain)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Class: ChaintracksReadableFile

```ts
export class ChaintracksReadableFile implements ChaintracksReadableFileApi {
    path: string;
    parsedPath: Path.ParsedPath;
    f: fs.FileHandle;
    protected constructor(path: string, f: fs.FileHandle)
    async close(): Promise<void>
    async getLength(): Promise<number>
    async read(length?: number, offset?: number): Promise<Uint8Array>
    static async openAsReadable(path: string): Promise<ChaintracksReadableFile>
}
```

See also: [ChaintracksReadableFileApi](./services.md#interface-chaintracksreadablefileapi)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Class: ChaintracksService

```ts
export class ChaintracksService {
    static createChaintracksServiceOptions(chain: Chain): ChaintracksServiceOptions
    chain: Chain;
    options: ChaintracksServiceOptions;
    port?: number;
    chaintracks: Chaintracks;
    services: Services;
    server?: Server<typeof IncomingMessage, typeof ServerResponse>;
    constructor(options: ChaintracksServiceOptions)
    async stopJsonRpcServer(): Promise<void>
    async startJsonRpcServer(port?: number): Promise<void>
}
```

See also: [Chain](./client.md#type-chain), [Chaintracks](./services.md#class-chaintracks), [ChaintracksServiceOptions](./services.md#interface-chaintracksserviceoptions), [Services](./services.md#class-services)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Class: ChaintracksServiceClient

Connects to a ChaintracksService to implement 'ChaintracksClientApi'

```ts
export class ChaintracksServiceClient implements ChaintracksClientApi {
    static createChaintracksServiceClientOptions(): ChaintracksServiceClientOptions
    options: ChaintracksServiceClientOptions;
    constructor(public chain: Chain, serviceUrl: string, options?: ChaintracksServiceClientOptions)
    readonly serviceUrl: string;
    async subscribeHeaders(_listener: HeaderListener): Promise<string>
    async subscribeReorgs(_listener: ReorgListener): Promise<string>
    async unsubscribe(_subscriptionId: string): Promise<boolean>
    async currentHeight(): Promise<number>
    async isValidRootForHeight(root: string, height: number): Promise<boolean>
    async getJsonOrUndefined<T>(path: string): Promise<T | undefined>
    async getJson<T>(path: string): Promise<T>
    async postJsonVoid<T>(path: string, params: T): Promise<void>
    async addHeader(header: BaseBlockHeader): Promise<void>
    async startListening(): Promise<void>
    async listening(): Promise<void>
    async getChain(): Promise<Chain>
    async isListening(): Promise<boolean>
    async isSynchronized(): Promise<boolean>
    async getPresentHeight(): Promise<number>
    async getInfo(): Promise<ChaintracksInfoApi>
    async findChainTipHeader(): Promise<BlockHeader>
    async findChainTipHash(): Promise<string>
    async getHeaders(height: number, count: number): Promise<string>
    async findHeaderForHeight(height: number): Promise<BlockHeader | undefined>
    async findHeaderForBlockHash(hash: string): Promise<BlockHeader | undefined>
}
```

See also: [BaseBlockHeader](./client.md#interface-baseblockheader), [BlockHeader](./client.md#interface-blockheader), [Chain](./client.md#type-chain), [ChaintracksClientApi](./services.md#interface-chaintracksclientapi), [ChaintracksInfoApi](./services.md#interface-chaintracksinfoapi), [ChaintracksServiceClientOptions](./services.md#interface-chaintracksserviceclientoptions), [HeaderListener](./services.md#type-headerlistener), [ReorgListener](./services.md#type-reorglistener)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Class: ChaintracksStorageBase

Required interface methods of a Chaintracks Storage Engine implementation.

```ts
export abstract class ChaintracksStorageBase implements ChaintracksStorageQueryApi, ChaintracksStorageIngestApi {
    static createStorageBaseOptions(chain: Chain): ChaintracksStorageBaseOptions
    log: (...args: any[]) => void = () => { };
    chain: Chain;
    liveHeightThreshold: number;
    reorgHeightThreshold: number;
    bulkMigrationChunkSize: number;
    batchInsertLimit: number;
    isAvailable: boolean = false;
    hasMigrated: boolean = false;
    bulkManager: BulkFileDataManager;
    constructor(options: ChaintracksStorageBaseOptions)
    protected validateIncomingHeader(header: BlockHeader): BlockHeader
    protected validateLiveHeaderRecord(header: LiveBlockHeader, allowUnassignedHeaderId = false): LiveBlockHeader
    protected validateHeight(height: number, name = "height"): void
    protected validateHeaderId(headerId: number, name = "headerId"): void
    protected validateHash(hash: string, name = "hash"): void
    protected validateRange(range: HeightRange, maximumLength = MAX_PUBLIC_HEADER_RANGE): void
    protected recordTraversalVisit(seen: Set<number>, header: LiveBlockHeader, operation: string): void
    protected validateStoredParentLink(child: LiveBlockHeader, parent: LiveBlockHeader): void
    async shutdown(): Promise<void>
    async makeAvailable(): Promise<void>
    async migrateLatest(): Promise<void>
    async dropAllData(): Promise<void>
    abstract deleteLiveBlockHeaders(): Promise<void>;
    abstract deleteOlderLiveBlockHeaders(maxHeight: number): Promise<number>;
    abstract findChainTipHeader(): Promise<LiveBlockHeader>;
    abstract findChainTipHeaderOrUndefined(): Promise<LiveBlockHeader | undefined>;
    abstract findLiveHeaderForBlockHash(hash: string): Promise<LiveBlockHeader | null>;
    abstract findLiveHeaderForHeaderId(headerId: number): Promise<LiveBlockHeader>;
    abstract findLiveHeaderForHeight(height: number): Promise<LiveBlockHeader | null>;
    abstract findLiveHeaderForMerkleRoot(merkleRoot: string): Promise<LiveBlockHeader | null>;
    abstract findLiveHeightRange(): Promise<HeightRange>;
    abstract findMaxHeaderId(): Promise<number>;
    abstract liveHeadersForBulk(count: number): Promise<LiveBlockHeader[]>;
    abstract getLiveHeaders(range: HeightRange): Promise<LiveBlockHeader[]>;
    abstract insertHeader(header: BlockHeader): Promise<InsertHeaderResult>;
    abstract destroy(): Promise<void>;
    async getBulkHeaders(range: HeightRange): Promise<Uint8Array>
    async getHeadersUint8Array(height: number, count: number): Promise<Uint8Array>
    async getHeaders(height: number, count: number): Promise<BaseBlockHeader[]>
    async deleteBulkBlockHeaders(): Promise<void>
    async getAvailableHeightRanges(): Promise<{
        bulk: HeightRange;
        live: HeightRange;
    }>
    async pruneLiveBlockHeaders(activeTipHeight: number): Promise<void>
    async findChainTipHash(): Promise<string>
    async findChainTipWork(): Promise<string>
    async findChainWorkForBlockHash(hash: string): Promise<string>
    async findBulkFilesHeaderForHeightOrUndefined(height: number): Promise<BlockHeader | undefined>
    async findHeaderForHeightOrUndefined(height: number): Promise<LiveBlockHeader | BlockHeader | undefined>
    async findHeaderForHeight(height: number): Promise<LiveBlockHeader | BlockHeader>
    async isMerkleRootActive(merkleRoot: string): Promise<boolean>
    async findCommonAncestor(header1: LiveBlockHeader, header2: LiveBlockHeader): Promise<LiveBlockHeader>
    async findReorgDepth(header1: LiveBlockHeader, header2: LiveBlockHeader): Promise<number>
    async migrateLiveToBulk(count: number, ignoreLimits = false): Promise<void>
    async addBulkHeaders(headers: BlockHeader[], bulkRange: HeightRange, priorLiveHeaders: BlockHeader[]): Promise<BlockHeader[]>
}
```

See also: [BaseBlockHeader](./client.md#interface-baseblockheader), [BlockHeader](./client.md#interface-blockheader), [BulkFileDataManager](./services.md#class-bulkfiledatamanager), [Chain](./client.md#type-chain), [ChaintracksStorageBaseOptions](./services.md#interface-chaintracksstoragebaseoptions), [ChaintracksStorageIngestApi](./services.md#interface-chaintracksstorageingestapi), [ChaintracksStorageQueryApi](./services.md#interface-chaintracksstoragequeryapi), [HeightRange](./services.md#class-heightrange), [InsertHeaderResult](./services.md#type-insertheaderresult), [LiveBlockHeader](./services.md#interface-liveblockheader)

###### Method insertHeader

```ts
abstract insertHeader(header: BlockHeader): Promise<InsertHeaderResult>
```
See also: [BlockHeader](./client.md#interface-blockheader), [InsertHeaderResult](./services.md#type-insertheaderresult)

Returns

details of conditions found attempting to insert header

Argument Details

+ **header**
  + Header to attempt to add to live storage.

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Class: ChaintracksStorageIdb

```ts
export class ChaintracksStorageIdb extends ChaintracksStorageBase implements ChaintracksStorageBulkFileApi {
    dbName: string;
    db?: IDBPDatabase<ChaintracksStorageIdbSchema>;
    whenLastAccess?: Date;
    allStores: string[] = ["live_headers", "bulk_headers"];
    constructor(options: ChaintracksStorageIdbOptions)
    override async makeAvailable(): Promise<void>
    override async migrateLatest(): Promise<void>
    override async destroy(): Promise<void>
    override async deleteLiveBlockHeaders(): Promise<void>
    override async deleteOlderLiveBlockHeaders(maxHeight: number): Promise<number>
    override async findChainTipHeader(): Promise<LiveBlockHeader>
    override async findChainTipHeaderOrUndefined(): Promise<LiveBlockHeader | undefined>
    override async findLiveHeaderForBlockHash(hash: string): Promise<LiveBlockHeader | null>
    override async findLiveHeaderForHeaderId(headerId: number): Promise<LiveBlockHeader>
    override async findLiveHeaderForHeight(height: number): Promise<LiveBlockHeader | null>
    override async findLiveHeaderForMerkleRoot(merkleRoot: string): Promise<LiveBlockHeader | null>
    override async findLiveHeightRange(): Promise<HeightRange>
    override async findMaxHeaderId(): Promise<number>
    override async liveHeadersForBulk(count: number): Promise<LiveBlockHeader[]>
    override async getLiveHeaders(range: HeightRange): Promise<LiveBlockHeader[]>
    override async insertHeader(header: BlockHeader): Promise<InsertHeaderResult>
    async deleteBulkFile(fileId: number): Promise<number>
    async insertBulkFile(file: BulkHeaderFileInfo): Promise<number>
    async updateBulkFile(fileId: number, file: BulkHeaderFileInfo): Promise<number>
    async replaceBulkFiles(files: BulkHeaderFileInfo[]): Promise<BulkHeaderFileInfo[]>
    async getBulkFiles(): Promise<BulkHeaderFileInfo[]>
    async getBulkFileData(fileId: number, offset?: number, length?: number): Promise<Uint8Array | undefined>
    protected repairStoredLiveHeader(header?: LiveBlockHeader): LiveBlockHeader | undefined
    async insertLiveHeader(header: LiveBlockHeader): Promise<LiveBlockHeader>
    async initDB(): Promise<IDBPDatabase<ChaintracksStorageIdbSchema>>
    toDbTrxReadOnly(stores: string[]): IDBPTransaction<ChaintracksStorageIdbSchema, string[], "readonly">
    toDbTrxReadWrite(stores: string[]): IDBPTransaction<ChaintracksStorageIdbSchema, string[], "readwrite">
}
```

See also: [BlockHeader](./client.md#interface-blockheader), [BulkHeaderFileInfo](./services.md#interface-bulkheaderfileinfo), [ChaintracksStorageBase](./services.md#class-chaintracksstoragebase), [ChaintracksStorageBulkFileApi](./services.md#interface-chaintracksstoragebulkfileapi), [ChaintracksStorageIdbOptions](./services.md#interface-chaintracksstorageidboptions), [ChaintracksStorageIdbSchema](./services.md#interface-chaintracksstorageidbschema), [HeightRange](./services.md#class-heightrange), [InsertHeaderResult](./services.md#type-insertheaderresult), [LiveBlockHeader](./services.md#interface-liveblockheader)

###### Method deleteOlderLiveBlockHeaders

Delete live headers with height less or equal to `maxHeight`

Set existing headers with previousHeaderId value set to the headerId value of
a header which is to be deleted to null.

```ts
override async deleteOlderLiveBlockHeaders(maxHeight: number): Promise<number>
```

Returns

number of deleted records

Argument Details

+ **maxHeight**
  + delete all records with less or equal `height`

###### Method findChainTipHeader

```ts
override async findChainTipHeader(): Promise<LiveBlockHeader>
```
See also: [LiveBlockHeader](./services.md#interface-liveblockheader)

Returns

the active chain tip header

Throws

an error if there is no tip.

###### Method findChainTipHeaderOrUndefined

```ts
override async findChainTipHeaderOrUndefined(): Promise<LiveBlockHeader | undefined>
```
See also: [LiveBlockHeader](./services.md#interface-liveblockheader)

Returns

the active chain tip header

Throws

an error if there is no tip.

###### Method repairStoredLiveHeader

IndexedDB does not do indices of boolean properties.
So true is stored as a 1, and false is stored as no property value (delete v['property'])

This function restores these property values to true and false.

```ts
protected repairStoredLiveHeader(header?: LiveBlockHeader): LiveBlockHeader | undefined
```
See also: [LiveBlockHeader](./services.md#interface-liveblockheader)

Returns

copy of header with updated properties

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Class: ChaintracksStorageKnex

Implements the ChaintracksStorageApi using Knex.js for both MySql and Sqlite support.
Also see `chaintracksStorageMemory` which leverages Knex support for an in memory database.

```ts
export class ChaintracksStorageKnex extends ChaintracksStorageBase implements ChaintracksStorageBulkFileApi {
    static createStorageKnexOptions(chain: Chain, knex?: Knex): ChaintracksStorageKnexOptions
    knex: Knex;
    _dbtype?: DBType;
    bulkFilesTableName: string = "bulk_files";
    headerTableName: string = "live_headers";
    stateTableName: string = "chaintracks_state";
    constructor(options: ChaintracksStorageKnexOptions)
    get dbtype(): DBType
    override async shutdown(): Promise<void>
    override async makeAvailable(): Promise<void>
    override async migrateLatest(): Promise<void>
    override async dropAllData(): Promise<void>
    override async destroy(): Promise<void>
    override async findLiveHeightRange(): Promise<HeightRange>
    override async findLiveHeaderForHeaderId(headerId: number): Promise<LiveBlockHeader>
    override async findChainTipHeader(): Promise<LiveBlockHeader>
    override async findChainTipHeaderOrUndefined(): Promise<LiveBlockHeader | undefined>
    async findLiveHeaderForHeight(height: number): Promise<LiveBlockHeader | null>
    async findLiveHeaderForBlockHash(hash: string): Promise<LiveBlockHeader | null>
    async findLiveHeaderForMerkleRoot(merkleRoot: string): Promise<LiveBlockHeader | null>
    async deleteBulkFile(fileId: number): Promise<number>
    async insertBulkFile(file: BulkHeaderFileInfo): Promise<number>
    async updateBulkFile(fileId: number, file: BulkHeaderFileInfo): Promise<number>
    async replaceBulkFiles(files: BulkHeaderFileInfo[]): Promise<BulkHeaderFileInfo[]>
    async getBulkFiles(): Promise<BulkHeaderFileInfo[]>
    async getBulkFileData(fileId: number, offset?: number, length?: number): Promise<Uint8Array | undefined>
    async insertHeader(header: BlockHeader): Promise<InsertHeaderResult>
    async findMaxHeaderId(): Promise<number>
    override async deleteLiveBlockHeaders(): Promise<void>
    override async deleteBulkBlockHeaders(): Promise<void>
    async deleteOlderLiveBlockHeaders(maxHeight: number): Promise<number>
    async getLiveHeaders(range: HeightRange): Promise<LiveBlockHeader[]>
    concatSerializedHeaders(bufs: number[][]): number[]
    async liveHeadersForBulk(count: number): Promise<LiveBlockHeader[]>
}
```

See also: [BlockHeader](./client.md#interface-blockheader), [BulkHeaderFileInfo](./services.md#interface-bulkheaderfileinfo), [Chain](./client.md#type-chain), [ChaintracksStorageBase](./services.md#class-chaintracksstoragebase), [ChaintracksStorageBulkFileApi](./services.md#interface-chaintracksstoragebulkfileapi), [ChaintracksStorageKnexOptions](./services.md#interface-chaintracksstorageknexoptions), [DBType](./storage.md#type-dbtype), [HeightRange](./services.md#class-heightrange), [InsertHeaderResult](./services.md#type-insertheaderresult), [LiveBlockHeader](./services.md#interface-liveblockheader)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Class: ChaintracksStorageNoDb

```ts
export class ChaintracksStorageNoDb extends ChaintracksStorageBase {
    static readonly mainData: ChaintracksNoDbData = {
        chain: "main",
        liveHeaders: new Map<number, LiveBlockHeader>(),
        maxHeaderId: 0,
        tipHeaderId: 0,
        hashToHeaderId: new Map<string, number>()
    };
    static readonly testData: ChaintracksNoDbData = {
        chain: "test",
        liveHeaders: new Map<number, LiveBlockHeader>(),
        maxHeaderId: 0,
        tipHeaderId: 0,
        hashToHeaderId: new Map<string, number>()
    };
    static readonly stnData: ChaintracksNoDbData = {
        chain: "stn",
        liveHeaders: new Map<number, LiveBlockHeader>(),
        maxHeaderId: 0,
        tipHeaderId: 0,
        hashToHeaderId: new Map<string, number>()
    };
    static readonly ttnData: ChaintracksNoDbData = {
        chain: "ttn",
        liveHeaders: new Map<number, LiveBlockHeader>(),
        maxHeaderId: 0,
        tipHeaderId: 0,
        hashToHeaderId: new Map<string, number>()
    };
    static readonly tstnData: ChaintracksNoDbData = {
        chain: "tstn",
        liveHeaders: new Map<number, LiveBlockHeader>(),
        maxHeaderId: 0,
        tipHeaderId: 0,
        hashToHeaderId: new Map<string, number>()
    };
    constructor(options: ChaintracksStorageNoDbOptions)
    override async destroy(): Promise<void>
    async getData(): Promise<ChaintracksNoDbData>
    override async deleteLiveBlockHeaders(): Promise<void>
    override async deleteOlderLiveBlockHeaders(maxHeight: number): Promise<number>
    override async findChainTipHeader(): Promise<LiveBlockHeader>
    override async findChainTipHeaderOrUndefined(): Promise<LiveBlockHeader | undefined>
    override async findLiveHeaderForBlockHash(hash: string): Promise<LiveBlockHeader | null>
    override async findLiveHeaderForHeaderId(headerId: number): Promise<LiveBlockHeader>
    override async findLiveHeaderForHeight(height: number): Promise<LiveBlockHeader | null>
    override async findLiveHeaderForMerkleRoot(merkleRoot: string): Promise<LiveBlockHeader | null>
    override async findLiveHeightRange(): Promise<HeightRange>
    override async findMaxHeaderId(): Promise<number>
    override async liveHeadersForBulk(count: number): Promise<LiveBlockHeader[]>
    override async getLiveHeaders(range: HeightRange): Promise<LiveBlockHeader[]>
    override async insertHeader(header: BlockHeader): Promise<InsertHeaderResult>
}
```

See also: [BlockHeader](./client.md#interface-blockheader), [ChaintracksStorageBase](./services.md#class-chaintracksstoragebase), [ChaintracksStorageNoDbOptions](./services.md#interface-chaintracksstoragenodboptions), [HeightRange](./services.md#class-heightrange), [InsertHeaderResult](./services.md#type-insertheaderresult), [LiveBlockHeader](./services.md#interface-liveblockheader)

###### Method getData

Returns an isolated diagnostic snapshot; mutating it never changes tracker state.

```ts
async getData(): Promise<ChaintracksNoDbData>
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Class: ChaintracksWritableFile

```ts
export class ChaintracksWritableFile extends ChaintracksFolderAwareFile implements ChaintracksWritableFileApi {
    static async openAsWritable(path: string): Promise<ChaintracksWritableFile>
    async append(data: Uint8Array): Promise<void>
}
```

See also: [ChaintracksWritableFileApi](./services.md#interface-chaintrackswritablefileapi)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Class: DurableFileBulkFileDownloadBudget

Crash-safe fixed-window reservation ledger for remote bulk-header bytes.

State is flushed before `consume` resolves, so a crash may conservatively
over-count an attempt but can never reset the allowance or permit an
unrecorded request. Deployments must place `stateFile` on durable storage.

```ts
export class DurableFileBulkFileDownloadBudget implements BulkFileDownloadBudgetApi {
    constructor(options: DurableFileBulkFileDownloadBudgetOptions)
    async initialize(): Promise<void>
    async consume(byteCount: number): Promise<void>
    snapshot(): BulkFileDownloadBudgetSnapshot
}
```

See also: [BulkFileDownloadBudgetApi](./services.md#interface-bulkfiledownloadbudgetapi), [BulkFileDownloadBudgetSnapshot](./services.md#interface-bulkfiledownloadbudgetsnapshot), [DurableFileBulkFileDownloadBudgetOptions](./services.md#interface-durablefilebulkfiledownloadbudgetoptions)

###### Method initialize

Load and validate the durable ledger before the service becomes ready.

`consume` also initializes lazily, but services should await this method so
readiness reports the persisted allowance and corrupt state fails startup.

```ts
async initialize(): Promise<void>
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Class: FixedWindowBulkFileDownloadBudget

Conservative process-local byte reservation budget for remote bulk-header
downloads. A reservation is retained even when the subsequent request
fails, preventing a failing upstream from bypassing the bound.

```ts
export class FixedWindowBulkFileDownloadBudget implements BulkFileDownloadBudgetApi {
    constructor(options: FixedWindowBulkFileDownloadBudgetOptions)
    consume(byteCount: number): void
    snapshot(): {
        maxBytes: number;
        consumedBytes: number;
        remainingBytes: number;
        windowStartedAt: number;
        windowMsecs: number;
    }
}
```

See also: [BulkFileDownloadBudgetApi](./services.md#interface-bulkfiledownloadbudgetapi), [FixedWindowBulkFileDownloadBudgetOptions](./services.md#interface-fixedwindowbulkfiledownloadbudgetoptions)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Class: GoChaintracksServiceClient

Client for go-chaintracks compatible HTTP services, including Arcade's
`/chaintracks/v2` surface. Unlike the legacy ChaintracksServiceClient, this
can subscribe to tip/reorg SSE streams and therefore drive Monitor block
processing without a local WhatsOnChain polling ingestor.

```ts
export class GoChaintracksServiceClient implements ChaintracksClientApi {
    constructor(public chain: Chain, serviceUrl: string, options: GoChaintracksServiceClientOptions = {})
    async currentHeight(): Promise<number>
    async isValidRootForHeight(root: string, height: number): Promise<boolean>
    async getChain(): Promise<Chain>
    async getInfo(): Promise<ChaintracksInfoApi>
    async getPresentHeight(): Promise<number>
    async getHeaders(height: number, count: number): Promise<string>
    async findChainTipHeader(): Promise<BlockHeader>
    async findChainTipHash(): Promise<string>
    async findHeaderForHeight(height: number): Promise<BlockHeader | undefined>
    async findHeaderForBlockHash(hash: string): Promise<BlockHeader | undefined>
    async addHeader(_header: BaseBlockHeader): Promise<void>
    async startListening(): Promise<void>
    async listening(): Promise<void>
    async isListening(): Promise<boolean>
    async isSynchronized(): Promise<boolean>
    async subscribeHeaders(listener: HeaderListener): Promise<string>
    async subscribeReorgs(listener: ReorgListener): Promise<string>
    async unsubscribe(subscriptionId: string): Promise<boolean>
}
```

See also: [BaseBlockHeader](./client.md#interface-baseblockheader), [BlockHeader](./client.md#interface-blockheader), [Chain](./client.md#type-chain), [ChaintracksClientApi](./services.md#interface-chaintracksclientapi), [ChaintracksInfoApi](./services.md#interface-chaintracksinfoapi), [GoChaintracksServiceClientOptions](./services.md#interface-gochaintracksserviceclientoptions), [HeaderListener](./services.md#type-headerlistener), [ReorgListener](./services.md#type-reorglistener)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Class: HeightRange

Represents a range of block heights.

Operations support integrating contiguous batches of headers,

```ts
export class HeightRange implements HeightRangeApi {
    constructor(public minHeight: number, public maxHeight: number)
    static readonly empty = new HeightRange(0, -1);
    get isEmpty()
    static from(headers: BlockHeader[]): HeightRange
    get length()
    toString(): string
    contains(range: HeightRange | number)
    intersect(range: HeightRange)
    union(range: HeightRange)
    subtract(range: HeightRange)
    above(range: HeightRange)
    copy(): HeightRange
}
```

See also: [BlockHeader](./client.md#interface-blockheader), [HeightRangeApi](./services.md#interface-heightrangeapi)

###### Property empty

All ranges where maxHeight is less than minHeight are considered empty.
The canonical empty range is (0, -1).

```ts
static readonly empty = new HeightRange(0, -1)
```
See also: [HeightRange](./services.md#class-heightrange)

###### Method above

If `range` is not empty and this is not empty, returns a new range minHeight
replaced by to range.maxHeight + 1.

Otherwise returns a copy of this range.

This returns the portion of this range that is strictly above `range`.

```ts
above(range: HeightRange)
```
See also: [HeightRange](./services.md#class-heightrange)

###### Method contains

```ts
contains(range: HeightRange | number)
```
See also: [HeightRange](./services.md#class-heightrange)

Returns

true if `range` is entirely within this range.

Argument Details

+ **range**
  + HeightRange or single height value.

###### Method copy

Return a copy of this range.

```ts
copy(): HeightRange
```
See also: [HeightRange](./services.md#class-heightrange)

###### Method from

```ts
static from(headers: BlockHeader[]): HeightRange
```
See also: [BlockHeader](./client.md#interface-blockheader), [HeightRange](./services.md#class-heightrange)

Returns

range of height values from the given headers, or the empty range if there are no headers.

Argument Details

+ **headers**
  + an array of objects with a non-negative integer `height` property.

###### Method intersect

Return the intersection with another height range.

Intersection with an empty range is always empty.

The result is always a single, possibly empty, range.

```ts
intersect(range: HeightRange)
```
See also: [HeightRange](./services.md#class-heightrange)

###### Method subtract

Returns `range` subtracted from this range.

Throws an error if the subtraction would create two disjoint ranges.

```ts
subtract(range: HeightRange)
```
See also: [HeightRange](./services.md#class-heightrange)

###### Method toString

function toString() { [native code] }

```ts
toString(): string
```

Returns

an easy to read string representation of the height range.

###### Method union

Return the union with another height range.

Only valid if the two ranges overlap or touch, or one is empty.

Throws an error if the union would create two disjoint ranges.

```ts
union(range: HeightRange)
```
See also: [HeightRange](./services.md#class-heightrange)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Class: InlineBulkFileDataValidator

Portable complete-object validator. Node services should normally inject
`NodeBulkFileDataValidator`; browser and mobile consumers retain this
dependency-free fallback.

```ts
export class InlineBulkFileDataValidator implements BulkFileDataValidatorApi {
    async validate(request: BulkFileDataValidationRequest): Promise<BulkFileDataValidationResult>
}
```

See also: [BulkFileDataValidationRequest](./services.md#interface-bulkfiledatavalidationrequest), [BulkFileDataValidationResult](./services.md#interface-bulkfiledatavalidationresult), [BulkFileDataValidatorApi](./services.md#interface-bulkfiledatavalidatorapi)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Class: LiveIngestorBase

```ts
export abstract class LiveIngestorBase implements LiveIngestorApi {
    static createLiveIngestorBaseOptions(chain: Chain)
    chain: Chain;
    log: (...args: any[]) => void = () => ;
    constructor(options: LiveIngestorBaseOptions)
    async shutdown(): Promise<void> { }
    async setStorage(storage: ChaintracksStorageApi, log: (...args: any[]) => void): Promise<void>
    storage(): ChaintracksStorageApi
    abstract getHeaderByHash(hash: string): Promise<BlockHeader | undefined>;
    abstract startListening(liveHeaders: BlockHeader[]): Promise<void>;
    abstract stopListening(): void;
}
```

See also: [BlockHeader](./client.md#interface-blockheader), [Chain](./client.md#type-chain), [ChaintracksStorageApi](./services.md#interface-chaintracksstorageapi), [LiveIngestorApi](./services.md#interface-liveingestorapi), [LiveIngestorBaseOptions](./services.md#interface-liveingestorbaseoptions)

###### Method getHeaderByHash

Called to retrieve a missing block header,
when the previousHash of a new header is unknown.

```ts
abstract getHeaderByHash(hash: string): Promise<BlockHeader | undefined>
```
See also: [BlockHeader](./client.md#interface-blockheader)

Argument Details

+ **hash**
  + block hash of missing header

###### Method setStorage

Allocate resources.

```ts
async setStorage(storage: ChaintracksStorageApi, log: (...args: any[]) => void): Promise<void>
```
See also: [ChaintracksStorageApi](./services.md#interface-chaintracksstorageapi)

Argument Details

+ **storage**
  + coordinating storage engine.

###### Method shutdown

Release resources.
Override if required.

```ts
async shutdown(): Promise<void>
```

###### Method startListening

Begin retrieving new block headers.

New headers are pushed onto the liveHeaders array.

Continue waiting for new headers.

Return only when either `stopListening` or `shutdown` are called.

Be prepared to resume listening after `stopListening` but not
after `shutdown`.

```ts
abstract startListening(liveHeaders: BlockHeader[]): Promise<void>
```
See also: [BlockHeader](./client.md#interface-blockheader)

###### Method stopListening

Causes `startListening` to stop listening for new block headers and return.

```ts
abstract stopListening(): void
```

###### Method storage

```ts
storage(): ChaintracksStorageApi
```
See also: [ChaintracksStorageApi](./services.md#interface-chaintracksstorageapi)

Returns

coordinating storage engine.

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Class: LiveIngestorChaintracksSSE

Adapts a remote Chaintracks event stream, such as Arcade/go-chaintracks
`/chaintracks/v2/tip/stream`, into the local Chaintracks live-ingestor API.

```ts
export class LiveIngestorChaintracksSSE extends LiveIngestorBase {
    static createLiveIngestorChaintracksSSEOptions(chain: Chain, chaintracks: ChaintracksClientApi): LiveIngestorChaintracksSSEOptions
    constructor(private readonly options: LiveIngestorChaintracksSSEOptions)
    async getHeaderByHash(hash: string): Promise<BlockHeader | undefined>
    async startListening(liveHeaders: BlockHeader[]): Promise<void>
    stopListening(): void
    override async shutdown(): Promise<void>
}
```

See also: [BlockHeader](./client.md#interface-blockheader), [Chain](./client.md#type-chain), [ChaintracksClientApi](./services.md#interface-chaintracksclientapi), [LiveIngestorBase](./services.md#class-liveingestorbase), [LiveIngestorChaintracksSSEOptions](./services.md#interface-liveingestorchaintrackssseoptions)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Class: LiveIngestorWhatsOnChainPoll

Reports new headers by polling periodically.

```ts
export class LiveIngestorWhatsOnChainPoll extends LiveIngestorBase {
    static createLiveIngestorWhatsOnChainOptions(chain: Chain): LiveIngestorWhatsOnChainOptions
    idleWait: number;
    retryWait: number;
    retryWaitMax: number;
    maxQueuedHeaders: number;
    woc: WhatsOnChainServices;
    done: boolean = false;
    constructor(options: LiveIngestorWhatsOnChainOptions)
    async getHeaderByHash(hash: string): Promise<BlockHeader | undefined>
    async startListening(liveHeaders: BlockHeader[]): Promise<void>
    stopListening(): void
    override async shutdown(): Promise<void>
}
```

See also: [BlockHeader](./client.md#interface-blockheader), [Chain](./client.md#type-chain), [LiveIngestorBase](./services.md#class-liveingestorbase), [LiveIngestorWhatsOnChainOptions](./services.md#interface-liveingestorwhatsonchainoptions), [WhatsOnChainServices](./services.md#class-whatsonchainservices)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Class: LiveIngestorWhatsOnChainWs

```ts
export class LiveIngestorWhatsOnChainWs extends LiveIngestorBase {
    static createLiveIngestorWhatsOnChainOptions(chain: Chain): LiveIngestorWhatsOnChainOptions
    idleWait: number;
    retryWait: number;
    retryWaitMax: number;
    maxQueuedHeaders: number;
    woc: WhatsOnChainServices;
    stopNewListenersToken: StopListenerToken = { stop: undefined };
    done = false;
    constructor(options: LiveIngestorWhatsOnChainOptions)
    async getHeaderByHash(hash: string): Promise<BlockHeader | undefined>
    async startListening(liveHeaders: BlockHeader[]): Promise<void>
    stopListening(): void
    override async shutdown(): Promise<void>
}
```

See also: [BlockHeader](./client.md#interface-blockheader), [Chain](./client.md#type-chain), [LiveIngestorBase](./services.md#class-liveingestorbase), [LiveIngestorWhatsOnChainOptions](./services.md#interface-liveingestorwhatsonchainoptions), [StopListenerToken](./services.md#interface-stoplistenertoken), [WhatsOnChainServices](./services.md#class-whatsonchainservices)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Class: LocalChainTracker

Local-first SDK ChainTracker with explicit management and fallback state.

A definitive local `false` validation is never overridden by a remote
source. Fallback is reserved for local exceptions or explicit remote-only
mode, and applications can require agreement across multiple independent
references before accepting a fallback result.

```ts
export class LocalChainTracker implements ChainTracker {
    constructor(options: LocalChainTrackerOptions)
    getMode(): LocalChainTrackerMode
    setMode(mode: LocalChainTrackerMode): void
    getStatus(): LocalChainTrackerStatus
    getLocalClient(): ChaintracksClientApi
    async currentHeight(): Promise<number>
    async isValidRootForHeight(root: string, height: number): Promise<boolean>
    async synchronize(): Promise<LocalChainTrackerStatus>
    async clearLocalData(): Promise<LocalChainTrackerStatus>
    async checkConsistency(): Promise<LocalChainTrackerStatus>
}
```

See also: [ChaintracksClientApi](./services.md#interface-chaintracksclientapi), [LocalChainTrackerMode](./services.md#type-localchaintrackermode), [LocalChainTrackerOptions](./services.md#interface-localchaintrackeroptions), [LocalChainTrackerStatus](./services.md#interface-localchaintrackerstatus)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Class: NodeBulkFileDataValidator

Bounded Node worker pool for complete bulk-header verification.

A bounded private copy transfers to the worker and back without structured
cloning. This preserves the caller's source bytes if a worker crashes while
queue bounds prevent validation copies from consuming unbounded memory.

```ts
export class NodeBulkFileDataValidator implements BulkFileDataValidatorApi {
    constructor(options: NodeBulkFileDataValidatorOptions = {})
    async validate(request: BulkFileDataValidationRequest): Promise<BulkFileDataValidationResult>
    getStats(): BulkFileDataValidatorStats
    async destroy(): Promise<void>
}
```

See also: [BulkFileDataValidationRequest](./services.md#interface-bulkfiledatavalidationrequest), [BulkFileDataValidationResult](./services.md#interface-bulkfiledatavalidationresult), [BulkFileDataValidatorApi](./services.md#interface-bulkfiledatavalidatorapi), [BulkFileDataValidatorStats](./services.md#interface-bulkfiledatavalidatorstats), [NodeBulkFileDataValidatorOptions](./services.md#interface-nodebulkfiledatavalidatoroptions)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Class: SdkWhatsOnChain

Represents a chain tracker based on What's On Chain .

```ts
export default class SdkWhatsOnChain implements ChainTracker {
    readonly network: string;
    readonly apiKey: string;
    protected readonly URL: string;
    protected readonly httpClient: HttpClient;
    protected readonly requestTimeoutMsecs: number;
    constructor(network: "main" | "test" | "stn" | "ttn" | "tstn" = "main", config: LocalWhatsOnChainConfig = {})
    protected async request<T, Data = unknown>(url: string, options: HttpClientRequestOptions<Data>): Promise<HttpClientResponse<T>>
    async isValidRootForHeight(root: string, height: number): Promise<boolean>
    async currentHeight(): Promise<number>
    protected getHttpHeaders(): Record<string, string>
}
```

###### Constructor

Constructs an instance of the WhatsOnChain ChainTracker.

```ts
constructor(network: "main" | "test" | "stn" | "ttn" | "tstn" = "main", config: LocalWhatsOnChainConfig = {})
```

Argument Details

+ **network**
  + The BSV network to use when calling the WhatsOnChain API.
+ **config**
  + Configuration options for the WhatsOnChain ChainTracker.

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Class: ServiceCollection

```ts
export class ServiceCollection<T> {
    services: Array<{
        name: string;
        service: T;
    }>;
    _index: number;
    readonly since: Date;
    _historyByProvider: Record<string, ProviderCallHistory> = {};
    constructor(public serviceName: string, services?: Array<{
        name: string;
        service: T;
    }>)
    add(s: {
        name: string;
        service: T;
    }): this
    remove(name: string): void
    get name(): string
    get service(): T
    getServiceToCall(i: number): ServiceToCall<T>
    get serviceToCall(): ServiceToCall<T>
    get allServicesToCall(): Array<ServiceToCall<T>>
    moveServiceToLast(stc: ServiceToCall<T>): void
    get allServices(): T[]
    get count(): number
    get index(): number
    reset(): void
    next(): number
    clone(): ServiceCollection<T>
    _addServiceCall(providerName: string, call: ServiceCall): ProviderCallHistory
    getDuration(since: Date | string): number
    addServiceCallSuccess(stc: ServiceToCall<T>, result?: string): void
    addServiceCallFailure(stc: ServiceToCall<T>, result?: string): void
    addServiceCallError(stc: ServiceToCall<T>, error: WalletError): void
    getServiceCallHistory(reset?: boolean): ServiceCallHistory
}
```

See also: [ProviderCallHistory](./client.md#interface-providercallhistory), [ServiceCall](./services.md#interface-servicecall), [ServiceCallHistory](./client.md#interface-servicecallhistory), [ServiceToCall](./services.md#interface-servicetocall), [WalletError](./client.md#class-walleterror)

###### Property since

Start of currentCounts interval. Initially instance construction time.

```ts
readonly since: Date
```

###### Method getServiceCallHistory

```ts
getServiceCallHistory(reset?: boolean): ServiceCallHistory
```
See also: [ServiceCallHistory](./client.md#interface-servicecallhistory)

Returns

A copy of current service call history

###### Method moveServiceToLast

Used to de-prioritize a service call by moving it to the end of the list.

```ts
moveServiceToLast(stc: ServiceToCall<T>): void
```
See also: [ServiceToCall](./services.md#interface-servicetocall)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Class: Services

```ts
export class Services implements WalletServices {
    static readonly getStatusForTxidsBatchLimit = 20;
    static createDefaultOptions(chain: Chain): WalletServicesOptions
    options: WalletServicesOptions;
    whatsonchain: WhatsOnChain;
    arcTaal: ARC;
    arcGorillaPool?: ARC;
    arcade?: Arcade;
    bitails?: Bitails;
    getMerklePathServices!: ServiceCollection<GetMerklePathService>;
    getRawTxServices!: ServiceCollection<GetRawTxService>;
    postBeefServices!: ServiceCollection<PostBeefService>;
    getUtxoStatusServices!: ServiceCollection<GetUtxoStatusService>;
    getStatusForTxidsServices!: ServiceCollection<GetStatusForTxidsService>;
    getScriptHashHistoryServices!: ServiceCollection<GetScriptHashHistoryService>;
    updateFiatExchangeRateServices!: ServiceCollection<UpdateFiatExchangeRateService>;
    chain: Chain;
    readonly telemetry: Telemetry;
    constructor(optionsOrChain: Chain | WalletServicesOptions)
    getServicesCallHistory(reset?: boolean): ServicesCallHistory
    async getChainTracker(): Promise<ChainTracker>
    async getBsvExchangeRate(): Promise<number>
    async getFiatExchangeRate(currency: FiatCurrencyCode, base?: FiatCurrencyCode): Promise<number>
    async getFiatExchangeRates(targetCurrencies: FiatCurrencyCode[]): Promise<FiatExchangeRates>
    get getProofsCount(): number
    get getRawTxsCount(): number
    get postBeefServicesCount(): number
    get getUtxoStatsCount(): number
    async getStatusForTxids(txids: string[], useNext?: boolean): Promise<GetStatusForTxidsResult>
    hashOutputScript(script: string): string
    async isUtxo(output: TableOutput): Promise<boolean>
    async getUtxoStatus(output: string, outputFormat?: GetUtxoStatusOutputFormat, outpoint?: string, useNext?: boolean, logger?: WalletLoggerInterface): Promise<GetUtxoStatusResult>
    async getScriptHashHistory(hash: string, useNext?: boolean, logger?: WalletLoggerInterface): Promise<GetScriptHashHistoryResult>
    postBeefMode: "PromiseAll" | "UntilSuccess" = "UntilSuccess";
    postBeefUntilSuccessSoftTimeoutMs = 5000;
    postBeefUntilSuccessSoftTimeoutPerKbMs = 50;
    postBeefUntilSuccessSoftTimeoutMaxMs = 30000;
    async postBeef(beef: Beef, txids: string[], logger?: WalletLoggerInterface): Promise<PostBeefResult[]>
    async getRawTx(txid: string, useNext?: boolean): Promise<GetRawTxResult>
    async invokeChaintracksWithRetry<R>(method: () => Promise<R>, operation: string = "unknown"): Promise<R>
    async getHeaderForHeight(height: number): Promise<number[]>
    async getHeight(): Promise<number>
    async hashToHeader(hash: string): Promise<BlockHeader>
    async getMerklePath(txid: string, useNext?: boolean, logger?: WalletLoggerInterface): Promise<GetMerklePathResult>
    async getValidatedMerklePath(txid: string, validate: (result: GetMerklePathResult) => Promise<void>): Promise<GetMerklePathResult>
    async updateFiatExchangeRates(targetCurrencies: FiatCurrencyCode[], updateMsecs?: number): Promise<FiatExchangeRates>
    async nLockTimeIsFinal(tx: string | number[] | BsvTransaction | number): Promise<boolean>
    async getBeefForTxid(txid: string): Promise<Beef>
}
```

See also: [ARC](./services.md#class-arc), [Arcade](./services.md#class-arcade), [Bitails](./services.md#class-bitails), [BlockHeader](./client.md#interface-blockheader), [Chain](./client.md#type-chain), [FiatCurrencyCode](./client.md#type-fiatcurrencycode), [FiatExchangeRates](./client.md#interface-fiatexchangerates), [GetMerklePathResult](./client.md#interface-getmerklepathresult), [GetMerklePathService](./client.md#type-getmerklepathservice), [GetRawTxResult](./client.md#interface-getrawtxresult), [GetRawTxService](./client.md#type-getrawtxservice), [GetScriptHashHistoryResult](./client.md#interface-getscripthashhistoryresult), [GetScriptHashHistoryService](./client.md#type-getscripthashhistoryservice), [GetStatusForTxidsResult](./client.md#interface-getstatusfortxidsresult), [GetStatusForTxidsService](./client.md#type-getstatusfortxidsservice), [GetUtxoStatusOutputFormat](./client.md#type-getutxostatusoutputformat), [GetUtxoStatusResult](./client.md#interface-getutxostatusresult), [GetUtxoStatusService](./client.md#type-getutxostatusservice), [PostBeefResult](./client.md#interface-postbeefresult), [PostBeefService](./client.md#type-postbeefservice), [ServiceCollection](./services.md#class-servicecollection), [ServicesCallHistory](./client.md#interface-servicescallhistory), [TableOutput](./storage.md#interface-tableoutput), [UpdateFiatExchangeRateService](./client.md#type-updatefiatexchangerateservice), [WalletServices](./client.md#interface-walletservices), [WalletServicesOptions](./client.md#interface-walletservicesoptions), [WhatsOnChain](./services.md#class-whatsonchain), [getBeefForTxid](./services.md#function-getbeeffortxid), [logger](./client.md#variable-logger)

###### Property arcade

Primary Arcade (bsv-blockchain/arcade) broadcaster, when `options.arcadeUrl` is set.

```ts
arcade?: Arcade
```
See also: [Arcade](./services.md#class-arcade)

###### Property postBeefUntilSuccessSoftTimeoutMaxMs

Upper bound for adaptive soft-timeout in `UntilSuccess` mode.

```ts
postBeefUntilSuccessSoftTimeoutMaxMs = 30000
```

###### Property postBeefUntilSuccessSoftTimeoutMs

Soft timeout used for each provider call in `UntilSuccess` mode.
This bounds request latency when a provider hangs before failover.

```ts
postBeefUntilSuccessSoftTimeoutMs = 5000
```

###### Property postBeefUntilSuccessSoftTimeoutPerKbMs

Additional soft-timeout budget (ms) per KiB of serialized Beef payload.
Helps avoid false timeout failover on legitimately large submissions.

```ts
postBeefUntilSuccessSoftTimeoutPerKbMs = 50
```

###### Method hashOutputScript

```ts
hashOutputScript(script: string): string
```

Returns

script hash in 'hashLE' format, which is the default.

Argument Details

+ **script**
  + Output script to be hashed for `getUtxoStatus` default `outputFormat`

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Class: SingleWriterMultiReaderLock

A reader-writer lock to manage concurrent access.
Allows multiple readers or one writer at a time.

```ts
export class SingleWriterMultiReaderLock {
    constructor(private readonly maxQueued = 4096)
    async withReadLock<T>(fn: () => Promise<T>): Promise<T>
    async withWriteLock<T>(fn: () => Promise<T>): Promise<T>
}
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Class: WhatsOnChain

```ts
export class WhatsOnChain extends WhatsOnChainNoServices {
    services: Services;
    constructor(chain: Chain = "main", config: WalletToolboxWhatsOnChainConfig = {}, services?: Services)
    async getMerklePath(txid: string, services: WalletServices): Promise<GetMerklePathResult>
}
```

See also: [Chain](./client.md#type-chain), [GetMerklePathResult](./client.md#interface-getmerklepathresult), [Services](./services.md#class-services), [WalletServices](./client.md#interface-walletservices), [WalletToolboxWhatsOnChainConfig](./services.md#interface-wallettoolboxwhatsonchainconfig), [WhatsOnChainNoServices](./services.md#class-whatsonchainnoservices)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Class: WhatsOnChainNoServices

```ts
export class WhatsOnChainNoServices extends SdkWhatsOnChain {
    constructor(chain: Chain = "main", config: WalletToolboxWhatsOnChainConfig = {})
    async getStatusForTxids(txids: string[]): Promise<GetStatusForTxidsResult>
    async getTxPropagation(txid: string): Promise<number>
    async getRawTx(txid: string): Promise<string | undefined>
    async getRawTxResult(txid: string): Promise<GetRawTxResult>
    async postBeef(beef: Beef, txids: string[]): Promise<PostBeefResult>
    async postRawTx(rawTx: HexString): Promise<PostTxResultForTxid>
    async updateBsvExchangeRate(rate?: BsvExchangeRate, updateMsecs?: number): Promise<BsvExchangeRate>
    async getUtxoStatus(output: string, outputFormat?: GetUtxoStatusOutputFormat, outpoint?: string): Promise<GetUtxoStatusResult>
    async getScriptHashConfirmedHistory(hash: string): Promise<GetScriptHashHistoryResult>
    async getScriptHashUnconfirmedHistory(hash: string): Promise<GetScriptHashHistoryResult>
    async getScriptHashHistory(hash: string): Promise<GetScriptHashHistoryResult>
    async getBlockHeaderByHash(hash: string): Promise<BlockHeader | undefined>
    async getChainInfo(): Promise<WocChainInfo>
}
```

See also: [BlockHeader](./client.md#interface-blockheader), [BsvExchangeRate](./client.md#interface-bsvexchangerate), [Chain](./client.md#type-chain), [GetRawTxResult](./client.md#interface-getrawtxresult), [GetScriptHashHistoryResult](./client.md#interface-getscripthashhistoryresult), [GetStatusForTxidsResult](./client.md#interface-getstatusfortxidsresult), [GetUtxoStatusOutputFormat](./client.md#type-getutxostatusoutputformat), [GetUtxoStatusResult](./client.md#interface-getutxostatusresult), [PostBeefResult](./client.md#interface-postbeefresult), [PostTxResultForTxid](./client.md#interface-posttxresultfortxid), [SdkWhatsOnChain](./services.md#class-sdkwhatsonchain), [WalletToolboxWhatsOnChainConfig](./services.md#interface-wallettoolboxwhatsonchainconfig), [WocChainInfo](./services.md#interface-wocchaininfo)

###### Method getBlockHeaderByHash

{
  "hash": "000000000000000004a288072ebb35e37233f419918f9783d499979cb6ac33eb",
  "confirmations": 328433,
  "size": 14421,
  "height": 575045,
  "version": 536928256,
  "versionHex": "2000e000",
  "merkleroot": "4ebcba09addd720991d03473f39dce4b9a72cc164e505cd446687a54df9b1585",
  "time": 1553416668,
  "mediantime": 1553414858,
  "nonce": 87914848,
  "bits": "180997ee",
  "difficulty": 114608607557.4425,
  "chainwork": "000000000000000000000000000000000000000000ddf5d385546872bab7dc01",
  "previousblockhash": "00000000000000000988156c7075dc9147a5b62922f1310862e8b9000d46dd9b",
  "nextblockhash": "00000000000000000112b36a37c10235fa0c991f680bc5482ba9692e0ae697db",
  "nTx": 0,
  "num_tx": 5
}

```ts
async getBlockHeaderByHash(hash: string): Promise<BlockHeader | undefined>
```
See also: [BlockHeader](./client.md#interface-blockheader)

###### Method getRawTx

May return undefined for unmined transactions that are in the mempool.

```ts
async getRawTx(txid: string): Promise<string | undefined>
```

Returns

raw transaction as hex string or undefined if txid not found in mined block.

###### Method getStatusForTxids

POST
https://api.whatsonchain.com/v1/bsv/main/txs/status
Content-Type: application/json
data: "{\"txids\":[\"6815f8014db74eab8b7f75925c68929597f1d97efa970109d990824c25e5e62b\"]}"

result for a mined txid:
    [{
       "txid":"294cd1ebd5689fdee03509f92c32184c0f52f037d4046af250229b97e0c8f1aa",
       "blockhash":"000000000000000004b5ce6670f2ff27354a1e87d0a01bf61f3307f4ccd358b5",
       "blockheight":612251,
       "blocktime":1575841517,
       "confirmations":278272
     }]

result for a valid recent txid:
    [{"txid":"6815f8014db74eab8b7f75925c68929597f1d97efa970109d990824c25e5e62b"}]

result for an unknown txid:
    [{"txid":"6815f8014db74eab8b7f75925c68929597f1d97efa970109d990824c25e5e62c","error":"unknown"}]

```ts
async getStatusForTxids(txids: string[]): Promise<GetStatusForTxidsResult>
```
See also: [GetStatusForTxidsResult](./client.md#interface-getstatusfortxidsresult)

###### Method getTxPropagation

2025-02-16 throwing internal server error 500.

```ts
async getTxPropagation(txid: string): Promise<number>
```

###### Method postBeef

WhatsOnChain does not natively support a postBeef end-point aware of multiple txids of interest in the Beef.

Send rawTx in `txids` order from beef.

```ts
async postBeef(beef: Beef, txids: string[]): Promise<PostBeefResult>
```
See also: [PostBeefResult](./client.md#interface-postbeefresult)

###### Method postRawTx

```ts
async postRawTx(rawTx: HexString): Promise<PostTxResultForTxid>
```
See also: [PostTxResultForTxid](./client.md#interface-posttxresultfortxid)

Returns

txid returned by transaction processor of transaction broadcast

Argument Details

+ **rawTx**
  + raw transaction to broadcast as hex string

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Class: WhatsOnChainServices

```ts
export class WhatsOnChainServices {
    static createWhatsOnChainServicesOptions(chain: Chain): WhatsOnChainServicesOptions
    static readonly chainInfo: Array<WocChainInfo | undefined> = [];
    static readonly chainInfoTime: Array<Date | undefined> = [];
    static readonly chainInfoMsecs: number[] = [];
    static readonly chainInfoPromise: Partial<Record<Chain, Promise<WocChainInfo>>> = {};
    chain: Chain;
    woc: WhatsOnChain;
    public readonly options: WhatsOnChainServicesOptions;
    constructor(options: WhatsOnChainServicesOptions)
    async getHeaderByHash(hash: string): Promise<BlockHeader | undefined>
    async getChainInfo(): Promise<WocChainInfo>
    async getChainTipHeight(): Promise<number>
    async getChainTipHash(): Promise<string>
    async getHeaders(fetch?: ChaintracksFetchApi): Promise<WocGetHeadersHeader[]>
    async getHeaderByteFileLinks(neededRange: HeightRange, fetch?: ChaintracksFetchApi): Promise<GetHeaderByteFileLinksResult[]>
}
```

See also: [BlockHeader](./client.md#interface-blockheader), [Chain](./client.md#type-chain), [ChaintracksFetchApi](./services.md#interface-chaintracksfetchapi), [GetHeaderByteFileLinksResult](./services.md#interface-getheaderbytefilelinksresult), [HeightRange](./services.md#class-heightrange), [WhatsOnChain](./services.md#class-whatsonchain), [WhatsOnChainServicesOptions](./services.md#interface-whatsonchainservicesoptions), [WocChainInfo](./services.md#interface-wocchaininfo), [WocGetHeadersHeader](./services.md#interface-wocgetheadersheader)

###### Method getHeaders

```ts
async getHeaders(fetch?: ChaintracksFetchApi): Promise<WocGetHeadersHeader[]>
```
See also: [ChaintracksFetchApi](./services.md#interface-chaintracksfetchapi), [WocGetHeadersHeader](./services.md#interface-wocgetheadersheader)

Returns

returns the last 10 block headers including height, size, chainwork...

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
#### Functions

| | | |
| --- | --- | --- |
| [WocHeadersBulkListener](#function-wocheadersbulklistener) | [getWhatsOnChainBlockHeaderByHash](#function-getwhatsonchainblockheaderbyhash) | [serializeBaseBlockHeader](#function-serializebaseblockheader) |
| [WocHeadersBulkListener_test](#function-wocheadersbulklistener_test) | [handlePostRawTxErrorResponse](#function-handlepostrawtxerrorresponse) | [serializeBaseBlockHeaders](#function-serializebaseblockheaders) |
| [WocHeadersLiveListener](#function-wocheaderslivelistener) | [handleScriptHashHistoryCatch](#function-handlescripthashhistorycatch) | [sha256HashOfBinaryFile](#function-sha256hashofbinaryfile) |
| [WocHeadersLiveListener_test](#function-wocheaderslivelistener_test) | [handleScriptHashHistoryResponse](#function-handlescripthashhistoryresponse) | [snapshotMerklePathResult](#function-snapshotmerklepathresult) |
| [addWork](#function-addwork) | [handleUtxoConnReset](#function-handleutxoconnreset) | [snapshotPostBeefRequest](#function-snapshotpostbeefrequest) |
| [arcDefaultUrl](#function-arcdefaulturl) | [isArcAcceptedTxStatus](#function-isarcacceptedtxstatus) | [startChaintracks](#function-startchaintracks) |
| [arcGorillaPoolUrl](#function-arcgorillapoolurl) | [isArcDoubleSpendTxStatus](#function-isarcdoublespendtxstatus) | [stnArcadeUrl](#function-stnarcadeurl) |
| [arcadeDefaultUrl](#function-arcadedefaulturl) | [isArcInvalidTxStatus](#function-isarcinvalidtxstatus) | [stnChaintracksUrl](#function-stnchaintracksurl) |
| [authenticateMerklePathResult](#function-authenticatemerklepathresult) | [isArcServiceErrorStatus](#function-isarcserviceerrorstatus) | [subWork](#function-subwork) |
| [blockHash](#function-blockhash) | [isBaseBlockHeader](#function-isbaseblockheader) | [swapByteOrder](#function-swapbyteorder) |
| [buildChaintracksOptionsWithIngestors](#function-buildchaintracksoptionswithingestors) | [isBlockHeader](#function-isblockheader) | [toBinaryBaseBlockHeader](#function-tobinarybaseblockheader) |
| [classifyArcadeRejection](#function-classifyarcaderejection) | [isKnownValidBulkHeaderFile](#function-isknownvalidbulkheaderfile) | [toDefaultChaintracksArguments](#function-todefaultchaintracksarguments) |
| [classifyMerklePathResponse](#function-classifymerklepathresponse) | [isLive](#function-islive) | [toDefaultKnexChaintracksArguments](#function-todefaultknexchaintracksarguments) |
| [classifyOutputUtxo](#function-classifyoutpututxo) | [isLiveBlockHeader](#function-isliveblockheader) | [tstnArcadeUrl](#function-tstnarcadeurl) |
| [containsControlCharacter](#function-containscontrolcharacter) | [isMoreWork](#function-ismorework) | [tstnChaintracksUrl](#function-tstnchaintracksurl) |
| [convertBitsToTarget](#function-convertbitstotarget) | [isValidFiatRate](#function-isvalidfiatrate) | [updateChaintracksFiatExchangeRates](#function-updatechaintracksfiatexchangerates) |
| [convertBitsToWork](#function-convertbitstowork) | [makeMerklePathNote](#function-makemerklepathnote) | [updateExchangeratesapi](#function-updateexchangeratesapi) |
| [convertBufferToUint32](#function-convertbuffertouint32) | [makePostBeefServiceError](#function-makepostbeefserviceerror) | [validBulkHeaderFilesByFileHash](#function-validbulkheaderfilesbyfilehash) |
| [convertUint32ToBuffer](#function-convertuint32tobuffer) | [mapWithConcurrency](#function-mapwithconcurrency) | [validateAgainstDirtyHashes](#function-validateagainstdirtyhashes) |
| [convertWocToBlockHeaderHex](#function-convertwoctoblockheaderhex) | [normalizeArcProviderConfig](#function-normalizearcproviderconfig) | [validateArcadeTxData](#function-validatearcadetxdata) |
| [copyRawTransactionBytes](#function-copyrawtransactionbytes) | [normalizeBulkFileDataValidationRequest](#function-normalizebulkfiledatavalidationrequest) | [validateBaseBlockHeaderFormat](#function-validatebaseblockheaderformat) |
| [copyValidatedBlockHeader](#function-copyvalidatedblockheader) | [normalizeBulkHeaderFileInfo](#function-normalizebulkheaderfileinfo) | [validateBufferOfHeaders](#function-validatebufferofheaders) |
| [createAndStartDefaultChaintracks](#function-createandstartdefaultchaintracks) | [normalizeBulkHeaderFileSequence](#function-normalizebulkheaderfilesequence) | [validateBulkFileData](#function-validatebulkfiledata) |
| [createAndStartDefaultKnexChaintracks](#function-createandstartdefaultknexchaintracks) | [normalizeBulkHeaderFilesInfo](#function-normalizebulkheaderfilesinfo) | [validateGenesisHeader](#function-validategenesisheader) |
| [createChaintracksInitialSchema](#function-createchaintracksinitialschema) | [normalizeFiatCurrencies](#function-normalizefiatcurrencies) | [validateHeaderDifficulty](#function-validateheaderdifficulty) |
| [createDefaultBulkFileDataManager](#function-createdefaultbulkfiledatamanager) | [normalizeFiatCurrency](#function-normalizefiatcurrency) | [validateHeaderFormat](#function-validateheaderformat) |
| [createDefaultChaintracksClient](#function-createdefaultchaintracksclient) | [normalizeFiatExchangeRates](#function-normalizefiatexchangerates) | [validateHeaderProofOfWork](#function-validateheaderproofofwork) |
| [createDefaultChaintracksStorageOptions](#function-createdefaultchaintracksstorageoptions) | [normalizeFiatRate](#function-normalizefiatrate) | [validateMerklePathResult](#function-validatemerklepathresult) |
| [createDefaultIdbChaintracksOptions](#function-createdefaultidbchaintracksoptions) | [normalizeFiatRateTimestamps](#function-normalizefiatratetimestamps) | [validatePostBeefResult](#function-validatepostbeefresult) |
| [createDefaultKnexChaintracksOptions](#function-createdefaultknexchaintracksoptions) | [normalizeFiatTimestamp](#function-normalizefiattimestamp) | [validatePostBeefResultOrServiceError](#function-validatepostbeefresultorserviceerror) |
| [createDefaultNoDbChaintracksOptions](#function-createdefaultnodbchaintracksoptions) | [normalizePostRawHex](#function-normalizepostrawhex) | [validatePostTxResult](#function-validateposttxresult) |
| [createDefaultWalletServicesOptions](#function-createdefaultwalletservicesoptions) | [normalizePostTxids](#function-normalizeposttxids) | [validatePostTxResultOrServiceError](#function-validateposttxresultorserviceerror) |
| [createIdbChaintracks](#function-createidbchaintracks) | [normalizeTxid](#function-normalizetxid) | [validateRawTxResult](#function-validaterawtxresult) |
| [createKnexChaintracks](#function-createknexchaintracks) | [normalizeWalletOutpoint](#function-normalizewalletoutpoint) | [validateScriptHash](#function-validatescripthash) |
| [createNoDbChaintracks](#function-createnodbchaintracks) | [parseFileLink](#function-parsefilelink) | [validateScriptHashHistoryResult](#function-validatescripthashhistoryresult) |
| [createStopHandler](#function-createstophandler) | [populateUtxoDetails](#function-populateutxodetails) | [validateStatusForTxidsResult](#function-validatestatusfortxidsresult) |
| [deserializeBaseBlockHeader](#function-deserializebaseblockheader) | [publicArcadeUrl](#function-publicarcadeurl) | [validateUtxoStatusResult](#function-validateutxostatusresult) |
| [deserializeBaseBlockHeaders](#function-deserializebaseblockheaders) | [readUInt32BE](#function-readuint32be) | [validateWocChainInfo](#function-validatewocchaininfo) |
| [deserializeBlockHeader](#function-deserializeblockheader) | [readUInt32LE](#function-readuint32le) | [wocGetHeadersHeaderToBlockHeader](#function-wocgetheadersheadertoblockheader) |
| [deserializeBlockHeaders](#function-deserializeblockheaders) | [requireConclusiveUtxo](#function-requireconclusiveutxo) | [workBNtoBuffer](#function-workbntobuffer) |
| [genesisBuffer](#function-genesisbuffer) | [resolveDefaultChaintracksArguments](#function-resolvedefaultchaintracksarguments) | [writeUInt32BE](#function-writeuint32be) |
| [genesisHeader](#function-genesisheader) | [resolveDefaultKnexChaintracksArguments](#function-resolvedefaultknexchaintracksarguments) | [writeUInt32LE](#function-writeuint32le) |
| [getBeefForTxid](#function-getbeeffortxid) | [safeDiagnostic](#function-safediagnostic) |  |
| [getExchangeRatesIo](#function-getexchangeratesio) | [selectBulkHeaderFiles](#function-selectbulkheaderfiles) |  |

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---

##### Function: WocHeadersBulkListener

High speed WebSocket based based old block header listener

```ts
export async function WocHeadersBulkListener(...[fromHeight, toHeight, enqueue, error, stop, chain, logger = () => { }, idleWait = 5000]: [
    fromHeight: number,
    toHeight: number,
    enqueue: (header: BlockHeader) => void,
    error: (code: number, message: string) => boolean,
    stop: StopListenerToken,
    chain: Chain,
    logger?: (...args: any[]) => void,
    idleWait?: number
]): Promise<boolean>
```

See also: [BlockHeader](./client.md#interface-blockheader), [Chain](./client.md#type-chain), [StopListenerToken](./services.md#interface-stoplistenertoken), [logger](./client.md#variable-logger)

Returns

true on normal completion, false if should restart if no error received.

Argument Details

+ **enqueue**
  + returns headers received from WebSocket service
+ **error**
  + notifies of abnormal events, return false to close websocket, true to ignore the error.
+ **stop**
  + an object with a stop property which gets set to a method to stop listener
+ **chain**
  + 'test' | 'main'
+ **idleWait**
  + how many milliseconds to timeout between completion checks.

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: WocHeadersBulkListener_test

v2
{
"message": {
"data": {
  "version": 872415232,
  "previousblockhash": "00000000000000000ea1f9ba0817a0f922ee227be306fd9097a4e76caf5ff411",
  "merkleroot": "dcd7efb3c39e8e2d597e4757b9a49c98f52f77a6df39d1d5936ac3abb2559944",
  "time": 1750182239,
  "bits": 403926191,
  "nonce": 1043732575,
  "hash": "0000000000000000032d09ca772ca5b3bc5b90a79a5bbcc4a05c99fb6d3b23d8",
  "height": 901658
}
}
}

```ts
export async function WocHeadersBulkListener_test(): Promise<void>
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: WocHeadersLiveListener

High speed WebSocket based based new block header listener

```ts
export async function WocHeadersLiveListener(enqueue: (header: BlockHeader) => void, error: (code: number, message: string) => boolean, stop: StopListenerToken, chain: Chain, _logger: (...args: any[]) => void, idleWait = 100000): Promise<boolean>
```

See also: [BlockHeader](./client.md#interface-blockheader), [Chain](./client.md#type-chain), [StopListenerToken](./services.md#interface-stoplistenertoken)

Returns

true only if exit caused by `stop`

Argument Details

+ **enqueue**
  + returns headers received from WebSocket service
+ **error**
  + notifies of abnormal events, return false to close websocket, true to ignore the error.
+ **stop**
  + an object with a stop property which gets set to a method to stop listener
+ **chain**
  + 'test' | 'main'
+ **idleWait**
  + without any input, after this many milliseconds, assume dead service and exit.

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: WocHeadersLiveListener_test

```ts
export async function WocHeadersLiveListener_test(): Promise<void>
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: addWork

Add two Buffer encoded chainwork values

```ts
export function addWork(work1: string, work2: string): string
```

Returns

Sum of work1 + work2 as Buffer encoded chainWork value

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: arcDefaultUrl

```ts
export function arcDefaultUrl(chain: Chain): string
```

See also: [Chain](./client.md#type-chain)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: arcGorillaPoolUrl

```ts
export function arcGorillaPoolUrl(chain: Chain): string | undefined
```

See also: [Chain](./client.md#type-chain)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: arcadeDefaultUrl

Default Arcade (bsv-blockchain/arcade) endpoint per chain.
Returns undefined when no public default is known for the chain.

```ts
export function arcadeDefaultUrl(chain: Chain): string | undefined
```

See also: [Chain](./client.md#type-chain)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: authenticateMerklePathResult

```ts
export async function authenticateMerklePathResult(requestedTxid: unknown, result: GetMerklePathResult, validator: MerkleRootValidator, requireProofOfWork = false, requireHeaderFormat = true): Promise<ValidatedMerklePathResult>
```

See also: [GetMerklePathResult](./client.md#interface-getmerklepathresult), [MerkleRootValidator](./services.md#interface-merklerootvalidator), [ValidatedMerklePathResult](./services.md#interface-validatedmerklepathresult)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: blockHash

Computes double sha256 hash of bitcoin block header
bytes are reversed to bigendian order

If header is a Buffer, it is required to 80 bytes long
and in standard block header serialized encoding.

```ts
export function blockHash(header: BaseBlockHeader | number[] | Uint8Array): string {
    const a = !Array.isArray(header) && !(header instanceof Uint8Array) ? serializeBaseBlockHeader(header) : header;
    if (a.length !== 80)
        throw new Error("Block header must be 80 bytes long.");
    return asString(doubleSha256BE(a));
}
```

See also: [BaseBlockHeader](./client.md#interface-baseblockheader), [asString](./client.md#function-asstring), [doubleSha256BE](./client.md#function-doublesha256be), [serializeBaseBlockHeader](./services.md#function-serializebaseblockheader)

Returns

doule sha256 hash of header bytes reversed

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: buildChaintracksOptionsWithIngestors

Builds the shared portion of ChaintracksOptions that all storage backends
(Knex, Idb, NoDb) have in common: the options shell and bulk/live ingestors.

The caller is responsible for providing the storage implementation.

```ts
export function buildChaintracksOptionsWithIngestors(params: ChaintracksIngestorParams, storage: ChaintracksOptions["storage"]): ChaintracksOptions
```

See also: [ChaintracksIngestorParams](./services.md#interface-chaintracksingestorparams), [ChaintracksOptions](./services.md#interface-chaintracksoptions)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: classifyArcadeRejection

Canonical classification shared by Arcade polling and SSE. Keeping this in
one place prevents a provider from calling a rejection "unknown" while the
monitor's event path calls the same status terminal.

```ts
export function classifyArcadeRejection(event: ArcadeLifecycleStatus): ArcadeRejectionClassification
```

See also: [ArcadeLifecycleStatus](./services.md#interface-arcadelifecyclestatus), [ArcadeRejectionClassification](./services.md#interface-arcaderejectionclassification)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: classifyMerklePathResponse

Classify a non-OK status response for getMerklePath.

Returns `'retry'` when the request was rate-limited and the caller should retry,
`'notFound'` for 404, `'badStatus'` for other non-200 codes.

```ts
export function classifyMerklePathResponse(status: number, statusText: string, retry: number): "retry" | "notFound" | "badStatus" | "ok"
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: classifyOutputUtxo

Classify an output without ever converting provider absence or failure into
positive spent evidence. This helper deliberately catches provider throws so
batch callers can finish classifying every candidate before deciding whether
a destructive operation is safe.

```ts
export async function classifyOutputUtxo(services: UtxoServices, output: TableOutput): Promise<OutputUtxoClassification>
```

See also: [OutputUtxoClassification](./services.md#interface-outpututxoclassification), [TableOutput](./storage.md#interface-tableoutput)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: containsControlCharacter

```ts
export function containsControlCharacter(value: string): boolean
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: convertBitsToTarget

Computes "target" value for 4 byte Bitcoin block header "bits" value.

```ts
export function convertBitsToTarget(bits: number | number[]): BigNumber
```

Returns

32 byte Buffer with "target" value

Argument Details

+ **bits**
  + number or converted from Buffer using `readUint32LE`

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: convertBitsToWork

Computes "chainWork" value for 4 byte Bitcoin block header "bits" value.

```ts
export function convertBitsToWork(bits: number | number[]): string
```

Returns

32 byte Buffer with "chainWork" value

Argument Details

+ **bits**
  + number or converted from Buffer using `readUint32LE`

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: convertBufferToUint32

```ts
export function convertBufferToUint32(buffer: number[] | Uint8Array, littleEndian = true): number {
    validateByteWindow(buffer, 0, 4);
    if (buffer.length !== 4)
        throw new WERR_INVALID_PARAMETER("buffer", "exactly four bytes");
    if (typeof littleEndian !== "boolean")
        throw new WERR_INVALID_PARAMETER("littleEndian", "a boolean");
    const a = littleEndian ? buffer : buffer.slice().reverse();
    const n = (a[0] | (a[1] << 8) | (a[2] << 16) | (a[3] << 24)) >>> 0;
    return n;
}
```

See also: [WERR_INVALID_PARAMETER](./client.md#class-werr_invalid_parameter)

Returns

a number value in the Uint32 value range

Argument Details

+ **buffer**
  + four byte buffer with Uint32 number encoded
+ **littleEndian**
  + true for little-endian byte order in Buffer

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: convertUint32ToBuffer

```ts
export function convertUint32ToBuffer(n: number, littleEndian = true): number[] {
    validateUnsignedHeaderInteger(n, "uint32", UINT32_MAX);
    if (typeof littleEndian !== "boolean")
        throw new WERR_INVALID_PARAMETER("littleEndian", "a boolean");
    const a = [
        n & 255,
        (n >> 8) & 255,
        (n >> 16) & 255,
        (n >> 24) & 255
    ];
    return littleEndian ? a : a.reverse();
}
```

See also: [WERR_INVALID_PARAMETER](./client.md#class-werr_invalid_parameter)

Returns

four byte buffer with Uint32 number encoded

Argument Details

+ **num**
  + a number value in the Uint32 value range
+ **littleEndian**
  + true for little-endian byte order in Buffer

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: convertWocToBlockHeaderHex

```ts
export function convertWocToBlockHeaderHex(woc: WocHeader): BlockHeader
```

See also: [BlockHeader](./client.md#interface-blockheader), [WocHeader](./services.md#interface-wocheader)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: copyRawTransactionBytes

```ts
export function copyRawTransactionBytes(value: unknown, name = "rawTx"): number[]
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: copyValidatedBlockHeader

```ts
export function copyValidatedBlockHeader(value: unknown, requireProofOfWork = false, requireHeaderFormat = true): BlockHeader
```

See also: [BlockHeader](./client.md#interface-blockheader)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: createAndStartDefaultChaintracks

```ts
export function createAndStartDefaultChaintracks<TStorage extends ChaintracksOptions["storage"]>(args: DefaultChaintracksArguments, createOptions: (...args: DefaultChaintracksArguments) => ChaintracksOptions): CreatedChaintracks<TStorage>
```

See also: [ChaintracksOptions](./services.md#interface-chaintracksoptions), [CreatedChaintracks](./services.md#interface-createdchaintracks), [DefaultChaintracksArguments](./services.md#type-defaultchaintracksarguments)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: createAndStartDefaultKnexChaintracks

```ts
export function createAndStartDefaultKnexChaintracks<TStorage extends ChaintracksOptions["storage"]>(args: DefaultKnexChaintracksArguments, createOptions: (...args: DefaultKnexChaintracksArguments) => ChaintracksOptions): CreatedChaintracks<TStorage>
```

See also: [ChaintracksOptions](./services.md#interface-chaintracksoptions), [CreatedChaintracks](./services.md#interface-createdchaintracks), [DefaultKnexChaintracksArguments](./services.md#type-defaultknexchaintracksarguments)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: createChaintracksInitialSchema

Builds the current Chaintracks schema. Exported so dialect DDL can be regression-tested without a live server.

```ts
export function createChaintracksInitialSchema(knex: Knex): Knex.SchemaBuilder
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: createDefaultBulkFileDataManager

```ts
export function createDefaultBulkFileDataManager(params: ResolvedDefaultChaintracksParams): BulkFileDataManager
```

See also: [BulkFileDataManager](./services.md#class-bulkfiledatamanager), [ResolvedDefaultChaintracksParams](./services.md#interface-resolveddefaultchaintracksparams)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: createDefaultChaintracksClient

Returns the credential-free default ChainTracks client for a supported
public network, or an operator-configured client for stn/tstn.

BROWSER RUNTIMES get the legacy CORS-enabled Chaintracks service for
main/test. The Go Chaintracks deployments (`arcade-v2-*.bsvblockchain.tech`)
currently serve no `Access-Control-Allow-Origin` header and answer OPTIONS
preflights with 404 (verified live 2026-08-11), so every fetch from a
browser-hosted wallet is CORS-blocked (WebKit surfaces it as
`TypeError: Load failed`) and the wallet loses `getHeight`, headers and
merkle-root validation wholesale. The repository service contract
(AGENTS.md: "browser, mobile, and unknown-domain clients must not be
silently blocked by CORS") requires a default that browsers can actually
reach. Once the Go deployments serve CORS (and a browser-run conformance
check proves it), this branch can be removed and browsers can share the v2
default. Node runtimes are unchanged.

```ts
export function createDefaultChaintracksClient(chain: Exclude<Chain, "mock">): ChaintracksClientApi
```

See also: [Chain](./client.md#type-chain), [ChaintracksClientApi](./services.md#interface-chaintracksclientapi)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: createDefaultChaintracksStorageOptions

```ts
export function createDefaultChaintracksStorageOptions(params: ResolvedDefaultChaintracksParams)
```

See also: [ResolvedDefaultChaintracksParams](./services.md#interface-resolveddefaultchaintracksparams)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: createDefaultIdbChaintracksOptions

```ts
export function createDefaultIdbChaintracksOptions(...args: DefaultChaintracksArguments): ChaintracksOptions
```

See also: [ChaintracksOptions](./services.md#interface-chaintracksoptions), [DefaultChaintracksArguments](./services.md#type-defaultchaintracksarguments)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: createDefaultKnexChaintracksOptions

```ts
export function createDefaultKnexChaintracksOptions(...args: DefaultKnexChaintracksArguments): ChaintracksOptions
```

See also: [ChaintracksOptions](./services.md#interface-chaintracksoptions), [DefaultKnexChaintracksArguments](./services.md#type-defaultknexchaintracksarguments)

Argument Details

+ **rootFolder**
  + defaults to "./data/"

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: createDefaultNoDbChaintracksOptions

```ts
export function createDefaultNoDbChaintracksOptions(...args: DefaultChaintracksArguments): ChaintracksOptions
```

See also: [ChaintracksOptions](./services.md#interface-chaintracksoptions), [DefaultChaintracksArguments](./services.md#type-defaultchaintracksarguments)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: createDefaultWalletServicesOptions

```ts
export function createDefaultWalletServicesOptions(...[chain, arcCallbackUrl, arcCallbackToken, taalArcApiKey, gorillaPoolArcApiKey, bitailsApiKey, deploymentId, chaintracks, arcadeUrl, arcadeApiKey, arcadeCallbackToken]: [
    chain: Chain,
    arcCallbackUrl?: string,
    arcCallbackToken?: string,
    taalArcApiKey?: string,
    gorillaPoolArcApiKey?: string,
    bitailsApiKey?: string,
    deploymentId?: string,
    chaintracks?: ChaintracksClientApi,
    arcadeUrl?: string,
    arcadeApiKey?: string,
    arcadeCallbackToken?: string
]): WalletServicesOptions
```

See also: [Chain](./client.md#type-chain), [ChaintracksClientApi](./services.md#interface-chaintracksclientapi), [WalletServicesOptions](./client.md#interface-walletservicesoptions)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: createIdbChaintracks

```ts
export async function createIdbChaintracks(...args: DefaultChaintracksArguments): Promise<{
    chain: Chain;
    maxPerFile: number;
    fetch: ChaintracksFetchApi;
    storage: ChaintracksStorageIdb;
    chaintracks: Chaintracks;
    available: Promise<void>;
}>
```

See also: [Chain](./client.md#type-chain), [Chaintracks](./services.md#class-chaintracks), [ChaintracksFetchApi](./services.md#interface-chaintracksfetchapi), [ChaintracksStorageIdb](./services.md#class-chaintracksstorageidb), [DefaultChaintracksArguments](./services.md#type-defaultchaintracksarguments)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: createKnexChaintracks

```ts
export async function createKnexChaintracks(...args: DefaultKnexChaintracksArguments): Promise<{
    chain: Chain;
    maxPerFile: number;
    fetch: ChaintracksFetchApi;
    storage: ChaintracksStorageKnex;
    chaintracks: Chaintracks;
    available: Promise<void>;
}>
```

See also: [Chain](./client.md#type-chain), [Chaintracks](./services.md#class-chaintracks), [ChaintracksFetchApi](./services.md#interface-chaintracksfetchapi), [ChaintracksStorageKnex](./services.md#class-chaintracksstorageknex), [DefaultKnexChaintracksArguments](./services.md#type-defaultknexchaintracksarguments)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: createNoDbChaintracks

```ts
export async function createNoDbChaintracks(...args: DefaultChaintracksArguments): Promise<{
    chain: Chain;
    maxPerFile: number;
    fetch: ChaintracksFetchApi;
    storage: ChaintracksStorageNoDb;
    chaintracks: Chaintracks;
    available: Promise<void>;
}>
```

See also: [Chain](./client.md#type-chain), [Chaintracks](./services.md#class-chaintracks), [ChaintracksFetchApi](./services.md#interface-chaintracksfetchapi), [ChaintracksStorageNoDb](./services.md#class-chaintracksstoragenodb), [DefaultChaintracksArguments](./services.md#type-defaultchaintracksarguments)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: createStopHandler

```ts
export function createStopHandler(markOk: () => void, isOpen: () => boolean, markClosed: () => void, close: () => void, markDone: () => void): () => void
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: deserializeBaseBlockHeader

Deserialize a BaseBlockHeader from an 80 byte buffer

```ts
export function deserializeBaseBlockHeader(buffer: number[] | Uint8Array, offset = 0): BaseBlockHeader {
    validateByteWindow(buffer, offset, 80);
    const reader = Utils.ReaderUint8Array.makeReader(buffer, offset);
    const header: BaseBlockHeader = {
        version: reader.readUInt32LE(),
        previousHash: asString(reader.read(32).reverse()),
        merkleRoot: asString(reader.read(32).reverse()),
        time: reader.readUInt32LE(),
        bits: reader.readUInt32LE(),
        nonce: reader.readUInt32LE()
    };
    return header;
}
```

See also: [BaseBlockHeader](./client.md#interface-baseblockheader), [asString](./client.md#function-asstring), [readUInt32LE](./services.md#function-readuint32le)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: deserializeBaseBlockHeaders

```ts
export function deserializeBaseBlockHeaders(buffer: number[] | Uint8Array, offset = 0, count?: number | undefined): BaseBlockHeader[]
```

See also: [BaseBlockHeader](./client.md#interface-baseblockheader)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: deserializeBlockHeader

```ts
export function deserializeBlockHeader(buffer: number[] | Uint8Array, height: number, offset = 0): BlockHeader
```

See also: [BlockHeader](./client.md#interface-blockheader)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: deserializeBlockHeaders

```ts
export function deserializeBlockHeaders(firstHeight: number, buffer: number[] | Uint8Array, offset = 0, count?: number | undefined): BlockHeader[]
```

See also: [BlockHeader](./client.md#interface-blockheader)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: genesisBuffer

Returns the genesis block for the specified chain.

```ts
export function genesisBuffer(chain: Chain): number[] {
    return serializeBaseBlockHeader(genesisHeader(chain));
}
```

See also: [Chain](./client.md#type-chain), [genesisHeader](./services.md#function-genesisheader), [serializeBaseBlockHeader](./services.md#function-serializebaseblockheader)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: genesisHeader

Returns the genesis block for the specified chain.

```ts
export function genesisHeader(chain: Chain): BlockHeader {
    switch (chain) {
        case "main":
            return {
                version: 1,
                previousHash: "0000000000000000000000000000000000000000000000000000000000000000",
                merkleRoot: "4a5e1e4baab89f3a32518a88c31bc87f618f76673e2cc77ab2127b7afdeda33b",
                time: 1231006505,
                bits: 486604799,
                nonce: 2083236893,
                height: 0,
                hash: "000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f"
            };
        case "test":
            return {
                version: 1,
                previousHash: "0000000000000000000000000000000000000000000000000000000000000000",
                merkleRoot: "4a5e1e4baab89f3a32518a88c31bc87f618f76673e2cc77ab2127b7afdeda33b",
                time: 1296688602,
                bits: 486604799,
                nonce: 414098458,
                height: 0,
                hash: "000000000933ea01ad0ee984209779baaec3ced90fa3f408719526f8d77f4943"
            };
        case "stn":
            return {
                version: 1,
                previousHash: "0000000000000000000000000000000000000000000000000000000000000000",
                merkleRoot: "4a5e1e4baab89f3a32518a88c31bc87f618f76673e2cc77ab2127b7afdeda33b",
                time: 1296688602,
                bits: 486604799,
                nonce: 173779992,
                height: 0,
                hash: "6b38bdbcd73a19f7889d23e1fa6166a9de71affceca60ca3bb1b28af8135c594"
            };
        case "ttn":
            return {
                version: 1,
                previousHash: "0000000000000000000000000000000000000000000000000000000000000000",
                merkleRoot: "4a5e1e4baab89f3a32518a88c31bc87f618f76673e2cc77ab2127b7afdeda33b",
                time: 1755606836,
                bits: 486604799,
                nonce: 1092578460,
                height: 0,
                hash: "000000000499eabba0a88f5b3747231c74b9191c1a4a04b2c2ea817976b7776d"
            };
        case "tstn":
            return {
                version: 1,
                previousHash: "0000000000000000000000000000000000000000000000000000000000000000",
                merkleRoot: "64452e5b25c65e492ad6a4f5ce9f427ca986626c28315d88de920d66e28cc98f",
                time: 1782864000,
                bits: 486604799,
                nonce: 1780488216,
                height: 0,
                hash: "000000005d221c0e023cb56b5682cf094f32cd959958b40bc931e5797cae706c"
            };
        case "mock":
            throw new Error("genesisHeader does not support 'mock' chain. Mock chain generates its own genesis block.");
    }
}
```

See also: [BlockHeader](./client.md#interface-blockheader), [Chain](./client.md#type-chain)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: getBeefForTxid

```ts
export async function getBeefForTxid(services: Services, txid: string): Promise<Beef>
```

See also: [Services](./services.md#class-services)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: getExchangeRatesIo

```ts
export async function getExchangeRatesIo(key: string, symbols?: string[], fetchClient?: typeof fetch): Promise<ExchangeRatesIoApi>
```

See also: [ExchangeRatesIoApi](./services.md#interface-exchangeratesioapi)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: getWhatsOnChainBlockHeaderByHash

```ts
export async function getWhatsOnChainBlockHeaderByHash(hash: string, chain: Chain = "main", apiKey?: string): Promise<BlockHeader | undefined>
```

See also: [BlockHeader](./client.md#interface-blockheader), [Chain](./client.md#type-chain)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: handlePostRawTxErrorResponse

Classify an error-status WoC response and mutate `r` accordingly.

```ts
export function handlePostRawTxErrorResponse(r: PostTxResultForTxid, nne: () => Record<string, unknown>, response: {
    data?: unknown;
    statusText?: unknown;
    status?: unknown;
    ok?: boolean;
}): void
```

See also: [PostTxResultForTxid](./client.md#interface-posttxresultfortxid)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: handleScriptHashHistoryCatch

Decide whether a caught error is retryable for script-hash history calls.
If not retryable, sets `r.error` and returns false.

```ts
export function handleScriptHashHistoryCatch(r: GetScriptHashHistoryResult, error_: unknown, _url: string, methodName: string, retry: number, maxRetry: number): boolean
```

See also: [GetScriptHashHistoryResult](./client.md#interface-getscripthashhistoryresult)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: handleScriptHashHistoryResponse

Inspect a WoC script-hash history response and update `r` in-place.

Returns:
 - `'continue'`  — rate-limited, caller should retry
 - `'return'`    — done, caller should return `r`
 - `'ok'`        — response was successful, continue parsing

```ts
export function handleScriptHashHistoryResponse(r: GetScriptHashHistoryResult, response: ScriptHashHistoryResponse, methodName: string, retry: number): "continue" | "return" | "ok"
```

See also: [GetScriptHashHistoryResult](./client.md#interface-getscripthashhistoryresult), [ScriptHashHistoryResponse](./services.md#interface-scripthashhistoryresponse)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: handleUtxoConnReset

Decide whether the ECONNRESET error is retryable and, if not, set `r.error`.
Returns true when the caller should retry, false when it should return.

```ts
export function handleUtxoConnReset(r: GetUtxoStatusResult, error_: unknown, _url: string, retry: number, maxRetry: number): boolean
```

See also: [GetUtxoStatusResult](./client.md#interface-getutxostatusresult)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: isArcAcceptedTxStatus

```ts
export function isArcAcceptedTxStatus(txStatus: string | undefined): boolean
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: isArcDoubleSpendTxStatus

```ts
export function isArcDoubleSpendTxStatus(txStatus: string | undefined): boolean
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: isArcInvalidTxStatus

```ts
export function isArcInvalidTxStatus(txStatus: string | undefined): boolean
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: isArcServiceErrorStatus

```ts
export function isArcServiceErrorStatus(status: number | undefined, detail?: string): boolean
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: isBaseBlockHeader

Type guard function.

```ts
export function isBaseBlockHeader(header: AnyBlockHeader): header is BaseBlockHeader {
    const properties = dataProperties(header);
    return properties != null && hasBaseHeaderShape(properties);
}
```

See also: [AnyBlockHeader](./services.md#type-anyblockheader), [BaseBlockHeader](./client.md#interface-baseblockheader)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: isBlockHeader

Type guard function.

```ts
export function isBlockHeader(header: AnyBlockHeader): header is BlockHeader {
    const properties = dataProperties(header);
    return (properties != null &&
        hasBaseHeaderShape(properties) &&
        isHeight(valueOf(properties, "height")) &&
        isHash(valueOf(properties, "hash")));
}
```

See also: [AnyBlockHeader](./services.md#type-anyblockheader), [BlockHeader](./client.md#interface-blockheader)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: isKnownValidBulkHeaderFile

Compares meta data received for a bulk header file `vbf` to known
valid bulk header files based on their `fileHash`.

Short circuits both the retreival and validation of individual headers,
only a single SHA256 hash of the aggregate data needs to be compared.

The standard file size for historic block headers is 100,000 per file
which results in a many orders of magnitude initialization speedup.

The following properties must match:
- `firstHeight`
- `count`
- `prevChainWork`
- `prevHash`
- `lastChainWork`
- `lastHash`
- `chain`

```ts
export function isKnownValidBulkHeaderFile(vbf: BulkHeaderFileInfo): boolean {
    if (!vbf?.fileHash)
        return false;
    const bf = validBulkHeaderFilesByFileHash()[vbf.fileHash];
    if (bf?.firstHeight !== vbf.firstHeight ||
        bf?.count !== vbf.count ||
        bf?.prevChainWork !== vbf.prevChainWork ||
        bf?.prevHash !== vbf.prevHash ||
        bf?.lastChainWork !== vbf.lastChainWork ||
        bf?.lastHash !== vbf.lastHash ||
        bf?.chain !== vbf.chain) {
        return false;
    }
    return true;
}
```

See also: [BulkHeaderFileInfo](./services.md#interface-bulkheaderfileinfo), [validBulkHeaderFilesByFileHash](./services.md#function-validbulkheaderfilesbyfilehash)

Returns

true iff bulk file meta data (excluding its source) matches a known file.

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: isLive

Type guard function.

```ts
export function isLive(header: BlockHeader | LiveBlockHeader): header is LiveBlockHeader {
    return isLiveBlockHeader(header);
}
```

See also: [BlockHeader](./client.md#interface-blockheader), [LiveBlockHeader](./services.md#interface-liveblockheader), [isLiveBlockHeader](./services.md#function-isliveblockheader)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: isLiveBlockHeader

Type guard function.

```ts
export function isLiveBlockHeader(header: AnyBlockHeader): header is LiveBlockHeader {
    const properties = dataProperties(header);
    const headerId = properties == null ? undefined : valueOf(properties, "headerId");
    const previousHeaderId = properties == null ? undefined : valueOf(properties, "previousHeaderId");
    return (properties != null &&
        hasBaseHeaderShape(properties) &&
        isHeight(valueOf(properties, "height")) &&
        isHash(valueOf(properties, "hash")) &&
        isHash(valueOf(properties, "chainWork")) &&
        Number.isSafeInteger(headerId) &&
        (headerId as number) >= 1 &&
        (previousHeaderId === null || (Number.isSafeInteger(previousHeaderId) && (previousHeaderId as number) >= 1)) &&
        typeof valueOf(properties, "isActive") === "boolean" &&
        typeof valueOf(properties, "isChainTip") === "boolean");
}
```

See also: [AnyBlockHeader](./services.md#type-anyblockheader), [LiveBlockHeader](./services.md#interface-liveblockheader)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: isMoreWork

Returns true if work1 is more work (greater than) work2

```ts
export function isMoreWork(work1: string, work2: string): boolean
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: isValidFiatRate

```ts
export function isValidFiatRate(value: unknown): value is number
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: makeMerklePathNote

```ts
export function makeMerklePathNote(what: MerklePathNoteWhat, name: string, extra: Partial<MerklePathNote> = {}): MerklePathNote
```

See also: [MerklePathNote](./services.md#interface-merklepathnote), [MerklePathNoteWhat](./services.md#type-merklepathnotewhat)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: makePostBeefServiceError

```ts
export function makePostBeefServiceError(providerName: string, txids: string[], what: "postBeefServiceError" | "postBeefServiceTimeout", timeoutMs?: number): PostBeefResult
```

See also: [PostBeefResult](./client.md#interface-postbeefresult)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: mapWithConcurrency

```ts
export async function mapWithConcurrency<T, R>(values: T[], maxConcurrency: number, worker: (value: T, index: number) => Promise<R>): Promise<R[]>
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: normalizeArcProviderConfig

Snapshot security-relevant ARC/Arcade constructor configuration exactly once.

```ts
export function normalizeArcProviderConfig(config: string | ArcConfig | undefined, defaultDeploymentId: () => string): NormalizedArcProviderConfig
```

See also: [ArcConfig](./services.md#interface-arcconfig), [NormalizedArcProviderConfig](./services.md#interface-normalizedarcproviderconfig)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: normalizeBulkFileDataValidationRequest

Normalize and snapshot a complete validator request before asynchronous work.

```ts
export function normalizeBulkFileDataValidationRequest(request: unknown): BulkFileDataValidationRequest
```

See also: [BulkFileDataValidationRequest](./services.md#interface-bulkfiledatavalidationrequest)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: normalizeBulkHeaderFileInfo

```ts
export function normalizeBulkHeaderFileInfo(value: unknown, allowStoredBoolean = false): BulkHeaderFileInfo
```

See also: [BulkHeaderFileInfo](./services.md#interface-bulkheaderfileinfo)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: normalizeBulkHeaderFileSequence

```ts
export function normalizeBulkHeaderFileSequence(files: unknown, allowStoredBoolean = false): BulkHeaderFileInfo[]
```

See also: [BulkHeaderFileInfo](./services.md#interface-bulkheaderfileinfo)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: normalizeBulkHeaderFilesInfo

```ts
export function normalizeBulkHeaderFilesInfo(value: unknown): BulkHeaderFilesInfo
```

See also: [BulkHeaderFilesInfo](./services.md#interface-bulkheaderfilesinfo)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: normalizeFiatCurrencies

```ts
export function normalizeFiatCurrencies(value: unknown, extras: readonly FiatCurrencyCode[] = []): FiatCurrencyCode[]
```

See also: [FiatCurrencyCode](./client.md#type-fiatcurrencycode)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: normalizeFiatCurrency

```ts
export function normalizeFiatCurrency(value: unknown, name = "currency"): FiatCurrencyCode
```

See also: [FiatCurrencyCode](./client.md#type-fiatcurrencycode)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: normalizeFiatExchangeRates

```ts
export function normalizeFiatExchangeRates(value: unknown, required: readonly FiatCurrencyCode[], now = Date.now()): FiatExchangeRates
```

See also: [FiatCurrencyCode](./client.md#type-fiatcurrencycode), [FiatExchangeRates](./client.md#interface-fiatexchangerates)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: normalizeFiatRate

```ts
export function normalizeFiatRate(value: unknown, currency: string): number
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: normalizeFiatRateTimestamps

```ts
export function normalizeFiatRateTimestamps(value: unknown, now = Date.now()): Record<string, Date> | undefined
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: normalizeFiatTimestamp

```ts
export function normalizeFiatTimestamp(value: unknown, now = Date.now()): Date
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: normalizePostRawHex

```ts
export function normalizePostRawHex(value: unknown, maximumBytes: number, name = "rawTx"): string
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: normalizePostTxids

```ts
export function normalizePostTxids(value: unknown, name = "txids", allowEmpty = false): string[]
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: normalizeTxid

```ts
export function normalizeTxid(value: unknown, name = "txid"): string
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: normalizeWalletOutpoint

```ts
export function normalizeWalletOutpoint(value: unknown): string | undefined
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: parseFileLink

```ts
export function parseFileLink(file: string): {
    range: {
        fromHeight: number;
        toHeight: number;
    } | "latest";
    sourceUrl: string;
    fileName: string;
} | undefined
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: populateUtxoDetails

Populate UTXO details from a WoC result array

```ts
export function populateUtxoDetails(r: GetUtxoStatusResult, result: Array<{
    tx_hash: string;
    value: number;
    height: number;
    tx_pos: number;
}>, outpoint?: string): void
```

See also: [GetUtxoStatusResult](./client.md#interface-getutxostatusresult)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: publicArcadeUrl

Credential-free public Arcade host for supported networks.

```ts
export function publicArcadeUrl(chain: Chain): string | undefined
```

See also: [Chain](./client.md#type-chain)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: readUInt32BE

```ts
export function readUInt32BE(a: number[] | Uint8Array, offset: number): number
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: readUInt32LE

```ts
export function readUInt32LE(a: number[] | Uint8Array, offset: number): number
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: requireConclusiveUtxo

Convert an internal tri-state classification to the historical boolean
contract only when a provider supplied a conclusive answer.

```ts
export function requireConclusiveUtxo(classification: OutputUtxoClassification): boolean
```

See also: [OutputUtxoClassification](./services.md#interface-outpututxoclassification)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: resolveDefaultChaintracksArguments

```ts
export function resolveDefaultChaintracksArguments(args: DefaultChaintracksArguments): ResolvedDefaultChaintracksParams
```

See also: [DefaultChaintracksArguments](./services.md#type-defaultchaintracksarguments), [ResolvedDefaultChaintracksParams](./services.md#interface-resolveddefaultchaintracksparams)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: resolveDefaultKnexChaintracksArguments

```ts
export function resolveDefaultKnexChaintracksArguments(args: DefaultKnexChaintracksArguments): ResolvedDefaultKnexChaintracksParams
```

See also: [DefaultKnexChaintracksArguments](./services.md#type-defaultknexchaintracksarguments), [ResolvedDefaultKnexChaintracksParams](./services.md#interface-resolveddefaultknexchaintracksparams)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: safeDiagnostic

Convert an untrusted diagnostic to bounded, single-line text suitable for logs and status APIs.

```ts
export function safeDiagnostic(value: unknown, maximum = 512): string
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: selectBulkHeaderFiles

```ts
export function selectBulkHeaderFiles(files: BulkHeaderFileInfo[], chain: Chain, maxPerFile: number): BulkHeaderFileInfo[]
```

See also: [BulkHeaderFileInfo](./services.md#interface-bulkheaderfileinfo), [Chain](./client.md#type-chain)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: serializeBaseBlockHeader

Serializes a block header as an 80 byte Buffer.
The exact serialized format is defined in the Bitcoin White Paper
such that computing a double sha256 hash of the buffer computes
the block hash for the header.

```ts
export function serializeBaseBlockHeader(header: BaseBlockHeader, buffer?: number[], offset?: number): number[] {
    const validated = copyBaseHeaderData(header);
    validateBaseBlockHeaderFormat(validated);
    const writer = new Utils.Writer();
    writer.writeUInt32LE(validated.version);
    writer.write(asArray(validated.previousHash).reverse());
    writer.write(asArray(validated.merkleRoot).reverse());
    writer.writeUInt32LE(validated.time);
    writer.writeUInt32LE(validated.bits);
    writer.writeUInt32LE(validated.nonce);
    const data = writer.toArray();
    if (buffer != null) {
        if (!Array.isArray(buffer))
            throw new WERR_INVALID_PARAMETER("buffer", "an array");
        offset ??= 0;
        if (!Number.isSafeInteger(offset) || offset < 0 || offset + data.length > buffer.length) {
            throw new WERR_INVALID_PARAMETER("offset", "a non-negative safe integer with 80 writable bytes");
        }
        for (let i = 0; i < data.length; i++) {
            buffer[offset + i] = data[i];
        }
    }
    return data;
}
```

See also: [BaseBlockHeader](./client.md#interface-baseblockheader), [WERR_INVALID_PARAMETER](./client.md#class-werr_invalid_parameter), [asArray](./client.md#function-asarray), [validateBaseBlockHeaderFormat](./services.md#function-validatebaseblockheaderformat), [writeUInt32LE](./services.md#function-writeuint32le)

Returns

80 byte Buffer

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: serializeBaseBlockHeaders

```ts
export function serializeBaseBlockHeaders(headers: BlockHeader[]): Uint8Array
```

See also: [BlockHeader](./client.md#interface-blockheader)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: sha256HashOfBinaryFile

Computes sha256 hash of file contents read as bytes with no encoding.

```ts
export async function sha256HashOfBinaryFile(fs: ChaintracksFsApi, filepath: string, bufferSize = 80000): Promise<{
    hash: string;
    length: number;
}>
```

See also: [ChaintracksFsApi](./services.md#interface-chaintracksfsapi)

Returns

`{hash, length}` where `hash` is base64 string form of file hash and `length` is file length in bytes.

Argument Details

+ **filepath**
  + Full filepath to file.
+ **bufferSize**
  + Optional read buffer size to use. Defaults to 80,000 bytes. Currently ignored.

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: snapshotMerklePathResult

Snapshot the provider envelope before inspecting proof availability or
diagnostics. The optional legacy array mode is bounded for older custom
WalletServices implementations; ordinary providers return one path.

```ts
export function snapshotMerklePathResult(value: unknown, allowLegacyArray = false, providerName?: string): SnapshotMerklePathResult
```

See also: [SnapshotMerklePathResult](./services.md#interface-snapshotmerklepathresult)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: snapshotPostBeefRequest

```ts
export function snapshotPostBeefRequest(beef: Beef, txids: string[]): ValidatedPostBeefRequest
```

See also: [ValidatedPostBeefRequest](./services.md#interface-validatedpostbeefrequest)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: startChaintracks

```ts
export function startChaintracks<TStorage extends ChaintracksOptions["storage"]>(params: ResolvedDefaultChaintracksParams, options: ChaintracksOptions): CreatedChaintracks<TStorage>
```

See also: [ChaintracksOptions](./services.md#interface-chaintracksoptions), [CreatedChaintracks](./services.md#interface-createdchaintracks), [ResolvedDefaultChaintracksParams](./services.md#interface-resolveddefaultchaintracksparams)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: stnArcadeUrl

Arcade broadcaster / ARC endpoint for stn, or `undefined` when unset.

```ts
export function stnArcadeUrl(): string | undefined
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: stnChaintracksUrl

ChainTracks service URL for stn. Falls back to the configured Arcade host's
legacy-compatible path when STN_CHAINTRACKS_URL is unset.

```ts
export function stnChaintracksUrl(): string
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: subWork

Subtract Buffer encoded chainwork values

```ts
export function subWork(work1: string, work2: string): string
```

Returns

work1 - work2 as Buffer encoded chainWork value

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: swapByteOrder

Returns a copy of a Buffer with byte order reversed.

```ts
export function swapByteOrder(buffer: number[]): number[] {
    return buffer.slice().reverse();
}
```

Returns

new buffer with byte order reversed.

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: toBinaryBaseBlockHeader

Serializes a block header as an 80 byte array.
The exact serialized format is defined in the Bitcoin White Paper
such that computing a double sha256 hash of the array computes
the block hash for the header.

```ts
export function toBinaryBaseBlockHeader(header: BaseBlockHeader): number[] {
    const writer = new Utils.Writer();
    writer.writeUInt32LE(header.version);
    writer.writeReverse(asArray(header.previousHash));
    writer.writeReverse(asArray(header.merkleRoot));
    writer.writeUInt32LE(header.time);
    writer.writeUInt32LE(header.bits);
    writer.writeUInt32LE(header.nonce);
    const r = writer.toArray();
    return r;
}
```

See also: [BaseBlockHeader](./client.md#interface-baseblockheader), [asArray](./client.md#function-asarray), [writeUInt32LE](./services.md#function-writeuint32le)

Returns

80 byte array

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: toDefaultChaintracksArguments

```ts
export function toDefaultChaintracksArguments(params: ResolvedDefaultChaintracksParams): DefaultChaintracksArguments
```

See also: [DefaultChaintracksArguments](./services.md#type-defaultchaintracksarguments), [ResolvedDefaultChaintracksParams](./services.md#interface-resolveddefaultchaintracksparams)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: toDefaultKnexChaintracksArguments

```ts
export function toDefaultKnexChaintracksArguments(params: ResolvedDefaultKnexChaintracksParams): DefaultKnexChaintracksArguments
```

See also: [DefaultKnexChaintracksArguments](./services.md#type-defaultknexchaintracksarguments), [ResolvedDefaultKnexChaintracksParams](./services.md#interface-resolveddefaultknexchaintracksparams)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: tstnArcadeUrl

Arcade broadcaster / ARC endpoint for tstn, or `undefined` when `TSTN_ARCADE_URL` is unset.

```ts
export function tstnArcadeUrl(): string | undefined
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: tstnChaintracksUrl

ChainTracks service URL for tstn. Falls back to `${TSTN_ARCADE_URL}/chaintracks/v1` when
`TSTN_CHAINTRACKS_URL` is unset (mirrors the ttn layout). Throws when neither is configured.

```ts
export function tstnChaintracksUrl(): string
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: updateChaintracksFiatExchangeRates

```ts
export async function updateChaintracksFiatExchangeRates(targetCurrencies: string[], options: WalletServicesOptions): Promise<FiatExchangeRates>
```

See also: [FiatExchangeRates](./client.md#interface-fiatexchangerates), [WalletServicesOptions](./client.md#interface-walletservicesoptions)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: updateExchangeratesapi

```ts
export async function updateExchangeratesapi(targetCurrencies: string[], options: WalletServicesOptions): Promise<FiatExchangeRates>
```

See also: [FiatExchangeRates](./client.md#interface-fiatexchangerates), [WalletServicesOptions](./client.md#interface-walletservicesoptions)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: validBulkHeaderFilesByFileHash

Hash map of known valid bulk header files by their `fileHash`.

```ts
export function validBulkHeaderFilesByFileHash(): Record<string, BulkHeaderFileInfo>
```

See also: [BulkHeaderFileInfo](./services.md#interface-bulkheaderfileinfo)

Returns

object where keys are file hashes of known bulk header files.

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: validateAgainstDirtyHashes

Throws Error if blockHash is in the dirtyHashes list.

```ts
export function validateAgainstDirtyHashes(blockHash: string): void
```

See also: [blockHash](./services.md#function-blockhash)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: validateArcadeTxData

Validate and snapshot the untrusted Arcade `GET /tx/{txid}` response.

```ts
export function validateArcadeTxData(value: unknown, expectedTxid: string, responseStatus = 200): ArcMinerGetTxData
```

See also: [ArcMinerGetTxData](./services.md#interface-arcminergettxdata)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: validateBaseBlockHeaderFormat

Validates the exact data representation of an unpositioned 80-byte block
header before it reaches a chain lookup, queue, or serializer.

```ts
export function validateBaseBlockHeaderFormat(header: BaseBlockHeader): void
```

See also: [BaseBlockHeader](./client.md#interface-baseblockheader)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: validateBufferOfHeaders

Validate headers contained in an array of bytes. The headers must be consecutive block headers, 80 bytes long,
 where the hash of each header equals the previousHash of the following header.

```ts
export function validateBufferOfHeaders(buffer: Uint8Array, previousHash: string, offset = 0, count = -1, previousChainWork?: string): {
    lastHeaderHash: string;
    lastChainWork: string | undefined;
}
```

Returns

Header hash of last header validated or previousHash if there where none.

Argument Details

+ **buffer**
  + Buffer of headers to be validated.
+ **previousHash**
  + Expected previousHash of first header.
+ **offset**
  + Optional starting offset within `buffer`.
+ **count**
  + Optional number of headers to validate. Validates to end of buffer if missing.

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: validateBulkFileData

Validates the contents of a bulk header file.

```ts
export async function validateBulkFileData(bf: BulkHeaderFileInfo, prevHash: string, prevChainWork: string, fetch?: ChaintracksFetchApi): Promise<BulkHeaderFileInfo>
```

See also: [BulkHeaderFileInfo](./services.md#interface-bulkheaderfileinfo), [ChaintracksFetchApi](./services.md#interface-chaintracksfetchapi)

Returns

Validated BulkHeaderFileInfo with `validated` set to true.

Argument Details

+ **bf**
  + BulkHeaderFileInfo containing `data` to validate.
+ **prevHash**
  + Required previous header hash.
+ **prevChainWork**
  + Required previous chain work.
+ **fetch**
  + Optional ChaintracksFetchApi instance for fetching data.

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: validateGenesisHeader

Verifies that buffer begins with valid genesis block header for the specified chain.

```ts
export function validateGenesisHeader(buffer: Uint8Array, chain: Chain): void
```

See also: [Chain](./client.md#type-chain)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: validateHeaderDifficulty

Ensures that a header has a valid proof-of-work target and hash.

```ts
export function validateHeaderDifficulty(hash: number[] | Uint8Array, bits: number)
```

Returns

true if the header is valid

Argument Details

+ **header**
  + The header to validate

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: validateHeaderFormat

```ts
export function validateHeaderFormat(header: BlockHeader): void
```

See also: [BlockHeader](./client.md#interface-blockheader)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: validateHeaderProofOfWork

Ensures that a structured header's computed hash satisfies its declared
proof-of-work target.

```ts
export function validateHeaderProofOfWork(header: BlockHeader): true {
    validateConsensusProofOfWork(header.hash, header.bits);
    return true;
}
```

See also: [BlockHeader](./client.md#interface-blockheader)

Returns

true if the header has valid proof-of-work.

Argument Details

+ **header**
  + Header whose format and hash have already been checked.

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: validateMerklePathResult

```ts
export function validateMerklePathResult(requestedTxid: unknown, result: GetMerklePathResult, requireProofOfWork = false, requireHeaderFormat = true): ValidatedMerklePathResult
```

See also: [GetMerklePathResult](./client.md#interface-getmerklepathresult), [ValidatedMerklePathResult](./services.md#interface-validatedmerklepathresult)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: validatePostBeefResult

```ts
export function validatePostBeefResult(value: unknown, expectedTxids: string[], configuredProviderName: string, allowInternalTimeoutNote = false): PostBeefResult
```

See also: [PostBeefResult](./client.md#interface-postbeefresult)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: validatePostBeefResultOrServiceError

```ts
export function validatePostBeefResultOrServiceError(value: unknown, expectedTxids: string[], configuredProviderName: string): PostBeefResult
```

See also: [PostBeefResult](./client.md#interface-postbeefresult)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: validatePostTxResult

```ts
export function validatePostTxResult(value: unknown, expectedTxid: string, configuredProviderName: string): PostTxResultForTxid
```

See also: [PostTxResultForTxid](./client.md#interface-posttxresultfortxid)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: validatePostTxResultOrServiceError

```ts
export function validatePostTxResultOrServiceError(value: unknown, expectedTxid: string, configuredProviderName: string): PostTxResultForTxid
```

See also: [PostTxResultForTxid](./client.md#interface-posttxresultfortxid)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: validateRawTxResult

Snapshot and bind a raw-transaction provider result to its requested txid.

```ts
export function validateRawTxResult(value: unknown, expectedTxid: string, providerName?: string): GetRawTxResult
```

See also: [GetRawTxResult](./client.md#interface-getrawtxresult)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: validateScriptHash

```ts
export function validateScriptHash(output: string, outputFormat?: GetUtxoStatusOutputFormat): string
```

See also: [GetUtxoStatusOutputFormat](./client.md#type-getutxostatusoutputformat)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: validateScriptHashHistoryResult

Validate and own a script-history result before it contributes competing transaction IDs.

```ts
export function validateScriptHashHistoryResult(value: unknown, configuredProviderName?: string): GetScriptHashHistoryResult
```

See also: [GetScriptHashHistoryResult](./client.md#interface-getscripthashhistoryresult)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: validateStatusForTxidsResult

Copy and validate an external transaction-status provider response before it
can influence wallet transaction state. Provider names may be replaced with
a locally configured name so remote data cannot forge durable attribution.

```ts
export function validateStatusForTxidsResult(value: unknown, requestedTxids: readonly string[], providerName?: string): GetStatusForTxidsResult
```

See also: [GetStatusForTxidsResult](./client.md#interface-getstatusfortxidsresult)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: validateUtxoStatusResult

Validate, bind, and own a UTXO-oracle result before wallet state uses it.

```ts
export function validateUtxoStatusResult(value: unknown, expectedOutpoint?: string, configuredProviderName?: string): GetUtxoStatusResult
```

See also: [GetUtxoStatusResult](./client.md#interface-getutxostatusresult)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: validateWocChainInfo

```ts
export function validateWocChainInfo(value: unknown, expectedChain: Chain): WocChainInfo
```

See also: [Chain](./client.md#type-chain), [WocChainInfo](./services.md#interface-wocchaininfo)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: wocGetHeadersHeaderToBlockHeader

```ts
export function wocGetHeadersHeaderToBlockHeader(h: WocGetHeadersHeader): BlockHeader
```

See also: [BlockHeader](./client.md#interface-blockheader), [WocGetHeadersHeader](./services.md#interface-wocgetheadersheader)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: workBNtoBuffer

```ts
export function workBNtoBuffer(work: BigNumber): string
```

Returns

Converted chainWork value from BN to hex string of 32 bytes.

Argument Details

+ **work**
  + chainWork as a BigNumber

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: writeUInt32BE

```ts
export function writeUInt32BE(n: number, a: number[] | Uint8Array, offset: number): number
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: writeUInt32LE

```ts
export function writeUInt32LE(n: number, a: number[] | Uint8Array, offset: number): number
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
#### Types

| | |
| --- | --- |
| [AnyBlockHeader](#type-anyblockheader) | [InsertHeaderResult](#type-insertheaderresult) |
| [ChaintracksArgumentsTail](#type-chaintracksargumentstail) | [LocalChainTrackerConsistency](#type-localchaintrackerconsistency) |
| [DefaultChaintracksArguments](#type-defaultchaintracksarguments) | [LocalChainTrackerMode](#type-localchaintrackermode) |
| [DefaultKnexChaintracksArguments](#type-defaultknexchaintracksarguments) | [MerklePathNoteWhat](#type-merklepathnotewhat) |
| [EnqueueHandler](#type-enqueuehandler) | [OutputUtxoVerdict](#type-outpututxoverdict) |
| [ErrorHandler](#type-errorhandler) | [ReorgListener](#type-reorglistener) |
| [HeaderListener](#type-headerlistener) |  |

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---

##### Type: AnyBlockHeader

Union of all block header variants

```ts
export type AnyBlockHeader = BaseBlockHeader | BlockHeader | LiveBlockHeader
```

See also: [BaseBlockHeader](./client.md#interface-baseblockheader), [BlockHeader](./client.md#interface-blockheader), [LiveBlockHeader](./services.md#interface-liveblockheader)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Type: ChaintracksArgumentsTail

```ts
export type ChaintracksArgumentsTail = [
    whatsonchainApiKey?: string,
    maxPerFile?: number,
    maxRetained?: number,
    fetch?: ChaintracksFetchApi,
    cdnUrl?: string,
    liveHeightThreshold?: number,
    reorgHeightThreshold?: number,
    bulkMigrationChunkSize?: number,
    batchInsertLimit?: number,
    addLiveRecursionLimit?: number,
    sources?: ChaintracksSourceOptions
]
```

See also: [ChaintracksFetchApi](./services.md#interface-chaintracksfetchapi), [ChaintracksSourceOptions](./services.md#interface-chaintrackssourceoptions)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Type: DefaultChaintracksArguments

```ts
export type DefaultChaintracksArguments = [
    chain: Chain,
    ...options: ChaintracksArgumentsTail
]
```

See also: [Chain](./client.md#type-chain), [ChaintracksArgumentsTail](./services.md#type-chaintracksargumentstail)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Type: DefaultKnexChaintracksArguments

```ts
export type DefaultKnexChaintracksArguments = [
    chain: Chain,
    rootFolder?: string,
    knexConfig?: Knex.Config,
    ...options: ChaintracksArgumentsTail
]
```

See also: [Chain](./client.md#type-chain), [ChaintracksArgumentsTail](./services.md#type-chaintracksargumentstail)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Type: EnqueueHandler

```ts
export type EnqueueHandler = (header: BlockHeader) => void
```

See also: [BlockHeader](./client.md#interface-blockheader)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Type: ErrorHandler

return true to ignore error, false to close service connection

```ts
export type ErrorHandler = (code: number, message: string) => boolean
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Type: HeaderListener

```ts
export type HeaderListener = (header: BlockHeader) => void
```

See also: [BlockHeader](./client.md#interface-blockheader)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Type: InsertHeaderResult

```ts
export type InsertHeaderResult = {
    added: boolean;
    dupe: boolean;
    isActiveTip: boolean;
    reorgDepth: number;
    priorTip: LiveBlockHeader | undefined;
    deactivatedHeaders: LiveBlockHeader[];
    noPrev: boolean;
    badPrev: boolean;
    noActiveAncestor: boolean;
    noTip: boolean;
}
```

See also: [LiveBlockHeader](./services.md#interface-liveblockheader)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Type: LocalChainTrackerConsistency

```ts
export type LocalChainTrackerConsistency = "unchecked" | "agreed" | "lagging" | "diverged" | "insufficient-references" | "error"
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Type: LocalChainTrackerMode

```ts
export type LocalChainTrackerMode = "local-primary" | "remote-only"
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Type: MerklePathNoteWhat

```ts
export type MerklePathNoteWhat = "getMerklePathRetry" | "getMerklePathNotFound" | "getMerklePathBadStatus" | "getMerklePathNoData" | "getMerklePathSuccess" | "getMerklePathNoHeader" | "getMerklePathError" | "getMerklePathInternal"
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Type: OutputUtxoVerdict

```ts
export type OutputUtxoVerdict = "unspent" | "spent" | "unknown"
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Type: ReorgListener

```ts
export type ReorgListener = (depth: number, oldTip: BlockHeader, newTip: BlockHeader, deactivatedHeaders?: BlockHeader[]) => void
```

See also: [BlockHeader](./client.md#interface-blockheader)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
#### Variables

| | |
| --- | --- |
| [ARCADE_POST_BEEF_CONCURRENCY](#variable-arcade_post_beef_concurrency) | [MAX_RAW_TRANSACTION_BYTES](#variable-max_raw_transaction_bytes) |
| [ChaintracksFs](#variable-chaintracksfs) | [MAX_SCRIPT_HASH_HISTORY_ITEMS](#variable-max_script_hash_history_items) |
| [MAX_FIAT_FUTURE_SKEW_MS](#variable-max_fiat_future_skew_ms) | [MAX_UTXO_STATUS_DETAILS](#variable-max_utxo_status_details) |
| [MAX_FIAT_RATE](#variable-max_fiat_rate) | [UTXO_PROVIDER_MAX_CONCURRENCY](#variable-utxo_provider_max_concurrency) |
| [MAX_FIAT_RESPONSE_RATES](#variable-max_fiat_response_rates) | [dirtyHashes](#variable-dirtyhashes) |
| [MAX_POST_BEEF_BYTES](#variable-max_post_beef_bytes) | [validBulkHeaderFiles](#variable-validbulkheaderfiles) |
| [MAX_POST_BEEF_TXIDS](#variable-max_post_beef_txids) |  |

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---

##### Variable: ARCADE_POST_BEEF_CONCURRENCY

```ts
ARCADE_POST_BEEF_CONCURRENCY = 4
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Variable: ChaintracksFs

```ts
ChaintracksFs: ChaintracksFsApi = ChaintracksFsStatics
```

See also: [ChaintracksFsApi](./services.md#interface-chaintracksfsapi), [ChaintracksFsStatics](./services.md#class-chaintracksfsstatics)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Variable: MAX_FIAT_FUTURE_SKEW_MS

```ts
MAX_FIAT_FUTURE_SKEW_MS = 5 * 60 * 1000
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Variable: MAX_FIAT_RATE

```ts
MAX_FIAT_RATE = 1000000000000000
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Variable: MAX_FIAT_RESPONSE_RATES

```ts
MAX_FIAT_RESPONSE_RATES = 256
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Variable: MAX_POST_BEEF_BYTES

```ts
MAX_POST_BEEF_BYTES = 64 * 1024 * 1024
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Variable: MAX_POST_BEEF_TXIDS

```ts
MAX_POST_BEEF_TXIDS = Validation.MAXIMUM_SEND_WITH_TRANSACTIONS
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Variable: MAX_RAW_TRANSACTION_BYTES

```ts
MAX_RAW_TRANSACTION_BYTES = 32 * 1024 * 1024
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Variable: MAX_SCRIPT_HASH_HISTORY_ITEMS

```ts
MAX_SCRIPT_HASH_HISTORY_ITEMS = 4096
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Variable: MAX_UTXO_STATUS_DETAILS

```ts
MAX_UTXO_STATUS_DETAILS = 4096
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Variable: UTXO_PROVIDER_MAX_CONCURRENCY

```ts
UTXO_PROVIDER_MAX_CONCURRENCY = 4
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Variable: dirtyHashes

```ts
dirtyHashes = {
    "00000000000000000019f112ec0a9982926f1258cdcc558dd7c3b7e5dc7fa148": "This is the first header of the invalid SegWit chain.",
    "0000000000000000004626ff6e3b936941d341c5932ece4357eeccac44e6d56c": "This is the first header of the invalid ABC chain."
}
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Variable: validBulkHeaderFiles

```ts
validBulkHeaderFiles: BulkHeaderFileInfo[] = [
    {
        sourceUrl: "https://cdn.projectbabbage.com/blockheaders",
        fileName: "testNet_0.headers",
        firstHeight: 0,
        prevHash: "0000000000000000000000000000000000000000000000000000000000000000",
        count: 100000,
        lastHash: "000000004956cc2edd1a8caa05eacfa3c69f4c490bfc9ace820257834115ab35",
        fileHash: "gAJPUfI2DfAabJTOBxT1rwy1cS4/QULaQHaQWa1RWNk=",
        lastChainWork: "000000000000000000000000000000000000000000000000004143c00b3d47b8",
        prevChainWork: "0000000000000000000000000000000000000000000000000000000000000000",
        chain: "test",
        validated: true
    },
    {
        sourceUrl: "https://cdn.projectbabbage.com/blockheaders",
        fileName: "testNet_1.headers",
        firstHeight: 100000,
        prevHash: "000000004956cc2edd1a8caa05eacfa3c69f4c490bfc9ace820257834115ab35",
        count: 100000,
        lastHash: "0000000000c470c4a573272aa4a680c93fc4c2f5df8ce9546441796f73277334",
        fileHash: "OIJ010bnIbFobNppJzCNE9jFI1uANz0iNGvqpoG2xq4=",
        lastChainWork: "00000000000000000000000000000000000000000000000004504f3a4e71aa13",
        prevChainWork: "000000000000000000000000000000000000000000000000004143c00b3d47b8",
        chain: "test",
        validated: true
    },
    {
        sourceUrl: "https://cdn.projectbabbage.com/blockheaders",
        fileName: "testNet_2.headers",
        firstHeight: 200000,
        prevHash: "0000000000c470c4a573272aa4a680c93fc4c2f5df8ce9546441796f73277334",
        count: 100000,
        lastHash: "00000000dfe970844d1bf983d0745f709368b5c66224837a17ed633f0dabd300",
        fileHash: "hZXE3im7V4tE0oROWM2mGB9xPXEcpVLRIYUPaYT3VV0=",
        lastChainWork: "00000000000000000000000000000000000000000000000062378b066f9fba96",
        prevChainWork: "00000000000000000000000000000000000000000000000004504f3a4e71aa13",
        chain: "test",
        validated: true
    },
    {
        sourceUrl: "https://cdn.projectbabbage.com/blockheaders",
        fileName: "testNet_3.headers",
        firstHeight: 300000,
        prevHash: "00000000dfe970844d1bf983d0745f709368b5c66224837a17ed633f0dabd300",
        count: 100000,
        lastHash: "0000000001127c76ac45f605f9300dfa96a8054533b96413883fdc4378aeb42d",
        fileHash: "BGZxsk/Ooa4BOaoBEMOor+B8wL9ghW5A0We2G2fmyLE=",
        lastChainWork: "0000000000000000000000000000000000000000000000040da9d61d8e129a53",
        prevChainWork: "00000000000000000000000000000000000000000000000062378b066f9fba96",
        chain: "test",
        validated: true
    },
    {
        sourceUrl: "https://cdn.projectbabbage.com/blockheaders",
        fileName: "testNet_4.headers",
        firstHeight: 400000,
        prevHash: "0000000001127c76ac45f605f9300dfa96a8054533b96413883fdc4378aeb42d",
        count: 100000,
        lastHash: "0000000001965655a870175b510326e6393114d293896ddb237709eecb381ab8",
        fileHash: "3DjOpFnatZ0OKrpACATfAtBITX2s8JjfYTAnDHVkGuw=",
        lastChainWork: "00000000000000000000000000000000000000000000000461063a8389300d36",
        prevChainWork: "0000000000000000000000000000000000000000000000040da9d61d8e129a53",
        chain: "test",
        validated: true
    },
    {
        sourceUrl: "https://cdn.projectbabbage.com/blockheaders",
        fileName: "testNet_5.headers",
        firstHeight: 500000,
        prevHash: "0000000001965655a870175b510326e6393114d293896ddb237709eecb381ab8",
        count: 100000,
        lastHash: "000000000000bb1644b4d9a643b165a52b3ffba077f2a12b8bd1f0a6b6cc0fbc",
        fileHash: "wF008GqnZzAYsOwnmyFzIOmrJthHE3bq6oUg1FvHG1Y=",
        lastChainWork: "0000000000000000000000000000000000000000000000067a8291cfec0aa549",
        prevChainWork: "00000000000000000000000000000000000000000000000461063a8389300d36",
        chain: "test",
        validated: true
    },
    {
        sourceUrl: "https://cdn.projectbabbage.com/blockheaders",
        fileName: "testNet_6.headers",
        firstHeight: 600000,
        prevHash: "000000000000bb1644b4d9a643b165a52b3ffba077f2a12b8bd1f0a6b6cc0fbc",
        count: 100000,
        lastHash: "0000000000003e784511e93aca014ecaa6d4ba3637cf373f4b84dcac7c70cca0",
        fileHash: "uc7IW6NRXXtX3oGWwOYjtetTaZ+1zhvijNEwPbK+rAs=",
        lastChainWork: "0000000000000000000000000000000000000000000000078286c7f42f7ec693",
        prevChainWork: "0000000000000000000000000000000000000000000000067a8291cfec0aa549",
        chain: "test",
        validated: true
    },
    {
        sourceUrl: "https://cdn.projectbabbage.com/blockheaders",
        fileName: "testNet_7.headers",
        firstHeight: 700000,
        prevHash: "0000000000003e784511e93aca014ecaa6d4ba3637cf373f4b84dcac7c70cca0",
        count: 100000,
        lastHash: "0000000000068f8658ff71cbf8f5b31c837cc6df5bf53e40f05459d4267b53e6",
        fileHash: "yfomaIGZyoW/m7YdpZYNozeNrUmJBwaF0PpLdSADWJE=",
        lastChainWork: "00000000000000000000000000000000000000000000000a551ea869597d2a74",
        prevChainWork: "0000000000000000000000000000000000000000000000078286c7f42f7ec693",
        chain: "test",
        validated: true
    },
    {
        sourceUrl: "https://cdn.projectbabbage.com/blockheaders",
        fileName: "testNet_8.headers",
        firstHeight: 800000,
        prevHash: "0000000000068f8658ff71cbf8f5b31c837cc6df5bf53e40f05459d4267b53e6",
        count: 100000,
        lastHash: "0000000000214fbb71abe4695d935b8e089d306899c4a90124b1bc6806e6e299",
        fileHash: "/AIS2PYHdMJBmRF9ECsZmCphoqhDyFWs+aO+3GIpPhg=",
        lastChainWork: "00000000000000000000000000000000000000000000000eb93c12a85efec237",
        prevChainWork: "00000000000000000000000000000000000000000000000a551ea869597d2a74",
        chain: "test",
        validated: true
    },
    {
        sourceUrl: "https://cdn.projectbabbage.com/blockheaders",
        fileName: "testNet_9.headers",
        firstHeight: 900000,
        prevHash: "0000000000214fbb71abe4695d935b8e089d306899c4a90124b1bc6806e6e299",
        count: 100000,
        lastHash: "00000000002208a5fee5b9baa4b5519d2cd8ab405754fca13704dc667448f21a",
        fileHash: "lJtRGLYlMnHe6r0xuJJWauJA7DKL4ZYOqkYmUD2iwbM=",
        lastChainWork: "000000000000000000000000000000000000000000000017e96a5ada9f4a8bfb",
        prevChainWork: "00000000000000000000000000000000000000000000000eb93c12a85efec237",
        chain: "test",
        validated: true
    },
    {
        sourceUrl: "https://cdn.projectbabbage.com/blockheaders",
        fileName: "testNet_10.headers",
        firstHeight: 1000000,
        prevHash: "00000000002208a5fee5b9baa4b5519d2cd8ab405754fca13704dc667448f21a",
        count: 100000,
        lastHash: "000000000005bc8878ba47a47129c3e21f32f8c10b9658f9ee6db16a83870162",
        fileHash: "tfWVFoIp4A6yXd2c0YietQ7hYlmLf7O884baego+D4E=",
        lastChainWork: "000000000000000000000000000000000000000000000021bf46518c698a4bc8",
        prevChainWork: "000000000000000000000000000000000000000000000017e96a5ada9f4a8bfb",
        chain: "test",
        validated: true
    },
    {
        sourceUrl: "https://cdn.projectbabbage.com/blockheaders",
        fileName: "testNet_11.headers",
        firstHeight: 1100000,
        prevHash: "000000000005bc8878ba47a47129c3e21f32f8c10b9658f9ee6db16a83870162",
        count: 100000,
        lastHash: "00000000f8bf61018ddd77d23c112e874682704a290252f635e7df06c8a317b8",
        fileHash: "S0Y9WXGFFJLRsRkQRNvrtImOezjReEQ1eDdB2x5M6Mw=",
        lastChainWork: "0000000000000000000000000000000000000000000000288b285ca9b1bb8065",
        prevChainWork: "000000000000000000000000000000000000000000000021bf46518c698a4bc8",
        chain: "test",
        validated: true
    },
    {
        sourceUrl: "https://cdn.projectbabbage.com/blockheaders",
        fileName: "testNet_12.headers",
        firstHeight: 1200000,
        prevHash: "00000000f8bf61018ddd77d23c112e874682704a290252f635e7df06c8a317b8",
        count: 100000,
        lastHash: "0000000000000165e6678be46ec2b15c587611b86da7147f7069a0e7175d62da",
        fileHash: "eFHQB8EaSfs4EKZxVsLhX8UA79kpOI4dR6j/z9P8frI=",
        lastChainWork: "0000000000000000000000000000000000000000000000542144c6af6e9258ea",
        prevChainWork: "0000000000000000000000000000000000000000000000288b285ca9b1bb8065",
        chain: "test",
        validated: true
    },
    {
        sourceUrl: "https://cdn.projectbabbage.com/blockheaders",
        fileName: "testNet_13.headers",
        firstHeight: 1300000,
        prevHash: "0000000000000165e6678be46ec2b15c587611b86da7147f7069a0e7175d62da",
        count: 100000,
        lastHash: "00000000000002ef0a47d0f242ab280bded8f4780bad506c71f2e1d2771becd4",
        fileHash: "2MFJLBjHOBnuaDAICQFCL3y+6ejj0k92gbcmLWa1/Xc=",
        lastChainWork: "0000000000000000000000000000000000000000000000dcc85f546d353f7b08",
        prevChainWork: "0000000000000000000000000000000000000000000000542144c6af6e9258ea",
        chain: "test",
        validated: true
    },
    {
        sourceUrl: "https://cdn.projectbabbage.com/blockheaders",
        fileName: "testNet_14.headers",
        firstHeight: 1400000,
        prevHash: "00000000000002ef0a47d0f242ab280bded8f4780bad506c71f2e1d2771becd4",
        count: 100000,
        lastHash: "0000000000000168de8736c8a424fd5ebe1dcf0a030ed5fa0699b8c0fafc0b5e",
        fileHash: "lWmP/pOR5ciEnu5tjIrf7OTEaiaMcfqFZQQYT7QH6qg=",
        lastChainWork: "00000000000000000000000000000000000000000000011bed7ab81a56a65cbc",
        prevChainWork: "0000000000000000000000000000000000000000000000dcc85f546d353f7b08",
        chain: "test",
        validated: true
    },
    {
        sourceUrl: "https://cdn.projectbabbage.com/blockheaders",
        fileName: "testNet_15.headers",
        firstHeight: 1500000,
        prevHash: "0000000000000168de8736c8a424fd5ebe1dcf0a030ed5fa0699b8c0fafc0b5e",
        count: 100000,
        lastHash: "00000000000005504bfd1a3ce4688c30c86740390102b6cd464a2fb5e0e3fed1",
        fileHash: "1bCf0R0RsoadANX+6H4NH1b3jNuTPyTayoS1SpQXa2Q=",
        lastChainWork: "000000000000000000000000000000000000000000000156c3b84396da4e60b9",
        prevChainWork: "00000000000000000000000000000000000000000000011bed7ab81a56a65cbc",
        chain: "test",
        validated: true
    },
    {
        chain: "test",
        count: 100000,
        fileHash: "qPjPA41mUU0ieEqud/JO95Agqq8XgzbzS5FLnHIRyPA=",
        fileName: "testNet_16.headers",
        firstHeight: 1600000,
        lastChainWork: "00000000000000000000000000000000000000000000015814b9c82dabd4ea74",
        lastHash: "000000000001561e0532f48401f822f5c0d8797e364b1d612a317eca6983ca36",
        prevChainWork: "000000000000000000000000000000000000000000000156c3b84396da4e60b9",
        prevHash: "00000000000005504bfd1a3ce4688c30c86740390102b6cd464a2fb5e0e3fed1",
        sourceUrl: "https://cdn.projectbabbage.com/blockheaders",
        validated: true
    },
    {
        chain: "test",
        count: 28130,
        fileHash: "2DNTS2vBk4ddDzVz5MbFfRtxuze4FN4wrtKfaxbfC98=",
        fileName: "testNet_17.headers",
        firstHeight: 1700000,
        lastChainWork: "0000000000000000000000000000000000000000000001581bdf712d6fabd4da",
        lastHash: "0000000072d02bc85e05ff155357fbbde7fe80057c4f9354fe5535147de00687",
        prevChainWork: "00000000000000000000000000000000000000000000015814b9c82dabd4ea74",
        prevHash: "000000000001561e0532f48401f822f5c0d8797e364b1d612a317eca6983ca36",
        sourceUrl: "https://cdn.projectbabbage.com/blockheaders"
    },
    {
        sourceUrl: "https://cdn.projectbabbage.com/blockheaders",
        fileName: "mainNet_0.headers",
        firstHeight: 0,
        prevHash: "0000000000000000000000000000000000000000000000000000000000000000",
        count: 100000,
        lastHash: "000000000002d01c1fccc21636b607dfd930d31d01c3a62104612a1719011250",
        fileHash: "DMXYETHMphmYRh5y0+qsJhj67ML5Ui4LE1eEZDYbnZE=",
        lastChainWork: "000000000000000000000000000000000000000000000000064492eaf00f2520",
        prevChainWork: "0000000000000000000000000000000000000000000000000000000000000000",
        chain: "main",
        validated: true
    },
    {
        sourceUrl: "https://cdn.projectbabbage.com/blockheaders",
        fileName: "mainNet_1.headers",
        firstHeight: 100000,
        prevHash: "000000000002d01c1fccc21636b607dfd930d31d01c3a62104612a1719011250",
        count: 100000,
        lastHash: "00000000000003a20def7a05a77361b9657ff954b2f2080e135ea6f5970da215",
        fileHash: "IID8O84Uny22i10fWHTQr6f9+9eFZ8dhVyegYPGSg+Q=",
        lastChainWork: "00000000000000000000000000000000000000000000001ac0479f335782cb80",
        prevChainWork: "000000000000000000000000000000000000000000000000064492eaf00f2520",
        chain: "main",
        validated: true
    },
    {
        sourceUrl: "https://cdn.projectbabbage.com/blockheaders",
        fileName: "mainNet_2.headers",
        firstHeight: 200000,
        prevHash: "00000000000003a20def7a05a77361b9657ff954b2f2080e135ea6f5970da215",
        count: 100000,
        lastHash: "000000000000000067ecc744b5ae34eebbde14d21ca4db51652e4d67e155f07e",
        fileHash: "wbfV/ZuPvLKHtRJN4QlHiKlpNncuqWA1dMJ6O9mhisc=",
        lastChainWork: "000000000000000000000000000000000000000000005a795f5d6ede10bc6d60",
        prevChainWork: "00000000000000000000000000000000000000000000001ac0479f335782cb80",
        chain: "main",
        validated: true
    },
    {
        sourceUrl: "https://cdn.projectbabbage.com/blockheaders",
        fileName: "mainNet_3.headers",
        firstHeight: 300000,
        prevHash: "000000000000000067ecc744b5ae34eebbde14d21ca4db51652e4d67e155f07e",
        count: 100000,
        lastHash: "0000000000000000030034b661aed920a9bdf6bbfa6d2e7a021f78481882fa39",
        fileHash: "5pklz64as2MG6y9lQiiClZaA82f6xoK1xdzkSqOZLsA=",
        lastChainWork: "0000000000000000000000000000000000000000001229fea679a4cdc26e7460",
        prevChainWork: "000000000000000000000000000000000000000000005a795f5d6ede10bc6d60",
        chain: "main",
        validated: true
    },
    {
        sourceUrl: "https://cdn.projectbabbage.com/blockheaders",
        fileName: "mainNet_4.headers",
        firstHeight: 400000,
        prevHash: "0000000000000000030034b661aed920a9bdf6bbfa6d2e7a021f78481882fa39",
        count: 100000,
        lastHash: "0000000000000000043831d6ebb013716f0580287ee5e5687e27d0ed72e6e523",
        fileHash: "2X78/S+Z/h5ELA63aC3xt6/o4G8JMcAOEiZ00ycKHsM=",
        lastChainWork: "0000000000000000000000000000000000000000007ae4707601d47bc6695487",
        prevChainWork: "0000000000000000000000000000000000000000001229fea679a4cdc26e7460",
        chain: "main",
        validated: true
    },
    {
        sourceUrl: "https://cdn.projectbabbage.com/blockheaders",
        fileName: "mainNet_5.headers",
        firstHeight: 500000,
        prevHash: "0000000000000000043831d6ebb013716f0580287ee5e5687e27d0ed72e6e523",
        count: 100000,
        lastHash: "0000000000000000078f57b9a986b53b73f007c6b27b6f16409ca4eda83034e8",
        fileHash: "Tzm60n66tIuq7wNdP6M1BH77iFzGCPbOMIl6smJ/LRg=",
        lastChainWork: "000000000000000000000000000000000000000000e8f2ea21f069a214067ed7",
        prevChainWork: "0000000000000000000000000000000000000000007ae4707601d47bc6695487",
        chain: "main",
        validated: true
    },
    {
        sourceUrl: "https://cdn.projectbabbage.com/blockheaders",
        fileName: "mainNet_6.headers",
        firstHeight: 600000,
        prevHash: "0000000000000000078f57b9a986b53b73f007c6b27b6f16409ca4eda83034e8",
        count: 100000,
        lastHash: "000000000000000013abf3ab026610ed70e023476db8ce96f68637acdcbcf3cb",
        fileHash: "O7SoyIDxhejB0Qs4rBO4OkfBK2yVZKhxra6YxZMhiIk=",
        lastChainWork: "0000000000000000000000000000000000000000012f32fb33b26aa239be0fc3",
        prevChainWork: "000000000000000000000000000000000000000000e8f2ea21f069a214067ed7",
        chain: "main",
        validated: true
    },
    {
        sourceUrl: "https://cdn.projectbabbage.com/blockheaders",
        fileName: "mainNet_7.headers",
        firstHeight: 700000,
        prevHash: "000000000000000013abf3ab026610ed70e023476db8ce96f68637acdcbcf3cb",
        count: 100000,
        lastHash: "00000000000000000b6ae23bbe9f549844c20943d8c20b8ceedbae8aa1dde8e0",
        fileHash: "+0Wu2GrKgCv4o1yZfdWl60aAgvBj6Rt3xlWj8TQprUw=",
        lastChainWork: "000000000000000000000000000000000000000001483b2995af390c20b58320",
        prevChainWork: "0000000000000000000000000000000000000000012f32fb33b26aa239be0fc3",
        chain: "main",
        validated: true
    },
    {
        chain: "main",
        count: 100000,
        fileHash: "xKYCsMzfbWdwq6RtEos4+4w7F3FroFMXb4tk4Z2gn5s=",
        fileName: "mainNet_8.headers",
        firstHeight: 800000,
        lastChainWork: "000000000000000000000000000000000000000001664db1f2d50327928007e0",
        lastHash: "00000000000000000e7dcc27c06ee353bd37260b2e7e664314c204f0324a5087",
        prevChainWork: "000000000000000000000000000000000000000001483b2995af390c20b58320",
        prevHash: "00000000000000000b6ae23bbe9f549844c20943d8c20b8ceedbae8aa1dde8e0",
        sourceUrl: "https://cdn.projectbabbage.com/blockheaders",
        validated: true
    },
    {
        chain: "main",
        count: 42761,
        fileHash: "iWZR7qvenqLKHANygKBBnikqmiW8GCoVCN7zjVXwgwY=",
        fileName: "mainNet_9.headers",
        firstHeight: 900000,
        lastChainWork: "0000000000000000000000000000000000000000016bf64e6fb83417f3b94c86",
        lastHash: "0000000000000000108a6b142072acf8a781d5fcdd1c9a637d2194ad6b9c09dc",
        prevChainWork: "000000000000000000000000000000000000000001664db1f2d50327928007e0",
        prevHash: "00000000000000000e7dcc27c06ee353bd37260b2e7e664314c204f0324a5087",
        sourceUrl: "https://cdn.projectbabbage.com/blockheaders"
    }
]
```

See also: [BulkHeaderFileInfo](./services.md#interface-bulkheaderfileinfo)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---

<!--#endregion ts2md-api-merged-here-->
