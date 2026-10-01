import {
  OutputProtocolError,
  canonicalOutputJSON,
  closedOutputObject,
  outputAssert,
  outputHex32
} from '@bsv/sdk'
import type { ProposalMaintenanceItem, ProposalMaintenanceSource } from './ProposalMaintenance.js'

/** Trusted existing-reservation recovery only; there is deliberately no fresh finalize operation. */
export interface ProposalMaintenanceService {
  expire(channelKey: string): Promise<void>
  reconcile(proposalId: string): Promise<void>
}
export interface ProposalSchedulerOptions {
  source: ProposalMaintenanceSource
  service: ProposalMaintenanceService
  pageSize?: number
  maximumRecoveries?: number
  intervalMs?: number
}
export interface ProposalScheduleReport {
  scanned: number
  expiryChecks: number
  /** Newly owned jobs; shutdown can cancel one before its deferred service invocation. */
  recoveriesStarted: number
  recoveryCallsCompleted: number
  /** Actual unsettled or not-yet-collected jobs; a timeout is never a physical completion. */
  retainedJobs: number
  failures: { key: string; phase: 'expiry' | 'recovery'; error: unknown }[]
}
interface Job {
  done: Promise<void>
  settled: boolean
  failed: boolean
  error?: unknown
}
const stopped = 'Proposal scheduling stopped'
function emptyReport(): ProposalScheduleReport {
  return {
    scanned: 0,
    expiryChecks: 0,
    recoveriesStarted: 0,
    recoveryCallsCompleted: 0,
    retainedJobs: 0,
    failures: []
  }
}
function item(input: unknown): ProposalMaintenanceItem {
  closedOutputObject(input, ['channelKey', 'proposalId', 'state'])
  outputAssert(
    typeof input.channelKey === 'string' && input.channelKey.length > 0,
    'Invalid proposal maintenance channel'
  )
  canonicalOutputJSON(input.channelKey, { bytes: 16384 })
  outputAssert(
    input.state === 'active' || input.state === 'finalizing',
    'Invalid proposal maintenance state'
  )
  return {
    channelKey: input.channelKey,
    proposalId: outputHex32(input.proposalId),
    state: input.state
  }
}

/**
 * Opt-in bounded startup/periodic recovery with independent expiry scans.
 * Unsettled recovery jobs keep their slots and cannot block inventory/expiry.
 * The source owns durable inventory, the service owns validation and commits,
 * and the host owns storage/configuration lifetime. No wallet or fresh effect
 * initiation is exposed by these ports. Observe start() and drain stop() before
 * closing any dependency. A hung dependency keeps shutdown pending.
 */
export class ProposalScheduler {
  private readonly source: ProposalMaintenanceSource
  private readonly service: ProposalMaintenanceService
  private readonly pageSize: number
  private readonly maximum: number
  private readonly interval: number
  private readonly jobs = new Map<string, Job>()
  private cursor?: string
  private scanning?: Promise<ProposalScheduleReport>
  private loop?: Promise<void>
  private stopping?: Promise<ProposalScheduleReport>
  private stopped = false
  private wakeRequested = false
  private releaseWait?: () => void

  constructor(options: ProposalSchedulerOptions) {
    outputAssert(
      options.source.durability === 'durable',
      'Proposal recovery inventory must be durable'
    )
    this.source = { durability: 'durable', page: options.source.page.bind(options.source) }
    this.service = {
      expire: options.service.expire.bind(options.service),
      reconcile: options.service.reconcile.bind(options.service)
    }
    this.pageSize = options.pageSize ?? 64
    this.maximum = options.maximumRecoveries ?? 4
    this.interval = options.intervalMs ?? 1000
    for (const [value, maximum] of [
      [this.pageSize, 256],
      [this.maximum, 64],
      [this.interval, 60000]
    ])
      outputAssert(
        Number.isSafeInteger(value) && value >= 1 && value <= maximum,
        'Invalid proposal scheduler bound'
      )
  }

  /** Concurrent callers share one bounded page; source/expiry failures never turn into empty success. */
  async runOnce(): Promise<ProposalScheduleReport> {
    outputAssert(!this.stopped, stopped, 'cancelled')
    if (!this.scanning)
      this.scanning = this.scan().finally(() => {
        this.scanning = undefined
      })
    return await this.scanning
  }

  /** Observe completion; scan or observer failure stops intake. The observer must not await stop(). */
  async start(onPass: (report: ProposalScheduleReport) => void | Promise<void>): Promise<void> {
    outputAssert(!this.stopped, stopped, 'cancelled')
    if (!this.loop) this.loop = this.runLoop(onPass).finally(() => this.halt())
    await this.loop
  }
  /** Coalesced hint only. Startup and periodic scans independently recover lost hints. */
  wake(): void {
    if (this.stopped) return
    this.wakeRequested = true
    this.releaseWait?.()
  }

  /** Stop intake and physically drain; the final report preserves late recovery failures. */
  stop(): Promise<ProposalScheduleReport> {
    if (!this.stopping) {
      this.halt()
      this.stopping = this.drain()
    }
    return this.stopping
  }
  private halt(): void {
    this.stopped = true
    this.releaseWait?.()
  }
  private async drain(): Promise<ProposalScheduleReport> {
    await Promise.allSettled([this.scanning, this.loop])
    await Promise.all([...this.jobs.values()].map(job => job.done))
    const report = emptyReport()
    this.collect(report)
    return report
  }
  private collect(report: ProposalScheduleReport): void {
    for (const [key, job] of this.jobs) {
      if (!job.settled) continue
      this.jobs.delete(key)
      if (job.failed) report.failures.push({ key, phase: 'recovery', error: job.error })
      else report.recoveryCallsCompleted++
    }
    report.retainedJobs = this.jobs.size
  }
  private launch(proposalId: string): void {
    const job: Job = { done: Promise.resolve(), settled: false, failed: false }
    this.jobs.set(proposalId, job)
    // Defer invocation until the job is physically registered; synchronous throws
    // and asynchronous rejections are retained identically for the next report.
    job.done = Promise.resolve()
      .then(() => {
        if (this.stopped) throw new OutputProtocolError('cancelled', stopped)
        return this.service.reconcile(proposalId)
      })
      .then(
        () => {
          job.settled = true
        },
        (error: unknown) => {
          job.failed = true
          job.error = error
          job.settled = true
        }
      )
  }
  private async scan(): Promise<ProposalScheduleReport> {
    const report = emptyReport()
    const page = await this.source.page(this.pageSize, this.cursor)
    closedOutputObject(page, ['items'], ['next'])
    outputAssert(
      Array.isArray(page.items) && page.items.length <= this.pageSize,
      'Invalid proposal maintenance page'
    )
    const next = page.next
    if (next !== undefined) {
      outputAssert(
        typeof next === 'string' && next.length > 0,
        'Invalid proposal maintenance continuation'
      )
      canonicalOutputJSON(next, { bytes: 32768 })
      outputAssert(
        next !== this.cursor,
        'Proposal maintenance continuation did not advance',
        'unavailable'
      )
    }
    // Validate/own the whole bounded page before any effect.
    const items = page.items.map(item)
    // Keep completed outcomes queued if inventory fails; only consume them once
    // this pass can return a report to its observer.
    this.collect(report)
    for (const candidate of items) {
      if (this.stopped) break
      report.scanned++
      if (candidate.state === 'active') {
        try {
          await this.service.expire(candidate.channelKey)
          report.expiryChecks++
        } catch (error) {
          report.failures.push({ key: candidate.channelKey, phase: 'expiry', error })
        }
      } else if (this.jobs.size < this.maximum && !this.jobs.has(candidate.proposalId)) {
        this.launch(candidate.proposalId)
        report.recoveriesStarted++
      }
    }
    this.cursor = next
    this.collect(report)
    return report
  }
  private async runLoop(
    onPass: (report: ProposalScheduleReport) => void | Promise<void>
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
}
