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
| [AdminStatsResult](#interface-adminstatsresult) | [PostBeefResultForTxidApi](#interface-postbeefresultfortxidapi) | [TableMonitorLease](#interface-tablemonitorlease) |
| [AggregatePostBeefTxResult](#interface-aggregatepostbeeftxresult) | [PostReqsToNetworkDetails](#interface-postreqstonetworkdetails) | [TableOutput](#interface-tableoutput) |
| [AuditEvent](#interface-auditevent) | [PostReqsToNetworkResult](#interface-postreqstonetworkresult) | [TableOutputBasket](#interface-tableoutputbasket) |
| [CommitNewTxResults](#interface-commitnewtxresults) | [ProvenTxFromTxidResult](#interface-proventxfromtxidresult) | [TableOutputTag](#interface-tableoutputtag) |
| [EntitySyncMap](#interface-entitysyncmap) | [ProvenTxReqHistory](#interface-proventxreqhistory) | [TableOutputTagMap](#interface-tableoutputtagmap) |
| [FsmTransitionResult](#interface-fsmtransitionresult) | [ProvenTxReqHistorySummaryApi](#interface-proventxreqhistorysummaryapi) | [TableOutputX](#interface-tableoutputx) |
| [GenerateChangeSdkChangeInput](#interface-generatechangesdkchangeinput) | [ProvenTxReqNotify](#interface-proventxreqnotify) | [TableProvenTx](#interface-tableproventx) |
| [GenerateChangeSdkChangeOutput](#interface-generatechangesdkchangeoutput) | [StorageAdminStats](#interface-storageadminstats) | [TableProvenTxReq](#interface-tableproventxreq) |
| [GenerateChangeSdkInput](#interface-generatechangesdkinput) | [StorageIdbOptions](#interface-storageidboptions) | [TableProvenTxReqDynamics](#interface-tableproventxreqdynamics) |
| [GenerateChangeSdkOutput](#interface-generatechangesdkoutput) | [StorageIdbSchema](#interface-storageidbschema) | [TableSettings](#interface-tablesettings) |
| [GenerateChangeSdkParams](#interface-generatechangesdkparams) | [StorageKnexOptions](#interface-storageknexoptions) | [TableSyncState](#interface-tablesyncstate) |
| [GenerateChangeSdkResult](#interface-generatechangesdkresult) | [StorageProviderOptions](#interface-storageprovideroptions) | [TableTransaction](#interface-tabletransaction) |
| [GenerateChangeSdkStorageChange](#interface-generatechangesdkstoragechange) | [StorageReaderOptions](#interface-storagereaderoptions) | [TableTransactionNew](#interface-tabletransactionnew) |
| [GetReqsAndBeefDetail](#interface-getreqsandbeefdetail) | [StorageReaderWriterOptions](#interface-storagereaderwriteroptions) | [TableTxAudit](#interface-tabletxaudit) |
| [GetReqsAndBeefResult](#interface-getreqsandbeefresult) | [SyncError](#interface-syncerror) | [TableTxLabel](#interface-tabletxlabel) |
| [ListActionsSpecOp](#interface-listactionsspecop) | [SyncMap](#interface-syncmap) | [TableTxLabelMap](#interface-tabletxlabelmap) |
| [ListOutputsSpecOp](#interface-listoutputsspecop) | [TableAction](#interface-tableaction) | [TableUser](#interface-tableuser) |
| [MonitorAdminContext](#interface-monitoradmincontext) | [TableCertificate](#interface-tablecertificate) | [ValidateGenerateChangeSdkParamsResult](#interface-validategeneratechangesdkparamsresult) |
| [MonitorAdminContextConfig](#interface-monitoradmincontextconfig) | [TableCertificateField](#interface-tablecertificatefield) | [VerifyAndRepairBeefResult](#interface-verifyandrepairbeefresult) |
| [MonitorLeaseClaim](#interface-monitorleaseclaim) | [TableCertificateX](#interface-tablecertificatex) | [WalletStorageServerOptions](#interface-walletstorageserveroptions) |
| [MonitorLeaseRelease](#interface-monitorleaserelease) | [TableChainTip](#interface-tablechaintip) | [XValidCreateActionOutput](#interface-xvalidcreateactionoutput) |
| [MonitorLeaseRenew](#interface-monitorleaserenew) | [TableCommission](#interface-tablecommission) |  |
| [MonitorLeaseResult](#interface-monitorleaseresult) | [TableMonitorEvent](#interface-tablemonitorevent) |  |

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
##### Interface: AuditEvent

append-only audit log writer.

Each call inserts one `tx_audit` row. Events should be small, stable
identifiers (e.g. `processing.changed`, `proof.acquired`, `lease.claimed`).
Payload is stored as a JSON-encoded string so downstream consumers may add
shape over time without a migration.

```ts
export interface AuditEvent {
    transactionId?: number;
    actionId?: number;
    event: string;
    fromState?: sdk.ProcessingStatus;
    toState?: sdk.ProcessingStatus;
    details?: Record<string, unknown>;
}
```

See also: [ProcessingStatus](./client.md#type-processingstatus)

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
##### Interface: FsmTransitionResult

```ts
export interface FsmTransitionResult {
    ok: boolean;
    reason?: string;
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
Defaults to `maxChangeOutputsPerTransaction` (8).

Callers may override this to allow more outputs in special cases (e.g.
consolidation transactions) or fewer outputs when a compact transaction
is preferred.

```ts
maxChangeOutputs?: number
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
}
```

See also: [GetReqsAndBeefDetail](./storage.md#interface-getreqsandbeefdetail)

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
    includeOutputScripts?: boolean;
    includeSpent?: boolean;
    totalOutputsIsSumOfSatoshis?: boolean;
    resultFromTags?: (s: StorageProvider, auth: AuthId, vargs: Validation.ValidListOutputsArgs, specOpTags: string[]) => Promise<ListOutputsResult>;
    resultFromOutputs?: (s: StorageProvider, auth: AuthId, vargs: Validation.ValidListOutputsArgs, specOpTags: string[], outputs: TableOutput[]) => Promise<ListOutputsResult>;
    filterOutputs?: (s: StorageProvider, auth: AuthId, vargs: Validation.ValidListOutputsArgs, specOpTags: string[], outputs: TableOutput[]) => Promise<TableOutput[]>;
    tagsToIntercept?: string[];
    tagsParamsCount?: number;
}
```

See also: [AuthId](./client.md#interface-authid), [StorageProvider](./storage.md#class-storageprovider), [TableOutput](./storage.md#interface-tableoutput)

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
}
```

See also: [Chain](./client.md#type-chain)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: MonitorLeaseClaim

monitor lease primitive.

A `monitor_lease` row records the owner that may currently execute a named
task. Acquisition is opportunistic: a Monitor calls `tryClaimLease()` to
insert or take over a stale row; if it succeeds it owns the task until
`expiresAt`. While running it calls `renewLease()` to extend the deadline.
On clean shutdown it calls `releaseLease()`.

The Knex driver expresses claim + takeover as a single conditional UPDATE
so that two contending Monitors cannot both believe they own the task — at
most one row write will succeed per (task, expiry) pair.

```ts
export interface MonitorLeaseClaim {
    taskName: string;
    ownerId: string;
    ttlMs: number;
    note?: string;
}
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: MonitorLeaseRelease

```ts
export interface MonitorLeaseRelease {
    taskName: string;
    ownerId: string;
}
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: MonitorLeaseRenew

```ts
export interface MonitorLeaseRenew {
    taskName: string;
    ownerId: string;
    ttlMs: number;
    note?: string;
}
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: MonitorLeaseResult

```ts
export interface MonitorLeaseResult {
    acquired: boolean;
    lease?: TableMonitorLease;
}
```

See also: [TableMonitorLease](./storage.md#interface-tablemonitorlease)

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
            provenTxId: number;
            reference: string;
            status: TransactionStatus;
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
    transactionsNew: {
        key: number;
        value: TableTransactionNew;
        indexes: {
            txid: HexString;
            processing: ProcessingStatus;
            batch: string;
            idempotencyKey: string;
        };
    };
    actions: {
        key: number;
        value: TableAction;
        indexes: {
            userId: number;
            transactionId: number;
            userId_transactionId: [
                number,
                number
            ];
            userId_reference: [
                number,
                string
            ];
        };
    };
    chainTip: {
        key: number;
        value: TableChainTip;
        indexes: Record<string, never>;
    };
    txAudit: {
        key: number;
        value: TableTxAudit;
        indexes: {
            transactionId: number;
            actionId: number;
            event: string;
        };
    };
    monitorLease: {
        key: string;
        value: TableMonitorLease;
        indexes: {
            expiresAt: Date;
        };
    };
}
```

See also: [ProcessingStatus](./client.md#type-processingstatus), [ProvenTxReqStatus](./client.md#type-proventxreqstatus), [SyncStatus](./client.md#type-syncstatus), [TableAction](./storage.md#interface-tableaction), [TableCertificate](./storage.md#interface-tablecertificate), [TableCertificateField](./storage.md#interface-tablecertificatefield), [TableChainTip](./storage.md#interface-tablechaintip), [TableCommission](./storage.md#interface-tablecommission), [TableMonitorEvent](./storage.md#interface-tablemonitorevent), [TableMonitorLease](./storage.md#interface-tablemonitorlease), [TableOutput](./storage.md#interface-tableoutput), [TableOutputBasket](./storage.md#interface-tableoutputbasket), [TableOutputTag](./storage.md#interface-tableoutputtag), [TableOutputTagMap](./storage.md#interface-tableoutputtagmap), [TableProvenTx](./storage.md#interface-tableproventx), [TableProvenTxReq](./storage.md#interface-tableproventxreq), [TableSettings](./storage.md#interface-tablesettings), [TableSyncState](./storage.md#interface-tablesyncstate), [TableTransaction](./storage.md#interface-tabletransaction), [TableTransactionNew](./storage.md#interface-tabletransactionnew), [TableTxAudit](./storage.md#interface-tabletxaudit), [TableTxLabel](./storage.md#interface-tabletxlabel), [TableTxLabelMap](./storage.md#interface-tabletxlabelmap), [TableUser](./storage.md#interface-tableuser), [TransactionStatus](./client.md#type-transactionstatus)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: StorageKnexOptions

```ts
export interface StorageKnexOptions extends StorageProviderOptions {
    knex: Knex;
}
```

See also: [StorageProviderOptions](./storage.md#interface-storageprovideroptions)

###### Property knex

Knex database interface initialized with valid connection configuration.

```ts
knex: Knex
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: StorageProviderOptions

```ts
export interface StorageProviderOptions extends StorageReaderWriterOptions {
    chain: Chain;
    feeModel: StorageFeeModel;
    commissionSatoshis: number;
    commissionPubKeyHex?: PubKeyHex;
}
```

See also: [Chain](./client.md#type-chain), [StorageFeeModel](./client.md#interface-storagefeemodel), [StorageReaderWriterOptions](./storage.md#interface-storagereaderwriteroptions)

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

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: StorageReaderOptions

```ts
export interface StorageReaderOptions {
    chain: sdk.Chain;
}
```

See also: [Chain](./client.md#type-chain)

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
##### Interface: TableAction

per-user view of a transaction.

Migrated from the legacy `transactions` table. Holds everything that is truly
per-user (description, labels via tx_labels_map -> actionId, soft-delete flags,
notification subscribers). All on-chain status lives in the new `transactions`
table addressed by `transactionId`.

UNIQUE(userId, transactionId).

```ts
export interface TableAction extends sdk.EntityTimeStamp {
    created_at: Date;
    updated_at: Date;
    actionId: number;
    userId: number;
    transactionId: number;
    reference: string;
    description: string;
    isOutgoing: boolean;
    satoshisDelta: number;
    userNosend: boolean;
    hidden: boolean;
    userAborted: boolean;
    notifyJson?: string;
    rowVersion: number;
}
```

See also: [EntityTimeStamp](./client.md#interface-entitytimestamp)

###### Property actionId

PK

```ts
actionId: number
```

###### Property hidden

Soft-delete flag — hide from default queries

```ts
hidden: boolean
```

###### Property isOutgoing

true if originated in this wallet (change returns to it)

```ts
isOutgoing: boolean
```

###### Property notifyJson

JSON string of per-user notification subscribers (mirrors legacy notify)

```ts
notifyJson?: string
```

###### Property reference

Application reference, hex/Base64, max 64 chars

```ts
reference: string
```

###### Property rowVersion

Optimistic concurrency token

```ts
rowVersion: number
```

###### Property satoshisDelta

Signed net change to this user's balance from this action

```ts
satoshisDelta: number
```

###### Property transactionId

FK -> new transactions.transactionId (per-txid record)

```ts
transactionId: number
```

###### Property userAborted

Per-user abort flag

```ts
userAborted: boolean
```

###### Property userNosend

Per-user nosend override

```ts
userNosend: boolean
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
##### Interface: TableChainTip

singleton row tracking the most recently observed chain tip.
Used by spendability checks and coinbase maturity calculations.

```ts
export interface TableChainTip extends sdk.EntityTimeStamp {
    created_at: Date;
    updated_at: Date;
    id: number;
    height: number;
    blockHash: string;
    merkleRoot?: string;
    observedAt: Date;
}
```

See also: [EntityTimeStamp](./client.md#interface-entitytimestamp), [blockHash](./services.md#function-blockhash)

###### Property id

Always 1 — singleton enforced by storage layer

```ts
id: number
```

###### Property observedAt

Wall-clock of the observation

```ts
observedAt: Date
```

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
##### Interface: TableMonitorLease

monitor_lease record so at most one Monitor daemon owns a given task at a time.

The Monitor acquires a lease by upserting `(taskName, ownerId, expiresAt)`
and renews periodically. Stale leases (`expiresAt < now`) may be claimed by
another instance.

```ts
export interface TableMonitorLease extends sdk.EntityTimeStamp {
    created_at: Date;
    updated_at: Date;
    taskName: string;
    ownerId: string;
    expiresAt: Date;
    renewCount: number;
    note?: string;
}
```

See also: [EntityTimeStamp](./client.md#interface-entitytimestamp)

###### Property expiresAt

Lease expiry — claimants treat any row with expiresAt <= now() as free

```ts
expiresAt: Date
```

###### Property note

Optional free-text description of current activity

```ts
note?: string
```

###### Property ownerId

Stable identifier for the owning Monitor instance

```ts
ownerId: string
```

###### Property renewCount

Monotonic counter incremented on each successful renew

```ts
renewCount: number
```

###### Property taskName

Logical task name, e.g. 'proof-acquisition'

```ts
taskName: string
```

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
    maturesAtHeight?: number;
}
```

See also: [EntityTimeStamp](./client.md#interface-entitytimestamp), [StorageProvidedBy](./client.md#type-storageprovidedby)

###### Property maturesAtHeight

new-schema: minimum block height at which a coinbase output becomes spendable.
NULL for non-coinbase outputs and for pre-new schema rows that have not yet been
backfilled. The §4 spendability rule treats a non-coinbase output as
mature regardless of this column.

```ts
maturesAtHeight?: number
```

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
}
```

See also: [EntityTimeStamp](./client.md#interface-entitytimestamp), [TransactionStatus](./client.md#type-transactionstatus)

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
##### Interface: TableTransactionNew

new canonical per-txid table.

Single source of truth for everything about a transaction on the network.
Merges the legacy `proven_tx_reqs` (broadcast queue + processing state) and
`proven_txs` (final Merkle proof) tables into one row per txid.

Per-user metadata (description, labels, hidden, etc.) lives in `actions`.

```ts
export interface TableTransactionNew extends sdk.EntityTimeStamp {
    created_at: Date;
    updated_at: Date;
    transactionId: number;
    txid: string;
    processing: sdk.ProcessingStatus;
    processingChangedAt: Date;
    nextActionAt?: Date;
    attempts: number;
    rebroadcastCycles: number;
    wasBroadcast: boolean;
    idempotencyKey?: string;
    batch?: string;
    rawTx?: number[];
    inputBeef?: number[];
    height?: number;
    merkleIndex?: number;
    merklePath?: number[];
    merkleRoot?: string;
    blockHash?: string;
    isCoinbase: boolean;
    lastProvider?: string;
    lastProviderStatus?: string;
    frozenReason?: string;
    rowVersion: number;
}
```

See also: [EntityTimeStamp](./client.md#interface-entitytimestamp), [ProcessingStatus](./client.md#type-processingstatus), [blockHash](./services.md#function-blockhash)

###### Property attempts

Cumulative network-service attempt count

```ts
attempts: number
```

###### Property batch

Optional batch tag for grouped broadcast

```ts
batch?: string
```

###### Property frozenReason

Reason a row is in `frozen` state, free text

```ts
frozenReason?: string
```

###### Property height

Merkle proof fields — populated on transition to `proven`

```ts
height?: number
```

###### Property idempotencyKey

Application-supplied idempotency key (unique when present)

```ts
idempotencyKey?: string
```

###### Property nextActionAt

Wall-clock at which the next monitor pass should consider this row

```ts
nextActionAt?: Date
```

###### Property processing

Granular FSM state (see ProcessingStatus)

```ts
processing: sdk.ProcessingStatus
```
See also: [ProcessingStatus](./client.md#type-processingstatus)

###### Property processingChangedAt

Wall-clock of the most recent processing transition

```ts
processingChangedAt: Date
```

###### Property rebroadcastCycles

Count of times this row has been reset for rebroadcast (circuit-breaker)

```ts
rebroadcastCycles: number
```

###### Property rowVersion

Optimistic concurrency token

```ts
rowVersion: number
```

###### Property transactionId

PK

```ts
transactionId: number
```

###### Property txid

UNIQUE — Bitcoin txid, hex

```ts
txid: string
```

###### Property wasBroadcast

true once the row has reached a state implying successful broadcast

```ts
wasBroadcast: boolean
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: TableTxAudit

per-event audit log for transactions and actions.

Each row records a single observable event scoped to either a transaction
(per-txid) or an action (per-user) or both. Append-only.

```ts
export interface TableTxAudit extends sdk.EntityTimeStamp {
    created_at: Date;
    updated_at: Date;
    auditId: number;
    transactionId?: number;
    actionId?: number;
    event: string;
    fromState?: string;
    toState?: string;
    detailsJson?: string;
}
```

See also: [EntityTimeStamp](./client.md#interface-entitytimestamp)

###### Property actionId

FK -> actions.actionId, optional for tx-only events

```ts
actionId?: number
```

###### Property auditId

PK

```ts
auditId: number
```

###### Property detailsJson

JSON-encoded event payload

```ts
detailsJson?: string
```

###### Property event

Stable event identifier, e.g. 'processing.changed', 'proof.acquired'

```ts
event: string
```

###### Property fromState

Optional FSM source state for transitions

```ts
fromState?: string
```

###### Property toState

Optional FSM target state for transitions

```ts
toState?: string
```

###### Property transactionId

FK -> transactions.transactionId, optional for action-only events

```ts
transactionId?: number
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
##### Interface: ValidateGenerateChangeSdkParamsResult

```ts
export interface ValidateGenerateChangeSdkParamsResult {
    hasMaxPossibleOutput?: number;
}
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
    port: number;
    wallet: Wallet;
    monetize: boolean;
    calculateRequestPrice?: (req: Request) => number | Promise<number>;
    adminIdentityKeys?: string[];
    makeLogger?: MakeWalletLogger;
}
```

See also: [Wallet](./client.md#class-wallet)

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
| [AdminServer](#class-adminserver) | [EntityProvenTxReq](#class-entityproventxreq) | [StorageIdb](#class-storageidb) |
| [EntityBase](#class-entitybase) | [EntitySyncState](#class-entitysyncstate) | [StorageKnex](#class-storageknex) |
| [EntityCertificate](#class-entitycertificate) | [EntityTransaction](#class-entitytransaction) | [StorageProvider](#class-storageprovider) |
| [EntityCertificateField](#class-entitycertificatefield) | [EntityTxLabel](#class-entitytxlabel) | [StorageReader](#class-storagereader) |
| [EntityCommission](#class-entitycommission) | [EntityTxLabelMap](#class-entitytxlabelmap) | [StorageReaderWriter](#class-storagereaderwriter) |
| [EntityOutput](#class-entityoutput) | [EntityUser](#class-entityuser) | [StorageServer](#class-storageserver) |
| [EntityOutputBasket](#class-entityoutputbasket) | [KnexMigrations](#class-knexmigrations) | [StorageSyncReader](#class-storagesyncreader) |
| [EntityOutputTag](#class-entityoutputtag) | [MergeEntity](#class-mergeentity) | [TransactionService](#class-transactionservice) |
| [EntityOutputTagMap](#class-entityoutputtagmap) | [StorageClient](#class-storageclient) | [WalletStorageManager](#class-walletstoragemanager) |
| [EntityProvenTx](#class-entityproventx) | [StorageClientBase](#class-storageclientbase) |  |

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
    getMerklePath(): MerklePath 
    _mp?: MerklePath;
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
    static async fromReq(req: EntityProvenTxReq, gmpResult: GetMerklePathResult, countsAsAttempt: boolean, maxRebroadcastAttempts = 0): Promise<EntityProvenTx | undefined> 
}
```

See also: [EntityBase](./storage.md#class-entitybase), [EntityProvenTxReq](./storage.md#class-entityproventxreq), [EntityStorage](./storage.md#type-entitystorage), [GetMerklePathResult](./client.md#interface-getmerklepathresult), [ProvenTxFromTxidResult](./storage.md#interface-proventxfromtxidresult), [SyncMap](./storage.md#interface-syncmap), [TableProvenTx](./storage.md#interface-tableproventx), [TrxToken](./client.md#interface-trxtoken), [WalletServices](./client.md#interface-walletservices), [blockHash](./services.md#function-blockhash)

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
static async fromReq(req: EntityProvenTxReq, gmpResult: GetMerklePathResult, countsAsAttempt: boolean, maxRebroadcastAttempts = 0): Promise<EntityProvenTx | undefined> 
```
See also: [EntityProvenTx](./storage.md#class-entityproventx), [EntityProvenTxReq](./storage.md#class-entityproventxreq), [GetMerklePathResult](./client.md#interface-getmerklepathresult)

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
getMerklePath(): MerklePath 
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
    static fromTxid(txid: string, rawTx: number[], inputBEEF?: number[]): EntityProvenTxReq 
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
    historyPretty(since?: Date, indent = 0): string 
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
    static syncChunkSummary(c: SyncChunk): string {
        let log = "";
        log += `SYNC CHUNK SUMMARY
  from storage: ${c.fromStorageIdentityKey}
  to storage: ${c.toStorageIdentityKey}
  for user: ${c.userIdentityKey}
`;
        if (c.user != null)
            log += `  USER activeStorage ${c.user.activeStorage}\n`;
        if (c.provenTxs != null) {
            log += "  PROVEN_TXS\n";
            for (const r of c.provenTxs) {
                log += `    ${r.provenTxId} ${r.txid}\n`;
            }
        }
        if (c.provenTxReqs != null) {
            log += "  PROVEN_TX_REQS\n";
            for (const r of c.provenTxReqs) {
                log += `    ${r.provenTxReqId} ${r.txid} ${r.status} ${r.provenTxId || ""}\n`;
            }
        }
        if (c.transactions != null) {
            log += "  TRANSACTIONS\n";
            for (const r of c.transactions) {
                log += `    ${r.transactionId} ${r.txid} ${r.status} ${r.provenTxId || ""} sats:${r.satoshis}\n`;
            }
        }
        if (c.outputs != null) {
            log += "  OUTPUTS\n";
            for (const r of c.outputs) {
                log += `    ${r.outputId} ${r.txid}.${r.vout} ${r.transactionId} ${r.spendable ? "spendable" : ""} sats:${r.satoshis}\n`;
            }
        }
        return log;
    }
    async processSyncChunk(writer: EntityStorage, args: RequestSyncChunkArgs, chunk: SyncChunk): Promise<{
        done: boolean;
        maxUpdated_at: Date | undefined;
        updates: number;
        inserts: number;
    }> 
}
```

See also: [EntityBase](./storage.md#class-entitybase), [EntityStorage](./storage.md#type-entitystorage), [RequestSyncChunkArgs](./client.md#interface-requestsyncchunkargs), [SyncChunk](./client.md#interface-syncchunk), [SyncError](./storage.md#interface-syncerror), [SyncMap](./storage.md#interface-syncmap), [SyncStatus](./client.md#type-syncstatus), [TableSettings](./storage.md#interface-tablesettings), [TableSyncState](./storage.md#interface-tablesyncstate), [TrxToken](./client.md#interface-trxtoken), [WalletStorageSync](./client.md#interface-walletstoragesync)

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

v3 greenfield schema — see `docs/v3-upgrade/SCHEMA_V4.md`.

 - `transactions` keyed by `txid` (canonical chain record).
 - `actions` per-user (PK actionId, FK txid nullable for unsigned drafts).
 - `outputs` FK actionId, with denormalised txid + `spentByActionId`.
 - `commissions` FK actionId. `tx_audit(txid, actionId)`. `tx_labels_map.actionId`.

No bridge tables. No `runSchemaCutover`. Fresh installs get the canonical
layout from a single migration; v2 deployments perform their own ETL.

```ts
export class KnexMigrations implements MigrationSource<string> {
    migrations: Record<string, Migration> = {};
    constructor(public chain: Chain, public storageName: string, public storageIdentityKey: string, public maxOutputScriptLength: number) 
    async getMigrations(): Promise<string[]> 
    getMigrationName(m: string) 
    async getMigration(m: string): Promise<Migration> 
    async getLatestMigration(): Promise<string> 
    static async latestMigration(): Promise<string> 
    setupMigrations(chain: string, storageName: string, storageIdentityKey: string, maxOutputScriptLength: number): Record<string, Migration> 
}
```

See also: [Chain](./client.md#type-chain)

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
##### Class: StorageClient

`StorageClient` implements the `WalletStorageProvider` interface which allows it to
serve as a BRC-100 wallet's active storage.

Internally, it uses JSON-RPC over HTTPS to make requests of a remote server.
Typically this server uses the `StorageServer` class to implement the service.

The `AuthFetch` component is used to secure and authenticate the requests to the remote server.

`AuthFetch` is initialized with a BRC-100 wallet which establishes the identity of
the party making requests of the remote service.

For details of the API implemented, follow the "See also" link for the `WalletStorageProvider` interface.

```ts
export class StorageClient extends StorageClientBase {
    constructor(wallet: WalletInterface, endpointUrl: string) 
    protected async rpcCall<T>(method: string, params: unknown[]): Promise<T> 
}
```

See also: [StorageClientBase](./storage.md#class-storageclientbase)

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
    public settings?: TableSettings;
    constructor(wallet: WalletInterface, endpointUrl: string) 
    isStorageProvider(): boolean 
    protected abstract rpcCall<T>(method: string, params: unknown[]): Promise<T>;
    isAvailable(): boolean 
    getSettings(): TableSettings 
    async makeAvailable(): Promise<TableSettings> 
    async destroy(): Promise<void> 
    async migrate(storageName: string, storageIdentityKey: string): Promise<string> 
    getServices(): WalletServices 
    setServices(v: WalletServices): void 
    async internalizeAction(auth: AuthId, args: InternalizeActionArgs): Promise<StorageInternalizeActionResult> 
    async createAction(auth: AuthId, args: Validation.ValidCreateActionArgs): Promise<StorageCreateActionResult> 
    async processAction(auth: AuthId, args: StorageProcessActionArgs): Promise<StorageProcessActionResults> 
    async abortAction(auth: AuthId, args: AbortActionArgs): Promise<AbortActionResult> 
    async findOrInsertUser(identityKey): Promise<{
        user: TableUser;
        isNew: boolean;
    }> 
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
    async updateProvenTxReqWithNewProvenTx(args: UpdateProvenTxReqWithNewProvenTxArgs): Promise<UpdateProvenTxReqWithNewProvenTxResult> 
    async setActive(auth: AuthId, newActiveStorageIdentityKey: string): Promise<number> 
    validateDate(date: Date | string | number): Date 
    validateEntity<T extends EntityTimeStamp>(entity: T, dateFields?: string[]): T 
    validateEntities<T extends EntityTimeStamp>(entities: T[], dateFields?: string[]): T[] 
}
```

See also: [AuthId](./client.md#interface-authid), [EntityTimeStamp](./client.md#interface-entitytimestamp), [FindCertificatesArgs](./client.md#interface-findcertificatesargs), [FindOutputBasketsArgs](./client.md#interface-findoutputbasketsargs), [FindOutputsArgs](./client.md#interface-findoutputsargs), [FindProvenTxReqsArgs](./client.md#interface-findproventxreqsargs), [ProcessSyncChunkResult](./client.md#interface-processsyncchunkresult), [RequestSyncChunkArgs](./client.md#interface-requestsyncchunkargs), [StorageCreateActionResult](./client.md#interface-storagecreateactionresult), [StorageInternalizeActionResult](./client.md#interface-storageinternalizeactionresult), [StorageProcessActionArgs](./client.md#interface-storageprocessactionargs), [StorageProcessActionResults](./client.md#interface-storageprocessactionresults), [SyncChunk](./client.md#interface-syncchunk), [TableCertificateX](./storage.md#interface-tablecertificatex), [TableOutput](./storage.md#interface-tableoutput), [TableOutputBasket](./storage.md#interface-tableoutputbasket), [TableProvenTxReq](./storage.md#interface-tableproventxreq), [TableSettings](./storage.md#interface-tablesettings), [TableSyncState](./storage.md#interface-tablesyncstate), [TableUser](./storage.md#interface-tableuser), [UpdateProvenTxReqWithNewProvenTxArgs](./client.md#interface-updateproventxreqwithnewproventxargs), [UpdateProvenTxReqWithNewProvenTxResult](./client.md#interface-updateproventxreqwithnewproventxresult), [WalletServices](./client.md#interface-walletservices), [WalletStorageProvider](./client.md#interface-walletstorageprovider), [createAction](./storage.md#function-createaction), [getSyncChunk](./storage.md#function-getsyncchunk), [internalizeAction](./storage.md#function-internalizeaction), [listActions](./storage.md#function-listactions), [listCertificates](./storage.md#function-listcertificates), [listOutputs](./storage.md#function-listoutputs), [processAction](./storage.md#function-processaction), [validateDate](./storage.md#function-validatedate), [validateEntities](./storage.md#function-validateentities), [validateEntity](./storage.md#function-validateentity)

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
async findOrInsertUser(identityKey): Promise<{
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
getSettings(): TableSettings 
```
See also: [TableSettings](./storage.md#interface-tablesettings)

Returns

remote storage `TableSettings` if they have been retreived by `makeAvailable`.

Throws

WERR_INVALID_OPERATION if `makeAvailable` has not yet been called.

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
async makeAvailable(): Promise<TableSettings> 
```
See also: [TableSettings](./storage.md#interface-tablesettings)

Returns

remote storage `TableSettings`

###### Method migrate

Requests schema migration to latest.
Typically remote storage will ignore this request.

```ts
async migrate(storageName: string, storageIdentityKey: string): Promise<string> 
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
setServices(v: WalletServices): void 
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
    async migrate(storageName: string, storageIdentityKey: string): Promise<string> 
    async verifyDB(storageName?: string, storageIdentityKey?: string): Promise<IDBPDatabase<StorageIdbSchema>> 
    toDbTrx(stores: string[], mode: "readonly" | "readwrite", trx?: TrxToken): IDBPTransaction<StorageIdbSchema, string[], "readwrite" | "readonly"> 
    async readSettings(trx?: TrxToken): Promise<TableSettings> 
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
    async getRawTxOfKnownValidTransaction(txid?: string, offset?: number, length?: number, trx?: TrxToken): Promise<number[] | undefined> 
    async getLabelsForTransactionId(transactionId?: number, trx?: TrxToken): Promise<TableTxLabel[]> 
    async getTagsForOutputId(outputId: number, trx?: TrxToken): Promise<TableOutputTag[]> 
    async listActions(auth: AuthId, vargs: Validation.ValidListActionsArgs): Promise<ListActionsResult> 
    async listOutputs(auth: AuthId, vargs: Validation.ValidListOutputsArgs): Promise<ListOutputsResult> 
    async countChangeInputs(userId: number, basketId: number, excludeSending: boolean): Promise<number> 
    async findCertificatesAuth(auth: AuthId, args: FindCertificatesArgs): Promise<TableCertificateX[]> 
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
    async updateTxLabel(id: number, update: Partial<TableTxLabel>, trx?: TrxToken): Promise<number> 
    async updateUser(id: number, update: Partial<TableUser>, trx?: TrxToken): Promise<number> 
    async updateOutputTagMap(outputId: number, tagId: number, update: Partial<TableOutputTagMap>, trx?: TrxToken): Promise<number> 
    async updateTxLabelMap(transactionId: number, txLabelId: number, update: Partial<TableTxLabelMap>, trx?: TrxToken): Promise<number> 
    async destroy(): Promise<void> 
    allStores: string[] = [
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
    async verifyReadyForDatabaseAccess(trx?: TrxToken): Promise<DBType> 
    validateEntity<T extends EntityTimeStamp>(entity: T, dateFields?: string[], booleanFields?: string[]): T 
    validateEntities<T extends EntityTimeStamp>(entities: T[], dateFields?: string[], booleanFields?: string[]): T[] 
    validatePartialForUpdate<T extends EntityTimeStamp>(update: Partial<T>, dateFields?: string[], booleanFields?: string[]): Partial<T> 
    async validateEntityForInsert<T extends EntityTimeStamp>(entity: T, trx?: TrxToken, dateFields?: string[], booleanFields?: string[]): Promise<any> 
    async validateRawTransaction(t: TableTransaction, trx?: TrxToken): Promise<void> 
    async adminStats(adminIdentityKey: string): Promise<StorageAdminStats> 
}
```

See also: [AuthId](./client.md#interface-authid), [DBType](./storage.md#type-dbtype), [EntityTimeStamp](./client.md#interface-entitytimestamp), [FindCertificateFieldsArgs](./client.md#interface-findcertificatefieldsargs), [FindCertificatesArgs](./client.md#interface-findcertificatesargs), [FindCommissionsArgs](./client.md#interface-findcommissionsargs), [FindForUserSincePagedArgs](./client.md#interface-findforusersincepagedargs), [FindMonitorEventsArgs](./client.md#interface-findmonitoreventsargs), [FindOutputBasketsArgs](./client.md#interface-findoutputbasketsargs), [FindOutputTagMapsArgs](./client.md#interface-findoutputtagmapsargs), [FindOutputTagsArgs](./client.md#interface-findoutputtagsargs), [FindOutputsArgs](./client.md#interface-findoutputsargs), [FindProvenTxReqsArgs](./client.md#interface-findproventxreqsargs), [FindProvenTxsArgs](./client.md#interface-findproventxsargs), [FindSyncStatesArgs](./client.md#interface-findsyncstatesargs), [FindTransactionsArgs](./client.md#interface-findtransactionsargs), [FindTxLabelMapsArgs](./client.md#interface-findtxlabelmapsargs), [FindTxLabelsArgs](./client.md#interface-findtxlabelsargs), [FindUsersArgs](./client.md#interface-findusersargs), [ProvenOrRawTx](./client.md#interface-provenorrawtx), [PurgeParams](./client.md#interface-purgeparams), [PurgeResults](./client.md#interface-purgeresults), [StorageAdminStats](./storage.md#interface-storageadminstats), [StorageIdbOptions](./storage.md#interface-storageidboptions), [StorageIdbSchema](./storage.md#interface-storageidbschema), [StorageProvider](./storage.md#class-storageprovider), [TableCertificate](./storage.md#interface-tablecertificate), [TableCertificateField](./storage.md#interface-tablecertificatefield), [TableCertificateX](./storage.md#interface-tablecertificatex), [TableCommission](./storage.md#interface-tablecommission), [TableMonitorEvent](./storage.md#interface-tablemonitorevent), [TableOutput](./storage.md#interface-tableoutput), [TableOutputBasket](./storage.md#interface-tableoutputbasket), [TableOutputTag](./storage.md#interface-tableoutputtag), [TableOutputTagMap](./storage.md#interface-tableoutputtagmap), [TableProvenTx](./storage.md#interface-tableproventx), [TableProvenTxReq](./storage.md#interface-tableproventxreq), [TableSettings](./storage.md#interface-tablesettings), [TableSyncState](./storage.md#interface-tablesyncstate), [TableTransaction](./storage.md#interface-tabletransaction), [TableTxLabel](./storage.md#interface-tabletxlabel), [TableTxLabelMap](./storage.md#interface-tabletxlabelmap), [TableUser](./storage.md#interface-tableuser), [TrxToken](./client.md#interface-trxtoken), [WalletStorageProvider](./client.md#interface-walletstorageprovider), [listActions](./storage.md#function-listactions), [listOutputs](./storage.md#function-listoutputs), [purgeData](./storage.md#function-purgedata), [reviewStatus](./storage.md#function-reviewstatus), [validateEntities](./storage.md#function-validateentities), [validateEntity](./storage.md#function-validateentity)

###### Method allocateChangeInput

Proceeds in three stages:
1. Find an output that exactly funds the transaction (if exactSatoshis is not undefined).
2. Find an output that overfunds by the least amount (targetSatoshis).
3. Find an output that comes as close to funding as possible (targetSatoshis).
4. Return undefined if no output is found.

Outputs must belong to userId and basketId and have spendable true.
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
async readSettings(trx?: TrxToken): Promise<TableSettings> 
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
    constructor(options: StorageKnexOptions) 
    override getTransactionService(): TransactionService | undefined 
    override async makeAvailable(): Promise<TableSettings> 
    async provenTxsTableName(): Promise<string> 
    async provenTxReqsTableName(): Promise<string> 
    override async insertLegacyTransaction(tx: TableTransaction, trx?: TrxToken): Promise<number> 
    override async insertLegacyTxLabelMap(labelMap: TableTxLabelMap, trx?: TrxToken): Promise<void> 
    async readSettings(): Promise<TableSettings> 
    override async getProvenOrRawTx(txid: string, trx?: TrxToken): Promise<ProvenOrRawTx> 
    async dbBypassFks(disable: boolean): Promise<void> 
    dbTypeSubstring(source: string, fromOffset: number, forLength?: number) 
    override async getRawTxOfKnownValidTransaction(txid?: string, offset?: number, length?: number, trx?: TrxToken): Promise<number[] | undefined> 
    getProvenTxsForUserQuery(args: FindForUserSincePagedArgs): Knex.QueryBuilder 
    override async getProvenTxsForUser(args: FindForUserSincePagedArgs): Promise<TableProvenTx[]> 
    getProvenTxReqsForUserQuery(args: FindForUserSincePagedArgs): Knex.QueryBuilder 
    override async getProvenTxReqsForUser(args: FindForUserSincePagedArgs): Promise<TableProvenTxReq[]> 
    getTxLabelMapsForUserQuery(args: FindForUserSincePagedArgs): Knex.QueryBuilder 
    override async getTxLabelMapsForUser(args: FindForUserSincePagedArgs): Promise<TableTxLabelMap[]> 
    getOutputTagMapsForUserQuery(args: FindForUserSincePagedArgs): Knex.QueryBuilder 
    override async getOutputTagMapsForUser(args: FindForUserSincePagedArgs): Promise<TableOutputTagMap[]> 
    override async listActions(auth: AuthId, vargs: Validation.ValidListActionsArgs): Promise<ListActionsResult> 
    override async listOutputs(auth: AuthId, vargs: Validation.ValidListOutputsArgs): Promise<ListOutputsResult> 
    override async insertProvenTx(tx: TableProvenTx, trx?: TrxToken): Promise<number> 
    override async insertProvenTxReq(tx: TableProvenTxReq, trx?: TrxToken): Promise<number> 
    override async insertUser(user: TableUser, trx?: TrxToken): Promise<number> 
    override async insertCertificateAuth(auth: AuthId, certificate: TableCertificateX): Promise<number> 
    override async insertCertificate(certificate: TableCertificateX, trx?: TrxToken): Promise<number> 
    override async insertCertificateField(certificateField: TableCertificateField, trx?: TrxToken): Promise<void> 
    override async insertOutputBasket(basket: TableOutputBasket, trx?: TrxToken): Promise<number> 
    override async insertTransaction(tx: TableTransaction, trx?: TrxToken): Promise<number> 
    override async insertCommission(commission: TableCommission, trx?: TrxToken): Promise<number> 
    override async insertOutput(output: TableOutput, trx?: TrxToken): Promise<number> 
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
    async bulkUpdateOutputs(updates: Array<{
        id: number;
        update: Partial<TableOutput>;
    }>, trx?: TrxToken): Promise<number> 
    override async updateOutputTagMap(outputId: number, tagId: number, update: Partial<TableOutputTagMap>, trx?: TrxToken): Promise<number> 
    override async updateOutputTag(id: number, update: Partial<TableOutputTag>, trx?: TrxToken): Promise<number> 
    override async updateProvenTxReq(id: number | number[], update: Partial<TableProvenTxReq>, trx?: TrxToken): Promise<number> 
    override async updateProvenTx(id: number, update: Partial<TableProvenTx>, trx?: TrxToken): Promise<number> 
    override async updateSyncState(id: number, update: Partial<TableSyncState>, trx?: TrxToken): Promise<number> 
    override async updateTransaction(id: number | number[], update: Partial<TableTransaction>, trx?: TrxToken): Promise<number> 
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
    findProvenTxReqsQuery(args: FindProvenTxReqsArgs, tableName = "proven_tx_reqs"): Knex.QueryBuilder 
    findProvenTxsQuery(args: FindProvenTxsArgs, tableName = "proven_txs"): Knex.QueryBuilder 
    findStaleMerkleRootsQuery(args: FindStaleMerkleRootsArgs, tableName = "proven_txs"): Knex.QueryBuilder 
    findSyncStatesQuery(args: FindSyncStatesArgs): Knex.QueryBuilder 
    findTransactionsQuery(args: FindTransactionsArgs, count?: boolean): Knex.QueryBuilder 
    findTxLabelMapsQuery(args: FindTxLabelMapsArgs): Knex.QueryBuilder 
    findTxLabelsQuery(args: FindTxLabelsArgs): Knex.QueryBuilder 
    findUsersQuery(args: FindUsersArgs): Knex.QueryBuilder 
    findMonitorEventsQuery(args: FindMonitorEventsArgs): Knex.QueryBuilder 
    override async findCertificatesAuth(auth: AuthId, args: FindCertificatesArgs): Promise<TableCertificateX[]> 
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
    override async findLegacyTransactions(args: FindTransactionsArgs): Promise<TableTransaction[]> 
    override async updateLegacyTransaction(id: number | number[], update: Partial<TableTransaction>, trx?: TrxToken): Promise<number> 
    override async markOutputAsSpentBy(outputId: number, update: Partial<TableOutput>, trx?: TrxToken): Promise<void> 
    override async disableForeignKeys(): Promise<void> 
    override async enableForeignKeys(): Promise<void> 
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
    toDb(trx?: TrxToken) 
    async validateRawTransaction(t: TableTransaction, trx?: TrxToken): Promise<void> 
    _verifiedReadyForDatabaseAccess = false;
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
    override async findOutputsByIds(outputIds: number[], trx?: TrxToken): Promise<Record<number, TableOutput>> 
    override async findOutputsByOutpoints(userId: number, outpoints: Array<{
        txid: string;
        vout: number;
    }>, trx?: TrxToken): Promise<Record<string, TableOutput>> 
    override async findOrInsertOutputBasketsBulk(userId: number, names: string[], trx?: TrxToken): Promise<Record<string, TableOutputBasket>> 
    override async findOrInsertOutputTagsBulk(userId: number, tags: string[], trx?: TrxToken): Promise<Record<string, TableOutputTag>> 
    override async sumSpendableSatoshisInBasket(userId: number, basketId: number, excludeSending: boolean, trx?: TrxToken): Promise<number> 
    async allocateChangeInput(userId: number, basketId: number, targetSatoshis: number, exactSatoshis: number | undefined, excludeSending: boolean, transactionId: number): Promise<TableOutput | undefined> 
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
        const monitorStats: ServicesCallHistory | undefined = (monitorEvent != null) ? JSON.parse(monitorEvent.details!) : undefined;
        const servicesStats = this.getServices().getServicesCallHistory(true);
        const one_day_ago = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
        const one_week_ago = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
        const one_month_ago = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
        const [[{ usersDay, usersMonth, usersWeek, usersTotal, transactionsDay, transactionsMonth, transactionsWeek, transactionsTotal, txCompletedDay, txCompletedMonth, txCompletedWeek, txCompletedTotal, txFailedDay, txFailedMonth, txFailedWeek, txFailedTotal, txAbandonedDay, txAbandonedMonth, txAbandonedWeek, txAbandonedTotal, txUnprocessedDay, txUnprocessedMonth, txUnprocessedWeek, txUnprocessedTotal, txSendingDay, txSendingMonth, txSendingWeek, txSendingTotal, txUnprovenDay, txUnprovenMonth, txUnprovenWeek, txUnprovenTotal, txUnsignedDay, txUnsignedMonth, txUnsignedWeek, txUnsignedTotal, txNosendDay, txNosendMonth, txNosendWeek, txNosendTotal, txNonfinalDay, txNonfinalMonth, txNonfinalWeek, txNonfinalTotal, txUnfailDay, txUnfailMonth, txUnfailWeek, txUnfailTotal, satoshisDefaultDay, satoshisDefaultMonth, satoshisDefaultWeek, satoshisDefaultTotal, satoshisOtherDay, satoshisOtherMonth, satoshisOtherWeek, satoshisOtherTotal, basketsDay, basketsMonth, basketsWeek, basketsTotal, labelsDay, labelsMonth, labelsWeek, labelsTotal, tagsDay, tagsMonth, tagsWeek, tagsTotal }]] = await this.knex.raw(`
select
    (select count(*) from users where created_at > '${one_day_ago}') as usersDay,
    (select count(*) from users where created_at > '${one_week_ago}') as usersWeek,
    (select count(*) from users where created_at > '${one_month_ago}') as usersMonth,
	  (select count(*) from users) as usersTotal,
    (select count(*) from transactions where created_at > '${one_day_ago}') as transactionsDay,
    (select count(*) from transactions where created_at > '${one_week_ago}') as transactionsWeek,
    (select count(*) from transactions where created_at > '${one_month_ago}') as transactionsMonth,
	  (select count(*) from transactions) as transactionsTotal,
    (select count(*) from transactions where status = 'completed' and created_at > '${one_day_ago}') as txCompletedDay,
    (select count(*) from transactions where status = 'completed' and created_at > '${one_week_ago}') as txCompletedWeek,
    (select count(*) from transactions where status = 'completed' and created_at > '${one_month_ago}') as txCompletedMonth,
	  (select count(*) from transactions where status = 'completed') as txCompletedTotal,
    (select count(*) from transactions where status = 'failed' and not txid is null and created_at > '${one_day_ago}') as txFailedDay,
    (select count(*) from transactions where status = 'failed' and not txid is null and created_at > '${one_week_ago}') as txFailedWeek,
    (select count(*) from transactions where status = 'failed' and not txid is null and created_at > '${one_month_ago}') as txFailedMonth,
	  (select count(*) from transactions where status = 'failed' and not txid is null) as txFailedTotal,
    (select count(*) from transactions where status = 'failed' and txid is null and created_at > '${one_day_ago}') as txAbandonedDay,
    (select count(*) from transactions where status = 'failed' and txid is null and created_at > '${one_week_ago}') as txAbandonedWeek,
    (select count(*) from transactions where status = 'failed' and txid is null and created_at > '${one_month_ago}') as txAbandonedMonth,
	  (select count(*) from transactions where status = 'failed' and txid is null) as txAbandonedTotal,
    (select count(*) from transactions where status = 'unprocessed' and created_at > '${one_day_ago}') as txUnprocessedDay,
    (select count(*) from transactions where status = 'unprocessed' and created_at > '${one_week_ago}') as txUnprocessedWeek,
    (select count(*) from transactions where status = 'unprocessed' and created_at > '${one_month_ago}') as txUnprocessedMonth,
	  (select count(*) from transactions where status = 'unprocessed') as txUnprocessedTotal,
    (select count(*) from transactions where status = 'sending' and created_at > '${one_day_ago}') as txSendingDay,
    (select count(*) from transactions where status = 'sending' and created_at > '${one_week_ago}') as txSendingWeek,
    (select count(*) from transactions where status = 'sending' and created_at > '${one_month_ago}') as txSendingMonth,
	  (select count(*) from transactions where status = 'sending') as txSendingTotal,
    (select count(*) from transactions where status = 'unproven' and created_at > '${one_day_ago}') as txUnprovenDay,
    (select count(*) from transactions where status = 'unproven' and created_at > '${one_week_ago}') as txUnprovenWeek,
    (select count(*) from transactions where status = 'unproven' and created_at > '${one_month_ago}') as txUnprovenMonth,
	  (select count(*) from transactions where status = 'unproven') as txUnprovenTotal,
    (select count(*) from transactions where status = 'unsigned' and created_at > '${one_day_ago}') as txUnsignedDay,
    (select count(*) from transactions where status = 'unsigned' and created_at > '${one_week_ago}') as txUnsignedWeek,
    (select count(*) from transactions where status = 'unsigned' and created_at > '${one_month_ago}') as txUnsignedMonth,
	  (select count(*) from transactions where status = 'unsigned') as txUnsignedTotal,
    (select count(*) from transactions where status = 'nosend' and created_at > '${one_day_ago}') as txNosendDay,
    (select count(*) from transactions where status = 'nosend' and created_at > '${one_week_ago}') as txNosendWeek,
    (select count(*) from transactions where status = 'nosend' and created_at > '${one_month_ago}') as txNosendMonth,
	  (select count(*) from transactions where status = 'nosend') as txNosendTotal,
    (select count(*) from transactions where status = 'nonfinal' and created_at > '${one_day_ago}') as txNonfinalDay,
    (select count(*) from transactions where status = 'nonfinal' and created_at > '${one_week_ago}') as txNonfinalWeek,
    (select count(*) from transactions where status = 'nonfinal' and created_at > '${one_month_ago}') as txNonfinalMonth,
	  (select count(*) from transactions where status = 'nonfinal') as txNonfinalTotal,
    (select count(*) from transactions where status = 'unfail' and created_at > '${one_day_ago}') as txUnfailDay,
    (select count(*) from transactions where status = 'unfail' and created_at > '${one_week_ago}') as txUnfailWeek,
    (select count(*) from transactions where status = 'unfail' and created_at > '${one_month_ago}') as txUnfailMonth,
	  (select count(*) from transactions where status = 'unfail') as txUnfailTotal,
    (select sum(o.satoshis) from outputs o, transactions t where o.transactionId = t.transactionId and t.status = 'completed' and o.spendable = 1 and o.change = 1 and o.created_at > '${one_day_ago}') as satoshisDefaultDay,
    (select sum(o.satoshis) from outputs o, transactions t where o.transactionId = t.transactionId and t.status = 'completed' and o.spendable = 1 and o.change = 1 and o.created_at > '${one_week_ago}') as satoshisDefaultWeek,
    (select sum(o.satoshis) from outputs o, transactions t where o.transactionId = t.transactionId and t.status = 'completed' and o.spendable = 1 and o.change = 1 and o.created_at > '${one_month_ago}') as satoshisDefaultMonth,
	  (select sum(o.satoshis) from outputs o, transactions t where o.transactionId = t.transactionId and t.status = 'completed' and o.spendable = 1 and o.change = 1) as satoshisDefaultTotal,
    (select sum(o.satoshis) from outputs o, transactions t where o.transactionId = t.transactionId and t.status = 'completed' and o.spendable = 1 and o.change = 0 and not o.basketId is null and o.created_at > '${one_day_ago}') as satoshisOtherDay,
    (select sum(o.satoshis) from outputs o, transactions t where o.transactionId = t.transactionId and t.status = 'completed' and o.spendable = 1 and o.change = 0 and not o.basketId is null and o.created_at > '${one_week_ago}') as satoshisOtherWeek,
    (select sum(o.satoshis) from outputs o, transactions t where o.transactionId = t.transactionId and t.status = 'completed' and o.spendable = 1 and o.change = 0 and not o.basketId is null and o.created_at > '${one_month_ago}') as satoshisOtherMonth,
	  (select sum(o.satoshis) from outputs o, transactions t where o.transactionId = t.transactionId and t.status = 'completed' and o.spendable = 1 and o.change = 0 and not o.basketId is null) as satoshisOtherTotal,
    (select count(*) from output_baskets where created_at > '${one_day_ago}') as basketsDay,
    (select count(*) from output_baskets where created_at > '${one_week_ago}') as basketsWeek,
    (select count(*) from output_baskets where created_at > '${one_month_ago}') as basketsMonth,
	  (select count(*) from output_baskets) as basketsTotal,
    (select count(*) from tx_labels where created_at > '${one_day_ago}') as labelsDay,
    (select count(*) from tx_labels where created_at > '${one_week_ago}') as labelsWeek,
    (select count(*) from tx_labels where created_at > '${one_month_ago}') as labelsMonth,
	  (select count(*) from tx_labels) as labelsTotal,
    (select count(*) from output_tags where created_at > '${one_day_ago}') as tagsDay,
    (select count(*) from output_tags where created_at > '${one_week_ago}') as tagsWeek,
    (select count(*) from output_tags where created_at > '${one_month_ago}') as tagsMonth,
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

See also: [AdminStatsResult](./storage.md#interface-adminstatsresult), [AuthId](./client.md#interface-authid), [DBType](./storage.md#type-dbtype), [EntityTimeStamp](./client.md#interface-entitytimestamp), [FindCertificateFieldsArgs](./client.md#interface-findcertificatefieldsargs), [FindCertificatesArgs](./client.md#interface-findcertificatesargs), [FindCommissionsArgs](./client.md#interface-findcommissionsargs), [FindForUserSincePagedArgs](./client.md#interface-findforusersincepagedargs), [FindMonitorEventsArgs](./client.md#interface-findmonitoreventsargs), [FindOutputBasketsArgs](./client.md#interface-findoutputbasketsargs), [FindOutputTagMapsArgs](./client.md#interface-findoutputtagmapsargs), [FindOutputTagsArgs](./client.md#interface-findoutputtagsargs), [FindOutputsArgs](./client.md#interface-findoutputsargs), [FindPartialSincePagedArgs](./client.md#interface-findpartialsincepagedargs), [FindProvenTxReqsArgs](./client.md#interface-findproventxreqsargs), [FindProvenTxsArgs](./client.md#interface-findproventxsargs), [FindStaleMerkleRootsArgs](./client.md#interface-findstalemerklerootsargs), [FindSyncStatesArgs](./client.md#interface-findsyncstatesargs), [FindTransactionsArgs](./client.md#interface-findtransactionsargs), [FindTxLabelMapsArgs](./client.md#interface-findtxlabelmapsargs), [FindTxLabelsArgs](./client.md#interface-findtxlabelsargs), [FindUsersArgs](./client.md#interface-findusersargs), [ProvenOrRawTx](./client.md#interface-provenorrawtx), [PurgeParams](./client.md#interface-purgeparams), [PurgeResults](./client.md#interface-purgeresults), [ServicesCallHistory](./client.md#interface-servicescallhistory), [StorageKnexOptions](./storage.md#interface-storageknexoptions), [StorageProvider](./storage.md#class-storageprovider), [TableCertificate](./storage.md#interface-tablecertificate), [TableCertificateField](./storage.md#interface-tablecertificatefield), [TableCertificateX](./storage.md#interface-tablecertificatex), [TableCommission](./storage.md#interface-tablecommission), [TableMonitorEvent](./storage.md#interface-tablemonitorevent), [TableOutput](./storage.md#interface-tableoutput), [TableOutputBasket](./storage.md#interface-tableoutputbasket), [TableOutputTag](./storage.md#interface-tableoutputtag), [TableOutputTagMap](./storage.md#interface-tableoutputtagmap), [TableProvenTx](./storage.md#interface-tableproventx), [TableProvenTxReq](./storage.md#interface-tableproventxreq), [TableSettings](./storage.md#interface-tablesettings), [TableSyncState](./storage.md#interface-tablesyncstate), [TableTransaction](./storage.md#interface-tabletransaction), [TableTxLabel](./storage.md#interface-tabletxlabel), [TableTxLabelMap](./storage.md#interface-tabletxlabelmap), [TableUser](./storage.md#interface-tableuser), [TransactionService](./storage.md#class-transactionservice), [TrxToken](./client.md#interface-trxtoken), [WERR_NOT_IMPLEMENTED](./client.md#class-werr_not_implemented), [WalletStorageProvider](./client.md#interface-walletstorageprovider), [listActions](./storage.md#function-listactions), [listOutputs](./storage.md#function-listoutputs), [purgeData](./storage.md#function-purgedata), [reviewStatus](./storage.md#function-reviewstatus), [validateEntities](./storage.md#function-validateentities), [validateEntity](./storage.md#function-validateentity), [verifyOneOrNone](./client.md#function-verifyoneornone)

###### Method allocateChangeInput

Finds closest matching available change output to use as input for new transaction.

Transactionally allocate the output such that

```ts
async allocateChangeInput(userId: number, basketId: number, targetSatoshis: number, exactSatoshis: number | undefined, excludeSending: boolean, transactionId: number): Promise<TableOutput | undefined> 
```
See also: [TableOutput](./storage.md#interface-tableoutput)

###### Method bulkUpdateOutputs

Bulk-update many outputs in a single SQL statement (per shape group),
replacing N round-trips with at most a handful regardless of N.

Updates are grouped by the set of columns whose values are constant across
the group. Per-row columns become `CASE outputId WHEN id THEN value ... END`
expressions. Works on both SQLite and MySQL.

Falls back to per-row updates when the group is small enough that the CASE
overhead would dominate (currently: ≤ 2 rows).

```ts
async bulkUpdateOutputs(updates: Array<{
    id: number;
    update: Partial<TableOutput>;
}>, trx?: TrxToken): Promise<number> 
```
See also: [TableOutput](./storage.md#interface-tableoutput), [TrxToken](./client.md#interface-trxtoken)

###### Method countChangeInputs

Counts the outputs for userId in basketId that are spendable: true
AND whose transaction status is one of:
- completed
- unproven
- sending (if excludeSending is false)

```ts
async countChangeInputs(userId: number, basketId: number, excludeSending: boolean): Promise<number> 
```

###### Method dbBypassFks

Engine-agnostic FK bypass. SQLite uses `PRAGMA foreign_keys`, MySQL uses
`SET FOREIGN_KEY_CHECKS`, Postgres uses `SET session_replication_role`.
Callers pass `disable=true` to bypass FK checks, `false` to restore.

Note: PRAGMA / SET statements run on the underlying connection; on SQLite
they are no-ops inside an open transaction, so callers that need bypass
during a transaction must call this BEFORE opening it.

```ts
async dbBypassFks(disable: boolean): Promise<void> 
```

###### Method disableForeignKeys

Post-cutover bridge-period FK bypass. Called before opening a transaction
that contains bridge inserts (legacy-table rows whose FKs reference
renamed tables).

SQLite: PRAGMA foreign_keys=OFF on the bare connection (PRAGMA inside
a Knex transaction is a no-op on SQLite, so the call must precede the
`knex.transaction()`).
Postgres: session_replication_role=replica skips FK + trigger enforcement
for the duration of the connection's session.
MySQL: pre-cutover FK semantics already accommodate the bridge inserts
via the rebuild pattern; no-op here.

```ts
override async disableForeignKeys(): Promise<void> 
```

###### Method enableForeignKeys

Re-enable FK after the transaction opened via `disableForeignKeys()` completes.
Mirrors `disableForeignKeys` engine handling.

```ts
override async enableForeignKeys(): Promise<void> 
```

###### Method findLegacyTransactions

Post-cutover: queries `transactions_legacy` for unsigned/pending rows
created by `createAction` (which have no real txid yet and therefore have no
new-schema counterpart).  Falls back to the standard `findTransactions` pre-cutover.

Used by `processAction.validateCommitNewTxToStorageArgs` to locate the
unsigned transaction row by `{userId, reference}`.

Mapping §2: legacy `unsigned` / `unprocessed` → these rows only exist in
`transactions_legacy` post-cutover; new `transactions` has `processing` not
`status` and no unsigned-state rows.

```ts
override async findLegacyTransactions(args: FindTransactionsArgs): Promise<TableTransaction[]> 
```
See also: [FindTransactionsArgs](./client.md#interface-findtransactionsargs), [TableTransaction](./storage.md#interface-tabletransaction)

###### Method insertLegacyTransaction

Insert a legacy-shaped transaction row into the correct table:
- Post-cutover: `transactions_legacy` (the renamed legacy schema table)
- Pre-cutover:     `transactions` (the standard table, same behaviour as `insertTransaction`)

This allows `createAction` to store unsigned rows (txid unknown) without
conflicting with the new `transactions` table's NOT NULL txid constraint.
A new `transactions` row + `actions` row are created later by `processAction`
once the real txid is known.

On SQLite, foreign key enforcement is temporarily disabled while inserting
into `transactions_legacy` because the referenced `proven_txs` table was
renamed to `proven_txs_legacy` during the the schema cutover. Since `provenTxId`
is always NULL for new unsigned transactions this is semantically safe.

```ts
override async insertLegacyTransaction(tx: TableTransaction, trx?: TrxToken): Promise<number> 
```
See also: [TableTransaction](./storage.md#interface-tabletransaction), [TrxToken](./client.md#interface-trxtoken)

###### Method insertLegacyTxLabelMap

Insert a `tx_labels_map` row for a legacy transaction that does not yet
have a `actions.actionId`. On post-cutover SQLite, temporarily disables
FK checks so that the legacy transactionId (which is not yet an actionId)
can be written. processAction will repoint it via repointLabelsToActionId.

Note: bypasses `validateEntityForInsert` (and therefore `verifyReadyForDatabaseAccess`
which would re-enable FK checks) to ensure the PRAGMA=OFF persists across
the insert statement.

```ts
override async insertLegacyTxLabelMap(labelMap: TableTxLabelMap, trx?: TrxToken): Promise<void> 
```
See also: [TableTxLabelMap](./storage.md#interface-tabletxlabelmap), [TrxToken](./client.md#interface-trxtoken)

###### Method makeAvailable

Eagerly warm the `_postCutoverCache` so sync query builders such as
`findOutputsQuery` can branch on cutover state without an extra await.
Callers that have invoked `makeAvailable` are guaranteed the cache has
been populated.

```ts
override async makeAvailable(): Promise<TableSettings> 
```
See also: [TableSettings](./storage.md#interface-tablesettings)

###### Method markOutputAsSpentBy

Post-cutover SQLite: temporarily disable FK enforcement around the
`outputs.spentBy = legacyTransactionId` UPDATE. The `outputs.spentBy` FK
references `transactions.transactionId` after cutover, but unsigned
transactions from `createAction` live in `transactions_legacy` (their new-schema
counterpart is created later by `processAction`).

IMPORTANT: We bypass `updateOutput` (and therefore `verifyReadyForDatabaseAccess`)
because `verifyReadyForDatabaseAccess` always re-enables FK with
`PRAGMA foreign_keys = ON`, which would undo our bypass. Instead we
directly run the UPDATE via the raw knex handle.

Pre-cutover or MySQL: delegates to `updateOutput` unchanged.

Mapping §2: bridge-period spentBy references transactions_legacy during
createAction; FK bypass covers this until processAction wires the new-schema.

```ts
override async markOutputAsSpentBy(outputId: number, update: Partial<TableOutput>, trx?: TrxToken): Promise<void> 
```
See also: [TableOutput](./storage.md#interface-tableoutput), [TrxToken](./client.md#interface-trxtoken)

###### Method provenTxReqsTableName

Returns the canonical name of the `proven_tx_reqs` table —
`proven_tx_reqs_legacy` post-cutover, `proven_tx_reqs` otherwise.

Public so that helper modules (reviewStatus, purgeData) can resolve the
correct table name without duplicating the post-cutover detection logic.

```ts
async provenTxReqsTableName(): Promise<string> 
```

###### Method provenTxsTableName

Returns the canonical name of the `proven_txs` table — `proven_txs_legacy`
post-cutover, `proven_txs` otherwise.

Public so that helper modules (reviewStatus, purgeData) can resolve the
correct table name without duplicating the post-cutover detection logic.

```ts
async provenTxsTableName(): Promise<string> 
```

###### Method toDb

Convert the standard optional `TrxToken` parameter into either a direct knex database instance,
or a Knex.Transaction as appropriate.

```ts
toDb(trx?: TrxToken) 
```
See also: [TrxToken](./client.md#interface-trxtoken)

###### Method updateLegacyTransaction

Post-cutover: updates `transactions_legacy` (where unsigned rows live).
Pre-cutover: delegates to `updateTransaction`.

Used by `processAction.commitNewTxToStorage` to write back the real txid
and status to the legacy row that was created by `createAction`.

Mapping §2: legacy `unsigned` → `unprocessed` transition and txid write-back
must go to `transactions_legacy` post-cutover, not new `transactions`.

```ts
override async updateLegacyTransaction(id: number | number[], update: Partial<TableTransaction>, trx?: TrxToken): Promise<number> 
```
See also: [TableTransaction](./storage.md#interface-tabletransaction), [TrxToken](./client.md#interface-trxtoken)

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
    static defaultOptions() 
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
    abstract getProvenOrRawTx(txid: string, trx?: TrxToken): Promise<ProvenOrRawTx>;
    abstract getRawTxOfKnownValidTransaction(txid?: string, offset?: number, length?: number, trx?: TrxToken): Promise<number[] | undefined>;
    abstract getLabelsForTransactionId(transactionId?: number, trx?: TrxToken): Promise<TableTxLabel[]>;
    abstract getTagsForOutputId(outputId: number, trx?: TrxToken): Promise<TableOutputTag[]>;
    abstract listActions(auth: AuthId, args: Validation.ValidListActionsArgs): Promise<ListActionsResult>;
    abstract listOutputs(auth: AuthId, args: Validation.ValidListOutputsArgs): Promise<ListOutputsResult>;
    abstract countChangeInputs(userId: number, basketId: number, excludeSending: boolean): Promise<number>;
    async findOutputsByIds(outputIds: number[], trx?: TrxToken): Promise<Record<number, TableOutput>> 
    async findStaleMerkleRoots(args: FindStaleMerkleRootsArgs): Promise<string[]> 
    async findOutputsByOutpoints(userId: number, outpoints: Array<{
        txid: string;
        vout: number;
    }>, trx?: TrxToken): Promise<Record<string, TableOutput>> 
    async findOrInsertOutputBasketsBulk(userId: number, names: string[], trx?: TrxToken): Promise<Record<string, TableOutputBasket>> 
    async findOrInsertOutputTagsBulk(userId: number, tags: string[], trx?: TrxToken): Promise<Record<string, TableOutputTag>> 
    async sumSpendableSatoshisInBasket(userId: number, basketId: number, excludeSending: boolean, trx?: TrxToken): Promise<number> 
    abstract findCertificatesAuth(auth: AuthId, args: FindCertificatesArgs): Promise<TableCertificateX[]>;
    abstract findOutputBasketsAuth(auth: AuthId, args: FindOutputBasketsArgs): Promise<TableOutputBasket[]>;
    abstract findOutputsAuth(auth: AuthId, args: FindOutputsArgs): Promise<TableOutput[]>;
    abstract insertCertificateAuth(auth: AuthId, certificate: TableCertificateX): Promise<number>;
    abstract adminStats(adminIdentityKey: string): Promise<AdminStatsResult>;
    async recentlyActiveUsers(limit = 50, trx?: TrxToken): Promise<TableUser[]> 
    override isStorageProvider(): boolean 
    setServices(v: WalletServices) 
    getServices(): WalletServices 
    getTransactionService(): TransactionService | undefined 
    async insertLegacyTransaction(tx: TableTransaction, trx?: TrxToken): Promise<number> 
    async insertLegacyTxLabelMap(labelMap: TableTxLabelMap, trx?: TrxToken): Promise<void> 
    async findOrInsertLegacyTxLabelMap(transactionId: number, txLabelId: number, trx?: TrxToken): Promise<TableTxLabelMap> 
    async findLegacyTransactions(args: FindTransactionsArgs): Promise<TableTransaction[]> 
    async updateLegacyTransaction(id: number | number[], update: Partial<TableTransaction>, trx?: TrxToken): Promise<number> 
    async markOutputAsSpentBy(outputId: number, update: Partial<TableOutput>, trx?: TrxToken): Promise<void> 
    async disableForeignKeys(): Promise<void> 
    async enableForeignKeys(): Promise<void> 
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
    async getValidBeefForTxid(txid: string, mergeToBeef?: Beef, trustSelf?: TrustSelf, knownTxids?: string[], trx?: TrxToken, requiredLevels?: number, chainTracker?: ChainTracker, skipInvalidProofs?: boolean): Promise<Beef | undefined> 
    async getBeefForTransaction(txid: string, options: StorageGetBeefOptions): Promise<Beef> 
    async findMonitorEventById(id: number, trx?: TrxToken): Promise<TableMonitorEvent | undefined> 
    async relinquishCertificate(auth: AuthId, args: RelinquishCertificateArgs): Promise<number> 
    async relinquishOutput(auth: AuthId, args: RelinquishOutputArgs): Promise<number> 
    async processSyncChunk(args: RequestSyncChunkArgs, chunk: SyncChunk): Promise<ProcessSyncChunkResult> 
    async updateProvenTxReqWithNewProvenTx(args: UpdateProvenTxReqWithNewProvenTxArgs): Promise<UpdateProvenTxReqWithNewProvenTxResult> 
    async confirmSpendableOutputs(): Promise<{
        invalidSpendableOutputs: TableOutput[];
    }> 
    async updateProvenTxReqDynamics(id: number, update: Partial<TableProvenTxReqDynamics>, trx?: TrxToken): Promise<number> 
    async extendOutput(o: TableOutput, includeBasket = false, includeTags = false, trx?: TrxToken): Promise<TableOutputX> 
    async validateOutputScript(o: TableOutput, trx?: TrxToken): Promise<void> 
}
```

See also: [AdminStatsResult](./storage.md#interface-adminstatsresult), [AuthId](./client.md#interface-authid), [Chain](./client.md#type-chain), [EntityProvenTxReq](./storage.md#class-entityproventxreq), [FindCertificatesArgs](./client.md#interface-findcertificatesargs), [FindOutputBasketsArgs](./client.md#interface-findoutputbasketsargs), [FindOutputsArgs](./client.md#interface-findoutputsargs), [FindStaleMerkleRootsArgs](./client.md#interface-findstalemerklerootsargs), [FindTransactionsArgs](./client.md#interface-findtransactionsargs), [GetReqsAndBeefResult](./storage.md#interface-getreqsandbeefresult), [PostReqsToNetworkResult](./storage.md#interface-postreqstonetworkresult), [ProcessSyncChunkResult](./client.md#interface-processsyncchunkresult), [ProvenOrRawTx](./client.md#interface-provenorrawtx), [PurgeParams](./client.md#interface-purgeparams), [PurgeResults](./client.md#interface-purgeresults), [RequestSyncChunkArgs](./client.md#interface-requestsyncchunkargs), [StorageCreateActionResult](./client.md#interface-storagecreateactionresult), [StorageFeeModel](./client.md#interface-storagefeemodel), [StorageGetBeefOptions](./client.md#interface-storagegetbeefoptions), [StorageInternalizeActionResult](./client.md#interface-storageinternalizeactionresult), [StorageProcessActionArgs](./client.md#interface-storageprocessactionargs), [StorageProcessActionResults](./client.md#interface-storageprocessactionresults), [StorageProvenOrReq](./client.md#interface-storageprovenorreq), [StorageProviderOptions](./storage.md#interface-storageprovideroptions), [StorageReaderWriter](./storage.md#class-storagereaderwriter), [SyncChunk](./client.md#interface-syncchunk), [TableCertificateX](./storage.md#interface-tablecertificatex), [TableMonitorEvent](./storage.md#interface-tablemonitorevent), [TableOutput](./storage.md#interface-tableoutput), [TableOutputBasket](./storage.md#interface-tableoutputbasket), [TableOutputTag](./storage.md#interface-tableoutputtag), [TableOutputX](./storage.md#interface-tableoutputx), [TableProvenTxReq](./storage.md#interface-tableproventxreq), [TableProvenTxReqDynamics](./storage.md#interface-tableproventxreqdynamics), [TableTransaction](./storage.md#interface-tabletransaction), [TableTxLabel](./storage.md#interface-tabletxlabel), [TableTxLabelMap](./storage.md#interface-tabletxlabelmap), [TableUser](./storage.md#interface-tableuser), [TransactionService](./storage.md#class-transactionservice), [TransactionStatus](./client.md#type-transactionstatus), [TrxToken](./client.md#interface-trxtoken), [UpdateProvenTxReqWithNewProvenTxArgs](./client.md#interface-updateproventxreqwithnewproventxargs), [UpdateProvenTxReqWithNewProvenTxResult](./client.md#interface-updateproventxreqwithnewproventxresult), [WalletServices](./client.md#interface-walletservices), [WalletStorageProvider](./client.md#interface-walletstorageprovider), [attemptToPostReqsToNetwork](./storage.md#function-attempttopostreqstonetwork), [createAction](./storage.md#function-createaction), [getBeefForTransaction](./storage.md#function-getbeeffortransaction), [internalizeAction](./storage.md#function-internalizeaction), [listActions](./storage.md#function-listactions), [listCertificates](./storage.md#function-listcertificates), [listOutputs](./storage.md#function-listoutputs), [logger](./client.md#variable-logger), [processAction](./storage.md#function-processaction), [purgeData](./storage.md#function-purgedata), [reviewStatus](./storage.md#function-reviewstatus)

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

###### Method disableForeignKeys

Disable FK enforcement on the underlying database connection.

No-op on non-SQLite or pre-cutover databases. On post-cutover SQLite,
`StorageKnex` overrides this to run `PRAGMA foreign_keys = OFF` on the
bare knex connection BEFORE a transaction is opened (since PRAGMA changes
inside SQLite transactions are silently ignored).

Must be paired with a `enableForeignKeys()` call in a finally block.

```ts
async disableForeignKeys(): Promise<void> 
```

###### Method enableForeignKeys

Re-enable FK enforcement on the underlying database connection.
Counterpart to `disableForeignKeys()`.

```ts
async enableForeignKeys(): Promise<void> 
```

###### Method findLegacyTransactions

Find legacy-shaped transaction rows from the appropriate table.

Post-cutover: queries `transactions_legacy` (the renamed legacy schema
table that holds unsigned/unprocessed rows without a real txid).
Pre-cutover (or on providers that do not support the the new schema): falls back
to the standard `findTransactions` which targets the `transactions` table.

Used by `processAction.validateCommitNewTxToStorageArgs` to locate the
unsigned transaction row created by `createAction` via `insertLegacyTransaction`.

StorageKnex overrides this to route to `transactions_legacy` when the
table exists (post-cutover), otherwise falls through to `findTransactions`.

```ts
async findLegacyTransactions(args: FindTransactionsArgs): Promise<TableTransaction[]> 
```
See also: [FindTransactionsArgs](./client.md#interface-findtransactionsargs), [TableTransaction](./storage.md#interface-tabletransaction)

###### Method findOrInsertLegacyTxLabelMap

Find-or-insert a `tx_labels_map` row using `insertLegacyTxLabelMap` so
that post-cutover FK constraints are bypassed for new unsigned transactions.

Mirrors the logic of `findOrInsertTxLabelMap` (StorageReaderWriter) but
delegates the insert step to `insertLegacyTxLabelMap`.

```ts
async findOrInsertLegacyTxLabelMap(transactionId: number, txLabelId: number, trx?: TrxToken): Promise<TableTxLabelMap> 
```
See also: [TableTxLabelMap](./storage.md#interface-tabletxlabelmap), [TrxToken](./client.md#interface-trxtoken)

###### Method getReqsAndBeefToShareWithWorld

Given an array of transaction txids with current ProvenTxReq ready-to-share status,
lookup their ProvenTxReqApi req records.
For the txids with reqs and status still ready to send construct a single merged beef.

```ts
async getReqsAndBeefToShareWithWorld(txids: string[], knownTxids: string[], trx?: TrxToken): Promise<GetReqsAndBeefResult> 
```
See also: [GetReqsAndBeefResult](./storage.md#interface-getreqsandbeefresult), [TrxToken](./client.md#interface-trxtoken)

###### Method getTransactionService

Returns a TransactionService instance if this storage provider supports
the the new schema (i.e. has a Knex handle). Returns undefined for providers
that do not support the new schema layer (e.g. StorageIdb).

StorageKnex overrides this to return `new TransactionService(this.knex)`.

```ts
getTransactionService(): TransactionService | undefined 
```
See also: [TransactionService](./storage.md#class-transactionservice)

###### Method getValidBeefForKnownTxid

Pulls data from storage to build a valid beef for a txid.

Optionally merges the data into an existing beef.
Optionally requires a minimum number of proof levels.

```ts
async getValidBeefForKnownTxid(txid: string, mergeToBeef?: Beef, trustSelf?: TrustSelf, knownTxids?: string[], trx?: TrxToken, requiredLevels?: number): Promise<Beef> 
```
See also: [TrxToken](./client.md#interface-trxtoken)

###### Method insertLegacyTransaction

Insert a legacy-shaped transaction row.

Post-cutover: writes into `transactions_legacy` (the renamed legacy table)
so that `createAction` can still store unsigned rows before the real txid is
known, without touching the new `transactions` table (which requires a non-null txid).

Pre-cutover (or on providers that do not support the the new schema): falls back
to the standard `insertTransaction` which targets the `transactions` table.

StorageKnex overrides this to route to `transactions_legacy` when the table
exists, otherwise falls through to the standard `transactions` insert.

```ts
async insertLegacyTransaction(tx: TableTransaction, trx?: TrxToken): Promise<number> 
```
See also: [TableTransaction](./storage.md#interface-tabletransaction), [TrxToken](./client.md#interface-trxtoken)

###### Method insertLegacyTxLabelMap

Insert a `tx_labels_map` row for a legacy transaction that does not yet
have a `actions.actionId`.

Post-cutover the `tx_labels_map.transactionId` column has a FK to
`actions.actionId`. When `createAction` writes labels against a legacy
transactionId (before processAction creates the actions row), the FK
cannot be satisfied. This shim bypasses that constraint temporarily.
`processAction` later rewrites the rows to the real actionId via
`TransactionService.repointLabelsToActionId`.

Pre-cutover: delegates to `insertTxLabelMap` with no FK bypass needed.

StorageKnex overrides this to temporarily disable FK checks on SQLite
when `transactions_legacy` is present (indicating post-cutover).

```ts
async insertLegacyTxLabelMap(labelMap: TableTxLabelMap, trx?: TrxToken): Promise<void> 
```
See also: [TableTxLabelMap](./storage.md#interface-tabletxlabelmap), [TrxToken](./client.md#interface-trxtoken)

###### Method markOutputAsSpentBy

Mark an output as spent by a (potentially legacy) transaction.

Post-cutover on SQLite: setting `outputs.spentBy = legacyTransactionId`
violates the FK `outputs.spentBy → transactions.transactionId` because
unsigned transactions created by `createAction` live in `transactions_legacy`.
This method disables the FK constraint for the duration of the update.
The constraint will be satisfied once `processAction` creates the new schema row and
the bridge-period is complete.

Pre-cutover: delegates to `updateOutput` with no FK bypass.

StorageKnex overrides this to toggle `PRAGMA foreign_keys` around the UPDATE
when `isPostCutover()` and the dbtype is `SQLite`.

Mapping §2: bridge-period `outputs.spentBy` temporarily references
`transactions_legacy.transactionId` during `createAction`; new-schema FK is bypassed.

```ts
async markOutputAsSpentBy(outputId: number, update: Partial<TableOutput>, trx?: TrxToken): Promise<void> 
```
See also: [TableOutput](./storage.md#interface-tableoutput), [TrxToken](./client.md#interface-trxtoken)

###### Method updateLegacyTransaction

Update a legacy-shaped transaction row in the appropriate table.

Post-cutover: updates `transactions_legacy` (where unsigned rows live).
Pre-cutover: delegates to the standard `updateTransaction`.

Used by `processAction.commitNewTxToStorage` to write back the final txid
and status to the legacy row that was created by `createAction`.

StorageKnex overrides this to route to `transactions_legacy` when the
table exists (post-cutover), otherwise falls through to `updateTransaction`.

```ts
async updateLegacyTransaction(id: number | number[], update: Partial<TableTransaction>, trx?: TrxToken): Promise<number> 
```
See also: [TableTransaction](./storage.md#interface-tabletransaction), [TrxToken](./client.md#interface-trxtoken)

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
async updateProvenTxReqWithNewProvenTx(args: UpdateProvenTxReqWithNewProvenTxArgs): Promise<UpdateProvenTxReqWithNewProvenTxResult> 
```
See also: [UpdateProvenTxReqWithNewProvenTxArgs](./client.md#interface-updateproventxreqwithnewproventxargs), [UpdateProvenTxReqWithNewProvenTxResult](./client.md#interface-updateproventxreqwithnewproventxresult)

###### Method updateTransactionStatus

For all `status` values besides 'failed', just updates the transaction records status property.

For 'status' of 'failed', attempts to make outputs previously allocated as inputs to this transaction usable again.

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
    async findUserByIdentityKey(key: string): Promise<TableUser | undefined> 
    async getSyncChunk(args: sdk.RequestSyncChunkArgs): Promise<sdk.SyncChunk> 
    validateEntityDate(date: Date | string | number): Date | string 
    validateOptionalEntityDate(date: Date | string | number | null | undefined, useNowAsDefault?: boolean): Date | string | undefined 
    validateDate(date: Date | string | number): Date 
    validateOptionalDate(date: Date | string | number | null | undefined): Date | undefined 
    validateDateForWhere(date: Date | string | number): Date | string | number 
}
```

See also: [Chain](./client.md#type-chain), [DBType](./storage.md#type-dbtype), [FindCertificateFieldsArgs](./client.md#interface-findcertificatefieldsargs), [FindCertificatesArgs](./client.md#interface-findcertificatesargs), [FindCommissionsArgs](./client.md#interface-findcommissionsargs), [FindForUserSincePagedArgs](./client.md#interface-findforusersincepagedargs), [FindMonitorEventsArgs](./client.md#interface-findmonitoreventsargs), [FindOutputBasketsArgs](./client.md#interface-findoutputbasketsargs), [FindOutputTagsArgs](./client.md#interface-findoutputtagsargs), [FindOutputsArgs](./client.md#interface-findoutputsargs), [FindSyncStatesArgs](./client.md#interface-findsyncstatesargs), [FindTransactionsArgs](./client.md#interface-findtransactionsargs), [FindTxLabelsArgs](./client.md#interface-findtxlabelsargs), [FindUsersArgs](./client.md#interface-findusersargs), [RequestSyncChunkArgs](./client.md#interface-requestsyncchunkargs), [StorageReaderOptions](./storage.md#interface-storagereaderoptions), [SyncChunk](./client.md#interface-syncchunk), [TableCertificateField](./storage.md#interface-tablecertificatefield), [TableCertificateX](./storage.md#interface-tablecertificatex), [TableCommission](./storage.md#interface-tablecommission), [TableMonitorEvent](./storage.md#interface-tablemonitorevent), [TableOutput](./storage.md#interface-tableoutput), [TableOutputBasket](./storage.md#interface-tableoutputbasket), [TableOutputTag](./storage.md#interface-tableoutputtag), [TableOutputTagMap](./storage.md#interface-tableoutputtagmap), [TableProvenTx](./storage.md#interface-tableproventx), [TableProvenTxReq](./storage.md#interface-tableproventxreq), [TableSettings](./storage.md#interface-tablesettings), [TableSyncState](./storage.md#interface-tablesyncstate), [TableTransaction](./storage.md#interface-tabletransaction), [TableTxLabel](./storage.md#interface-tabletxlabel), [TableTxLabelMap](./storage.md#interface-tabletxlabelmap), [TableUser](./storage.md#interface-tableuser), [TrxToken](./client.md#interface-trxtoken), [WalletStorageSyncReader](./client.md#interface-walletstoragesyncreader), [getSyncChunk](./storage.md#function-getsyncchunk), [validateDate](./storage.md#function-validatedate)

###### Method validateEntityDate

Force dates to strings on SQLite and Date objects on MySQL

```ts
validateEntityDate(date: Date | string | number): Date | string 
```

###### Method validateOptionalEntityDate

```ts
validateOptionalEntityDate(date: Date | string | number | null | undefined, useNowAsDefault?: boolean): Date | string | undefined 
```

Argument Details

+ **useNowAsDefault**
  + if true and date is null or undefiend, set to current time.

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Class: StorageReaderWriter

```ts
export abstract class StorageReaderWriter extends StorageReader {
    constructor(options: StorageReaderWriterOptions) 
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

See also: [AuthId](./client.md#interface-authid), [FindOutputTagMapsArgs](./client.md#interface-findoutputtagmapsargs), [FindProvenTxReqsArgs](./client.md#interface-findproventxreqsargs), [FindProvenTxsArgs](./client.md#interface-findproventxsargs), [FindStaleMerkleRootsArgs](./client.md#interface-findstalemerklerootsargs), [FindTxLabelMapsArgs](./client.md#interface-findtxlabelmapsargs), [ProcessSyncChunkResult](./client.md#interface-processsyncchunkresult), [RequestSyncChunkArgs](./client.md#interface-requestsyncchunkargs), [StorageReader](./storage.md#class-storagereader), [StorageReaderWriterOptions](./storage.md#interface-storagereaderwriteroptions), [SyncChunk](./client.md#interface-syncchunk), [TableCertificate](./storage.md#interface-tablecertificate), [TableCertificateField](./storage.md#interface-tablecertificatefield), [TableCommission](./storage.md#interface-tablecommission), [TableMonitorEvent](./storage.md#interface-tablemonitorevent), [TableOutput](./storage.md#interface-tableoutput), [TableOutputBasket](./storage.md#interface-tableoutputbasket), [TableOutputTag](./storage.md#interface-tableoutputtag), [TableOutputTagMap](./storage.md#interface-tableoutputtagmap), [TableProvenTx](./storage.md#interface-tableproventx), [TableProvenTxReq](./storage.md#interface-tableproventxreq), [TableSyncState](./storage.md#interface-tablesyncstate), [TableTransaction](./storage.md#interface-tabletransaction), [TableTxLabel](./storage.md#interface-tabletxlabel), [TableTxLabelMap](./storage.md#interface-tabletxlabelmap), [TableUser](./storage.md#interface-tableuser), [TrxToken](./client.md#interface-trxtoken)

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
##### Class: TransactionService

```ts
export class TransactionService {
    constructor(private readonly knex: Knex) 
    async findByTxid(txid: string): Promise<TableTransactionNew | undefined> 
    async findById(transactionId: number): Promise<TableTransactionNew | undefined> 
    async create(args: {
        txid: string;
        processing?: sdk.ProcessingStatus;
        rawTx?: number[];
        inputBeef?: number[];
        batch?: string;
        idempotencyKey?: string;
        isCoinbase?: boolean;
        now?: Date;
    }): Promise<TableTransactionNew> 
    async transition(args: {
        transactionId: number;
        expectedFrom: sdk.ProcessingStatus;
        to: sdk.ProcessingStatus;
        provider?: string;
        providerStatus?: string;
        details?: Record<string, unknown>;
        now?: Date;
    }): Promise<TableTransactionNew | undefined> 
    async recordProof(args: {
        transactionId: number;
        height: number;
        merklePath: number[];
        merkleRoot: string;
        blockHash: string;
        expectedFrom: sdk.ProcessingStatus;
        now?: Date;
    }): Promise<TableTransactionNew | undefined> 
    async findActionForUser(userId: number, transactionId: number): Promise<TableAction | undefined> 
    async createAction(args: {
        userId: number;
        transactionId: number;
        reference: string;
        description: string;
        isOutgoing: boolean;
        satoshisDelta: number;
        userNosend?: boolean;
        notifyJson?: string;
        now?: Date;
    }): Promise<number> 
    async getChainTip(): Promise<{
        height: number;
        blockHash: string;
    } | undefined> 
    async setChainTip(args: {
        height: number;
        blockHash: string;
        merkleRoot?: string;
        now?: Date;
    }): Promise<void> 
    async tryClaimLease(claim: MonitorLeaseClaim, now?: Date): Promise<MonitorLeaseResult> 
    async renewLease(renew: MonitorLeaseRenew, now?: Date): Promise<MonitorLeaseResult> 
    async releaseLease(release: MonitorLeaseRelease): Promise<boolean> 
    async findActionByReference(userId: number, reference: string): Promise<{
        action: TableAction;
        transaction: TableTransactionNew;
    } | undefined> 
    async findActionByUserTxid(userId: number, txid: string): Promise<{
        action: TableAction;
        transaction: TableTransactionNew;
    } | undefined> 
    async findOrCreateActionForTxid(args: {
        userId: number;
        txid: string;
        isOutgoing: boolean;
        description: string;
        satoshisDelta: number;
        reference: string;
        rawTx?: number[];
        inputBeef?: number[];
        processing?: sdk.ProcessingStatus;
        now?: Date;
    }): Promise<{
        action: TableAction;
        transaction: TableTransactionNew;
        isNew: boolean;
    }> 
    async updateActionSatoshisDelta(actionId: number, delta: number, now?: Date): Promise<void> 
    async createWithProof(args: {
        txid: string;
        rawTx?: number[];
        inputBeef?: number[];
        height: number;
        merklePath: number[];
        merkleRoot: string;
        blockHash: string;
        isCoinbase?: boolean;
        now?: Date;
    }): Promise<TableTransactionNew> 
    async findOrCreateForBroadcast(args: {
        txid: string;
        rawTx: number[];
        inputBeef?: number[];
        batch?: string;
        processing?: sdk.ProcessingStatus;
        now?: Date;
    }): Promise<{
        transaction: TableTransactionNew;
        isNew: boolean;
    }> 
    async transitionMany(args: {
        transactionIds: number[];
        expectedFrom?: sdk.ProcessingStatus;
        to: sdk.ProcessingStatus;
        provider?: string;
        providerStatus?: string;
        details?: Record<string, unknown>;
        now?: Date;
    }): Promise<{
        updated: number[];
        skipped: number[];
    }> 
    async setBatch(transactionIds: number[], batch: string | undefined, now?: Date): Promise<void> 
    async incrementAttempts(transactionId: number, now?: Date): Promise<TableTransactionNew | undefined> 
    async recordBroadcastResult(args: {
        transactionId: number;
        txid: string;
        status: sdk.ProcessingStatus;
        provider: string;
        providerStatus?: string;
        wasBroadcast?: boolean;
        details?: Record<string, unknown>;
        now?: Date;
    }): Promise<TableTransactionNew | undefined> 
    async recordHistoryNote(transactionId: number, note: {
        what: string;
        [k: string]: unknown;
    }, now?: Date): Promise<void> 
    async mergeBeefForTxids(beef: Beef, txids: string[]): Promise<void> 
    async collectReqsAndBeef(txids: string[], extraTxids?: string[]): Promise<{
        beef: Beef;
        details: Array<{
            txid: string;
            status: "readyToSend" | "alreadySent" | "error" | "unknown";
            reason?: string;
        }>;
    }> 
    async listActionsForUser(args: {
        userId: number;
        statusFilter?: sdk.ProcessingStatus[];
        labelIds?: number[];
        labelQueryMode?: "all" | "any";
        createdAtFrom?: Date;
        createdAtTo?: Date;
        limit: number;
        offset: number;
    }): Promise<{
        rows: Array<TableAction & {
            txid: string;
            processing: sdk.ProcessingStatus;
            height?: number;
        }>;
        total?: number;
    }> 
    async listOutputsForUser(args: {
        userId: number;
        basketId?: number;
        tagIds?: number[];
        tagQueryMode?: "all" | "any";
        processingFilter: sdk.ProcessingStatus[];
        includeSpent: boolean;
        limit: number;
        offset: number;
        includeLockingScripts?: boolean;
    }): Promise<{
        rows: Array<TableOutput & {
            processing: sdk.ProcessingStatus;
        }>;
        total?: number;
    }> 
    async repointLabelsToActionId(legacyTransactionId: number, actionId: number, now?: Date): Promise<void> 
    async repointOutputsToNewTransactionId(legacyTransactionId: number, newTransactionId: number, now?: Date): Promise<void> 
}
```

See also: [MonitorLeaseClaim](./monitor.md#interface-monitorleaseclaim), [MonitorLeaseRelease](./monitor.md#interface-monitorleaserelease), [MonitorLeaseRenew](./monitor.md#interface-monitorleaserenew), [MonitorLeaseResult](./monitor.md#interface-monitorleaseresult), [ProcessingStatus](./client.md#type-processingstatus), [TableAction](./storage.md#interface-tableaction), [TableOutput](./storage.md#interface-tableoutput), [TableTransactionNew](./storage.md#interface-tabletransactionnew), [blockHash](./services.md#function-blockhash), [createAction](./storage.md#function-createaction), [getChainTip](./storage.md#function-getchaintip), [releaseLease](./monitor.md#function-releaselease), [renewLease](./monitor.md#function-renewlease), [setChainTip](./storage.md#function-setchaintip), [tryClaimLease](./monitor.md#function-tryclaimlease)

###### Method collectReqsAndBeef

#13 — Collect broadcast-readiness info and a populated Beef for a list of
txids. Each entry is classified as:
 - `readyToSend`  — queued/sending → still needs broadcast
 - `alreadySent`  — sent/seen/seen_multi/unconfirmed/confirmed → already on network
 - `error`        — invalid/doubleSpend → terminal failure
 - `unknown`      — not found in new-schema

```ts
async collectReqsAndBeef(txids: string[], extraTxids?: string[]): Promise<{
    beef: Beef;
    details: Array<{
        txid: string;
        status: "readyToSend" | "alreadySent" | "error" | "unknown";
        reason?: string;
    }>;
}> 
```

###### Method create

Insert a new new transaction row. The row is created in `queued` state
unless the caller overrides `processing`.

```ts
async create(args: {
    txid: string;
    processing?: sdk.ProcessingStatus;
    rawTx?: number[];
    inputBeef?: number[];
    batch?: string;
    idempotencyKey?: string;
    isCoinbase?: boolean;
    now?: Date;
}): Promise<TableTransactionNew> 
```
See also: [ProcessingStatus](./client.md#type-processingstatus), [TableTransactionNew](./storage.md#interface-tabletransactionnew)

###### Method createWithProof

#5 — Create a new transaction row already in `confirmed` state with all proof
columns populated. Useful for internalised transactions that arrive with a
Merkle proof (bump) already attached.

```ts
async createWithProof(args: {
    txid: string;
    rawTx?: number[];
    inputBeef?: number[];
    height: number;
    merklePath: number[];
    merkleRoot: string;
    blockHash: string;
    isCoinbase?: boolean;
    now?: Date;
}): Promise<TableTransactionNew> 
```
See also: [TableTransactionNew](./storage.md#interface-tabletransactionnew), [blockHash](./services.md#function-blockhash)

###### Method findActionByReference

#1 — Look up an action + its backing transaction by (userId, reference).

```ts
async findActionByReference(userId: number, reference: string): Promise<{
    action: TableAction;
    transaction: TableTransactionNew;
} | undefined> 
```
See also: [TableAction](./storage.md#interface-tableaction), [TableTransactionNew](./storage.md#interface-tabletransactionnew)

###### Method findActionByUserTxid

#2 — Look up an action + its backing transaction by (userId, txid).

```ts
async findActionByUserTxid(userId: number, txid: string): Promise<{
    action: TableAction;
    transaction: TableTransactionNew;
} | undefined> 
```
See also: [TableAction](./storage.md#interface-tableaction), [TableTransactionNew](./storage.md#interface-tabletransactionnew)

###### Method findOrCreateActionForTxid

#3 — Upsert: find existing action for (userId, txid) or create both the new
transaction row and the action row.

```ts
async findOrCreateActionForTxid(args: {
    userId: number;
    txid: string;
    isOutgoing: boolean;
    description: string;
    satoshisDelta: number;
    reference: string;
    rawTx?: number[];
    inputBeef?: number[];
    processing?: sdk.ProcessingStatus;
    now?: Date;
}): Promise<{
    action: TableAction;
    transaction: TableTransactionNew;
    isNew: boolean;
}> 
```
See also: [ProcessingStatus](./client.md#type-processingstatus), [TableAction](./storage.md#interface-tableaction), [TableTransactionNew](./storage.md#interface-tabletransactionnew)

###### Method findOrCreateForBroadcast

#6 — Find an existing new transaction row for the given txid (suitable for
the broadcast queue) or create a new one in `queued` state.

```ts
async findOrCreateForBroadcast(args: {
    txid: string;
    rawTx: number[];
    inputBeef?: number[];
    batch?: string;
    processing?: sdk.ProcessingStatus;
    now?: Date;
}): Promise<{
    transaction: TableTransactionNew;
    isNew: boolean;
}> 
```
See also: [ProcessingStatus](./client.md#type-processingstatus), [TableTransactionNew](./storage.md#interface-tabletransactionnew)

###### Method incrementAttempts

#9 — Atomically increment the `attempts` counter for one transaction and
write an `attempts.incremented` audit entry.

```ts
async incrementAttempts(transactionId: number, now?: Date): Promise<TableTransactionNew | undefined> 
```
See also: [TableTransactionNew](./storage.md#interface-tabletransactionnew)

###### Method listActionsForUser

#14 — Paginated list of actions (per-user transaction views) with optional
status and label filters.

After the the schema cutover `tx_labels_map.transactionId` references `actions.actionId`
(not `transactions.transactionId`).

```ts
async listActionsForUser(args: {
    userId: number;
    statusFilter?: sdk.ProcessingStatus[];
    labelIds?: number[];
    labelQueryMode?: "all" | "any";
    createdAtFrom?: Date;
    createdAtTo?: Date;
    limit: number;
    offset: number;
}): Promise<{
    rows: Array<TableAction & {
        txid: string;
        processing: sdk.ProcessingStatus;
        height?: number;
    }>;
    total?: number;
}> 
```
See also: [ProcessingStatus](./client.md#type-processingstatus), [TableAction](./storage.md#interface-tableaction)

###### Method listOutputsForUser

#15 — Paginated list of outputs with their backing transaction processing
state. Optional filters: basket, tag set, processing state, spent flag.

```ts
async listOutputsForUser(args: {
    userId: number;
    basketId?: number;
    tagIds?: number[];
    tagQueryMode?: "all" | "any";
    processingFilter: sdk.ProcessingStatus[];
    includeSpent: boolean;
    limit: number;
    offset: number;
    includeLockingScripts?: boolean;
}): Promise<{
    rows: Array<TableOutput & {
        processing: sdk.ProcessingStatus;
    }>;
    total?: number;
}> 
```
See also: [ProcessingStatus](./client.md#type-processingstatus), [TableOutput](./storage.md#interface-tableoutput)

###### Method mergeBeefForTxids

#12 — For each txid that exists in the new transactions table, merge the
raw transaction bytes and (where available) the Merkle path into `beef`.
Txids not present in new-schema are silently skipped.

```ts
async mergeBeefForTxids(beef: Beef, txids: string[]): Promise<void> 
```

###### Method recordBroadcastResult

#10 — Record the outcome of a broadcast attempt. Transitions processing
state, updates `wasBroadcast` and `lastProvider*` columns, and writes an
audit row.

```ts
async recordBroadcastResult(args: {
    transactionId: number;
    txid: string;
    status: sdk.ProcessingStatus;
    provider: string;
    providerStatus?: string;
    wasBroadcast?: boolean;
    details?: Record<string, unknown>;
    now?: Date;
}): Promise<TableTransactionNew | undefined> 
```
See also: [ProcessingStatus](./client.md#type-processingstatus), [TableTransactionNew](./storage.md#interface-tabletransactionnew)

###### Method recordHistoryNote

#11 — Append a free-form history note to the audit log for a transaction.

```ts
async recordHistoryNote(transactionId: number, note: {
    what: string;
    [k: string]: unknown;
}, now?: Date): Promise<void> 
```

###### Method recordProof

Record acquisition of a Merkle proof for a transaction. Atomically:
 - Updates proof columns (height, index, merkle_path, merkle_root, block_hash)
 - Transitions processing to `confirmed` from any spendable-class state.
 - Writes a `proof.acquired` audit row.

The merkle leaf index is derived from `merklePath` (BUMP) using the row's
`txid`; callers do not pass it.

```ts
async recordProof(args: {
    transactionId: number;
    height: number;
    merklePath: number[];
    merkleRoot: string;
    blockHash: string;
    expectedFrom: sdk.ProcessingStatus;
    now?: Date;
}): Promise<TableTransactionNew | undefined> 
```
See also: [ProcessingStatus](./client.md#type-processingstatus), [TableTransactionNew](./storage.md#interface-tabletransactionnew), [blockHash](./services.md#function-blockhash)

###### Method repointLabelsToActionId

Post-cutover helper: rewrite `tx_labels_map.transactionId` rows that were
written with the legacy transactionId (before the real txid + actionId were
known) so that they now point at the new-schema `actions.actionId`.

Call this once per new outgoing transaction immediately after
`findOrCreateActionForTxid` resolves the actionId.

This is a no-op when:
 - `legacyTransactionId` has no rows in `tx_labels_map` (no labels on the tx)
 - `legacyTransactionId === actionId` (should not happen in practice but
   is safe to call anyway)

```ts
async repointLabelsToActionId(legacyTransactionId: number, actionId: number, now?: Date): Promise<void> 
```

###### Method repointOutputsToNewTransactionId

After `processAction` creates the new `transactions` row, remap
`outputs.transactionId` and `outputs.spentBy` from the bridge-period
`transactions_legacy.transactionId` to the real `transactions.transactionId`.

During `createAction`, new outputs are inserted with `transactionId =
legacyTransactionId` (bypassing FK constraints). `listActionsKnex` queries
outputs by new transactionId, so without this remap the outputs would be
invisible to `listActions`.

This is a no-op when `legacyTransactionId === newTransactionId`.

```ts
async repointOutputsToNewTransactionId(legacyTransactionId: number, newTransactionId: number, now?: Date): Promise<void> 
```

###### Method setBatch

#8 — Bulk-set the `batch` column for a list of transaction ids.
Pass `undefined` to clear the batch tag.

```ts
async setBatch(transactionIds: number[], batch: string | undefined, now?: Date): Promise<void> 
```

###### Method transition

Transition processing state with optimistic concurrency. Returns
`undefined` when the FSM rejects the move OR the row's current state no
longer matches `expectedFrom`.

```ts
async transition(args: {
    transactionId: number;
    expectedFrom: sdk.ProcessingStatus;
    to: sdk.ProcessingStatus;
    provider?: string;
    providerStatus?: string;
    details?: Record<string, unknown>;
    now?: Date;
}): Promise<TableTransactionNew | undefined> 
```
See also: [ProcessingStatus](./client.md#type-processingstatus), [TableTransactionNew](./storage.md#interface-tabletransactionnew)

###### Method transitionMany

#7 — Bulk transition: attempt `transition` for each id; collect results.
When `expectedFrom` is omitted the current state of each row is used as
the expected source (lenient mode — only the FSM is checked).

```ts
async transitionMany(args: {
    transactionIds: number[];
    expectedFrom?: sdk.ProcessingStatus;
    to: sdk.ProcessingStatus;
    provider?: string;
    providerStatus?: string;
    details?: Record<string, unknown>;
    now?: Date;
}): Promise<{
    updated: number[];
    skipped: number[];
}> 
```
See also: [ProcessingStatus](./client.md#type-processingstatus)

###### Method updateActionSatoshisDelta

#4 — Atomically update the satoshisDelta column on an action row.

```ts
async updateActionSatoshisDelta(actionId: number, delta: number, now?: Date): Promise<void> 
```

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
    _isAvailable = false;
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
    isActiveStorageProvider(): boolean 
    async addWalletStorageProvider(provider: sdk.WalletStorageProvider): Promise<void> 
    setServices(v: sdk.WalletServices) 
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
    async syncFromReader(identityKey: string, reader: sdk.WalletStorageSyncReader, activeSync?: sdk.WalletStorageSync, log = ""): Promise<{
        inserts: number;
        updates: number;
        log: string;
    }> 
    async syncToWriter(auth: sdk.AuthId, writer: sdk.WalletStorageProvider, activeSync?: sdk.WalletStorageSync, log = "", progLog?: (s: string) => string): Promise<{
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

See also: [AuthId](./client.md#interface-authid), [FindCertificatesArgs](./client.md#interface-findcertificatesargs), [FindOutputBasketsArgs](./client.md#interface-findoutputbasketsargs), [FindOutputsArgs](./client.md#interface-findoutputsargs), [FindProvenTxReqsArgs](./client.md#interface-findproventxreqsargs), [ReproveHeaderResult](./client.md#interface-reproveheaderresult), [ReproveProvenResult](./client.md#interface-reproveprovenresult), [StorageCreateActionResult](./client.md#interface-storagecreateactionresult), [StorageInternalizeActionResult](./client.md#interface-storageinternalizeactionresult), [StorageProcessActionArgs](./client.md#interface-storageprocessactionargs), [StorageProcessActionResults](./client.md#interface-storageprocessactionresults), [StorageProvider](./storage.md#class-storageprovider), [TableCertificate](./storage.md#interface-tablecertificate), [TableCertificateX](./storage.md#interface-tablecertificatex), [TableOutput](./storage.md#interface-tableoutput), [TableOutputBasket](./storage.md#interface-tableoutputbasket), [TableProvenTx](./storage.md#interface-tableproventx), [TableProvenTxReq](./storage.md#interface-tableproventxreq), [TableSettings](./storage.md#interface-tablesettings), [TableUser](./storage.md#interface-tableuser), [WalletServices](./client.md#interface-walletservices), [WalletStorage](./client.md#interface-walletstorage), [WalletStorageInfo](./client.md#interface-walletstorageinfo), [WalletStorageProvider](./client.md#interface-walletstorageprovider), [WalletStorageReader](./client.md#interface-walletstoragereader), [WalletStorageSync](./client.md#interface-walletstoragesync), [WalletStorageSyncReader](./client.md#interface-walletstoragesyncreader), [WalletStorageWriter](./client.md#interface-walletstoragewriter), [createAction](./storage.md#function-createaction), [internalizeAction](./storage.md#function-internalizeaction), [listActions](./storage.md#function-listactions), [listCertificates](./storage.md#function-listcertificates), [listOutputs](./storage.md#function-listoutputs), [processAction](./storage.md#function-processaction)

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
_isAvailable = false
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
| [appendTxAudit](#function-appendtxaudit) | [markStaleInputsAsSpent](#function-markstaleinputsasspent) | [transactionOutputSize](#function-transactionoutputsize) |
| [attemptToPostReqsToNetwork](#function-attempttopostreqstonetwork) | [matchesCertificateFieldPartial](#function-matchescertificatefieldpartial) | [transactionSize](#function-transactionsize) |
| [auditProcessingTransition](#function-auditprocessingtransition) | [matchesCertificatePartial](#function-matchescertificatepartial) | [transitionProcessing](#function-transitionprocessing) |
| [classifyReqStatus](#function-classifyreqstatus) | [matchesCommissionPartial](#function-matchescommissionpartial) | [tryClaimLease](#function-tryclaimlease) |
| [createAction](#function-createaction) | [matchesMonitorEventPartial](#function-matchesmonitoreventpartial) | [updateReqsFromAggregateResults](#function-updatereqsfromaggregateresults) |
| [createStorageServiceChargeScript](#function-createstorageservicechargescript) | [matchesOutputBasketPartial](#function-matchesoutputbasketpartial) | [upgradeActions](#function-upgradeactions) |
| [createSyncMap](#function-createsyncmap) | [matchesOutputPartial](#function-matchesoutputpartial) | [upgradeAllStoresV1](#function-upgradeallstoresv1) |
| [dateMatches](#function-datematches) | [matchesOutputTagMapPartial](#function-matchesoutputtagmappartial) | [upgradeCertificateFields](#function-upgradecertificatefields) |
| [determineDBType](#function-determinedbtype) | [matchesOutputTagPartial](#function-matchesoutputtagpartial) | [upgradeCertificates](#function-upgradecertificates) |
| [findAction](#function-findaction) | [matchesProvenTxPartial](#function-matchesproventxpartial) | [upgradeChainTip](#function-upgradechaintip) |
| [findTransactionNew](#function-findtransactionnew) | [matchesProvenTxReqPartial](#function-matchesproventxreqpartial) | [upgradeCommissions](#function-upgradecommissions) |
| [findTransactionNewByTxid](#function-findtransactionnewbytxid) | [matchesSyncStatePartial](#function-matchessyncstatepartial) | [upgradeMonitorEvents](#function-upgrademonitorevents) |
| [generateChangeSdk](#function-generatechangesdk) | [matchesTransactionPartial](#function-matchestransactionpartial) | [upgradeMonitorLease](#function-upgrademonitorlease) |
| [generateChangeSdkMakeStorage](#function-generatechangesdkmakestorage) | [matchesTxLabelMapPartial](#function-matchestxlabelmappartial) | [upgradeOutputBaskets](#function-upgradeoutputbaskets) |
| [getBeefForTransaction](#function-getbeeffortransaction) | [matchesTxLabelPartial](#function-matchestxlabelpartial) | [upgradeOutputTags](#function-upgradeoutputtags) |
| [getChainTip](#function-getchaintip) | [mergeInputBeefs](#function-mergeinputbeefs) | [upgradeOutputTagsMap](#function-upgradeoutputtagsmap) |
| [getListOutputsSpecOp](#function-getlistoutputsspecop) | [mergeInputsIntoBeef](#function-mergeinputsintobeef) | [upgradeOutputs](#function-upgradeoutputs) |
| [getSyncChunk](#function-getsyncchunk) | [notifyTransactionsOfProof](#function-notifytransactionsofproof) | [upgradeProvenTxReqs](#function-upgradeproventxreqs) |
| [indexFromMerklePath](#function-indexfrommerklepath) | [offsetPrivKey](#function-offsetprivkey) | [upgradeProvenTxs](#function-upgradeproventxs) |
| [insertAction](#function-insertaction) | [offsetPubKey](#function-offsetpubkey) | [upgradeSyncStates](#function-upgradesyncstates) |
| [insertTransactionNew](#function-inserttransactionnew) | [partitionActionLabels](#function-partitionactionlabels) | [upgradeTransactions](#function-upgradetransactions) |
| [internalizeAction](#function-internalizeaction) | [processAction](#function-processaction) | [upgradeTransactionsNew](#function-upgradetransactionsnew) |
| [isProcessingSpendable](#function-isprocessingspendable) | [processingTransitionMap](#function-processingtransitionmap) | [upgradeTxAudit](#function-upgradetxaudit) |
| [isProcessingTerminal](#function-isprocessingterminal) | [purgeData](#function-purgedata) | [upgradeTxLabels](#function-upgradetxlabels) |
| [isValidProcessingTransition](#function-isvalidprocessingtransition) | [purgeDataIdb](#function-purgedataidb) | [upgradeTxLabelsMap](#function-upgradetxlabelsmap) |
| [keyOffsetToHashedSecret](#function-keyoffsettohashedsecret) | [redeemServiceCharges](#function-redeemservicecharges) | [upgradeUsers](#function-upgradeusers) |
| [listActions](#function-listactions) | [releaseLease](#function-releaselease) | [validateDate](#function-validatedate) |
| [listActionsIdb](#function-listactionsidb) | [renderAdminPage](#function-renderadminpage) | [validateEntities](#function-validateentities) |
| [listAuditForTransaction](#function-listauditfortransaction) | [renewLease](#function-renewlease) | [validateEntity](#function-validateentity) |
| [listCertificates](#function-listcertificates) | [reviewStatus](#function-reviewstatus) | [validateGenerateChangeSdkParams](#function-validategeneratechangesdkparams) |
| [listOutputs](#function-listoutputs) | [reviewStatusIdb](#function-reviewstatusidb) | [validateGenerateChangeSdkResult](#function-validategeneratechangesdkresult) |
| [listOutputsIdb](#function-listoutputsidb) | [setChainTip](#function-setchaintip) | [validateProcessingTransition](#function-validateprocessingtransition) |
| [lockScriptWithKeyOffsetFromPubKey](#function-lockscriptwithkeyoffsetfrompubkey) | [setDisableDoubleSpendCheckForTest](#function-setdisabledoublespendcheckfortest) | [validateStorageFeeModel](#function-validatestoragefeemodel) |
| [mapActionRow](#function-mapactionrow) | [shareReqsWithWorld](#function-sharereqswithworld) | [validateSyncChunkEntities](#function-validatesyncchunkentities) |
| [mapTransactionRow](#function-maptransactionrow) | [transactionInputSize](#function-transactioninputsize) | [varUintSize](#function-varuintsize) |

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---

##### Function: appendTxAudit

```ts
export async function appendTxAudit(knex: Knex, ev: AuditEvent, now: Date = new Date()): Promise<number> 
```

See also: [AuditEvent](./storage.md#interface-auditevent)

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
##### Function: auditProcessingTransition

Convenience helper for processing transitions. Validates the move first;
on rejection it still records the attempt with `event = 'processing.rejected'`
so the audit trail captures impossible transitions for later diagnosis.

Returns `true` when the transition is legal (audit row written with
`processing.changed`) and `false` when rejected (audit row written with
`processing.rejected`).

```ts
export async function auditProcessingTransition(knex: Knex, transactionId: number, from: sdk.ProcessingStatus, to: sdk.ProcessingStatus, details?: Record<string, unknown>, now: Date = new Date()): Promise<boolean> 
```

See also: [ProcessingStatus](./client.md#type-processingstatus)

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
##### Function: createAction

```ts
export async function createAction(storage: StorageProvider, auth: AuthId, vargs: Validation.ValidCreateActionArgs, originator?: OriginatorDomainNameStringUnder250Bytes): Promise<StorageCreateActionResult> 
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
##### Function: determineDBType

```ts
export async function determineDBType(knex: Knex<any, any[]>): Promise<DBType> 
```

See also: [DBType](./storage.md#type-dbtype)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: findAction

Find an action row by `(userId, transactionId)`.

```ts
export async function findAction(knex: Knex, userId: number, transactionId: number): Promise<TableAction | undefined> 
```

See also: [TableAction](./storage.md#interface-tableaction)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: findTransactionNew

Read a single `transactions` (new canonical) row by PK.

```ts
export async function findTransactionNew(knex: Knex, transactionId: number): Promise<TableTransactionNew | undefined> 
```

See also: [TableTransactionNew](./storage.md#interface-tabletransactionnew)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: findTransactionNewByTxid

Read a single `transactions` (new canonical) row by txid, returning `undefined` if absent.

```ts
export async function findTransactionNewByTxid(knex: Knex, txid: string): Promise<TableTransactionNew | undefined> 
```

See also: [TableTransactionNew](./storage.md#interface-tabletransactionnew)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: generateChangeSdk

Simplifications:
 - only support one change type with fixed length scripts.
 - only support satsPerKb fee model.

Confirms for each availbleChange output that it remains available as they are allocated and selects alternate if not.

```ts
export async function generateChangeSdk(params: GenerateChangeSdkParams, allocateChangeInput: (targetSatoshis: number, exactSatoshis?: number) => Promise<GenerateChangeSdkChangeInput | undefined>, releaseChangeInput: (outputId: number) => Promise<void>, logger?: WalletLoggerInterface): Promise<GenerateChangeSdkResult> 
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
##### Function: getChainTip

Get the singleton chain tip row (`id = 1`).

```ts
export async function getChainTip(knex: Knex): Promise<TableChainTip | undefined> 
```

See also: [TableChainTip](./storage.md#interface-tablechaintip)

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
##### Function: indexFromMerklePath

High-level service over the new-schema storage primitives.

Storage methods and the Monitor call into this surface rather than the
lower-level CRUD/FSM/audit/lease modules so that:
 - Every processing transition is audited.
 - Optimistic concurrency is uniformly enforced.
 - Chain tip + monitor lease access have one canonical entry point.

Construction takes a Knex handle; instances are stateless and cheap to
create — typically one per request or per Monitor task tick.

Extract the merkle leaf index for `txid` from a BUMP-encoded merkle path.

The BUMP format encodes level 0 leaves with `txid: true` and an `offset`
equal to the position of the transaction in its block. For a single-tx
proof exactly one leaf is flagged; for trimmed compound proofs the leaf
matching `txid` is selected.

```ts
export function indexFromMerklePath(merklePath: number[], txid: string): number 
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: insertAction

```ts
export async function insertAction(knex: Knex, row: Omit<TableAction, "actionId" | "created_at" | "updated_at">, now: Date = new Date()): Promise<number> 
```

See also: [TableAction](./storage.md#interface-tableaction)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: insertTransactionNew

Insert a new `transactions` (new canonical) row. Caller supplies the full body.

```ts
export async function insertTransactionNew(knex: Knex, row: Omit<TableTransactionNew, "transactionId" | "created_at" | "updated_at">, now: Date = new Date()): Promise<number> 
```

See also: [TableTransactionNew](./storage.md#interface-tabletransactionnew)

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
The existing transaction must be in the 'unproven' or 'completed' status. Any other status is an error.

When the transaction already exists, the description is updated. The isOutgoing sense is not changed.

"basket insertion" Merge Rules:
1. The "default" basket may not be specified as the insertion basket.
2. A change output in the "default" basket may not be target of an insertion into a different basket.
3. These baskets do not affect the wallet's balance and are typed "custom".

"wallet payment" Merge Rules:
1. Targetting an existing change "default" basket output results in a no-op. No error. No alterations made.
2. Targetting a previously "custom" non-change output converts it into a change output. This alters the transaction's `satoshis`, and the wallet balance.

```ts
export async function internalizeAction(storage: StorageProvider, auth: AuthId, args: InternalizeActionArgs): Promise<StorageInternalizeActionResult> 
```

See also: [AuthId](./client.md#interface-authid), [StorageInternalizeActionResult](./client.md#interface-storageinternalizeactionresult), [StorageProvider](./storage.md#class-storageprovider)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: isProcessingSpendable

True when the given state implies the transaction has been seen / accepted
by at least one network provider — the precondition for output spendability
in §4.

```ts
export function isProcessingSpendable(s: sdk.ProcessingStatus): boolean 
```

See also: [ProcessingStatus](./client.md#type-processingstatus)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: isProcessingTerminal

True when the state is terminal (no further automatic transitions).

```ts
export function isProcessingTerminal(s: sdk.ProcessingStatus): boolean 
```

See also: [ProcessingStatus](./client.md#type-processingstatus)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: isValidProcessingTransition

Returns true when `from -> to` is a permitted processing transition.
Identity transitions (`from === to`) are always allowed — they represent a
status refresh without state change.

```ts
export function isValidProcessingTransition(from: sdk.ProcessingStatus, to: sdk.ProcessingStatus): boolean 
```

See also: [ProcessingStatus](./client.md#type-processingstatus)

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
##### Function: listAuditForTransaction

Read all audit rows for a transaction, oldest first. Useful for tests.

```ts
export async function listAuditForTransaction(knex: Knex, transactionId: number): Promise<TableTxAudit[]> 
```

See also: [TableTxAudit](./storage.md#interface-tabletxaudit)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: listCertificates

```ts
export async function listCertificates(storage: StorageProvider, auth: AuthId, vargs: Validation.ValidListCertificatesArgs, originator?: OriginatorDomainNameStringUnder250Bytes): Promise<ListCertificatesResult> 
```

See also: [AuthId](./client.md#interface-authid), [StorageProvider](./storage.md#class-storageprovider)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: listOutputs

```ts
export async function listOutputs(dsk: StorageKnex, auth: AuthId, vargs: Validation.ValidListOutputsArgs, originator?: OriginatorDomainNameStringUnder250Bytes): Promise<ListOutputsResult> 
```

See also: [AuthId](./client.md#interface-authid), [StorageKnex](./storage.md#class-storageknex)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: listOutputsIdb

```ts
export async function listOutputsIdb(storage: StorageIdb, auth: AuthId, vargs: Validation.ValidListOutputsArgs, originator?: OriginatorDomainNameStringUnder250Bytes): Promise<ListOutputsResult> 
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
##### Function: mapActionRow

```ts
export function mapActionRow(row: any): TableAction 
```

See also: [TableAction](./storage.md#interface-tableaction)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: mapTransactionRow

```ts
export function mapTransactionRow(row: any): TableTransactionNew 
```

See also: [TableTransactionNew](./storage.md#interface-tabletransactionnew)

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
##### Function: notifyTransactionsOfProof

Notify each transaction that a proof has been found.
Mutates `req` history notes in place.

The `addNote` and `flushNotes` callbacks avoid coupling this helper to a
specific entity type.

```ts
export async function notifyTransactionsOfProof(ids: number[], provenTxId: number, addNote: (note: ReqHistoryNote) => void, flushNotes: () => Promise<void>, updateTransaction: (id: number, update: {
    provenTxId: number;
    status: "completed";
}) => Promise<unknown>): Promise<void> 
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
##### Function: processAction

```ts
export async function processAction(storage: StorageProvider, auth: AuthId, args: StorageProcessActionArgs): Promise<StorageProcessActionResults> 
```

See also: [AuthId](./client.md#interface-authid), [StorageProcessActionArgs](./client.md#interface-storageprocessactionargs), [StorageProcessActionResults](./client.md#interface-storageprocessactionresults), [StorageProvider](./storage.md#class-storageprovider)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: processingTransitionMap

Snapshot of the transition table for documentation + tests.

```ts
export function processingTransitionMap(): Readonly<Record<sdk.ProcessingStatus, readonly sdk.ProcessingStatus[]>> 
```

See also: [ProcessingStatus](./client.md#type-processingstatus)

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
export async function purgeDataIdb(storage: StorageIdb, params: PurgeParams, trx?: TrxToken): Promise<PurgeResults> 
```

See also: [PurgeParams](./client.md#interface-purgeparams), [PurgeResults](./client.md#interface-purgeresults), [StorageIdb](./storage.md#class-storageidb), [TrxToken](./client.md#interface-trxtoken)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: redeemServiceCharges

```ts
export function redeemServiceCharges(privateKeyWif: string, charges: TableCommission[]): Array<{}> 
```

See also: [TableCommission](./storage.md#interface-tablecommission)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: releaseLease

Release the lease (no-op when not owned by the caller).
The row is deleted so subsequent claimants do not see an inherited
`renew_count`.

```ts
export async function releaseLease(knex: Knex, release: MonitorLeaseRelease): Promise<boolean> 
```

See also: [MonitorLeaseRelease](./monitor.md#interface-monitorleaserelease)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: renderAdminPage

```ts
export function renderAdminPage(): string 
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: renewLease

Extend the current owner's lease. Fails (returns `acquired: false`) when the
row does not exist, is owned by someone else, or has already expired.

```ts
export async function renewLease(knex: Knex, renew: MonitorLeaseRenew, now: Date = new Date()): Promise<MonitorLeaseResult> 
```

See also: [MonitorLeaseRenew](./monitor.md#interface-monitorleaserenew), [MonitorLeaseResult](./monitor.md#interface-monitorleaseresult)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: reviewStatus

Looks for unpropagated state:

1. set transactions to 'failed' if not already failed and provenTxReq with matching txid has status of 'invalid'.
2. sets outputs to spendable true, spentBy undefined if spentBy is a transaction with status 'failed'.
3. sets transactions to 'completed' if provenTx with matching txid exists and current provenTxId is null.

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
2. sets transactions to 'completed' if provenTx with matching txid exists and current provenTxId is null.
3. sets outputs to spendable true, spentBy undefined if spentBy is a transaction with status 'failed'.

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
##### Function: setChainTip

Upsert the singleton chain tip. Always uses `id = 1`.

```ts
export async function setChainTip(knex: Knex, args: {
    height: number;
    blockHash: string;
    merkleRoot?: string;
}, now: Date = new Date()): Promise<void> 
```

See also: [blockHash](./services.md#function-blockhash)

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
##### Function: transitionProcessing

Transition the processing column atomically and append a `tx_audit` row.
Returns the new `TableTransactionNew` on success and `undefined` when the
source state did not match the row (CAS failed) or the transition was
rejected by the FSM.

Optimistic concurrency: the caller passes the `expectedFromState` they
read in the same logical operation; the update only fires when the row's
current `processing` still equals that value.

```ts
export async function transitionProcessing(knex: Knex, args: {
    transactionId: number;
    expectedFromState: sdk.ProcessingStatus;
    toState: sdk.ProcessingStatus;
    details?: Record<string, unknown>;
    provider?: string;
    providerStatus?: string;
}, now: Date = new Date()): Promise<TableTransactionNew | undefined> 
```

See also: [ProcessingStatus](./client.md#type-processingstatus), [TableTransactionNew](./storage.md#interface-tabletransactionnew)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: tryClaimLease

Try to claim a lease on `taskName`. Succeeds iff:
  - no row exists for the task, OR
  - the existing row has `expiresAt <= now`, OR
  - the existing row's `ownerId` already equals the requested owner.

On success the row is upserted with `expiresAt = now + ttlMs` and
`renewCount = renewCount + 1` (0 for fresh rows).

```ts
export async function tryClaimLease(knex: Knex, claim: MonitorLeaseClaim, now: Date = new Date()): Promise<MonitorLeaseResult> 
```

See also: [MonitorLeaseClaim](./monitor.md#interface-monitorleaseclaim), [MonitorLeaseResult](./monitor.md#interface-monitorleaseresult)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: updateReqsFromAggregateResults

For each txid in submitted `txids`:

  Based on its aggregate status, and whether broadcast happening in background (isDelayed) or immediately (!isDelayed),
  and iff current req.status is not 'unproven' or 'completed':

    'success':
      req.status => 'unmined', tx.status => 'unproven'
    'doubleSpend':
      req.status => 'doubleSpend', tx.status => 'failed'
    'invalidTx':
      req.status => 'invalid', tx.status => 'failed'
    'serviceError':
      increment req.attempts

```ts
export async function updateReqsFromAggregateResults(txids: string[], r: PostReqsToNetworkResult, apbrs: Record<string, AggregatePostBeefTxResult>, storage: StorageProvider, services?: sdk.WalletServices, trx?: sdk.TrxToken, logger?: WalletLoggerInterface): Promise<void> 
```

See also: [AggregatePostBeefTxResult](./storage.md#interface-aggregatepostbeeftxresult), [PostReqsToNetworkResult](./storage.md#interface-postreqstonetworkresult), [StorageProvider](./storage.md#class-storageprovider), [TrxToken](./client.md#interface-trxtoken), [WalletServices](./client.md#interface-walletservices), [logger](./client.md#variable-logger)

Argument Details

+ **services**
  + if valid, doubleSpend results will be verified (but only if not within a trx. e.g. trx must be undefined)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: upgradeActions

```ts
export function upgradeActions(db: IDBPDatabase<StorageIdbSchema>): void 
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
##### Function: upgradeChainTip

```ts
export function upgradeChainTip(db: IDBPDatabase<StorageIdbSchema>): void 
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
##### Function: upgradeMonitorEvents

```ts
export function upgradeMonitorEvents(db: IDBPDatabase<StorageIdbSchema>): void 
```

See also: [StorageIdbSchema](./storage.md#interface-storageidbschema)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: upgradeMonitorLease

```ts
export function upgradeMonitorLease(db: IDBPDatabase<StorageIdbSchema>): void 
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
##### Function: upgradeTransactionsNew

```ts
export function upgradeTransactionsNew(db: IDBPDatabase<StorageIdbSchema>): void 
```

See also: [StorageIdbSchema](./storage.md#interface-storageidbschema)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: upgradeTxAudit

```ts
export function upgradeTxAudit(db: IDBPDatabase<StorageIdbSchema>): void 
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
##### Function: validateProcessingTransition

As `isValidProcessingTransition` but returns a structured result with a
human-readable reason for any rejection. Useful for `tx_audit` payloads.

```ts
export function validateProcessingTransition(from: sdk.ProcessingStatus, to: sdk.ProcessingStatus): FsmTransitionResult 
```

See also: [FsmTransitionResult](./storage.md#interface-fsmtransitionresult), [ProcessingStatus](./client.md#type-processingstatus)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Function: validateStorageFeeModel

```ts
export function validateStorageFeeModel(v?: StorageFeeModel): StorageFeeModel 
```

See also: [StorageFeeModel](./client.md#interface-storagefeemodel)

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

| |
| --- |
| [DBType](#type-dbtype) |
| [EntityStorage](#type-entitystorage) |
| [PostReqsToNetworkDetailsStatus](#type-postreqstonetworkdetailsstatus) |

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---

##### Type: DBType

```ts
export type DBType = "SQLite" | "MySQL" | "Postgres" | "IndexedDB"
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
#### Variables

| |
| --- |
| [getLabelToSpecOp](#variable-getlabeltospecop) |
| [maxChangeOutputsPerTransaction](#variable-maxchangeoutputspertransaction) |
| [maxPossibleSatoshis](#variable-maxpossiblesatoshis) |
| [outputColumnsWithoutLockingScript](#variable-outputcolumnswithoutlockingscript) |
| [transactionColumnsWithoutRawTx](#variable-transactioncolumnswithoutrawtx) |

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
                if (specOpLabels.includes("abort")) {
                    for (const tx of txs) {
                        if (tx.status === "nosend") {
                            await s.abortAction(auth, { reference: tx.reference! });
                            tx.status = "failed";
                        }
                    }
                }
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
    "txid"
]
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---

<!--#endregion ts2md-api-merged-here-->