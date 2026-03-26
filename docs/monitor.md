# MONITOR: BSV Wallet Toolbox API Documentation

The documentation is split into various pages, this page covers the [Monitor](#class-monitor) and related API.

To function properly, a wallet must be able to perform a number of house keeping tasks:

1. Ensure transactions are sent to the network without slowing application flow or when created while offline.
1. Obtain and merge proofs when transactions are mined.
1. Detect and propagate transactions that fail due to double-spend, reorgs, or other reasons.

These tasks are the responsibility of the [Monitor](#class-monitor) class.

[Return To Top](./README.md)

<!--#region ts2md-api-merged-here-->
### API

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

#### Interfaces

| |
| --- |
| [DeactivedHeader](#interface-deactivedheader) |
| [MonitorDaemonSetup](#interface-monitordaemonsetup) |
| [MonitorOptions](#interface-monitoroptions) |
| [ReviewHeightRangeResult](#interface-reviewheightrangeresult) |
| [TaskPurgeParams](#interface-taskpurgeparams) |

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---

##### Interface: DeactivedHeader

```ts
export interface DeactivedHeader {
    whenMsecs: number;
    tries: number;
    header: BlockHeader;
}
```

See also: [BlockHeader](./client.md#interface-blockheader)

###### Property header

The deactivated block header.

```ts
header: BlockHeader
```
See also: [BlockHeader](./client.md#interface-blockheader)

###### Property tries

Number of attempts made to process the header.
Supports returning deactivation notification to the queue if proof data is not yet available.

```ts
tries: number
```

###### Property whenMsecs

To control aging of notification before pursuing updated proof data.

```ts
whenMsecs: number
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: MonitorDaemonSetup

```ts
export interface MonitorDaemonSetup {
    chain?: Chain;
    sqliteFilename?: string;
    mySQLConnection?: string;
    knexConfig?: Knex.Config;
    knex?: Knex<any, any[]>;
    storageKnexOptions?: StorageKnexOptions;
    storageProvider?: StorageProvider;
    storageManager?: WalletStorageManager;
    servicesOptions?: WalletServicesOptions;
    services?: Services;
    monitor?: Monitor;
    chaintracks?: Chaintracks;
    startupTaskMode?: MonitorStartupTaskMode;
}
```

See also: [Chain](./client.md#type-chain), [Chaintracks](./services.md#class-chaintracks), [Monitor](./monitor.md#class-monitor), [MonitorStartupTaskMode](./monitor.md#type-monitorstartuptaskmode), [Services](./services.md#class-services), [StorageKnexOptions](./storage.md#interface-storageknexoptions), [StorageProvider](./storage.md#class-storageprovider), [WalletServicesOptions](./client.md#interface-walletservicesoptions), [WalletStorageManager](./storage.md#class-walletstoragemanager)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: MonitorOptions

```ts
export interface MonitorOptions {
    chain: Chain;
    services: Services | WalletServices;
    storage: MonitorStorage;
    chaintracks: ChaintracksClientApi;
    chaintracksWithEvents?: Chaintracks;
    startupTaskMode?: MonitorStartupTaskMode;
    msecsWaitPerMerkleProofServiceReq: number;
    taskRunWaitMsecs: number;
    abandonedMsecs: number;
    unprovenAttemptsLimitTest: number;
    unprovenAttemptsLimitMain: number;
    callbackToken?: string;
    loadLastSSEEventId?: () => Promise<string | undefined>;
    saveLastSSEEventId?: (lastEventId: string) => Promise<void>;
    EventSourceClass?: any;
    onTransactionBroadcasted?: (broadcastResult: ReviewActionResult) => Promise<void>;
    onTransactionProven?: (txStatus: ProvenTransactionStatus) => Promise<void>;
    onTransactionStatusChanged?: (txid: string, newStatus: string) => Promise<void>;
}
```

See also: [Chain](./client.md#type-chain), [Chaintracks](./services.md#class-chaintracks), [ChaintracksClientApi](./services.md#interface-chaintracksclientapi), [MonitorStartupTaskMode](./monitor.md#type-monitorstartuptaskmode), [MonitorStorage](./monitor.md#type-monitorstorage), [ProvenTransactionStatus](./client.md#interface-proventransactionstatus), [ReviewActionResult](./client.md#interface-reviewactionresult), [Services](./services.md#class-services), [WalletServices](./client.md#interface-walletservices)

###### Property EventSourceClass

The react-native-sse EventSource class for SSE support in React Native

```ts
EventSourceClass?: any
```

###### Property callbackToken

Stable callback token for ARC SSE event streaming.
When set, TaskArcadeSSE will open an SSE connection to Arcade's
/events endpoint and receive real-time transaction status updates.
Must match the X-CallbackToken header sent during broadcast.

```ts
callbackToken?: string
```

###### Property loadLastSSEEventId

Load persisted SSE lastEventId (e.g. from SQLite) for catchup on startup

```ts
loadLastSSEEventId?: () => Promise<string | undefined>
```

###### Property msecsWaitPerMerkleProofServiceReq

How many msecs to wait after each getMerkleProof service request.

```ts
msecsWaitPerMerkleProofServiceReq: number
```

###### Property onTransactionBroadcasted

These are hooks for a wallet-toolbox client to get transaction updates.

```ts
onTransactionBroadcasted?: (broadcastResult: ReviewActionResult) => Promise<void>
```
See also: [ReviewActionResult](./client.md#interface-reviewactionresult)

###### Property saveLastSSEEventId

Save SSE lastEventId to persistent storage

```ts
saveLastSSEEventId?: (lastEventId: string) => Promise<void>
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: ReviewHeightRangeResult

```ts
export interface ReviewHeightRangeResult {
    log: string;
    reviewedHeights: number;
    mismatchedHeights: number;
    affectedTransactions: number;
    updatedTransactions: number;
}
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Interface: TaskPurgeParams

The database stores a variety of data that may be considered transient.

At one extreme, the data that must be preserved:
  - unspent outputs (UTXOs)
  - in-use metadata (labels, baskets, tags...)

At the other extreme, everything can be preserved to fully log all transaction creation and processing actions.

The following purge actions are available to support sustained operation:
  - Failed transactions, delete all associated data including:
      + Delete tag and label mapping records
      + Delete output records
      + Delete transaction records
      + Delete mapi_responses records
      + Delete proven_tx_reqs records
      + Delete commissions records
      + Update output records marked spentBy failed transactions
  - Completed transactions, delete transient data including:
      + transactions table set truncatedExternalInputs = null
      + transactions table set beef = null
      + transactions table set rawTx = null
      + Delete mapi_responses records
      + proven_tx_reqs table delete records

```ts
export interface TaskPurgeParams extends PurgeParams {
}
```

See also: [PurgeParams](./client.md#interface-purgeparams)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
#### Classes

| | |
| --- | --- |
| [Monitor](#class-monitor) | [TaskPurge](#class-taskpurge) |
| [MonitorDaemon](#class-monitordaemon) | [TaskReorg](#class-taskreorg) |
| [TaskArcadeSSE](#class-taskarcadesse) | [TaskReviewDoubleSpends](#class-taskreviewdoublespends) |
| [TaskCheckForProofs](#class-taskcheckforproofs) | [TaskReviewProvenTxs](#class-taskreviewproventxs) |
| [TaskCheckNoSends](#class-taskchecknosends) | [TaskReviewStatus](#class-taskreviewstatus) |
| [TaskClock](#class-taskclock) | [TaskReviewUtxos](#class-taskreviewutxos) |
| [TaskFailAbandoned](#class-taskfailabandoned) | [TaskSendWaiting](#class-tasksendwaiting) |
| [TaskMineBlock](#class-taskmineblock) | [TaskSyncWhenIdle](#class-tasksyncwhenidle) |
| [TaskMonitorCallHistory](#class-taskmonitorcallhistory) | [TaskUnFail](#class-taskunfail) |
| [TaskNewHeader](#class-tasknewheader) | [WalletMonitorTask](#class-walletmonitortask) |

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---

##### Class: Monitor

Background task to make sure transactions are processed, transaction proofs are received and propagated,
and potentially that reorgs update proofs that were already received.

```ts
export class Monitor {
    static createDefaultWalletMonitorOptions(chain: Chain, storage: MonitorStorage, services?: Services, chaintracks?: Chaintracks, startupTaskMode: MonitorStartupTaskMode = "none"): MonitorOptions 
    options: MonitorOptions;
    services: Services | WalletServices;
    chain: Chain;
    storage: MonitorStorage;
    chaintracks: ChaintracksClientApi;
    chaintracksWithEvents?: Chaintracks;
    reorgSubscriptionPromise?: Promise<string>;
    headersSubscriptionPromise?: Promise<string>;
    onTransactionBroadcasted?: (broadcastResult: ReviewActionResult) => Promise<void>;
    onTransactionProven?: (txStatus: ProvenTransactionStatus) => Promise<void>;
    onTransactionStatusChanged?: (txid: string, newStatus: string) => Promise<void>;
    constructor(options: MonitorOptions) 
    async destroy(): Promise<void> 
    static readonly oneSecond = 1000;
    static readonly oneMinute = 60 * Monitor.oneSecond;
    static readonly oneHour = 60 * Monitor.oneMinute;
    static readonly oneDay = 24 * Monitor.oneHour;
    static readonly oneWeek = 7 * Monitor.oneDay;
    _tasks: WalletMonitorTask[] = [];
    _otherTasks: WalletMonitorTask[] = [];
    _tasksRunning = false;
    defaultPurgeParams: TaskPurgeParams = {
        purgeSpent: false,
        purgeCompleted: false,
        purgeFailed: true,
        purgeSpentAge: 2 * Monitor.oneWeek,
        purgeCompletedAge: 2 * Monitor.oneWeek,
        purgeFailedAge: 5 * Monitor.oneDay
    };
    addAllTasksToOther(): void 
    addDefaultTasks(): void 
    addMultiUserTasks(): void 
    addTask(task: WalletMonitorTask): void 
    removeTask(name: string): void 
    async runTask(name: string): Promise<string> 
    async runOnce(): Promise<void> 
    _runAsyncSetup: boolean = true;
    _tasksRunningPromise?: PromiseLike<void>;
    resolveCompletion: ((value: void | PromiseLike<void>) => void) | undefined = undefined;
    async startTasks(): Promise<void> 
    async logEvent(event: string, details?: string): Promise<void> 
    stopTasks(): void 
    lastNewHeader: BlockHeader | undefined;
    lastNewHeaderWhen: Date | undefined;
    processNewBlockHeader(header: BlockHeader): void 
    callOnBroadcastedTransaction(broadcastResult: ReviewActionResult): void 
    callOnProvenTransaction(txStatus: ProvenTransactionStatus): void 
    callOnTransactionStatusChanged(txid: string, newStatus: string): void 
    async fetchSSEEvents(): Promise<number> 
    deactivatedHeaders: DeactivedHeader[] = [];
    processReorg(depth: number, oldTip: BlockHeader, newTip: BlockHeader, deactivatedHeaders?: BlockHeader[]): void 
    processHeader(header: BlockHeader): void 
}
```

See also: [BlockHeader](./client.md#interface-blockheader), [Chain](./client.md#type-chain), [Chaintracks](./services.md#class-chaintracks), [ChaintracksClientApi](./services.md#interface-chaintracksclientapi), [DeactivedHeader](./monitor.md#interface-deactivedheader), [MonitorOptions](./monitor.md#interface-monitoroptions), [MonitorStartupTaskMode](./monitor.md#type-monitorstartuptaskmode), [MonitorStorage](./monitor.md#type-monitorstorage), [ProvenTransactionStatus](./client.md#interface-proventransactionstatus), [ReviewActionResult](./client.md#interface-reviewactionresult), [Services](./services.md#class-services), [TaskPurgeParams](./monitor.md#interface-taskpurgeparams), [WalletMonitorTask](./monitor.md#class-walletmonitortask), [WalletServices](./client.md#interface-walletservices)

###### Property _otherTasks

_otherTasks can be run by runTask but not by scheduler.

```ts
_otherTasks: WalletMonitorTask[] = []
```
See also: [WalletMonitorTask](./monitor.md#class-walletmonitortask)

###### Property _tasks

_tasks are typically run by the scheduler but may also be run by runTask.

```ts
_tasks: WalletMonitorTask[] = []
```
See also: [WalletMonitorTask](./monitor.md#class-walletmonitortask)

###### Method addDefaultTasks

Default tasks with settings appropriate for a single user storage

```ts
addDefaultTasks(): void 
```

###### Method addMultiUserTasks

Tasks appropriate for multi-user storage

```ts
addMultiUserTasks(): void 
```

###### Method callOnBroadcastedTransaction

This is a function run from a TaskSendWaiting Monitor task.

This allows the user of wallet-toolbox to 'subscribe' for transaction broadcast updates.

```ts
callOnBroadcastedTransaction(broadcastResult: ReviewActionResult): void 
```
See also: [ReviewActionResult](./client.md#interface-reviewactionresult)

###### Method callOnProvenTransaction

This is a function run from a TaskCheckForProofs Monitor task.

This allows the user of wallet-toolbox to 'subscribe' for transaction updates.

```ts
callOnProvenTransaction(txStatus: ProvenTransactionStatus): void 
```
See also: [ProvenTransactionStatus](./client.md#interface-proventransactionstatus)

###### Method callOnTransactionStatusChanged

Called by TaskArcadeSSE when an SSE status event is received from Arcade.

```ts
callOnTransactionStatusChanged(txid: string, newStatus: string): void 
```

###### Method fetchSSEEvents

Fetch pending transaction status events from Arcade on demand.
Call this on app open, balance refresh, transaction list view, etc.

```ts
async fetchSSEEvents(): Promise<number> 
```

###### Method processHeader

Handler for new header events from Chaintracks.

To minimize reorg processing, new headers are aged before processing via TaskNewHeader.
Therefore this handler is intentionally a no-op.

```ts
processHeader(header: BlockHeader): void 
```
See also: [BlockHeader](./client.md#interface-blockheader)

###### Method processNewBlockHeader

Process new chain header event received from Chaintracks

Kicks processing 'unconfirmed' and 'unmined' request processing.

```ts
processNewBlockHeader(header: BlockHeader): void 
```
See also: [BlockHeader](./client.md#interface-blockheader)

###### Method processReorg

Process reorg event received from Chaintracks

Reorgs can move recent transactions to new blocks at new index positions.
Affected transaction proofs become invalid and must be updated.

It is possible for a transaction to become invalid.

Coinbase transactions always become invalid.

```ts
processReorg(depth: number, oldTip: BlockHeader, newTip: BlockHeader, deactivatedHeaders?: BlockHeader[]): void 
```
See also: [BlockHeader](./client.md#interface-blockheader)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Class: MonitorDaemon

```ts
export class MonitorDaemon {
    setup?: MonitorDaemonSetup;
    doneListening?: Promise<void>;
    doneTasks?: Promise<void>;
    stopDaemon: boolean = false;
    constructor(public args: MonitorDaemonSetup, public noRunTasks?: boolean) 
    async createSetup(): Promise<void> 
    async start(): Promise<void> 
    async stop(): Promise<void> 
    async destroy(): Promise<void> 
    async runDaemon(): Promise<void> 
}
```

See also: [MonitorDaemonSetup](./monitor.md#interface-monitordaemonsetup)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Class: TaskArcadeSSE

Monitor task that receives transaction status updates from Arcade via SSE
and processes them — including fetching merkle proofs directly from Arcade
when transactions are MINED.

```ts
export class TaskArcadeSSE extends WalletMonitorTask {
    static taskName = "ArcadeSSE";
    sseClient: ArcSSEClient | null = null;
    constructor(monitor: Monitor) 
    override async asyncSetup(): Promise<void> 
    trigger(_nowMsecsSinceEpoch: number): {
        run: boolean;
    } 
    async runTask(): Promise<string> 
    async fetchNow(): Promise<number> 
}
```

See also: [ArcSSEClient](./services.md#class-arcsseclient), [Monitor](./monitor.md#class-monitor), [WalletMonitorTask](./monitor.md#class-walletmonitortask)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Class: TaskCheckForProofs

`TaskCheckForProofs` is a WalletMonitor task that retreives merkle proofs for
transactions.

It is normally triggered by the Chaintracks new block header event.

When a new block is found, cwi-external-services are used to obtain proofs for
any transactions that are currently in the 'unmined' or 'unknown' state.

If a proof is obtained and validated, a new ProvenTx record is created and
the original ProvenTxReq status is advanced to 'notifying'.

```ts
export class TaskCheckForProofs extends WalletMonitorTask {
    static taskName = "CheckForProofs";
    static checkNow = false;
    constructor(monitor: Monitor, public triggerMsecs = 0) 
    trigger(nowMsecsSinceEpoch: number): {
        run: boolean;
    } 
    async runTask(): Promise<string> 
}
```

See also: [Monitor](./monitor.md#class-monitor), [WalletMonitorTask](./monitor.md#class-walletmonitortask)

###### Property checkNow

An external service such as the chaintracks new block header
listener can set this true to cause

```ts
static checkNow = false
```

###### Method trigger

Normally triggered by checkNow getting set by new block header found event from chaintracks

```ts
trigger(nowMsecsSinceEpoch: number): {
    run: boolean;
} 
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Class: TaskCheckNoSends

`TaskCheckNoSends` is a WalletMonitor task that retreives merkle proofs for
'nosend' transactions that MAY have been shared externally.

Unlike intentionally processed transactions, 'nosend' transactions are fully valid
transactions which have not been processed by the wallet.

By default, this task runs once a day to check if any 'nosend' transaction has
managed to get mined by some external process.

If a proof is obtained and validated, a new ProvenTx record is created and
the original ProvenTxReq status is advanced to 'notifying'.

```ts
export class TaskCheckNoSends extends WalletMonitorTask {
    static taskName = "CheckNoSends";
    static checkNow = false;
    constructor(monitor: Monitor, public triggerMsecs = Monitor.oneDay * 1) 
    trigger(nowMsecsSinceEpoch: number): {
        run: boolean;
    } 
    async runTask(): Promise<string> 
}
```

See also: [Monitor](./monitor.md#class-monitor), [WalletMonitorTask](./monitor.md#class-walletmonitortask)

###### Property checkNow

An external service such as the chaintracks new block header
listener can set this true to cause

```ts
static checkNow = false
```

###### Method trigger

Normally triggered by checkNow getting set by new block header found event from chaintracks

```ts
trigger(nowMsecsSinceEpoch: number): {
    run: boolean;
} 
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Class: TaskClock

```ts
export class TaskClock extends WalletMonitorTask {
    static taskName = "Clock";
    nextMinute: number;
    constructor(monitor: Monitor, public triggerMsecs = 1 * Monitor.oneSecond) 
    trigger(nowMsecsSinceEpoch: number): {
        run: boolean;
    } 
    async runTask(): Promise<string> 
    getNextMinute(): number 
}
```

See also: [Monitor](./monitor.md#class-monitor), [WalletMonitorTask](./monitor.md#class-walletmonitortask)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Class: TaskFailAbandoned

Handles transactions which do not have terminal status and have not been
updated for an extended time period.

Calls `updateTransactionStatus` to set `status` to `failed`.
This returns inputs to spendable status and verifies that any
outputs are not spendable.

```ts
export class TaskFailAbandoned extends WalletMonitorTask {
    static taskName = "FailAbandoned";
    constructor(monitor: Monitor, public triggerMsecs = 1000 * 60 * 5) 
    trigger(nowMsecsSinceEpoch: number): {
        run: boolean;
    } 
    async runTask(): Promise<string> 
}
```

See also: [Monitor](./monitor.md#class-monitor), [WalletMonitorTask](./monitor.md#class-walletmonitortask)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Class: TaskMineBlock

```ts
export class TaskMineBlock extends WalletMonitorTask {
    static taskName = "MineBlock";
    static mineNow = false;
    constructor(monitor: Monitor, public triggerMsecs = 10 * Monitor.oneMinute) 
    trigger(nowMsecsSinceEpoch: number): {
        run: boolean;
    } 
    async runTask(): Promise<string> 
}
```

See also: [Monitor](./monitor.md#class-monitor), [WalletMonitorTask](./monitor.md#class-walletmonitortask)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Class: TaskMonitorCallHistory

```ts
export class TaskMonitorCallHistory extends WalletMonitorTask {
    static taskName = "MonitorCallHistory";
    constructor(monitor: Monitor, public triggerMsecs = Monitor.oneMinute * 12) 
    trigger(nowMsecsSinceEpoch: number): {
        run: boolean;
    } 
    async runTask(): Promise<string> 
}
```

See also: [Monitor](./monitor.md#class-monitor), [WalletMonitorTask](./monitor.md#class-walletmonitortask)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Class: TaskNewHeader

This task polls for new block headers performing two essential functions:
1. The arrival of a new block is the right time to check for proofs for recently broadcast transactions.
2. The height of the block is used to limit which proofs are accepted with the aim of avoiding re-orged proofs.

The most common new block orphan is one which is almost immediately orphaned.
Waiting a minute before pursuing proof requests avoids almost all the re-org work that could be done.
Thus this task queues new headers for one cycle.
If a new header arrives during that cycle, it replaces the queued header and delays again.
Only when there is an elapsed cycle without a new header does proof solicitation get triggered,
with that header height as the limit for which proofs are accepted.

```ts
export class TaskNewHeader extends WalletMonitorTask {
    static taskName = "NewHeader";
    header?: BlockHeader;
    queuedHeader?: BlockHeader;
    queuedHeaderWhen?: Date;
    constructor(monitor: Monitor, public triggerMsecs = 1 * Monitor.oneMinute) 
    async getHeader(): Promise<BlockHeader> 
    override async asyncSetup(): Promise<void> 
    trigger(nowMsecsSinceEpoch: number): {
        run: boolean;
    } 
    async runTask(): Promise<string> 
}
```

See also: [BlockHeader](./client.md#interface-blockheader), [Monitor](./monitor.md#class-monitor), [WalletMonitorTask](./monitor.md#class-walletmonitortask)

###### Property header

This is always the most recent chain tip header returned from the chaintracker.

```ts
header?: BlockHeader
```
See also: [BlockHeader](./client.md#interface-blockheader)

###### Property queuedHeader

Tracks the value of `header` except that it is set to undefined
when a cycle without a new header occurs and `processNewBlockHeader` is called.

```ts
queuedHeader?: BlockHeader
```
See also: [BlockHeader](./client.md#interface-blockheader)

###### Method asyncSetup

TODO: This is a temporary incomplete solution for which a full chaintracker
with new header and reorg event notification is required.

New header events drive retrieving merklePaths for newly mined transactions.
This implementation performs this function.

Reorg events are needed to know when previously retrieved mekrlePaths need to be
updated in the proven_txs table (and ideally notifications delivered to users).
Note that in-general, a reorg only shifts where in the block a transaction is mined,
and sometimes which block. In the case of coinbase transactions, a transaction may
also fail after a reorg.

```ts
override async asyncSetup(): Promise<void> 
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Class: TaskPurge

```ts
export class TaskPurge extends WalletMonitorTask {
    static taskName = "Purge";
    static checkNow = false;
    constructor(monitor: Monitor, public params: TaskPurgeParams, public triggerMsecs = 0) 
    trigger(nowMsecsSinceEpoch: number): {
        run: boolean;
    } 
    async runTask(): Promise<string> 
}
```

See also: [Monitor](./monitor.md#class-monitor), [TaskPurgeParams](./monitor.md#interface-taskpurgeparams), [WalletMonitorTask](./monitor.md#class-walletmonitortask)

###### Property checkNow

Set to true to trigger running this task

```ts
static checkNow = false
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Class: TaskReorg

Check the `monitor.deactivatedHeaders` for any headers that have been deactivated.

When headers are found, review matching ProvenTx records and update proof data as appropriate.

New deactivated headers are pushed onto the `deactivatedHeaders` array.
They must be shifted out as they are processed.

The current implementation ages deactivation notifications by 10 minutes with each retry.
If a successful proof update confirms original proof data after 3 retries, the original is retained.

In normal operation there should rarely be any work for this task to perform.
The most common result is that there are no matching proven_txs records because
generating new proven_txs records intentionally lags new block generation to
minimize this disruption.

It is very disruptive to update a proven_txs record because:
- Sync'ed storage is impacted.
- Generated beefs are impacted.
- Updated proof data may be unavailable at the time a reorg is first reported.

Proper reorg handling also requires repairing invalid beefs for new transactions when
createAction fails to verify a generated beef against the chaintracker.

```ts
export class TaskReorg extends WalletMonitorTask {
    static taskName = "Reorg";
    process: DeactivedHeader[] = [];
    constructor(monitor: Monitor, public agedMsecs = Monitor.oneMinute * 10, public maxRetries = 3) 
    trigger(nowMsecsSinceEpoch: number): {
        run: boolean;
    } 
    async runTask(): Promise<string> 
}
```

See also: [DeactivedHeader](./monitor.md#interface-deactivedheader), [Monitor](./monitor.md#class-monitor), [WalletMonitorTask](./monitor.md#class-walletmonitortask)

###### Method trigger

Shift aged deactivated headers onto `process` array.

```ts
trigger(nowMsecsSinceEpoch: number): {
    run: boolean;
} 
```

Returns

`run` true iff there are aged deactivated headers to process.

Argument Details

+ **nowMsecsSinceEpoch**
  + current time in milliseconds since epoch.

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Class: TaskReviewDoubleSpends

Review recent reqs in terminal 'doubleSpend' state and move any false positives
back to 'unfail' so existing recovery handling can re-process them.

```ts
export class TaskReviewDoubleSpends extends WalletMonitorTask {
    static taskName = "ReviewDoubleSpends";
    static checkNow = false;
    triggerNextMsecs: number;
    constructor(monitor: Monitor, public triggerMsecs = Monitor.oneMinute * 12, public reviewLimit = 100, public minAgeMinutes = 60, public triggerQuickMsecs = Monitor.oneMinute * 1) 
    trigger(nowMsecsSinceEpoch: number): {
        run: boolean;
    } 
    async getLastReviewedCheckpoint(): Promise<{
        resumeOffset: number;
        expectedProvenTxReqId?: number;
    } | undefined> 
    async runTask(): Promise<string> 
}
```

See also: [Monitor](./monitor.md#class-monitor), [WalletMonitorTask](./monitor.md#class-walletmonitortask)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Class: TaskReviewProvenTxs

Backup verification task for recent proven_txs records.

Reorg handling should normally be driven by TaskReorg via deactivated-header events.
This task runs a lagged audit over recent heights and only reproves transactions when
the currently canonical merkleRoot at a height no longer matches stored proven_txs roots.

```ts
export class TaskReviewProvenTxs extends WalletMonitorTask {
    static taskName = "ReviewProvenTxs";
    static checkNow = false;
    triggerNextMsecs: number;
    constructor(monitor: Monitor, public triggerMsecs = Monitor.oneMinute * 10, public maxHeightsPerRun = 100, public minBlockAge = 100, public triggerQuickMsecs = Monitor.oneMinute * 1) 
    trigger(nowMsecsSinceEpoch: number): {
        run: boolean;
    } 
    async runTask(): Promise<string> 
    async reviewHeightRange(range: HeightRange): Promise<ReviewHeightRangeResult> 
    async getLastReviewedHeight(): Promise<number | undefined> 
}
```

See also: [HeightRange](./services.md#class-heightrange), [Monitor](./monitor.md#class-monitor), [ReviewHeightRangeResult](./monitor.md#interface-reviewheightrangeresult), [WalletMonitorTask](./monitor.md#class-walletmonitortask)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Class: TaskReviewStatus

Notify Transaction records of changes in ProvenTxReq records they may have missed.

The `notified` property flags reqs that do not need to be checked.

Looks for aged Transactions with provenTxId with status != 'completed', sets status to 'completed'.

Looks for reqs with 'invalid' status that have corresonding transactions with status other than 'failed'.

```ts
export class TaskReviewStatus extends WalletMonitorTask {
    static taskName = "ReviewStatus";
    static checkNow = false;
    constructor(monitor: Monitor, public triggerMsecs = 1000 * 60 * 15, public agedMsecs = 1000 * 60 * 5) 
    trigger(nowMsecsSinceEpoch: number): {
        run: boolean;
    } 
    async runTask(): Promise<string> 
}
```

See also: [Monitor](./monitor.md#class-monitor), [WalletMonitorTask](./monitor.md#class-walletmonitortask)

###### Property checkNow

Set to true to trigger running this task

```ts
static checkNow = false
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Class: TaskReviewUtxos

Use the reviewByIdentityKey method to review the utxos of a specific user by their identityKey.

The task itself is disabled and will not run on a schedule; review must be triggered manually by calling reviewByIdentityKey.

```ts
export class TaskReviewUtxos extends WalletMonitorTask {
    static taskName = "ReviewUtxos";
    static checkNow = false;
    constructor(monitor: Monitor, public triggerMsecs = 0, public userLimit = 10, public userOffset = 0, public tags: string[] = ["release", "all"]) 
    trigger(_nowMsecsSinceEpoch: number): {
        run: boolean;
    } 
    async runTask(): Promise<string> 
    async reviewByIdentityKey(identityKey: string, mode: "all" | "change" = "all"): Promise<string> 
}
```

See also: [Monitor](./monitor.md#class-monitor), [WalletMonitorTask](./monitor.md#class-walletmonitortask)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Class: TaskSendWaiting

```ts
export class TaskSendWaiting extends WalletMonitorTask {
    static taskName = "SendWaiting";
    lastSendingRunMsecsSinceEpoch: number | undefined;
    includeSending: boolean = true;
    triggerNextMsecs: number;
    constructor(monitor: Monitor, public triggerMsecs = Monitor.oneSecond * 8, public agedMsecs = Monitor.oneSecond * 7, public sendingMsecs = Monitor.oneMinute * 5, public triggerQuickMsecs = Monitor.oneSecond * 1, public chunkLimit = 100) 
    trigger(nowMsecsSinceEpoch: number): {
        run: boolean;
    } 
    async runTask(): Promise<string> 
    async processUnsent(reqApis: TableProvenTxReq[], indent = 0): Promise<string> 
}
```

See also: [Monitor](./monitor.md#class-monitor), [TableProvenTxReq](./storage.md#interface-tableproventxreq), [WalletMonitorTask](./monitor.md#class-walletmonitortask)

###### Constructor

```ts
constructor(monitor: Monitor, public triggerMsecs = Monitor.oneSecond * 8, public agedMsecs = Monitor.oneSecond * 7, public sendingMsecs = Monitor.oneMinute * 5, public triggerQuickMsecs = Monitor.oneSecond * 1, public chunkLimit = 100) 
```
See also: [Monitor](./monitor.md#class-monitor)

Argument Details

+ **monitor**
  + Wallet monitor owning this task.
+ **triggerMsecs**
  + Normal interval between SendWaiting runs when no backlog remains.
+ **agedMsecs**
  + Minimum age a request must reach before this task will attempt to send it.
+ **sendingMsecs**
  + Minimum interval before stale `sending` requests are included again.
+ **triggerQuickMsecs**
  + Follow-up interval used when a full chunk was consumed and more work may remain.
+ **chunkLimit**
  + Maximum number of waiting requests to fetch and inspect in a single run.

###### Method processUnsent

Process an array of 'unsent' status table.ProvenTxReq

Send rawTx to transaction processor(s), requesting proof callbacks when possible.

Set status 'invalid' if req is invalid.

Set status to 'callback' on successful network submission with callback service.

Set status to 'unmined' on successful network submission without callback service.

Add mapi responses to database table if received.

Increments attempts if sending was attempted.

```ts
async processUnsent(reqApis: TableProvenTxReq[], indent = 0): Promise<string> 
```
See also: [TableProvenTxReq](./storage.md#interface-tableproventxreq)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Class: TaskSyncWhenIdle

```ts
export class TaskSyncWhenIdle extends WalletMonitorTask {
    static taskName = "SyncWhenIdle";
    constructor(monitor: Monitor, public triggerMsecs = 1000 * 60 * 1) 
    trigger(nowMsecsSinceEpoch: number): {
        run: boolean;
    } 
    async runTask(): Promise<string> 
}
```

See also: [Monitor](./monitor.md#class-monitor), [WalletMonitorTask](./monitor.md#class-walletmonitortask)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Class: TaskUnFail

Setting provenTxReq status to 'unfail' when 'invalid' will attempt to find a merklePath, and if successful:

1. set the req status to 'unmined'
2. set the referenced txs to 'unproven'
3. determine if any inputs match user's existing outputs and if so update spentBy and spendable of those outputs.
4. set the txs outputs to spendable

If it fails (to find a merklePath), returns the req status to 'invalid'.

```ts
export class TaskUnFail extends WalletMonitorTask {
    static taskName = "UnFail";
    static checkNow = false;
    constructor(monitor: Monitor, public triggerMsecs = Monitor.oneMinute * 10) 
    trigger(nowMsecsSinceEpoch: number): {
        run: boolean;
    } 
    async runTask(): Promise<string> 
    async unfail(reqs: TableProvenTxReq[], indent = 0): Promise<{
        log: string;
    }> 
    async unfailReq(req: EntityProvenTxReq, indent: number): Promise<string> 
}
```

See also: [EntityProvenTxReq](./storage.md#class-entityproventxreq), [Monitor](./monitor.md#class-monitor), [TableProvenTxReq](./storage.md#interface-tableproventxreq), [WalletMonitorTask](./monitor.md#class-walletmonitortask)

###### Property checkNow

Set to true to trigger running this task

```ts
static checkNow = false
```

###### Method unfailReq

2. set the referenced txs to 'unproven'
3. determine if any inputs match user's existing outputs and if so update spentBy and spendable of those outputs.
4. set the txs outputs to spendable

```ts
async unfailReq(req: EntityProvenTxReq, indent: number): Promise<string> 
```
See also: [EntityProvenTxReq](./storage.md#class-entityproventxreq)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Class: WalletMonitorTask

A monitor task performs some periodic or state triggered maintenance function
on the data managed by a wallet (Bitcoin UTXO manager, aka wallet)

The monitor maintains a collection of tasks.

It runs each task's non-asynchronous trigger to determine if the runTask method needs to run.

Tasks that need to be run are run consecutively by awaiting their async runTask override method.

The monitor then waits a fixed interval before repeating...

Tasks may use the monitor_events table to persist their execution history.
This is done by accessing the wathman.storage object.

```ts
export abstract class WalletMonitorTask {
    lastRunMsecsSinceEpoch = 0;
    storage: MonitorStorage;
    constructor(public monitor: Monitor, public name: string) 
    async asyncSetup(): Promise<void> 
    abstract trigger(nowMsecsSinceEpoch: number): {
        run: boolean;
    };
    abstract runTask(): Promise<string>;
}
```

See also: [Monitor](./monitor.md#class-monitor), [MonitorStorage](./monitor.md#type-monitorstorage)

###### Property lastRunMsecsSinceEpoch

Set by monitor each time runTask completes

```ts
lastRunMsecsSinceEpoch = 0
```

###### Method asyncSetup

Override to handle async task setup configuration.

Called before first call to `trigger`

```ts
async asyncSetup(): Promise<void> 
```

###### Method trigger

Return true if `runTask` needs to be called now.

```ts
abstract trigger(nowMsecsSinceEpoch: number): {
    run: boolean;
}
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
#### Functions

##### Function: getProofs

Process an array of table.ProvenTxReq (typically with status 'unmined' or 'unknown')

If req is invalid, set status 'invalid'

Verify the requests are valid, lookup proofs or updated transaction status using the array of getProofServices,

When proofs are found, create new ProvenTxApi records and transition the requests' status to 'unconfirmed' or 'notifying',
depending on chaintracks succeeding on proof verification.

Increments attempts if proofs where requested.

```ts
export async function getProofs(task: WalletMonitorTask, reqs: TableProvenTxReq[], indent = 0, countsAsAttempt = false, ignoreStatus = false, maxAcceptableHeight: number): Promise<{
    proven: TableProvenTxReq[];
    invalid: TableProvenTxReq[];
    log: string;
}> 
```

See also: [TableProvenTxReq](./storage.md#interface-tableproventxreq), [WalletMonitorTask](./monitor.md#class-walletmonitortask)

Returns

reqs partitioned by status

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
#### Types

| |
| --- |
| [MonitorStartupTaskMode](#type-monitorstartuptaskmode) |
| [MonitorStorage](#type-monitorstorage) |

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---

##### Type: MonitorStartupTaskMode

```ts
export type MonitorStartupTaskMode = "none" | "default" | "multiuser" | "alltoother"
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
##### Type: MonitorStorage

```ts
export type MonitorStorage = WalletStorageManager
```

See also: [WalletStorageManager](./storage.md#class-walletstoragemanager)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
#### Variables


<!--#endregion ts2md-api-merged-here-->
