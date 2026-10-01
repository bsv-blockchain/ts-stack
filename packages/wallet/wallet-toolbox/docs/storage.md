# STORAGE: BSV Wallet Toolbox API Documentation

The documentation is split into various pages, this page covers the persistent storage of wallet data: transactions, outputs and metadata.

The [WalletStorageManager](#class-walletstoragemanager) class manages a collection of storage providers of which one is the "active" storage
at any one time, and the rest are backups. It manages access to wallet data, pushing incremental updates to backups, and switching the active
to what was previously a backup.

The [StorageClient](#class-storageclient) implements a cloud based storage provider via JSON-RPC. The [StorageServer](#class-storageserver) class
and `@bsv/wallet-infra` package can be used to host such a JSON-RPC server.

The [StorageKnex](#class-storageknex) class implements `Knex` based database storage with explicit support for both MySQL and SQLite.

[Return To Top](./README.md)

<!--#region ts2md-api-merged-here-->
### API

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

#### Interfaces

| | | |
| --- | --- | --- |
| [AdminStatsLike](#interface-adminstatslike) | [PostReqsToNetworkResult](#interface-postreqstonetworkresult) | [TableActionBatchOutput](#interface-tableactionbatchoutput) |
| [AdminStatsResult](#interface-adminstatsresult) | [PreparedBeefLookupResult](#interface-preparedbeeflookupresult) | [TableAuthSession](#interface-tableauthsession) |
| [AdminUtxoReviewRequest](#interface-adminutxoreviewrequest) | [PreparedBeefOptions](#interface-preparedbeefoptions) | [TableCertificate](#interface-tablecertificate) |
| [AdminUtxoReviewStorage](#interface-adminutxoreviewstorage) | [PreparedBeefPolicy](#interface-preparedbeefpolicy) | [TableCertificateField](#interface-tablecertificatefield) |
| [AdminUtxoReviewTask](#interface-adminutxoreviewtask) | [PreparedBeefPreparation](#interface-preparedbeefpreparation) | [TableCertificateX](#interface-tablecertificatex) |
| [AggregatePostBeefTxResult](#interface-aggregatepostbeeftxresult) | [PreparedBeefRoot](#interface-preparedbeefroot) | [TableCommission](#interface-tablecommission) |
| [CanonicalFundingCandidate](#interface-canonicalfundingcandidate) | [PreparedBeefStorage](#interface-preparedbeefstorage) | [TableMonitorEvent](#interface-tablemonitorevent) |
| [CommitNewTxResults](#interface-commitnewtxresults) | [ProvenTxFromTxidResult](#interface-proventxfromtxidresult) | [TableOutput](#interface-tableoutput) |
| [CorsPolicyOptions](#interface-corspolicyoptions) | [ProvenTxReqHistory](#interface-proventxreqhistory) | [TableOutputBasket](#interface-tableoutputbasket) |
| [EntitySyncMap](#interface-entitysyncmap) | [ProvenTxReqHistorySummaryApi](#interface-proventxreqhistorysummaryapi) | [TableOutputTag](#interface-tableoutputtag) |
| [FailedInputReconciliationResult](#interface-failedinputreconciliationresult) | [ProvenTxReqNotify](#interface-proventxreqnotify) | [TableOutputTagMap](#interface-tableoutputtagmap) |
| [GenerateChangeSdkChangeInput](#interface-generatechangesdkchangeinput) | [ResourceProfileValues](#interface-resourceprofilevalues) | [TableOutputX](#interface-tableoutputx) |
| [GenerateChangeSdkChangeOutput](#interface-generatechangesdkchangeoutput) | [ReviewUtxoOutputsResult](#interface-reviewutxooutputsresult) | [TablePreparedBeef](#interface-tablepreparedbeef) |
| [GenerateChangeSdkInput](#interface-generatechangesdkinput) | [SecurityHeadersOptions](#interface-securityheadersoptions) | [TableProvenTx](#interface-tableproventx) |
| [GenerateChangeSdkOutput](#interface-generatechangesdkoutput) | [SpentInputTransition](#interface-spentinputtransition) | [TableProvenTxReq](#interface-tableproventxreq) |
| [GenerateChangeSdkParams](#interface-generatechangesdkparams) | [StorageAdminStats](#interface-storageadminstats) | [TableProvenTxReqDynamics](#interface-tableproventxreqdynamics) |
| [GenerateChangeSdkResult](#interface-generatechangesdkresult) | [StorageClientOptions](#interface-storageclientoptions) | [TableSettings](#interface-tablesettings) |
| [GenerateChangeSdkStorageChange](#interface-generatechangesdkstoragechange) | [StorageIdbOptions](#interface-storageidboptions) | [TableSyncState](#interface-tablesyncstate) |
| [GetReqsAndBeefDetail](#interface-getreqsandbeefdetail) | [StorageIdbSchema](#interface-storageidbschema) | [TableTransaction](#interface-tabletransaction) |
| [GetReqsAndBeefResult](#interface-getreqsandbeefresult) | [StorageKnexOptions](#interface-storageknexoptions) | [TableTxLabel](#interface-tabletxlabel) |
| [HttpServerPolicyDefaults](#interface-httpserverpolicydefaults) | [StorageProviderOptions](#interface-storageprovideroptions) | [TableTxLabelMap](#interface-tabletxlabelmap) |
| [KnexSessionManagerOptions](#interface-knexsessionmanageroptions) | [StorageReaderOptions](#interface-storagereaderoptions) | [TableUser](#interface-tableuser) |
| [ListActionsSpecOp](#interface-listactionsspecop) | [StorageReaderWriterOptions](#interface-storagereaderwriteroptions) | [UtxoReviewClassification](#interface-utxoreviewclassification) |
| [ListOutputsSpecOp](#interface-listoutputsspecop) | [SyncError](#interface-syncerror) | [UtxoReviewDiagnostics](#interface-utxoreviewdiagnostics) |
| [ManagedChangeBasketDefaults](#interface-managedchangebasketdefaults) | [SyncMap](#interface-syncmap) | [ValidateGenerateChangeSdkParamsResult](#interface-validategeneratechangesdkparamsresult) |
| [ManagedChangePolicy](#interface-managedchangepolicy) | [SyncProofValidationStorage](#interface-syncproofvalidationstorage) | [ValidatedBatchAction](#interface-validatedbatchaction) |
| [MonitorAdminContext](#interface-monitoradmincontext) | [SyncTransferCapabilities](#interface-synctransfercapabilities) | [VerifyAndRepairBeefResult](#interface-verifyandrepairbeefresult) |
| [MonitorAdminContextConfig](#interface-monitoradmincontextconfig) | [SyncTransferManifest](#interface-synctransfermanifest) | [WalletStorageServerOptions](#interface-walletstorageserveroptions) |
| [NoSendExpiryLifecycleResult](#interface-nosendexpirylifecycleresult) | [SyncTransferPart](#interface-synctransferpart) | [XValidCreateActionInput](#interface-xvalidcreateactioninput) |
| [PostBeefResultForTxidApi](#interface-postbeefresultfortxidapi) | [TableActionBatch](#interface-tableactionbatch) | [XValidCreateActionOutput](#interface-xvalidcreateactionoutput) |
| [PostReqsToNetworkDetails](#interface-postreqstonetworkdetails) | [TableActionBatchBlob](#interface-tableactionbatchblob) |  |

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---

##### Interface: AdminStatsLike

```ts
export interface AdminStatsLike {
    requestedBy?: unknown;
    when?: unknown;
    usersDay?: unknown;
    usersWeek?: unknown;
    usersMonth?: unknown;
    usersTotal?: unknown;
    satoshisDefaultDay?: unknown;
    satoshisDefaultWeek?: unknown;
    satoshisDefaultMonth?: unknown;
    satoshisDefaultTotal?: unknown;
    satoshisOtherDay?: unknown;
    satoshisOtherWeek?: unknown;
    satoshisOtherMonth?: unknown;
    satoshisOtherTotal?: unknown;
    labelsDay?: unknown;
    labelsWeek?: unknown;
    labelsMonth?: unknown;
    labelsTotal?: unknown;
    tagsDay?: unknown;
    tagsWeek?: unknown;
    tagsMonth?: unknown;
    tagsTotal?: unknown;
    basketsDay?: unknown;
    basketsWeek?: unknown;
    basketsMonth?: unknown;
    basketsTotal?: unknown;
    transactionsDay?: unknown;
    transactionsWeek?: unknown;
    transactionsMonth?: unknown;
    transactionsTotal?: unknown;
    txCompletedDay?: unknown;
    txCompletedWeek?: unknown;
    txCompletedMonth?: unknown;
    txCompletedTotal?: unknown;
    txFailedDay?: unknown;
    txFailedWeek?: unknown;
    txFailedMonth?: unknown;
    txFailedTotal?: unknown;
    txAbandonedDay?: unknown;
    txAbandonedWeek?: unknown;
    txAbandonedMonth?: unknown;
    txAbandonedTotal?: unknown;
    txNosendDay?: unknown;
    txNosendWeek?: unknown;
    txNosendMonth?: unknown;
    txNosendTotal?: unknown;
    txUnprovenDay?: unknown;
    txUnprovenWeek?: unknown;
    txUnprovenMonth?: unknown;
    txUnprovenTotal?: unknown;
    txSendingDay?: unknown;
    txSendingWeek?: unknown;
    txSendingMonth?: unknown;
    txSendingTotal?: unknown;
    txUnprocessedDay?: unknown;
    txUnprocessedWeek?: unknown;
    txUnprocessedMonth?: unknown;
    txUnprocessedTotal?: unknown;
    txUnsignedDay?: unknown;
    txUnsignedWeek?: unknown;
    txUnsignedMonth?: unknown;
    txUnsignedTotal?: unknown;
    txNonfinalDay?: unknown;
    txNonfinalWeek?: unknown;
    txNonfinalMonth?: unknown;
    txNonfinalTotal?: unknown;
    txUnfailDay?: unknown;
    txUnfailWeek?: unknown;
    txUnfailMonth?: unknown;
    txUnfailTotal?: unknown;
}
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: AdminStatsResult

```ts
export interface AdminStatsResult extends StorageAdminStats {
    servicesStats?: ServicesCallHistory;
    monitorStats?: ServicesCallHistory;
}
```

See also: [ServicesCallHistory](./client.md#interface-servicescallhistory), [StorageAdminStats](./storage.md#interface-storageadminstats)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: AdminUtxoReviewRequest

```ts
export interface AdminUtxoReviewRequest {
    storage: AdminUtxoReviewStorage;
    task: AdminUtxoReviewTask;
    requestedBy: string;
    identityKey: string;
    mode: "all" | "change";
    release: boolean;
    pageLimit: number;
    offset: number;
}
```

See also: [AdminUtxoReviewStorage](./storage.md#interface-adminutxoreviewstorage), [AdminUtxoReviewTask](./storage.md#interface-adminutxoreviewtask)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: AdminUtxoReviewStorage

```ts
export interface AdminUtxoReviewStorage {
    insertMonitorEvent: (event: TableMonitorEvent) => Promise<number>;
}
```

See also: [TableMonitorEvent](./storage.md#interface-tablemonitorevent)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: AdminUtxoReviewTask

```ts
export interface AdminUtxoReviewTask {
    reviewPageByIdentityKey: (identityKey: string, mode: "all" | "change", release: boolean, pageLimit: number, offset: number) => Promise<TaskReviewUtxosPageResult>;
}
```

See also: [TaskReviewUtxosPageResult](./monitor.md#interface-taskreviewutxospageresult)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: AggregatePostBeefTxResult

```ts
export interface AggregatePostBeefTxResult {
    txid: string;
    txidResults: sdk.PostTxResultForTxid[];
    status: AggregateStatus;
    vreq: PostReqsToNetworkDetails;
    successCount: number;
    doubleSpendCount: number;
    statusErrorCount: number;
    serviceErrorCount: number;
    competingTxs: string[];
}
```

See also: [PostReqsToNetworkDetails](./storage.md#interface-postreqstonetworkdetails), [PostTxResultForTxid](./client.md#interface-posttxresultfortxid)

###### Property competingTxs

Any competing double spend txids reported for this txid

```ts
competingTxs: string[]
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: CanonicalFundingCandidate

```ts
export interface CanonicalFundingCandidate {
    outputId: number;
    satoshis: number;
}
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: CommitNewTxResults

```ts
export interface CommitNewTxResults {
    req: EntityProvenTxReq;
    log?: string;
}
```

See also: [EntityProvenTxReq](./storage.md#class-entityproventxreq)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: CorsPolicyOptions

```ts
export interface CorsPolicyOptions {
    environmentPrefix: string;
    methods: string[];
    allowedOrigins?: string[];
    defaultMode?: CorsMode;
    allowedHeaders?: string[];
    exposedHeaders?: string[];
    allowCredentials?: boolean;
    maxAgeSeconds?: number;
}
```

See also: [CorsMode](./storage.md#type-corsmode)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: EntitySyncMap

```ts
export interface EntitySyncMap {
    entityName: string;
    idMap: Record<number, number>;
    maxUpdated_at?: Date;
    count: number;
}
```

###### Property count

The cummulative count of items of this entity type received over all the `SyncChunk`s
since the `since` was last updated.

This is the `offset` value to use for the next SyncChunk request.

```ts
count: number
```

###### Property idMap

Maps foreign ids to local ids
Some entities don't have idMaps (CertificateField, TxLabelMap and OutputTagMap)

```ts
idMap: Record<number, number>
```

###### Property maxUpdated_at

the maximum updated_at value seen for this entity over chunks received
during this udpate cycle.

```ts
maxUpdated_at?: Date
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: FailedInputReconciliationResult

```ts
export interface FailedInputReconciliationResult {
    checked: number;
    staleConfirmed: number;
    staleOutpoints: string[];
}
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: GenerateChangeSdkChangeInput

```ts
export interface GenerateChangeSdkChangeInput {
    outputId: number;
    satoshis: number;
}
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: GenerateChangeSdkChangeOutput

```ts
export interface GenerateChangeSdkChangeOutput {
    satoshis: number;
    lockingScriptLength: number;
}
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: GenerateChangeSdkInput

```ts
export interface GenerateChangeSdkInput {
    satoshis: number;
    unlockingScriptLength: number;
}
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: GenerateChangeSdkOutput

```ts
export interface GenerateChangeSdkOutput {
    satoshis: number;
    lockingScriptLength: number;
}
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: GenerateChangeSdkParams

```ts
export interface GenerateChangeSdkParams {
    fixedInputs: GenerateChangeSdkInput[];
    fixedOutputs: GenerateChangeSdkOutput[];
    feeModel: StorageFeeModel;
    targetNetCount?: number;
    changeInitialSatoshis: number;
    changeFirstSatoshis: number;
    changeLockingScriptLength: number;
    changeUnlockingScriptLength: number;
    maxChangeOutputs?: number;
    surplusPoolShaping?: boolean;
    maxMigrationInputs?: number;
    randomVals?: number[];
    noLogging?: boolean;
    log?: string;
}
```

See also: [GenerateChangeSdkInput](./storage.md#interface-generatechangesdkinput), [GenerateChangeSdkOutput](./storage.md#interface-generatechangesdkoutput), [StorageFeeModel](./client.md#interface-storagefeemodel)

###### Property changeFirstSatoshis

Lowest amount value to assign to a change output.
Drop the output if unable to satisfy.
default 285

```ts
changeFirstSatoshis: number
```

###### Property changeInitialSatoshis

Satoshi amount to initialize optional new change outputs.

```ts
changeInitialSatoshis: number
```

###### Property changeLockingScriptLength

Fixed change locking script length.

For P2PKH template, 25 bytes

```ts
changeLockingScriptLength: number
```

###### Property changeUnlockingScriptLength

Fixed change unlocking script length.

For P2PKH template, 107 bytes

```ts
changeUnlockingScriptLength: number
```

###### Property maxChangeOutputs

Maximum number of change outputs to create in this transaction.
Defaults to `maxChangeOutputsPerTransaction` (8). Set to -1 only when an
operator deliberately wants the basket target to be the sole bound.

Callers may override this to allow more outputs in special cases (e.g.
consolidation transactions) or fewer outputs when a compact transaction
is preferred.

```ts
maxChangeOutputs?: number
```

###### Property maxMigrationInputs

Soft bound on undersized, fee-positive inputs consumed after compulsory
funding to migrate an old wallet gradually. Set to -1 for an intentionally
unbounded migration pass. Ignored unless surplusPoolShaping is true.

```ts
maxMigrationInputs?: number
```

###### Property surplusPoolShaping

When true, targetNetCount shapes only genuine post-funding surplus. The
planner will not add inputs merely to reach the desired pool count.

```ts
surplusPoolShaping?: boolean
```

###### Property targetNetCount

Target for number of new change outputs added minus number of funding change outputs consumed.
If undefined, only a single change output will be added if excess fees must be recaptured.

```ts
targetNetCount?: number
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: GenerateChangeSdkResult

```ts
export interface GenerateChangeSdkResult {
    allocatedChangeInputs: GenerateChangeSdkChangeInput[];
    changeOutputs: GenerateChangeSdkChangeOutput[];
    size: number;
    fee: number;
    satsPerKb: number;
    maxPossibleSatoshisAdjustment?: {
        fixedOutputIndex: number;
        satoshis: number;
    };
}
```

See also: [GenerateChangeSdkChangeInput](./storage.md#interface-generatechangesdkchangeinput), [GenerateChangeSdkChangeOutput](./storage.md#interface-generatechangesdkchangeoutput)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: GenerateChangeSdkStorageChange

```ts
export interface GenerateChangeSdkStorageChange extends GenerateChangeSdkChangeInput {
    spendable: boolean;
}
```

See also: [GenerateChangeSdkChangeInput](./storage.md#interface-generatechangesdkchangeinput)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: GetReqsAndBeefDetail

```ts
export interface GetReqsAndBeefDetail {
    txid: string;
    req?: TableProvenTxReq;
    proven?: TableProvenTx;
    status: "readyToSend" | "alreadySent" | "error" | "unknown";
    error?: string;
}
```

See also: [TableProvenTx](./storage.md#interface-tableproventx), [TableProvenTxReq](./storage.md#interface-tableproventxreq)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: GetReqsAndBeefResult

```ts
export interface GetReqsAndBeefResult {
    beef: Beef;
    details: GetReqsAndBeefDetail[];
    verified?: boolean;
}
```

See also: [GetReqsAndBeefDetail](./storage.md#interface-getreqsandbeefdetail)

###### Property verified

Internal fast path: this exact BEEF instance already passed validation.

```ts
verified?: boolean
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: HttpServerPolicyDefaults

```ts
export interface HttpServerPolicyDefaults {
    requestTimeoutMs: number;
    headersTimeoutMs: number;
    keepAliveTimeoutMs: number;
    socketTimeoutMs: number;
    maxRequestsPerSocket: number;
    maxConnections?: number;
}
```

###### Property maxConnections

Open TCP/WebSocket connections retained by one process. Default: 1,000.

```ts
maxConnections?: number
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: KnexSessionManagerOptions

```ts
export interface KnexSessionManagerOptions {
    ttlMs?: number;
    touchIntervalMs?: number;
    maxMessageNoncesPerSession?: number;
    now?: () => number;
}
```

###### Property maxMessageNoncesPerSession

Maximum one-time signed message nonces retained per active session.

```ts
maxMessageNoncesPerSession?: number
```

###### Property now

Testable clock source. Defaults to `Date.now`.

```ts
now?: () => number
```

###### Property touchIntervalMs

Maximum time that an authenticated, timestamp-only session update may be
coalesced. Authentication and certificate state changes are always written
immediately. Default: 1 minute (or one quarter of ttlMs when shorter).

```ts
touchIntervalMs?: number
```

###### Property ttlMs

Session lifetime since its most recent authenticated use. Default: 24 hours.

```ts
ttlMs?: number
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: ListActionsSpecOp

```ts
export interface ListActionsSpecOp {
    name: string;
    labelsToIntercept?: string[];
    setStatusFilter?: () => TransactionStatus[];
    postProcess?: (s: StorageProvider, auth: AuthId, vargs: Validation.ValidListActionsArgs, specOpLabels: string[], txs: Array<Partial<TableTransaction>>) => Promise<void>;
}
```

See also: [AuthId](./client.md#interface-authid), [StorageProvider](./storage.md#class-storageprovider), [TableTransaction](./storage.md#interface-tabletransaction), [TransactionStatus](./client.md#type-transactionstatus)

###### Property labelsToIntercept

undefined to intercept no labels from vargs,
empty array to intercept all labels,
or an explicit array of labels to intercept.

```ts
labelsToIntercept?: string[]
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: ListOutputsSpecOp

```ts
export interface ListOutputsSpecOp {
    name: string;
    useBasket?: string;
    ignoreLimit?: boolean;
    maximumCandidateCount?: number;
    includeOutputScripts?: boolean;
    includeSpent?: boolean;
    totalOutputsIsSumOfSatoshis?: boolean;
    managedChangeOnly?: boolean;
    resultFromTags?: (s: StorageProvider, auth: AuthId, vargs: Validation.ValidListOutputsArgs, specOpTags: string[]) => Promise<ListOutputsResult>;
    resultFromOutputs?: (s: StorageProvider, auth: AuthId, vargs: Validation.ValidListOutputsArgs, specOpTags: string[], outputs: TableOutput[]) => Promise<ListOutputsResult>;
    filterOutputs?: (s: StorageProvider, auth: AuthId, vargs: Validation.ValidListOutputsArgs, specOpTags: string[], outputs: TableOutput[]) => Promise<TableOutput[]>;
    tagsToIntercept?: string[];
    tagsParamsCount?: number;
}
```

See also: [AuthId](./client.md#interface-authid), [StorageProvider](./storage.md#class-storageprovider), [TableOutput](./storage.md#interface-tableoutput)

###### Property managedChangeOnly

Restrict the operation to wallet-managed, BRC-29-signable change.

```ts
managedChangeOnly?: boolean
```

###### Property maximumCandidateCount

Hard ceiling applied even when this operation intentionally ignores caller paging.

```ts
maximumCandidateCount?: number
```

###### Property tagsParamsCount

How many positional tags to intercept.

```ts
tagsParamsCount?: number
```

###### Property tagsToIntercept

undefined to intercept no tags from vargs,
empty array to intercept all tags,
or an explicit array of tags to intercept.

```ts
tagsToIntercept?: string[]
```

###### Property totalOutputsIsSumOfSatoshis

If true, and supported by storage, maximum performance optimization, computing balance done in the query itself.

```ts
totalOutputsIsSumOfSatoshis?: boolean
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: ManagedChangeBasketDefaults

```ts
export interface ManagedChangeBasketDefaults {
    name: string;
    numberOfDesiredUTXOs: number;
    minimumDesiredUTXOValue: number;
}
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: ManagedChangePolicy

```ts
export interface ManagedChangePolicy {
    maxOutputsPerAction: number;
    migrationInputsPerAction: number;
    pendingComparisonInputs: number;
}
```

###### Property maxOutputsPerAction

Maximum change outputs created by one action while growing the pool; -1 is unlimited.

```ts
maxOutputsPerAction: number
```

###### Property migrationInputsPerAction

Maximum undersized, fee-positive inputs consumed only to improve the pool; -1 is unlimited.

```ts
migrationInputsPerAction: number
```

###### Property pendingComparisonInputs

A completed-only plan above this input count is compared with pending
alternatives using exact BEEF bytes. This is a comparison trigger, never
a funding limit. -1 disables pending comparison until settled funding is
actually insufficient.

```ts
pendingComparisonInputs: number
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: MonitorAdminContext

```ts
export interface MonitorAdminContext {
    config: MonitorAdminContextConfig;
    daemon: MonitorDaemon;
    authWallet?: Wallet;
}
```

See also: [MonitorAdminContextConfig](./storage.md#interface-monitoradmincontextconfig), [MonitorDaemon](./monitor.md#class-monitordaemon), [Wallet](./client.md#class-wallet)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: MonitorAdminContextConfig

```ts
export interface MonitorAdminContextConfig {
    chain: sdk.Chain;
    adminPort?: number;
    adminHost: string;
    adminIdentityKeys: string[];
    adminAllowedOrigins?: string[];
    adminSecurityHeaders?: SecurityHeadersOptions;
}
```

See also: [Chain](./client.md#type-chain), [SecurityHeadersOptions](./storage.md#interface-securityheadersoptions)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: NoSendExpiryLifecycleResult

```ts
export interface NoSendExpiryLifecycleResult {
    inspected: number;
    cancelled: number;
    observed: number;
    reclaimActivated: number;
    reclaimRetried: number;
    reclaimed: number;
    targetWon: number;
    deferred: number;
    errors: number;
}
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: PostBeefResultForTxidApi

```ts
export interface PostBeefResultForTxidApi {
    txid: string;
    status: "success" | "error";
    alreadyKnown?: boolean;
    blockHash?: string;
    blockHeight?: number;
    merklePath?: string;
}
```

See also: [blockHash](./services.md#function-blockhash)

###### Property alreadyKnown

if true, the transaction was already known to this service. Usually treat as a success.

Potentially stop posting to additional transaction processors.

```ts
alreadyKnown?: boolean
```

###### Property status

'success' - The transaction was accepted for processing

```ts
status: "success" | "error"
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: PostReqsToNetworkDetails

```ts
export interface PostReqsToNetworkDetails {
    txid: string;
    req: EntityProvenTxReq;
    status: PostReqsToNetworkDetailsStatus;
    competingTxs?: string[];
}
```

See also: [EntityProvenTxReq](./storage.md#class-entityproventxreq), [PostReqsToNetworkDetailsStatus](./storage.md#type-postreqstonetworkdetailsstatus)

###### Property competingTxs

Any competing double spend txids reported for this txid

```ts
competingTxs?: string[]
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: PostReqsToNetworkResult

```ts
export interface PostReqsToNetworkResult {
    status: "success" | "error";
    beef: Beef;
    details: PostReqsToNetworkDetails[];
    log: string;
}
```

See also: [PostReqsToNetworkDetails](./storage.md#interface-postreqstonetworkdetails)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: PreparedBeefLookupResult

```ts
export interface PreparedBeefLookupResult {
    beef: Beef;
    hitTxids: string[];
    missingTxids: string[];
    corruptCount: number;
    byteLength: number;
}
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: PreparedBeefOptions

```ts
export interface PreparedBeefOptions {
    readEnabled?: boolean;
    writeEnabled?: boolean;
    backfillEnabled?: boolean;
    maxQueueSize?: number;
    maxQueueSizePerUser?: number;
    maxArtifactBytes?: number;
    maxLookupBytes?: number;
    maxArtifactTransactions?: number;
    backfillBatchSize?: number;
    backfillIntervalMs?: number;
}
```

###### Property backfillBatchSize

Maximum roots selected by each low-priority backfill pass.

```ts
backfillBatchSize?: number
```

###### Property backfillEnabled

Gradually prepare existing eligible managed-change roots. Default false.

```ts
backfillEnabled?: boolean
```

###### Property backfillIntervalMs

Delay between backfill passes.

```ts
backfillIntervalMs?: number
```

###### Property maxArtifactBytes

Reject a prepared artifact larger than this many bytes.

```ts
maxArtifactBytes?: number
```

###### Property maxArtifactTransactions

Reject source or prepared BEEF graphs with more transactions.

```ts
maxArtifactTransactions?: number
```

###### Property maxLookupBytes

Bypass prepared lookup when all matching artifacts exceed this total.

```ts
maxLookupBytes?: number
```

###### Property maxQueueSize

Maximum queued roots. New background work is dropped when full.

```ts
maxQueueSize?: number
```

###### Property maxQueueSizePerUser

Maximum queued or running roots for one user.

```ts
maxQueueSizePerUser?: number
```

###### Property readEnabled

Read prepared artifacts on the createAction proof path. Default false.

```ts
readEnabled?: boolean
```

###### Property writeEnabled

Prepare and persist artifacts after foreground work completes. Default false.

```ts
writeEnabled?: boolean
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: PreparedBeefPolicy

```ts
export interface PreparedBeefPolicy {
    readEnabled: boolean;
    writeEnabled: boolean;
    backfillEnabled: boolean;
    maxQueueSize: number;
    maxQueueSizePerUser: number;
    maxArtifactBytes: number;
    maxLookupBytes: number;
    maxArtifactTransactions: number;
    backfillBatchSize: number;
    backfillIntervalMs: number;
}
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: PreparedBeefPreparation

```ts
export interface PreparedBeefPreparation {
    userId: number;
    rootTxids: string[];
}
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: PreparedBeefRoot

```ts
export interface PreparedBeefRoot {
    userId: number;
    rootTxid: string;
}
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: PreparedBeefStorage

Knex-owned extension used without adding server cache code to portable providers.

```ts
export interface PreparedBeefStorage extends Pick<StorageProvider, "telemetry" | "getBeefForTransaction" | "getServices"> {
    readonly preparedBeefPolicy: PreparedBeefPolicy;
    preparedBeefReadsEnabled?: () => boolean;
    findPreparedBeefs: (userId: number, rootTxids: string[]) => Promise<TablePreparedBeef[]>;
    readPreparedBeefLookupByteLength: (userId: number, rootTxids: string[]) => Promise<number>;
    readPreparedBeefProofEpoch: () => Promise<number>;
    readPreparedBeefSourceByteLength: (rootTxid: string) => Promise<number | undefined>;
    upsertPreparedBeef: (artifact: TablePreparedBeef, expectedProofEpoch: number) => Promise<boolean>;
    findPreparedBeefBackfillRoots: (limit: number, formatVersion: number) => Promise<PreparedBeefRoot[]>;
}
```

See also: [PreparedBeefPolicy](./storage.md#interface-preparedbeefpolicy), [PreparedBeefRoot](./storage.md#interface-preparedbeefroot), [StorageProvider](./storage.md#class-storageprovider), [TablePreparedBeef](./storage.md#interface-tablepreparedbeef)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: ProvenTxFromTxidResult

```ts
export interface ProvenTxFromTxidResult {
    proven?: EntityProvenTx;
    rawTx?: number[];
}
```

See also: [EntityProvenTx](./storage.md#class-entityproventx)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: ProvenTxReqHistory

```ts
export interface ProvenTxReqHistory {
    notes?: ReqHistoryNote[];
}
```

See also: [ReqHistoryNote](./client.md#interface-reqhistorynote)

###### Property notes

Keys are Date().toISOString()
Values are a description of what happened.

```ts
notes?: ReqHistoryNote[]
```
See also: [ReqHistoryNote](./client.md#interface-reqhistorynote)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: ProvenTxReqHistorySummaryApi

```ts
export interface ProvenTxReqHistorySummaryApi {
    setToCompleted: boolean;
    setToCallback: boolean;
    setToUnmined: boolean;
    setToDoubleSpend: boolean;
    setToSending: boolean;
    setToUnconfirmed: boolean;
}
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: ProvenTxReqNotify

```ts
export interface ProvenTxReqNotify {
    transactionIds?: number[];
}
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: ResourceProfileValues

```ts
export interface ResourceProfileValues {
    small: number;
    standard: number;
    highThroughput: number;
}
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: ReviewUtxoOutputsResult

```ts
export interface ReviewUtxoOutputsResult {
    classifications: UtxoReviewClassification[];
    confirmedSpentOutputs: TableOutput[];
    unknownOutputs: TableOutput[];
    diagnostics: UtxoReviewDiagnostics;
}
```

See also: [TableOutput](./storage.md#interface-tableoutput), [UtxoReviewClassification](./storage.md#interface-utxoreviewclassification), [UtxoReviewDiagnostics](./storage.md#interface-utxoreviewdiagnostics)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: SecurityHeadersOptions

```ts
export interface SecurityHeadersOptions {
    environmentPrefix?: string;
    contentSecurityPolicy?: string | false;
    crossOriginResourcePolicy?: "same-origin" | "same-site" | "cross-origin" | false;
    crossOriginOpenerPolicy?: "same-origin" | "same-origin-allow-popups" | "unsafe-none" | false;
    frameOptions?: "DENY" | "SAMEORIGIN" | false;
    permissionsPolicy?: string | false;
    strictTransportSecurity?: boolean;
}
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: SpentInputTransition

```ts
export interface SpentInputTransition {
    outputId: number;
    setSpentBy: boolean;
}
```

###### Property setSpentBy

true if the call set spentBy; false if only spendable was flipped.

```ts
setSpentBy: boolean
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: StorageAdminStats

```ts
export interface StorageAdminStats {
    requestedBy: string;
    when: string;
    usersDay: number;
    usersWeek: number;
    usersMonth: number;
    usersTotal: number;
    transactionsDay: number;
    transactionsWeek: number;
    transactionsMonth: number;
    transactionsTotal: number;
    txCompletedDay: number;
    txCompletedWeek: number;
    txCompletedMonth: number;
    txCompletedTotal: number;
    txFailedDay: number;
    txFailedWeek: number;
    txFailedMonth: number;
    txFailedTotal: number;
    txAbandonedDay: number;
    txAbandonedWeek: number;
    txAbandonedMonth: number;
    txAbandonedTotal: number;
    txUnprocessedDay: number;
    txUnprocessedWeek: number;
    txUnprocessedMonth: number;
    txUnprocessedTotal: number;
    txSendingDay: number;
    txSendingWeek: number;
    txSendingMonth: number;
    txSendingTotal: number;
    txUnprovenDay: number;
    txUnprovenWeek: number;
    txUnprovenMonth: number;
    txUnprovenTotal: number;
    txUnsignedDay: number;
    txUnsignedWeek: number;
    txUnsignedMonth: number;
    txUnsignedTotal: number;
    txNosendDay: number;
    txNosendWeek: number;
    txNosendMonth: number;
    txNosendTotal: number;
    txNonfinalDay: number;
    txNonfinalWeek: number;
    txNonfinalMonth: number;
    txNonfinalTotal: number;
    txUnfailDay: number;
    txUnfailWeek: number;
    txUnfailMonth: number;
    txUnfailTotal: number;
    satoshisDefaultDay: number;
    satoshisDefaultWeek: number;
    satoshisDefaultMonth: number;
    satoshisDefaultTotal: number;
    satoshisOtherDay: number;
    satoshisOtherWeek: number;
    satoshisOtherMonth: number;
    satoshisOtherTotal: number;
    basketsDay: number;
    basketsWeek: number;
    basketsMonth: number;
    basketsTotal: number;
    labelsDay: number;
    labelsWeek: number;
    labelsMonth: number;
    labelsTotal: number;
    tagsDay: number;
    tagsWeek: number;
    tagsMonth: number;
    tagsTotal: number;
}
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: StorageClientOptions

```ts
export interface StorageClientOptions {
    binaryRequests?: boolean;
    telemetry?: TelemetryConfig;
    serverIdentityKey?: string;
    storageIdentityKey?: string;
}
```

###### Property binaryRequests

Send compact tagged binary request values after the server advertises
support. Leave disabled during rolling deployments where an endpoint may
still route requests to legacy server instances.

```ts
binaryRequests?: boolean
```

###### Property serverIdentityKey

Optional independently validated server identity key. When omitted, the
first authenticated response is authoritative for this client instance.

```ts
serverIdentityKey?: string
```

###### Property storageIdentityKey

Optional independently validated storage-provider identity. The storage
and authenticated server may use distinct keys. When omitted, the value
advertised in the first authenticated `makeAvailable` response is
authoritative for this client instance.

```ts
storageIdentityKey?: string
```

###### Property telemetry

Optional vendor-neutral tracing. Disabled unless an enabled sink is
supplied. Request parameters and response payloads are never emitted.

```ts
telemetry?: TelemetryConfig
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: StorageIdbOptions

```ts
export interface StorageIdbOptions extends StorageProviderOptions {
}
```

See also: [StorageProviderOptions](./storage.md#interface-storageprovideroptions)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: StorageIdbSchema

```ts
export interface StorageIdbSchema {
    action_batches: {
        key: number;
        value: TableActionBatch;
        indexes: {
            userId: number;
            userId_batchId: [
                number,
                string
            ];
            expiresAt: Date;
        };
    };
    action_batch_outputs: {
        key: number;
        value: TableActionBatchOutput;
        indexes: {
            actionBatchId: number;
        };
    };
    action_batch_blobs: {
        key: [
            number,
            string
        ];
        value: TableActionBatchBlob;
        indexes: {
            actionBatchId: number;
        };
    };
    certificates: {
        key: number;
        value: TableCertificate;
        indexes: {
            userId: number;
            userId_type_certifier_serialNumber: [
                number,
                Base64String,
                PubKeyHex,
                Base64String
            ];
        };
    };
    certificateFields: {
        key: number;
        value: TableCertificateField;
        indexes: {
            userId: number;
            certificateId: number;
        };
    };
    commissions: {
        key: number;
        value: TableCommission;
        indexes: {
            userId: number;
            transactionId: number;
        };
    };
    monitorEvents: {
        key: number;
        value: TableMonitorEvent;
    };
    outputs: {
        key: number;
        value: TableOutput;
        indexes: {
            userId: number;
            userId_basketId: [
                number,
                number
            ];
            txid_vout_userId: [
                string,
                number,
                number
            ];
            transactionId: number;
            basketId: number;
            spentBy: string;
            transactionId_vout_userId: [
                number,
                number,
                number
            ];
        };
    };
    outputBaskets: {
        key: number;
        value: TableOutputBasket;
        indexes: {
            userId: number;
            name_userId: [
                string,
                number
            ];
        };
    };
    outputTags: {
        key: number;
        value: TableOutputTag;
        indexes: {
            userId: number;
            tag_userId: [
                string,
                number
            ];
        };
    };
    outputTagMaps: {
        key: number;
        value: TableOutputTagMap;
        indexes: {
            outputTagId: number;
            outputId: number;
        };
    };
    provenTxs: {
        key: number;
        value: TableProvenTx;
        indexes: {
            txid: HexString;
        };
    };
    provenTxReqs: {
        key: number;
        value: TableProvenTxReq;
        indexes: {
            provenTxId: number;
            txid: HexString;
            status: ProvenTxReqStatus;
            batch: string;
        };
    };
    syncStates: {
        key: number;
        value: TableSyncState;
        indexes: {
            userId: number;
            refNum: string;
            status: SyncStatus;
        };
    };
    settings: {
        key: number;
        value: TableSettings;
        indexes: Record<string, never>;
    };
    transactions: {
        key: number;
        value: TableTransaction;
        indexes: {
            userId: number;
            txid_userId: [
                string,
                number
            ];
            provenTxId: number;
            reference: string;
            status: TransactionStatus;
            noSendExpiryState: string;
            noSendExpiryReclaimTxid: string;
        };
    };
    txLabels: {
        key: number;
        value: TableTxLabel;
        indexes: {
            userId: number;
            label_userId: [
                string,
                number
            ];
        };
    };
    txLabelMaps: {
        key: number;
        value: TableTxLabelMap;
        indexes: {
            transactionId: number;
            txLabelId: number;
        };
    };
    users: {
        key: number;
        value: TableUser;
        indexes: {
            identityKey: string;
        };
    };
}
```

See also: [ProvenTxReqStatus](./client.md#type-proventxreqstatus), [SyncStatus](./client.md#type-syncstatus), [TableActionBatch](./storage.md#interface-tableactionbatch), [TableActionBatchBlob](./storage.md#interface-tableactionbatchblob), [TableActionBatchOutput](./storage.md#interface-tableactionbatchoutput), [TableCertificate](./storage.md#interface-tablecertificate), [TableCertificateField](./storage.md#interface-tablecertificatefield), [TableCommission](./storage.md#interface-tablecommission), [TableMonitorEvent](./storage.md#interface-tablemonitorevent), [TableOutput](./storage.md#interface-tableoutput), [TableOutputBasket](./storage.md#interface-tableoutputbasket), [TableOutputTag](./storage.md#interface-tableoutputtag), [TableOutputTagMap](./storage.md#interface-tableoutputtagmap), [TableProvenTx](./storage.md#interface-tableproventx), [TableProvenTxReq](./storage.md#interface-tableproventxreq), [TableSettings](./storage.md#interface-tablesettings), [TableSyncState](./storage.md#interface-tablesyncstate), [TableTransaction](./storage.md#interface-tabletransaction), [TableTxLabel](./storage.md#interface-tabletxlabel), [TableTxLabelMap](./storage.md#interface-tabletxlabelmap), [TableUser](./storage.md#interface-tableuser), [TransactionStatus](./client.md#type-transactionstatus)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: StorageKnexOptions

```ts
export interface StorageKnexOptions extends StorageProviderOptions {
    knex: Knex;
    preparedBeef?: PreparedBeefOptions;
}
```

See also: [PreparedBeefOptions](./storage.md#interface-preparedbeefoptions), [StorageProviderOptions](./storage.md#interface-storageprovideroptions)

###### Property knex

Knex database interface initialized with valid connection configuration.

```ts
knex: Knex
```

###### Property preparedBeef

Optional prepared-BEEF (COOK) rollout controls. Disabled by default.

```ts
preparedBeef?: PreparedBeefOptions
```
See also: [PreparedBeefOptions](./storage.md#interface-preparedbeefoptions)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: StorageProviderOptions

```ts
export interface StorageProviderOptions extends StorageReaderWriterOptions {
    chain: Chain;
    feeModel: StorageFeeModel;
    commissionSatoshis: number;
    commissionPubKeyHex?: PubKeyHex;
    scriptVerifier?: SpendVerifierInterface;
    actionBatchMaxReservedOutputs?: number;
    managedChangePolicy?: ManagedChangePolicyOptions;
}
```

See also: [Chain](./client.md#type-chain), [ManagedChangePolicyOptions](./storage.md#type-managedchangepolicyoptions), [StorageFeeModel](./client.md#interface-storagefeemodel), [StorageReaderWriterOptions](./storage.md#interface-storagereaderwriteroptions)

###### Property actionBatchMaxReservedOutputs

Maximum persisted outputs one action-batch workspace may reserve.
Defaults to 256; -1 disables this cumulative provider limit.

```ts
actionBatchMaxReservedOutputs?: number
```

###### Property commissionPubKeyHex

If commissionSatoshis is greater than zero, must be a valid public key hex string.
The actual locking script for each commission will use a public key derived
from this key by information stored in the commissions table.

```ts
commissionPubKeyHex?: PubKeyHex
```

###### Property commissionSatoshis

Transactions created by this Storage can charge a fee per transaction.
A value of zero disables commission fees.

```ts
commissionSatoshis: number
```

###### Property managedChangePolicy

Optional wallet-managed liquidity tuning. Values are soft shaping and
comparison budgets; none can prevent an otherwise fundable action. Each
limit accepts -1 for an explicit operator-selected unlimited mode.

```ts
managedChangePolicy?: ManagedChangePolicyOptions
```
See also: [ManagedChangePolicyOptions](./storage.md#type-managedchangepolicyoptions)

###### Property scriptVerifier

Optional verifier for server-side action-batch script checks. This Wallet
Toolbox extension leaves the BRC-100 wallet interface unchanged.

```ts
scriptVerifier?: SpendVerifierInterface
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: StorageReaderOptions

```ts
export interface StorageReaderOptions {
    chain: sdk.Chain;
    telemetry?: TelemetryConfig;
}
```

See also: [Chain](./client.md#type-chain)

###### Property telemetry

Optional provider-neutral storage and database tracing.

```ts
telemetry?: TelemetryConfig
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: StorageReaderWriterOptions

```ts
export interface StorageReaderWriterOptions extends StorageReaderOptions {
}
```

See also: [StorageReaderOptions](./storage.md#interface-storagereaderoptions)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: SyncError

```ts
export interface SyncError {
    code: string;
    description: string;
    stack?: string;
}
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: SyncMap

```ts
export interface SyncMap {
    provenTx: EntitySyncMap;
    outputBasket: EntitySyncMap;
    transaction: EntitySyncMap;
    provenTxReq: EntitySyncMap;
    txLabel: EntitySyncMap;
    txLabelMap: EntitySyncMap;
    output: EntitySyncMap;
    outputTag: EntitySyncMap;
    outputTagMap: EntitySyncMap;
    certificate: EntitySyncMap;
    certificateField: EntitySyncMap;
    commission: EntitySyncMap;
}
```

See also: [EntitySyncMap](./storage.md#interface-entitysyncmap)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: SyncProofValidationStorage

```ts
export interface SyncProofValidationStorage {
    getServices: () => WalletServices;
}
```

See also: [WalletServices](./client.md#interface-walletservices)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: SyncTransferCapabilities

Versioned transport framing; the reconstructed BRC-40 request/response is unchanged.

```ts
export interface SyncTransferCapabilities {
    version: 1;
    maxBytes: number;
    partBytes: number;
    inlineBytes?: number;
}
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: SyncTransferManifest

```ts
export interface SyncTransferManifest {
    transferId: string;
    digest: string;
    totalBytes: number;
    partBytes: number;
    expiresAt: number;
}
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: SyncTransferPart

```ts
export interface SyncTransferPart {
    offset: number;
    bytes: Uint8Array;
}
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: TableActionBatch

```ts
export interface TableActionBatch extends EntityTimeStamp {
    actionBatchId: number;
    userId: number;
    batchId: string;
    status: ActionBatchStatus;
    expiresAt: Date;
    hardExpiresAt: Date;
    manifestDigest?: string;
    manifest?: string;
    uploadDigests?: string;
    result?: string;
}
```

See also: [ActionBatchStatus](./storage.md#type-actionbatchstatus), [EntityTimeStamp](./client.md#interface-entitytimestamp)

###### Property manifest

JSON-encoded format-2 manifest retained between prepare and commit.

```ts
manifest?: string
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: TableActionBatchBlob

```ts
export interface TableActionBatchBlob extends EntityTimeStamp {
    actionBatchBlobId: number;
    actionBatchId: number;
    digest: string;
    bytes: number[] | Uint8Array;
}
```

See also: [EntityTimeStamp](./client.md#interface-entitytimestamp)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: TableActionBatchOutput

```ts
export interface TableActionBatchOutput extends EntityTimeStamp {
    actionBatchId: number;
    outputId: number;
}
```

See also: [EntityTimeStamp](./client.md#interface-entitytimestamp)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: TableAuthSession

Durable representation of a BRC-103 peer session.

The session nonce is the authoritative key. `lastUpdate` also acts as the
optimistic-write version so a delayed request from one replica cannot
overwrite newer authentication state written by another replica.

```ts
export interface TableAuthSession {
    sessionNonce: string;
    peerNonce?: string | null;
    peerIdentityKey?: string | null;
    isAuthenticated: boolean | number;
    lastUpdate: number | string;
    certificatesRequired?: boolean | number | null;
    certificatesValidated?: boolean | number | null;
    expiresAt: number | string;
}
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: TableCertificate

```ts
export interface TableCertificate extends sdk.EntityTimeStamp {
    created_at: Date;
    updated_at: Date;
    certificateId: number;
    userId: number;
    type: Base64String;
    serialNumber: Base64String;
    certifier: PubKeyHex;
    subject: PubKeyHex;
    verifier?: PubKeyHex;
    revocationOutpoint: OutpointString;
    signature: HexString;
    isDeleted: boolean;
}
```

See also: [EntityTimeStamp](./client.md#interface-entitytimestamp)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: TableCertificateField

```ts
export interface TableCertificateField extends sdk.EntityTimeStamp {
    created_at: Date;
    updated_at: Date;
    userId: number;
    certificateId: number;
    fieldName: string;
    fieldValue: string;
    masterKey: Base64String;
}
```

See also: [EntityTimeStamp](./client.md#interface-entitytimestamp)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: TableCertificateX

```ts
export interface TableCertificateX extends TableCertificate {
    fields?: TableCertificateField[];
}
```

See also: [TableCertificate](./storage.md#interface-tablecertificate), [TableCertificateField](./storage.md#interface-tablecertificatefield)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: TableCommission

```ts
export interface TableCommission extends sdk.EntityTimeStamp {
    created_at: Date;
    updated_at: Date;
    commissionId: number;
    userId: number;
    transactionId: number;
    satoshis: number;
    keyOffset: string;
    isRedeemed: boolean;
    lockingScript: number[];
}
```

See also: [EntityTimeStamp](./client.md#interface-entitytimestamp)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: TableMonitorEvent

```ts
export interface TableMonitorEvent extends sdk.EntityTimeStamp {
    created_at: Date;
    updated_at: Date;
    id: number;
    event: string;
    details?: string;
}
```

See also: [EntityTimeStamp](./client.md#interface-entitytimestamp)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: TableOutput

```ts
export interface TableOutput extends sdk.EntityTimeStamp {
    created_at: Date;
    updated_at: Date;
    outputId: number;
    userId: number;
    transactionId: number;
    basketId?: number;
    spendable: boolean;
    change: boolean;
    outputDescription: DescriptionString5to50Bytes;
    vout: number;
    satoshis: number;
    providedBy: sdk.StorageProvidedBy;
    purpose: string;
    type: string;
    txid?: string;
    senderIdentityKey?: PubKeyHex;
    derivationPrefix?: Base64String;
    derivationSuffix?: Base64String;
    customInstructions?: string;
    spentBy?: number;
    sequenceNumber?: number;
    spendingDescription?: string;
    scriptLength?: number;
    scriptOffset?: number;
    lockingScript?: number[];
}
```

See also: [EntityTimeStamp](./client.md#interface-entitytimestamp), [StorageProvidedBy](./client.md#type-storageprovidedby)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: TableOutputBasket

```ts
export interface TableOutputBasket extends sdk.EntityTimeStamp {
    created_at: Date;
    updated_at: Date;
    basketId: number;
    userId: number;
    name: string;
    numberOfDesiredUTXOs: number;
    minimumDesiredUTXOValue: number;
    isDeleted: boolean;
}
```

See also: [EntityTimeStamp](./client.md#interface-entitytimestamp)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: TableOutputTag

```ts
export interface TableOutputTag extends sdk.EntityTimeStamp {
    created_at: Date;
    updated_at: Date;
    outputTagId: number;
    userId: number;
    tag: string;
    isDeleted: boolean;
}
```

See also: [EntityTimeStamp](./client.md#interface-entitytimestamp)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: TableOutputTagMap

```ts
export interface TableOutputTagMap extends sdk.EntityTimeStamp {
    created_at: Date;
    updated_at: Date;
    outputTagId: number;
    outputId: number;
    isDeleted: boolean;
}
```

See also: [EntityTimeStamp](./client.md#interface-entitytimestamp)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: TableOutputX

```ts
export interface TableOutputX extends TableOutput {
    basket?: TableOutputBasket;
    tags?: TableOutputTag[];
}
```

See also: [TableOutput](./storage.md#interface-tableoutput), [TableOutputBasket](./storage.md#interface-tableoutputbasket), [TableOutputTag](./storage.md#interface-tableoutputtag)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: TablePreparedBeef

Rebuildable, user-scoped proof material prepared for a future spend.

This table is deliberately excluded from wallet synchronization. The
authoritative transaction, proof, and output rows can always rebuild it.

```ts
export interface TablePreparedBeef extends sdk.EntityTimeStamp {
    created_at: Date;
    updated_at: Date;
    preparedBeefId: number;
    userId: number;
    rootTxid: string;
    beef: number[];
    checksum: string;
    formatVersion: number;
    state: PreparedBeefState;
    txCount: number;
    bumpCount: number;
    byteLength: number;
}
```

See also: [EntityTimeStamp](./client.md#interface-entitytimestamp), [PreparedBeefState](./storage.md#type-preparedbeefstate)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: TableProvenTx

```ts
export interface TableProvenTx extends sdk.EntityTimeStamp {
    created_at: Date;
    updated_at: Date;
    provenTxId: number;
    txid: string;
    height: number;
    index: number;
    merklePath: number[];
    rawTx: number[];
    blockHash: string;
    merkleRoot: string;
}
```

See also: [EntityTimeStamp](./client.md#interface-entitytimestamp), [blockHash](./services.md#function-blockhash)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: TableProvenTxReq

```ts
export interface TableProvenTxReq extends TableProvenTxReqDynamics {
    created_at: Date;
    updated_at: Date;
    provenTxReqId: number;
    provenTxId?: number;
    status: sdk.ProvenTxReqStatus;
    attempts: number;
    notified: boolean;
    txid: string;
    batch?: string;
    history: string;
    notify: string;
    rawTx: number[];
    inputBEEF?: number[];
    wasBroadcast?: boolean;
    rebroadcastAttempts?: number;
}
```

See also: [ProvenTxReqStatus](./client.md#type-proventxreqstatus), [TableProvenTxReqDynamics](./storage.md#interface-tableproventxreqdynamics)

###### Property attempts

Count of how many times a service has been asked about this txid

```ts
attempts: number
```

###### Property batch

If valid, a unique string identifying a batch of transactions to be sent together for processing.

```ts
batch?: string
```

###### Property history

JSON string of processing history.
Parses to `ProvenTxReqHistoryApi`.

```ts
history: string
```

###### Property notified

Set to true when a terminal status has been set and notification has occurred.

```ts
notified: boolean
```

###### Property notify

JSON string of data to drive notifications when this request completes.
Parses to `ProvenTxReqNotifyApi`.

```ts
notify: string
```

###### Property rebroadcastAttempts

Count of how many times this req has been reset to 'unsent' for rebroadcast
after proof check timeout. Used by the circuit-breaker (maxRebroadcastAttempts).
Defaults to 0 (added by migration 2026-04-30-001).

```ts
rebroadcastAttempts?: number
```

###### Property wasBroadcast

Set to true the first time this req transitions to 'unmined' or 'callback' status,
indicating the transaction was successfully broadcast to the network.
Used to distinguish rebroadcast candidates from transactions that were never sent.
Defaults to false (added by migration 2026-04-30-001).

```ts
wasBroadcast?: boolean
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: TableProvenTxReqDynamics

Table properties that may change after initial record insertion.

```ts
export interface TableProvenTxReqDynamics extends sdk.EntityTimeStamp {
    updated_at: Date;
    provenTxId?: number;
    status: sdk.ProvenTxReqStatus;
    attempts: number;
    notified: boolean;
    batch?: string;
    history: string;
    notify: string;
    wasBroadcast?: boolean;
    rebroadcastAttempts?: number;
}
```

See also: [EntityTimeStamp](./client.md#interface-entitytimestamp), [ProvenTxReqStatus](./client.md#type-proventxreqstatus)

###### Property attempts

Count of how many times a service has been asked about this txid

```ts
attempts: number
```

###### Property batch

If valid, a unique string identifying a batch of transactions to be sent together for processing.

```ts
batch?: string
```

###### Property history

JSON string of processing history.
Parses to `ProvenTxReqHistoryApi`.

```ts
history: string
```

###### Property notified

Set to true when a terminal status has been set and notification has occurred.

```ts
notified: boolean
```

###### Property notify

JSON string of data to drive notifications when this request completes.
Parses to `ProvenTxReqNotifyApi`.

```ts
notify: string
```

###### Property rebroadcastAttempts

Count of rebroadcast cycles for this req. Used by the circuit-breaker.
Defaults to 0 (added by migration 2026-04-30-001).

```ts
rebroadcastAttempts?: number
```

###### Property wasBroadcast

Set to true the first time this req transitions to 'unmined' or 'callback' status.
Defaults to false (added by migration 2026-04-30-001).

```ts
wasBroadcast?: boolean
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: TableSettings

```ts
export interface TableSettings extends sdk.StorageIdentity, sdk.EntityTimeStamp {
    created_at: Date;
    updated_at: Date;
    storageIdentityKey: string;
    storageName: string;
    chain: sdk.Chain;
    dbtype: "SQLite" | "MySQL" | "IndexedDB";
    maxOutputScript: number;
}
```

See also: [Chain](./client.md#type-chain), [EntityTimeStamp](./client.md#interface-entitytimestamp), [StorageIdentity](./client.md#interface-storageidentity)

###### Property storageIdentityKey

The identity key (public key) assigned to this storage

```ts
storageIdentityKey: string
```

###### Property storageName

The human readable name assigned to this storage.

```ts
storageName: string
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: TableSyncState

```ts
export interface TableSyncState extends sdk.EntityTimeStamp {
    created_at: Date;
    updated_at: Date;
    syncStateId: number;
    userId: number;
    storageIdentityKey: string;
    storageName: string;
    status: sdk.SyncStatus;
    init: boolean;
    refNum: string;
    syncMap: string;
    when?: Date;
    satoshis?: number;
    errorLocal?: string;
    errorOther?: string;
}
```

See also: [EntityTimeStamp](./client.md#interface-entitytimestamp), [SyncStatus](./client.md#type-syncstatus)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: TableTransaction

```ts
export interface TableTransaction extends sdk.EntityTimeStamp {
    created_at: Date;
    updated_at: Date;
    transactionId: number;
    userId: number;
    provenTxId?: number;
    status: sdk.TransactionStatus;
    reference: Base64String;
    isOutgoing: boolean;
    satoshis: number;
    description: string;
    version?: number;
    lockTime?: number;
    txid?: string;
    inputBEEF?: number[];
    rawTx?: number[];
    noSendExpiryMode?: Brc177NoSendExpiryMode;
    noSendExpiryValue?: number;
    noSendExpiryDeadline?: number;
    noSendExpiryState?: Brc177NoSendExpiryState;
    noSendExpiryAnchorTxid?: string;
    noSendExpiryAnchorVout?: number;
    noSendExpiryReleasedAt?: number;
    noSendExpiryObservedAt?: number;
    noSendExpiryReclaimTxid?: string;
    noSendExpiryReclaimRawTx?: number[];
    noSendExpiryReclaimDerivationPrefix?: string;
    noSendExpiryReclaimDerivationSuffix?: string;
    noSendExpiryReclaimSatoshis?: number;
}
```

See also: [Brc177NoSendExpiryMode](./client.md#type-brc177nosendexpirymode), [Brc177NoSendExpiryState](./client.md#type-brc177nosendexpirystate), [EntityTimeStamp](./client.md#interface-entitytimestamp), [TransactionStatus](./client.md#type-transactionstatus)

###### Property isOutgoing

true if transaction originated in this wallet, change returns to it.
false for a transaction created externally and handed in to this wallet.

```ts
isOutgoing: boolean
```

###### Property lockTime

Optional. Default is zero.
When the transaction can be processed into a block:
>= 500,000,000 values are interpreted as minimum required unix time stamps in seconds
< 500,000,000 values are interpreted as minimum required block height

```ts
lockTime?: number
```

###### Property noSendExpiryDeadline

Resolved Unix seconds for time modes, or the absolute height for blockheight.

```ts
noSendExpiryDeadline?: number
```

###### Property noSendExpiryMode

Internal BRC-177 lifecycle metadata. These fields are synchronized with the action.

```ts
noSendExpiryMode?: Brc177NoSendExpiryMode
```
See also: [Brc177NoSendExpiryMode](./client.md#type-brc177nosendexpirymode)

###### Property reference

max length of 64, hex encoded

```ts
reference: Base64String
```

###### Property version

If not undefined, must match value in associated rawTransaction.

```ts
version?: number
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: TableTxLabel

```ts
export interface TableTxLabel extends sdk.EntityTimeStamp {
    created_at: Date;
    updated_at: Date;
    txLabelId: number;
    userId: number;
    label: string;
    isDeleted: boolean;
}
```

See also: [EntityTimeStamp](./client.md#interface-entitytimestamp)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: TableTxLabelMap

```ts
export interface TableTxLabelMap extends sdk.EntityTimeStamp {
    created_at: Date;
    updated_at: Date;
    txLabelId: number;
    transactionId: number;
    isDeleted: boolean;
}
```

See also: [EntityTimeStamp](./client.md#interface-entitytimestamp)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: TableUser

```ts
export interface TableUser extends sdk.EntityTimeStamp {
    created_at: Date;
    updated_at: Date;
    userId: number;
    identityKey: string;
    activeStorage: string;
}
```

See also: [EntityTimeStamp](./client.md#interface-entitytimestamp)

###### Property activeStorage

The storageIdentityKey value of the active wallet storage.

```ts
activeStorage: string
```

###### Property identityKey

PubKeyHex uniquely identifying user.
Typically 66 hex digits.

```ts
identityKey: string
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: UtxoReviewClassification

```ts
export interface UtxoReviewClassification {
    output: TableOutput;
    status: OutputUtxoClassification;
}
```

See also: [OutputUtxoClassification](./services.md#interface-outpututxoclassification), [TableOutput](./storage.md#interface-tableoutput)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: UtxoReviewDiagnostics

```ts
export interface UtxoReviewDiagnostics {
    checked: number;
    confirmedUnspent: number;
    confirmedSpent: number;
    unknown: number;
    confirmedSpentSatoshis: number;
    released: number;
    releasedSatoshis: number;
    providers: string[];
    providerCount: number;
    providersTruncated: boolean;
}
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: ValidateGenerateChangeSdkParamsResult

```ts
export interface ValidateGenerateChangeSdkParamsResult {
    hasMaxPossibleOutput?: number;
}
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: ValidatedBatchAction

```ts
export interface ValidatedBatchAction {
    action: ActionBatchCommitAction;
    tx: Transaction;
    rawTx: Uint8Array;
    externalInputBeef: Uint8Array;
}
```

See also: [ActionBatchCommitAction](./client.md#interface-actionbatchcommitaction)

###### Property externalInputBeef

Proof frontier for inputs outside this atomic batch.

```ts
externalInputBeef: Uint8Array
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: VerifyAndRepairBeefResult

```ts
export interface VerifyAndRepairBeefResult {
    isStructurallyValid: boolean;
    originalRoots: Record<number, string>;
    invalidRoots: Record<number, {
        root: string;
        reproveResults: sdk.ReproveHeaderResult;
    }>;
    verifiedBeef?: Beef;
}
```

See also: [ReproveHeaderResult](./client.md#interface-reproveheaderresult)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: WalletStorageServerOptions

```ts
export interface WalletStorageServerOptions {
    host?: string;
    port: number;
    wallet: Wallet;
    monetize: boolean;
    calculateRequestPrice?: (req: Request) => number | Promise<number>;
    adminIdentityKeys?: string[];
    makeLogger?: MakeWalletLogger;
    sessionManager?: AuthMiddlewareOptions["sessionManager"];
    rateLimit?: Partial<RateLimitOptions>;
    preAuthRateLimit?: Partial<RateLimitOptions>;
    trustProxy?: TrustProxySetting;
    allowedOrigins?: string[];
    maxConcurrentRequests?: number;
    http?: Partial<HttpServerPolicyDefaults>;
    securityHeaders?: SecurityHeadersOptions;
    logRpcRequests?: boolean;
    logShortReqs?: boolean;
    telemetry?: TelemetryConfig;
    defaultRpcListLimit?: number;
    maxRpcListLimit?: number;
    maxRpcListOffset?: number;
    maxRpcArrayItems?: number;
    maxRpcResponseBytes?: number;
    syncTransfers?: boolean;
    paymentReplayStore?: PaymentReplayStore;
}
```

See also: [HttpServerPolicyDefaults](./storage.md#interface-httpserverpolicydefaults), [SecurityHeadersOptions](./storage.md#interface-securityheadersoptions), [TrustProxySetting](./storage.md#type-trustproxysetting), [Wallet](./client.md#class-wallet), [securityHeaders](./storage.md#function-securityheaders)

###### Property allowedOrigins

Exact browser origins allowed to call this server. Omit for public CORS.

```ts
allowedOrigins?: string[]
```

###### Property defaultRpcListLimit

Default item limit inserted for list/find RPC calls that omit one. Default: 1,000.

```ts
defaultRpcListLimit?: number
```

###### Property host

Listener bind host. Omit to retain Node's historical all-interface behavior.

```ts
host?: string
```

###### Property http

Node HTTP timeout/connection policy overrides.

```ts
http?: Partial<HttpServerPolicyDefaults>
```
See also: [HttpServerPolicyDefaults](./storage.md#interface-httpserverpolicydefaults)

###### Property logRpcRequests

Emit one JSON log record for each authenticated RPC. Default: true.

```ts
logRpcRequests?: boolean
```

###### Property maxConcurrentRequests

Per-process in-flight request ceiling. Defaults to the selected resource profile (24 in standard).

```ts
maxConcurrentRequests?: number
```

###### Property maxRpcArrayItems

Maximum elements in any decoded request array. Use -1 only for trusted callers.

```ts
maxRpcArrayItems?: number
```

###### Property maxRpcListLimit

Largest caller-selected list/find item limit. Use -1 to disable this operator ceiling.

```ts
maxRpcListLimit?: number
```

###### Property maxRpcListOffset

Largest list/find/sync offset accepted at the RPC edge. Use -1 only for trusted tenants.

```ts
maxRpcListOffset?: number
```

###### Property maxRpcResponseBytes

Maximum serialized JSON-RPC response bytes. Use -1 to disable.

```ts
maxRpcResponseBytes?: number
```

###### Property paymentReplayStore

Durable BRC-105 replay claims for monetized multi-replica deployments.

```ts
paymentReplayStore?: PaymentReplayStore
```

###### Property preAuthRateLimit

Pre-authentication IP rate limiting. Defaults to 300 requests per minute.
Use a shared store when multiple server processes or replicas must enforce
one aggregate limit.

```ts
preAuthRateLimit?: Partial<RateLimitOptions>
```

###### Property rateLimit

Authenticated request rate limiting. Defaults to 1,000 requests per
identity key per minute. Override the store for shared enforcement across
multiple server processes or replicas.

```ts
rateLimit?: Partial<RateLimitOptions>
```

###### Property securityHeaders

Security response-header and CSP overrides.

```ts
securityHeaders?: SecurityHeadersOptions
```
See also: [SecurityHeadersOptions](./storage.md#interface-securityheadersoptions)

###### Property sessionManager

Shared BRC-103 session storage for multi-process or multi-replica servers.
Defaults to the auth middleware's in-process SessionManager.

```ts
sessionManager?: AuthMiddlewareOptions["sessionManager"]
```

###### Property syncTransfers

Disable the additive durable transfer transport during a mixed-version rollout. Knex only.

```ts
syncTransfers?: boolean
```

###### Property telemetry

Optional provider-neutral timing for ingress, authentication, RPC
authorization, storage dispatch, and response formulation.

```ts
telemetry?: TelemetryConfig
```

###### Property trustProxy

Explicit Express proxy trust policy. Omit for the secure direct-socket
default. Prefer a known hop count, subnet, or predicate; permissive
`true` is intentionally unsupported.

```ts
trustProxy?: TrustProxySetting
```
See also: [TrustProxySetting](./storage.md#type-trustproxysetting)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: XValidCreateActionInput

```ts
export interface XValidCreateActionInput extends Validation.ValidCreateActionInput {
    vin: number;
    lockingScript: Script;
    satoshis: number;
    output?: TableOutput;
}
```

See also: [TableOutput](./storage.md#interface-tableoutput)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: XValidCreateActionOutput

```ts
export interface XValidCreateActionOutput extends Validation.ValidCreateActionOutput {
    vout: number;
    providedBy: StorageProvidedBy;
    purpose?: string;
    derivationSuffix?: string;
    keyOffset?: string;
}
```

See also: [StorageProvidedBy](./client.md#type-storageprovidedby)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
#### Classes

| | | |
| --- | --- | --- |
| [AdminServer](#class-adminserver) | [EntitySyncState](#class-entitysyncstate) | [StorageClient](#class-storageclient) |
| [CanonicalChangeSelector](#class-canonicalchangeselector) | [EntityTransaction](#class-entitytransaction) | [StorageClientBase](#class-storageclientbase) |
| [EntityBase](#class-entitybase) | [EntityTxLabel](#class-entitytxlabel) | [StorageIdb](#class-storageidb) |
| [EntityCertificate](#class-entitycertificate) | [EntityTxLabelMap](#class-entitytxlabelmap) | [StorageKnex](#class-storageknex) |
| [EntityCertificateField](#class-entitycertificatefield) | [EntityUser](#class-entityuser) | [StorageProvider](#class-storageprovider) |
| [EntityCommission](#class-entitycommission) | [KnexMigrations](#class-knexmigrations) | [StorageReader](#class-storagereader) |
| [EntityOutput](#class-entityoutput) | [KnexPaymentReplayStore](#class-knexpaymentreplaystore) | [StorageReaderWriter](#class-storagereaderwriter) |
| [EntityOutputBasket](#class-entityoutputbasket) | [KnexSessionManager](#class-knexsessionmanager) | [StorageServer](#class-storageserver) |
| [EntityOutputTag](#class-entityoutputtag) | [KnexSyncTransferStore](#class-knexsynctransferstore) | [StorageSyncReader](#class-storagesyncreader) |
| [EntityOutputTagMap](#class-entityoutputtagmap) | [MergeEntity](#class-mergeentity) | [SyncPageBudget](#class-syncpagebudget) |
| [EntityProvenTx](#class-entityproventx) | [PreparedBeefCoordinator](#class-preparedbeefcoordinator) | [WalletStorageManager](#class-walletstoragemanager) |
| [EntityProvenTxReq](#class-entityproventxreq) | [StaleSyncProofError](#class-stalesyncprooferror) |  |

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---

##### Class: AdminServer

```ts
export class AdminServer {
    constructor(private readonly context: MonitorAdminContext)
    start(): void
    async close(): Promise<void>
}
```

See also: [MonitorAdminContext](./storage.md#interface-monitoradmincontext)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Class: CanonicalChangeSelector

Stateful form of the canonical selector for allocating many inputs from one
candidate set. It preserves exact / least-over / largest-under ordering but
sorts once instead of filtering and sorting the full set per input.

```ts
export class CanonicalChangeSelector<T extends CanonicalFundingCandidate> {
    constructor(outputs: readonly T[])
    take(targetSatoshis: number, exactSatoshis?: number): T | undefined
    release(outputId: number): void
}
```

See also: [CanonicalFundingCandidate](./storage.md#interface-canonicalfundingcandidate)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Class: EntityBase

```ts
export abstract class EntityBase<T> {
    api: T;
    constructor(api: T)
    abstract get id(): number;
    abstract get entityName(): string;
    abstract get entityTable(): string;
    abstract updateApi(): void;
    abstract equals(ei: T, syncMap?: SyncMap): boolean;
    abstract mergeNew(storage: EntityStorage, userId: number, syncMap: SyncMap, trx?: TrxToken): Promise<void>;
    abstract mergeExisting(storage: EntityStorage, since: Date | undefined, ei: T, syncMap: SyncMap, trx?: TrxToken): Promise<boolean>;
    toApi(): T
}
```

See also: [EntityStorage](./storage.md#type-entitystorage), [SyncMap](./storage.md#interface-syncmap), [TrxToken](./client.md#interface-trxtoken)

###### Method equals

Tests for equality or 'merge' / 'convergent' equality if syncMap is provided.

'convergent' equality must satisfy (A sync B) equals (B sync A)

```ts
abstract equals(ei: T, syncMap?: SyncMap): boolean
```
See also: [SyncMap](./storage.md#interface-syncmap)

###### Method mergeExisting

Perform a 'merge' / 'convergent' equality migration of state
from external `ei` to this existing local EntityUser

```ts
abstract mergeExisting(storage: EntityStorage, since: Date | undefined, ei: T, syncMap: SyncMap, trx?: TrxToken): Promise<boolean>
```
See also: [EntityStorage](./storage.md#type-entitystorage), [SyncMap](./storage.md#interface-syncmap), [TrxToken](./client.md#interface-trxtoken)

Returns

true iff entity state changed and was updated to storage

###### Method mergeNew

Perform a 'merge' / 'convergent' equality migration of state
to this new local entity which was constructed
as a copy of the external object.

```ts
abstract mergeNew(storage: EntityStorage, userId: number, syncMap: SyncMap, trx?: TrxToken): Promise<void>
```
See also: [EntityStorage](./storage.md#type-entitystorage), [SyncMap](./storage.md#interface-syncmap), [TrxToken](./client.md#interface-trxtoken)

Argument Details

+ **userId**
  + local userId

###### Method toApi

An entity may decode properties of the underlying Api object on construction.

The `toApi` method forces an `updateApi` before returning the underlying,
now updated, Api object.

```ts
toApi(): T
```

Returns

The underlying Api object with any entity decoded properties updated.

###### Method updateApi

On construction, an entity may decode properties of the `api` object,
such as JSON stringified objects.

The `updateApi` method must re-encode the current state of those decoded properties
into the `api` object.

Used by the `toApi` method to return an updated `api` object.

```ts
abstract updateApi(): void
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Class: EntityCertificate

```ts
export class EntityCertificate extends EntityBase<TableCertificate> {
    constructor(api?: TableCertificate)
    override updateApi(): void
    get certificateId()
    set certificateId(v: number)
    get created_at()
    set created_at(v: Date)
    get updated_at()
    set updated_at(v: Date)
    get userId()
    set userId(v: number)
    get type()
    set type(v: string)
    get subject()
    set subject(v: string)
    get verifier()
    set verifier(v: string | undefined)
    get serialNumber()
    set serialNumber(v: string)
    get certifier()
    set certifier(v: string)
    get revocationOutpoint()
    set revocationOutpoint(v: string)
    get signature()
    set signature(v: string)
    get isDeleted()
    set isDeleted(v: boolean)
    override get id(): number
    override set id(v: number)
    override get entityName(): string
    override get entityTable(): string
    override equals(ei: TableCertificate, syncMap?: SyncMap): boolean
    static async mergeFind(storage: EntityStorage, userId: number, ei: TableCertificate, syncMap: SyncMap, trx?: TrxToken): Promise<{
        found: boolean;
        eo: EntityCertificate;
        eiId: number;
    }>
    override async mergeNew(storage: EntityStorage, userId: number, syncMap: SyncMap, trx?: TrxToken): Promise<void>
    override async mergeExisting(storage: EntityStorage, since: Date | undefined, ei: TableCertificate, syncMap: SyncMap, trx?: TrxToken): Promise<boolean>
}
```

See also: [EntityBase](./storage.md#class-entitybase), [EntityStorage](./storage.md#type-entitystorage), [SyncMap](./storage.md#interface-syncmap), [TableCertificate](./storage.md#interface-tablecertificate), [TrxToken](./client.md#interface-trxtoken)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Class: EntityCertificateField

```ts
export class EntityCertificateField extends EntityBase<TableCertificateField> {
    constructor(api?: TableCertificateField)
    override updateApi(): void
    get userId()
    set userId(v: number)
    get certificateId()
    set certificateId(v: number)
    get created_at()
    set created_at(v: Date)
    get updated_at()
    set updated_at(v: Date)
    get fieldName()
    set fieldName(v: string)
    get fieldValue()
    set fieldValue(v: string)
    get masterKey()
    set masterKey(v: string)
    override get id(): number
    override get entityName(): string
    override get entityTable(): string
    override equals(ei: TableCertificateField, syncMap?: SyncMap | undefined): boolean
    static async mergeFind(storage: EntityStorage, userId: number, ei: TableCertificateField, syncMap: SyncMap, trx?: TrxToken): Promise<{
        found: boolean;
        eo: EntityCertificateField;
        eiId: number;
    }>
    override async mergeNew(storage: EntityStorage, userId: number, syncMap: SyncMap, trx?: TrxToken): Promise<void>
    override async mergeExisting(storage: EntityStorage, since: Date | undefined, ei: TableCertificateField, syncMap: SyncMap, trx?: TrxToken): Promise<boolean>
}
```

See also: [EntityBase](./storage.md#class-entitybase), [EntityStorage](./storage.md#type-entitystorage), [SyncMap](./storage.md#interface-syncmap), [TableCertificateField](./storage.md#interface-tablecertificatefield), [TrxToken](./client.md#interface-trxtoken)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Class: EntityCommission

```ts
export class EntityCommission extends EntityBase<TableCommission> {
    constructor(api?: TableCommission)
    override updateApi(): void
    get commissionId()
    set commissionId(v: number)
    get created_at()
    set created_at(v: Date)
    get updated_at()
    set updated_at(v: Date)
    get transactionId()
    set transactionId(v: number)
    get userId()
    set userId(v: number)
    get isRedeemed()
    set isRedeemed(v: boolean)
    get keyOffset()
    set keyOffset(v: string)
    get lockingScript()
    set lockingScript(v: number[])
    get satoshis()
    set satoshis(v: number)
    override get id(): number
    override set id(v: number)
    override get entityName(): string
    override get entityTable(): string
    override equals(ei: TableCommission, syncMap?: SyncMap | undefined): boolean
    static async mergeFind(storage: EntityStorage, userId: number, ei: TableCommission, syncMap: SyncMap, trx?: TrxToken): Promise<{
        found: boolean;
        eo: EntityCommission;
        eiId: number;
    }>
    override async mergeNew(storage: EntityStorage, userId: number, syncMap: SyncMap, trx?: TrxToken): Promise<void>
    override async mergeExisting(storage: EntityStorage, since: Date | undefined, ei: TableCommission, syncMap: SyncMap, trx?: TrxToken): Promise<boolean>
}
```

See also: [EntityBase](./storage.md#class-entitybase), [EntityStorage](./storage.md#type-entitystorage), [SyncMap](./storage.md#interface-syncmap), [TableCommission](./storage.md#interface-tablecommission), [TrxToken](./client.md#interface-trxtoken)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Class: EntityOutput

```ts
export class EntityOutput extends EntityBase<TableOutput> {
    constructor(api?: TableOutput)
    override updateApi(): void
    get outputId()
    set outputId(v: number)
    get created_at()
    set created_at(v: Date)
    get updated_at()
    set updated_at(v: Date)
    get userId()
    set userId(v: number)
    get transactionId()
    set transactionId(v: number)
    get basketId()
    set basketId(v: number | undefined)
    get spentBy()
    set spentBy(v: number | undefined)
    get vout()
    set vout(v: number)
    get satoshis()
    set satoshis(v: number)
    get outputDescription()
    set outputDescription(v: string)
    get spendable()
    set spendable(v: boolean)
    get change()
    set change(v: boolean)
    get txid()
    set txid(v: string | undefined)
    get type()
    set type(v: string)
    get providedBy()
    set providedBy(v: StorageProvidedBy)
    get purpose()
    set purpose(v: string)
    get spendingDescription()
    set spendingDescription(v: string | undefined)
    get derivationPrefix()
    set derivationPrefix(v: string | undefined)
    get derivationSuffix()
    set derivationSuffix(v: string | undefined)
    get senderIdentityKey()
    set senderIdentityKey(v: string | undefined)
    get customInstructions()
    set customInstructions(v: string | undefined)
    get lockingScript()
    set lockingScript(v: number[] | undefined)
    get scriptLength()
    set scriptLength(v: number | undefined)
    get scriptOffset()
    set scriptOffset(v: number | undefined)
    override get id(): number
    override set id(v: number)
    override get entityName(): string
    override get entityTable(): string
    override equals(ei: TableOutput, syncMap?: SyncMap | undefined): boolean
    static async mergeFind(storage: EntityStorage, userId: number, ei: TableOutput, syncMap: SyncMap, trx?: TrxToken): Promise<{
        found: boolean;
        eo: EntityOutput;
        eiId: number;
    }>
    override async mergeNew(storage: EntityStorage, userId: number, syncMap: SyncMap, trx?: TrxToken): Promise<void>
    override async mergeExisting(storage: EntityStorage, since: Date | undefined, ei: TableOutput, syncMap: SyncMap, trx?: TrxToken): Promise<boolean>
}
```

See also: [EntityBase](./storage.md#class-entitybase), [EntityStorage](./storage.md#type-entitystorage), [StorageProvidedBy](./client.md#type-storageprovidedby), [SyncMap](./storage.md#interface-syncmap), [TableOutput](./storage.md#interface-tableoutput), [TrxToken](./client.md#interface-trxtoken)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Class: EntityOutputBasket

```ts
export class EntityOutputBasket extends EntityBase<TableOutputBasket> {
    constructor(api?: TableOutputBasket)
    get basketId()
    set basketId(v: number)
    get created_at()
    set created_at(v: Date)
    get updated_at()
    set updated_at(v: Date)
    get userId()
    set userId(v: number)
    get name()
    set name(v: string)
    get numberOfDesiredUTXOs()
    set numberOfDesiredUTXOs(v: number)
    get minimumDesiredUTXOValue()
    set minimumDesiredUTXOValue(v: number)
    get isDeleted()
    set isDeleted(v: boolean)
    override get id()
    override set id(v: number)
    override get entityName(): string
    override get entityTable(): string
    override updateApi(): void
    override equals(ei: TableOutputBasket, syncMap?: SyncMap): boolean
    static async mergeFind(storage: EntityStorage, userId: number, ei: TableOutputBasket, syncMap: SyncMap, trx?: TrxToken): Promise<{
        found: boolean;
        eo: EntityOutputBasket;
        eiId: number;
    }>
    override async mergeNew(storage: EntityStorage, userId: number, syncMap: SyncMap, trx?: TrxToken): Promise<void>
    override async mergeExisting(storage: EntityStorage, since: Date | undefined, ei: TableOutputBasket, syncMap: SyncMap, trx?: TrxToken): Promise<boolean>
}
```

See also: [EntityBase](./storage.md#class-entitybase), [EntityStorage](./storage.md#type-entitystorage), [SyncMap](./storage.md#interface-syncmap), [TableOutputBasket](./storage.md#interface-tableoutputbasket), [TrxToken](./client.md#interface-trxtoken)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Class: EntityOutputTag

```ts
export class EntityOutputTag extends EntityBase<TableOutputTag> {
    constructor(api?: TableOutputTag)
    override updateApi(): void
    get outputTagId()
    set outputTagId(v: number)
    get created_at()
    set created_at(v: Date)
    get updated_at()
    set updated_at(v: Date)
    get tag()
    set tag(v: string)
    get userId()
    set userId(v: number)
    get isDeleted()
    set isDeleted(v: boolean)
    override get id(): number
    override set id(v: number)
    override get entityName(): string
    override get entityTable(): string
    override equals(ei: TableOutputTag, syncMap?: SyncMap | undefined): boolean
    static async mergeFind(storage: EntityStorage, userId: number, ei: TableOutputTag, syncMap: SyncMap, trx?: TrxToken): Promise<{
        found: boolean;
        eo: EntityOutputTag;
        eiId: number;
    }>
    override async mergeNew(storage: EntityStorage, userId: number, syncMap: SyncMap, trx?: TrxToken): Promise<void>
    override async mergeExisting(storage: EntityStorage, since: Date | undefined, ei: TableOutputTag, syncMap: SyncMap, trx?: TrxToken): Promise<boolean>
}
```

See also: [EntityBase](./storage.md#class-entitybase), [EntityStorage](./storage.md#type-entitystorage), [SyncMap](./storage.md#interface-syncmap), [TableOutputTag](./storage.md#interface-tableoutputtag), [TrxToken](./client.md#interface-trxtoken)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Class: EntityOutputTagMap

```ts
export class EntityOutputTagMap extends EntityBase<TableOutputTagMap> {
    constructor(api?: TableOutputTagMap)
    override updateApi(): void
    get outputTagId()
    set outputTagId(v: number)
    get outputId()
    set outputId(v: number)
    get created_at()
    set created_at(v: Date)
    get updated_at()
    set updated_at(v: Date)
    get isDeleted()
    set isDeleted(v: boolean)
    override get id(): number
    override get entityName(): string
    override get entityTable(): string
    override equals(ei: TableOutputTagMap, syncMap?: SyncMap | undefined): boolean
    static async mergeFind(storage: EntityStorage, userId: number, ei: TableOutputTagMap, syncMap: SyncMap, trx?: TrxToken): Promise<{
        found: boolean;
        eo: EntityOutputTagMap;
        eiId: number;
    }>
    override async mergeNew(storage: EntityStorage, userId: number, syncMap: SyncMap, trx?: TrxToken): Promise<void>
    override async mergeExisting(storage: EntityStorage, since: Date | undefined, ei: TableOutputTagMap, syncMap: SyncMap, trx?: TrxToken): Promise<boolean>
}
```

See also: [EntityBase](./storage.md#class-entitybase), [EntityStorage](./storage.md#type-entitystorage), [SyncMap](./storage.md#interface-syncmap), [TableOutputTagMap](./storage.md#interface-tableoutputtagmap), [TrxToken](./client.md#interface-trxtoken)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Class: EntityProvenTx

```ts
export class EntityProvenTx extends EntityBase<TableProvenTx> {
    static async fromTxid(txid: string, services: WalletServices, rawTx?: number[]): Promise<ProvenTxFromTxidResult>
    constructor(api?: TableProvenTx)
    override updateApi(): void
    getMerklePath(validateRoots: boolean = true): MerklePath
    _mp?: MerklePath;
    _mpUnchecked?: MerklePath;
    get provenTxId()
    set provenTxId(v: number)
    get created_at()
    set created_at(v: Date)
    get updated_at()
    set updated_at(v: Date)
    get txid()
    set txid(v: string)
    get height()
    set height(v: number)
    get index()
    set index(v: number)
    get merklePath()
    set merklePath(v: number[])
    get rawTx()
    set rawTx(v: number[])
    get blockHash()
    set blockHash(v: string)
    get merkleRoot()
    set merkleRoot(v: string)
    override get id()
    override set id(v: number)
    override get entityName(): string
    override get entityTable(): string
    override equals(ei: TableProvenTx, syncMap?: SyncMap | undefined): boolean
    static async mergeFind(storage: EntityStorage, userId: number, ei: TableProvenTx, syncMap: SyncMap, trx?: TrxToken): Promise<{
        found: boolean;
        eo: EntityProvenTx;
        eiId: number;
    }>
    override async mergeNew(storage: EntityStorage, userId: number, syncMap: SyncMap, trx?: TrxToken): Promise<void>
    override async mergeExisting(storage: EntityStorage, since: Date | undefined, ei: TableProvenTx, syncMap: SyncMap, trx?: TrxToken): Promise<boolean>
    static readonly getProofAttemptsLimit = 8;
    static readonly getProofMinutes = 60;
    static async fromReq(req: EntityProvenTxReq, gmpResult: GetMerklePathResult, countsAsAttempt: boolean, maxRebroadcastAttempts = 0, rootValidator?: MerkleRootValidator): Promise<EntityProvenTx | undefined>
}
```

See also: [EntityBase](./storage.md#class-entitybase), [EntityProvenTxReq](./storage.md#class-entityproventxreq), [EntityStorage](./storage.md#type-entitystorage), [GetMerklePathResult](./client.md#interface-getmerklepathresult), [MerkleRootValidator](./services.md#interface-merklerootvalidator), [ProvenTxFromTxidResult](./storage.md#interface-proventxfromtxidresult), [SyncMap](./storage.md#interface-syncmap), [TableProvenTx](./storage.md#interface-tableproventx), [TrxToken](./client.md#interface-trxtoken), [WalletServices](./client.md#interface-walletservices), [blockHash](./services.md#function-blockhash)

###### Property getProofAttemptsLimit

How high attempts can go before status is forced to invalid

```ts
static readonly getProofAttemptsLimit = 8
```

###### Property getProofMinutes

How many hours we have to try for a poof

```ts
static readonly getProofMinutes = 60
```

###### Method fromReq

Try to create a new ProvenTx from a ProvenTxReq and GetMerkleProofResultApi

Otherwise it returns undefined and updates req.status to either 'unknown', 'invalid', or 'unconfirmed'

```ts
static async fromReq(req: EntityProvenTxReq, gmpResult: GetMerklePathResult, countsAsAttempt: boolean, maxRebroadcastAttempts = 0, rootValidator?: MerkleRootValidator): Promise<EntityProvenTx | undefined>
```
See also: [EntityProvenTx](./storage.md#class-entityproventx), [EntityProvenTxReq](./storage.md#class-entityproventxreq), [GetMerklePathResult](./client.md#interface-getmerklepathresult), [MerkleRootValidator](./services.md#interface-merklerootvalidator)

###### Method fromTxid

Given a txid and optionally its rawTx, create a new ProvenTx object.

rawTx is fetched if not provided.

Only succeeds (proven is not undefined) if a proof is confirmed for rawTx,
and hash of rawTx is confirmed to match txid

The returned ProvenTx and ProvenTxReq objects have not been added to the storage database,
this is optional and can be done by the caller if appropriate.

```ts
static async fromTxid(txid: string, services: WalletServices, rawTx?: number[]): Promise<ProvenTxFromTxidResult>
```
See also: [ProvenTxFromTxidResult](./storage.md#interface-proventxfromtxidresult), [WalletServices](./client.md#interface-walletservices)

###### Method getMerklePath

```ts
getMerklePath(validateRoots: boolean = true): MerklePath
```

Returns

desirialized `MerklePath` object, value is cached.

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Class: EntityProvenTxReq

```ts
export class EntityProvenTxReq extends EntityBase<TableProvenTxReq> {
    static readonly wasBroadcastStatuses: ProvenTxReqStatus[] = ["unmined", "callback", "unconfirmed", "completed"];
    static async fromStorageTxid(storage: EntityStorage, txid: string, trx?: TrxToken): Promise<EntityProvenTxReq | undefined>
    static async fromStorageId(storage: EntityStorage, id: number, trx?: TrxToken): Promise<EntityProvenTxReq>
    static fromTxid(txid: string, rawTx: number[] | Uint8Array, inputBEEF?: number[] | Uint8Array): EntityProvenTxReq
    history: ProvenTxReqHistory;
    notify: ProvenTxReqNotify;
    packApiHistory()
    packApiNotify()
    unpackApiHistory()
    unpackApiNotify()
    get apiHistory(): string
    get apiNotify(): string
    set apiHistory(v: string)
    set apiNotify(v: string)
    updateApi(): void
    unpackApi(): void
    async refreshFromStorage(storage: EntityStorage | WalletStorageManager, trx?: TrxToken): Promise<void>
    constructor(api?: TableProvenTxReq)
    historySince(since: Date): ProvenTxReqHistory
    historyPretty(since?: Date, _indent = 0): string
    prettyNote(note: ReqHistoryNote): string
    getHistorySummary(): ProvenTxReqHistorySummaryApi
    parseHistoryNote(note: ReqHistoryNote, summary?: ProvenTxReqHistorySummaryApi): string
    addNotifyTransactionId(id: number)
    addHistoryNote(note: ReqHistoryNote, noDupes?: boolean)
    async updateStorage(storage: EntityStorage, trx?: TrxToken)
    async updateStorageDynamicProperties(storage: WalletStorageManager | StorageProvider, trx?: TrxToken)
    async insertOrMerge(storage: EntityStorage, trx?: TrxToken): Promise<EntityProvenTxReq>
    get status()
    set status(v: ProvenTxReqStatus)
    get provenTxReqId()
    set provenTxReqId(v: number)
    get created_at()
    set created_at(v: Date)
    get updated_at()
    set updated_at(v: Date)
    get txid()
    set txid(v: string)
    get inputBEEF()
    set inputBEEF(v: number[] | undefined)
    get rawTx()
    set rawTx(v: number[])
    get attempts()
    set attempts(v: number)
    get provenTxId()
    set provenTxId(v: number | undefined)
    get notified()
    set notified(v: boolean)
    get batch()
    set batch(v: string | undefined)
    get wasBroadcast(): boolean
    set wasBroadcast(v: boolean)
    get rebroadcastAttempts(): number
    set rebroadcastAttempts(v: number)
    applyProofTimeout(maxRebroadcastAttempts = 0): {
        action: "invalid" | "rebroadcast";
        rebroadcastAttempts: number;
    }
    override get id()
    override set id(v: number)
    override get entityName(): string
    override get entityTable(): string
    override equals(ei: TableProvenTxReq, syncMap?: SyncMap | undefined): boolean
    static async mergeFind(storage: EntityStorage, userId: number, ei: TableProvenTxReq, syncMap: SyncMap, trx?: TrxToken): Promise<{
        found: boolean;
        eo: EntityProvenTxReq;
        eiId: number;
    }>
    mapNotifyTransactionIds(syncMap: SyncMap): void
    mergeNotifyTransactionIds(ei: TableProvenTxReq, syncMap?: SyncMap): void
    mergeHistory(ei: TableProvenTxReq, syncMap?: SyncMap, noDupes?: boolean): void
    static isTerminalStatus(status: ProvenTxReqStatus): boolean
    override async mergeNew(storage: EntityStorage, userId: number, syncMap: SyncMap, trx?: TrxToken): Promise<void>
    override async mergeExisting(storage: EntityStorage, since: Date | undefined, ei: TableProvenTxReq, syncMap: SyncMap, trx?: TrxToken): Promise<boolean>
}
```

See also: [EntityBase](./storage.md#class-entitybase), [EntityStorage](./storage.md#type-entitystorage), [ProvenTxReqHistory](./storage.md#interface-proventxreqhistory), [ProvenTxReqHistorySummaryApi](./storage.md#interface-proventxreqhistorysummaryapi), [ProvenTxReqNotify](./storage.md#interface-proventxreqnotify), [ProvenTxReqStatus](./client.md#type-proventxreqstatus), [ReqHistoryNote](./client.md#interface-reqhistorynote), [StorageProvider](./storage.md#class-storageprovider), [SyncMap](./storage.md#interface-syncmap), [TableProvenTxReq](./storage.md#interface-tableproventxreq), [TrxToken](./client.md#interface-trxtoken), [WalletStorageManager](./storage.md#class-walletstoragemanager)

###### Method addHistoryNote

Adds a note to history.
Notes with identical property values to an existing note are ignored.

```ts
addHistoryNote(note: ReqHistoryNote, noDupes?: boolean)
```
See also: [ReqHistoryNote](./client.md#interface-reqhistorynote)

Argument Details

+ **note**
  + Note to add
+ **noDupes**
  + if true, only newest note with same `what` value is retained.

###### Method equals

'convergent' equality must satisfy (A sync B) equals (B sync A)

```ts
override equals(ei: TableProvenTxReq, syncMap?: SyncMap | undefined): boolean
```
See also: [SyncMap](./storage.md#interface-syncmap), [TableProvenTxReq](./storage.md#interface-tableproventxreq)

###### Method historySince

Returns history to only what followed since date.

```ts
historySince(since: Date): ProvenTxReqHistory
```
See also: [ProvenTxReqHistory](./storage.md#interface-proventxreqhistory)

###### Method mergeExisting

When merging `ProvenTxReq`, care is taken to avoid short-cirtuiting notification: `status` must not transition to `completed` without
passing through `notifying`. Thus a full convergent merge passes through these sequence steps:
1. Remote storage completes before local storage.
2. The remotely completed req and ProvenTx sync to local storage.
3. The local storage transitions to `notifying`, after merging the remote attempts and history.
4. The local storage notifies, transitioning to `completed`.
5. Having been updated, the local req, but not ProvenTx sync to remote storage, but do not merge because the earlier `completed` wins.
6. Convergent equality is achieved (completing work - history and attempts are equal)

On terminal failure: `doubleSpend` trumps `invalid` as it contains more data.

```ts
override async mergeExisting(storage: EntityStorage, since: Date | undefined, ei: TableProvenTxReq, syncMap: SyncMap, trx?: TrxToken): Promise<boolean>
```
See also: [EntityStorage](./storage.md#type-entitystorage), [SyncMap](./storage.md#interface-syncmap), [TableProvenTxReq](./storage.md#interface-tableproventxreq), [TrxToken](./client.md#interface-trxtoken)

###### Method updateStorage

Updates database record with current state of this EntityUser

```ts
async updateStorage(storage: EntityStorage, trx?: TrxToken)
```
See also: [EntityStorage](./storage.md#type-entitystorage), [TrxToken](./client.md#interface-trxtoken)

###### Method updateStorageDynamicProperties

Update storage with changes to non-static properties:
  updated_at
  provenTxId
  status
  history
  notify
  notified
  attempts
  batch

```ts
async updateStorageDynamicProperties(storage: WalletStorageManager | StorageProvider, trx?: TrxToken)
```
See also: [StorageProvider](./storage.md#class-storageprovider), [TrxToken](./client.md#interface-trxtoken), [WalletStorageManager](./storage.md#class-walletstoragemanager)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Class: EntitySyncState

```ts
export class EntitySyncState extends EntityBase<TableSyncState> {
    constructor(api?: TableSyncState)
    validateSyncMap(sm: SyncMap)
    static async fromStorage(storage: WalletStorageSync, userIdentityKey: string, remoteSettings: TableSettings): Promise<EntitySyncState>
    async updateStorage(storage: EntityStorage, notSyncMap?: boolean, trx?: TrxToken)
    override updateApi(notSyncMap?: boolean): void
    set created_at(v: Date)
    get created_at()
    set updated_at(v: Date)
    get updated_at()
    set userId(v: number)
    get userId()
    set storageIdentityKey(v: string)
    get storageIdentityKey()
    set storageName(v: string)
    get storageName()
    set init(v: boolean)
    get init()
    set refNum(v: string)
    get refNum()
    set status(v: SyncStatus)
    get status(): SyncStatus
    set when(v: Date | undefined)
    get when()
    set satoshis(v: number | undefined)
    get satoshis()
    get apiErrorLocal()
    get apiErrorOther()
    get apiSyncMap()
    override get id(): number
    set id(id: number)
    override get entityName(): string
    override get entityTable(): string
    static mergeIdMap(fromMap: Record<number, number>, toMap: Record<number, number>)
    mergeSyncMap(iSyncMap: SyncMap)
    errorLocal: SyncError | undefined;
    errorOther: SyncError | undefined;
    syncMap: SyncMap;
    override equals(ei: TableSyncState, syncMap?: SyncMap | undefined): boolean
    override async mergeNew(storage: EntityStorage, userId: number, syncMap: SyncMap, trx?: TrxToken): Promise<void>
    override async mergeExisting(storage: EntityStorage, since: Date | undefined, ei: TableSyncState, syncMap: SyncMap, trx?: TrxToken): Promise<boolean>
    makeRequestSyncChunkArgs(forIdentityKey: string, forStorageIdentityKey: string, maxRoughSize?: number, maxItems?: number): RequestSyncChunkArgs
    makeSyncCheckpoint(): SyncCheckpoint
    static syncChunkSummary(c: SyncChunk): string {
        let log = `SYNC CHUNK SUMMARY
  from storage: ${c.fromStorageIdentityKey}
  to storage: ${c.toStorageIdentityKey}
  for user: ${c.userIdentityKey}
`;
        if (c.user != null)
            log += `  USER activeStorage ${c.user.activeStorage}\n`;
        log += formatSyncSection("PROVEN_TXS", c.provenTxs, r => `${r.provenTxId} ${r.txid}`);
        log += formatSyncSection("PROVEN_TX_REQS", c.provenTxReqs, r => `${r.provenTxReqId} ${r.txid} ${r.status} ${r.provenTxId || ""}`);
        log += formatSyncSection("TRANSACTIONS", c.transactions, r => `${r.transactionId} ${r.txid} ${r.status} ${r.provenTxId || ""} sats:${r.satoshis}`);
        log += formatSyncSection("OUTPUTS", c.outputs, r => `${r.outputId} ${r.txid}.${r.vout} ${r.transactionId} ${r.spendable ? "spendable" : ""} sats:${r.satoshis}`);
        return log;
    }
    async processSyncChunk(writer: EntityStorage, args: RequestSyncChunkArgs, chunk: SyncChunk, trx?: TrxToken): Promise<{
        done: boolean;
        maxUpdated_at: Date | undefined;
        updates: number;
        inserts: number;
    }>
}
```

See also: [EntityBase](./storage.md#class-entitybase), [EntityStorage](./storage.md#type-entitystorage), [RequestSyncChunkArgs](./client.md#interface-requestsyncchunkargs), [SyncCheckpoint](./client.md#interface-synccheckpoint), [SyncChunk](./client.md#interface-syncchunk), [SyncError](./storage.md#interface-syncerror), [SyncMap](./storage.md#interface-syncmap), [SyncStatus](./client.md#type-syncstatus), [TableSettings](./storage.md#interface-tablesettings), [TableSyncState](./storage.md#interface-tablesyncstate), [TrxToken](./client.md#interface-trxtoken), [WalletStorageSync](./client.md#interface-walletstoragesync)

###### Method makeSyncCheckpoint

Return progress without the potentially large writer-local ID maps.

```ts
makeSyncCheckpoint(): SyncCheckpoint
```
See also: [SyncCheckpoint](./client.md#interface-synccheckpoint)

###### Method mergeSyncMap

Merge additions to the syncMap

```ts
mergeSyncMap(iSyncMap: SyncMap)
```
See also: [SyncMap](./storage.md#interface-syncmap)

###### Method updateStorage

Handles both insert and update based on id value: zero indicates insert.

```ts
async updateStorage(storage: EntityStorage, notSyncMap?: boolean, trx?: TrxToken)
```
See also: [EntityStorage](./storage.md#type-entitystorage), [TrxToken](./client.md#interface-trxtoken)

Argument Details

+ **notSyncMap**
  + if not new and true, excludes updating syncMap in storage.

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Class: EntityTransaction

```ts
export class EntityTransaction extends EntityBase<TableTransaction> {
    getBsvTx(): BsvTransaction | undefined
    getBsvTxIns(): TransactionInput[]
    async getInputs(storage: EntityStorage, trx?: TrxToken): Promise<TableOutput[]>
    constructor(api?: TableTransaction)
    override updateApi(): void
    get transactionId()
    set transactionId(v: number)
    get created_at()
    set created_at(v: Date)
    get updated_at()
    set updated_at(v: Date)
    get version()
    set version(v: number | undefined)
    get lockTime()
    set lockTime(v: number | undefined)
    get isOutgoing()
    set isOutgoing(v: boolean)
    get status()
    set status(v: TransactionStatus)
    get userId()
    set userId(v: number)
    get provenTxId()
    set provenTxId(v: number | undefined)
    get satoshis()
    set satoshis(v: number)
    get txid()
    set txid(v: string | undefined)
    get reference()
    set reference(v: string)
    get inputBEEF()
    set inputBEEF(v: number[] | undefined)
    get description()
    set description(v: string)
    get rawTx()
    set rawTx(v: number[] | undefined)
    get noSendExpiryMode()
    set noSendExpiryMode(v)
    get noSendExpiryValue()
    set noSendExpiryValue(v)
    get noSendExpiryDeadline()
    set noSendExpiryDeadline(v)
    get noSendExpiryState()
    set noSendExpiryState(v)
    get noSendExpiryAnchorTxid()
    set noSendExpiryAnchorTxid(v)
    get noSendExpiryAnchorVout()
    set noSendExpiryAnchorVout(v)
    get noSendExpiryReleasedAt()
    set noSendExpiryReleasedAt(v)
    get noSendExpiryObservedAt()
    set noSendExpiryObservedAt(v)
    get noSendExpiryReclaimTxid()
    set noSendExpiryReclaimTxid(v)
    get noSendExpiryReclaimRawTx()
    set noSendExpiryReclaimRawTx(v)
    get noSendExpiryReclaimDerivationPrefix()
    set noSendExpiryReclaimDerivationPrefix(v)
    get noSendExpiryReclaimDerivationSuffix()
    set noSendExpiryReclaimDerivationSuffix(v)
    get noSendExpiryReclaimSatoshis()
    set noSendExpiryReclaimSatoshis(v)
    override get id(): number
    override set id(v: number)
    override get entityName(): string
    override get entityTable(): string
    override equals(ei: TableTransaction, syncMap?: SyncMap | undefined): boolean
    static async mergeFind(storage: EntityStorage, userId: number, ei: TableTransaction, syncMap: SyncMap, trx?: TrxToken): Promise<{
        found: boolean;
        eo: EntityTransaction;
        eiId: number;
    }>
    override async mergeNew(storage: EntityStorage, userId: number, syncMap: SyncMap, trx?: TrxToken): Promise<void>
    override async mergeExisting(storage: EntityStorage, since: Date | undefined, ei: TableTransaction, syncMap: SyncMap, trx?: TrxToken): Promise<boolean>
    async getProvenTx(storage: EntityStorage, trx?: TrxToken): Promise<EntityProvenTx | undefined>
}
```

See also: [EntityBase](./storage.md#class-entitybase), [EntityProvenTx](./storage.md#class-entityproventx), [EntityStorage](./storage.md#type-entitystorage), [SyncMap](./storage.md#interface-syncmap), [TableOutput](./storage.md#interface-tableoutput), [TableTransaction](./storage.md#interface-tabletransaction), [TransactionStatus](./client.md#type-transactionstatus), [TrxToken](./client.md#interface-trxtoken)

###### Method getBsvTxIns

```ts
getBsvTxIns(): TransactionInput[]
```

Returns

array of

###### Method getInputs

Returns an array of "known" inputs to this transaction which belong to the same userId.
Uses both spentBy and rawTx inputs (if available) to locate inputs from among user's outputs.
Not all transaction inputs correspond to prior storage outputs.

```ts
async getInputs(storage: EntityStorage, trx?: TrxToken): Promise<TableOutput[]>
```
See also: [EntityStorage](./storage.md#type-entitystorage), [TableOutput](./storage.md#interface-tableoutput), [TrxToken](./client.md#interface-trxtoken)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Class: EntityTxLabel

```ts
export class EntityTxLabel extends EntityBase<TableTxLabel> {
    constructor(api?: TableTxLabel)
    override updateApi(): void
    get txLabelId()
    set txLabelId(v: number)
    get created_at()
    set created_at(v: Date)
    get updated_at()
    set updated_at(v: Date)
    get label()
    set label(v: string)
    get userId()
    set userId(v: number)
    get isDeleted()
    set isDeleted(v: boolean)
    override get id(): number
    override set id(v: number)
    override get entityName(): string
    override get entityTable(): string
    override equals(ei: TableTxLabel, syncMap?: SyncMap): boolean
    static async mergeFind(storage: EntityStorage, userId: number, ei: TableTxLabel, syncMap: SyncMap, trx?: TrxToken): Promise<{
        found: boolean;
        eo: EntityTxLabel;
        eiId: number;
    }>
    override async mergeNew(storage: EntityStorage, userId: number, syncMap: SyncMap, trx?: TrxToken): Promise<void>
    override async mergeExisting(storage: EntityStorage, since: Date | undefined, ei: TableTxLabel, syncMap: SyncMap, trx?: TrxToken): Promise<boolean>
}
```

See also: [EntityBase](./storage.md#class-entitybase), [EntityStorage](./storage.md#type-entitystorage), [SyncMap](./storage.md#interface-syncmap), [TableTxLabel](./storage.md#interface-tabletxlabel), [TrxToken](./client.md#interface-trxtoken)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Class: EntityTxLabelMap

```ts
export class EntityTxLabelMap extends EntityBase<TableTxLabelMap> {
    constructor(api?: TableTxLabelMap)
    override updateApi(): void
    get txLabelId()
    set txLabelId(v: number)
    get transactionId()
    set transactionId(v: number)
    get created_at()
    set created_at(v: Date)
    get updated_at()
    set updated_at(v: Date)
    get isDeleted()
    set isDeleted(v: boolean)
    override get id(): number
    override get entityName(): string
    override get entityTable(): string
    override equals(ei: TableTxLabelMap, syncMap?: SyncMap | undefined): boolean
    static async mergeFind(storage: EntityStorage, userId: number, ei: TableTxLabelMap, syncMap: SyncMap, trx?: TrxToken): Promise<{
        found: boolean;
        eo: EntityTxLabelMap;
        eiId: number;
    }>
    override async mergeNew(storage: EntityStorage, userId: number, syncMap: SyncMap, trx?: TrxToken): Promise<void>
    override async mergeExisting(storage: EntityStorage, since: Date | undefined, ei: TableTxLabelMap, syncMap: SyncMap, trx?: TrxToken): Promise<boolean>
}
```

See also: [EntityBase](./storage.md#class-entitybase), [EntityStorage](./storage.md#type-entitystorage), [SyncMap](./storage.md#interface-syncmap), [TableTxLabelMap](./storage.md#interface-tabletxlabelmap), [TrxToken](./client.md#interface-trxtoken)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Class: EntityUser

```ts
export class EntityUser extends EntityBase<TableUser> {
    constructor(api?: TableUser)
    override updateApi(): void
    get userId()
    set userId(v: number)
    get created_at()
    set created_at(v: Date)
    get updated_at()
    set updated_at(v: Date)
    get identityKey()
    set identityKey(v: string)
    get activeStorage()
    set activeStorage(v: string)
    override get id(): number
    override set id(v: number)
    override get entityName(): string
    override get entityTable(): string
    override equals(ei: TableUser, syncMap?: SyncMap | undefined): boolean
    static async mergeFind(storage: EntityStorage, userId: number, ei: TableUser, trx?: TrxToken): Promise<{
        found: boolean;
        eo: EntityUser;
        eiId: number;
    }>
    override async mergeNew(storage: EntityStorage, userId: number, syncMap: SyncMap, trx?: TrxToken): Promise<void>
    override async mergeExisting(storage: EntityStorage, since: Date | undefined, ei: TableUser, syncMap?: SyncMap, trx?: TrxToken): Promise<boolean>
}
```

See also: [EntityBase](./storage.md#class-entitybase), [EntityStorage](./storage.md#type-entitystorage), [SyncMap](./storage.md#interface-syncmap), [TableUser](./storage.md#interface-tableuser), [TrxToken](./client.md#interface-trxtoken)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Class: KnexMigrations

```ts
export class KnexMigrations implements MigrationSource<string> {
    migrations: Record<string, Migration> = {};
    constructor(public chain: Chain, public storageName: string, public storageIdentityKey: string, public maxOutputScriptLength: number)
    async getMigrations(): Promise<string[]>
    getMigrationName(migration: string)
    async getMigration(migration: string): Promise<Migration>
    async getLatestMigration(): Promise<string>
    static async latestMigration(): Promise<string>
    setupMigrations(chain: string, storageName: string, storageIdentityKey: string, maxOutputScriptLength: number): Record<string, Migration>
}
```

See also: [Chain](./client.md#type-chain)

###### Constructor

```ts
constructor(public chain: Chain, public storageName: string, public storageIdentityKey: string, public maxOutputScriptLength: number)
```
See also: [Chain](./client.md#type-chain)

Argument Details

+ **storageName**
  + human readable name for this storage instance
+ **maxOutputScriptLength**
  + limit for scripts kept in outputs table, longer scripts will be pulled from rawTx

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Class: KnexPaymentReplayStore

Durable, replica-safe BRC-105 transaction replay claims.

```ts
export class KnexPaymentReplayStore implements PaymentReplayStore {
    constructor(private readonly knex: Knex, private readonly ttlDays: number = 365)
    async claim(transactionId: string): Promise<boolean>
    async pruneExpired(now = new Date()): Promise<number>
}
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Class: KnexSessionManager

Shared BRC-103 session storage for horizontally scaled StorageServer nodes.

Every instance must use the same Knex database. The wallet-toolbox migration
creates the required `auth_sessions` and `auth_message_nonces` tables. The
nonce table atomically rejects replay across replicas. Writes are monotonic
by `PeerSession.lastUpdate`, preventing a delayed request on one replica from
replacing newer session state written by another replica.

```ts
export class KnexSessionManager implements AsyncSessionManager {
    constructor(private readonly knex: Knex, options: KnexSessionManagerOptions = {})
    async addSession(session: PeerSession): Promise<void>
    async updateSession(session: PeerSession): Promise<void>
    async getSession(identifier: string): Promise<PeerSession | undefined>
    async removeSession(session: PeerSession): Promise<void>
    async hasSession(identifier: string): Promise<boolean>
    async claimMessageNonce(sessionNonce: string, messageNonce: string): Promise<boolean>
    async claimInitialRequestNonce(identityKey: string, initialNonce: string): Promise<boolean>
    async pruneExpiredSessions(): Promise<number>
}
```

See also: [KnexSessionManagerOptions](./storage.md#interface-knexsessionmanageroptions)

###### Method claimInitialRequestNonce

Atomically reject replayed unsigned initial requests across replicas.

```ts
async claimInitialRequestNonce(identityKey: string, initialNonce: string): Promise<boolean>
```

###### Method claimMessageNonce

Atomically reject reuse of a signed BRC-103 message nonce across replicas.

```ts
async claimMessageNonce(sessionNonce: string, messageNonce: string): Promise<boolean>
```

###### Method pruneExpiredSessions

Delete expired rows. Call from an operator-controlled maintenance task.

```ts
async pruneExpiredSessions(): Promise<number>
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Class: KnexSyncTransferStore

Durable, identity-scoped staging in the wallet database; never part of exported wallet data.

```ts
export class KnexSyncTransferStore {
    constructor(private readonly knex: Knex, readonly capabilities: SyncTransferCapabilities)
    async beginRead(identityKey: string, context: string, bytes: Uint8Array): Promise<SyncTransferManifest>
    async beginWrite(identityKey: string, digest: string, totalBytes: number): Promise<SyncTransferManifest & {
        receivedBytes: number;
    }>
    async read(identityKey: string, transferId: string, offset: number): Promise<SyncTransferPart>
    async write(identityKey: string, transferId: string, offset: number, bytes: Uint8Array): Promise<number>
    async loadWrite(identityKey: string, transferId: string): Promise<{
        bytes: Uint8Array;
        result?: unknown;
    }>
    async complete(identityKey: string, transferId: string, result: unknown): Promise<void>
    async release(identityKey: string, transferId: string): Promise<void>
}
```

See also: [SyncTransferCapabilities](./storage.md#interface-synctransfercapabilities), [SyncTransferManifest](./storage.md#interface-synctransfermanifest), [SyncTransferPart](./storage.md#interface-synctransferpart)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Class: MergeEntity

```ts
export class MergeEntity<API extends EntityTimeStamp, DE extends EntityBase<API>> {
    idMap: Record<number, number>;
    constructor(public stateArray: API[] | undefined, public find: (storage: EntityStorage, userId: number, ei: API, syncMap: SyncMap, trx?: TrxToken) => Promise<{
        found: boolean;
        eo: DE;
        eiId: number;
    }>, public esm: EntitySyncMap)
    updateSyncMap(map: Record<number, number>, inId: number, outId: number)
    async merge(since: Date | undefined, storage: EntityStorage, userId: number, syncMap: SyncMap, trx?: TrxToken): Promise<{
        inserts: number;
        updates: number;
    }>
}
```

See also: [EntityBase](./storage.md#class-entitybase), [EntityStorage](./storage.md#type-entitystorage), [EntitySyncMap](./storage.md#interface-entitysyncmap), [EntityTimeStamp](./client.md#interface-entitytimestamp), [SyncMap](./storage.md#interface-syncmap), [TrxToken](./client.md#interface-trxtoken)

###### Method merge

```ts
async merge(since: Date | undefined, storage: EntityStorage, userId: number, syncMap: SyncMap, trx?: TrxToken): Promise<{
    inserts: number;
    updates: number;
}>
```
See also: [EntityStorage](./storage.md#type-entitystorage), [SyncMap](./storage.md#interface-syncmap), [TrxToken](./client.md#interface-trxtoken)

Argument Details

+ **since**
  + date of current sync chunk

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Class: PreparedBeefCoordinator

Bounded, best-effort COOK worker. No foreground caller awaits this queue.
Dropped or failed work is safe because canonical storage remains the source
of truth and the normal BEEF builder remains the read-path fallback.

```ts
export class PreparedBeefCoordinator {
    constructor(private readonly storage: PreparedBeefStorage)
    enqueue(preparation: PreparedBeefPreparation): boolean
    startBackfill(): void
    async waitForIdle(): Promise<void>
    async stop(): Promise<void>
}
```

See also: [PreparedBeefPreparation](./storage.md#interface-preparedbeefpreparation), [PreparedBeefStorage](./storage.md#interface-preparedbeefstorage)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Class: StaleSyncProofError

Identifies a structurally valid proof which needs current-chain reconciliation.

```ts
export class StaleSyncProofError extends WERR_INVALID_PARAMETER {
    constructor()
}
```

See also: [WERR_INVALID_PARAMETER](./client.md#class-werr_invalid_parameter)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Class: StorageClient

`StorageClient` implements the `WalletStorageProvider` interface which allows it to
serve as a BRC-100 wallet's active storage.

Internally, it uses JSON-RPC over HTTPS to make requests of a remote server.
Typically this server uses the `StorageServer` class to implement the service.

The `AuthFetch` component is used to secure and authenticate the requests to the remote server.

`AuthFetch` is initialized with a BRC-100 wallet which establishes the identity of
the party making requests of the remote service. Responses must complete mutual
authentication. By default, the first authenticated server identity is trusted for
this client instance; callers can instead supply `serverIdentityKey` as an
independently validated pin. The distinct storage-provider identity advertised by
the authenticated `makeAvailable` response is authoritative by default; callers
can independently pin it with `storageIdentityKey`.

For details of the API implemented, follow the "See also" link for the `WalletStorageProvider` interface.

```ts
export class StorageClient extends StorageClientBase {
    constructor(wallet: WalletInterface, endpointUrl: string, options: StorageClientOptions = {})
    protected async rpcCall<T>(method: string, params: unknown[]): Promise<T>
}
```

See also: [StorageClientBase](./storage.md#class-storageclientbase), [StorageClientOptions](./storage.md#interface-storageclientoptions)

###### Method rpcCall

Make a JSON-RPC call to the remote server.

```ts
protected async rpcCall<T>(method: string, params: unknown[]): Promise<T>
```

Argument Details

+ **method**
  + The WalletStorage method name to call.
+ **params**
  + The array of parameters to pass to the method in order.

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Class: StorageClientBase

Abstract base class shared by `StorageClient` and `StorageMobile`.

Contains all `WalletStorageProvider` method implementations and entity-validation
helpers. Subclasses only need to provide `rpcCall`, which differs between
the full (logger-aware) and mobile (lightweight) variants.

```ts
export abstract class StorageClientBase implements WalletStorageProvider {
    readonly endpointUrl: string;
    protected readonly authClient: AuthFetch;
    protected nextId = 1;
    protected serverSupportsBinary = false;
    protected readonly binaryRequests: boolean;
    protected readonly telemetry: Telemetry;
    onSyncTransferProgress?: (progress: {
        direction: "read" | "write";
        bytes: number;
        totalBytes: number;
    }) => void;
    public settings?: RemoteStorageSettings;
    constructor(wallet: WalletInterface, endpointUrl: string, options: StorageClientOptions = {})
    protected async authenticatedFetch(url: string, config: Parameters<AuthFetch["fetch"]>[1]): Promise<Response>
    protected async traceRpcCall<T>(method: string, params: unknown[], callback: (span?: TelemetrySpan) => Promise<T>): Promise<T>
    protected async traceRpcStep<T>(name: string, parent: TelemetrySpan | undefined, callback: (span?: TelemetrySpan) => Promise<T> | T, attributes?: Readonly<Record<string, unknown>>): Promise<T>
    isStorageProvider(): boolean
    protected abstract rpcCall<T>(method: string, params: unknown[]): Promise<T>;
    protected nextRequestId(): number
    isAvailable(): boolean
    getSettings(): RemoteStorageSettings
    async makeAvailable(): Promise<RemoteStorageSettings>
    async destroy(): Promise<void>
    async migrate(storageName: string, _storageIdentityKey: string): Promise<string>
    getServices(): WalletServices
    setServices(_v: WalletServices): void
    async internalizeAction(auth: AuthId, args: InternalizeActionArgs): Promise<StorageInternalizeActionResult>
    async createAction(auth: AuthId, args: Validation.ValidCreateActionArgs): Promise<StorageCreateActionResult>
    async processAction(auth: AuthId, args: StorageProcessActionArgs): Promise<StorageProcessActionResults>
    async prepareNoSendExpiry(auth: AuthId, args: Validation.ValidCreateActionArgs): Promise<StoragePrepareNoSendExpiryResult>
    async activateNoSendExpiry(auth: AuthId, args: StorageActivateNoSendExpiryArgs): Promise<StorageActivateNoSendExpiryResult>
    async armNoSendExpiry(auth: AuthId, args: StorageArmNoSendExpiryArgs): Promise<void>
    async getCapabilities(): Promise<StorageCapabilities>
    async beginActionBatch(auth: AuthId, args: BeginActionBatchArgs): Promise<BeginActionBatchResult>
    async extendActionBatch(auth: AuthId, args: ExtendActionBatchArgs): Promise<ExtendActionBatchResult>
    async renewActionBatch(auth: AuthId, batchId: string): Promise<RenewActionBatchResult>
    async resumeActionBatch(auth: AuthId, args: ResumeActionBatchArgs): Promise<ResumeActionBatchResult>
    async prepareActionBatchCommit(auth: AuthId, manifest: ActionBatchManifest): Promise<PrepareActionBatchCommitResult>
    async putActionBatchBlob(auth: AuthId, args: PutActionBatchBlobArgs): Promise<void>
    async putActionBatchPack(_auth: AuthId, args: PutActionBatchPackArgs): Promise<void>
    async commitActionBatch(auth: AuthId, manifest: ActionBatchManifest): Promise<CommitActionBatchResult>
    async commitActionBatchByDigest(auth: AuthId, args: CommitActionBatchByDigestArgs): Promise<CommitActionBatchResult>
    async abortActionBatch(auth: AuthId, batchId: string): Promise<AbortActionBatchResult>
    async abortAction(auth: AuthId, args: AbortActionArgs): Promise<AbortActionResult>
    async findOrInsertUser(identityKey: string): Promise<{
        user: TableUser;
        isNew: boolean;
    }>
    async getSyncCheckpoint(auth: AuthId, storageIdentityKey: string, storageName: string): Promise<SyncCheckpoint | undefined>
    async findOrInsertSyncStateAuth(auth: AuthId, storageIdentityKey: string, storageName: string): Promise<{
        syncState: TableSyncState;
        isNew: boolean;
    }>
    async insertCertificateAuth(auth: AuthId, certificate: TableCertificateX): Promise<number>
    async listActions(auth: AuthId, vargs: Validation.ValidListActionsArgs): Promise<ListActionsResult>
    async listOutputs(auth: AuthId, vargs: Validation.ValidListOutputsArgs): Promise<ListOutputsResult>
    async listCertificates(auth: AuthId, vargs: Validation.ValidListCertificatesArgs): Promise<ListCertificatesResult>
    async findCertificatesAuth(auth: AuthId, args: FindCertificatesArgs): Promise<TableCertificateX[]>
    async findOutputBasketsAuth(auth: AuthId, args: FindOutputBasketsArgs): Promise<TableOutputBasket[]>
    async findOutputsAuth(auth: AuthId, args: FindOutputsArgs): Promise<TableOutput[]>
    async findProvenTxReqs(args: FindProvenTxReqsArgs): Promise<TableProvenTxReq[]>
    async relinquishCertificate(auth: AuthId, args: RelinquishCertificateArgs): Promise<number>
    async relinquishOutput(auth: AuthId, args: RelinquishOutputArgs): Promise<number>
    async processSyncChunk(args: RequestSyncChunkArgs, chunk: SyncChunk): Promise<ProcessSyncChunkResult>
    async getSyncChunk(args: RequestSyncChunkArgs): Promise<SyncChunk>
    protected requestUsesBinary(method: string): boolean
    protected rpcResponseError(response: Response): Error
    async updateProvenTxReqWithNewProvenTx(args: UpdateProvenTxReqWithNewProvenTxArgs): Promise<UpdateProvenTxReqWithNewProvenTxResult>
    async setActive(auth: AuthId, newActiveStorageIdentityKey: string): Promise<number>
    validateDate(date: Date | string | number): Date
    validateEntity<T extends EntityTimeStamp>(entity: T, dateFields?: string[]): T
    validateEntities<T extends EntityTimeStamp>(entities: T[], dateFields?: string[]): T[]
}
```

See also: [AbortActionBatchResult](./client.md#interface-abortactionbatchresult), [ActionBatchManifest](./client.md#interface-actionbatchmanifest), [AuthId](./client.md#interface-authid), [BeginActionBatchArgs](./client.md#interface-beginactionbatchargs), [BeginActionBatchResult](./client.md#interface-beginactionbatchresult), [CommitActionBatchByDigestArgs](./client.md#interface-commitactionbatchbydigestargs), [CommitActionBatchResult](./client.md#interface-commitactionbatchresult), [EntityTimeStamp](./client.md#interface-entitytimestamp), [ExtendActionBatchArgs](./client.md#interface-extendactionbatchargs), [ExtendActionBatchResult](./client.md#interface-extendactionbatchresult), [FindCertificatesArgs](./client.md#interface-findcertificatesargs), [FindOutputBasketsArgs](./client.md#interface-findoutputbasketsargs), [FindOutputsArgs](./client.md#interface-findoutputsargs), [FindProvenTxReqsArgs](./client.md#interface-findproventxreqsargs), [PrepareActionBatchCommitResult](./client.md#interface-prepareactionbatchcommitresult), [ProcessSyncChunkResult](./client.md#interface-processsyncchunkresult), [PutActionBatchBlobArgs](./client.md#interface-putactionbatchblobargs), [PutActionBatchPackArgs](./client.md#interface-putactionbatchpackargs), [RenewActionBatchResult](./client.md#interface-renewactionbatchresult), [RequestSyncChunkArgs](./client.md#interface-requestsyncchunkargs), [ResumeActionBatchArgs](./client.md#interface-resumeactionbatchargs), [ResumeActionBatchResult](./client.md#interface-resumeactionbatchresult), [StorageActivateNoSendExpiryArgs](./client.md#interface-storageactivatenosendexpiryargs), [StorageActivateNoSendExpiryResult](./client.md#interface-storageactivatenosendexpiryresult), [StorageArmNoSendExpiryArgs](./client.md#interface-storagearmnosendexpiryargs), [StorageCapabilities](./client.md#interface-storagecapabilities), [StorageClientOptions](./storage.md#interface-storageclientoptions), [StorageCreateActionResult](./client.md#interface-storagecreateactionresult), [StorageInternalizeActionResult](./client.md#interface-storageinternalizeactionresult), [StoragePrepareNoSendExpiryResult](./client.md#interface-storagepreparenosendexpiryresult), [StorageProcessActionArgs](./client.md#interface-storageprocessactionargs), [StorageProcessActionResults](./client.md#interface-storageprocessactionresults), [SyncCheckpoint](./client.md#interface-synccheckpoint), [SyncChunk](./client.md#interface-syncchunk), [TableCertificateX](./storage.md#interface-tablecertificatex), [TableOutput](./storage.md#interface-tableoutput), [TableOutputBasket](./storage.md#interface-tableoutputbasket), [TableProvenTxReq](./storage.md#interface-tableproventxreq), [TableSyncState](./storage.md#interface-tablesyncstate), [TableUser](./storage.md#interface-tableuser), [UpdateProvenTxReqWithNewProvenTxArgs](./client.md#interface-updateproventxreqwithnewproventxargs), [UpdateProvenTxReqWithNewProvenTxResult](./client.md#interface-updateproventxreqwithnewproventxresult), [WalletServices](./client.md#interface-walletservices), [WalletStorageProvider](./client.md#interface-walletstorageprovider), [abortActionBatch](./storage.md#function-abortactionbatch), [activateNoSendExpiry](./storage.md#function-activatenosendexpiry), [armNoSendExpiry](./storage.md#function-armnosendexpiry), [beginActionBatch](./storage.md#function-beginactionbatch), [commitActionBatch](./storage.md#function-commitactionbatch), [commitActionBatchByDigest](./storage.md#function-commitactionbatchbydigest), [createAction](./storage.md#function-createaction), [extendActionBatch](./storage.md#function-extendactionbatch), [getSyncChunk](./storage.md#function-getsyncchunk), [internalizeAction](./storage.md#function-internalizeaction), [listActions](./storage.md#function-listactions), [listCertificates](./storage.md#function-listcertificates), [listOutputs](./storage.md#function-listoutputs), [prepareActionBatchCommit](./storage.md#function-prepareactionbatchcommit), [prepareNoSendExpiry](./storage.md#function-preparenosendexpiry), [processAction](./storage.md#function-processaction), [putActionBatchBlob](./storage.md#function-putactionbatchblob), [putActionBatchPack](./storage.md#function-putactionbatchpack), [renewActionBatch](./storage.md#function-renewactionbatch), [resumeActionBatch](./storage.md#function-resumeactionbatch), [validateDate](./storage.md#function-validatedate), [validateEntities](./storage.md#function-validateentities), [validateEntity](./storage.md#function-validateentity)

###### Property onSyncTransferProgress

Optional progress/cancellation hook for a bounded transfer; never receives wallet contents.

```ts
onSyncTransferProgress?: (progress: {
    direction: "read" | "write";
    bytes: number;
    totalBytes: number;
}) => void
```

###### Method abortAction

Aborts an action by `reference` string.

```ts
async abortAction(auth: AuthId, args: AbortActionArgs): Promise<AbortActionResult>
```
See also: [AuthId](./client.md#interface-authid)

Returns

`abortAction` result.

Argument Details

+ **auth**
  + Identifies client by identity key and the storage identity key of their currently active storage.
This must match the `AuthFetch` identity securing the remote conneciton.
+ **args**
  + original wallet `abortAction` args.

###### Method createAction

Storage level processing for wallet `createAction`.

```ts
async createAction(auth: AuthId, args: Validation.ValidCreateActionArgs): Promise<StorageCreateActionResult>
```
See also: [AuthId](./client.md#interface-authid), [StorageCreateActionResult](./client.md#interface-storagecreateactionresult)

Returns

`StorageCreateActionResults` supporting additional wallet processing to yield `createAction` results.

Argument Details

+ **auth**
  + Identifies client by identity key and the storage identity key of their currently active storage.
This must match the `AuthFetch` identity securing the remote conneciton.
+ **args**
  + Validated extension of original wallet `createAction` arguments.

###### Method destroy

Called to cleanup resources when no further use of this object will occur.

```ts
async destroy(): Promise<void>
```

###### Method findCertificatesAuth

Find user certificates, optionally with fields.

This certificate retrieval method supports internal wallet operations.
Field values are stored and retrieved encrypted.

```ts
async findCertificatesAuth(auth: AuthId, args: FindCertificatesArgs): Promise<TableCertificateX[]>
```
See also: [AuthId](./client.md#interface-authid), [FindCertificatesArgs](./client.md#interface-findcertificatesargs), [TableCertificateX](./storage.md#interface-tablecertificatex)

Returns

array of certificates matching args.

Argument Details

+ **auth**
  + Identifies client by identity key and the storage identity key of their currently active storage.
This must match the `AuthFetch` identity securing the remote conneciton.
+ **args**
  + `FindCertificatesArgs` determines which certificates to retrieve and whether to include fields.

###### Method findOrInsertSyncStateAuth

Used to both find and insert a `TableSyncState` record for the user to track wallet data replication across storage providers.

```ts
async findOrInsertSyncStateAuth(auth: AuthId, storageIdentityKey: string, storageName: string): Promise<{
    syncState: TableSyncState;
    isNew: boolean;
}>
```
See also: [AuthId](./client.md#interface-authid), [TableSyncState](./storage.md#interface-tablesyncstate)

Returns

`TableSyncState` and whether a new record was created.

Argument Details

+ **auth**
  + Identifies client by identity key and the storage identity key of their currently active storage.
This must match the `AuthFetch` identity securing the remote conneciton.
+ **storageName**
  + the name of the remote storage being sync'd
+ **storageIdentityKey**
  + the identity key of the remote storage being sync'd

###### Method findOrInsertUser

Used to both find and initialize a new user by identity key.
It is up to the remote storage whether to allow creation of new users by this method.

```ts
async findOrInsertUser(identityKey: string): Promise<{
    user: TableUser;
    isNew: boolean;
}>
```
See also: [TableUser](./storage.md#interface-tableuser)

Returns

`TableUser` for the user and whether a new user was created.

Argument Details

+ **identityKey**
  + of the user.

###### Method findOutputBasketsAuth

Find output baskets.

This retrieval method supports internal wallet operations.

```ts
async findOutputBasketsAuth(auth: AuthId, args: FindOutputBasketsArgs): Promise<TableOutputBasket[]>
```
See also: [AuthId](./client.md#interface-authid), [FindOutputBasketsArgs](./client.md#interface-findoutputbasketsargs), [TableOutputBasket](./storage.md#interface-tableoutputbasket)

Returns

array of output baskets matching args.

Argument Details

+ **auth**
  + Identifies client by identity key and the storage identity key of their currently active storage.
This must match the `AuthFetch` identity securing the remote conneciton.
+ **args**
  + `FindOutputBasketsArgs` determines which baskets to retrieve.

###### Method findOutputsAuth

Find outputs.

This retrieval method supports internal wallet operations.

```ts
async findOutputsAuth(auth: AuthId, args: FindOutputsArgs): Promise<TableOutput[]>
```
See also: [AuthId](./client.md#interface-authid), [FindOutputsArgs](./client.md#interface-findoutputsargs), [TableOutput](./storage.md#interface-tableoutput)

Returns

array of outputs matching args.

Argument Details

+ **auth**
  + Identifies client by identity key and the storage identity key of their currently active storage.
This must match the `AuthFetch` identity securing the remote conneciton.
+ **args**
  + `FindOutputsArgs` determines which outputs to retrieve.

###### Method findProvenTxReqs

Find requests for transaction proofs.

This retrieval method supports internal wallet operations.

```ts
async findProvenTxReqs(args: FindProvenTxReqsArgs): Promise<TableProvenTxReq[]>
```
See also: [FindProvenTxReqsArgs](./client.md#interface-findproventxreqsargs), [TableProvenTxReq](./storage.md#interface-tableproventxreq)

Returns

array of proof requests matching args.

Argument Details

+ **auth**
  + Identifies client by identity key and the storage identity key of their currently active storage.
This must match the `AuthFetch` identity securing the remote conneciton.
+ **args**
  + `FindProvenTxReqsArgs` determines which proof requests to retrieve.

###### Method getServices

Remote storage does not offer `Services` to remote clients.

```ts
getServices(): WalletServices
```
See also: [WalletServices](./client.md#interface-walletservices)

Throws

WERR_INVALID_OPERATION

###### Method getSettings

```ts
getSettings(): RemoteStorageSettings
```

Returns

remote storage `TableSettings` if they have been retreived by `makeAvailable`.

Throws

WERR_INVALID_OPERATION if `makeAvailable` has not yet been called.

###### Method getSyncCheckpoint

Read compact progress only when the provider advertises support.

```ts
async getSyncCheckpoint(auth: AuthId, storageIdentityKey: string, storageName: string): Promise<SyncCheckpoint | undefined>
```
See also: [AuthId](./client.md#interface-authid), [SyncCheckpoint](./client.md#interface-synccheckpoint)

###### Method getSyncChunk

Request a "chunk" of replication data for a specific user and storage provider.

The normal data flow is for the active storage to push backups as a sequence of data chunks to backup storage providers.
Also supports recovery where non-active storage can attempt to merge available data prior to becoming active.

```ts
async getSyncChunk(args: RequestSyncChunkArgs): Promise<SyncChunk>
```
See also: [RequestSyncChunkArgs](./client.md#interface-requestsyncchunkargs), [SyncChunk](./client.md#interface-syncchunk)

Returns

the next "chunk" of replication data

Argument Details

+ **args**
  + that identify the non-active storage which will receive replication data and constrains the replication process.

###### Method insertCertificateAuth

Inserts a new certificate with fields and keyring into remote storage.

```ts
async insertCertificateAuth(auth: AuthId, certificate: TableCertificateX): Promise<number>
```
See also: [AuthId](./client.md#interface-authid), [TableCertificateX](./storage.md#interface-tablecertificatex)

Returns

record Id of the inserted `TableCertificate` record.

Argument Details

+ **auth**
  + Identifies client by identity key and the storage identity key of their currently active storage.
This must match the `AuthFetch` identity securing the remote conneciton.
+ **certificate**
  + the certificate to insert.

###### Method internalizeAction

Storage level processing for wallet `internalizeAction`.
Updates internalized outputs in remote storage.
Triggers proof validation of containing transaction.

```ts
async internalizeAction(auth: AuthId, args: InternalizeActionArgs): Promise<StorageInternalizeActionResult>
```
See also: [AuthId](./client.md#interface-authid), [StorageInternalizeActionResult](./client.md#interface-storageinternalizeactionresult)

Returns

`internalizeAction` results

Argument Details

+ **auth**
  + Identifies client by identity key and the storage identity key of their currently active storage.
This must match the `AuthFetch` identity securing the remote conneciton.
+ **args**
  + Original wallet `internalizeAction` arguments.

###### Method isAvailable

```ts
isAvailable(): boolean
```

Returns

true once storage `TableSettings` have been retreived from remote storage.

###### Method isStorageProvider

The `StorageClient` implements the `WalletStorageProvider` interface.
It does not implement the lower level `StorageProvider` interface.

```ts
isStorageProvider(): boolean
```

Returns

false

###### Method listActions

Storage level processing for wallet `listActions`.

```ts
async listActions(auth: AuthId, vargs: Validation.ValidListActionsArgs): Promise<ListActionsResult>
```
See also: [AuthId](./client.md#interface-authid)

Returns

`listActions` results.

Argument Details

+ **auth**
  + Identifies client by identity key and the storage identity key of their currently active storage.
This must match the `AuthFetch` identity securing the remote conneciton.
+ **args**
  + Validated extension of original wallet `listActions` arguments.

###### Method listCertificates

Storage level processing for wallet `listCertificates`.

```ts
async listCertificates(auth: AuthId, vargs: Validation.ValidListCertificatesArgs): Promise<ListCertificatesResult>
```
See also: [AuthId](./client.md#interface-authid)

Returns

`listCertificates` results.

Argument Details

+ **auth**
  + Identifies client by identity key and the storage identity key of their currently active storage.
This must match the `AuthFetch` identity securing the remote conneciton.
+ **args**
  + Validated extension of original wallet `listCertificates` arguments.

###### Method listOutputs

Storage level processing for wallet `listOutputs`.

```ts
async listOutputs(auth: AuthId, vargs: Validation.ValidListOutputsArgs): Promise<ListOutputsResult>
```
See also: [AuthId](./client.md#interface-authid)

Returns

`listOutputs` results.

Argument Details

+ **auth**
  + Identifies client by identity key and the storage identity key of their currently active storage.
This must match the `AuthFetch` identity securing the remote conneciton.
+ **args**
  + Validated extension of original wallet `listOutputs` arguments.

###### Method makeAvailable

Must be called prior to making use of storage.
Retreives `TableSettings` from remote storage provider.

```ts
async makeAvailable(): Promise<RemoteStorageSettings>
```

Returns

remote storage `TableSettings`

###### Method migrate

Requests schema migration to latest.
Typically remote storage will ignore this request.

```ts
async migrate(storageName: string, _storageIdentityKey: string): Promise<string>
```

Returns

current schema migration identifier

Argument Details

+ **storageName**
  + Unique human readable name for remote storage if it does not yet exist.
+ **storageIdentityKey**
  + Unique identity key for remote storage if it does not yet exist.

###### Method processAction

Storage level processing for wallet `createAction` and `signAction`.

Handles remaining storage tasks once a fully signed transaction has been completed. This is common to both `createAction` and `signAction`.

```ts
async processAction(auth: AuthId, args: StorageProcessActionArgs): Promise<StorageProcessActionResults>
```
See also: [AuthId](./client.md#interface-authid), [StorageProcessActionArgs](./client.md#interface-storageprocessactionargs), [StorageProcessActionResults](./client.md#interface-storageprocessactionresults)

Returns

`StorageProcessActionResults` supporting final wallet processing to yield `createAction` or `signAction` results.

Argument Details

+ **auth**
  + Identifies client by identity key and the storage identity key of their currently active storage.
This must match the `AuthFetch` identity securing the remote conneciton.
+ **args**
  + `StorageProcessActionArgs` convey completed signed transaction to storage.

###### Method processSyncChunk

Process a "chunk" of replication data for the user.

The normal data flow is for the active storage to push backups as a sequence of data chunks to backup storage providers.

```ts
async processSyncChunk(args: RequestSyncChunkArgs, chunk: SyncChunk): Promise<ProcessSyncChunkResult>
```
See also: [ProcessSyncChunkResult](./client.md#interface-processsyncchunkresult), [RequestSyncChunkArgs](./client.md#interface-requestsyncchunkargs), [SyncChunk](./client.md#interface-syncchunk)

Returns

whether processing is done, counts of inserts and udpates, and related progress tracking properties.

Argument Details

+ **args**
  + a copy of the replication request args that initiated the sequence of data chunks.
+ **chunk**
  + the current data chunk to process.

###### Method relinquishCertificate

Relinquish a certificate.

For storage supporting replication records must be kept of deletions. Therefore certificates are marked as deleted
when relinquished, and no longer returned by `listCertificates`, but are still retained by storage.

```ts
async relinquishCertificate(auth: AuthId, args: RelinquishCertificateArgs): Promise<number>
```
See also: [AuthId](./client.md#interface-authid)

Argument Details

+ **auth**
  + Identifies client by identity key and the storage identity key of their currently active storage.
This must match the `AuthFetch` identity securing the remote conneciton.
+ **args**
  + original wallet `relinquishCertificate` args.

###### Method relinquishOutput

Relinquish an output.

Relinquishing an output removes the output from whatever basket was tracking it.

```ts
async relinquishOutput(auth: AuthId, args: RelinquishOutputArgs): Promise<number>
```
See also: [AuthId](./client.md#interface-authid)

Argument Details

+ **auth**
  + Identifies client by identity key and the storage identity key of their currently active storage.
This must match the `AuthFetch` identity securing the remote conneciton.
+ **args**
  + original wallet `relinquishOutput` args.

###### Method rpcCall

Make a JSON-RPC call to the remote server.
Implemented differently by each subclass (with or without logger support).

```ts
protected abstract rpcCall<T>(method: string, params: unknown[]): Promise<T>
```

Argument Details

+ **method**
  + The WalletStorage method name to call.
+ **params**
  + The array of parameters to pass to the method in order.

###### Method setActive

Ensures up-to-date wallet data replication to all configured backup storage providers,
then promotes one of the configured backups to active,
demoting the current active to new backup.

```ts
async setActive(auth: AuthId, newActiveStorageIdentityKey: string): Promise<number>
```
See also: [AuthId](./client.md#interface-authid)

Argument Details

+ **auth**
  + Identifies client by identity key and the storage identity key of their currently active storage.
This must match the `AuthFetch` identity securing the remote conneciton.
+ **newActiveStorageIdentityKey**
  + which must be a currently configured backup storage provider.

###### Method setServices

Ignored. Remote storage cannot share `Services` with remote clients.

```ts
setServices(_v: WalletServices): void
```
See also: [WalletServices](./client.md#interface-walletservices)

###### Method updateProvenTxReqWithNewProvenTx

Handles the data received when a new transaction proof is found in response to an outstanding request for proof data:

  - Creates a new `TableProvenTx` record.
  - Notifies all user transaction records of the new status.
  - Updates the proof request record to 'completed' status which enables delayed deletion.

```ts
async updateProvenTxReqWithNewProvenTx(args: UpdateProvenTxReqWithNewProvenTxArgs): Promise<UpdateProvenTxReqWithNewProvenTxResult>
```
See also: [UpdateProvenTxReqWithNewProvenTxArgs](./client.md#interface-updateproventxreqwithnewproventxargs), [UpdateProvenTxReqWithNewProvenTxResult](./client.md#interface-updateproventxreqwithnewproventxresult)

Returns

results of updates

Argument Details

+ **args**
  + proof request and new transaction proof data

###### Method validateEntities

Helper to force uniform behavior across database engines.
Use to process all arrays of records with time stamps retreived from database.

```ts
validateEntities<T extends EntityTimeStamp>(entities: T[], dateFields?: string[]): T[]
```
See also: [EntityTimeStamp](./client.md#interface-entitytimestamp)

Returns

input `entities` array with contained values validated.

###### Method validateEntity

Helper to force uniform behavior across database engines.
Use to process all individual records with time stamps retreived from database.

```ts
validateEntity<T extends EntityTimeStamp>(entity: T, dateFields?: string[]): T
```
See also: [EntityTimeStamp](./client.md#interface-entitytimestamp)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Class: StorageIdb

This class implements the `StorageProvider` interface using IndexedDB,
via the promises wrapper package `idb`.

```ts
export class StorageIdb extends StorageProvider implements WalletStorageProvider {
    dbName: string;
    db?: IDBPDatabase<StorageIdbSchema>;
    constructor(options: StorageIdbOptions)
    protected override supportsActionBatchPersistence(): boolean
    protected override supportsNoSendExpiryPersistence(): boolean
    protected override requiresActionBatchCleanupBeforeCreateAction(): boolean
    async migrate(storageName: string, storageIdentityKey: string): Promise<string>
    async verifyDB(storageName?: string, storageIdentityKey?: string): Promise<IDBPDatabase<StorageIdbSchema>>
    toDbTrx(stores: string[], mode: "readonly" | "readwrite", trx?: TrxToken): IDBPTransaction<StorageIdbSchema, string[], "readwrite" | "readonly">
    async readSettings(_trx?: TrxToken): Promise<TableSettings>
    async initDB(storageName?: string, storageIdentityKey?: string): Promise<IDBPDatabase<StorageIdbSchema>>
    async reviewStatus(args: {
        agedLimit: Date;
        trx?: TrxToken;
    }): Promise<{
        log: string;
    }>
    async purgeData(params: PurgeParams, trx?: TrxToken): Promise<PurgeResults>
    async allocateChangeInput(userId: number, basketId: number, targetSatoshis: number, exactSatoshis: number | undefined, excludeSending: boolean, transactionId: number): Promise<TableOutput | undefined>
    async getProvenOrRawTx(txid: string, trx?: TrxToken): Promise<ProvenOrRawTx>
    override async getProvenOrRawTxs(txids: string[], trx?: TrxToken): Promise<Map<string, ProvenOrRawTx>>
    async getRawTxOfKnownValidTransaction(txid?: string, offset?: number, length?: number, trx?: TrxToken): Promise<number[] | undefined>
    async getLabelsForTransactionId(transactionId?: number, trx?: TrxToken): Promise<TableTxLabel[]>
    async getTagsForOutputId(outputId: number, trx?: TrxToken): Promise<TableOutputTag[]>
    async listActions(auth: AuthId, vargs: Validation.ValidListActionsArgs): Promise<ListActionsResult>
    async listOutputs(auth: AuthId, vargs: Validation.ValidListOutputsArgs): Promise<ListOutputsResult>
    async countChangeInputs(userId: number, basketId: number, excludeSending: boolean): Promise<number>
    override async findTransactionStatusesByIds(userId: number, transactionIds: number[], trx?: TrxToken): Promise<Map<number, TransactionStatus>>
    override async findOutputsByOutpoints(userId: number, outpoints: Array<{
        txid: string;
        vout: number;
    }>, trx?: TrxToken): Promise<Record<string, TableOutput>>
    override async findOutputsByOutpointsForUpdate(userId: number, outpoints: Array<{
        txid: string;
        vout: number;
    }>, trx: TrxToken, noScript = false): Promise<Record<string, TableOutput>>
    async findCertificatesAuth(auth: AuthId, args: FindCertificatesArgs): Promise<TableCertificateX[]>
    override async findProvenTxReqsAuth(auth: AuthId, args: FindProvenTxReqsArgs): Promise<TableProvenTxReq[]>
    async findOutputBasketsAuth(auth: AuthId, args: FindOutputBasketsArgs): Promise<TableOutputBasket[]>
    async findOutputsAuth(auth: AuthId, args: FindOutputsArgs): Promise<TableOutput[]>
    async insertCertificateAuth(auth: AuthId, certificate: TableCertificateX): Promise<number>
    async dropAllData(): Promise<void>
    async filterOutputTagMaps(args: FindOutputTagMapsArgs, filtered: (v: TableOutputTagMap) => void, userId?: number): Promise<void>
    async findOutputTagMaps(args: FindOutputTagMapsArgs): Promise<TableOutputTagMap[]>
    async filterProvenTxReqs(args: FindProvenTxReqsArgs, filtered: (v: TableProvenTxReq) => void, userId?: number): Promise<void>
    async findProvenTxReqs(args: FindProvenTxReqsArgs): Promise<TableProvenTxReq[]>
    async filterProvenTxs(args: FindProvenTxsArgs, filtered: (v: TableProvenTx) => void, userId?: number): Promise<void>
    async findProvenTxs(args: FindProvenTxsArgs): Promise<TableProvenTx[]>
    async filterTxLabelMaps(args: FindTxLabelMapsArgs, filtered: (v: TableTxLabelMap) => void, userId?: number): Promise<void>
    async findTxLabelMaps(args: FindTxLabelMapsArgs): Promise<TableTxLabelMap[]>
    async countOutputTagMaps(args: FindOutputTagMapsArgs): Promise<number>
    async countProvenTxReqs(args: FindProvenTxReqsArgs): Promise<number>
    async countProvenTxs(args: FindProvenTxsArgs): Promise<number>
    async countTxLabelMaps(args: FindTxLabelMapsArgs): Promise<number>
    async insertCertificate(certificate: TableCertificateX, trx?: TrxToken): Promise<number>
    async insertCertificateField(certificateField: TableCertificateField, trx?: TrxToken): Promise<void>
    async insertCommission(commission: TableCommission, trx?: TrxToken): Promise<number>
    async insertMonitorEvent(event: TableMonitorEvent, trx?: TrxToken): Promise<number>
    async insertOutput(output: TableOutput, trx?: TrxToken): Promise<number>
    async insertOutputBasket(basket: TableOutputBasket, trx?: TrxToken): Promise<number>
    async insertOutputTag(tag: TableOutputTag, trx?: TrxToken): Promise<number>
    async insertOutputTagMap(tagMap: TableOutputTagMap, trx?: TrxToken): Promise<void>
    async insertProvenTx(tx: TableProvenTx, trx?: TrxToken): Promise<number>
    async insertProvenTxReq(tx: TableProvenTxReq, trx?: TrxToken): Promise<number>
    async insertSyncState(syncState: TableSyncState, trx?: TrxToken): Promise<number>
    async insertTransaction(tx: TableTransaction, trx?: TrxToken): Promise<number>
    async insertTxLabel(label: TableTxLabel, trx?: TrxToken): Promise<number>
    async insertTxLabelMap(labelMap: TableTxLabelMap, trx?: TrxToken): Promise<void>
    async insertUser(user: TableUser, trx?: TrxToken): Promise<number>
    async updateIdb<T>(id: number | number[], update: Partial<T>, keyProp: string, storeName: string, trx?: TrxToken): Promise<number>
    async updateIdbKey<T>(key: Array<number | string>, update: Partial<T>, keyProps: string[], storeName: string, trx?: TrxToken): Promise<number>
    async updateCertificate(id: number, update: Partial<TableCertificate>, trx?: TrxToken): Promise<number>
    async updateCertificateField(certificateId: number, fieldName: string, update: Partial<TableCertificateField>, trx?: TrxToken): Promise<number>
    async updateCommission(id: number, update: Partial<TableCommission>, trx?: TrxToken): Promise<number>
    async updateMonitorEvent(id: number, update: Partial<TableMonitorEvent>, trx?: TrxToken): Promise<number>
    async updateOutput(id: number, update: Partial<TableOutput>, trx?: TrxToken): Promise<number>
    async updateOutputBasket(id: number, update: Partial<TableOutputBasket>, trx?: TrxToken): Promise<number>
    async updateOutputTag(id: number, update: Partial<TableOutputTag>, trx?: TrxToken): Promise<number>
    async updateProvenTx(id: number, update: Partial<TableProvenTx>, trx?: TrxToken): Promise<number>
    async updateProvenTxReq(id: number | number[], update: Partial<TableProvenTxReq>, trx?: TrxToken): Promise<number>
    async updateSyncState(id: number, update: Partial<TableSyncState>, trx?: TrxToken): Promise<number>
    async updateTransaction(id: number | number[], update: Partial<TableTransaction>, trx?: TrxToken): Promise<number>
    override async compareAndSetNoSendExpiryState(transactionId: number, expected: Brc177NoSendExpiryState, next: Brc177NoSendExpiryState, trx?: TrxToken): Promise<boolean>
    async updateTxLabel(id: number, update: Partial<TableTxLabel>, trx?: TrxToken): Promise<number>
    async updateUser(id: number, update: Partial<TableUser>, trx?: TrxToken): Promise<number>
    async updateOutputTagMap(outputId: number, tagId: number, update: Partial<TableOutputTagMap>, trx?: TrxToken): Promise<number>
    async updateTxLabelMap(transactionId: number, txLabelId: number, update: Partial<TableTxLabelMap>, trx?: TrxToken): Promise<number>
    async destroy(): Promise<void>
    allStores: string[] = [
        "action_batches",
        "action_batch_outputs",
        "action_batch_blobs",
        "certificates",
        "certificate_fields",
        "commissions",
        "monitor_events",
        "outputs",
        "output_baskets",
        "output_tags",
        "output_tags_map",
        "proven_txs",
        "proven_tx_reqs",
        "sync_states",
        "transactions",
        "tx_labels",
        "tx_labels_map",
        "users"
    ];
    override async insertActionBatch(batch: TableActionBatch, trx?: TrxToken): Promise<number>
    override async findActionBatch(userId: number, batchId: string, trx?: TrxToken): Promise<TableActionBatch | undefined>
    override async findExpiredActionBatches(now: Date, trx?: TrxToken): Promise<TableActionBatch[]>
    override async updateActionBatch(actionBatchId: number, update: Partial<TableActionBatch>, trx?: TrxToken): Promise<number>
    override async deleteActionBatch(actionBatchId: number, trx?: TrxToken): Promise<void>
    override async reserveActionBatchOutputs(reservations: TableActionBatchOutput[], trx?: TrxToken): Promise<void>
    override async findActionBatchOutputIds(actionBatchId: number, trx?: TrxToken): Promise<number[]>
    override async findReservedActionBatchOutputIds(outputIds: number[], trx?: TrxToken): Promise<number[]>
    override async deleteActionBatchOutputReservations(actionBatchId: number, trx?: TrxToken): Promise<void>
    override async putActionBatchBlobRecord(blob: TableActionBatchBlob, trx?: TrxToken): Promise<void>
    override async findActionBatchBlobRecord(actionBatchId: number, digest: string, trx?: TrxToken): Promise<TableActionBatchBlob | undefined>
    override async findActionBatchBlobRecords(actionBatchId: number, digests: string[], trx?: TrxToken): Promise<TableActionBatchBlob[]>
    override async putActionBatchBlobRecords(blobs: TableActionBatchBlob[], trx?: TrxToken): Promise<void>
    override async deleteActionBatchBlobRecords(actionBatchId: number, trx?: TrxToken): Promise<void>
    async transaction<T>(scope: (trx: TrxToken) => Promise<T>, trx?: TrxToken): Promise<T>
    async filterCertificateFields(args: FindCertificateFieldsArgs, filtered: (v: TableCertificateField) => void): Promise<void>
    async findCertificateFields(args: FindCertificateFieldsArgs): Promise<TableCertificateField[]>
    async filterCertificates(args: FindCertificatesArgs, filtered: (v: TableCertificateX) => void): Promise<void>
    async findCertificates(args: FindCertificatesArgs): Promise<TableCertificateX[]>
    async filterCommissions(args: FindCommissionsArgs, filtered: (v: TableCommission) => void): Promise<void>
    async findCommissions(args: FindCommissionsArgs): Promise<TableCommission[]>
    async filterMonitorEvents(args: FindMonitorEventsArgs, filtered: (v: TableMonitorEvent) => void): Promise<void>
    async findMonitorEvents(args: FindMonitorEventsArgs): Promise<TableMonitorEvent[]>
    async filterOutputBaskets(args: FindOutputBasketsArgs, filtered: (v: TableOutputBasket) => void): Promise<void>
    async findOutputBaskets(args: FindOutputBasketsArgs): Promise<TableOutputBasket[]>
    async filterOutputs(args: FindOutputsArgs, filtered: (v: TableOutput) => void, tagIds?: number[], isQueryModeAll?: boolean): Promise<void>
    async findOutputs(args: FindOutputsArgs, tagIds?: number[], isQueryModeAll?: boolean): Promise<TableOutput[]>
    async filterOutputTags(args: FindOutputTagsArgs, filtered: (v: TableOutputTag) => void): Promise<void>
    async findOutputTags(args: FindOutputTagsArgs): Promise<TableOutputTag[]>
    async filterSyncStates(args: FindSyncStatesArgs, filtered: (v: TableSyncState) => void): Promise<void>
    async findSyncStates(args: FindSyncStatesArgs): Promise<TableSyncState[]>
    async filterTransactions(args: FindTransactionsArgs, filtered: (v: TableTransaction) => void, labelIds?: number[], isQueryModeAll?: boolean): Promise<void>
    async findTransactions(args: FindTransactionsArgs, labelIds?: number[], isQueryModeAll?: boolean): Promise<TableTransaction[]>
    async filterTxLabels(args: FindTxLabelsArgs, filtered: (v: TableTxLabel) => void): Promise<void>
    async findTxLabels(args: FindTxLabelsArgs): Promise<TableTxLabel[]>
    async filterUsers(args: FindUsersArgs, filtered: (v: TableUser) => void): Promise<void>
    async findUsers(args: FindUsersArgs): Promise<TableUser[]>
    async countCertificateFields(args: FindCertificateFieldsArgs): Promise<number>
    async countCertificates(args: FindCertificatesArgs): Promise<number>
    async countCommissions(args: FindCommissionsArgs): Promise<number>
    async countMonitorEvents(args: FindMonitorEventsArgs): Promise<number>
    async countOutputBaskets(args: FindOutputBasketsArgs): Promise<number>
    async countOutputs(args: FindOutputsArgs, tagIds?: number[], isQueryModeAll?: boolean): Promise<number>
    async countOutputTags(args: FindOutputTagsArgs): Promise<number>
    async countSyncStates(args: FindSyncStatesArgs): Promise<number>
    async countTransactions(args: FindTransactionsArgs, labelIds?: number[], isQueryModeAll?: boolean): Promise<number>
    async countTxLabels(args: FindTxLabelsArgs): Promise<number>
    async countUsers(args: FindUsersArgs): Promise<number>
    async getProvenTxsForUser(args: FindForUserSincePagedArgs): Promise<TableProvenTx[]>
    async getProvenTxReqsForUser(args: FindForUserSincePagedArgs): Promise<TableProvenTxReq[]>
    async getTxLabelMapsForUser(args: FindForUserSincePagedArgs): Promise<TableTxLabelMap[]>
    async getOutputTagMapsForUser(args: FindForUserSincePagedArgs): Promise<TableOutputTagMap[]>
    async verifyReadyForDatabaseAccess(_trx?: TrxToken): Promise<DBType>
    validateEntity<T extends EntityTimeStamp>(entity: T, dateFields?: string[], booleanFields?: string[]): T
    validateEntities<T extends EntityTimeStamp>(entities: T[], dateFields?: string[], booleanFields?: string[]): T[]
    validatePartialForUpdate<T extends EntityTimeStamp>(update: Partial<T>, dateFields?: string[], booleanFields?: string[]): Partial<T>
    async validateEntityForInsert<T extends EntityTimeStamp>(entity: T, trx?: TrxToken, dateFields?: string[], booleanFields?: string[]): Promise<any>
    async validateRawTransaction(t: TableTransaction, trx?: TrxToken): Promise<void>
    async adminStats(_adminIdentityKey: string): Promise<StorageAdminStats>
}
```

See also: [AuthId](./client.md#interface-authid), [Brc177NoSendExpiryState](./client.md#type-brc177nosendexpirystate), [DBType](./storage.md#type-dbtype), [EntityTimeStamp](./client.md#interface-entitytimestamp), [FindCertificateFieldsArgs](./client.md#interface-findcertificatefieldsargs), [FindCertificatesArgs](./client.md#interface-findcertificatesargs), [FindCommissionsArgs](./client.md#interface-findcommissionsargs), [FindForUserSincePagedArgs](./client.md#interface-findforusersincepagedargs), [FindMonitorEventsArgs](./client.md#interface-findmonitoreventsargs), [FindOutputBasketsArgs](./client.md#interface-findoutputbasketsargs), [FindOutputTagMapsArgs](./client.md#interface-findoutputtagmapsargs), [FindOutputTagsArgs](./client.md#interface-findoutputtagsargs), [FindOutputsArgs](./client.md#interface-findoutputsargs), [FindProvenTxReqsArgs](./client.md#interface-findproventxreqsargs), [FindProvenTxsArgs](./client.md#interface-findproventxsargs), [FindSyncStatesArgs](./client.md#interface-findsyncstatesargs), [FindTransactionsArgs](./client.md#interface-findtransactionsargs), [FindTxLabelMapsArgs](./client.md#interface-findtxlabelmapsargs), [FindTxLabelsArgs](./client.md#interface-findtxlabelsargs), [FindUsersArgs](./client.md#interface-findusersargs), [ProvenOrRawTx](./client.md#interface-provenorrawtx), [PurgeParams](./client.md#interface-purgeparams), [PurgeResults](./client.md#interface-purgeresults), [StorageAdminStats](./storage.md#interface-storageadminstats), [StorageIdbOptions](./storage.md#interface-storageidboptions), [StorageIdbSchema](./storage.md#interface-storageidbschema), [StorageProvider](./storage.md#class-storageprovider), [TableActionBatch](./storage.md#interface-tableactionbatch), [TableActionBatchBlob](./storage.md#interface-tableactionbatchblob), [TableActionBatchOutput](./storage.md#interface-tableactionbatchoutput), [TableCertificate](./storage.md#interface-tablecertificate), [TableCertificateField](./storage.md#interface-tablecertificatefield), [TableCertificateX](./storage.md#interface-tablecertificatex), [TableCommission](./storage.md#interface-tablecommission), [TableMonitorEvent](./storage.md#interface-tablemonitorevent), [TableOutput](./storage.md#interface-tableoutput), [TableOutputBasket](./storage.md#interface-tableoutputbasket), [TableOutputTag](./storage.md#interface-tableoutputtag), [TableOutputTagMap](./storage.md#interface-tableoutputtagmap), [TableProvenTx](./storage.md#interface-tableproventx), [TableProvenTxReq](./storage.md#interface-tableproventxreq), [TableSettings](./storage.md#interface-tablesettings), [TableSyncState](./storage.md#interface-tablesyncstate), [TableTransaction](./storage.md#interface-tabletransaction), [TableTxLabel](./storage.md#interface-tabletxlabel), [TableTxLabelMap](./storage.md#interface-tabletxlabelmap), [TableUser](./storage.md#interface-tableuser), [TransactionStatus](./client.md#type-transactionstatus), [TrxToken](./client.md#interface-trxtoken), [WalletStorageProvider](./client.md#interface-walletstorageprovider), [listActions](./storage.md#function-listactions), [listOutputs](./storage.md#function-listoutputs), [purgeData](./storage.md#function-purgedata), [reviewStatus](./storage.md#function-reviewstatus), [validateEntities](./storage.md#function-validateentities), [validateEntity](./storage.md#function-validateentity)

###### Method allocateChangeInput

Proceeds in three stages:
1. Find an output that exactly funds the transaction (if exactSatoshis is not undefined).
2. Find an output that overfunds by the least amount (targetSatoshis).
3. Find an output that comes as close to funding as possible (targetSatoshis).
4. Return undefined if no output is found.

Outputs must belong to userId and basketId and satisfy the wallet-managed
BRC-29 change policy.
Their corresponding transaction must have status of 'completed', 'unproven', or 'sending' (if excludeSending is false).

```ts
async allocateChangeInput(userId: number, basketId: number, targetSatoshis: number, exactSatoshis: number | undefined, excludeSending: boolean, transactionId: number): Promise<TableOutput | undefined>
```
See also: [TableOutput](./storage.md#interface-tableoutput)

Returns

next funding output to add to transaction or undefined if there are none.

###### Method migrate

This method must be called at least once before any other method accesses the database,
and each time the schema may have updated.

If the database has already been created in this context, `storageName` and `storageIdentityKey`
are ignored.

```ts
async migrate(storageName: string, storageIdentityKey: string): Promise<string>
```

###### Method readSettings

Called by `makeAvailable` to return storage `TableSettings`.
Since this is the first async method that must be called by all clients,
it is where async initialization occurs.

After initialization, cached settings are returned.

```ts
async readSettings(_trx?: TrxToken): Promise<TableSettings>
```
See also: [TableSettings](./storage.md#interface-tablesettings), [TrxToken](./client.md#interface-trxtoken)

###### Method toDbTrx

Convert the standard optional `TrxToken` parameter into either a direct knex database instance,
or a Knex.Transaction as appropriate.

```ts
toDbTrx(stores: string[], mode: "readonly" | "readwrite", trx?: TrxToken): IDBPTransaction<StorageIdbSchema, string[], "readwrite" | "readonly">
```
See also: [StorageIdbSchema](./storage.md#interface-storageidbschema), [TrxToken](./client.md#interface-trxtoken)

###### Method validateEntities

Helper to force uniform behavior across database engines.
Use to process all arrays of records with time stamps retreived from database.

```ts
validateEntities<T extends EntityTimeStamp>(entities: T[], dateFields?: string[], booleanFields?: string[]): T[]
```
See also: [EntityTimeStamp](./client.md#interface-entitytimestamp)

Returns

input `entities` array with contained values validated.

###### Method validateEntity

Helper to force uniform behavior across database engines.
Use to process all individual records with time stamps or number[] retreived from database.

```ts
validateEntity<T extends EntityTimeStamp>(entity: T, dateFields?: string[], booleanFields?: string[]): T
```
See also: [EntityTimeStamp](./client.md#interface-entitytimestamp)

###### Method validateEntityForInsert

Helper to force uniform behavior across database engines.
Use to process new entities being inserted into the database.

```ts
async validateEntityForInsert<T extends EntityTimeStamp>(entity: T, trx?: TrxToken, dateFields?: string[], booleanFields?: string[]): Promise<any>
```
See also: [EntityTimeStamp](./client.md#interface-entitytimestamp), [TrxToken](./client.md#interface-trxtoken)

###### Method validatePartialForUpdate

Helper to force uniform behavior across database engines.
Use to process the update template for entities being updated.

```ts
validatePartialForUpdate<T extends EntityTimeStamp>(update: Partial<T>, dateFields?: string[], booleanFields?: string[]): Partial<T>
```
See also: [EntityTimeStamp](./client.md#interface-entitytimestamp)

###### Method verifyDB

Following initial database initialization, this method verfies that db is ready for use.

```ts
async verifyDB(storageName?: string, storageIdentityKey?: string): Promise<IDBPDatabase<StorageIdbSchema>>
```
See also: [StorageIdbSchema](./storage.md#interface-storageidbschema)

Throws

`WERR_INVALID_OPERATION` if the database has not been initialized by a call to `migrate`.

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Class: StorageKnex

```ts
export class StorageKnex extends StorageProvider implements WalletStorageProvider {
    knex: Knex;
    readonly preparedBeefPolicy: PreparedBeefPolicy;
    constructor(options: StorageKnexOptions)
    protected override supportsActionBatchPersistence(): boolean
    protected override supportsNoSendExpiryPersistence(): boolean
    protected override requiresActionBatchCleanupBeforeCreateAction(): boolean
    override async makeAvailable(): Promise<TableSettings>
    override setServices(services: WalletServices): void
    async readSettings(trx?: TrxToken): Promise<TableSettings>
    override async getProvenOrRawTx(txid: string, trx?: TrxToken): Promise<ProvenOrRawTx>
    override async getProvenOrRawTxs(txids: string[], trx?: TrxToken): Promise<Map<string, ProvenOrRawTx>>
    async findPreparedBeefs(userId: number, rootTxids: string[], trx?: TrxToken): Promise<TablePreparedBeef[]>
    async readPreparedBeefLookupByteLength(userId: number, rootTxids: string[]): Promise<number>
    async readPreparedBeefProofEpoch(trx?: TrxToken): Promise<number>
    async readPreparedBeefSourceByteLength(rootTxid: string): Promise<number | undefined>
    async upsertPreparedBeef(artifact: TablePreparedBeef, expectedProofEpoch: number): Promise<boolean>
    async findPreparedBeefBackfillRoots(limit: number, formatVersion: number): Promise<PreparedBeefRoot[]>
    async invalidatePreparedBeefs(trx?: TrxToken): Promise<number>
    async lookupPreparedBeefs(userId: number, rootTxids: string[], parent?: TelemetrySpan): Promise<PreparedBeefLookupResult>
    preparedBeefReadsEnabled(): boolean
    suspendPreparedBeefReads(): () => void
    preparedBeefWritesEnabled(): boolean
    enqueuePreparedBeef(preparation: PreparedBeefPreparation): boolean
    startPreparedBeefBackfill(): void
    async waitForPreparedBeefTasks(): Promise<void>
    async stopPreparedBeefTasks(): Promise<void>
    override async getRawTxOfKnownValidTransaction(txid?: string, offset?: number, length?: number, trx?: TrxToken): Promise<number[] | undefined>
    getProvenTxsForUserQuery(args: FindForUserSincePagedArgs): Knex.QueryBuilder
    override async getProvenTxsForUser(args: FindForUserSincePagedArgs): Promise<TableProvenTx[]>
    getProvenTxReqsForUserQuery(args: FindForUserSincePagedArgs): Knex.QueryBuilder
    override async getProvenTxReqsForUser(args: FindForUserSincePagedArgs): Promise<TableProvenTxReq[]>
    getTxLabelMapsForUserQuery(args: FindForUserSincePagedArgs): Knex.QueryBuilder
    override async getTxLabelMapsForUser(args: FindForUserSincePagedArgs): Promise<TableTxLabelMap[]>
    getOutputTagMapsForUserQuery(args: FindForUserSincePagedArgs): Knex.QueryBuilder
    override async getOutputTagMapsForUser(args: FindForUserSincePagedArgs): Promise<TableOutputTagMap[]>
    override async getSyncChunkTotals(args: RequestSyncChunkArgs, userId: number): Promise<SyncChunkTotals>
    override async listActions(auth: AuthId, vargs: Validation.ValidListActionsArgs): Promise<ListActionsResult>
    override async listOutputs(auth: AuthId, vargs: Validation.ValidListOutputsArgs): Promise<ListOutputsResult>
    override async insertProvenTx(tx: TableProvenTx, trx?: TrxToken): Promise<number>
    override async insertActionBatch(batch: TableActionBatch, trx?: TrxToken): Promise<number>
    override async findActionBatch(userId: number, batchId: string, trx?: TrxToken): Promise<TableActionBatch | undefined>
    override async findActionBatchForUpdate(userId: number, batchId: string, trx: TrxToken): Promise<TableActionBatch | undefined>
    override async findExpiredActionBatches(now: Date, trx?: TrxToken): Promise<TableActionBatch[]>
    override async updateActionBatch(actionBatchId: number, update: Partial<TableActionBatch>, trx?: TrxToken): Promise<number>
    override async deleteActionBatch(actionBatchId: number, trx?: TrxToken): Promise<void>
    override async reserveActionBatchOutputs(reservations: TableActionBatchOutput[], trx?: TrxToken): Promise<void>
    override async findActionBatchOutputIds(actionBatchId: number, trx?: TrxToken): Promise<number[]>
    override async findReservedActionBatchOutputIds(outputIds: number[], trx?: TrxToken): Promise<number[]>
    override async deleteActionBatchOutputReservations(actionBatchId: number, trx?: TrxToken): Promise<void>
    override async putActionBatchBlobRecord(blob: TableActionBatchBlob, trx?: TrxToken): Promise<void>
    override async findActionBatchBlobRecord(actionBatchId: number, digest: string, trx?: TrxToken): Promise<TableActionBatchBlob | undefined>
    override async findActionBatchBlobRecords(actionBatchId: number, digests: string[], trx?: TrxToken): Promise<TableActionBatchBlob[]>
    override async putActionBatchBlobRecords(blobs: TableActionBatchBlob[], trx?: TrxToken): Promise<void>
    override async deleteActionBatchBlobRecords(actionBatchId: number, trx?: TrxToken): Promise<void>
    override async insertProvenTxReq(tx: TableProvenTxReq, trx?: TrxToken): Promise<number>
    override async insertUser(user: TableUser, trx?: TrxToken): Promise<number>
    override async insertCertificateAuth(auth: AuthId, certificate: TableCertificateX): Promise<number>
    override async insertCertificate(certificate: TableCertificateX, trx?: TrxToken): Promise<number>
    override async insertCertificateField(certificateField: TableCertificateField, trx?: TrxToken): Promise<void>
    override async insertOutputBasket(basket: TableOutputBasket, trx?: TrxToken): Promise<number>
    override async insertTransaction(tx: TableTransaction, trx?: TrxToken): Promise<number>
    override async insertCommission(commission: TableCommission, trx?: TrxToken): Promise<number>
    override async insertOutput(output: TableOutput, trx?: TrxToken): Promise<number>
    override async insertOutputs(outputs: TableOutput[], trx?: TrxToken): Promise<void>
    override async insertOutputTag(tag: TableOutputTag, trx?: TrxToken): Promise<number>
    override async insertOutputTagMap(tagMap: TableOutputTagMap, trx?: TrxToken): Promise<void>
    override async insertTxLabel(label: TableTxLabel, trx?: TrxToken): Promise<number>
    override async insertTxLabelMap(labelMap: TableTxLabelMap, trx?: TrxToken): Promise<void>
    override async insertMonitorEvent(event: TableMonitorEvent, trx?: TrxToken): Promise<number>
    override async insertSyncState(syncState: TableSyncState, trx?: TrxToken): Promise<number>
    override async updateCertificateField(certificateId: number, fieldName: string, update: Partial<TableCertificateField>, trx?: TrxToken): Promise<number>
    override async updateCertificate(id: number, update: Partial<TableCertificate>, trx?: TrxToken): Promise<number>
    override async updateCommission(id: number, update: Partial<TableCommission>, trx?: TrxToken): Promise<number>
    override async updateOutputBasket(id: number, update: Partial<TableOutputBasket>, trx?: TrxToken): Promise<number>
    override async updateOutput(id: number, update: Partial<TableOutput>, trx?: TrxToken): Promise<number>
    override async updateOutputTagMap(outputId: number, tagId: number, update: Partial<TableOutputTagMap>, trx?: TrxToken): Promise<number>
    override async updateOutputTag(id: number, update: Partial<TableOutputTag>, trx?: TrxToken): Promise<number>
    override async updateProvenTxReq(id: number | number[], update: Partial<TableProvenTxReq>, trx?: TrxToken): Promise<number>
    override async updateProvenTx(id: number, update: Partial<TableProvenTx>, trx?: TrxToken): Promise<number>
    override async updateSyncState(id: number, update: Partial<TableSyncState>, trx?: TrxToken): Promise<number>
    override async updateTransaction(id: number | number[], update: Partial<TableTransaction>, trx?: TrxToken): Promise<number>
    override async compareAndSetNoSendExpiryState(transactionId: number, expected: Brc177NoSendExpiryState, next: Brc177NoSendExpiryState, trx?: TrxToken): Promise<boolean>
    override async updateTxLabelMap(transactionId: number, txLabelId: number, update: Partial<TableTxLabelMap>, trx?: TrxToken): Promise<number>
    override async updateTxLabel(id: number, update: Partial<TableTxLabel>, trx?: TrxToken): Promise<number>
    override async updateUser(id: number, update: Partial<TableUser>, trx?: TrxToken): Promise<number>
    override async updateMonitorEvent(id: number, update: Partial<TableMonitorEvent>, trx?: TrxToken): Promise<number>
    setupQuery<T extends object>(table: string, args: FindPartialSincePagedArgs<T>): Knex.QueryBuilder
    findCertificateFieldsQuery(args: FindCertificateFieldsArgs): Knex.QueryBuilder
    findCertificatesQuery(args: FindCertificatesArgs): Knex.QueryBuilder
    findCommissionsQuery(args: FindCommissionsArgs): Knex.QueryBuilder
    findOutputBasketsQuery(args: FindOutputBasketsArgs): Knex.QueryBuilder
    findOutputsQuery(args: FindOutputsArgs, count?: boolean): Knex.QueryBuilder
    findOutputTagMapsQuery(args: FindOutputTagMapsArgs): Knex.QueryBuilder
    findOutputTagsQuery(args: FindOutputTagsArgs): Knex.QueryBuilder
    findProvenTxReqsQuery(args: FindProvenTxReqsArgs): Knex.QueryBuilder
    findProvenTxsQuery(args: FindProvenTxsArgs): Knex.QueryBuilder
    findStaleMerkleRootsQuery(args: FindStaleMerkleRootsArgs): Knex.QueryBuilder
    findSyncStatesQuery(args: FindSyncStatesArgs): Knex.QueryBuilder
    findTransactionsQuery(args: FindTransactionsArgs, count?: boolean): Knex.QueryBuilder
    findTxLabelMapsQuery(args: FindTxLabelMapsArgs): Knex.QueryBuilder
    findTxLabelsQuery(args: FindTxLabelsArgs): Knex.QueryBuilder
    findUsersQuery(args: FindUsersArgs): Knex.QueryBuilder
    findMonitorEventsQuery(args: FindMonitorEventsArgs): Knex.QueryBuilder
    override async findCertificatesAuth(auth: AuthId, args: FindCertificatesArgs): Promise<TableCertificateX[]>
    override async findProvenTxReqsAuth(auth: AuthId, args: FindProvenTxReqsArgs): Promise<TableProvenTxReq[]>
    override async findOutputBasketsAuth(auth: AuthId, args: FindOutputBasketsArgs): Promise<TableOutputBasket[]>
    override async findOutputsAuth(auth: AuthId, args: FindOutputsArgs): Promise<TableOutput[]>
    override async findCertificateFields(args: FindCertificateFieldsArgs): Promise<TableCertificateField[]>
    override async findCertificates(args: FindCertificatesArgs): Promise<TableCertificateX[]>
    override async findCommissions(args: FindCommissionsArgs): Promise<TableCommission[]>
    override async findOutputBaskets(args: FindOutputBasketsArgs): Promise<TableOutputBasket[]>
    override async findOutputs(args: FindOutputsArgs): Promise<TableOutput[]>
    override async findOutputTagMaps(args: FindOutputTagMapsArgs): Promise<TableOutputTagMap[]>
    override async findOutputTags(args: FindOutputTagsArgs): Promise<TableOutputTag[]>
    override async findProvenTxReqs(args: FindProvenTxReqsArgs): Promise<TableProvenTxReq[]>
    override async findProvenTxs(args: FindProvenTxsArgs): Promise<TableProvenTx[]>
    override async findStaleMerkleRoots(args: FindStaleMerkleRootsArgs): Promise<string[]>
    override async findSyncStates(args: FindSyncStatesArgs): Promise<TableSyncState[]>
    override async findTransactions(args: FindTransactionsArgs): Promise<TableTransaction[]>
    override async findTxLabelMaps(args: FindTxLabelMapsArgs): Promise<TableTxLabelMap[]>
    override async findTxLabels(args: FindTxLabelsArgs): Promise<TableTxLabel[]>
    override async findUsers(args: FindUsersArgs): Promise<TableUser[]>
    override async recentlyActiveUsers(limit = 50, trx?: TrxToken): Promise<TableUser[]>
    override async findMonitorEvents(args: FindMonitorEventsArgs): Promise<TableMonitorEvent[]>
    async getCount<T extends object>(q: Knex.QueryBuilder<T, T[]>): Promise<number>
    override async countCertificateFields(args: FindCertificateFieldsArgs): Promise<number>
    override async countCertificates(args: FindCertificatesArgs): Promise<number>
    override async countCommissions(args: FindCommissionsArgs): Promise<number>
    override async countOutputBaskets(args: FindOutputBasketsArgs): Promise<number>
    override async countOutputs(args: FindOutputsArgs): Promise<number>
    override async countOutputTagMaps(args: FindOutputTagMapsArgs): Promise<number>
    override async countOutputTags(args: FindOutputTagsArgs): Promise<number>
    override async countProvenTxReqs(args: FindProvenTxReqsArgs): Promise<number>
    override async countProvenTxs(args: FindProvenTxsArgs): Promise<number>
    override async countSyncStates(args: FindSyncStatesArgs): Promise<number>
    override async countTransactions(args: FindTransactionsArgs): Promise<number>
    override async countTxLabelMaps(args: FindTxLabelMapsArgs): Promise<number>
    override async countTxLabels(args: FindTxLabelsArgs): Promise<number>
    override async countUsers(args: FindUsersArgs): Promise<number>
    override async countMonitorEvents(args: FindMonitorEventsArgs): Promise<number>
    override async destroy(): Promise<void>
    override async migrate(storageName: string, storageIdentityKey: string): Promise<string>
    override async dropAllData(): Promise<void>
    override async transaction<T>(scope: (trx: TrxToken) => Promise<T>, trx?: TrxToken): Promise<T>
    toDb(trx?: TrxToken): Knex | Knex.Transaction<any, any[]>
    async validateRawTransaction(t: TableTransaction, trx?: TrxToken): Promise<void>
    _verifiedReadyForDatabaseAccess: boolean = false;
    async verifyReadyForDatabaseAccess(trx?: TrxToken): Promise<DBType>
    validatePartialForUpdate<T extends EntityTimeStamp>(update: Partial<T>, dateFields?: string[], booleanFields?: string[]): Partial<T>
    async validateEntityForInsert<T extends EntityTimeStamp>(entity: T, trx?: TrxToken, dateFields?: string[], booleanFields?: string[]): Promise<any>
    override async getLabelsForTransactionId(transactionId?: number, trx?: TrxToken): Promise<TableTxLabel[]>
    override async getTagsForOutputId(outputId: number, trx?: TrxToken): Promise<TableOutputTag[]>
    override async purgeData(params: PurgeParams, trx?: TrxToken): Promise<PurgeResults>
    override async reviewStatus(args: {
        agedLimit: Date;
        trx?: TrxToken;
    }): Promise<{
        log: string;
    }>
    async countChangeInputs(userId: number, basketId: number, excludeSending: boolean): Promise<number>
    override async findAvailableManagedChangeInputs(userId: number, basketId: number, excludeSending: boolean, trx?: TrxToken): Promise<TableOutput[]>
    override async findAvailableManagedChangeInputCandidates(userId: number, basketId: number, excludeSending: boolean, trx?: TrxToken): Promise<ManagedChangeInputCandidate[]>
    override async findOutputsByIds(outputIds: number[], trx?: TrxToken): Promise<Record<number, TableOutput>>
    override async findOutputsByOutpoints(userId: number, outpoints: Array<{
        txid: string;
        vout: number;
    }>, trx?: TrxToken): Promise<Record<string, TableOutput>>
    override async findOutputsByOutpointsForUpdate(userId: number, outpoints: Array<{
        txid: string;
        vout: number;
    }>, trx: TrxToken, noScript = false): Promise<Record<string, TableOutput>>
    override async findTransactionStatusesByIds(userId: number, transactionIds: number[], trx?: TrxToken): Promise<Map<number, TransactionStatus>>
    override async findFundingOutputsForUpdate(userId: number, outputIds: number[], statuses: TransactionStatus[], trx: TrxToken): Promise<Record<number, TableOutput>>
    override async findOrInsertOutputBasketsBulk(userId: number, names: string[], trx?: TrxToken): Promise<Record<string, TableOutputBasket>>
    override async findOrInsertOutputTagsBulk(userId: number, tags: string[], trx?: TrxToken): Promise<Record<string, TableOutputTag>>
    override async findOrInsertTxLabelsBulk(userId: number, labels: string[], trx?: TrxToken): Promise<Record<string, TableTxLabel>>
    override async sumSpendableSatoshisInBasket(userId: number, basketId: number, excludeSending: boolean, trx?: TrxToken): Promise<number>
    async allocateChangeInput(userId: number, basketId: number, targetSatoshis: number, exactSatoshis: number | undefined, excludeSending: boolean, transactionId: number): Promise<TableOutput | undefined>
    override async markChangeInputsSpent(outputIds: number[], transactionId: number, trx: TrxToken): Promise<number>
    validateEntity<T extends EntityTimeStamp>(entity: T, dateFields?: string[], booleanFields?: string[]): T
    validateEntities<T extends EntityTimeStamp>(entities: T[], dateFields?: string[], booleanFields?: string[]): T[]
    async adminStats(adminIdentityKey: string): Promise<AdminStatsResult> {
        if (this.dbtype !== "MySQL")
            throw new WERR_NOT_IMPLEMENTED("adminStats, only MySQL is supported");
        const monitorEvent = verifyOneOrNone(await this.findMonitorEvents({
            partial: { event: "MonitorCallHistory" },
            orderDescending: true,
            paged: { limit: 1 }
        }));
        const monitorStats: ServicesCallHistory | undefined = (monitorEvent != null) ? JSON.parse(monitorEvent.details as string) : undefined;
        const servicesStats = this.getServices().getServicesCallHistory(true);
        const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
        const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
        const oneMonthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
        const [[{ usersDay, usersMonth, usersWeek, usersTotal, transactionsDay, transactionsMonth, transactionsWeek, transactionsTotal, txCompletedDay, txCompletedMonth, txCompletedWeek, txCompletedTotal, txFailedDay, txFailedMonth, txFailedWeek, txFailedTotal, txAbandonedDay, txAbandonedMonth, txAbandonedWeek, txAbandonedTotal, txUnprocessedDay, txUnprocessedMonth, txUnprocessedWeek, txUnprocessedTotal, txSendingDay, txSendingMonth, txSendingWeek, txSendingTotal, txUnprovenDay, txUnprovenMonth, txUnprovenWeek, txUnprovenTotal, txUnsignedDay, txUnsignedMonth, txUnsignedWeek, txUnsignedTotal, txNosendDay, txNosendMonth, txNosendWeek, txNosendTotal, txNonfinalDay, txNonfinalMonth, txNonfinalWeek, txNonfinalTotal, txUnfailDay, txUnfailMonth, txUnfailWeek, txUnfailTotal, satoshisDefaultDay, satoshisDefaultMonth, satoshisDefaultWeek, satoshisDefaultTotal, satoshisOtherDay, satoshisOtherMonth, satoshisOtherWeek, satoshisOtherTotal, basketsDay, basketsMonth, basketsWeek, basketsTotal, labelsDay, labelsMonth, labelsWeek, labelsTotal, tagsDay, tagsMonth, tagsWeek, tagsTotal }]] = await this.knex.raw(`
select
    (select count(*) from users where created_at > '${oneDayAgo}') as usersDay,
    (select count(*) from users where created_at > '${oneWeekAgo}') as usersWeek,
    (select count(*) from users where created_at > '${oneMonthAgo}') as usersMonth,
    (select count(*) from users) as usersTotal,
    (select count(*) from transactions where created_at > '${oneDayAgo}') as transactionsDay,
    (select count(*) from transactions where created_at > '${oneWeekAgo}') as transactionsWeek,
    (select count(*) from transactions where created_at > '${oneMonthAgo}') as transactionsMonth,
    (select count(*) from transactions) as transactionsTotal,
    (select count(*) from transactions where status = 'completed' and created_at > '${oneDayAgo}') as txCompletedDay,
    (select count(*) from transactions where status = 'completed' and created_at > '${oneWeekAgo}') as txCompletedWeek,
    (select count(*) from transactions where status = 'completed' and created_at > '${oneMonthAgo}') as txCompletedMonth,
    (select count(*) from transactions where status = 'completed') as txCompletedTotal,
    (select count(*) from transactions where status = 'failed' and not txid is null and created_at > '${oneDayAgo}') as txFailedDay,
    (select count(*) from transactions where status = 'failed' and not txid is null and created_at > '${oneWeekAgo}') as txFailedWeek,
    (select count(*) from transactions where status = 'failed' and not txid is null and created_at > '${oneMonthAgo}') as txFailedMonth,
    (select count(*) from transactions where status = 'failed' and not txid is null) as txFailedTotal,
    (select count(*) from transactions where status = 'failed' and txid is null and created_at > '${oneDayAgo}') as txAbandonedDay,
    (select count(*) from transactions where status = 'failed' and txid is null and created_at > '${oneWeekAgo}') as txAbandonedWeek,
    (select count(*) from transactions where status = 'failed' and txid is null and created_at > '${oneMonthAgo}') as txAbandonedMonth,
    (select count(*) from transactions where status = 'failed' and txid is null) as txAbandonedTotal,
    (select count(*) from transactions where status = 'unprocessed' and created_at > '${oneDayAgo}') as txUnprocessedDay,
    (select count(*) from transactions where status = 'unprocessed' and created_at > '${oneWeekAgo}') as txUnprocessedWeek,
    (select count(*) from transactions where status = 'unprocessed' and created_at > '${oneMonthAgo}') as txUnprocessedMonth,
    (select count(*) from transactions where status = 'unprocessed') as txUnprocessedTotal,
    (select count(*) from transactions where status = 'sending' and created_at > '${oneDayAgo}') as txSendingDay,
    (select count(*) from transactions where status = 'sending' and created_at > '${oneWeekAgo}') as txSendingWeek,
    (select count(*) from transactions where status = 'sending' and created_at > '${oneMonthAgo}') as txSendingMonth,
    (select count(*) from transactions where status = 'sending') as txSendingTotal,
    (select count(*) from transactions where status = 'unproven' and created_at > '${oneDayAgo}') as txUnprovenDay,
    (select count(*) from transactions where status = 'unproven' and created_at > '${oneWeekAgo}') as txUnprovenWeek,
    (select count(*) from transactions where status = 'unproven' and created_at > '${oneMonthAgo}') as txUnprovenMonth,
    (select count(*) from transactions where status = 'unproven') as txUnprovenTotal,
    (select count(*) from transactions where status = 'unsigned' and created_at > '${oneDayAgo}') as txUnsignedDay,
    (select count(*) from transactions where status = 'unsigned' and created_at > '${oneWeekAgo}') as txUnsignedWeek,
    (select count(*) from transactions where status = 'unsigned' and created_at > '${oneMonthAgo}') as txUnsignedMonth,
    (select count(*) from transactions where status = 'unsigned') as txUnsignedTotal,
    (select count(*) from transactions where status = 'nosend' and created_at > '${oneDayAgo}') as txNosendDay,
    (select count(*) from transactions where status = 'nosend' and created_at > '${oneWeekAgo}') as txNosendWeek,
    (select count(*) from transactions where status = 'nosend' and created_at > '${oneMonthAgo}') as txNosendMonth,
    (select count(*) from transactions where status = 'nosend') as txNosendTotal,
    (select count(*) from transactions where status = 'nonfinal' and created_at > '${oneDayAgo}') as txNonfinalDay,
    (select count(*) from transactions where status = 'nonfinal' and created_at > '${oneWeekAgo}') as txNonfinalWeek,
    (select count(*) from transactions where status = 'nonfinal' and created_at > '${oneMonthAgo}') as txNonfinalMonth,
    (select count(*) from transactions where status = 'nonfinal') as txNonfinalTotal,
    (select count(*) from transactions where status = 'unfail' and created_at > '${oneDayAgo}') as txUnfailDay,
    (select count(*) from transactions where status = 'unfail' and created_at > '${oneWeekAgo}') as txUnfailWeek,
    (select count(*) from transactions where status = 'unfail' and created_at > '${oneMonthAgo}') as txUnfailMonth,
    (select count(*) from transactions where status = 'unfail') as txUnfailTotal,
    (select sum(o.satoshis) from outputs o, transactions t where o.transactionId = t.transactionId and t.status = 'completed' and o.spendable = 1 and o.change = 1 and o.created_at > '${oneDayAgo}') as satoshisDefaultDay,
    (select sum(o.satoshis) from outputs o, transactions t where o.transactionId = t.transactionId and t.status = 'completed' and o.spendable = 1 and o.change = 1 and o.created_at > '${oneWeekAgo}') as satoshisDefaultWeek,
    (select sum(o.satoshis) from outputs o, transactions t where o.transactionId = t.transactionId and t.status = 'completed' and o.spendable = 1 and o.change = 1 and o.created_at > '${oneMonthAgo}') as satoshisDefaultMonth,
    (select sum(o.satoshis) from outputs o, transactions t where o.transactionId = t.transactionId and t.status = 'completed' and o.spendable = 1 and o.change = 1) as satoshisDefaultTotal,
    (select sum(o.satoshis) from outputs o, transactions t where o.transactionId = t.transactionId and t.status = 'completed' and o.spendable = 1 and o.change = 0 and not o.basketId is null and o.created_at > '${oneDayAgo}') as satoshisOtherDay,
    (select sum(o.satoshis) from outputs o, transactions t where o.transactionId = t.transactionId and t.status = 'completed' and o.spendable = 1 and o.change = 0 and not o.basketId is null and o.created_at > '${oneWeekAgo}') as satoshisOtherWeek,
    (select sum(o.satoshis) from outputs o, transactions t where o.transactionId = t.transactionId and t.status = 'completed' and o.spendable = 1 and o.change = 0 and not o.basketId is null and o.created_at > '${oneMonthAgo}') as satoshisOtherMonth,
    (select sum(o.satoshis) from outputs o, transactions t where o.transactionId = t.transactionId and t.status = 'completed' and o.spendable = 1 and o.change = 0 and not o.basketId is null) as satoshisOtherTotal,
    (select count(*) from output_baskets where created_at > '${oneDayAgo}') as basketsDay,
    (select count(*) from output_baskets where created_at > '${oneWeekAgo}') as basketsWeek,
    (select count(*) from output_baskets where created_at > '${oneMonthAgo}') as basketsMonth,
    (select count(*) from output_baskets) as basketsTotal,
    (select count(*) from tx_labels where created_at > '${oneDayAgo}') as labelsDay,
    (select count(*) from tx_labels where created_at > '${oneWeekAgo}') as labelsWeek,
    (select count(*) from tx_labels where created_at > '${oneMonthAgo}') as labelsMonth,
    (select count(*) from tx_labels) as labelsTotal,
    (select count(*) from output_tags where created_at > '${oneDayAgo}') as tagsDay,
    (select count(*) from output_tags where created_at > '${oneWeekAgo}') as tagsWeek,
    (select count(*) from output_tags where created_at > '${oneMonthAgo}') as tagsMonth,
    (select count(*) from output_tags) as tagsTotal
      `);
        const r: AdminStatsResult = {
            monitorStats,
            servicesStats,
            requestedBy: adminIdentityKey,
            when: new Date().toISOString(),
            usersDay,
            usersWeek,
            usersMonth,
            usersTotal,
            transactionsDay,
            transactionsWeek,
            transactionsMonth,
            transactionsTotal,
            txCompletedDay,
            txCompletedWeek,
            txCompletedMonth,
            txCompletedTotal,
            txFailedDay,
            txFailedWeek,
            txFailedMonth,
            txFailedTotal,
            txAbandonedDay,
            txAbandonedWeek,
            txAbandonedMonth,
            txAbandonedTotal,
            txUnprocessedDay,
            txUnprocessedWeek,
            txUnprocessedMonth,
            txUnprocessedTotal,
            txSendingDay,
            txSendingWeek,
            txSendingMonth,
            txSendingTotal,
            txUnprovenDay,
            txUnprovenWeek,
            txUnprovenMonth,
            txUnprovenTotal,
            txUnsignedDay,
            txUnsignedWeek,
            txUnsignedMonth,
            txUnsignedTotal,
            txNosendDay,
            txNosendWeek,
            txNosendMonth,
            txNosendTotal,
            txNonfinalDay,
            txNonfinalWeek,
            txNonfinalMonth,
            txNonfinalTotal,
            txUnfailDay,
            txUnfailWeek,
            txUnfailMonth,
            txUnfailTotal,
            satoshisDefaultDay: Number(satoshisDefaultDay),
            satoshisDefaultWeek: Number(satoshisDefaultWeek),
            satoshisDefaultMonth: Number(satoshisDefaultMonth),
            satoshisDefaultTotal: Number(satoshisDefaultTotal),
            satoshisOtherDay: Number(satoshisOtherDay),
            satoshisOtherWeek: Number(satoshisOtherWeek),
            satoshisOtherMonth: Number(satoshisOtherMonth),
            satoshisOtherTotal: Number(satoshisOtherTotal),
            basketsDay,
            basketsWeek,
            basketsMonth,
            basketsTotal,
            labelsDay,
            labelsWeek,
            labelsMonth,
            labelsTotal,
            tagsDay,
            tagsWeek,
            tagsMonth,
            tagsTotal
        };
        return r;
    }
}
```

See also: [AdminStatsResult](./storage.md#interface-adminstatsresult), [AuthId](./client.md#interface-authid), [Brc177NoSendExpiryState](./client.md#type-brc177nosendexpirystate), [DBType](./storage.md#type-dbtype), [EntityTimeStamp](./client.md#interface-entitytimestamp), [FindCertificateFieldsArgs](./client.md#interface-findcertificatefieldsargs), [FindCertificatesArgs](./client.md#interface-findcertificatesargs), [FindCommissionsArgs](./client.md#interface-findcommissionsargs), [FindForUserSincePagedArgs](./client.md#interface-findforusersincepagedargs), [FindMonitorEventsArgs](./client.md#interface-findmonitoreventsargs), [FindOutputBasketsArgs](./client.md#interface-findoutputbasketsargs), [FindOutputTagMapsArgs](./client.md#interface-findoutputtagmapsargs), [FindOutputTagsArgs](./client.md#interface-findoutputtagsargs), [FindOutputsArgs](./client.md#interface-findoutputsargs), [FindPartialSincePagedArgs](./client.md#interface-findpartialsincepagedargs), [FindProvenTxReqsArgs](./client.md#interface-findproventxreqsargs), [FindProvenTxsArgs](./client.md#interface-findproventxsargs), [FindStaleMerkleRootsArgs](./client.md#interface-findstalemerklerootsargs), [FindSyncStatesArgs](./client.md#interface-findsyncstatesargs), [FindTransactionsArgs](./client.md#interface-findtransactionsargs), [FindTxLabelMapsArgs](./client.md#interface-findtxlabelmapsargs), [FindTxLabelsArgs](./client.md#interface-findtxlabelsargs), [FindUsersArgs](./client.md#interface-findusersargs), [ManagedChangeInputCandidate](./storage.md#type-managedchangeinputcandidate), [PreparedBeefLookupResult](./storage.md#interface-preparedbeeflookupresult), [PreparedBeefPolicy](./storage.md#interface-preparedbeefpolicy), [PreparedBeefPreparation](./storage.md#interface-preparedbeefpreparation), [PreparedBeefRoot](./storage.md#interface-preparedbeefroot), [ProvenOrRawTx](./client.md#interface-provenorrawtx), [PurgeParams](./client.md#interface-purgeparams), [PurgeResults](./client.md#interface-purgeresults), [RequestSyncChunkArgs](./client.md#interface-requestsyncchunkargs), [ServicesCallHistory](./client.md#interface-servicescallhistory), [StorageKnexOptions](./storage.md#interface-storageknexoptions), [StorageProvider](./storage.md#class-storageprovider), [SyncChunkTotals](./client.md#interface-syncchunktotals), [TableActionBatch](./storage.md#interface-tableactionbatch), [TableActionBatchBlob](./storage.md#interface-tableactionbatchblob), [TableActionBatchOutput](./storage.md#interface-tableactionbatchoutput), [TableCertificate](./storage.md#interface-tablecertificate), [TableCertificateField](./storage.md#interface-tablecertificatefield), [TableCertificateX](./storage.md#interface-tablecertificatex), [TableCommission](./storage.md#interface-tablecommission), [TableMonitorEvent](./storage.md#interface-tablemonitorevent), [TableOutput](./storage.md#interface-tableoutput), [TableOutputBasket](./storage.md#interface-tableoutputbasket), [TableOutputTag](./storage.md#interface-tableoutputtag), [TableOutputTagMap](./storage.md#interface-tableoutputtagmap), [TablePreparedBeef](./storage.md#interface-tablepreparedbeef), [TableProvenTx](./storage.md#interface-tableproventx), [TableProvenTxReq](./storage.md#interface-tableproventxreq), [TableSettings](./storage.md#interface-tablesettings), [TableSyncState](./storage.md#interface-tablesyncstate), [TableTransaction](./storage.md#interface-tabletransaction), [TableTxLabel](./storage.md#interface-tabletxlabel), [TableTxLabelMap](./storage.md#interface-tabletxlabelmap), [TableUser](./storage.md#interface-tableuser), [TransactionStatus](./client.md#type-transactionstatus), [TrxToken](./client.md#interface-trxtoken), [WERR_NOT_IMPLEMENTED](./client.md#class-werr_not_implemented), [WalletServices](./client.md#interface-walletservices), [WalletStorageProvider](./client.md#interface-walletstorageprovider), [listActions](./storage.md#function-listactions), [listOutputs](./storage.md#function-listoutputs), [lookupPreparedBeefs](./storage.md#function-lookuppreparedbeefs), [purgeData](./storage.md#function-purgedata), [reviewStatus](./storage.md#function-reviewstatus), [validateEntities](./storage.md#function-validateentities), [validateEntity](./storage.md#function-validateentity), [verifyOneOrNone](./client.md#function-verifyoneornone)

###### Method allocateChangeInput

Finds closest matching available change output to use as input for new transaction.

Transactionally allocate the output such that

```ts
async allocateChangeInput(userId: number, basketId: number, targetSatoshis: number, exactSatoshis: number | undefined, excludeSending: boolean, transactionId: number): Promise<TableOutput | undefined>
```
See also: [TableOutput](./storage.md#interface-tableoutput)

###### Method countChangeInputs

Counts wallet-managed BRC-29 change outputs for userId in basketId that
are currently eligible for automatic allocation
AND whose transaction status is one of:
- completed
- unproven
- sending (if excludeSending is false)

```ts
async countChangeInputs(userId: number, basketId: number, excludeSending: boolean): Promise<number>
```

###### Method enqueuePreparedBeef

Queue best-effort preparation after foreground action work has completed.

```ts
enqueuePreparedBeef(preparation: PreparedBeefPreparation): boolean
```
See also: [PreparedBeefPreparation](./storage.md#interface-preparedbeefpreparation)

###### Method readPreparedBeefLookupByteLength

Metadata-only foreground preflight for fragmented actions. SQL computes
the actual blob lengths; BEEF bytes are not transferred to the process.

```ts
async readPreparedBeefLookupByteLength(userId: number, rootTxids: string[]): Promise<number>
```

###### Method readPreparedBeefSourceByteLength

Cheap worker preflight. It prevents a large tenant-controlled no-send BEEF
from being loaded and parsed merely to discover that COOK will reject it.

```ts
async readPreparedBeefSourceByteLength(rootTxid: string): Promise<number | undefined>
```

###### Method startPreparedBeefBackfill

Start the optional, rate-limited existing-wallet backfill.

```ts
startPreparedBeefBackfill(): void
```

###### Method stopPreparedBeefTasks

Stop accepting background work and settle an active preparation before shutdown.

```ts
async stopPreparedBeefTasks(): Promise<void>
```

###### Method suspendPreparedBeefReads

Synchronously close the local prepared-read gate before asynchronous reorg
invalidation waits for manager/database locks. The returned release is
idempotent; callers release it only after invalidation commits.

```ts
suspendPreparedBeefReads(): () => void
```

###### Method toDb

Convert the standard optional `TrxToken` parameter into either a direct knex database instance,
or a Knex.Transaction as appropriate.

```ts
toDb(trx?: TrxToken): Knex | Knex.Transaction<any, any[]>
```
See also: [TrxToken](./client.md#interface-trxtoken)

###### Method validateEntities

Helper to force uniform behavior across database engines.
Use to process all arrays of records with time stamps retreived from database.

```ts
validateEntities<T extends EntityTimeStamp>(entities: T[], dateFields?: string[], booleanFields?: string[]): T[]
```
See also: [EntityTimeStamp](./client.md#interface-entitytimestamp)

Returns

input `entities` array with contained values validated.

###### Method validateEntity

Helper to force uniform behavior across database engines.
Use to process all individual records with time stamps retreived from database.

```ts
validateEntity<T extends EntityTimeStamp>(entity: T, dateFields?: string[], booleanFields?: string[]): T
```
See also: [EntityTimeStamp](./client.md#interface-entitytimestamp)

###### Method validateEntityForInsert

Helper to force uniform behavior across database engines.
Use to process new entities being inserted into the database.

```ts
async validateEntityForInsert<T extends EntityTimeStamp>(entity: T, trx?: TrxToken, dateFields?: string[], booleanFields?: string[]): Promise<any>
```
See also: [EntityTimeStamp](./client.md#interface-entitytimestamp), [TrxToken](./client.md#interface-trxtoken)

###### Method validatePartialForUpdate

Helper to force uniform behavior across database engines.
Use to process the update template for entities being updated.

```ts
validatePartialForUpdate<T extends EntityTimeStamp>(update: Partial<T>, dateFields?: string[], booleanFields?: string[]): Partial<T>
```
See also: [EntityTimeStamp](./client.md#interface-entitytimestamp)

###### Method verifyReadyForDatabaseAccess

Make sure database is ready for access:

- dateScheme is known
- foreign key constraints are enabled

```ts
async verifyReadyForDatabaseAccess(trx?: TrxToken): Promise<DBType>
```
See also: [DBType](./storage.md#type-dbtype), [TrxToken](./client.md#interface-trxtoken)

###### Method waitForPreparedBeefTasks

Test/operator hook for waiting until currently queued work is complete.

```ts
async waitForPreparedBeefTasks(): Promise<void>
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Class: StorageProvider

```ts
export abstract class StorageProvider extends StorageReaderWriter implements WalletStorageProvider {
    isDirty = false;
    _services?: WalletServices;
    feeModel: StorageFeeModel;
    commissionSatoshis: number;
    commissionPubKeyHex?: PubKeyHex;
    maxRecursionDepth?: number;
    readonly actionBatchMaxReservedOutputs: number;
    readonly managedChangePolicy: ManagedChangePolicy;
    readonly scriptVerifier?: SpendVerifierInterface;
    static defaultOptions(): {
        feeModel: StorageFeeModel;
        commissionSatoshis: number;
        commissionPubKeyHex: undefined;
        actionBatchMaxReservedOutputs: number;
        managedChangePolicy: ManagedChangePolicy;
    }
    static createStorageBaseOptions(chain: Chain): StorageProviderOptions
    constructor(options: StorageProviderOptions)
    abstract reviewStatus(args: {
        agedLimit: Date;
        trx?: TrxToken;
    }): Promise<{
        log: string;
    }>;
    abstract purgeData(params: PurgeParams, trx?: TrxToken): Promise<PurgeResults>;
    abstract allocateChangeInput(userId: number, basketId: number, targetSatoshis: number, exactSatoshis: number | undefined, excludeSending: boolean, transactionId: number): Promise<TableOutput | undefined>;
    async markChangeInputsSpent(outputIds: number[], transactionId: number, trx: TrxToken): Promise<number>
    async insertOutputs(outputs: TableOutput[], trx?: TrxToken): Promise<void>
    async findAvailableManagedChangeInputs(userId: number, basketId: number, excludeSending: boolean, trx?: TrxToken): Promise<TableOutput[]>
    async findAvailableManagedChangeInputCandidates(userId: number, basketId: number, excludeSending: boolean, trx?: TrxToken): Promise<ManagedChangeInputCandidate[]>
    async findTransactionStatusesByIds(userId: number, transactionIds: number[], trx?: TrxToken): Promise<Map<number, TransactionStatus>>
    async findFundingOutputsForUpdate(userId: number, outputIds: number[], statuses: TransactionStatus[], trx: TrxToken): Promise<Record<number, TableOutput>>
    abstract getProvenOrRawTx(txid: string, trx?: TrxToken): Promise<ProvenOrRawTx>;
    async getProvenOrRawTxs(txids: string[], trx?: TrxToken): Promise<Map<string, ProvenOrRawTx>>
    abstract getRawTxOfKnownValidTransaction(txid?: string, offset?: number, length?: number, trx?: TrxToken): Promise<number[] | undefined>;
    abstract getLabelsForTransactionId(transactionId?: number, trx?: TrxToken): Promise<TableTxLabel[]>;
    abstract getTagsForOutputId(outputId: number, trx?: TrxToken): Promise<TableOutputTag[]>;
    abstract listActions(auth: AuthId, args: Validation.ValidListActionsArgs): Promise<ListActionsResult>;
    abstract listOutputs(auth: AuthId, args: Validation.ValidListOutputsArgs): Promise<ListOutputsResult>;
    abstract countChangeInputs(userId: number, basketId: number, excludeSending: boolean): Promise<number>;
    async insertActionBatch(_batch: TableActionBatch, _trx?: TrxToken): Promise<number>
    async findActionBatch(_userId: number, _batchId: string, _trx?: TrxToken): Promise<TableActionBatch | undefined>
    async findActionBatchForUpdate(userId: number, batchId: string, trx: TrxToken): Promise<TableActionBatch | undefined>
    async findExpiredActionBatches(_now: Date, _trx?: TrxToken): Promise<TableActionBatch[]>
    async updateActionBatch(_actionBatchId: number, _update: Partial<TableActionBatch>, _trx?: TrxToken): Promise<number>
    async deleteActionBatch(_actionBatchId: number, _trx?: TrxToken): Promise<void>
    async reserveActionBatchOutputs(_reservations: TableActionBatchOutput[], _trx?: TrxToken): Promise<void>
    async findActionBatchOutputIds(_actionBatchId: number, _trx?: TrxToken): Promise<number[]>
    async findReservedActionBatchOutputIds(_outputIds: number[], _trx?: TrxToken): Promise<number[]>
    async deleteActionBatchOutputReservations(_actionBatchId: number, _trx?: TrxToken): Promise<void>
    async putActionBatchBlobRecord(_blob: TableActionBatchBlob, _trx?: TrxToken): Promise<void>
    async findActionBatchBlobRecord(_actionBatchId: number, _digest: string, _trx?: TrxToken): Promise<TableActionBatchBlob | undefined>
    async findActionBatchBlobRecords(actionBatchId: number, digests: string[], trx?: TrxToken): Promise<TableActionBatchBlob[]>
    async putActionBatchBlobRecords(blobs: TableActionBatchBlob[], trx?: TrxToken): Promise<void>
    async deleteActionBatchBlobRecords(_actionBatchId: number, _trx?: TrxToken): Promise<void>
    async getCapabilities(): Promise<StorageCapabilities>
    async findProvenTxReqsAuth(auth: AuthId, args: FindProvenTxReqsArgs): Promise<TableProvenTxReq[]>
    async prepareNoSendExpiry(auth: AuthId, args: Validation.ValidCreateActionArgs): Promise<StoragePrepareNoSendExpiryResult>
    async activateNoSendExpiry(auth: AuthId, args: StorageActivateNoSendExpiryArgs): Promise<StorageActivateNoSendExpiryResult>
    async armNoSendExpiry(auth: AuthId, args: StorageArmNoSendExpiryArgs): Promise<void>
    protected supportsNoSendExpiryPersistence(): boolean
    protected supportsActionBatchPersistence(): boolean
    protected requiresActionBatchCleanupBeforeCreateAction(): boolean
    async beginActionBatch(auth: AuthId, args: BeginActionBatchArgs): Promise<BeginActionBatchResult>
    async extendActionBatch(auth: AuthId, args: ExtendActionBatchArgs): Promise<ExtendActionBatchResult>
    async renewActionBatch(auth: AuthId, batchId: string): Promise<RenewActionBatchResult>
    async resumeActionBatch(auth: AuthId, args: ResumeActionBatchArgs): Promise<ResumeActionBatchResult>
    async prepareActionBatchCommit(auth: AuthId, manifest: ActionBatchManifest): Promise<PrepareActionBatchCommitResult>
    async putActionBatchBlob(auth: AuthId, args: PutActionBatchBlobArgs): Promise<void>
    async putActionBatchPack(auth: AuthId, args: PutActionBatchPackArgs): Promise<void>
    async commitActionBatch(auth: AuthId, manifest: ActionBatchManifest): Promise<CommitActionBatchResult>
    async commitActionBatchByDigest(auth: AuthId, args: CommitActionBatchByDigestArgs): Promise<CommitActionBatchResult>
    async abortActionBatch(auth: AuthId, batchId: string): Promise<AbortActionBatchResult>
    async findOutputsByIds(outputIds: number[], trx?: TrxToken): Promise<Record<number, TableOutput>>
    async findStaleMerkleRoots(args: FindStaleMerkleRootsArgs): Promise<string[]>
    async findOutputsByOutpoints(userId: number, outpoints: Array<{
        txid: string;
        vout: number;
    }>, trx?: TrxToken): Promise<Record<string, TableOutput>>
    async findOutputsByOutpointsForUpdate(userId: number, outpoints: Array<{
        txid: string;
        vout: number;
    }>, trx: TrxToken, _noScript = false): Promise<Record<string, TableOutput>>
    async findOrInsertOutputBasketsBulk(userId: number, names: string[], trx?: TrxToken): Promise<Record<string, TableOutputBasket>>
    async findOrInsertOutputTagsBulk(userId: number, tags: string[], trx?: TrxToken): Promise<Record<string, TableOutputTag>>
    async findOrInsertTxLabelsBulk(userId: number, labels: string[], trx?: TrxToken): Promise<Record<string, TableTxLabel>>
    async sumSpendableSatoshisInBasket(userId: number, basketId: number, excludeSending: boolean, trx?: TrxToken): Promise<number>
    abstract findCertificatesAuth(auth: AuthId, args: FindCertificatesArgs): Promise<TableCertificateX[]>;
    abstract findOutputBasketsAuth(auth: AuthId, args: FindOutputBasketsArgs): Promise<TableOutputBasket[]>;
    abstract findOutputsAuth(auth: AuthId, args: FindOutputsArgs): Promise<TableOutput[]>;
    abstract insertCertificateAuth(auth: AuthId, certificate: TableCertificateX): Promise<number>;
    abstract adminStats(adminIdentityKey: string): Promise<AdminStatsResult>;
    async recentlyActiveUsers(limit = 50, trx?: TrxToken): Promise<TableUser[]>
    override isStorageProvider(): boolean
    setServices(v: WalletServices): void
    getServices(): WalletServices
    async abortAction(auth: AuthId, args: AbortActionArgs): Promise<AbortActionResult>
    async internalizeAction(auth: AuthId, args: InternalizeActionArgs): Promise<StorageInternalizeActionResult>
    async getReqsAndBeefToShareWithWorld(txids: string[], knownTxids: string[], trx?: TrxToken): Promise<GetReqsAndBeefResult>
    async mergeReqToBeefToShareExternally(req: TableProvenTxReq, mergeToBeef: Beef, knownTxids: string[], trx?: TrxToken): Promise<void>
    async getProvenOrReq(txid: string, newReq?: TableProvenTxReq, trx?: TrxToken): Promise<StorageProvenOrReq>
    async updateTransactionsStatus(transactionIds: number[], status: TransactionStatus, trx?: TrxToken): Promise<void>
    async updateTransactionStatus(status: TransactionStatus, transactionId?: number, userId?: number, reference?: string, trx?: TrxToken): Promise<void>
    async createAction(auth: AuthId, args: Validation.ValidCreateActionArgs): Promise<StorageCreateActionResult>
    async processAction(auth: AuthId, args: StorageProcessActionArgs): Promise<StorageProcessActionResults>
    async attemptToPostReqsToNetwork(reqs: EntityProvenTxReq[], trx?: TrxToken, logger?: WalletLoggerInterface): Promise<PostReqsToNetworkResult>
    async listCertificates(auth: AuthId, args: Validation.ValidListCertificatesArgs): Promise<ListCertificatesResult>
    async verifyKnownValidTransaction(txid: string, trx?: TrxToken): Promise<boolean>
    async getValidBeefForKnownTxid(txid: string, mergeToBeef?: Beef, trustSelf?: TrustSelf, knownTxids?: string[], trx?: TrxToken, requiredLevels?: number): Promise<Beef>
    async getValidBeefForTxid(...[txid, mergeToBeef, trustSelf, knownTxids, trx, requiredLevels, chainTracker, skipInvalidProofs]: [
        txid: string,
        mergeToBeef?: Beef,
        trustSelf?: TrustSelf,
        knownTxids?: string[],
        trx?: TrxToken,
        requiredLevels?: number,
        chainTracker?: ChainTracker,
        skipInvalidProofs?: boolean
    ]): Promise<Beef | undefined>
    async getBeefForTransaction(txid: string, options: StorageGetBeefOptions): Promise<Beef>
    async getBeefForTransactions(txids: string[], options: StorageGetBeefOptions): Promise<Beef>
    async findMonitorEventById(id: number, trx?: TrxToken): Promise<TableMonitorEvent | undefined>
    async relinquishCertificate(auth: AuthId, args: RelinquishCertificateArgs): Promise<number>
    async relinquishOutput(auth: AuthId, args: RelinquishOutputArgs): Promise<number>
    async processSyncChunk(args: RequestSyncChunkArgs, chunk: SyncChunk): Promise<ProcessSyncChunkResult>
    async updateProvenTxReqWithNewProvenTx(args: UpdateProvenTxReqWithNewProvenTxArgs, validatedCandidate?: TableProvenTx): Promise<UpdateProvenTxReqWithNewProvenTxResult>
    async updateProvenTxReqWithNewProvenTxAuth(auth: AuthId, args: UpdateProvenTxReqWithNewProvenTxArgs): Promise<UpdateProvenTxReqWithNewProvenTxResult>
    async reconcileCompletedProvenTxReqs(): Promise<{
        log: string;
    }>
    async unfailTransactionsForProof(req: EntityProvenTxReq, indent = 0, requestUpdate?: Pick<TableProvenTxReqDynamics, "status" | "attempts">): Promise<string>
    async confirmSpendableOutputs(): Promise<{
        invalidSpendableOutputs: TableOutput[];
    }>
    async updateProvenTxReqDynamics(id: number, update: Partial<TableProvenTxReqDynamics>, trx?: TrxToken): Promise<number>
    async extendOutput(o: TableOutput, includeBasket = false, includeTags = false, trx?: TrxToken): Promise<TableOutputX>
    async validateOutputScript(o: TableOutput, trx?: TrxToken): Promise<void>
}
```

See also: [AbortActionBatchResult](./client.md#interface-abortactionbatchresult), [ActionBatchManifest](./client.md#interface-actionbatchmanifest), [AdminStatsResult](./storage.md#interface-adminstatsresult), [AuthId](./client.md#interface-authid), [BeginActionBatchArgs](./client.md#interface-beginactionbatchargs), [BeginActionBatchResult](./client.md#interface-beginactionbatchresult), [Chain](./client.md#type-chain), [CommitActionBatchByDigestArgs](./client.md#interface-commitactionbatchbydigestargs), [CommitActionBatchResult](./client.md#interface-commitactionbatchresult), [EntityProvenTxReq](./storage.md#class-entityproventxreq), [ExtendActionBatchArgs](./client.md#interface-extendactionbatchargs), [ExtendActionBatchResult](./client.md#interface-extendactionbatchresult), [FindCertificatesArgs](./client.md#interface-findcertificatesargs), [FindOutputBasketsArgs](./client.md#interface-findoutputbasketsargs), [FindOutputsArgs](./client.md#interface-findoutputsargs), [FindProvenTxReqsArgs](./client.md#interface-findproventxreqsargs), [FindStaleMerkleRootsArgs](./client.md#interface-findstalemerklerootsargs), [GetReqsAndBeefResult](./storage.md#interface-getreqsandbeefresult), [ManagedChangeInputCandidate](./storage.md#type-managedchangeinputcandidate), [ManagedChangePolicy](./storage.md#interface-managedchangepolicy), [PostReqsToNetworkResult](./storage.md#interface-postreqstonetworkresult), [PrepareActionBatchCommitResult](./client.md#interface-prepareactionbatchcommitresult), [ProcessSyncChunkResult](./client.md#interface-processsyncchunkresult), [ProvenOrRawTx](./client.md#interface-provenorrawtx), [PurgeParams](./client.md#interface-purgeparams), [PurgeResults](./client.md#interface-purgeresults), [PutActionBatchBlobArgs](./client.md#interface-putactionbatchblobargs), [PutActionBatchPackArgs](./client.md#interface-putactionbatchpackargs), [RenewActionBatchResult](./client.md#interface-renewactionbatchresult), [RequestSyncChunkArgs](./client.md#interface-requestsyncchunkargs), [ResumeActionBatchArgs](./client.md#interface-resumeactionbatchargs), [ResumeActionBatchResult](./client.md#interface-resumeactionbatchresult), [StorageActivateNoSendExpiryArgs](./client.md#interface-storageactivatenosendexpiryargs), [StorageActivateNoSendExpiryResult](./client.md#interface-storageactivatenosendexpiryresult), [StorageArmNoSendExpiryArgs](./client.md#interface-storagearmnosendexpiryargs), [StorageCapabilities](./client.md#interface-storagecapabilities), [StorageCreateActionResult](./client.md#interface-storagecreateactionresult), [StorageFeeModel](./client.md#interface-storagefeemodel), [StorageGetBeefOptions](./client.md#interface-storagegetbeefoptions), [StorageInternalizeActionResult](./client.md#interface-storageinternalizeactionresult), [StoragePrepareNoSendExpiryResult](./client.md#interface-storagepreparenosendexpiryresult), [StorageProcessActionArgs](./client.md#interface-storageprocessactionargs), [StorageProcessActionResults](./client.md#interface-storageprocessactionresults), [StorageProvenOrReq](./client.md#interface-storageprovenorreq), [StorageProviderOptions](./storage.md#interface-storageprovideroptions), [StorageReaderWriter](./storage.md#class-storagereaderwriter), [SyncChunk](./client.md#interface-syncchunk), [TableActionBatch](./storage.md#interface-tableactionbatch), [TableActionBatchBlob](./storage.md#interface-tableactionbatchblob), [TableActionBatchOutput](./storage.md#interface-tableactionbatchoutput), [TableCertificateX](./storage.md#interface-tablecertificatex), [TableMonitorEvent](./storage.md#interface-tablemonitorevent), [TableOutput](./storage.md#interface-tableoutput), [TableOutputBasket](./storage.md#interface-tableoutputbasket), [TableOutputTag](./storage.md#interface-tableoutputtag), [TableOutputX](./storage.md#interface-tableoutputx), [TableProvenTx](./storage.md#interface-tableproventx), [TableProvenTxReq](./storage.md#interface-tableproventxreq), [TableProvenTxReqDynamics](./storage.md#interface-tableproventxreqdynamics), [TableTxLabel](./storage.md#interface-tabletxlabel), [TableUser](./storage.md#interface-tableuser), [TransactionStatus](./client.md#type-transactionstatus), [TrxToken](./client.md#interface-trxtoken), [UpdateProvenTxReqWithNewProvenTxArgs](./client.md#interface-updateproventxreqwithnewproventxargs), [UpdateProvenTxReqWithNewProvenTxResult](./client.md#interface-updateproventxreqwithnewproventxresult), [WalletServices](./client.md#interface-walletservices), [WalletStorageProvider](./client.md#interface-walletstorageprovider), [abortActionBatch](./storage.md#function-abortactionbatch), [activateNoSendExpiry](./storage.md#function-activatenosendexpiry), [armNoSendExpiry](./storage.md#function-armnosendexpiry), [attemptToPostReqsToNetwork](./storage.md#function-attempttopostreqstonetwork), [beginActionBatch](./storage.md#function-beginactionbatch), [commitActionBatch](./storage.md#function-commitactionbatch), [commitActionBatchByDigest](./storage.md#function-commitactionbatchbydigest), [createAction](./storage.md#function-createaction), [extendActionBatch](./storage.md#function-extendactionbatch), [getBeefForTransaction](./storage.md#function-getbeeffortransaction), [getBeefForTransactions](./storage.md#function-getbeeffortransactions), [internalizeAction](./storage.md#function-internalizeaction), [listActions](./storage.md#function-listactions), [listCertificates](./storage.md#function-listcertificates), [listOutputs](./storage.md#function-listoutputs), [logger](./client.md#variable-logger), [prepareActionBatchCommit](./storage.md#function-prepareactionbatchcommit), [prepareNoSendExpiry](./storage.md#function-preparenosendexpiry), [processAction](./storage.md#function-processaction), [purgeData](./storage.md#function-purgedata), [putActionBatchBlob](./storage.md#function-putactionbatchblob), [putActionBatchPack](./storage.md#function-putactionbatchpack), [renewActionBatch](./storage.md#function-renewactionbatch), [resumeActionBatch](./storage.md#function-resumeactionbatch), [reviewStatus](./storage.md#function-reviewstatus)

###### Method confirmSpendableOutputs

For each spendable output in the 'default' basket of the authenticated user,
verify that the output script, satoshis, vout and txid match that of an output
still in the mempool of at least one service provider.

```ts
async confirmSpendableOutputs(): Promise<{
    invalidSpendableOutputs: TableOutput[];
}>
```
See also: [TableOutput](./storage.md#interface-tableoutput)

Returns

object with invalidSpendableOutputs array. A good result is an empty array.

###### Method findAvailableManagedChangeInputCandidates

Read only the fields needed by the in-memory funding planner.

```ts
async findAvailableManagedChangeInputCandidates(userId: number, basketId: number, excludeSending: boolean, trx?: TrxToken): Promise<ManagedChangeInputCandidate[]>
```
See also: [ManagedChangeInputCandidate](./storage.md#type-managedchangeinputcandidate), [TrxToken](./client.md#interface-trxtoken)

###### Method findAvailableManagedChangeInputs

Return unreserved wallet-managed outputs eligible for automatic funding.

```ts
async findAvailableManagedChangeInputs(userId: number, basketId: number, excludeSending: boolean, trx?: TrxToken): Promise<TableOutput[]>
```
See also: [TableOutput](./storage.md#interface-tableoutput), [TrxToken](./client.md#interface-trxtoken)

###### Method findFundingOutputsForUpdate

Lock and return the selected funding rows whose source transaction and
action-batch reservation state still permit allocation.

```ts
async findFundingOutputsForUpdate(userId: number, outputIds: number[], statuses: TransactionStatus[], trx: TrxToken): Promise<Record<number, TableOutput>>
```
See also: [TableOutput](./storage.md#interface-tableoutput), [TransactionStatus](./client.md#type-transactionstatus), [TrxToken](./client.md#interface-trxtoken)

###### Method findProvenTxReqsAuth

Restrict remotely requested proof work to transactions tracked by the
authenticated wallet. ProvenTxReq rows are globally deduplicated, so their
own schema has no userId column and must be authorized through transactions.

```ts
async findProvenTxReqsAuth(auth: AuthId, args: FindProvenTxReqsArgs): Promise<TableProvenTxReq[]>
```
See also: [AuthId](./client.md#interface-authid), [FindProvenTxReqsArgs](./client.md#interface-findproventxreqsargs), [TableProvenTxReq](./storage.md#interface-tableproventxreq)

###### Method findTransactionStatusesByIds

Read the current status of a set of source transactions without loading raw transaction bytes.

```ts
async findTransactionStatusesByIds(userId: number, transactionIds: number[], trx?: TrxToken): Promise<Map<number, TransactionStatus>>
```
See also: [TransactionStatus](./client.md#type-transactionstatus), [TrxToken](./client.md#interface-trxtoken)

###### Method getProvenOrRawTxs

Resolve several transaction proofs in one storage operation when the
backend supports it. The default preserves compatibility for custom
providers; SQL and IndexedDB providers override this hot path.

```ts
async getProvenOrRawTxs(txids: string[], trx?: TrxToken): Promise<Map<string, ProvenOrRawTx>>
```
See also: [ProvenOrRawTx](./client.md#interface-provenorrawtx), [TrxToken](./client.md#interface-trxtoken)

###### Method getReqsAndBeefToShareWithWorld

Given an array of transaction txids with current ProvenTxReq ready-to-share status,
lookup their ProvenTxReqApi req records.
For the txids with reqs and status still ready to send construct a single merged beef.

```ts
async getReqsAndBeefToShareWithWorld(txids: string[], knownTxids: string[], trx?: TrxToken): Promise<GetReqsAndBeefResult>
```
See also: [GetReqsAndBeefResult](./storage.md#interface-getreqsandbeefresult), [TrxToken](./client.md#interface-trxtoken)

###### Method getValidBeefForKnownTxid

Pulls data from storage to build a valid beef for a txid.

Optionally merges the data into an existing beef.
Optionally requires a minimum number of proof levels.

```ts
async getValidBeefForKnownTxid(txid: string, mergeToBeef?: Beef, trustSelf?: TrustSelf, knownTxids?: string[], trx?: TrxToken, requiredLevels?: number): Promise<Beef>
```
See also: [TrxToken](./client.md#interface-trxtoken)

###### Method insertOutputs

Insert outputs that do not need their generated ids returned to the
caller. Engines with a multi-row insert override this common-path helper;
the fallback preserves existing storage implementations unchanged.

```ts
async insertOutputs(outputs: TableOutput[], trx?: TrxToken): Promise<void>
```
See also: [TableOutput](./storage.md#interface-tableoutput), [TrxToken](./client.md#interface-trxtoken)

###### Method markChangeInputsSpent

Mark a planned set of change inputs spent within the caller's transaction.

```ts
async markChangeInputsSpent(outputIds: number[], transactionId: number, trx: TrxToken): Promise<number>
```
See also: [TrxToken](./client.md#interface-trxtoken)

###### Method reconcileCompletedProvenTxReqs

Reconcile completed proof requests whose transaction fan-out previously
failed or whose durable notification state drifted.

This is called by TaskReviewStatus so a completed request with
`notified = false` is retried and can become eligible for normal purge.

```ts
async reconcileCompletedProvenTxReqs(): Promise<{
    log: string;
}>
```

###### Method requiresActionBatchCleanupBeforeCreateAction

Custom providers may require physical expiry cleanup before reservations are queried.

```ts
protected requiresActionBatchCleanupBeforeCreateAction(): boolean
```

###### Method unfailTransactionsForProof

Restore every failed local copy of a transaction before proof completion.
Also heals the request's notification set from the authoritative txid
lookup so TaskUnFail cannot omit a local copy after notification drift.

```ts
async unfailTransactionsForProof(req: EntityProvenTxReq, indent = 0, requestUpdate?: Pick<TableProvenTxReqDynamics, "status" | "attempts">): Promise<string>
```
See also: [EntityProvenTxReq](./storage.md#class-entityproventxreq), [TableProvenTxReqDynamics](./storage.md#interface-tableproventxreqdynamics)

###### Method updateProvenTxReqWithNewProvenTx

Handles storage changes when a valid MerklePath and mined block header are found for a ProvenTxReq txid.

Performs the following storage updates (typically):
1. Lookup the exising `ProvenTxReq` record for its rawTx
2. Insert a new ProvenTx record using properties from `args` and rawTx, yielding a new provenTxId
3. Update ProvenTxReq record with status 'completed' and new provenTxId value (and history of status changed)
4. Unpack notify transactionIds from req and update each transaction's status to 'completed', provenTxId value.
5. Update ProvenTxReq history again to record that transactions have been notified.
6. Return results...

Alterations of "typically" to handle:

```ts
async updateProvenTxReqWithNewProvenTx(args: UpdateProvenTxReqWithNewProvenTxArgs, validatedCandidate?: TableProvenTx): Promise<UpdateProvenTxReqWithNewProvenTxResult>
```
See also: [TableProvenTx](./storage.md#interface-tableproventx), [UpdateProvenTxReqWithNewProvenTxArgs](./client.md#interface-updateproventxreqwithnewproventxargs), [UpdateProvenTxReqWithNewProvenTxResult](./client.md#interface-updateproventxreqwithnewproventxresult)

###### Method updateProvenTxReqWithNewProvenTxAuth

Authorize and validate remote proof completion before mutating shared proof state.

```ts
async updateProvenTxReqWithNewProvenTxAuth(auth: AuthId, args: UpdateProvenTxReqWithNewProvenTxArgs): Promise<UpdateProvenTxReqWithNewProvenTxResult>
```
See also: [AuthId](./client.md#interface-authid), [UpdateProvenTxReqWithNewProvenTxArgs](./client.md#interface-updateproventxreqwithnewproventxargs), [UpdateProvenTxReqWithNewProvenTxResult](./client.md#interface-updateproventxreqwithnewproventxresult)

###### Method updateTransactionStatus

For all `status` values besides 'failed', just updates the transaction records status property.

For 'status' of 'failed', attempts to make outputs previously allocated as inputs to this transaction usable again
and makes outputs generated by this transaction non-spendable.

```ts
async updateTransactionStatus(status: TransactionStatus, transactionId?: number, userId?: number, reference?: string, trx?: TrxToken): Promise<void>
```
See also: [TransactionStatus](./client.md#type-transactionstatus), [TrxToken](./client.md#interface-trxtoken)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Class: StorageReader

The `StorageReader` abstract class is the base of the concrete wallet storage provider classes.

It is the minimal interface required to read all wallet state records and is the base class for sync readers.

The next class in the heirarchy is the `StorageReaderWriter` which supports sync readers and writers.

The last class in the heirarchy is the `Storage` class which supports all active wallet operations.

The ability to construct a properly configured instance of this class implies authentication.
As such there are no user specific authenticated access checks implied in the implementation of any of these methods.

```ts
export abstract class StorageReader implements sdk.WalletStorageSyncReader {
    chain: sdk.Chain;
    readonly telemetry: Telemetry;
    _settings?: TableSettings;
    whenLastAccess?: Date;
    get dbtype(): DBType | undefined
    constructor(options: StorageReaderOptions)
    isAvailable(): boolean
    async makeAvailable(): Promise<TableSettings>
    getSettings(): TableSettings
    isStorageProvider(): boolean
    abstract destroy(): Promise<void>;
    abstract transaction<T>(scope: (trx: sdk.TrxToken) => Promise<T>, trx?: sdk.TrxToken): Promise<T>;
    abstract readSettings(trx?: sdk.TrxToken): Promise<TableSettings>;
    abstract findCertificateFields(args: sdk.FindCertificateFieldsArgs): Promise<TableCertificateField[]>;
    abstract findCertificates(args: sdk.FindCertificatesArgs): Promise<TableCertificateX[]>;
    abstract findCommissions(args: sdk.FindCommissionsArgs): Promise<TableCommission[]>;
    abstract findMonitorEvents(args: sdk.FindMonitorEventsArgs): Promise<TableMonitorEvent[]>;
    abstract findOutputBaskets(args: sdk.FindOutputBasketsArgs): Promise<TableOutputBasket[]>;
    abstract findOutputs(args: sdk.FindOutputsArgs): Promise<TableOutput[]>;
    abstract findOutputTags(args: sdk.FindOutputTagsArgs): Promise<TableOutputTag[]>;
    abstract findSyncStates(args: sdk.FindSyncStatesArgs): Promise<TableSyncState[]>;
    abstract findTransactions(args: sdk.FindTransactionsArgs): Promise<TableTransaction[]>;
    abstract findTxLabels(args: sdk.FindTxLabelsArgs): Promise<TableTxLabel[]>;
    abstract findUsers(args: sdk.FindUsersArgs): Promise<TableUser[]>;
    abstract countCertificateFields(args: sdk.FindCertificateFieldsArgs): Promise<number>;
    abstract countCertificates(args: sdk.FindCertificatesArgs): Promise<number>;
    abstract countCommissions(args: sdk.FindCommissionsArgs): Promise<number>;
    abstract countMonitorEvents(args: sdk.FindMonitorEventsArgs): Promise<number>;
    abstract countOutputBaskets(args: sdk.FindOutputBasketsArgs): Promise<number>;
    abstract countOutputs(args: sdk.FindOutputsArgs): Promise<number>;
    abstract countOutputTags(args: sdk.FindOutputTagsArgs): Promise<number>;
    abstract countSyncStates(args: sdk.FindSyncStatesArgs): Promise<number>;
    abstract countTransactions(args: sdk.FindTransactionsArgs): Promise<number>;
    abstract countTxLabels(args: sdk.FindTxLabelsArgs): Promise<number>;
    abstract countUsers(args: sdk.FindUsersArgs): Promise<number>;
    abstract getProvenTxsForUser(args: sdk.FindForUserSincePagedArgs): Promise<TableProvenTx[]>;
    abstract getProvenTxReqsForUser(args: sdk.FindForUserSincePagedArgs): Promise<TableProvenTxReq[]>;
    abstract getTxLabelMapsForUser(args: sdk.FindForUserSincePagedArgs): Promise<TableTxLabelMap[]>;
    abstract getOutputTagMapsForUser(args: sdk.FindForUserSincePagedArgs): Promise<TableOutputTagMap[]>;
    async getSyncChunkTotals(_args: sdk.RequestSyncChunkArgs, _userId: number): Promise<sdk.SyncChunkTotals | undefined>
    async findUserByIdentityKey(key: string): Promise<TableUser | undefined>
    async getSyncChunk(args: sdk.RequestSyncChunkArgs): Promise<sdk.SyncChunk>
    validateEntityDate(date: DateInput): StorageDate
    validateOptionalEntityDate(date: OptionalDateInput, useNowAsDefault?: boolean): StorageDate | undefined
    validateDate(date: DateInput): Date
    validateOptionalDate(date: OptionalDateInput): Date | undefined
    validateDateForWhere(date: DateInput): DateInput
}
```

See also: [Chain](./client.md#type-chain), [DBType](./storage.md#type-dbtype), [FindCertificateFieldsArgs](./client.md#interface-findcertificatefieldsargs), [FindCertificatesArgs](./client.md#interface-findcertificatesargs), [FindCommissionsArgs](./client.md#interface-findcommissionsargs), [FindForUserSincePagedArgs](./client.md#interface-findforusersincepagedargs), [FindMonitorEventsArgs](./client.md#interface-findmonitoreventsargs), [FindOutputBasketsArgs](./client.md#interface-findoutputbasketsargs), [FindOutputTagsArgs](./client.md#interface-findoutputtagsargs), [FindOutputsArgs](./client.md#interface-findoutputsargs), [FindSyncStatesArgs](./client.md#interface-findsyncstatesargs), [FindTransactionsArgs](./client.md#interface-findtransactionsargs), [FindTxLabelsArgs](./client.md#interface-findtxlabelsargs), [FindUsersArgs](./client.md#interface-findusersargs), [RequestSyncChunkArgs](./client.md#interface-requestsyncchunkargs), [StorageReaderOptions](./storage.md#interface-storagereaderoptions), [SyncChunk](./client.md#interface-syncchunk), [SyncChunkTotals](./client.md#interface-syncchunktotals), [TableCertificateField](./storage.md#interface-tablecertificatefield), [TableCertificateX](./storage.md#interface-tablecertificatex), [TableCommission](./storage.md#interface-tablecommission), [TableMonitorEvent](./storage.md#interface-tablemonitorevent), [TableOutput](./storage.md#interface-tableoutput), [TableOutputBasket](./storage.md#interface-tableoutputbasket), [TableOutputTag](./storage.md#interface-tableoutputtag), [TableOutputTagMap](./storage.md#interface-tableoutputtagmap), [TableProvenTx](./storage.md#interface-tableproventx), [TableProvenTxReq](./storage.md#interface-tableproventxreq), [TableSettings](./storage.md#interface-tablesettings), [TableSyncState](./storage.md#interface-tablesyncstate), [TableTransaction](./storage.md#interface-tabletransaction), [TableTxLabel](./storage.md#interface-tabletxlabel), [TableTxLabelMap](./storage.md#interface-tabletxlabelmap), [TableUser](./storage.md#interface-tableuser), [TrxToken](./client.md#interface-trxtoken), [WalletStorageSyncReader](./client.md#interface-walletstoragesyncreader), [getSyncChunk](./storage.md#function-getsyncchunk), [validateDate](./storage.md#function-validatedate)

###### Method getSyncChunkTotals

Optional efficient source-side totals for synchronization progress.
Providers without a native count implementation omit the metadata rather
than loading every matching record merely to count it.

```ts
async getSyncChunkTotals(_args: sdk.RequestSyncChunkArgs, _userId: number): Promise<sdk.SyncChunkTotals | undefined>
```
See also: [RequestSyncChunkArgs](./client.md#interface-requestsyncchunkargs), [SyncChunkTotals](./client.md#interface-syncchunktotals)

###### Method validateEntityDate

Force dates to strings on SQLite and Date objects on MySQL

```ts
validateEntityDate(date: DateInput): StorageDate
```

###### Method validateOptionalEntityDate

```ts
validateOptionalEntityDate(date: OptionalDateInput, useNowAsDefault?: boolean): StorageDate | undefined
```

Argument Details

+ **useNowAsDefault**
  + if true and date is null or undefiend, set to current time.

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Class: StorageReaderWriter

```ts
export abstract class StorageReaderWriter extends StorageReader {
    abstract dropAllData(): Promise<void>;
    abstract migrate(storageName: string, storageIdentityKey: string): Promise<string>;
    abstract findOutputTagMaps(args: FindOutputTagMapsArgs): Promise<TableOutputTagMap[]>;
    abstract findProvenTxReqs(args: FindProvenTxReqsArgs): Promise<TableProvenTxReq[]>;
    abstract findProvenTxs(args: FindProvenTxsArgs): Promise<TableProvenTx[]>;
    abstract findTxLabelMaps(args: FindTxLabelMapsArgs): Promise<TableTxLabelMap[]>;
    abstract findStaleMerkleRoots(args: FindStaleMerkleRootsArgs): Promise<string[]>;
    abstract countOutputTagMaps(args: FindOutputTagMapsArgs): Promise<number>;
    abstract countProvenTxReqs(args: FindProvenTxReqsArgs): Promise<number>;
    abstract countProvenTxs(args: FindProvenTxsArgs): Promise<number>;
    abstract countTxLabelMaps(args: FindTxLabelMapsArgs): Promise<number>;
    abstract insertCertificate(certificate: TableCertificate, trx?: TrxToken): Promise<number>;
    abstract insertCertificateField(certificateField: TableCertificateField, trx?: TrxToken): Promise<void>;
    abstract insertCommission(commission: TableCommission, trx?: TrxToken): Promise<number>;
    abstract insertMonitorEvent(event: TableMonitorEvent, trx?: TrxToken): Promise<number>;
    abstract insertOutput(output: TableOutput, trx?: TrxToken): Promise<number>;
    abstract insertOutputBasket(basket: TableOutputBasket, trx?: TrxToken): Promise<number>;
    abstract insertOutputTag(tag: TableOutputTag, trx?: TrxToken): Promise<number>;
    abstract insertOutputTagMap(tagMap: TableOutputTagMap, trx?: TrxToken): Promise<void>;
    abstract insertProvenTx(tx: TableProvenTx, trx?: TrxToken): Promise<number>;
    abstract insertProvenTxReq(tx: TableProvenTxReq, trx?: TrxToken): Promise<number>;
    abstract insertSyncState(syncState: TableSyncState, trx?: TrxToken): Promise<number>;
    abstract insertTransaction(tx: TableTransaction, trx?: TrxToken): Promise<number>;
    abstract insertTxLabel(label: TableTxLabel, trx?: TrxToken): Promise<number>;
    abstract insertTxLabelMap(labelMap: TableTxLabelMap, trx?: TrxToken): Promise<void>;
    abstract insertUser(user: TableUser, trx?: TrxToken): Promise<number>;
    abstract updateCertificate(id: number, update: Partial<TableCertificate>, trx?: TrxToken): Promise<number>;
    abstract updateCertificateField(certificateId: number, fieldName: string, update: Partial<TableCertificateField>, trx?: TrxToken): Promise<number>;
    abstract updateCommission(id: number, update: Partial<TableCommission>, trx?: TrxToken): Promise<number>;
    abstract updateMonitorEvent(id: number, update: Partial<TableMonitorEvent>, trx?: TrxToken): Promise<number>;
    abstract updateOutput(id: number, update: Partial<TableOutput>, trx?: TrxToken): Promise<number>;
    abstract updateOutputBasket(id: number, update: Partial<TableOutputBasket>, trx?: TrxToken): Promise<number>;
    abstract updateOutputTag(id: number, update: Partial<TableOutputTag>, trx?: TrxToken): Promise<number>;
    abstract updateOutputTagMap(outputId: number, tagId: number, update: Partial<TableOutputTagMap>, trx?: TrxToken): Promise<number>;
    abstract updateProvenTx(id: number, update: Partial<TableProvenTx>, trx?: TrxToken): Promise<number>;
    abstract updateProvenTxReq(id: number | number[], update: Partial<TableProvenTxReq>, trx?: TrxToken): Promise<number>;
    abstract updateSyncState(id: number, update: Partial<TableSyncState>, trx?: TrxToken): Promise<number>;
    abstract updateTransaction(id: number | number[], update: Partial<TableTransaction>, trx?: TrxToken): Promise<number>;
    async compareAndSetNoSendExpiryState(_transactionId: number, _expected: Brc177NoSendExpiryState, _next: Brc177NoSendExpiryState, _trx?: TrxToken): Promise<boolean>
    abstract updateTxLabel(id: number, update: Partial<TableTxLabel>, trx?: TrxToken): Promise<number>;
    abstract updateTxLabelMap(transactionId: number, txLabelId: number, update: Partial<TableTxLabelMap>, trx?: TrxToken): Promise<number>;
    abstract updateUser(id: number, update: Partial<TableUser>, trx?: TrxToken): Promise<number>;
    async setActive(auth: AuthId, newActiveStorageIdentityKey: string): Promise<number>
    async findCertificateById(id: number, trx?: TrxToken): Promise<TableCertificate | undefined>
    async findCommissionById(id: number, trx?: TrxToken): Promise<TableCommission | undefined>
    async findOutputById(id: number, trx?: TrxToken, noScript?: boolean): Promise<TableOutput | undefined>
    async findOutputBasketById(id: number, trx?: TrxToken): Promise<TableOutputBasket | undefined>
    async findProvenTxById(id: number, trx?: TrxToken | undefined): Promise<TableProvenTx | undefined>
    async findProvenTxReqById(id: number, trx?: TrxToken | undefined): Promise<TableProvenTxReq | undefined>
    async findSyncStateById(id: number, trx?: TrxToken): Promise<TableSyncState | undefined>
    async findTransactionById(id: number, trx?: TrxToken, noRawTx?: boolean): Promise<TableTransaction | undefined>
    async findTxLabelById(id: number, trx?: TrxToken): Promise<TableTxLabel | undefined>
    async findOutputTagById(id: number, trx?: TrxToken): Promise<TableOutputTag | undefined>
    async findUserById(id: number, trx?: TrxToken): Promise<TableUser | undefined>
    async findOrInsertUser(identityKey: string, trx?: TrxToken): Promise<{
        user: TableUser;
        isNew: boolean;
    }>
    async findOrInsertTransaction(newTx: TableTransaction, trx?: TrxToken): Promise<{
        tx: TableTransaction;
        isNew: boolean;
    }>
    async findOrInsertOutputBasket(userId: number, name: string, trx?: TrxToken): Promise<TableOutputBasket>
    async findOrInsertTxLabel(userId: number, label: string, trx?: TrxToken): Promise<TableTxLabel>
    async findOrInsertTxLabelMap(transactionId: number, txLabelId: number, trx?: TrxToken): Promise<TableTxLabelMap>
    async findOrInsertOutputTag(userId: number, tag: string, trx?: TrxToken): Promise<TableOutputTag>
    async findOrInsertOutputTagMap(outputId: number, outputTagId: number, trx?: TrxToken): Promise<TableOutputTagMap>
    async getSyncCheckpoint(auth: AuthId, storageIdentityKey: string, storageName: string)
    async findOrInsertSyncStateAuth(auth: AuthId, storageIdentityKey: string, storageName: string): Promise<{
        syncState: TableSyncState;
        isNew: boolean;
    }>
    async findOrInsertProvenTxReq(newReq: TableProvenTxReq, trx?: TrxToken): Promise<{
        req: TableProvenTxReq;
        isNew: boolean;
    }>
    async findOrInsertProvenTx(newProven: TableProvenTx, trx?: TrxToken): Promise<{
        proven: TableProvenTx;
        isNew: boolean;
    }>
    abstract processSyncChunk(args: RequestSyncChunkArgs, chunk: SyncChunk): Promise<ProcessSyncChunkResult>;
    async tagOutput(partial: Partial<TableOutput>, tag: string, trx?: TrxToken): Promise<void>
}
```

See also: [AuthId](./client.md#interface-authid), [Brc177NoSendExpiryState](./client.md#type-brc177nosendexpirystate), [FindOutputTagMapsArgs](./client.md#interface-findoutputtagmapsargs), [FindProvenTxReqsArgs](./client.md#interface-findproventxreqsargs), [FindProvenTxsArgs](./client.md#interface-findproventxsargs), [FindStaleMerkleRootsArgs](./client.md#interface-findstalemerklerootsargs), [FindTxLabelMapsArgs](./client.md#interface-findtxlabelmapsargs), [ProcessSyncChunkResult](./client.md#interface-processsyncchunkresult), [RequestSyncChunkArgs](./client.md#interface-requestsyncchunkargs), [StorageReader](./storage.md#class-storagereader), [SyncChunk](./client.md#interface-syncchunk), [TableCertificate](./storage.md#interface-tablecertificate), [TableCertificateField](./storage.md#interface-tablecertificatefield), [TableCommission](./storage.md#interface-tablecommission), [TableMonitorEvent](./storage.md#interface-tablemonitorevent), [TableOutput](./storage.md#interface-tableoutput), [TableOutputBasket](./storage.md#interface-tableoutputbasket), [TableOutputTag](./storage.md#interface-tableoutputtag), [TableOutputTagMap](./storage.md#interface-tableoutputtagmap), [TableProvenTx](./storage.md#interface-tableproventx), [TableProvenTxReq](./storage.md#interface-tableproventxreq), [TableSyncState](./storage.md#interface-tablesyncstate), [TableTransaction](./storage.md#interface-tabletransaction), [TableTxLabel](./storage.md#interface-tabletxlabel), [TableTxLabelMap](./storage.md#interface-tabletxlabelmap), [TableUser](./storage.md#interface-tableuser), [TrxToken](./client.md#interface-trxtoken)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Class: StorageServer

```ts
export class StorageServer {
    constructor(storage: StorageProvider, options: WalletStorageServerOptions)
    server: any;
    public start(): void
    public async close(): Promise<void>
    validateDate(date: Date | string | number): Date
    validateEntity<T extends EntityTimeStamp>(entity: T, dateFields?: string[]): T
    validateEntities<T extends EntityTimeStamp>(entities: T[], dateFields?: string[]): T[]
}
```

See also: [EntityTimeStamp](./client.md#interface-entitytimestamp), [StorageProvider](./storage.md#class-storageprovider), [WalletStorageServerOptions](./storage.md#interface-walletstorageserveroptions), [validateDate](./storage.md#function-validatedate), [validateEntities](./storage.md#function-validateentities), [validateEntity](./storage.md#function-validateentity)

###### Method validateEntities

Helper to force uniform behavior across database engines.
Use to process all arrays of records with time stamps retreived from database.

```ts
validateEntities<T extends EntityTimeStamp>(entities: T[], dateFields?: string[]): T[]
```
See also: [EntityTimeStamp](./client.md#interface-entitytimestamp)

Returns

input `entities` array with contained values validated.

###### Method validateEntity

Helper to force uniform behavior across database engines.
Use to process all individual records with time stamps retreived from database.

```ts
validateEntity<T extends EntityTimeStamp>(entity: T, dateFields?: string[]): T
```
See also: [EntityTimeStamp](./client.md#interface-entitytimestamp)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Class: StorageSyncReader

The `StorageSyncReader` non-abstract class must be used when authentication checking access to the methods of a `StorageBaseReader` is required.

Constructed from an `auth` object that must minimally include the authenticated user's identityKey,
and the `StorageBaseReader` to be protected.

```ts
export class StorageSyncReader implements sdk.WalletStorageSyncReader {
    constructor(public auth: sdk.AuthId, public storage: StorageReader)
    async makeAvailable(): Promise<TableSettings>
    async destroy(): Promise<void>
    async getSyncChunk(args: sdk.RequestSyncChunkArgs): Promise<sdk.SyncChunk>
}
```

See also: [AuthId](./client.md#interface-authid), [RequestSyncChunkArgs](./client.md#interface-requestsyncchunkargs), [StorageReader](./storage.md#class-storagereader), [SyncChunk](./client.md#interface-syncchunk), [TableSettings](./storage.md#interface-tablesettings), [WalletStorageSyncReader](./client.md#interface-walletstoragesyncreader), [getSyncChunk](./storage.md#function-getsyncchunk)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Class: SyncPageBudget

Per-copy work budget. Bytes alone cannot bound network-backed proof checks.

```ts
export class SyncPageBudget {
    apply(args: RequestSyncChunkArgs): RequestSyncChunkArgs
    committed(chunk: SyncChunk, elapsedMs: number): void
}
```

See also: [RequestSyncChunkArgs](./client.md#interface-requestsyncchunkargs), [SyncChunk](./client.md#interface-syncchunk)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Class: WalletStorageManager

The `WalletStorageManager` class delivers authentication checking storage access to the wallet.

If manages multiple `StorageBase` derived storage services: one actice, the rest as backups.

Of the storage services, one is 'active' at any one time.
On startup, and whenever triggered by the wallet, `WalletStorageManager` runs a syncrhonization sequence:

1. While synchronizing, all other access to storage is blocked waiting.
2. The active service is confirmed, potentially triggering a resolution process if there is disagreement.
3. Changes are pushed from the active storage service to each inactive, backup service.

Some storage services do not support multiple writers. `WalletStorageManager` manages wait-blocking write requests
for these services.

```ts
export class WalletStorageManager implements sdk.WalletStorage {
    _stores: ManagedStorage[] = [];
    _isAvailable: boolean = false;
    _active?: ManagedStorage;
    _backups?: ManagedStorage[];
    _conflictingActives?: ManagedStorage[];
    _authId: sdk.AuthId;
    _services?: sdk.WalletServices;
    constructor(identityKey: string, active?: sdk.WalletStorageProvider, backups?: sdk.WalletStorageProvider[])
    isStorageProvider(): boolean
    isAvailable(): boolean
    get isActiveEnabled(): boolean
    canMakeAvailable(): boolean
    async makeAvailable(): Promise<TableSettings>
    async getAuth(mustBeActive?: boolean): Promise<sdk.AuthId>
    async getUserId(): Promise<number>
    getActive(): sdk.WalletStorageProvider
    getActiveSettings(): TableSettings
    getActiveUser(): TableUser
    getActiveStore(): string
    getActiveStoreName(): string
    getBackupStores(): string[]
    getConflictingStores(): string[]
    getAllStores(): string[]
    async runAsWriter<R>(writer: (active: sdk.WalletStorageWriter) => Promise<R>): Promise<R>
    async runAsReader<R>(reader: (active: sdk.WalletStorageReader) => Promise<R>): Promise<R>
    async runAsSync<R>(sync: (active: sdk.WalletStorageSync) => Promise<R>, activeSync?: sdk.WalletStorageSync): Promise<R>
    async runAsStorageProvider<R>(sync: (active: StorageProvider) => Promise<R>): Promise<R>
    invalidatePreparedBeefsForReorg(): Promise<void>
    isActiveStorageProvider(): boolean
    async addWalletStorageProvider(provider: sdk.WalletStorageProvider): Promise<void>
    setServices(v: sdk.WalletServices): void
    getServices(): sdk.WalletServices
    getSettings(): TableSettings
    async migrate(storageName: string, storageIdentityKey: string): Promise<string>
    async destroy(): Promise<void>
    async findOrInsertUser(identityKey: string): Promise<{
        user: TableUser;
        isNew: boolean;
    }>
    async abortAction(args: AbortActionArgs): Promise<AbortActionResult>
    async createAction(vargs: Validation.ValidCreateActionArgs): Promise<sdk.StorageCreateActionResult>
    async internalizeAction(args: InternalizeActionArgs): Promise<sdk.StorageInternalizeActionResult>
    async relinquishCertificate(args: RelinquishCertificateArgs): Promise<number>
    async relinquishOutput(args: RelinquishOutputArgs): Promise<number>
    async processAction(args: sdk.StorageProcessActionArgs): Promise<sdk.StorageProcessActionResults>
    async prepareNoSendExpiry(args: Validation.ValidCreateActionArgs): Promise<sdk.StoragePrepareNoSendExpiryResult>
    async activateNoSendExpiry(args: sdk.StorageActivateNoSendExpiryArgs): Promise<sdk.StorageActivateNoSendExpiryResult>
    async armNoSendExpiry(args: sdk.StorageArmNoSendExpiryArgs): Promise<void>
    async getCapabilities(): Promise<sdk.StorageCapabilities>
    async beginActionBatch(args: sdk.BeginActionBatchArgs): Promise<sdk.BeginActionBatchResult>
    async extendActionBatch(args: sdk.ExtendActionBatchArgs): Promise<sdk.ExtendActionBatchResult>
    async renewActionBatch(batchId: string): Promise<sdk.RenewActionBatchResult>
    async resumeActionBatch(args: sdk.ResumeActionBatchArgs): Promise<sdk.ResumeActionBatchResult>
    async prepareActionBatchCommit(manifest: sdk.ActionBatchManifest): Promise<sdk.PrepareActionBatchCommitResult>
    async putActionBatchBlob(args: sdk.PutActionBatchBlobArgs): Promise<void>
    async putActionBatchPack(args: sdk.PutActionBatchPackArgs): Promise<void>
    async commitActionBatch(manifest: sdk.ActionBatchManifest): Promise<sdk.CommitActionBatchResult>
    async commitActionBatchByDigest(args: sdk.CommitActionBatchByDigestArgs): Promise<sdk.CommitActionBatchResult>
    async abortActionBatch(batchId: string): Promise<sdk.AbortActionBatchResult>
    async insertCertificate(certificate: TableCertificate): Promise<number>
    async listActions(vargs: Validation.ValidListActionsArgs): Promise<ListActionsResult>
    async listCertificates(args: Validation.ValidListCertificatesArgs): Promise<ListCertificatesResult>
    async listOutputs(vargs: Validation.ValidListOutputsArgs): Promise<ListOutputsResult>
    async findCertificates(args: sdk.FindCertificatesArgs): Promise<TableCertificateX[]>
    async findOutputBaskets(args: sdk.FindOutputBasketsArgs): Promise<TableOutputBasket[]>
    async findOutputs(args: sdk.FindOutputsArgs): Promise<TableOutput[]>
    async findProvenTxReqs(args: sdk.FindProvenTxReqsArgs): Promise<TableProvenTxReq[]>
    async reproveHeader(deactivatedHash: string): Promise<sdk.ReproveHeaderResult>
    async reproveHeightMerkleRoot(height: number, staleMerkleRoot: string): Promise<sdk.ReproveHeaderResult>
    async reproveProven(ptx: TableProvenTx, noUpdate?: boolean): Promise<sdk.ReproveProvenResult>
    async syncFromReader(identityKey: string, reader: sdk.WalletStorageSyncReader, activeSync?: sdk.WalletStorageSync, log: string = ""): Promise<{
        inserts: number;
        updates: number;
        log: string;
    }>
    async syncToWriter(auth: sdk.AuthId, writer: sdk.WalletStorageProvider, activeSync?: sdk.WalletStorageSync, log: string = "", progLog?: (s: string) => string): Promise<{
        inserts: number;
        updates: number;
        log: string;
    }>
    async updateBackups(activeSync?: sdk.WalletStorageSync, progLog?: (s: string) => string): Promise<string>
    async setActive(storageIdentityKey: string, progLog?: (s: string) => string): Promise<string>
    getStoreEndpointURL(store: ManagedStorage): string | undefined
    getStores(): sdk.WalletStorageInfo[]
}
```

See also: [AbortActionBatchResult](./client.md#interface-abortactionbatchresult), [ActionBatchManifest](./client.md#interface-actionbatchmanifest), [AuthId](./client.md#interface-authid), [BeginActionBatchArgs](./client.md#interface-beginactionbatchargs), [BeginActionBatchResult](./client.md#interface-beginactionbatchresult), [CommitActionBatchByDigestArgs](./client.md#interface-commitactionbatchbydigestargs), [CommitActionBatchResult](./client.md#interface-commitactionbatchresult), [ExtendActionBatchArgs](./client.md#interface-extendactionbatchargs), [ExtendActionBatchResult](./client.md#interface-extendactionbatchresult), [FindCertificatesArgs](./client.md#interface-findcertificatesargs), [FindOutputBasketsArgs](./client.md#interface-findoutputbasketsargs), [FindOutputsArgs](./client.md#interface-findoutputsargs), [FindProvenTxReqsArgs](./client.md#interface-findproventxreqsargs), [PrepareActionBatchCommitResult](./client.md#interface-prepareactionbatchcommitresult), [PutActionBatchBlobArgs](./client.md#interface-putactionbatchblobargs), [PutActionBatchPackArgs](./client.md#interface-putactionbatchpackargs), [RenewActionBatchResult](./client.md#interface-renewactionbatchresult), [ReproveHeaderResult](./client.md#interface-reproveheaderresult), [ReproveProvenResult](./client.md#interface-reproveprovenresult), [ResumeActionBatchArgs](./client.md#interface-resumeactionbatchargs), [ResumeActionBatchResult](./client.md#interface-resumeactionbatchresult), [StorageActivateNoSendExpiryArgs](./client.md#interface-storageactivatenosendexpiryargs), [StorageActivateNoSendExpiryResult](./client.md#interface-storageactivatenosendexpiryresult), [StorageArmNoSendExpiryArgs](./client.md#interface-storagearmnosendexpiryargs), [StorageCapabilities](./client.md#interface-storagecapabilities), [StorageCreateActionResult](./client.md#interface-storagecreateactionresult), [StorageInternalizeActionResult](./client.md#interface-storageinternalizeactionresult), [StoragePrepareNoSendExpiryResult](./client.md#interface-storagepreparenosendexpiryresult), [StorageProcessActionArgs](./client.md#interface-storageprocessactionargs), [StorageProcessActionResults](./client.md#interface-storageprocessactionresults), [StorageProvider](./storage.md#class-storageprovider), [TableCertificate](./storage.md#interface-tablecertificate), [TableCertificateX](./storage.md#interface-tablecertificatex), [TableOutput](./storage.md#interface-tableoutput), [TableOutputBasket](./storage.md#interface-tableoutputbasket), [TableProvenTx](./storage.md#interface-tableproventx), [TableProvenTxReq](./storage.md#interface-tableproventxreq), [TableSettings](./storage.md#interface-tablesettings), [TableUser](./storage.md#interface-tableuser), [WalletServices](./client.md#interface-walletservices), [WalletStorage](./client.md#interface-walletstorage), [WalletStorageInfo](./client.md#interface-walletstorageinfo), [WalletStorageProvider](./client.md#interface-walletstorageprovider), [WalletStorageReader](./client.md#interface-walletstoragereader), [WalletStorageSync](./client.md#interface-walletstoragesync), [WalletStorageSyncReader](./client.md#interface-walletstoragesyncreader), [WalletStorageWriter](./client.md#interface-walletstoragewriter), [abortActionBatch](./storage.md#function-abortactionbatch), [activateNoSendExpiry](./storage.md#function-activatenosendexpiry), [armNoSendExpiry](./storage.md#function-armnosendexpiry), [beginActionBatch](./storage.md#function-beginactionbatch), [commitActionBatch](./storage.md#function-commitactionbatch), [commitActionBatchByDigest](./storage.md#function-commitactionbatchbydigest), [createAction](./storage.md#function-createaction), [extendActionBatch](./storage.md#function-extendactionbatch), [internalizeAction](./storage.md#function-internalizeaction), [listActions](./storage.md#function-listactions), [listCertificates](./storage.md#function-listcertificates), [listOutputs](./storage.md#function-listoutputs), [prepareActionBatchCommit](./storage.md#function-prepareactionbatchcommit), [prepareNoSendExpiry](./storage.md#function-preparenosendexpiry), [processAction](./storage.md#function-processaction), [putActionBatchBlob](./storage.md#function-putactionbatchblob), [putActionBatchPack](./storage.md#function-putactionbatchpack), [renewActionBatch](./storage.md#function-renewactionbatch), [resumeActionBatch](./storage.md#function-resumeactionbatch)

###### Constructor

Creates a new WalletStorageManager with the given identityKey and optional active and backup storage providers.

```ts
constructor(identityKey: string, active?: sdk.WalletStorageProvider, backups?: sdk.WalletStorageProvider[])
```
See also: [WalletStorageProvider](./client.md#interface-walletstorageprovider)

Argument Details

+ **identityKey**
  + The identity key of the user for whom this wallet is being managed.
+ **active**
  + An optional active storage provider. If not provided, no active storage will be set.
+ **backups**
  + An optional array of backup storage providers. If not provided, no backups will be set.

###### Property _active

The current active store which is only enabled if the store's user record activeStorage property matches its settings record storageIdentityKey property

```ts
_active?: ManagedStorage
```

###### Property _authId

identityKey is always valid, userId and isActive are valid only if _isAvailable

```ts
_authId: sdk.AuthId
```
See also: [AuthId](./client.md#interface-authid)

###### Property _backups

Stores to which state is pushed by updateBackups.

```ts
_backups?: ManagedStorage[]
```

###### Property _conflictingActives

Stores whose user record activeStorage property disagrees with the active store's user record activeStorage property.

```ts
_conflictingActives?: ManagedStorage[]
```

###### Property _isAvailable

True if makeAvailable has been run and access to managed stores (active) is allowed

```ts
_isAvailable: boolean = false
```

###### Property _services

Configured services if any. If valid, shared with stores (which may ignore it).

```ts
_services?: sdk.WalletServices
```
See also: [WalletServices](./client.md#interface-walletservices)

###### Property _stores

All configured stores including current active, backups, and conflicting actives.

```ts
_stores: ManagedStorage[] = []
```

###### Method canMakeAvailable

```ts
canMakeAvailable(): boolean
```

Returns

true if at least one WalletStorageProvider has been added.

###### Method getStoreEndpointURL

Return the remote HTTP(S) endpoint for a managed store, if any.

Duck-types `endpointUrl` on the provider (as set by `StorageClientBase`).
Do **not** key this off `constructor.name === 'StorageClient'`: production
minifiers (Vite/esbuild/webpack) rename classes, so that check fails and
every remote store reports `endpointURL: undefined` even though the URL is
present. Consumers that match backups by URL (e.g. making a remote store
primary) then fail while sync still works, because sync walks `_backups`
without needing `endpointURL`.

```ts
getStoreEndpointURL(store: ManagedStorage): string | undefined
```

###### Method invalidatePreparedBeefsForReorg

Reorg notifications call this before aging or replacement-proof I/O. The
active Knex store closes its in-process prepared-read gate synchronously,
then advances the shared database epoch and stales artifacts. A failed
invalidation deliberately leaves reads suspended so canonical BEEF remains
the safe path until a later invalidation succeeds or the process restarts.

```ts
invalidatePreparedBeefsForReorg(): Promise<void>
```

###### Method isActiveStorageProvider

```ts
isActiveStorageProvider(): boolean
```

Returns

true if the active `WalletStorageProvider` also implements `StorageProvider`

###### Method reproveHeader

For each proven_txs record currently sourcing its transaction merkle proof from the given deactivated header,
attempt to reprove the transaction against the current chain,
updating the proven_txs record if a new valid proof is found.

```ts
async reproveHeader(deactivatedHash: string): Promise<sdk.ReproveHeaderResult>
```
See also: [ReproveHeaderResult](./client.md#interface-reproveheaderresult)

Argument Details

+ **deactivatedHash**
  + An orphaned header than may have served as a proof source for proven_txs records.

###### Method reproveHeightMerkleRoot

For all proven_txs records at the given height currently tied to the given stale merkleRoot,
attempt to reprove them against the current chain and update proof data if new valid proofs are found.

This is intended for backup auditing of recent heights after the primary reorg event path has run.

```ts
async reproveHeightMerkleRoot(height: number, staleMerkleRoot: string): Promise<sdk.ReproveHeaderResult>
```
See also: [ReproveHeaderResult](./client.md#interface-reproveheaderresult)

###### Method runAsSync

```ts
async runAsSync<R>(sync: (active: sdk.WalletStorageSync) => Promise<R>, activeSync?: sdk.WalletStorageSync): Promise<R>
```
See also: [WalletStorageSync](./client.md#interface-walletstoragesync)

Argument Details

+ **sync**
  + the function to run with sync access lock
+ **activeSync**
  + from chained sync functions, active storage already held under sync access lock.

###### Method setActive

Updates backups and switches to new active storage provider from among current backup providers.

Also resolves conflicting actives.

```ts
async setActive(storageIdentityKey: string, progLog?: (s: string) => string): Promise<string>
```

Argument Details

+ **storageIdentityKey**
  + of current backup storage provider that is to become the new active provider.

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
#### Functions

| | | |
| --- | --- | --- |
| [abortActionBatch](#function-abortactionbatch) | [markConfirmedStaleReqInputs](#function-markconfirmedstalereqinputs) | [securityHeaders](#function-securityheaders) |
| [activateNoSendExpiry](#function-activatenosendexpiry) | [markStaleInputsAsSpent](#function-markstaleinputsasspent) | [selectCanonicalChange](#function-selectcanonicalchange) |
| [alignLeft](#function-alignleft) | [markSyncProofInsertOnly](#function-marksyncproofinsertonly) | [selectNoSendExpiryFundingAnchor](#function-selectnosendexpiryfundinganchor) |
| [alignRight](#function-alignright) | [markSyncProofReconciled](#function-marksyncproofreconciled) | [setDisableDoubleSpendCheckForTest](#function-setdisabledoublespendcheckfortest) |
| [armNoSendExpiry](#function-armnosendexpiry) | [markUserInputsSpent](#function-markuserinputsspent) | [shareReqsWithWorld](#function-sharereqswithworld) |
| [asNumber](#function-asnumber) | [matchesCertificateFieldPartial](#function-matchescertificatefieldpartial) | [stringifyJsonRpc](#function-stringifyjsonrpc) |
| [assertSyncProofReplacementAuthorized](#function-assertsyncproofreplacementauthorized) | [matchesCertificatePartial](#function-matchescertificatepartial) | [syncChunkBinary](#function-syncchunkbinary) |
| [attemptToPostReqsToNetwork](#function-attempttopostreqstonetwork) | [matchesCommissionPartial](#function-matchescommissionpartial) | [syncProofUpdatedAt](#function-syncproofupdatedat) |
| [authenticatedIdentityKey](#function-authenticatedidentitykey) | [matchesMonitorEventPartial](#function-matchesmonitoreventpartial) | [syncTransferDigest](#function-synctransferdigest) |
| [availableManagedChange](#function-availablemanagedchange) | [matchesOutputBasketPartial](#function-matchesoutputbasketpartial) | [tableAuthSessionToPeerSession](#function-tableauthsessiontopeersession) |
| [beginActionBatch](#function-beginactionbatch) | [matchesOutputPartial](#function-matchesoutputpartial) | [toAdminStatsLog](#function-toadminstatslog) |
| [binaryJsonReplacer](#function-binaryjsonreplacer) | [matchesOutputTagMapPartial](#function-matchesoutputtagmappartial) | [transactionInputSize](#function-transactioninputsize) |
| [binaryJsonReviver](#function-binaryjsonreviver) | [matchesOutputTagPartial](#function-matchesoutputtagpartial) | [transactionOutputSize](#function-transactionoutputsize) |
| [bodyParserErrorHandler](#function-bodyparsererrorhandler) | [matchesProvenTxPartial](#function-matchesproventxpartial) | [transactionSize](#function-transactionsize) |
| [canonicalizeSyncProofIdentifiers](#function-canonicalizesyncproofidentifiers) | [matchesProvenTxReqPartial](#function-matchesproventxreqpartial) | [updateReqsFromAggregateResults](#function-updatereqsfromaggregateresults) |
| [classifyBroadcastInputSpendEvidence](#function-classifybroadcastinputspendevidence) | [matchesSyncStatePartial](#function-matchessyncstatepartial) | [upgradeActionBatchStoresV2](#function-upgradeactionbatchstoresv2) |
| [classifyReqStatus](#function-classifyreqstatus) | [matchesTransactionPartial](#function-matchestransactionpartial) | [upgradeAllStoresV1](#function-upgradeallstoresv1) |
| [cleanupExpiredActionBatches](#function-cleanupexpiredactionbatches) | [matchesTxLabelMapPartial](#function-matchestxlabelmappartial) | [upgradeCertificateFields](#function-upgradecertificatefields) |
| [commitActionBatch](#function-commitactionbatch) | [matchesTxLabelPartial](#function-matchestxlabelpartial) | [upgradeCertificates](#function-upgradecertificates) |
| [commitActionBatchByDigest](#function-commitactionbatchbydigest) | [mergeInputBeefs](#function-mergeinputbeefs) | [upgradeCommissions](#function-upgradecommissions) |
| [concurrencyLimit](#function-concurrencylimit) | [mergeInputsIntoBeef](#function-mergeinputsintobeef) | [upgradeLegacyManagedChangeBasketDefault](#function-upgradelegacymanagedchangebasketdefault) |
| [configureHttpServer](#function-configurehttpserver) | [normalizeReviewMode](#function-normalizereviewmode) | [upgradeMonitorEvents](#function-upgrademonitorevents) |
| [configureTrustProxy](#function-configuretrustproxy) | [notifyTransactionsOfProof](#function-notifytransactionsofproof) | [upgradeOutputBaskets](#function-upgradeoutputbaskets) |
| [corsPolicy](#function-corspolicy) | [offsetPrivKey](#function-offsetprivkey) | [upgradeOutputTags](#function-upgradeoutputtags) |
| [createAction](#function-createaction) | [offsetPubKey](#function-offsetpubkey) | [upgradeOutputTagsMap](#function-upgradeoutputtagsmap) |
| [createStorageServiceChargeScript](#function-createstorageservicechargescript) | [parseJsonRpc](#function-parsejsonrpc) | [upgradeOutputs](#function-upgradeoutputs) |
| [createSyncMap](#function-createsyncmap) | [partitionActionLabels](#function-partitionactionlabels) | [upgradeProvenTxReqs](#function-upgradeproventxreqs) |
| [dateMatches](#function-datematches) | [prepareActionBatchCommit](#function-prepareactionbatchcommit) | [upgradeProvenTxs](#function-upgradeproventxs) |
| [decodeBinaryJsonValue](#function-decodebinaryjsonvalue) | [prepareNoSendExpiry](#function-preparenosendexpiry) | [upgradeSyncStates](#function-upgradesyncstates) |
| [decodeSyncTransfer](#function-decodesynctransfer) | [processAction](#function-processaction) | [upgradeTransactions](#function-upgradetransactions) |
| [defaultManagedChangePolicy](#function-defaultmanagedchangepolicy) | [processNoSendExpiryLifecycle](#function-processnosendexpirylifecycle) | [upgradeTxLabels](#function-upgradetxlabels) |
| [defaultPreparedBeefPolicy](#function-defaultpreparedbeefpolicy) | [profileValue](#function-profilevalue) | [upgradeTxLabelsMap](#function-upgradetxlabelsmap) |
| [determineDBType](#function-determinedbtype) | [purgeData](#function-purgedata) | [upgradeUsers](#function-upgradeusers) |
| [encodeSyncTransfer](#function-encodesynctransfer) | [purgeDataIdb](#function-purgedataidb) | [validateActionBatchInlinePayload](#function-validateactionbatchinlinepayload) |
| [extendActionBatch](#function-extendactionbatch) | [putActionBatchBlob](#function-putactionbatchblob) | [validateActionBatchSendWith](#function-validateactionbatchsendwith) |
| [generateChangeSdk](#function-generatechangesdk) | [putActionBatchPack](#function-putactionbatchpack) | [validateCompactManifest](#function-validatecompactmanifest) |
| [generateChangeSdkMakeStorage](#function-generatechangesdkmakestorage) | [quarantineReqInputs](#function-quarantinereqinputs) | [validateDate](#function-validatedate) |
| [getActionBatchCapabilities](#function-getactionbatchcapabilities) | [quarantineReqInputsFromFailedParents](#function-quarantinereqinputsfromfailedparents) | [validateEntities](#function-validateentities) |
| [getBeefForTransaction](#function-getbeeffortransaction) | [randomizeOutputVouts](#function-randomizeoutputvouts) | [validateEntity](#function-validateentity) |
| [getBeefForTransactions](#function-getbeeffortransactions) | [rateLimitOptions](#function-ratelimitoptions) | [validateGenerateChangeSdkParams](#function-validategeneratechangesdkparams) |
| [getListOutputsSpecOp](#function-getlistoutputsspecop) | [readAllowedOrigins](#function-readallowedorigins) | [validateGenerateChangeSdkResult](#function-validategeneratechangesdkresult) |
| [getSyncChunk](#function-getsyncchunk) | [readBodyLimitBytes](#function-readbodylimitbytes) | [validateJsonRpcResponse](#function-validatejsonrpcresponse) |
| [initialDoubleSlashCompatibility](#function-initialdoubleslashcompatibility) | [readCorsOriginSetting](#function-readcorsoriginsetting) | [validateManagedChangePolicy](#function-validatemanagedchangepolicy) |
| [internalizeAction](#function-internalizeaction) | [readResourceLimit](#function-readresourcelimit) | [validateManifestActions](#function-validatemanifestactions) |
| [isAutoSpendableChangeOutput](#function-isautospendablechangeoutput) | [readResourceProfile](#function-readresourceprofile) | [validateNoSendExpiryRequest](#function-validatenosendexpiryrequest) |
| [isLegacyManagedChangeBasketDefault](#function-islegacymanagedchangebasketdefault) | [receiveSyncTransfer](#function-receivesynctransfer) | [validatePreparedBeefPolicy](#function-validatepreparedbeefpolicy) |
| [isManagedChangeOutput](#function-ismanagedchangeoutput) | [redeemServiceCharges](#function-redeemservicecharges) | [validateRequiredInputs](#function-validaterequiredinputs) |
| [keyOffsetToHashedSecret](#function-keyoffsettohashedsecret) | [renderAdminPage](#function-renderadminpage) | [validateRequiredOutputs](#function-validaterequiredoutputs) |
| [legacyBinaryJsonReplacer](#function-legacybinaryjsonreplacer) | [renewActionBatch](#function-renewactionbatch) | [validateStorageFeeModel](#function-validatestoragefeemodel) |
| [listActions](#function-listactions) | [repeatableRandom](#function-repeatablerandom) | [validateSyncCheckpoint](#function-validatesynccheckpoint) |
| [listActionsIdb](#function-listactionsidb) | [responseSizeLimit](#function-responsesizelimit) | [validateSyncChunkEntities](#function-validatesyncchunkentities) |
| [listCertificates](#function-listcertificates) | [restoreInputsToSpendable](#function-restoreinputstospendable) | [validateSyncProof](#function-validatesyncproof) |
| [listOutputs](#function-listoutputs) | [resumeActionBatch](#function-resumeactionbatch) | [validateSyncProofs](#function-validatesyncproofs) |
| [listOutputsIdb](#function-listoutputsidb) | [reviewStatus](#function-reviewstatus) | [validateSyncTransferCapabilities](#function-validatesynctransfercapabilities) |
| [lockScriptWithKeyOffsetFromPubKey](#function-lockscriptwithkeyoffsetfrompubkey) | [reviewStatusIdb](#function-reviewstatusidb) | [validateSyncTransferManifest](#function-validatesynctransfermanifest) |
| [lookupPreparedBeefs](#function-lookuppreparedbeefs) | [reviewUtxoOutputs](#function-reviewutxooutputs) | [varUintSize](#function-varuintsize) |
| [makeNoSendExpiryFundingArgs](#function-makenosendexpiryfundingargs) | [runAdminUtxoReview](#function-runadminutxoreview) |  |
| [manifestPhysicalDigests](#function-manifestphysicaldigests) | [sameSyncProof](#function-samesyncproof) |  |

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---

##### Function: abortActionBatch

```ts
export async function abortActionBatch(storage: StorageProvider, auth: AuthId, batchId: string): Promise<AbortActionBatchResult>
```

See also: [AbortActionBatchResult](./client.md#interface-abortactionbatchresult), [AuthId](./client.md#interface-authid), [StorageProvider](./storage.md#class-storageprovider)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: activateNoSendExpiry

```ts
export async function activateNoSendExpiry(storage: StorageProvider, auth: AuthId, args: StorageActivateNoSendExpiryArgs): Promise<StorageActivateNoSendExpiryResult>
```

See also: [AuthId](./client.md#interface-authid), [StorageActivateNoSendExpiryArgs](./client.md#interface-storageactivatenosendexpiryargs), [StorageActivateNoSendExpiryResult](./client.md#interface-storageactivatenosendexpiryresult), [StorageProvider](./storage.md#class-storageprovider)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: alignLeft

```ts
export function alignLeft(value: unknown, width: number): string
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: alignRight

```ts
export function alignRight(value: unknown, width: number): string
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: armNoSendExpiry

```ts
export async function armNoSendExpiry(storage: StorageProvider, auth: AuthId, args: StorageArmNoSendExpiryArgs): Promise<void>
```

See also: [AuthId](./client.md#interface-authid), [StorageArmNoSendExpiryArgs](./client.md#interface-storagearmnosendexpiryargs), [StorageProvider](./storage.md#class-storageprovider)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: asNumber

```ts
export function asNumber(value: unknown, fallback: number): number
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: assertSyncProofReplacementAuthorized

Enforce the pre-transaction proof decision again at the entity merge point.
This closes the race where another process inserts the txid after preflight.

```ts
export function assertSyncProofReplacementAuthorized(candidate: TableProvenTx): void
```

See also: [TableProvenTx](./storage.md#interface-tableproventx)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: attemptToPostReqsToNetwork

Attempt to post one or more `ProvenTxReq` with status 'unsent'
to the bitcoin network.

```ts
export async function attemptToPostReqsToNetwork(storage: StorageProvider, reqs: EntityProvenTxReq[], trx?: sdk.TrxToken, logger?: WalletLoggerInterface): Promise<PostReqsToNetworkResult>
```

See also: [EntityProvenTxReq](./storage.md#class-entityproventxreq), [PostReqsToNetworkResult](./storage.md#interface-postreqstonetworkresult), [StorageProvider](./storage.md#class-storageprovider), [TrxToken](./client.md#interface-trxtoken), [logger](./client.md#variable-logger)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: authenticatedIdentityKey

```ts
export function authenticatedIdentityKey(req: Request): string
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: availableManagedChange

Return the exact set of wallet-managed outputs currently eligible for
automatic funding. Keeping this predicate shared prevents the planner,
allocator, action-batch reservations, and availability count from drifting.

```ts
export async function availableManagedChange(storage: StorageProvider, userId: number, basketId: number, excludeSending: boolean, trx?: TrxToken): Promise<TableOutput[]>
```

See also: [StorageProvider](./storage.md#class-storageprovider), [TableOutput](./storage.md#interface-tableoutput), [TrxToken](./client.md#interface-trxtoken)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: beginActionBatch

```ts
export async function beginActionBatch(storage: StorageProvider, auth: AuthId, args: BeginActionBatchArgs): Promise<BeginActionBatchResult>
```

See also: [AuthId](./client.md#interface-authid), [BeginActionBatchArgs](./client.md#interface-beginactionbatchargs), [BeginActionBatchResult](./client.md#interface-beginactionbatchresult), [StorageProvider](./storage.md#class-storageprovider)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: binaryJsonReplacer

```ts
export function binaryJsonReplacer(this: Record<string, unknown>, key: string, value: unknown): unknown
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: binaryJsonReviver

```ts
export function binaryJsonReviver(_key: string, value: unknown): unknown
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: bodyParserErrorHandler

Convert body-parser/Express parser failures into stable, non-sensitive
protocol errors. Install immediately after all body parsers.

```ts
export function bodyParserErrorHandler(error: unknown, _req: Request, res: Response, next: NextFunction): void
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: canonicalizeSyncProofIdentifiers

Normalize text-key identifiers before lookup or persistence.

```ts
export function canonicalizeSyncProofIdentifiers(candidate: TableProvenTx): void
```

See also: [TableProvenTx](./storage.md#interface-tableproventx)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: classifyBroadcastInputSpendEvidence

```ts
export async function classifyBroadcastInputSpendEvidence(tx: Transaction, beef: Beef, services: Pick<sdk.WalletServices, "hashOutputScript" | "getUtxoStatus">): Promise<{
    spent: number;
    unspent: number;
    unknown: number;
}>
```

See also: [WalletServices](./client.md#interface-walletservices)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: classifyReqStatus

Classify a ProvenTxReq status into beef-sharing lifecycle status.
Mutates `d` in place.

```ts
export function classifyReqStatus(d: GetReqsAndBeefDetail, req: TableProvenTxReq): void
```

See also: [GetReqsAndBeefDetail](./storage.md#interface-getreqsandbeefdetail), [TableProvenTxReq](./storage.md#interface-tableproventxreq)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: cleanupExpiredActionBatches

```ts
export async function cleanupExpiredActionBatches(storage: StorageProvider): Promise<number>
```

See also: [StorageProvider](./storage.md#class-storageprovider)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: commitActionBatch

```ts
export async function commitActionBatch(storage: StorageProvider, auth: AuthId, manifest: ActionBatchManifest): Promise<CommitActionBatchResult>
```

See also: [ActionBatchManifest](./client.md#interface-actionbatchmanifest), [AuthId](./client.md#interface-authid), [CommitActionBatchResult](./client.md#interface-commitactionbatchresult), [StorageProvider](./storage.md#class-storageprovider)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: commitActionBatchByDigest

```ts
export async function commitActionBatchByDigest(storage: StorageProvider, auth: AuthId, args: CommitActionBatchByDigestArgs): Promise<CommitActionBatchResult>
```

See also: [AuthId](./client.md#interface-authid), [CommitActionBatchByDigestArgs](./client.md#interface-commitactionbatchbydigestargs), [CommitActionBatchResult](./client.md#interface-commitactionbatchresult), [StorageProvider](./storage.md#class-storageprovider)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: concurrencyLimit

A local concurrency ceiling prevents a single process from accepting
unbounded in-flight application work. Distributed/global quotas remain the
responsibility of the deployment's shared rate-limit store or gateway.

```ts
export function concurrencyLimit(environmentPrefix: string, fallback: number): RequestHandler
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: configureHttpServer

```ts
export function configureHttpServer(server: Server, environmentPrefix: string, defaults: HttpServerPolicyDefaults): void
```

See also: [HttpServerPolicyDefaults](./storage.md#interface-httpserverpolicydefaults)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: configureTrustProxy

```ts
export function configureTrustProxy(app: Application, setting: TrustProxySetting | undefined): void
```

See also: [TrustProxySetting](./storage.md#type-trustproxysetting)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: corsPolicy

Public protocol services accept browser origins by default and return
Access-Control-Allow-Origin: * without cookie credentials. Operators can
opt into an exact allowlist or disable cross-origin browser calls with
<PREFIX>_CORS_MODE.

```ts
export function corsPolicy(options: CorsPolicyOptions): RequestHandler
```

See also: [CorsPolicyOptions](./storage.md#interface-corspolicyoptions)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: createAction

```ts
export async function createAction(storage: StorageProvider, auth: AuthId, vargs: Validation.ValidCreateActionArgs, _originator?: OriginatorDomainNameStringUnder250Bytes): Promise<StorageCreateActionResult>
```

See also: [AuthId](./client.md#interface-authid), [StorageCreateActionResult](./client.md#interface-storagecreateactionresult), [StorageProvider](./storage.md#class-storageprovider)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: createStorageServiceChargeScript

```ts
export function createStorageServiceChargeScript(pubKeyHex: PubKeyHex): {
    script: string;
    keyOffset: string;
}
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: createSyncMap

```ts
export function createSyncMap(): SyncMap
```

See also: [SyncMap](./storage.md#interface-syncmap)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: dateMatches

```ts
export function dateMatches(a: Date | undefined, b: Date | undefined): boolean
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: decodeBinaryJsonValue

```ts
export function decodeBinaryJsonValue(value: unknown): unknown
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: decodeSyncTransfer

```ts
export function decodeSyncTransfer(bytes: Uint8Array): unknown
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: defaultManagedChangePolicy

```ts
export function defaultManagedChangePolicy(): ManagedChangePolicy
```

See also: [ManagedChangePolicy](./storage.md#interface-managedchangepolicy)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: defaultPreparedBeefPolicy

```ts
export function defaultPreparedBeefPolicy(): PreparedBeefPolicy
```

See also: [PreparedBeefPolicy](./storage.md#interface-preparedbeefpolicy)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: determineDBType

```ts
export async function determineDBType(knex: Knex<any, any[]>): Promise<DBType>
```

See also: [DBType](./storage.md#type-dbtype)

Returns

connected database engine variant

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: encodeSyncTransfer

A length-prefixed JSON metadata header followed by raw byte fields, without base64 expansion.

```ts
export function encodeSyncTransfer(value: unknown): Uint8Array
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: extendActionBatch

```ts
export async function extendActionBatch(storage: StorageProvider, auth: AuthId, args: ExtendActionBatchArgs): Promise<ExtendActionBatchResult>
```

See also: [AuthId](./client.md#interface-authid), [ExtendActionBatchArgs](./client.md#interface-extendactionbatchargs), [ExtendActionBatchResult](./client.md#interface-extendactionbatchresult), [StorageProvider](./storage.md#class-storageprovider)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: generateChangeSdk

Simplifications:
 - only support one change type with fixed length scripts.
 - only support satsPerKb fee model.

Confirms for each availbleChange output that it remains available as they are allocated and selects alternate if not.

```ts
export async function generateChangeSdk(params: GenerateChangeSdkParams, allocateChangeInput: (targetSatoshis: number, exactSatoshis?: number) => Promise<GenerateChangeSdkChangeInput | undefined>, releaseChangeInput: (outputId: number) => Promise<void>, logger?: WalletLoggerInterface, telemetry?: Telemetry): Promise<GenerateChangeSdkResult>
```

See also: [GenerateChangeSdkChangeInput](./storage.md#interface-generatechangesdkchangeinput), [GenerateChangeSdkParams](./storage.md#interface-generatechangesdkparams), [GenerateChangeSdkResult](./storage.md#interface-generatechangesdkresult), [logger](./client.md#variable-logger)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: generateChangeSdkMakeStorage

```ts
export function generateChangeSdkMakeStorage(availableChange: GenerateChangeSdkChangeInput[]): {
    allocateChangeInput: (targetSatoshis: number, exactSatoshis?: number) => Promise<GenerateChangeSdkChangeInput | undefined>;
    releaseChangeInput: (outputId: number) => Promise<void>;
    getLog: () => string;
}
```

See also: [GenerateChangeSdkChangeInput](./storage.md#interface-generatechangesdkchangeinput)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: getActionBatchCapabilities

```ts
export function getActionBatchCapabilities(maxReservedOutputs = ACTION_BATCH_MAX_RESERVED_OUTPUTS, supportsResume = false): StorageCapabilities
```

See also: [ACTION_BATCH_MAX_RESERVED_OUTPUTS](./storage.md#variable-action_batch_max_reserved_outputs), [StorageCapabilities](./client.md#interface-storagecapabilities)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: getBeefForTransaction

Creates a `Beef` to support the validity of a transaction identified by its `txid`.

`storage` is used to retrieve proven transactions and their merkle paths,
or proven_tx_req record with beef of external inputs (internal inputs meged by recursion).
Otherwise external services are used.

`options.maxRecursionDepth` can be set to prevent overly deep chained dependencies. Will throw ERR_EXTSVS_ENVELOPE_DEPTH if exceeded.

If `trustSelf` is true, a partial `Beef` will be returned where transactions known by `storage` to
be valid by verified proof are represented solely by 'txid'.

If `knownTxids` is defined, any 'txid' required by the `Beef` that appears in the array is represented solely as a 'known' txid.

```ts
export async function getBeefForTransaction(storage: StorageProvider, txid: string, options: StorageGetBeefOptions): Promise<Beef>
```

See also: [StorageGetBeefOptions](./client.md#interface-storagegetbeefoptions), [StorageProvider](./storage.md#class-storageprovider)

Argument Details

+ **storage**
  + the chain on which txid exists.
+ **txid**
  + the transaction hash for which an envelope is requested.

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: getBeefForTransactions

Build one aggregate BEEF for several roots while resolving each storage
frontier as a set. This avoids one proof query per funding input on the
createAction success path. Complex proof-level and chain-tracker policies
retain the established single-root implementation.

```ts
export async function getBeefForTransactions(storage: StorageProvider, txids: string[], options: StorageGetBeefOptions): Promise<Beef>
```

See also: [StorageGetBeefOptions](./client.md#interface-storagegetbeefoptions), [StorageProvider](./storage.md#class-storageprovider)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: getListOutputsSpecOp

Check basket and tags arguments passed to listOutputs to determine if they trigger a special operation execution mode.

```ts
export function getListOutputsSpecOp(basket: string, tags: string[]): {
    specOp: ListOutputsSpecOp | undefined;
    basket?: string;
    tags: string[];
}
```

See also: [ListOutputsSpecOp](./storage.md#interface-listoutputsspecop)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: getSyncChunk

Gets the next sync chunk of updated data from un-remoted storage (could be using a remote DB connection).

```ts
export async function getSyncChunk(storage: StorageReader, args: RequestSyncChunkArgs): Promise<SyncChunk>
```

See also: [RequestSyncChunkArgs](./client.md#interface-requestsyncchunkargs), [StorageReader](./storage.md#class-storagereader), [SyncChunk](./client.md#interface-syncchunk)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: initialDoubleSlashCompatibility

Preserve compatibility with clients that accidentally emit two or more
initial slashes. Only the initial slash run is normalized; the remainder of
the path and query string is unchanged.

```ts
export function initialDoubleSlashCompatibility(req: Request, _res: Response, next: NextFunction): void
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: internalizeAction

Internalize Action allows a wallet to take ownership of outputs in a pre-existing transaction.
The transaction may, or may not already be known to both the storage and user.

Two types of outputs are handled: "wallet payments" and "basket insertions".

A "basket insertion" output is considered a custom output and has no effect on the wallet's "balance".

A "wallet payment" adds an outputs value to the wallet's change "balance". These outputs are assigned to the "default" basket.

Processing starts with simple validation and then checks for a pre-existing transaction.
If the transaction is already known to the user, then the outputs are reviewed against the existing outputs treatment,
and merge rules are added to the arguments passed to the storage layer.

The existing transaction's `status` determines what the merge path does next:
 - `'unproven'`, `'completed'`, or `'sending'`: outputs are merged into the existing record. The transaction status is left as-is.
   The `'sending'` case covers a transaction this wallet already signed and handed to broadcast processing, but
   whose proven_tx_req has not yet been advanced by the normal monitor/posting flow.
 - `'nosend'`: an ambiguous case. The transaction was created with `noSend: true` and may have been externally
   broadcast, may be sitting in a sendWith chain, or may be stuck mid-flight. The merge path treats the
   `internalizeAction` call as explicit authorization to advance the lifecycle. Specifically: `transactions.status`
   is promoted to `'completed'` (when a BUMP is included in the BEEF) or `'unproven'` (otherwise), and the
   `proven_tx_req` is moved out of `'nosend'` so Monitor's standard proof-fetching flow can finalize it.
   This makes the `internalizeAction` semantics consistent regardless of whether the originator shares the
   same storage as the internalizer or not.
 - Any other status: an error.

When the transaction already exists, the description is updated. The isOutgoing sense is not changed.

"basket insertion" Merge Rules:
1. The "default" basket may not be specified as the insertion basket.
2. Managed change may not be reclassified as a basket insertion.
3. Basket insertions do not affect wallet balance and are typed "custom".

"wallet payment" Merge Rules:
1. Targeting an existing managed output is idempotent.
2. Targeting an existing custom output converts it to managed BRC-29
   change and increases wallet balance. This includes verified recovery of
   a legacy custom row that was incorrectly placed in the default basket.

```ts
export async function internalizeAction(storage: StorageProvider, auth: AuthId, args: InternalizeActionArgs): Promise<StorageInternalizeActionResult>
```

See also: [AuthId](./client.md#interface-authid), [StorageInternalizeActionResult](./client.md#interface-storageinternalizeactionresult), [StorageProvider](./storage.md#class-storageprovider)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: isAutoSpendableChangeOutput

True when managed change is currently eligible for automatic allocation.

```ts
export function isAutoSpendableChangeOutput(output: TableOutput | undefined): output is TableOutput
```

See also: [TableOutput](./storage.md#interface-tableoutput)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: isLegacyManagedChangeBasketDefault

True only for the exact historical default that is safe to auto-upgrade.

```ts
export function isLegacyManagedChangeBasketDefault(basket: ManagedChangeBasketDefaults): boolean
```

See also: [ManagedChangeBasketDefaults](./storage.md#interface-managedchangebasketdefaults)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: isManagedChangeOutput

True when an output has all metadata required to use the wallet-managed
BRC-29 signing path. `senderIdentityKey` is optional: wallet-created change
uses the client's change public key when it is absent, while received
BRC-29 payments record the sender's identity key.

```ts
export function isManagedChangeOutput(output: TableOutput | undefined): output is TableOutput
```

See also: [TableOutput](./storage.md#interface-tableoutput)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: keyOffsetToHashedSecret

```ts
export function keyOffsetToHashedSecret(pub: PublicKey, keyOffset?: string): {
    hashedSecret: BigNumber;
    keyOffset: string;
}
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: legacyBinaryJsonReplacer

```ts
export function legacyBinaryJsonReplacer(_key: string, value: unknown): unknown
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: listActions

```ts
export async function listActions(storage: StorageKnex, auth: AuthId, vargs: Validation.ValidListActionsArgs): Promise<ListActionsResult>
```

See also: [AuthId](./client.md#interface-authid), [StorageKnex](./storage.md#class-storageknex)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: listActionsIdb

```ts
export async function listActionsIdb(storage: StorageIdb, auth: AuthId, vargs: Validation.ValidListActionsArgs): Promise<ListActionsResult>
```

See also: [AuthId](./client.md#interface-authid), [StorageIdb](./storage.md#class-storageidb)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: listCertificates

```ts
export async function listCertificates(storage: StorageProvider, auth: AuthId, vargs: Validation.ValidListCertificatesArgs, _originator?: OriginatorDomainNameStringUnder250Bytes): Promise<ListCertificatesResult>
```

See also: [AuthId](./client.md#interface-authid), [StorageProvider](./storage.md#class-storageprovider)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: listOutputs

```ts
export async function listOutputs(dsk: StorageKnex, auth: AuthId, vargs: Validation.ValidListOutputsArgs, _originator?: OriginatorDomainNameStringUnder250Bytes): Promise<ListOutputsResult>
```

See also: [AuthId](./client.md#interface-authid), [StorageKnex](./storage.md#class-storageknex)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: listOutputsIdb

```ts
export async function listOutputsIdb(storage: StorageIdb, auth: AuthId, vargs: Validation.ValidListOutputsArgs, _originator?: OriginatorDomainNameStringUnder250Bytes): Promise<ListOutputsResult>
```

See also: [AuthId](./client.md#interface-authid), [StorageIdb](./storage.md#class-storageidb)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: lockScriptWithKeyOffsetFromPubKey

```ts
export function lockScriptWithKeyOffsetFromPubKey(pubKey: string, keyOffset?: string): {
    script: string;
    keyOffset: string;
}
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: lookupPreparedBeefs

Read and validate prepared artifacts without performing chain or service
work. A malformed, stale, oversized, or unsupported row is a cache miss.

```ts
export async function lookupPreparedBeefs(storage: PreparedBeefStorage, userId: number, rootTxids: string[], parent?: TelemetrySpan): Promise<PreparedBeefLookupResult>
```

See also: [PreparedBeefLookupResult](./storage.md#interface-preparedbeeflookupresult), [PreparedBeefStorage](./storage.md#interface-preparedbeefstorage)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: makeNoSendExpiryFundingArgs

```ts
export function makeNoSendExpiryFundingArgs(anchorSatoshis: number, protectedLabels: string[] = []): Brc177ValidCreateActionArgs
```

See also: [Brc177ValidCreateActionArgs](./client.md#type-brc177validcreateactionargs)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: manifestPhysicalDigests

```ts
export function manifestPhysicalDigests(manifest: ActionBatchManifest): string[]
```

See also: [ActionBatchManifest](./client.md#interface-actionbatchmanifest)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: markConfirmedStaleReqInputs

Ask the configured UTXO-provider collection to classify the request's local
inputs and mark only positively confirmed spent outputs unavailable.
Provider errors and a collection with no providers are inconclusive and
never count as spent.

```ts
export async function markConfirmedStaleReqInputs(req: EntityProvenTxReq, storage: StorageProvider, services: sdk.WalletServices, trx?: sdk.TrxToken, logger?: WalletLoggerInterface): Promise<FailedInputReconciliationResult>
```

See also: [EntityProvenTxReq](./storage.md#class-entityproventxreq), [FailedInputReconciliationResult](./storage.md#interface-failedinputreconciliationresult), [StorageProvider](./storage.md#class-storageprovider), [TrxToken](./client.md#interface-trxtoken), [WalletServices](./client.md#interface-walletservices), [logger](./client.md#variable-logger)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: markStaleInputsAsSpent

After any failed broadcast (doubleSpend, invalidTx, etc.), query each
consumed-input outpoint of the failed transaction against on-chain
UTXO state. For inputs the chain authoritatively confirms are spent
(i.e. NOT a UTXO), update the corresponding wallet basket entry to
spendable=false.

Background: `updateTransactionStatus(failed)` optimistically restores
all consumed-input outputs to spendable=true so the user can retry
with the same inputs. For some failures (genuine doubleSpend, or any
'missing-inputs' outcome where the input has been spent on chain by
a different transaction), restoration is incorrect — the input is
gone and restoring it produces an infinite missing-inputs loop on
the next createAction → broadcast cycle. Apps cannot evict from the
default basket on app-isolated wallets (admin-only policy), so this
self-heal must run inside the wallet.

Different broadcasters classify the same on-chain reality differently
(ARC → doubleSpend, WhatsOnChain/Bitails → invalidTx via
'missing-inputs'); this helper is broadcaster-agnostic because its
decision is based on services.isUtxo, not the aggregate failure
classification.

Pre-broadcast races where concurrent createActions reach the same
UTXO across separate app processes are out of scope; see PR
description.

Conservatively scoped:
  - Only inputs found in the failing user's basket are touched.
  - Inputs whose on-chain UTXO status cannot be determined (service
    error / inconclusive) are left spendable=true. Eviction is opt-in
    based on positive evidence of stale state.
  - Inputs the chain confirms are still UTXOs (e.g. a competing tx
    itself failed, or a malformed/fee failure where inputs are intact)
    are left spendable=true — preserving the existing transient-retry
    semantics callers depend on.

Returns counts for instrumentation and the set of stale outpoints
that were actually evicted (added to history note for diagnostics).

```ts
export async function markStaleInputsAsSpent(ar: AggregatePostBeefTxResult, storage: StorageProvider, services: sdk.WalletServices, trx?: sdk.TrxToken, logger?: WalletLoggerInterface): Promise<{
    checked: number;
    staleConfirmed: number;
    staleOutpoints: string[];
}>
```

See also: [AggregatePostBeefTxResult](./storage.md#interface-aggregatepostbeeftxresult), [StorageProvider](./storage.md#class-storageprovider), [TrxToken](./client.md#interface-trxtoken), [WalletServices](./client.md#interface-walletservices), [logger](./client.md#variable-logger)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: markSyncProofInsertOnly

Record that preflight found no row which this candidate may replace.

```ts
export function markSyncProofInsertOnly(candidate: TableProvenTx): void
```

See also: [TableProvenTx](./storage.md#interface-tableproventx)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: markSyncProofReconciled

Mark a fully validated reconciliation without changing the source cursor timestamp.

```ts
export function markSyncProofReconciled(candidate: TableProvenTx): void
```

See also: [TableProvenTx](./storage.md#interface-tableproventx)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: markUserInputsSpent

```ts
export async function markUserInputsSpent(storage: StorageProvider, userId: number, tx: BsvTransaction, transactionId: number): Promise<SpentInputTransition[]>
```

See also: [SpentInputTransition](./storage.md#interface-spentinputtransition), [StorageProvider](./storage.md#class-storageprovider)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: matchesCertificateFieldPartial

```ts
export function matchesCertificateFieldPartial(r: TableCertificateField, partial: Partial<TableCertificateField>): boolean
```

See also: [TableCertificateField](./storage.md#interface-tablecertificatefield)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: matchesCertificatePartial

```ts
export function matchesCertificatePartial(r: TableCertificate, partial: Partial<TableCertificate>): boolean
```

See also: [TableCertificate](./storage.md#interface-tablecertificate)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: matchesCommissionPartial

```ts
export function matchesCommissionPartial(r: TableCommission, partial: Partial<TableCommission>): boolean
```

See also: [TableCommission](./storage.md#interface-tablecommission)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: matchesMonitorEventPartial

```ts
export function matchesMonitorEventPartial(r: TableMonitorEvent, partial: Partial<TableMonitorEvent>): boolean
```

See also: [TableMonitorEvent](./storage.md#interface-tablemonitorevent)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: matchesOutputBasketPartial

```ts
export function matchesOutputBasketPartial(r: TableOutputBasket, partial: Partial<TableOutputBasket>): boolean
```

See also: [TableOutputBasket](./storage.md#interface-tableoutputbasket)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: matchesOutputPartial

```ts
export function matchesOutputPartial(r: TableOutput, partial: Partial<TableOutput>): boolean
```

See also: [TableOutput](./storage.md#interface-tableoutput)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: matchesOutputTagMapPartial

```ts
export function matchesOutputTagMapPartial(r: TableOutputTagMap, partial: Partial<TableOutputTagMap>): boolean
```

See also: [TableOutputTagMap](./storage.md#interface-tableoutputtagmap)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: matchesOutputTagPartial

```ts
export function matchesOutputTagPartial(r: TableOutputTag, partial: Partial<TableOutputTag>): boolean
```

See also: [TableOutputTag](./storage.md#interface-tableoutputtag)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: matchesProvenTxPartial

```ts
export function matchesProvenTxPartial(r: TableProvenTx, partial: Partial<TableProvenTx>): boolean
```

See also: [TableProvenTx](./storage.md#interface-tableproventx)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: matchesProvenTxReqPartial

```ts
export function matchesProvenTxReqPartial(r: TableProvenTxReq, partial: Partial<TableProvenTxReq>): boolean
```

See also: [TableProvenTxReq](./storage.md#interface-tableproventxreq)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: matchesSyncStatePartial

```ts
export function matchesSyncStatePartial(r: TableSyncState, partial: Partial<TableSyncState>): boolean
```

See also: [TableSyncState](./storage.md#interface-tablesyncstate)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: matchesTransactionPartial

```ts
export function matchesTransactionPartial(r: TableTransaction, partial: Partial<TableTransaction>): boolean
```

See also: [TableTransaction](./storage.md#interface-tabletransaction)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: matchesTxLabelMapPartial

```ts
export function matchesTxLabelMapPartial(r: TableTxLabelMap, partial: Partial<TableTxLabelMap>): boolean
```

See also: [TableTxLabelMap](./storage.md#interface-tabletxlabelmap)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: matchesTxLabelPartial

```ts
export function matchesTxLabelPartial(r: TableTxLabel, partial: Partial<TableTxLabel>): boolean
```

See also: [TableTxLabel](./storage.md#interface-tabletxlabel)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: mergeInputBeefs

For each input of `rawTx`, ensure the source txid is represented in `beef`.

When `requiredLevels` is undefined/0 and `knownTxids` contains the source txid,
a txid-only stub is merged rather than recursing into storage.

```ts
export async function mergeInputBeefs(rawTx: number[], beef: Beef, trustSelf: "known" | undefined, knownTxids: string[] | undefined, trx: TrxToken | undefined, requiredLevels: number | undefined, getValidBeef: (txid: string, beef: Beef, trustSelf: "known" | undefined, knownTxids: string[] | undefined, trx: TrxToken | undefined, requiredLevels: number | undefined) => Promise<unknown>): Promise<void>
```

See also: [TrxToken](./client.md#interface-trxtoken)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: mergeInputsIntoBeef

Convenience wrapper for the external-sharing path where `trustSelf` and
`requiredLevels` are always absent.

```ts
export async function mergeInputsIntoBeef(rawTx: number[], beef: Beef, knownTxids: string[], trx: TrxToken | undefined, getValidBeef: (txid: string, beef: Beef, trustSelf: undefined, knownTxids: string[], trx: TrxToken | undefined) => Promise<unknown>): Promise<void>
```

See also: [TrxToken](./client.md#interface-trxtoken)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: normalizeReviewMode

```ts
export function normalizeReviewMode(value: unknown): UtxoReviewMode
```

See also: [UtxoReviewMode](./storage.md#type-utxoreviewmode)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: notifyTransactionsOfProof

Notify each transaction that a proof has been found.
Mutates `req` history notes in place.

The `addNote` callback avoids coupling this helper to a specific entity type.
Returns false if any transaction update failed so callers can retain the
request for later status repair.

```ts
export async function notifyTransactionsOfProof(ids: number[], provenTxId: number, addNote: (note: ReqHistoryNote) => void, updateTransaction: (id: number, update: {
    provenTxId: number;
    status: "completed";
}) => Promise<unknown>): Promise<boolean>
```

See also: [ReqHistoryNote](./client.md#interface-reqhistorynote)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: offsetPrivKey

```ts
export function offsetPrivKey(privKey: string, keyOffset?: string): {
    offsetPrivKey: string;
    keyOffset: string;
}
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: offsetPubKey

```ts
export function offsetPubKey(pubKey: string, keyOffset?: string): {
    offsetPubKey: string;
    keyOffset: string;
}
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: parseJsonRpc

```ts
export function parseJsonRpc(text: string, binary: boolean = false): any
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: partitionActionLabels

```ts
export function partitionActionLabels(ordinaryLabels: string[]): {
    specOp: ListActionsSpecOp | undefined;
    specOpLabels: string[];
    labels: string[];
}
```

See also: [ListActionsSpecOp](./storage.md#interface-listactionsspecop)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: prepareActionBatchCommit

```ts
export async function prepareActionBatchCommit(storage: StorageProvider, auth: AuthId, manifest: ActionBatchManifest): Promise<PrepareActionBatchCommitResult>
```

See also: [ActionBatchManifest](./client.md#interface-actionbatchmanifest), [AuthId](./client.md#interface-authid), [PrepareActionBatchCommitResult](./client.md#interface-prepareactionbatchcommitresult), [StorageProvider](./storage.md#class-storageprovider)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: prepareNoSendExpiry

```ts
export async function prepareNoSendExpiry(storage: StorageProvider, auth: AuthId, target: Validation.ValidCreateActionArgs): Promise<StoragePrepareNoSendExpiryResult>
```

See also: [AuthId](./client.md#interface-authid), [StoragePrepareNoSendExpiryResult](./client.md#interface-storagepreparenosendexpiryresult), [StorageProvider](./storage.md#class-storageprovider)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: processAction

```ts
export async function processAction(storage: StorageProvider, auth: AuthId, args: StorageProcessActionArgs): Promise<StorageProcessActionResults>
```

See also: [AuthId](./client.md#interface-authid), [StorageProcessActionArgs](./client.md#interface-storageprocessactionargs), [StorageProcessActionResults](./client.md#interface-storageprocessactionresults), [StorageProvider](./storage.md#class-storageprovider)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: processNoSendExpiryLifecycle

```ts
export async function processNoSendExpiryLifecycle(storage: StorageProvider): Promise<NoSendExpiryLifecycleResult>
```

See also: [NoSendExpiryLifecycleResult](./storage.md#interface-nosendexpirylifecycleresult), [StorageProvider](./storage.md#class-storageprovider)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: profileValue

```ts
export function profileValue(profile: ResourceProfileName, values: ResourceProfileValues): number
```

See also: [ResourceProfileName](./storage.md#type-resourceprofilename), [ResourceProfileValues](./storage.md#interface-resourceprofilevalues)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: purgeData

```ts
export async function purgeData(storage: StorageKnex, params: PurgeParams, trx?: TrxToken): Promise<PurgeResults>
```

See also: [PurgeParams](./client.md#interface-purgeparams), [PurgeResults](./client.md#interface-purgeresults), [StorageKnex](./storage.md#class-storageknex), [TrxToken](./client.md#interface-trxtoken)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: purgeDataIdb

```ts
export async function purgeDataIdb(_storage: StorageIdb, _params: PurgeParams, _trx?: TrxToken): Promise<PurgeResults>
```

See also: [PurgeParams](./client.md#interface-purgeparams), [PurgeResults](./client.md#interface-purgeresults), [StorageIdb](./storage.md#class-storageidb), [TrxToken](./client.md#interface-trxtoken)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: putActionBatchBlob

```ts
export async function putActionBatchBlob(storage: StorageProvider, auth: AuthId, args: PutActionBatchBlobArgs): Promise<void>
```

See also: [AuthId](./client.md#interface-authid), [PutActionBatchBlobArgs](./client.md#interface-putactionbatchblobargs), [StorageProvider](./storage.md#class-storageprovider)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: putActionBatchPack

```ts
export async function putActionBatchPack(storage: StorageProvider, auth: AuthId, args: PutActionBatchPackArgs): Promise<void>
```

See also: [AuthId](./client.md#interface-authid), [PutActionBatchPackArgs](./client.md#interface-putactionbatchpackargs), [StorageProvider](./storage.md#class-storageprovider)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: quarantineReqInputs

Conservatively quarantine every locally-owned input of a transaction after
Arcade supplies explicit missing-input/conflict evidence. This path is
deliberately independent of explorer or UTXO providers: a positive
broadcaster verdict is enough to stop the failed transaction from feeding
the same inputs into another action. A later validated mined proof remains
able to repair the transaction through the ordinary proof recovery path.

```ts
export async function quarantineReqInputs(req: EntityProvenTxReq, storage: StorageProvider, trx?: sdk.TrxToken, logger?: WalletLoggerInterface): Promise<FailedInputReconciliationResult>
```

See also: [EntityProvenTxReq](./storage.md#class-entityproventxreq), [FailedInputReconciliationResult](./storage.md#interface-failedinputreconciliationresult), [StorageProvider](./storage.md#class-storageprovider), [TrxToken](./client.md#interface-trxtoken), [logger](./client.md#variable-logger)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: quarantineReqInputsFromFailedParents

Keep only inputs created by a locally terminal parent unavailable after the
failed-child transition releases its allocations. Other inputs may still be
valid UTXOs and must remain reusable.

```ts
export async function quarantineReqInputsFromFailedParents(req: EntityProvenTxReq, failedParentTxids: string[], storage: StorageProvider, trx?: sdk.TrxToken, logger?: WalletLoggerInterface): Promise<FailedInputReconciliationResult>
```

See also: [EntityProvenTxReq](./storage.md#class-entityproventxreq), [FailedInputReconciliationResult](./storage.md#interface-failedinputreconciliationresult), [StorageProvider](./storage.md#class-storageprovider), [TrxToken](./client.md#interface-trxtoken), [logger](./client.md#variable-logger)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: randomizeOutputVouts

Pure Fisher-Yates vout assignment shared by legacy and batch planning.

```ts
export function randomizeOutputVouts<T extends {
    vout: number;
}>(outputs: T[], randomVals?: number[]): void
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: rateLimitOptions

```ts
export function rateLimitOptions(defaults: {
    windowMs: number;
    limit: number;
}, overrides: Partial<Options> = {}): Partial<Options>
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: readAllowedOrigins

```ts
export function readAllowedOrigins(environmentPrefix: string): string[]
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: readBodyLimitBytes

```ts
export function readBodyLimitBytes(environmentPrefix: string, fallback: number, maximum: number = MAX_BODY_BYTES): number
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: readCorsOriginSetting

Socket.IO and similar transports can consume the same public/allowlist/
disabled policy as the HTTP middleware.

```ts
export function readCorsOriginSetting(environmentPrefix: string, defaultMode: CorsMode = "public"): "*" | string[]
```

See also: [CorsMode](./storage.md#type-corsmode)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: readResourceLimit

Reads an operator resource limit. `-1` and `unlimited` are explicit opt-outs;
omitting the setting always retains the service's tested safe default.

```ts
export function readResourceLimit(environmentPrefix: string, suffix: string, fallback: number, maximum: number = Number.MAX_SAFE_INTEGER): number
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: readResourceProfile

```ts
export function readResourceProfile(environmentPrefix: string, fallback: ResourceProfileName = "standard"): ResourceProfileName
```

See also: [ResourceProfileName](./storage.md#type-resourceprofilename)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: receiveSyncTransfer

Read-only part retries never advance the wallet's durable BRC-40 checkpoint.

```ts
export async function receiveSyncTransfer(manifest: SyncTransferManifest, read: (offset: number) => Promise<SyncTransferPart>): Promise<unknown>
```

See also: [SyncTransferManifest](./storage.md#interface-synctransfermanifest), [SyncTransferPart](./storage.md#interface-synctransferpart)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: redeemServiceCharges

```ts
export function redeemServiceCharges(privateKeyWif: string, charges: TableCommission[]): Array<{}>
```

See also: [TableCommission](./storage.md#interface-tablecommission)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: renderAdminPage

```ts
export function renderAdminPage(): string
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: renewActionBatch

```ts
export async function renewActionBatch(storage: StorageProvider, auth: AuthId, batchId: string): Promise<RenewActionBatchResult>
```

See also: [AuthId](./client.md#interface-authid), [RenewActionBatchResult](./client.md#interface-renewactionbatchresult), [StorageProvider](./storage.md#class-storageprovider)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: repeatableRandom

```ts
export function repeatableRandom(randomVals?: number[]): () => number
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: responseSizeLimit

Bounds materialized JSON/text/binary Express responses before downstream
authentication middleware signs or serializes them again. Streaming
endpoints must enforce their own byte budget while producing chunks.

```ts
export function responseSizeLimit(environmentPrefix: string, fallback: number, maximum: number = MAX_BODY_BYTES): RequestHandler
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: restoreInputsToSpendable

```ts
export async function restoreInputsToSpendable(storage: StorageProvider, transitions: SpentInputTransition[]): Promise<void>
```

See also: [SpentInputTransition](./storage.md#interface-spentinputtransition), [StorageProvider](./storage.md#class-storageprovider)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: resumeActionBatch

Reacquire exactly the persisted inputs owned by one expired client
workspace. This is deliberately explicit: another action may not become a
member merely because it happens to use the same Wallet instance.

```ts
export async function resumeActionBatch(storage: StorageProvider, auth: AuthId, args: ResumeActionBatchArgs): Promise<ResumeActionBatchResult>
```

See also: [AuthId](./client.md#interface-authid), [ResumeActionBatchArgs](./client.md#interface-resumeactionbatchargs), [ResumeActionBatchResult](./client.md#interface-resumeactionbatchresult), [StorageProvider](./storage.md#class-storageprovider)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: reviewStatus

Looks for unpropagated state:

1. set transactions to 'failed' if not already failed and provenTxReq with matching txid has status of 'invalid'.
2. sets outputs to spendable true, spentBy undefined if spentBy is a terminal failed transaction.
3. sets outputs generated by terminal failed transactions to spendable false, spentBy undefined.
4. sets transactions to 'completed' if provenTx with matching txid exists and current provenTxId is null.

```ts
export async function reviewStatus(storage: StorageKnex, args: {
    agedLimit: Date;
    trx?: TrxToken;
}): Promise<{
    log: string;
}>
```

See also: [StorageKnex](./storage.md#class-storageknex), [TrxToken](./client.md#interface-trxtoken)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: reviewStatusIdb

Looks for unpropagated state:

1. set transactions to 'failed' if not already failed and provenTxReq with matching txid has status of 'invalid'.
2. sets outputs to spendable true, spentBy undefined if spentBy is a terminal failed transaction.
3. sets outputs generated by terminal failed transactions to spendable false, spentBy undefined.

```ts
export async function reviewStatusIdb(storage: StorageIdb, args: {
    agedLimit: Date;
    trx?: sdk.TrxToken;
}): Promise<{
    log: string;
}>
```

See also: [StorageIdb](./storage.md#class-storageidb), [TrxToken](./client.md#interface-trxtoken)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: reviewUtxoOutputs

Classify a bounded set of wallet outputs without treating provider failure as
proof that an output was spent. Read-only reviews always return their
conclusive and unknown partitions. Atomic release requires every verdict to
be conclusive; the operator-only conclusive mode releases the positively
spent subset while retaining and reporting unknowns.

```ts
export async function reviewUtxoOutputs(storage: StorageProvider, auth: AuthId, outputs: TableOutput[], releaseMode: UtxoReviewReleaseMode = "none"): Promise<ReviewUtxoOutputsResult>
```

See also: [AuthId](./client.md#interface-authid), [ReviewUtxoOutputsResult](./storage.md#interface-reviewutxooutputsresult), [StorageProvider](./storage.md#class-storageprovider), [TableOutput](./storage.md#interface-tableoutput), [UtxoReviewReleaseMode](./storage.md#type-utxoreviewreleasemode)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: runAdminUtxoReview

Run one explicitly scoped admin UTXO review with durable start and outcome
evidence. Audit writes deliberately bracket the task so provider failures
and blocked releases remain observable.

```ts
export async function runAdminUtxoReview(request: AdminUtxoReviewRequest): Promise<{
    requestedBy: string;
} & TaskReviewUtxosPageResult>
```

See also: [AdminUtxoReviewRequest](./storage.md#interface-adminutxoreviewrequest), [TaskReviewUtxosPageResult](./monitor.md#interface-taskreviewutxospageresult)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: sameSyncProof

Compare proof authority fields, excluding local IDs and timestamps.

```ts
export function sameSyncProof(a: TableProvenTx, b: TableProvenTx): boolean
```

See also: [TableProvenTx](./storage.md#interface-tableproventx)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: securityHeaders

```ts
export function securityHeaders(options: SecurityHeadersOptions = {}): RequestHandler
```

See also: [SecurityHeadersOptions](./storage.md#interface-securityheadersoptions)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: selectCanonicalChange

Pure exact / least-over / largest-under change selection policy.

```ts
export function selectCanonicalChange<T extends CanonicalFundingCandidate>(outputs: T[], targetSatoshis: number, exactSatoshis?: number): T | undefined
```

See also: [CanonicalFundingCandidate](./storage.md#interface-canonicalfundingcandidate)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: selectNoSendExpiryFundingAnchor

```ts
export function selectNoSendExpiryFundingAnchor(outputs: StorageCreateTransactionSdkOutput[], anchorSatoshis: number): StorageCreateTransactionSdkOutput
```

See also: [StorageCreateTransactionSdkOutput](./client.md#interface-storagecreatetransactionsdkoutput)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: setDisableDoubleSpendCheckForTest

```ts
export function setDisableDoubleSpendCheckForTest(v: boolean)
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: shareReqsWithWorld

```ts
export async function shareReqsWithWorld(storage: StorageProvider, userId: number, txids: string[], isDelayed: boolean, r?: GetReqsAndBeefResult, logger?: WalletLoggerInterface): Promise<{
    swr: SendWithResult[];
    ndr: ReviewActionResult[] | undefined;
}>
```

See also: [GetReqsAndBeefResult](./storage.md#interface-getreqsandbeefresult), [ReviewActionResult](./client.md#interface-reviewactionresult), [StorageProvider](./storage.md#class-storageprovider), [logger](./client.md#variable-logger)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: stringifyJsonRpc

```ts
export function stringifyJsonRpc(value: unknown, binary: boolean): string
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: syncChunkBinary

Copy schema-defined byte fields for the already negotiated binary JSON codec.

```ts
export function syncChunkBinary(chunk: SyncChunk): Record<string, unknown>
```

See also: [SyncChunk](./client.md#interface-syncchunk)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: syncProofUpdatedAt

A local correction must be discoverable by subsequent incremental readers.

```ts
export function syncProofUpdatedAt(candidate: TableProvenTx, existing?: Date): Date
```

See also: [TableProvenTx](./storage.md#interface-tableproventx)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: syncTransferDigest

```ts
export function syncTransferDigest(bytes: Uint8Array): string
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: tableAuthSessionToPeerSession

```ts
export function tableAuthSessionToPeerSession(row: TableAuthSession): PeerSession
```

See also: [TableAuthSession](./storage.md#interface-tableauthsession)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: toAdminStatsLog

```ts
export function toAdminStatsLog(stats: AdminStatsLike): string
```

See also: [AdminStatsLike](./storage.md#interface-adminstatslike)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: transactionInputSize

```ts
export function transactionInputSize(scriptSize: number): number
```

Returns

serialized byte length a transaction input

Argument Details

+ **scriptSize**
  + byte length of input script

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: transactionOutputSize

```ts
export function transactionOutputSize(scriptSize: number): number
```

Returns

serialized byte length a transaction output

Argument Details

+ **scriptSize**
  + byte length of output script

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: transactionSize

Compute the serialized binary transaction size in bytes
given the number of inputs and outputs,
and the size of each script.

```ts
export function transactionSize(inputs: number[], outputs: number[]): number
```

Returns

total transaction size in bytes

Argument Details

+ **inputs**
  + array of input script lengths, in bytes
+ **outputs**
  + array of output script lengths, in bytes

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: updateReqsFromAggregateResults

```ts
export async function updateReqsFromAggregateResults(txids: string[], r: PostReqsToNetworkResult, apbrs: Record<string, AggregatePostBeefTxResult>, storage: StorageProvider, services?: sdk.WalletServices, trx?: sdk.TrxToken, logger?: WalletLoggerInterface): Promise<void>
```

See also: [AggregatePostBeefTxResult](./storage.md#interface-aggregatepostbeeftxresult), [PostReqsToNetworkResult](./storage.md#interface-postreqstonetworkresult), [StorageProvider](./storage.md#class-storageprovider), [TrxToken](./client.md#interface-trxtoken), [WalletServices](./client.md#interface-walletservices), [logger](./client.md#variable-logger)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: upgradeActionBatchStoresV2

Internal, non-synchronized action-batch state added in schema version 2.

```ts
export function upgradeActionBatchStoresV2(db: IDBPDatabase<StorageIdbSchema>): void
```

See also: [StorageIdbSchema](./storage.md#interface-storageidbschema)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: upgradeAllStoresV1

Upgrade handler for every store that existed at schema version 1.

```ts
export function upgradeAllStoresV1(db: IDBPDatabase<StorageIdbSchema>): void
```

See also: [StorageIdbSchema](./storage.md#interface-storageidbschema)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: upgradeCertificateFields

```ts
export function upgradeCertificateFields(db: IDBPDatabase<StorageIdbSchema>): void
```

See also: [StorageIdbSchema](./storage.md#interface-storageidbschema)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: upgradeCertificates

```ts
export function upgradeCertificates(db: IDBPDatabase<StorageIdbSchema>): void
```

See also: [StorageIdbSchema](./storage.md#interface-storageidbschema)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: upgradeCommissions

```ts
export function upgradeCommissions(db: IDBPDatabase<StorageIdbSchema>): void
```

See also: [StorageIdbSchema](./storage.md#interface-storageidbschema)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: upgradeLegacyManagedChangeBasketDefault

Normalize a legacy default while retaining every other field and every
operator-selected non-default value. Used by migrations, sync, and restore.

```ts
export function upgradeLegacyManagedChangeBasketDefault<T extends ManagedChangeBasketDefaults>(basket: T): T
```

See also: [ManagedChangeBasketDefaults](./storage.md#interface-managedchangebasketdefaults)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: upgradeMonitorEvents

```ts
export function upgradeMonitorEvents(db: IDBPDatabase<StorageIdbSchema>): void
```

See also: [StorageIdbSchema](./storage.md#interface-storageidbschema)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: upgradeOutputBaskets

```ts
export function upgradeOutputBaskets(db: IDBPDatabase<StorageIdbSchema>): void
```

See also: [StorageIdbSchema](./storage.md#interface-storageidbschema)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: upgradeOutputTags

```ts
export function upgradeOutputTags(db: IDBPDatabase<StorageIdbSchema>): void
```

See also: [StorageIdbSchema](./storage.md#interface-storageidbschema)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: upgradeOutputTagsMap

```ts
export function upgradeOutputTagsMap(db: IDBPDatabase<StorageIdbSchema>): void
```

See also: [StorageIdbSchema](./storage.md#interface-storageidbschema)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: upgradeOutputs

```ts
export function upgradeOutputs(db: IDBPDatabase<StorageIdbSchema>): void
```

See also: [StorageIdbSchema](./storage.md#interface-storageidbschema)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: upgradeProvenTxReqs

```ts
export function upgradeProvenTxReqs(db: IDBPDatabase<StorageIdbSchema>): void
```

See also: [StorageIdbSchema](./storage.md#interface-storageidbschema)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: upgradeProvenTxs

```ts
export function upgradeProvenTxs(db: IDBPDatabase<StorageIdbSchema>): void
```

See also: [StorageIdbSchema](./storage.md#interface-storageidbschema)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: upgradeSyncStates

```ts
export function upgradeSyncStates(db: IDBPDatabase<StorageIdbSchema>): void
```

See also: [StorageIdbSchema](./storage.md#interface-storageidbschema)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: upgradeTransactions

```ts
export function upgradeTransactions(db: IDBPDatabase<StorageIdbSchema>): void
```

See also: [StorageIdbSchema](./storage.md#interface-storageidbschema)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: upgradeTxLabels

```ts
export function upgradeTxLabels(db: IDBPDatabase<StorageIdbSchema>): void
```

See also: [StorageIdbSchema](./storage.md#interface-storageidbschema)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: upgradeTxLabelsMap

```ts
export function upgradeTxLabelsMap(db: IDBPDatabase<StorageIdbSchema>): void
```

See also: [StorageIdbSchema](./storage.md#interface-storageidbschema)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: upgradeUsers

```ts
export function upgradeUsers(db: IDBPDatabase<StorageIdbSchema>): void
```

See also: [StorageIdbSchema](./storage.md#interface-storageidbschema)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: validateActionBatchInlinePayload

```ts
export function validateActionBatchInlinePayload(manifest: ActionBatchManifest): void
```

See also: [ActionBatchManifest](./client.md#interface-actionbatchmanifest)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: validateActionBatchSendWith

```ts
export function validateActionBatchSendWith(sendWith: unknown): void
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: validateCompactManifest

```ts
export function validateCompactManifest(manifest: ActionBatchManifest, requireUploaded: boolean = false): void
```

See also: [ActionBatchManifest](./client.md#interface-actionbatchmanifest)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: validateDate

Shared entity-validation helpers used by both client-side storage remoting
(StorageClientBase / StorageMobile) and the server-side StorageServer.

These helpers normalise records returned from remote calls or database queries:
  - Coerce date strings / timestamps to `Date` objects.
  - Replace `null` values with `undefined`.
  - Replace `Uint8Array` / `Buffer` values with plain `number[]` arrays.

```ts
export function validateDate(date: Date | string | number): Date
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: validateEntities

Force uniform behaviour across database engines.
Use to process all arrays of records with timestamps retrieved from database.

```ts
export function validateEntities<T extends EntityTimeStamp>(entities: T[], dateFields?: string[]): T[]
```

See also: [EntityTimeStamp](./client.md#interface-entitytimestamp)

Returns

input `entities` array with contained values validated.

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: validateEntity

Force uniform behaviour across database engines.
Use to process all individual records with timestamps retrieved from database.

```ts
export function validateEntity<T extends EntityTimeStamp>(entity: T, dateFields?: string[]): T
```

See also: [EntityTimeStamp](./client.md#interface-entitytimestamp)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: validateGenerateChangeSdkParams

```ts
export function validateGenerateChangeSdkParams(params: GenerateChangeSdkParams): ValidateGenerateChangeSdkParamsResult
```

See also: [GenerateChangeSdkParams](./storage.md#interface-generatechangesdkparams), [ValidateGenerateChangeSdkParamsResult](./storage.md#interface-validategeneratechangesdkparamsresult)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: validateGenerateChangeSdkResult

```ts
export function validateGenerateChangeSdkResult(params: GenerateChangeSdkParams, r: GenerateChangeSdkResult): {
    ok: boolean;
    log: string;
}
```

See also: [GenerateChangeSdkParams](./storage.md#interface-generatechangesdkparams), [GenerateChangeSdkResult](./storage.md#interface-generatechangesdkresult)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: validateJsonRpcResponse

Require one exact response for the request that produced it.

```ts
export function validateJsonRpcResponse(value: unknown, expectedId: number): ValidatedJsonRpcResponse
```

See also: [ValidatedJsonRpcResponse](./storage.md#type-validatedjsonrpcresponse)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: validateManagedChangePolicy

```ts
export function validateManagedChangePolicy(options?: ManagedChangePolicyOptions): ManagedChangePolicy
```

See also: [ManagedChangePolicy](./storage.md#interface-managedchangepolicy), [ManagedChangePolicyOptions](./storage.md#type-managedchangepolicyoptions)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: validateManifestActions

```ts
export async function validateManifestActions(storage: StorageProvider, batch: TableActionBatch, manifest: ActionBatchManifest): Promise<{
    actions: ValidatedBatchAction[];
    dependencyBeef: Uint8Array;
    beef: Beef;
}>
```

See also: [ActionBatchManifest](./client.md#interface-actionbatchmanifest), [StorageProvider](./storage.md#class-storageprovider), [TableActionBatch](./storage.md#interface-tableactionbatch), [ValidatedBatchAction](./storage.md#interface-validatedbatchaction)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: validateNoSendExpiryRequest

```ts
export function validateNoSendExpiryRequest(args: Validation.ValidCreateActionArgs): ReturnType<typeof parseBrc177NoSendExpiryLabels>
```

See also: [parseBrc177NoSendExpiryLabels](./client.md#function-parsebrc177nosendexpirylabels)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: validatePreparedBeefPolicy

```ts
export function validatePreparedBeefPolicy(options?: PreparedBeefOptions): PreparedBeefPolicy
```

See also: [PreparedBeefOptions](./storage.md#interface-preparedbeefoptions), [PreparedBeefPolicy](./storage.md#interface-preparedbeefpolicy)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: validateRequiredInputs

Verify that we are in posession of validity proof data for any inputs being proposed for a new transaction.

`vargs.inputs` is the source of inputs.
`vargs.inputBEEF` may include new user supplied validity data.
'vargs.options.trustSelf === 'known'` indicates whether we can rely on the storage database records.

If there are no inputs, returns an empty `Beef`.

Always pulls rawTx data into first level of validity chains so that parsed transaction data is available
and checks input sourceSatoshis as well as filling in input sourceLockingScript.

This data may be pruned again before being returned to the user based on `vargs.options.knownTxids`.

```ts
export async function validateRequiredInputs(storage: StorageProvider, userId: number, vargs: Validation.ValidCreateActionArgs): Promise<{
    storageBeef: Beef;
    beef: Beef;
    xinputs: XValidCreateActionInput[];
}>
```

See also: [StorageProvider](./storage.md#class-storageprovider), [XValidCreateActionInput](./storage.md#interface-xvalidcreateactioninput)

Returns

containing only validity proof data for only unknown required inputs.

containing verified validity proof data for all required inputs.

extended validated required inputs.

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: validateRequiredOutputs

Convert vargs.outputs:

lockingScript: HexString
satoshis: SatoshiValue
outputDescription: DescriptionString5to50Bytes
basket?: BasketStringUnder300Bytes
customInstructions?: string
tags: BasketStringUnderBytes[]

to XValidCreateActionOutput (which aims for StorageCreateTransactionSdkOutput)

adds:
  vout: number
  providedBy: StorageProvidedBy
  purpose?: string
  derivationSuffix?: string
  keyOffset?: string

```ts
export function validateRequiredOutputs(storage: StorageProvider, userId: number, vargs: Validation.ValidCreateActionArgs): XValidCreateActionOutput[]
```

See also: [StorageProvider](./storage.md#class-storageprovider), [XValidCreateActionOutput](./storage.md#interface-xvalidcreateactionoutput)

Returns

xoutputs

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: validateStorageFeeModel

```ts
export function validateStorageFeeModel(v?: StorageFeeModel): StorageFeeModel
```

See also: [StorageFeeModel](./client.md#interface-storagefeemodel)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: validateSyncCheckpoint

Validate remote progress and return only the fields permitted to advance a sync.

```ts
export function validateSyncCheckpoint(value: SyncCheckpoint, previous?: Partial<SyncCheckpoint>): SyncCheckpoint
```

See also: [SyncCheckpoint](./client.md#interface-synccheckpoint)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: validateSyncChunkEntities

Validate all entity arrays within a `SyncChunk` received from a remote storage call.
Normalises timestamps, nulls, and binary fields in-place.

```ts
export function validateSyncChunkEntities(r: SyncChunk): SyncChunk
```

See also: [SyncChunk](./client.md#interface-syncchunk)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: validateSyncProof

Validate proof authority before an RPC proof is admitted or an in-process
backup/conflict proof replaces an existing global row. Network-backed checks
run before the storage merge transaction is opened.

```ts
export async function validateSyncProof(storage: SyncProofValidationStorage, candidate: TableProvenTx): Promise<void>
```

See also: [SyncProofValidationStorage](./storage.md#interface-syncproofvalidationstorage), [TableProvenTx](./storage.md#interface-tableproventx)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: validateSyncProofs

Validate a whole RPC page with at most eight proofs in flight and no database writes.

```ts
export async function validateSyncProofs(storage: SyncProofValidationStorage, candidates: TableProvenTx[]): Promise<void>
```

See also: [SyncProofValidationStorage](./storage.md#interface-syncproofvalidationstorage), [TableProvenTx](./storage.md#interface-tableproventx)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: validateSyncTransferCapabilities

```ts
export function validateSyncTransferCapabilities(value: SyncTransferCapabilities): SyncTransferCapabilities
```

See also: [SyncTransferCapabilities](./storage.md#interface-synctransfercapabilities)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: validateSyncTransferManifest

```ts
export function validateSyncTransferManifest(value: SyncTransferManifest, capabilities: SyncTransferCapabilities): SyncTransferManifest
```

See also: [SyncTransferCapabilities](./storage.md#interface-synctransfercapabilities), [SyncTransferManifest](./storage.md#interface-synctransfermanifest)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: varUintSize

Returns the byte size required to encode number as Bitcoin VarUint

```ts
export function varUintSize(val: number): 1 | 3 | 5 | 9 {
    if (val < 0)
        throw new WERR_INVALID_PARAMETER("varUint", "non-negative");
    if (val <= 252)
        return 1;
    if (val <= 65535)
        return 3;
    if (val <= 4294967295)
        return 5;
    return 9;
}
```

See also: [WERR_INVALID_PARAMETER](./client.md#class-werr_invalid_parameter)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
#### Types

| | |
| --- | --- |
| [ActionBatchStatus](#type-actionbatchstatus) | [PreparedBeefState](#type-preparedbeefstate) |
| [CorsMode](#type-corsmode) | [ResourceProfileName](#type-resourceprofilename) |
| [DBType](#type-dbtype) | [TrustProxySetting](#type-trustproxysetting) |
| [EntityStorage](#type-entitystorage) | [UtxoReviewMode](#type-utxoreviewmode) |
| [ManagedChangeInputCandidate](#type-managedchangeinputcandidate) | [UtxoReviewReleaseMode](#type-utxoreviewreleasemode) |
| [ManagedChangePolicyOptions](#type-managedchangepolicyoptions) | [ValidatedJsonRpcResponse](#type-validatedjsonrpcresponse) |
| [PostReqsToNetworkDetailsStatus](#type-postreqstonetworkdetailsstatus) |  |

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---

##### Type: ActionBatchStatus

```ts
export type ActionBatchStatus = "active" | "prepared" | "committed" | "aborted" | "expired"
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Type: CorsMode

```ts
export type CorsMode = "public" | "allowlist" | "disabled"
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Type: DBType

```ts
export type DBType = "SQLite" | "MySQL" | "IndexedDB"
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Type: EntityStorage

```ts
export type EntityStorage = StorageProvider
```

See also: [StorageProvider](./storage.md#class-storageprovider)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Type: ManagedChangeInputCandidate

```ts
export type ManagedChangeInputCandidate = Pick<TableOutput, "outputId" | "transactionId" | "satoshis" | "txid" | "vout"> & {
    transactionStatus?: TransactionStatus;
}
```

See also: [TableOutput](./storage.md#interface-tableoutput), [TransactionStatus](./client.md#type-transactionstatus)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Type: ManagedChangePolicyOptions

```ts
export type ManagedChangePolicyOptions = Partial<ManagedChangePolicy>
```

See also: [ManagedChangePolicy](./storage.md#interface-managedchangepolicy)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Type: PostReqsToNetworkDetailsStatus

Indicates status of a new Action following a `createAction` or `signAction` in immediate mode:
When `acceptDelayedBroadcast` is falses.

'success': The action has been broadcast and accepted by the bitcoin processing network.
'doubleSpend': The action has been confirmed to double spend one or more inputs, and by the "first-seen-rule" is the losing transaction.
'invalidTx': The action was rejected by the processing network as an invalid bitcoin transaction.
'serviceError': The broadcast services are currently unable to reach the bitcoin network. The action is now queued for delayed retries.

'invalid': The action was in an invalid state for processing, this status should never be seen by user code.
'unknown': An internal processing error has occured, this status should never be seen by user code.

```ts
export type PostReqsToNetworkDetailsStatus = "success" | "doubleSpend" | "unknown" | "invalid" | "serviceError" | "invalidTx"
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Type: PreparedBeefState

```ts
export type PreparedBeefState = "ready" | "stale" | "failed"
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Type: ResourceProfileName

```ts
export type ResourceProfileName = "small" | "standard" | "high-throughput"
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Type: TrustProxySetting

```ts
export type TrustProxySetting = number | string | string[] | ((ip: string, hop: number) => boolean)
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Type: UtxoReviewMode

```ts
export type UtxoReviewMode = "all" | "change" | "liquidity"
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Type: UtxoReviewReleaseMode

```ts
export type UtxoReviewReleaseMode = "none" | "atomic" | "conclusive"
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Type: ValidatedJsonRpcResponse

```ts
export type ValidatedJsonRpcResponse = {
    jsonrpc: "2.0";
    id: number;
    result: unknown;
} | {
    jsonrpc: "2.0";
    id: number;
    error: unknown;
}
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
#### Variables

| | | |
| --- | --- | --- |
| [ACTION_BATCH_HARD_LIFETIME_MS](#variable-action_batch_hard_lifetime_ms) | [BINARY_REQUEST_ENCODING_HEADER](#variable-binary_request_encoding_header) | [PAYMENT_REPLAY_MIGRATION](#variable-payment_replay_migration) |
| [ACTION_BATCH_LEASE_MS](#variable-action_batch_lease_ms) | [BRC177_NO_SEND_EXPIRY_MIGRATION](#variable-brc177_no_send_expiry_migration) | [PAYMENT_REPLAY_TABLE](#variable-payment_replay_table) |
| [ACTION_BATCH_MAX_BLOB_BYTES](#variable-action_batch_max_blob_bytes) | [CREATE_ACTION_FUNDING_INDEX_MIGRATION](#variable-create_action_funding_index_migration) | [PREPARED_BEEF_FORMAT_VERSION](#variable-prepared_beef_format_version) |
| [ACTION_BATCH_MAX_CONCURRENT_UPLOADS](#variable-action_batch_max_concurrent_uploads) | [DEFAULT_AUTH_SESSION_TOUCH_INTERVAL_MS](#variable-default_auth_session_touch_interval_ms) | [PREPARED_BEEF_MIGRATION](#variable-prepared_beef_migration) |
| [ACTION_BATCH_MAX_INLINE_BYTES](#variable-action_batch_max_inline_bytes) | [DEFAULT_AUTH_SESSION_TTL_MS](#variable-default_auth_session_ttl_ms) | [SYNC_TRANSFER_MAX_BYTES](#variable-sync_transfer_max_bytes) |
| [ACTION_BATCH_MAX_PACK_BYTES](#variable-action_batch_max_pack_bytes) | [DEFAULT_MANAGED_CHANGE_MAX_OUTPUTS_PER_ACTION](#variable-default_managed_change_max_outputs_per_action) | [SYNC_TRANSFER_MIGRATION](#variable-sync_transfer_migration) |
| [ACTION_BATCH_MAX_PACK_ITEMS](#variable-action_batch_max_pack_items) | [DEFAULT_MANAGED_CHANGE_MIGRATION_INPUTS_PER_ACTION](#variable-default_managed_change_migration_inputs_per_action) | [SYNC_TRANSFER_PART_BYTES](#variable-sync_transfer_part_bytes) |
| [ACTION_BATCH_MAX_RESERVATION_EXTENSION_OUTPUTS](#variable-action_batch_max_reservation_extension_outputs) | [DEFAULT_MANAGED_CHANGE_MINIMUM_SATOSHIS](#variable-default_managed_change_minimum_satoshis) | [UTXO_REVIEW_PROVIDER_TIMEOUT_MSECS](#variable-utxo_review_provider_timeout_msecs) |
| [ACTION_BATCH_MAX_RESERVED_OUTPUTS](#variable-action_batch_max_reserved_outputs) | [DEFAULT_MANAGED_CHANGE_PENDING_COMPARISON_INPUTS](#variable-default_managed_change_pending_comparison_inputs) | [WALLET_SYNC_SOURCE_INDEX_MIGRATION](#variable-wallet_sync_source_index_migration) |
| [AUTH_MESSAGE_NONCE_MIGRATION](#variable-auth_message_nonce_migration) | [DEFAULT_MANAGED_CHANGE_TARGET_UTXOS](#variable-default_managed_change_target_utxos) | [getLabelToSpecOp](#variable-getlabeltospecop) |
| [AUTH_MESSAGE_NONCE_TABLE](#variable-auth_message_nonce_table) | [DEFAULT_MAX_AUTH_MESSAGE_NONCES_PER_SESSION](#variable-default_max_auth_message_nonces_per_session) | [managedChangeOutputFields](#variable-managedchangeoutputfields) |
| [AUTH_SESSION_MIGRATION](#variable-auth_session_migration) | [LEGACY_MANAGED_CHANGE_MINIMUM_SATOSHIS](#variable-legacy_managed_change_minimum_satoshis) | [maxChangeOutputsPerTransaction](#variable-maxchangeoutputspertransaction) |
| [AUTH_SESSION_TABLE](#variable-auth_session_table) | [MANAGED_CHANGE_POLICY_MIGRATION](#variable-managed_change_policy_migration) | [maxPossibleSatoshis](#variable-maxpossiblesatoshis) |
| [BINARY_ENCODING](#variable-binary_encoding) | [MAX_UTXO_REVIEW_CANDIDATES](#variable-max_utxo_review_candidates) | [outputColumnsWithoutLockingScript](#variable-outputcolumnswithoutlockingscript) |
| [BINARY_ENCODING_HEADER](#variable-binary_encoding_header) | [MONITOR_CREATED_AT_INDEX_MIGRATION](#variable-monitor_created_at_index_migration) | [transactionColumnsWithoutRawTx](#variable-transactioncolumnswithoutrawtx) |

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---

##### Variable: ACTION_BATCH_HARD_LIFETIME_MS

```ts
ACTION_BATCH_HARD_LIFETIME_MS = 60 * 60 * 1000
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Variable: ACTION_BATCH_LEASE_MS

```ts
ACTION_BATCH_LEASE_MS = 15 * 60 * 1000
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Variable: ACTION_BATCH_MAX_BLOB_BYTES

```ts
ACTION_BATCH_MAX_BLOB_BYTES = 8 * 1024 * 1024
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Variable: ACTION_BATCH_MAX_CONCURRENT_UPLOADS

```ts
ACTION_BATCH_MAX_CONCURRENT_UPLOADS = 4
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Variable: ACTION_BATCH_MAX_INLINE_BYTES

```ts
ACTION_BATCH_MAX_INLINE_BYTES = 4 * 1024 * 1024
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Variable: ACTION_BATCH_MAX_PACK_BYTES

```ts
ACTION_BATCH_MAX_PACK_BYTES = 8 * 1024 * 1024
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Variable: ACTION_BATCH_MAX_PACK_ITEMS

```ts
ACTION_BATCH_MAX_PACK_ITEMS = 4096
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Variable: ACTION_BATCH_MAX_RESERVATION_EXTENSION_OUTPUTS

```ts
ACTION_BATCH_MAX_RESERVATION_EXTENSION_OUTPUTS = 64
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Variable: ACTION_BATCH_MAX_RESERVED_OUTPUTS

```ts
ACTION_BATCH_MAX_RESERVED_OUTPUTS = 256
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Variable: AUTH_MESSAGE_NONCE_MIGRATION

```ts
AUTH_MESSAGE_NONCE_MIGRATION = "2026-09-16-001 add auth message replay claims"
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Variable: AUTH_MESSAGE_NONCE_TABLE

```ts
AUTH_MESSAGE_NONCE_TABLE = "auth_message_nonces"
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Variable: AUTH_SESSION_MIGRATION

```ts
AUTH_SESSION_MIGRATION = "2026-07-14-001 add shared auth sessions"
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Variable: AUTH_SESSION_TABLE

```ts
AUTH_SESSION_TABLE = "auth_sessions"
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Variable: BINARY_ENCODING

```ts
BINARY_ENCODING = "base64"
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Variable: BINARY_ENCODING_HEADER

```ts
BINARY_ENCODING_HEADER = "X-BSV-Binary-Encoding"
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Variable: BINARY_REQUEST_ENCODING_HEADER

```ts
BINARY_REQUEST_ENCODING_HEADER = "X-BSV-Binary-Request-Encoding"
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Variable: BRC177_NO_SEND_EXPIRY_MIGRATION

```ts
BRC177_NO_SEND_EXPIRY_MIGRATION = "2026-08-30-001 add brc177 nosend expiry state"
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Variable: CREATE_ACTION_FUNDING_INDEX_MIGRATION

```ts
CREATE_ACTION_FUNDING_INDEX_MIGRATION = "2026-08-02-001 add createAction funding selection index"
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Variable: DEFAULT_AUTH_SESSION_TOUCH_INTERVAL_MS

```ts
DEFAULT_AUTH_SESSION_TOUCH_INTERVAL_MS = 60 * 1000
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Variable: DEFAULT_AUTH_SESSION_TTL_MS

```ts
DEFAULT_AUTH_SESSION_TTL_MS = 24 * 60 * 60 * 1000
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Variable: DEFAULT_MANAGED_CHANGE_MAX_OUTPUTS_PER_ACTION

```ts
DEFAULT_MANAGED_CHANGE_MAX_OUTPUTS_PER_ACTION = 8
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Variable: DEFAULT_MANAGED_CHANGE_MIGRATION_INPUTS_PER_ACTION

```ts
DEFAULT_MANAGED_CHANGE_MIGRATION_INPUTS_PER_ACTION = 4
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Variable: DEFAULT_MANAGED_CHANGE_MINIMUM_SATOSHIS

```ts
DEFAULT_MANAGED_CHANGE_MINIMUM_SATOSHIS = 5000
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Variable: DEFAULT_MANAGED_CHANGE_PENDING_COMPARISON_INPUTS

```ts
DEFAULT_MANAGED_CHANGE_PENDING_COMPARISON_INPUTS = 16
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Variable: DEFAULT_MANAGED_CHANGE_TARGET_UTXOS

```ts
DEFAULT_MANAGED_CHANGE_TARGET_UTXOS = 144
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Variable: DEFAULT_MAX_AUTH_MESSAGE_NONCES_PER_SESSION

```ts
DEFAULT_MAX_AUTH_MESSAGE_NONCES_PER_SESSION = 100000
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Variable: LEGACY_MANAGED_CHANGE_MINIMUM_SATOSHIS

```ts
LEGACY_MANAGED_CHANGE_MINIMUM_SATOSHIS = 32
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Variable: MANAGED_CHANGE_POLICY_MIGRATION

```ts
MANAGED_CHANGE_POLICY_MIGRATION = "2026-08-10-001 upgrade managed change liquidity defaults"
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Variable: MAX_UTXO_REVIEW_CANDIDATES

```ts
MAX_UTXO_REVIEW_CANDIDATES = 10000
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Variable: MONITOR_CREATED_AT_INDEX_MIGRATION

```ts
MONITOR_CREATED_AT_INDEX_MIGRATION = "2026-07-14-002 add monitor created index"
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Variable: PAYMENT_REPLAY_MIGRATION

```ts
PAYMENT_REPLAY_MIGRATION = "2026-08-04-001 add payment replay claims"
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Variable: PAYMENT_REPLAY_TABLE

```ts
PAYMENT_REPLAY_TABLE = "payment_replays"
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Variable: PREPARED_BEEF_FORMAT_VERSION

```ts
PREPARED_BEEF_FORMAT_VERSION = 1
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Variable: PREPARED_BEEF_MIGRATION

```ts
PREPARED_BEEF_MIGRATION = "2026-08-31-001 add prepared beef artifacts"
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Variable: SYNC_TRANSFER_MAX_BYTES

```ts
SYNC_TRANSFER_MAX_BYTES = 64 * 1024 * 1024
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Variable: SYNC_TRANSFER_MIGRATION

```ts
SYNC_TRANSFER_MIGRATION = "2026-09-09-001 add bounded sync transfers"
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Variable: SYNC_TRANSFER_PART_BYTES

```ts
SYNC_TRANSFER_PART_BYTES = 256 * 1024
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Variable: UTXO_REVIEW_PROVIDER_TIMEOUT_MSECS

```ts
UTXO_REVIEW_PROVIDER_TIMEOUT_MSECS = 5000
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Variable: WALLET_SYNC_SOURCE_INDEX_MIGRATION

```ts
WALLET_SYNC_SOURCE_INDEX_MIGRATION = "2026-08-17-001 add wallet sync source indexes"
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Variable: getLabelToSpecOp

```ts
getLabelToSpecOp: () => Record<string, ListActionsSpecOp> = () => {
    return {
        [specOpNoSendActions]: {
            name: "noSendActions",
            labelsToIntercept: ["abort"],
            setStatusFilter: () => ["nosend"],
            postProcess: async (s: StorageProvider, auth: AuthId, vargs: Validation.ValidListActionsArgs, specOpLabels: string[], txs: Array<Partial<TableTransaction>>): Promise<void> => {
                await postProcessNoSendActions(s, auth, specOpLabels, txs);
            }
        },
        [specOpFailedActions]: {
            name: "failedActions",
            labelsToIntercept: ["unfail"],
            setStatusFilter: () => ["failed"],
            postProcess: async (s: StorageProvider, auth: AuthId, vargs: Validation.ValidListActionsArgs, specOpLabels: string[], txs: Array<Partial<TableTransaction>>): Promise<void> => {
                if (specOpLabels.includes("unfail")) {
                    for (const tx of txs) {
                        if (tx.status === "failed") {
                            await s.updateTransaction(tx.transactionId!, { status: "unfail" });
                        }
                    }
                }
            }
        }
    };
}
```

See also: [AuthId](./client.md#interface-authid), [ListActionsSpecOp](./storage.md#interface-listactionsspecop), [StorageProvider](./storage.md#class-storageprovider), [TableTransaction](./storage.md#interface-tabletransaction), [specOpFailedActions](./client.md#variable-specopfailedactions), [specOpNoSendActions](./client.md#variable-specopnosendactions)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Variable: managedChangeOutputFields

```ts
managedChangeOutputFields = {
    type: "P2PKH",
    change: true,
    providedBy: "storage",
    purpose: "change"
} as const
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Variable: maxChangeOutputsPerTransaction

```ts
maxChangeOutputsPerTransaction = 8
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Variable: maxPossibleSatoshis

```ts
maxPossibleSatoshis = 2099999999999999
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Variable: outputColumnsWithoutLockingScript

```ts
outputColumnsWithoutLockingScript = [
    "created_at",
    "updated_at",
    "outputId",
    "userId",
    "transactionId",
    "basketId",
    "spendable",
    "change",
    "vout",
    "satoshis",
    "providedBy",
    "purpose",
    "type",
    "outputDescription",
    "txid",
    "senderIdentityKey",
    "derivationPrefix",
    "derivationSuffix",
    "customInstructions",
    "spentBy",
    "sequenceNumber",
    "spendingDescription",
    "scriptLength",
    "scriptOffset"
]
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Variable: transactionColumnsWithoutRawTx

```ts
transactionColumnsWithoutRawTx = [
    "created_at",
    "updated_at",
    "transactionId",
    "userId",
    "provenTxId",
    "status",
    "reference",
    "isOutgoing",
    "satoshis",
    "version",
    "lockTime",
    "description",
    "txid",
    "noSendExpiryMode",
    "noSendExpiryValue",
    "noSendExpiryDeadline",
    "noSendExpiryState",
    "noSendExpiryAnchorTxid",
    "noSendExpiryAnchorVout",
    "noSendExpiryReleasedAt",
    "noSendExpiryObservedAt",
    "noSendExpiryReclaimTxid",
    "noSendExpiryReclaimDerivationPrefix",
    "noSendExpiryReclaimDerivationSuffix",
    "noSendExpiryReclaimSatoshis"
]
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---

<!--#endregion ts2md-api-merged-here-->
