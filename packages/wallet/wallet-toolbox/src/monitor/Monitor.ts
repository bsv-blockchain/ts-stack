import { wait } from '../utility/utilityHelpers'

import { WalletMonitorTask } from './tasks/WalletMonitorTask'
import { WalletStorageManager } from '../storage/WalletStorageManager'

import { TaskPurge, TaskPurgeParams } from './tasks/TaskPurge'
import { TaskReviewStatus } from './tasks/TaskReviewStatus'
import { TaskFailAbandoned } from './tasks/TaskFailAbandoned'
import { TaskCheckForProofs } from './tasks/TaskCheckForProofs'
import { TaskClock } from './tasks/TaskClock'
import { TaskNewHeader } from './tasks/TaskNewHeader'
import { TaskMonitorCallHistory } from './tasks/TaskMonitorCallHistory'
import { TaskReorg } from './tasks/TaskReorg'
import { TaskArcadeSSE } from './tasks/TaskArcSSE'
import { TaskMineBlock } from './tasks/TaskMineBlock'

import { TaskSendWaiting } from './tasks/TaskSendWaiting'
import { TaskCheckNoSends } from './tasks/TaskCheckNoSends'
import { TaskNoSendExpiry } from './tasks/TaskNoSendExpiry'
import { TaskUnFail } from './tasks/TaskUnFail'
import { TaskReviewUtxos } from './tasks/TaskReviewUtxos'
import { TaskReviewDoubleSpends } from './tasks/TaskReviewDoubleSpends'
import { TaskReconcilePendingTransactions } from './tasks/TaskReconcilePendingTransactions'
import { TaskReviewProvenTxs } from './tasks/TaskReviewProvenTxs'
import { TaskCleanupActionBatches } from './tasks/TaskCleanupActionBatches'
import { Chain, ProvenTransactionStatus } from '../sdk/types'
import { ReviewActionResult } from '../sdk/WalletStorage.interfaces'
import { WERR_BAD_REQUEST, WERR_INVALID_PARAMETER } from '../sdk/WERR_errors'
import { WalletError } from '../sdk/WalletError'
import { BlockHeader, WalletServices } from '../sdk/WalletServices.interfaces'
import { Services } from '../services/Services'
import { ChaintracksClientApi } from '../services/chaintracker/chaintracks/Api/ChaintracksClientApi'
import { safeDiagnostic } from '../services/chaintracker/chaintracks/util/safeDiagnostic'
import { copyValidatedMonitorHeader, validateMonitorOptions } from './monitorValidation'

export type MonitorStorage = WalletStorageManager
export type MonitorStartupTaskMode = 'none' | 'default' | 'multiuser' | 'alltoother'

export interface MonitorOptions {
  chain: Chain

  services: Services | WalletServices

  storage: MonitorStorage

  chaintracks: ChaintracksClientApi

  chaintracksWithEvents?: ChaintracksClientApi

  /** Maximum deactivated block headers retained for reproof. Default: 4096. */
  maxQueuedDeactivatedHeaders?: number

  /** Optional bounded operational logger. Monitor library code is silent by default. */
  logging?: (...args: unknown[]) => void

  startupTaskMode?: MonitorStartupTaskMode

  /**
   * How many msecs to wait after each getMerkleProof service request.
   */
  msecsWaitPerMerkleProofServiceReq: number

  taskRunWaitMsecs: number

  abandonedMsecs: number

  unprovenAttemptsLimitTest: number

  unprovenAttemptsLimitMain: number

  /**
   * Maximum number of times a broadcast transaction may be reset to 'unsent' for
   * rebroadcast after proof check timeout (circuit breaker).
   *
   * Default 0 means unlimited — the tx is rebroadcast indefinitely until a proof
   * is found. Set to a positive integer to cap rebroadcast cycles; once the limit
   * is reached the req is marked 'invalid'.
   */
  maxRebroadcastAttempts: number

  /**
   * Stable callback token for ARC SSE event streaming.
   * When set, TaskArcadeSSE will open an SSE connection to Arcade's
   * /events endpoint and receive real-time transaction status updates.
   * Must match the X-CallbackToken header sent during broadcast.
   */
  callbackToken?: string

  /** Load persisted SSE lastEventId (e.g. from SQLite) for catchup on startup */
  loadLastSSEEventId?: () => Promise<string | undefined>
  /** Save SSE lastEventId to persistent storage */
  saveLastSSEEventId?: (lastEventId: string) => Promise<void>
  /** The react-native-sse EventSource class for SSE support in React Native */
  EventSourceClass?: any

  /**
   * These are hooks for a wallet-toolbox client to get transaction updates.
   */
  onTransactionBroadcasted?: (broadcastResult: ReviewActionResult) => Promise<void>
  onTransactionProven?: (txStatus: ProvenTransactionStatus) => Promise<void>
  onTransactionStatusChanged?: (txid: string, newStatus: string) => Promise<void>
}

/**
 * Background task to make sure transactions are processed, transaction proofs are received and propagated,
 * and potentially that reorgs update proofs that were already received.
 */
export class Monitor {
  static createDefaultWalletMonitorOptions(
    chain: Chain,
    storage: MonitorStorage,
    services?: Services,
    chaintracks?: ChaintracksClientApi,
    startupTaskMode: MonitorStartupTaskMode = 'none'
  ): MonitorOptions {
    services ??= new Services(chain)
    if (services.options.chaintracks == null) throw new WERR_INVALID_PARAMETER('services.options.chaintracks', 'valid')
    const o: MonitorOptions = {
      chain,
      services,
      storage,
      msecsWaitPerMerkleProofServiceReq: 500,
      taskRunWaitMsecs: 5000,
      abandonedMsecs: 1000 * 60 * 5,
      unprovenAttemptsLimitTest: 100,
      unprovenAttemptsLimitMain: 144,
      maxRebroadcastAttempts: 0,
      chaintracks: services.options.chaintracks,
      chaintracksWithEvents: chaintracks,
      maxQueuedDeactivatedHeaders: 4096,
      startupTaskMode
    }
    return o
  }

  options: MonitorOptions
  services: Services | WalletServices
  chain: Chain
  storage: MonitorStorage
  chaintracks: ChaintracksClientApi
  chaintracksWithEvents?: ChaintracksClientApi
  reorgSubscriptionPromise?: Promise<string>
  reorgInvalidationPromise: Promise<void> = Promise.resolve()
  headersSubscriptionPromise?: Promise<string>
  onTransactionBroadcasted?: (broadcastResult: ReviewActionResult) => Promise<void>
  onTransactionProven?: (txStatus: ProvenTransactionStatus) => Promise<void>
  onTransactionStatusChanged?: (txid: string, newStatus: string) => Promise<void>

  /**
   * Resolves once the optional Chaintracks subscriptions have been registered.
   * Await this before calling `startTasks()` if `chaintracksWithEvents` is provided
   * and you need subscriptions to be active before the first task loop runs.
   *
   * `runOnce`/`startTasks` do not await this directly — they call it through
   * `ensureEventSubscriptions`, which treats a rejection as best-effort and
   * always lets the scheduler proceed. A rejection here is not itself a
   * disaster: on failure `_readyInit` is reset below so the next access
   * retries `_init()`.
   */
  get ready(): Promise<void> {
    this._readyInit ??= this._init().catch(error => {
      this._readyInit = undefined
      throw error
    })
    return this._readyInit
  }

  private _readyInit?: Promise<void>
  private readonly maxQueuedDeactivatedHeaders: number
  private readonly deactivatedHeaderHashes = new Set<string>()
  private reorgInvalidationPending = false
  private readonly logging?: (...args: unknown[]) => void

  constructor(options: MonitorOptions) {
    validateMonitorOptions(options)
    this.options = { ...options }
    this.services = options.services
    this.chain = this.services.chain
    const configuredTrackerChain = (options.chaintracks as ChaintracksClientApi & { chain?: unknown })?.chain
    if (
      options.chain !== this.chain ||
      (configuredTrackerChain !== undefined && configuredTrackerChain !== this.chain)
    ) {
      throw new WERR_INVALID_PARAMETER('chain', 'the same supported network across monitor, services, and ChainTracks')
    }
    this.maxQueuedDeactivatedHeaders = options.maxQueuedDeactivatedHeaders ?? 4096
    if (
      !Number.isSafeInteger(this.maxQueuedDeactivatedHeaders) ||
      this.maxQueuedDeactivatedHeaders < 1 ||
      this.maxQueuedDeactivatedHeaders > 100_000
    ) {
      throw new WERR_INVALID_PARAMETER('maxQueuedDeactivatedHeaders', 'an integer from 1 through 100000')
    }
    if (options.logging != null && typeof options.logging !== 'function') {
      throw new WERR_INVALID_PARAMETER('logging', 'a function')
    }
    this.logging = options.logging
    this.storage = options.storage
    this.chaintracks = options.chaintracks
    this.chaintracksWithEvents = options.chaintracksWithEvents
    this.onTransactionProven = options.onTransactionProven
    this.onTransactionBroadcasted = options.onTransactionBroadcasted
    this.onTransactionStatusChanged = options.onTransactionStatusChanged

    this.applyStartupTaskMode(options.startupTaskMode ?? 'none')
  }

  private async _init(): Promise<void> {
    if (this.chaintracksWithEvents != null) {
      const eventSource = this.chaintracksWithEvents
      // Method presence is not capability (see ChaintracksClientApi's own doc
      // comment on `supportsReorgEvents`): `false` means subscribeHeaders /
      // subscribeReorgs are unsupported stubs that must not be called, e.g.
      // ChaintracksServiceClient, an HTTP-polling client. Regular scheduled
      // tasks (TaskNewHeader, TaskReorg, ...) already poll the configured
      // `chaintracks` every tick regardless of push events, so there is
      // nothing to set up here; skip without touching the network.
      if (eventSource.supportsReorgEvents === false) return
      const actualChain = await eventSource.getChain()
      if (actualChain !== this.chain) {
        throw new WERR_INVALID_PARAMETER('chaintracksWithEvents', `a ChainTracks source on ${this.chain}`)
      }
      let reorgSubscriptionId: string | undefined
      try {
        this.reorgSubscriptionPromise = eventSource.subscribeReorgs(this.processReorg.bind(this))
        reorgSubscriptionId = await this.reorgSubscriptionPromise
        this.headersSubscriptionPromise = eventSource.subscribeHeaders(this.processHeader.bind(this))
        await this.headersSubscriptionPromise
      } catch (error) {
        if (reorgSubscriptionId != null) await eventSource.unsubscribe(reorgSubscriptionId).catch(() => {})
        this.reorgSubscriptionPromise = undefined
        this.headersSubscriptionPromise = undefined
        throw error
      }
    }
  }

  private applyStartupTaskMode(mode: MonitorStartupTaskMode): void {
    switch (mode) {
      case 'default':
        this.addDefaultTasks()
        break
      case 'multiuser':
        this.addMultiUserTasks()
        break
      case 'alltoother':
        this.addAllTasksToOther()
        break
      case 'none':
        break
      default:
        throw new WERR_INVALID_PARAMETER('startupTaskMode', "'none', 'default', 'multiuser', or 'alltoother'")
    }
  }

  async destroy(): Promise<void> {
    for (const task of new Set([...this._tasks, ...this._otherTasks])) {
      if (task instanceof TaskArcadeSSE) task.close()
    }
    if (this.chaintracksWithEvents != null) {
      const c = this.chaintracksWithEvents
      const subscriptions = await Promise.allSettled(
        [this.reorgSubscriptionPromise, this.headersSubscriptionPromise].filter(
          (promise): promise is Promise<string> => promise != null
        )
      )
      await Promise.all(
        subscriptions
          .filter((result): result is PromiseFulfilledResult<string> => result.status === 'fulfilled')
          .map(async result => await c.unsubscribe(result.value).catch(() => false))
      )
    }
    await this.reorgInvalidationPromise
  }

  static readonly oneSecond = 1000
  static readonly oneMinute = 60 * Monitor.oneSecond
  static readonly oneHour = 60 * Monitor.oneMinute
  static readonly oneDay = 24 * Monitor.oneHour
  static readonly oneWeek = 7 * Monitor.oneDay

  /**
   * _tasks are typically run by the scheduler but may also be run by runTask.
   */
  _tasks: WalletMonitorTask[] = []
  /**
   * _otherTasks can be run by runTask but not by scheduler.
   */
  _otherTasks: WalletMonitorTask[] = []
  _tasksRunning = false

  defaultPurgeParams: TaskPurgeParams = {
    purgeSpent: false,
    purgeCompleted: false,
    purgeFailed: true,
    purgeSpentAge: 2 * Monitor.oneWeek,
    purgeCompletedAge: 2 * Monitor.oneWeek,
    purgeFailedAge: 5 * Monitor.oneDay
  }

  addAllTasksToOther(): void {
    this._otherTasks.push(
      new TaskClock(this),
      new TaskNewHeader(this),
      new TaskMonitorCallHistory(this),
      new TaskNoSendExpiry(this),
      new TaskSendWaiting(this),
      new TaskCheckForProofs(this),
      new TaskCheckNoSends(this),
      new TaskFailAbandoned(this),
      new TaskUnFail(this),
      new TaskReviewStatus(this),
      new TaskReorg(this),
      new TaskReviewUtxos(this),
      new TaskReviewDoubleSpends(this),
      new TaskReconcilePendingTransactions(this),
      new TaskReviewProvenTxs(this),
      new TaskCleanupActionBatches(this),
      new TaskPurge(this, this.defaultPurgeParams)
    )
    if (this.chain === 'mock') {
      this._otherTasks.push(new TaskMineBlock(this))
    }
  }

  /**
   * Default tasks with settings appropriate for a single user storage
   */
  addDefaultTasks(): void {
    this._tasks.push(
      new TaskClock(this),
      new TaskNewHeader(this),
      new TaskMonitorCallHistory(this),
      new TaskNoSendExpiry(this),
      new TaskSendWaiting(this, 8 * Monitor.oneSecond, 7 * Monitor.oneSecond), // Check every 8 seconds but must be 7 seconds old
      new TaskCheckForProofs(this, 2 * Monitor.oneHour), // Every two hours if no block found
      new TaskCheckNoSends(this),
      new TaskFailAbandoned(this, 8 * Monitor.oneMinute),
      new TaskUnFail(this),
      new TaskReviewStatus(this),
      new TaskReorg(this),
      new TaskReviewDoubleSpends(this),
      new TaskReconcilePendingTransactions(this),
      new TaskReviewProvenTxs(this),
      new TaskCleanupActionBatches(this),
      new TaskArcadeSSE(this)
    )
    this._otherTasks.push(new TaskPurge(this, this.defaultPurgeParams, 6 * Monitor.oneHour), new TaskReviewUtxos(this))
    if (this.chain === 'mock') {
      this._tasks.push(new TaskMineBlock(this))
    }
  }

  /**
   * Tasks appropriate for multi-user storage
   */
  addMultiUserTasks(): void {
    this._tasks.push(
      new TaskClock(this),
      new TaskNewHeader(this),
      new TaskMonitorCallHistory(this),
      new TaskNoSendExpiry(this),
      new TaskSendWaiting(this, 8 * Monitor.oneSecond, 7 * Monitor.oneSecond), // Check every 8 seconds but must be 7 seconds old
      new TaskCheckForProofs(this, 2 * Monitor.oneHour), // Every two hours if no block found
      new TaskCheckNoSends(this),
      new TaskFailAbandoned(this, 8 * Monitor.oneMinute),
      new TaskUnFail(this),
      new TaskReviewStatus(this),
      new TaskReorg(this),
      new TaskReviewDoubleSpends(this),
      new TaskReconcilePendingTransactions(this),
      new TaskReviewProvenTxs(this),
      new TaskCleanupActionBatches(this),
      new TaskArcadeSSE(this)
    )
    this._otherTasks.push(new TaskPurge(this, this.defaultPurgeParams), new TaskReviewUtxos(this))
    if (this.chain === 'mock') {
      this._tasks.push(new TaskMineBlock(this))
    }
  }

  addTask(task: WalletMonitorTask): void {
    if (task == null || typeof task.name !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(task.name)) {
      throw new WERR_INVALID_PARAMETER('task.name', 'a bounded control-free monitor task name')
    }
    if (this._tasks.some(t => t.name === task.name)) {
      throw new WERR_BAD_REQUEST(`task ${task.name} has already been added.`)
    }
    this._tasks.push(task)
    this._runAsyncSetup = true
  }

  removeTask(name: string): void {
    for (const task of this._tasks) {
      if (task.name === name && task instanceof TaskArcadeSSE) task.close()
    }
    this._tasks = this._tasks.filter(t => t.name !== name)
  }

  async runTask(name: string): Promise<string> {
    let task = this._tasks.find(t => t.name === name)
    let log = ''
    task ??= this._otherTasks.find(t => t.name === name)
    if (task != null) {
      await task.asyncSetup()
      log = await task.runTask()
    }
    return log
  }

  async runOnce(): Promise<void> {
    await this.ensureEventSubscriptions()
    await this.setupTasksOnce()
    if (!this.storage.getActive().isStorageProvider()) return
    for (const task of await this.tasksReadyToRun()) {
      await this.runScheduledTask(task)
    }
  }

  /**
   * Best-effort attempt to (re)register the optional Chaintracks header/reorg
   * push subscriptions ahead of this scheduler tick.
   *
   * Header and reorg events are a latency optimization, not a requirement:
   * every task that cares about chain height or reorgs (TaskNewHeader,
   * TaskReorg, ...) already polls the configured `chaintracks` on its own
   * schedule regardless of whether push events are flowing. An offline,
   * unimplemented (see the `supportsReorgEvents` skip in `_init`), or
   * otherwise misconfigured event source must not stop the scheduler that
   * runs every other maintenance task.
   *
   * A failure here is logged and swallowed; the `ready` getter's own
   * `.catch` resets `_readyInit` first, so the *next* call to this method
   * (i.e. the next scheduler tick) retries `_init()` from scratch. This
   * method itself never throws. A genuine configured-chain mismatch (see
   * `_init`) still fails `ready` every time it is retried, so the event
   * source never transitions to a subscribed state on mismatched data —
   * only this outer scheduling loop is decoupled from that failure.
   *
   * A caller that specifically needs subscriptions active before its own
   * first task loop can still `await monitor.ready` directly and handle the
   * rejection itself; that public contract is unchanged.
   */
  private async ensureEventSubscriptions(): Promise<void> {
    try {
      await this.ready
    } catch (error_: unknown) {
      await this.logChaintracksEventsError(error_)
    }
  }

  private async logChaintracksEventsError(error_: unknown): Promise<void> {
    const error = WalletError.fromUnknown(error_)
    const details = `monitor chaintracksWithEvents subscription unavailable ${safeDiagnostic(error.code, 64)} ${safeDiagnostic(error.description)}`
    this.emitLog(details)
    await this.logEvent('chaintracksEventsError', details)
  }

  private async setupTasksOnce(): Promise<void> {
    if (!this._runAsyncSetup) return
    const stopSensitive = this._tasksRunning
    for (const task of this._tasks) {
      if (this.setupTasksComplete.has(task)) continue
      try {
        await task.asyncSetup()
        this.setupTasksComplete.add(task)
      } catch (error_: unknown) {
        await this.logTaskError(task, 'asyncSetup', 'error0', error_)
      }
      if (stopSensitive && !this._tasksRunning) break
    }
    this._runAsyncSetup = this._tasks.some(task => !this.setupTasksComplete.has(task))
  }

  private async tasksReadyToRun(): Promise<WalletMonitorTask[]> {
    const tasks: WalletMonitorTask[] = []
    const now = Date.now()
    for (const task of this._tasks) {
      try {
        if (task.trigger(now).run) tasks.push(task)
      } catch (error_: unknown) {
        await this.logTaskError(task, 'trigger', 'error0', error_)
      }
    }
    return tasks
  }

  private async runScheduledTask(task: WalletMonitorTask): Promise<void> {
    try {
      if (!this.storage.getActive().isStorageProvider()) return
      const log = await task.runTask()
      if (log.length === 0) return
      const details = task.name === 'MonitorCallHistory' ? '...' : safeDiagnostic(log, 1024)
      this.emitLog(`Task${task.name} ${details}`)
      await this.logEvent(task.name, safeDiagnostic(log, 8192))
    } catch (error_: unknown) {
      await this.logTaskError(task, 'runTask', 'error1', error_, true)
    } finally {
      task.lastRunMsecsSinceEpoch = Date.now()
    }
  }

  private async logTaskError(
    task: WalletMonitorTask,
    operation: 'asyncSetup' | 'trigger' | 'runTask',
    event: 'error0' | 'error1',
    error_: unknown,
    includeStack = false
  ): Promise<void> {
    const error = WalletError.fromUnknown(error_)
    const stack = includeStack && error.stack != null ? ` ${safeDiagnostic(error.stack, 1024)}` : ''
    const details = `monitor task ${safeDiagnostic(task.name, 128)} ${operation} error ${safeDiagnostic(error.code, 64)} ${safeDiagnostic(error.description)}${stack}`
    this.emitLog(details)
    await this.logEvent(event, details)
  }

  _runAsyncSetup: boolean = true
  private readonly setupTasksComplete = new WeakSet<WalletMonitorTask>()
  _tasksRunningPromise?: PromiseLike<void>
  resolveCompletion: ((value: void | PromiseLike<void>) => void) | undefined = undefined

  async startTasks(): Promise<void> {
    if (this._tasksRunning) throw new WERR_BAD_REQUEST('monitor tasks are already runnining.')

    this._tasksRunning = true
    this._tasksRunningPromise = new Promise(resolve => {
      this.resolveCompletion = resolve
    })

    try {
      while (this._tasksRunning) {
        await this.runOnce()
        await wait(this.options.taskRunWaitMsecs)
      }
    } finally {
      this._tasksRunning = false
      if (this.resolveCompletion != null) {
        this.resolveCompletion()
        this.resolveCompletion = undefined
      }
    }
  }

  async logEvent(event: string, details?: string): Promise<void> {
    if (typeof event !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(event)) {
      throw new WERR_INVALID_PARAMETER('event', 'a bounded control-free monitor event name')
    }
    const boundedDetails = details == null ? undefined : safeDiagnostic(details, 8192)
    await this.storage.runAsStorageProvider(async sp => {
      await sp.insertMonitorEvent({
        created_at: new Date(),
        updated_at: new Date(),
        id: 0,
        event,
        details: boundedDetails
      })
    })
  }

  stopTasks(): void {
    this._tasksRunning = false
  }

  private emitLog(message: string): void {
    if (this.logging == null) return
    try {
      this.logging(message)
    } catch {
      // Observability hooks do not control monitor work.
    }
  }

  lastNewHeader: BlockHeader | undefined
  lastNewHeaderWhen: Date | undefined

  /**
   * Process new chain header event received from Chaintracks
   *
   * Kicks processing 'unconfirmed' and 'unmined' request processing.
   *
   * @param reqs
   */
  processNewBlockHeader(header: BlockHeader): void {
    const h = this.copyValidatedHeader(header, 'new block header')
    this.lastNewHeader = h
    this.lastNewHeaderWhen = new Date()
    // console.log(`WalletMonitor notified of new block header ${h.height}`)
    // Nudge the proof checker to try again.
    TaskCheckForProofs.checkNow = true
    // Nudge the nosend checker too. Externally-broadcast nosend txs
    // (created via createAction({noSend:true}) and broadcast by the
    // caller through ARC, a ladder, or other external paths) may have
    // confirmed in this new block. TaskCheckNoSends.runTask processes
    // 'nosend' reqs via getProofs the same way TaskCheckForProofs
    // processes 'unmined'/'unknown'/... reqs; without this nudge the
    // task only fires on its triggerMsecs cadence (default once per
    // day) which combined with intermittent wallet uptime means the
    // nosend lifecycle has no reliable retirement path. The
    // TaskCheckNoSends.checkNow flag was designed for this signal
    // (see TaskCheckNoSends.ts:22-25) but was never wired.
    TaskCheckNoSends.checkNow = true
    TaskNoSendExpiry.requestCheck()
  }

  /**
   * This is a function run from a TaskSendWaiting Monitor task.
   *
   * This allows the user of wallet-toolbox to 'subscribe' for transaction broadcast updates.
   *
   * @param broadcastResult
   */
  callOnBroadcastedTransaction(broadcastResult: ReviewActionResult): void {
    if (this.onTransactionBroadcasted != null) {
      this.invokeCallback('onTransactionBroadcasted', async () => await this.onTransactionBroadcasted!(broadcastResult))
    }
  }

  /**
   * This is a function run from a TaskCheckForProofs Monitor task.
   *
   * This allows the user of wallet-toolbox to 'subscribe' for transaction updates.
   *
   * @param txStatus
   */
  callOnProvenTransaction(txStatus: ProvenTransactionStatus): void {
    if (this.onTransactionProven != null) {
      this.invokeCallback('onTransactionProven', async () => await this.onTransactionProven!({ ...txStatus }))
    }
  }

  /**
   * Called by TaskArcadeSSE when an SSE status event is received from Arcade.
   */
  callOnTransactionStatusChanged(txid: string, newStatus: string): void {
    if (this.onTransactionStatusChanged != null) {
      this.invokeCallback(
        'onTransactionStatusChanged',
        async () => await this.onTransactionStatusChanged!(txid, newStatus)
      )
    }
  }

  private invokeCallback(name: string, callback: () => Promise<void>): void {
    void Promise.resolve()
      .then(callback)
      .catch(async error => {
        await this.logEvent('error1', `monitor ${name} callback error ${safeDiagnostic(error)}`).catch(() => {})
      })
  }

  /**
   * Fetch pending transaction status events from Arcade on demand.
   * Call this on app open, balance refresh, transaction list view, etc.
   */
  async fetchSSEEvents(): Promise<number> {
    const sseTask = this._tasks.find(t => t.name === TaskArcadeSSE.taskName) as TaskArcadeSSE | undefined
    return (await sseTask?.fetchNow()) ?? 0
  }

  deactivatedHeaders: DeactivedHeader[] = []

  /**
   * Process reorg event received from Chaintracks
   *
   * Reorgs can move recent transactions to new blocks at new index positions.
   * Affected transaction proofs become invalid and must be updated.
   *
   * It is possible for a transaction to become invalid.
   *
   * Coinbase transactions always become invalid.
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  processReorg(depth: number, oldTip: BlockHeader, newTip: BlockHeader, deactivatedHeaders?: BlockHeader[]): void {
    const event = this.validateReorgEvent(depth, oldTip, newTip, deactivatedHeaders)
    // Close prepared reads synchronously, then invalidate the shared epoch in
    // the background. Replacement-proof discovery remains aged because it may
    // require slow/unavailable network services; cache safety does not.
    this.requestPreparedBeefInvalidation()
    const whenMsecs = Date.now()
    for (const header of event.deactivatedHeaders) {
      this.enqueueDeactivatedHeader({ whenMsecs, tries: 0, header })
    }
  }

  enqueueDeactivatedHeader(item: DeactivedHeader): void {
    const header = this.copyValidatedHeader(item.header, 'deactivated header')
    if (!Number.isSafeInteger(item.whenMsecs) || item.whenMsecs < 0 || item.whenMsecs > Date.now() + Monitor.oneDay) {
      throw new WERR_INVALID_PARAMETER('whenMsecs', 'a non-negative timestamp no more than one day in the future')
    }
    if (!Number.isSafeInteger(item.tries) || item.tries < 0 || item.tries > 1000) {
      throw new WERR_INVALID_PARAMETER('tries', 'an integer from 0 through 1000')
    }
    if (this.deactivatedHeaderHashes.has(header.hash)) return
    if (this.deactivatedHeaders.length >= this.maxQueuedDeactivatedHeaders) {
      const evicted = this.deactivatedHeaders.shift()
      if (evicted != null) this.deactivatedHeaderHashes.delete(evicted.header.hash)
      void this.logEvent('error1', 'monitor reorg queue reached capacity; evicted its oldest header').catch(() => {})
    }
    this.deactivatedHeaders.push({ ...item, header })
    this.deactivatedHeaderHashes.add(header.hash)
  }

  shiftDeactivatedHeader(): DeactivedHeader | undefined {
    const item = this.deactivatedHeaders.shift()
    if (item != null) this.deactivatedHeaderHashes.delete(item.header.hash)
    return item
  }

  private preparedBeefInvalidation(): unknown {
    return this.storage.invalidatePreparedBeefsForReorg()
  }

  private requestPreparedBeefInvalidation(): void {
    if (this.reorgInvalidationPending) return
    this.reorgInvalidationPending = true
    let invalidation: Promise<void>
    try {
      invalidation = this.preparedBeefInvalidation() as Promise<void>
    } catch (error) {
      invalidation = Promise.reject(error)
    }
    this.reorgInvalidationPromise = invalidation
      .catch(async error_ => {
        const error = WalletError.fromUnknown(error_)
        const details = `monitor reorg prepared-BEEF invalidation error ${safeDiagnostic(error.code, 64)} ${safeDiagnostic(error.description)}`
        await this.logEvent('error1', details).catch(() => {})
      })
      .finally(() => {
        this.reorgInvalidationPending = false
      })
  }

  private validateReorgEvent(
    depth: unknown,
    oldTip: unknown,
    newTip: unknown,
    deactivatedHeaders: unknown
  ): { oldTip: BlockHeader; newTip: BlockHeader; deactivatedHeaders: BlockHeader[] } {
    if (!Number.isSafeInteger(depth) || (depth as number) < 1 || (depth as number) > 100_000) {
      throw new WERR_INVALID_PARAMETER('depth', 'an integer from 1 through 100000')
    }
    const oldHeader = this.copyValidatedHeader(oldTip, 'old tip')
    const newHeader = this.copyValidatedHeader(newTip, 'new tip')
    if (deactivatedHeaders === undefined) {
      return { oldTip: oldHeader, newTip: newHeader, deactivatedHeaders: [] }
    }
    if (
      !Array.isArray(deactivatedHeaders) ||
      deactivatedHeaders.length > (depth as number) ||
      deactivatedHeaders.length > this.maxQueuedDeactivatedHeaders
    ) {
      throw new WERR_INVALID_PARAMETER(
        'deactivatedHeaders',
        'a bounded dense array no longer than the reorganization depth'
      )
    }
    const headers: BlockHeader[] = []
    const hashes = new Set<string>()
    for (let index = 0; index < deactivatedHeaders.length; index++) {
      if (!Object.hasOwn(deactivatedHeaders, index)) {
        throw new WERR_INVALID_PARAMETER('deactivatedHeaders', 'a dense array')
      }
      const header = this.copyValidatedHeader(deactivatedHeaders[index], `deactivated header ${index}`)
      if (hashes.has(header.hash)) throw new WERR_INVALID_PARAMETER('deactivatedHeaders', 'unique header hashes')
      hashes.add(header.hash)
      const child = headers.at(-1)
      if (child != null && (child.height !== header.height + 1 || child.previousHash !== header.hash)) {
        throw new WERR_INVALID_PARAMETER('deactivatedHeaders', 'one descending linked header chain')
      }
      headers.push(header)
    }
    if (headers.length > 0 && headers[0].hash !== oldHeader.hash) {
      throw new WERR_INVALID_PARAMETER('deactivatedHeaders', 'a list beginning at the old tip')
    }
    return { oldTip: oldHeader, newTip: newHeader, deactivatedHeaders: headers }
  }

  private copyValidatedHeader(value: unknown, name: string): BlockHeader {
    // The in-memory mock chain deliberately uses a regtest-style target that
    // is outside Bitcoin's production proof-of-work limit. Still bind every
    // field to the computed header hash, but require consensus PoW everywhere
    // a remotely sourced production/test network header can enter.
    return copyValidatedMonitorHeader(value, name, this.chain !== 'mock')
  }

  /**
   * Handler for new header events from Chaintracks.
   *
   * To minimize reorg processing, new headers are aged before processing via TaskNewHeader.
   * Therefore this handler is intentionally a no-op.
   *
   * @param header
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  processHeader(header: BlockHeader): void {
    // Intentional no-op: new headers are aged via TaskNewHeader before processing
  }
}

export interface DeactivedHeader {
  /**
   * To control aging of notification before pursuing updated proof data.
   */
  whenMsecs: number
  /**
   * Number of attempts made to process the header.
   * Supports returning deactivation notification to the queue if proof data is not yet available.
   */
  tries: number
  /**
   * The deactivated block header.
   */
  header: BlockHeader
}
