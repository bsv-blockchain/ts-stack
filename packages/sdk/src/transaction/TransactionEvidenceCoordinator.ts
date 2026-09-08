import type ChainTracker from './ChainTracker.js'
import type BdkVerifierInterface from './BdkVerifierInterface.js'
import { scriptVerificationBackend } from './ScriptVerificationBackend.js'
import LockingScript from '../script/LockingScript.js'
import { EvidenceScriptWork, withEvidenceScriptWork } from './EvidenceScriptWork.js'
import {
  defaultTransactionEvidenceLimits,
  evidenceError,
  assertEvidenceUnchanged,
  parseEvidence,
  TransactionEvidenceError,
  type EvidenceCandidate,
  type TransactionEvidence,
  type TransactionEvidenceLimits,
  type VerifiedTransactionOutput
} from './TransactionEvidence.js'

/** Caller-controlled trust configuration; never populate this from lookup metadata. */
export interface TransactionEvidenceContext {
  chainTracker: ChainTracker
  /** Network/genesis identifier or an explicit application chain namespace. */
  chainNamespace: string
  /** Semantic verification policy/backend version; change it when policy changes. */
  policyId: string
  verifier?: BdkVerifierInterface
}

export interface TransactionEvidenceCoordinatorOptions extends TransactionEvidenceContext {
  limits?: Partial<TransactionEvidenceLimits>
}

interface Anchor {
  root: string
  height: number
}
interface Positive {
  scripts: string[]
  anchors: Anchor[]
  observedHeight?: number
  expiresAt: number
  bytes: number
}
interface Consumer {
  outputIndex: number
  resolve: (value: VerifiedTransactionOutput) => void
  reject: (error: TransactionEvidenceError) => void
  detach: () => void
}
interface Work {
  txid: string
  revision: number
  controller: AbortController
  candidates: EvidenceCandidate[]
  receipts: Set<string>
  consumers: Set<Consumer>
  timer: ReturnType<typeof setTimeout>
  expiresAt: number
  running: boolean
}
interface ChainCall {
  controller: AbortController
  owners: number
  promise: Promise<boolean | number | string>
}

function outcome(error: unknown): TransactionEvidenceError {
  return evidenceError(error)
}

/**
 * Bounded, process-local transaction evidence work sharing. This is independent of
 * lookup services, certificates and trust ratings. Positive reuse always checks
 * canonical anchors again; ChainTracker remains the caller's trusted chain source.
 * Synchronous parsing/script execution is byte/memory bounded, not preemptible.
 */
export class TransactionEvidenceCoordinator {
  private readonly scriptWork: EvidenceScriptWork
  readonly limits: Readonly<TransactionEvidenceLimits>
  private context: TransactionEvidenceContext
  private marker: string | number | undefined
  private backend: BdkVerifierInterface | undefined
  private revision = 0
  private disposed = false
  private readonly work = new Map<string, Work>()
  private readonly positives = new Map<string, Positive>()
  private readonly chainCalls = new Map<string, ChainCall>()
  private pendingChainCalls = 0
  private activeAttempts = 0
  private consumers = 0
  private retainedBytes = 0
  private expiryTimer?: ReturnType<typeof setTimeout>

  constructor(options: TransactionEvidenceCoordinatorOptions) {
    this.context = this.validateContext(options)
    this.limits = Object.freeze({ ...defaultTransactionEvidenceLimits, ...options.limits })
    for (const value of Object.values(this.limits)) {
      if (!Number.isSafeInteger(value) || value <= 0) throw new TransactionEvidenceError('limit')
    }
    this.scriptWork = new EvidenceScriptWork(this.limits)
    this.marker = this.context.chainTracker.getVerificationContext?.()
    this.backend = this.context.verifier ?? scriptVerificationBackend()
  }

  private validateContext(context: TransactionEvidenceContext): TransactionEvidenceContext {
    if (
      context.chainTracker == null ||
      typeof context.chainTracker.isValidRootForHeight !== 'function' ||
      typeof context.chainTracker.currentHeight !== 'function' ||
      context.chainNamespace.length === 0 ||
      context.policyId.length === 0
    ) {
      throw new TransactionEvidenceError('invalid-evidence')
    }
    return {
      chainTracker: context.chainTracker,
      chainNamespace: context.chainNamespace,
      policyId: context.policyId,
      verifier: context.verifier
    }
  }

  /** Explicit session/network/policy change. Stale in-flight work cannot publish. */
  setContext(context: TransactionEvidenceContext): void {
    const next = this.validateContext(context)
    this.invalidate(new TransactionEvidenceError('context-changed'))
    this.context = next
    this.marker = next.chainTracker.getVerificationContext?.()
    this.backend = next.verifier ?? scriptVerificationBackend()
  }

  dispose(): void {
    this.disposed = true
    this.invalidate(new TransactionEvidenceError('disposed'))
  }

  private invalidate(error: TransactionEvidenceError): void {
    this.revision++
    this.scriptWork.clear()
    for (const job of this.work.values()) this.finish(job, undefined, error)
    for (const txid of this.positives.keys()) this.removePositive(txid)
    clearTimeout(this.expiryTimer)
    this.expiryTimer = undefined
  }

  private synchronize(): void {
    if (this.disposed) throw new TransactionEvidenceError('disposed')
    const marker = this.context.chainTracker.getVerificationContext?.()
    const backend = this.context.verifier ?? scriptVerificationBackend()
    if (marker !== this.marker || backend !== this.backend) {
      this.invalidate(new TransactionEvidenceError('context-changed'))
      this.marker = marker
      this.backend = backend
    }
  }

  private check(job: Work, signal: AbortSignal): void {
    this.synchronize()
    if (job.revision !== this.revision) throw new TransactionEvidenceError('context-changed')
    if (Date.now() >= job.expiresAt) throw new TransactionEvidenceError('timeout')
    if (signal.aborted || job.consumers.size === 0)
      throw outcome(signal.reason ?? new TransactionEvidenceError('cancelled'))
  }

  /** Snapshot intake is synchronous up to the returned Promise's first await. */
  async verify(
    evidence: TransactionEvidence,
    options: { signal?: AbortSignal } = {}
  ): Promise<VerifiedTransactionOutput> {
    this.synchronize()
    this.prune()
    if (options.signal?.aborted === true) throw new TransactionEvidenceError('cancelled')
    if (this.consumers >= this.limits.consumers) throw new TransactionEvidenceError('limit')
    let candidate: EvidenceCandidate
    try {
      candidate = parseEvidence(evidence, this.limits)
    } catch (error) {
      throw outcome(error)
    }
    let job = this.work.get(candidate.txid)
    if (job === undefined) {
      if (this.work.size >= this.limits.pendingTransactions)
        throw new TransactionEvidenceError('limit')
      const controller = new AbortController()
      const created: Work = {
        txid: candidate.txid,
        revision: this.revision,
        controller,
        candidates: [],
        receipts: new Set(),
        consumers: new Set(),
        running: false,
        timer: setTimeout(
          () => this.finish(created, undefined, new TransactionEvidenceError('timeout')),
          this.limits.requestTimeoutMs
        ),
        expiresAt: Date.now() + this.limits.requestTimeoutMs
      }
      job = created
      this.work.set(job.txid, job)
    }
    if (!job.receipts.has(candidate.receipt)) {
      if (
        job.receipts.size >= this.limits.candidatesPerTransaction ||
        this.retainedBytes + candidate.byteLength > this.limits.retainedBytes
      ) {
        if (job.consumers.size === 0)
          this.finish(job, undefined, new TransactionEvidenceError('limit'))
        throw new TransactionEvidenceError('limit')
      }
      job.receipts.add(candidate.receipt)
      job.candidates.push(candidate)
      this.retainedBytes += candidate.byteLength
    }
    const current = job
    return await new Promise<VerifiedTransactionOutput>((resolve, reject) => {
      const cancel = (): void => {
        this.removeConsumer(current, consumer)
        reject(new TransactionEvidenceError('cancelled'))
        if (current.consumers.size === 0)
          this.finish(current, undefined, new TransactionEvidenceError('cancelled'))
      }
      const consumer: Consumer = {
        outputIndex: candidate.outputIndex,
        resolve,
        reject,
        detach: () => options.signal?.removeEventListener('abort', cancel)
      }
      current.consumers.add(consumer)
      this.consumers++
      options.signal?.addEventListener('abort', cancel, { once: true })
      this.pump()
    })
  }

  private removeConsumer(job: Work, consumer: Consumer): void {
    if (!job.consumers.delete(consumer)) return
    consumer.detach()
    this.consumers--
  }

  private finish(
    job: Work,
    positive?: Positive,
    error = new TransactionEvidenceError('invalid-evidence')
  ): void {
    if (this.work.get(job.txid) !== job) return
    this.work.delete(job.txid)
    clearTimeout(job.timer)
    for (const candidate of job.candidates) this.retainedBytes -= candidate.byteLength
    job.candidates = []
    for (const consumer of job.consumers) {
      this.removeConsumer(job, consumer)
      if (positive === undefined) consumer.reject(error)
      else
        consumer.resolve({
          txid: job.txid,
          outputIndex: consumer.outputIndex,
          outpoint: `${job.txid}.${consumer.outputIndex}`,
          lockingScript: LockingScript.fromHex(positive.scripts[consumer.outputIndex])
        })
    }
    job.controller.abort(error)
  }

  private pump(): void {
    let running = [...this.work.values()].filter(job => job.running).length
    for (const job of this.work.values()) {
      if (
        running >= this.limits.concurrentTransactions ||
        this.activeAttempts >= this.limits.concurrentTransactions
      )
        break
      if (job.running) continue
      job.running = true
      running++
      void this.run(job).finally(() => this.pump())
    }
  }

  private async run(job: Work): Promise<void> {
    let error = new TransactionEvidenceError('invalid-evidence')
    try {
      const cached = this.positives.get(job.txid)
      if (cached !== undefined) {
        try {
          await this.attempt(job, async signal => await this.recheck(job, cached, signal))
          this.check(job, job.controller.signal)
          this.finish(job, cached)
          return
        } catch (failure) {
          error = outcome(failure)
          this.removePositive(job.txid)
        }
      }
      while (job.candidates.length > 0 && !job.controller.signal.aborted) {
        const candidate = job.candidates.shift()!
        try {
          const positive = await this.attempt(
            job,
            async signal => {
              const token = await this.contextToken(job, signal)
              const anchors = new Map<string, Anchor>()
              let observedHeight: number | undefined
              const tracker: ChainTracker = {
                isValidRootForHeight: async (root, height) => {
                  const valid = await this.chainCall(
                    job,
                    `root:${height}:${root}`,
                    signal,
                    root,
                    height
                  )
                  if (valid === true) anchors.set(`${height}:${root}`, { root, height })
                  return valid === true
                },
                currentHeight: async () => {
                  const height = await this.chainCall(job, 'height', signal)
                  if (typeof height !== 'number' || !Number.isSafeInteger(height) || height < 0)
                    throw new TransactionEvidenceError('invalid-evidence')
                  observedHeight = Math.max(observedHeight ?? 0, height)
                  return height
                }
              }
              this.check(job, signal)
              const valid = await withEvidenceScriptWork(
                candidate.tx,
                {
                  work: this.scriptWork,
                  signal,
                  check: () => this.check(job, signal)
                },
                async () =>
                  await candidate.tx.verify(
                    tracker,
                    undefined,
                    this.limits.scriptMemoryBytes,
                    this.backend
                  )
              )
              this.check(job, signal)
              assertEvidenceUnchanged(candidate)
              if (valid !== true || anchors.size === 0)
                throw new TransactionEvidenceError('invalid-evidence')
              const scripts = candidate.tx.outputs.map(output => output.lockingScript.toHex())
              const positive: Positive = {
                scripts,
                anchors: [...anchors.values()],
                observedHeight,
                expiresAt: Date.now() + this.limits.cacheAgeMs,
                bytes:
                  scripts.reduce((total, script) => total + script.length / 2, 0) +
                  anchors.size * 40
              }
              await this.recheck(job, positive, signal, token)
              assertEvidenceUnchanged(candidate)
              return positive
            },
            () => {
              this.retainedBytes -= candidate.byteLength
            }
          )
          this.check(job, job.controller.signal)
          this.cache(job.txid, positive)
          this.finish(job, positive)
          return
        } catch (failure) {
          error = outcome(failure)
        }
      }
    } catch (failure) {
      error = outcome(failure)
    }
    this.finish(job, undefined, error)
  }

  private async attempt<T>(
    job: Work,
    operation: (signal: AbortSignal) => Promise<T>,
    settled?: () => void
  ): Promise<T> {
    if (this.activeAttempts >= this.limits.concurrentTransactions) {
      settled?.()
      throw new TransactionEvidenceError('limit')
    }
    this.activeAttempts++
    const controller = new AbortController()
    const deadline = Date.now() + this.limits.attemptTimeoutMs
    const abort = (): void => controller.abort(job.controller.signal.reason)
    job.controller.signal.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(
      () => controller.abort(new TransactionEvidenceError('timeout')),
      this.limits.attemptTimeoutMs
    )
    let rejectAbort: () => void = () => {}
    const cancelled = new Promise<never>((_resolve, reject) => {
      rejectAbort = () => reject(outcome(controller.signal.reason))
      controller.signal.addEventListener('abort', rejectAbort, { once: true })
    })
    // Keep non-abortable backend work counted until its actual Promise settles.
    const pending = operation(controller.signal)
      .then(value => {
        if (Date.now() >= deadline) throw new TransactionEvidenceError('timeout')
        return value
      })
      .finally(() => {
        settled?.()
        this.activeAttempts--
        this.pump()
      })
    try {
      return await Promise.race([pending, cancelled])
    } finally {
      clearTimeout(timer)
      job.controller.signal.removeEventListener('abort', abort)
      controller.signal.removeEventListener('abort', rejectAbort)
    }
  }

  private async chainCall(
    job: Work,
    key: string,
    signal: AbortSignal,
    root?: string,
    height?: number
  ): Promise<boolean | number | string> {
    this.check(job, signal)
    const scopedKey = `${job.revision}:${key}`
    let call = this.chainCalls.get(scopedKey)
    if (call === undefined) {
      if (this.pendingChainCalls >= this.limits.pendingChainCalls)
        throw new TransactionEvidenceError('limit')
      const controller = new AbortController()
      const tracker = this.context.chainTracker
      const created: ChainCall = { controller, owners: 0, promise: Promise.resolve(false) }
      this.pendingChainCalls++
      created.promise = Promise.resolve()
        .then(async () => {
          if (controller.signal.aborted) throw new TransactionEvidenceError('cancelled')
          if (key === 'context-token')
            return await tracker.getVerificationContextToken!(controller.signal)
          return root === undefined
            ? await tracker.currentHeight(controller.signal)
            : await tracker.isValidRootForHeight(root, height!, controller.signal)
        })
        .finally(() => {
          this.pendingChainCalls--
          if (this.chainCalls.get(scopedKey) === created) this.chainCalls.delete(scopedKey)
        })
      call = created
      this.chainCalls.set(scopedKey, created)
    }
    call.owners++
    const owned = call
    let abort: () => void = () => {}
    const cancelled = new Promise<never>((_resolve, reject) => {
      abort = () => reject(outcome(signal.reason))
      signal.addEventListener('abort', abort, { once: true })
    })
    try {
      const value = await Promise.race([owned.promise, cancelled])
      this.check(job, signal)
      if (root !== undefined && value !== true) this.invalidateAnchor(root, height!)
      return value
    } finally {
      signal.removeEventListener('abort', abort)
      owned.owners--
      if (owned.owners === 0) {
        if (this.chainCalls.get(scopedKey) === owned) this.chainCalls.delete(scopedKey)
        owned.controller.abort()
      }
    }
  }

  private async contextToken(job: Work, signal: AbortSignal): Promise<string | undefined> {
    if (this.context.chainTracker.getVerificationContextToken === undefined) return undefined
    const token = await this.chainCall(job, 'context-token', signal)
    if (typeof token !== 'string' || token.length === 0)
      throw new TransactionEvidenceError('invalid-evidence')
    if (token.length > 4096) throw new TransactionEvidenceError('limit')
    return token
  }

  private async recheck(
    job: Work,
    positive: Positive,
    signal: AbortSignal,
    token?: string
  ): Promise<void> {
    const before = token ?? (await this.contextToken(job, signal))
    for (const anchor of positive.anchors) {
      if (
        (await this.chainCall(
          job,
          `root:${anchor.height}:${anchor.root}`,
          signal,
          anchor.root,
          anchor.height
        )) !== true
      ) {
        throw new TransactionEvidenceError('invalid-evidence')
      }
    }
    if (positive.observedHeight !== undefined) {
      const height = await this.chainCall(job, 'height', signal)
      if (typeof height !== 'number' || height < positive.observedHeight)
        throw new TransactionEvidenceError('invalid-evidence')
    }
    if ((await this.contextToken(job, signal)) !== before)
      throw new TransactionEvidenceError('context-changed')
    this.check(job, signal)
  }

  private invalidateAnchor(root: string, height: number): void {
    this.scriptWork.clear()
    for (const [txid, positive] of this.positives) {
      if (positive.anchors.some(anchor => anchor.root === root && anchor.height === height))
        this.removePositive(txid)
    }
  }

  private removePositive(txid: string): void {
    const positive = this.positives.get(txid)
    if (positive === undefined) return
    this.retainedBytes -= positive.bytes
    this.positives.delete(txid)
  }

  private cache(txid: string, positive: Positive): void {
    this.removePositive(txid)
    this.prune()
    while (
      this.positives.size > 0 &&
      (this.positives.size >= this.limits.cacheEntries ||
        this.retainedBytes + positive.bytes > this.limits.retainedBytes)
    ) {
      this.removePositive(this.positives.keys().next().value!)
    }
    if (this.retainedBytes + positive.bytes <= this.limits.retainedBytes) {
      this.positives.set(txid, positive)
      this.retainedBytes += positive.bytes
      this.scheduleExpiry()
    }
  }

  private prune(): void {
    for (const [txid, positive] of this.positives)
      if (positive.expiresAt <= Date.now()) this.removePositive(txid)
  }

  private scheduleExpiry(): void {
    clearTimeout(this.expiryTimer)
    const expiresAt = Math.min(...[...this.positives.values()].map(value => value.expiresAt))
    if (!Number.isFinite(expiresAt)) return
    this.expiryTimer = setTimeout(
      () => {
        this.prune()
        this.scheduleExpiry()
      },
      Math.max(1, expiresAt - Date.now())
    )
    this.expiryTimer.unref?.()
  }

  /** Payload-free local diagnostics; pending calls include abandoned, non-abortable I/O. */
  getStats(): {
    pendingTransactions: number
    consumers: number
    cachedTransactions: number
    retainedBytes: number
    pendingChainCalls: number
    activeAttempts: number
  } {
    this.prune()
    return {
      pendingTransactions: this.work.size,
      consumers: this.consumers,
      cachedTransactions: this.positives.size,
      retainedBytes: this.retainedBytes,
      pendingChainCalls: this.pendingChainCalls,
      activeAttempts: this.activeAttempts
    }
  }
}
