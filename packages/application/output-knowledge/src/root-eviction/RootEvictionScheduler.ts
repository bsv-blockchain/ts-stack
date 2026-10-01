import { outputAssert, outputHex32, outputString } from '@bsv/sdk'
import { BoundedOutputWork, checkOutputWork } from '../internal/BoundedOutputWork.js'
import type { RootEvictionContracts } from './RootEvictionContracts.js'
import type {
  RootEvictionCommitGuard,
  RootEvictionObservation
} from './RootEvictionCommitContext.js'
import type {
  RootEvictionMaintenanceGuard,
  RootEvictionMaintenanceStorage
} from './RootEvictionMaintenanceStorage.js'
import type {
  RootEvictionRecoveredRequest,
  RootEvictionRecoveryStorage
} from './RootEvictionRecoveryStorage.js'
import type { RootEvictionEvaluation } from './RootEvictionStorage.js'

/** Explicitly installed local authority; never inferred from a request, reason or peer vote. */
export interface RootEvictionAutomaticEvaluation {
  /** Versioned local policy identifier and its independently installed digest. */
  policyId: string
  policyDigest: string
  journal: RootEvictionRecoveryStorage
  contracts: RootEvictionContracts
  guard(digest: string, signal: AbortSignal): Promise<RootEvictionCommitGuard>
  /**
   * Verify evidence, attribution, currentness and restoration authority outside
   * the database gate. Return only justified decisions; an empty array defers.
   * The worker binds the commit to the original observation and installed policy.
   */
  evaluate(
    observation: RootEvictionObservation<RootEvictionRecoveredRequest>,
    signal: AbortSignal
  ): Promise<RootEvictionEvaluation['targets']>
}
export interface RootEvictionSchedulerOptions {
  maintenance: RootEvictionMaintenanceStorage
  maintenanceGuard: RootEvictionMaintenanceGuard
  /** Omit for the default manual/advisory mode, which only expires old work. */
  automatic?: RootEvictionAutomaticEvaluation
  pageSize?: number
  maximum?: number
  timeoutMs?: number
  intervalMs?: number
}
export interface RootEvictionScheduleReport {
  scanned: number
  expiredTargets: number
  started: number
  failures: { digest: string; phase: 'expiry' | 'evaluation'; error: unknown }[]
}
interface PhysicalJob {
  controller: AbortController
  done: Promise<void>
  finish(): void
  started: boolean
}
const cancelled = 'Root scheduling stopped'
const check = (signal: AbortSignal): void => checkOutputWork(signal, cancelled)

/**
 * Bounded local recovery, independent expiry and optional policy evaluation.
 * Wake calls are coalesced hints; startup/periodic scans recover lost hints.
 * No database, signing, projection or HTTP lifecycle ownership is transferred.
 */
export class RootEvictionScheduler {
  private readonly options: RootEvictionSchedulerOptions
  private readonly automatic?: RootEvictionAutomaticEvaluation
  private readonly pageSize: number
  private readonly maximum: number
  private readonly interval: number
  private readonly work: BoundedOutputWork
  private readonly jobs = new Map<string, PhysicalJob>()
  private expiryCursor?: string
  private evaluationCursor?: string
  private scanning?: Promise<RootEvictionScheduleReport>
  private loop?: Promise<void>
  private stopped = false
  private wakeRequested = false
  private releaseWait?: () => void

  constructor(options: RootEvictionSchedulerOptions) {
    outputAssert(options.maintenance.durability === 'durable', 'Root maintenance must be durable')
    this.options = {
      ...options,
      maintenanceGuard: {
        clock: options.maintenanceGuard.clock.bind(options.maintenanceGuard),
        authorize: options.maintenanceGuard.authorize.bind(options.maintenanceGuard)
      }
    }
    this.pageSize = options.pageSize ?? 64
    this.maximum = options.maximum ?? 4
    this.interval = options.intervalMs ?? 1000
    for (const [value, ceiling] of [
      [this.pageSize, 64],
      [this.maximum, 64],
      [this.interval, 60000]
    ])
      outputAssert(
        Number.isSafeInteger(value) && value >= 1 && value <= ceiling,
        'Invalid root scheduler bound'
      )
    if (options.automatic) {
      outputAssert(
        options.automatic.journal.durability === 'durable',
        'Root recovery must be durable'
      )
      this.automatic = {
        journal: options.automatic.journal,
        contracts: options.automatic.contracts,
        guard: options.automatic.guard.bind(options.automatic),
        evaluate: options.automatic.evaluate.bind(options.automatic),
        policyId: outputString(options.automatic.policyId),
        policyDigest: outputHex32(options.automatic.policyDigest)
      }
    }
    this.work = new BoundedOutputWork(
      {
        invalid: 'Invalid root scheduler work bound',
        capacity: 'Root scheduler physical capacity is full',
        cancelled,
        deadline: 'Root evaluation deadline reached'
      },
      this.maximum,
      this.maximum,
      options.timeoutMs
    )
  }

  /** One bounded pass; concurrent callers share that pass instead of queuing scans. */
  async runOnce(): Promise<RootEvictionScheduleReport> {
    outputAssert(!this.stopped, cancelled, 'cancelled')
    if (!this.scanning)
      this.scanning = this.scan().finally(() => {
        this.scanning = undefined
      })
    return await this.scanning
  }

  /**
   * Explicitly start the lifetime loop and observe each completed pass. Observe
   * the returned promise: a scan/observer failure stops this loop and rejects it.
   * Observer completion is awaited; it must not await this worker's own stop().
   * Item failures remain in the report and are revisited by later bounded passes.
   */
  async start(onPass: (report: RootEvictionScheduleReport) => void | Promise<void>): Promise<void> {
    outputAssert(!this.stopped, cancelled, 'cancelled')
    if (!this.loop) this.loop = this.runLoop(onPass).finally(() => this.halt())
    await this.loop
  }

  wake(): void {
    if (this.stopped) return
    this.wakeRequested = true
    this.releaseWait?.()
  }

  /**
   * Irreversibly stop intake, cancel jobs and await their physical settlement.
   * A non-cooperating dependency keeps this pending. Close caller-owned storage
   * only after it resolves; a logical timeout is not a physical drain.
   */
  async stop(): Promise<void> {
    this.halt()
    await Promise.allSettled([this.scanning, this.loop])
    await Promise.all(Array.from(this.jobs.values(), job => job.done))
  }

  private halt(): void {
    this.stopped = true
    this.releaseWait?.()
    for (const job of this.jobs.values()) job.controller.abort()
  }

  private async runLoop(
    onPass: (report: RootEvictionScheduleReport) => void | Promise<void>
  ): Promise<void> {
    while (!this.stopped) {
      this.wakeRequested = false
      await onPass(await this.runOnce())
      if (!this.stopped && !this.wakeRequested)
        await new Promise<void>(resolve => {
          const finish = (): void => {
            clearTimeout(timer)
            this.releaseWait = undefined
            resolve()
          }
          const timer = setTimeout(finish, this.interval)
          this.releaseWait = finish
        })
    }
  }

  private async scan(): Promise<RootEvictionScheduleReport> {
    const report: RootEvictionScheduleReport = {
      scanned: 0,
      expiredTargets: 0,
      started: 0,
      failures: []
    }
    const { maintenance, maintenanceGuard } = this.options
    const page = await maintenance.pendingPage(
      { maximum: this.pageSize, after: this.expiryCursor },
      maintenanceGuard
    )
    for (const digest of page.value.digests) {
      if (this.stopped) return report
      report.scanned++
      await this.expire(digest, report)
    }
    this.expiryCursor = page.value.next
    // Separate cursors ensure stalled evaluations cannot stop expiry or starve
    // later requests. The finite journal bounds each wrapping local scan.
    const available = this.maximum - this.jobs.size
    if (!this.automatic || available === 0 || this.stopped) return report
    const pending = await maintenance.pendingPage(
      { maximum: Math.min(this.pageSize, available), after: this.evaluationCursor },
      maintenanceGuard
    )
    const launched: Promise<void>[] = []
    for (const digest of pending.value.digests) {
      if (this.stopped) break
      if (this.jobs.has(digest)) continue
      const remaining = await this.expire(digest, report)
      if (remaining && !this.stopped) {
        report.started++
        launched.push(this.launch(digest, report))
      }
    }
    this.evaluationCursor = pending.value.next
    await Promise.all(launched)
    return report
  }

  private async expire(digest: string, report: RootEvictionScheduleReport): Promise<boolean> {
    try {
      const result = await this.options.maintenance.expirePending(
        digest,
        this.options.maintenanceGuard
      )
      report.expiredTargets += result.value.expiredTargets.length
      return result.value.pendingTargets.length > 0
    } catch (error) {
      report.failures.push({ digest, phase: 'expiry', error })
      return false
    }
  }

  private launch(digest: string, report: RootEvictionScheduleReport): Promise<void> {
    let finish!: () => void
    const done = new Promise<void>(resolve => {
      finish = resolve
    })
    const job: PhysicalJob = {
      controller: new AbortController(),
      done,
      started: false,
      finish: () => {
        this.jobs.delete(digest)
        finish()
      }
    }
    this.jobs.set(digest, job)
    return this.work
      .run(null, job.controller.signal, async signal => {
        job.started = true
        try {
          await this.evaluate(digest, signal)
        } finally {
          job.finish()
        }
      })
      .catch((error: unknown) => {
        report.failures.push({ digest, phase: 'evaluation', error })
      })
      .finally(() => {
        if (!job.started) job.finish()
      })
  }

  private async evaluate(digest: string, signal: AbortSignal): Promise<void> {
    const automatic = this.automatic!
    const guard = await automatic.guard(digest, signal)
    check(signal)
    outputAssert(
      guard.expectedPolicyDigest === automatic.policyDigest,
      'Installed root scheduler policy changed',
      'context-changed'
    )
    for (const callback of [guard.clock, guard.authorize, guard.contextCurrent])
      outputAssert(
        typeof callback === 'function' && callback.constructor.name !== 'AsyncFunction',
        'Root scheduler callbacks must be synchronous'
      )
    const checked: RootEvictionCommitGuard = {
      expectedPolicyDigest: automatic.policyDigest,
      clock: () => {
        check(signal)
        const now = guard.clock()
        check(signal)
        return now
      },
      authorize: (head, now) => {
        check(signal)
        const value = guard.authorize(head, now)
        check(signal)
        return value
      },
      contextCurrent: (head, now) => {
        check(signal)
        const value = guard.contextCurrent(head, now)
        check(signal)
        return value
      }
    }
    const observed = await automatic.journal.recoverCoordinated(
      digest,
      automatic.contracts,
      checked
    )
    check(signal)
    const revision = observed.head.revision
    const targets = await automatic.evaluate(structuredClone(observed), signal)
    check(signal)
    if (targets.length === 0) return
    await automatic.journal.evaluateChecked(
      { requestDigest: digest, expectedRevision: revision, targets: structuredClone(targets) },
      checked
    )
    check(signal)
  }
}
