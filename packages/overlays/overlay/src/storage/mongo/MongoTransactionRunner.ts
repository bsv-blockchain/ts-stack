import { randomUUID } from 'node:crypto'
import { Binary, type ClientSession, type Db, type Document } from 'mongodb'
import {
  admissionSemanticDigest,
  type AdmissionCommitResult,
  type AdmissionIdentity,
  type AdmissionOperationKey,
  type AdmissionReceipt,
  type AdmissionReconcileResult,
  type StorageScope
} from '../AdmissionStorage.js'
import {
  decodeMongoUint64,
  encodeMongoUint64,
  MongoCollectionNames,
  mongoNodeKey,
  mongoRecordKey
} from './MongoSchema.js'

export interface MongoTransactionRequest {
  key: AdmissionOperationKey
  identity: AdmissionIdentity
  receipt: AdmissionReceipt
}

export interface MongoTransactionOptions {
  /** Total call budget, including claim, body and commit. Range 1..50000 ms. */
  timeoutMS?: number
  signal?: AbortSignal
}

export interface MongoTransactionRunnerOptions {
  maxBodyAttempts?: number
  maxCommitAttempts?: number
  /** Persisted ownership lease; expiry permits a fenced abort, never implies one. */
  leaseMS?: number
  /** Unresolved sessions are retained for same-session commit reconciliation. */
  maxRetainedSessions?: number
}

export interface MongoTransactionContext {
  readonly session: ClientSession
  /** Obtain immediately before EACH database operation; do not cache or omit it. */
  options: () => { session: ClientSession; timeoutMS: number }
  /** Cooperative body gate. Mongo write deadlines use timeoutMS, not signal. */
  readonly signal: AbortSignal
}

interface Operation extends Document {
  _id: string
  semanticDigest: string
  txid: string
  state: 'pending' | 'committed' | 'aborted'
  attemptId: string
  leaseOwner: string
  leaseToken: string
  receipt?: Binary
}

interface Attempt {
  operation: Operation
  session: ClientSession
  phase: 'body' | 'commit' | 'unknown'
  receipt: AdmissionReceipt
  busy: boolean
}

const majority = { w: 'majority' as const, j: true }

function boundedInteger(value: number, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
    throw new Error('Invalid Mongo transaction bound')
  return value
}

function hasLabel(error: unknown, label: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'hasErrorLabel' in error &&
    typeof error.hasErrorLabel === 'function' &&
    error.hasErrorLabel(label) === true
  )
}

function isTransientTransactionError(error: unknown): boolean {
  if (hasLabel(error, 'TransientTransactionError')) return true
  if (typeof error === 'object' && error !== null && 'code' in error && error.code === 112) return true
  return error instanceof Error && error.message.includes('Write conflict')
}

function duplicateKey(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 11000
}

class Budget {
  private readonly controller = new AbortController()
  private readonly timer: ReturnType<typeof setTimeout>
  private readonly deadline: number
  readonly signal: AbortSignal

  constructor(options: MongoTransactionOptions) {
    const timeoutMS = boundedInteger(options.timeoutMS ?? 5000, 1, 50000)
    this.deadline = performance.now() + timeoutMS
    this.signal =
      options.signal === undefined
        ? this.controller.signal
        : AbortSignal.any([this.controller.signal, options.signal])
    this.timer = setTimeout(() => this.controller.abort(new Error('Mongo transaction deadline exceeded')), timeoutMS)
    this.timer.unref()
  }

  remaining(): number {
    this.signal.throwIfAborted()
    const remaining = Math.ceil(this.deadline - performance.now())
    if (remaining <= 0) throw new Error('Mongo transaction deadline exceeded')
    return remaining
  }

  options(): { timeoutMS: number } {
    return { timeoutMS: this.remaining() }
  }

  close(): void {
    clearTimeout(this.timer)
    // Cached operation options must become unusable after the trusted body exits.
    this.controller.abort(new Error('Mongo transaction call ended'))
  }
}

function cloneRequest(request: MongoTransactionRequest): MongoTransactionRequest {
  return {
    key: { ...request.key, scope: { ...request.key.scope } },
    identity: {
      ...request.identity,
      scope: { ...request.identity.scope },
      topics: request.identity.topics.map(topic => ({ ...topic }))
    },
    receipt: copyReceipt(request.receipt)
  }
}

function copyReceipt(receipt: AdmissionReceipt): AdmissionReceipt {
  if (
    receipt.durability !== 'atomic-local' ||
    typeof receipt.steak !== 'string' ||
    !receipt.steak.isWellFormed() ||
    !Array.isArray(receipt.indexes) ||
    receipt.indexes.some(index => typeof index.target !== 'string' || index.target.length === 0 || !index.target.isWellFormed() || (index.state !== 'visible' && index.state !== 'pending')) ||
    (receipt.propagation !== 'not-requested' && receipt.propagation !== 'pending')
  ) throw new Error('Invalid Mongo transaction receipt')
  JSON.parse(receipt.steak)
  const copy: AdmissionReceipt = {
    operationId: receipt.operationId,
    semanticDigest: receipt.semanticDigest,
    durability: 'atomic-local',
    steak: receipt.steak,
    indexes: receipt.indexes.map(index => ({ target: index.target, state: index.state })),
    propagation: receipt.propagation
  }
  if (Buffer.byteLength(JSON.stringify(copy), 'utf8') > 1048576)
    throw new Error('Mongo transaction receipt is too large')
  return copy
}

/**
 * Database-only transaction foundation, NOT an AdmissionStorage adapter. The
 * trusted body must enlist all its reads/writes using context.options(), finish
 * all its work before returning, and perform no uploads, plug-ins or network I/O.
 * The caller remains responsible for admission, read guards, spends and payloads.
 */
export class MongoTransactionRunner {
  private readonly scope: StorageScope
  private readonly owner = randomUUID()
  private readonly attempts = new Map<string, Attempt>()
  private readonly maxBodyAttempts: number
  private readonly maxCommitAttempts: number
  private readonly leaseMS: number
  private readonly maxRetainedSessions: number
  private closed = false
  private reservations = 0
  private calls = 0

  constructor(private readonly db: Db, scope: StorageScope, options: MongoTransactionRunnerOptions = {}) {
    mongoNodeKey(scope)
    this.scope = { ...scope }
    this.maxBodyAttempts = boundedInteger(options.maxBodyAttempts ?? 3, 1, 10)
    this.maxCommitAttempts = boundedInteger(options.maxCommitAttempts ?? 3, 1, 10)
    this.leaseMS = boundedInteger(options.leaseMS ?? 30000, 1, 60000)
    this.maxRetainedSessions = boundedInteger(options.maxRetainedSessions ?? 64, 1, 1024)
  }

  private collection() {
    return this.db.collection<Operation>(MongoCollectionNames.submissionOperations)
  }

  private id(key: AdmissionOperationKey): string {
    if (this.closed) throw new Error('Mongo transaction runner is closed')
    if (mongoNodeKey(key.scope) !== mongoNodeKey(this.scope) || !/^[0-9a-f]{64}$/.test(key.semanticDigest))
      throw new Error('Invalid Mongo transaction operation scope or digest')
    return mongoRecordKey('operation', key.scope.network, key.scope.genesisHash, key.scope.nodeId, key.operationId)
  }

  private async read(id: string, budget: Budget): Promise<Operation | null> {
    return await this.collection().findOne({ _id: id }, { ...budget.options(), readConcern: { level: 'majority' }, readPreference: 'primary' })
  }

  private result(operation: Operation, key: AdmissionOperationKey): AdmissionReconcileResult {
    if (operation.semanticDigest !== key.semanticDigest) return { state: 'rejected', code: 'digest-mismatch' }
    if (operation.state === 'committed') {
      if (!(operation.receipt instanceof Binary)) throw new Error('Committed Mongo operation has no receipt')
      const receipt = copyReceipt(JSON.parse(Buffer.from(operation.receipt.value()).toString('utf8')) as AdmissionReceipt)
      if (receipt.operationId !== key.operationId || receipt.semanticDigest !== key.semanticDigest)
        throw new Error('Corrupt Mongo operation receipt identity')
      return { state: 'committed', receipt }
    }
    return operation.state === 'aborted' ? { state: 'aborted' } : { state: 'pending', attemptId: operation.attemptId }
  }

  private fence(operation: Operation) {
    return { _id: operation._id, state: 'pending' as const, semanticDigest: operation.semanticDigest, attemptId: operation.attemptId, leaseOwner: operation.leaseOwner, leaseToken: operation.leaseToken }
  }

  private async release(attempt: Attempt): Promise<void> {
    this.attempts.delete(attempt.operation.attemptId)
    await attempt.session.endSession()
  }

  private async abort(attempt: Attempt): Promise<void> {
    try {
      if (attempt.session.inTransaction()) await attempt.session.abortTransaction({ timeoutMS: 500 })
    } finally {
      // This is an actual majority write to the row the transaction also writes.
      // If it succeeds, a competing late commit cannot subsequently win.
      try {
        await this.collection().updateOne(this.fence(attempt.operation), [
          { $set: { state: 'aborted', guard: randomUUID(), updatedAt: '$$NOW' } }
        ], { writeConcern: majority, timeoutMS: 1000 })
      } finally {
        await this.release(attempt)
      }
    }
  }

  private async commit(attempt: Attempt, budget: Budget): Promise<AdmissionCommitResult> {
    attempt.phase = 'commit'
    attempt.busy = true
    try {
      for (let index = 0; index < this.maxCommitAttempts; index += 1) {
        try {
          await attempt.session.commitTransaction({ timeoutMS: budget.remaining() })
          await this.release(attempt)
          return { state: 'committed', receipt: copyReceipt(attempt.receipt) }
        } catch {
          // Unknown wins over any accompanying transient label. Never rerun its body.
          // Even an unexpected unlabeled failure after invocation stays pending.
          // Reconciliation, not error wording, determines its final outcome.
          attempt.phase = 'unknown'
          if (budget.signal.aborted) break
        }
      }
      return { state: 'pending', attemptId: attempt.operation.attemptId }
    } finally {
      attempt.busy = false
    }
  }

  private async claim(previous: Operation, request: MongoTransactionRequest, receipt: AdmissionReceipt, budget: Budget): Promise<Attempt | null> {
    if (this.attempts.size + this.reservations >= this.maxRetainedSessions)
      throw new Error('Mongo unresolved transaction capacity reached')
    this.reservations += 1
    try {
      const attemptId = randomUUID()
      const operation = await this.collection().findOneAndUpdate({ _id: previous._id, semanticDigest: request.key.semanticDigest, state: 'aborted', leaseToken: previous.leaseToken }, [{ $set: { state: 'pending', attemptId, leaseOwner: this.owner, leaseToken: encodeMongoUint64((BigInt(decodeMongoUint64(previous.leaseToken)) + BigInt(1)).toString()), guard: randomUUID(), leaseUntil: { $dateAdd: { startDate: '$$NOW', unit: 'millisecond', amount: this.leaseMS } }, updatedAt: '$$NOW' } }], { ...budget.options(), writeConcern: majority, returnDocument: 'after' })
      if (operation === null) return null
      const session = this.db.client.startSession()
      const attempt: Attempt = { operation, session, phase: 'body', receipt, busy: true }
      this.attempts.set(attemptId, attempt)
      return attempt
    } finally {
      this.reservations -= 1
    }
  }

  async run(request: MongoTransactionRequest, body: (context: MongoTransactionContext) => Promise<void>, options: MongoTransactionOptions = {}): Promise<AdmissionCommitResult> {
    request = cloneRequest(request)
    const id = this.id(request.key)
    const receipt = copyReceipt(request.receipt)
    const rejected = this.rejectRun(request, receipt)
    if (rejected !== undefined) return rejected
    const budget = new Budget(options)
    this.calls += 1
    try {
      for (let bodyIndex = 0; bodyIndex < this.maxBodyAttempts; bodyIndex += 1) {
        const completed = await this.runBodyAttempt(id, request, receipt, body, budget, bodyIndex)
        if (completed !== undefined) return completed
      }
      throw new Error('Mongo transaction attempt limit reached')
    } finally {
      this.calls -= 1
      budget.close()
    }
  }

  private rejectRun(
    request: MongoTransactionRequest,
    receipt: AdmissionReceipt
  ): AdmissionCommitResult | undefined {
    if (
      admissionSemanticDigest(request.identity) !== request.key.semanticDigest ||
      mongoNodeKey(request.identity.scope) !== mongoNodeKey(this.scope)
    )
      return { state: 'rejected', code: 'digest-mismatch' }
    if (receipt.operationId !== request.key.operationId || receipt.semanticDigest !== request.key.semanticDigest)
      return { state: 'rejected', code: 'invalid-plan' }
    return undefined
  }

  private async ensureClaimableRow(
    id: string,
    request: MongoTransactionRequest,
    budget: Budget
  ): Promise<Operation> {
    let previous = await this.read(id, budget)
    if (previous === null) {
      try {
        await this.collection().insertOne({ _id: id, schemaVersion: 1, ...this.scope, operationId: request.key.operationId, semanticDigest: request.key.semanticDigest, txid: request.identity.txid, state: 'aborted', attemptId: randomUUID(), leaseOwner: this.owner, leaseToken: encodeMongoUint64('0'), leaseUntil: new Date(0), guard: randomUUID(), createdAt: new Date(), updatedAt: new Date() }, { ...budget.options(), writeConcern: majority })
      } catch (error) {
        if (!duplicateKey(error)) throw error
      }
      previous = await this.read(id, budget)
      if (previous === null) throw new Error('Mongo operation claim was not visible')
    }
    return previous
  }

  private async observeClaimWinner(
    id: string,
    request: MongoTransactionRequest,
    budget: Budget
  ): Promise<AdmissionCommitResult | undefined> {
    const winner = await this.read(id, budget)
    if (winner === null) throw new Error('Mongo operation claim disappeared')
    const result = this.result(winner, request.key)
    return result.state === 'aborted' ? undefined : result
  }

  private async executeTrustedBody(
    attempt: Attempt,
    receipt: AdmissionReceipt,
    body: (context: MongoTransactionContext) => Promise<void>,
    budget: Budget,
    bodyIndex: number
  ): Promise<AdmissionCommitResult | undefined> {
    const { session, operation } = attempt
    let bodyActive = true
    const context: MongoTransactionContext = { session, signal: budget.signal, options: () => {
      if (!bodyActive || !session.inTransaction()) throw new Error('Mongo transaction body is no longer active')
      return { session, ...budget.options() }
    } }
    try {
      session.startTransaction({ readConcern: { level: 'snapshot' }, writeConcern: majority, readPreference: 'primary', maxCommitTimeMS: budget.remaining() })
      const guarded = await this.collection().updateOne({ ...this.fence(operation), $expr: { $gt: ['$leaseUntil', '$$NOW'] } }, { $set: { guard: randomUUID() } }, context.options())
      if (guarded.modifiedCount !== 1) throw new Error('Mongo transaction ownership lost')
      // Never end a session while its body is still running. Trusted bodies
      // await every bounded database operation and observe the context gate.
      await body(context)
      const saved = await this.collection().updateOne(this.fence(operation), { $set: { state: 'committed', receipt: new Binary(Buffer.from(JSON.stringify(receipt), 'utf8')), guard: randomUUID() }, $currentDate: { updatedAt: true } }, context.options())
      if (saved.modifiedCount !== 1) throw new Error('Mongo transaction ownership lost')
      bodyActive = false
      return await this.commit(attempt, budget)
    } catch (error) {
      bodyActive = false
      await this.abort(attempt)
      if (!isTransientTransactionError(error) || bodyIndex + 1 >= this.maxBodyAttempts) throw error
      return undefined
    } finally {
      bodyActive = false
      attempt.busy = false
    }
  }

  private async runBodyAttempt(
    id: string,
    request: MongoTransactionRequest,
    receipt: AdmissionReceipt,
    body: (context: MongoTransactionContext) => Promise<void>,
    budget: Budget,
    bodyIndex: number
  ): Promise<AdmissionCommitResult | undefined> {
    const previous = await this.ensureClaimableRow(id, request, budget)
    const existing = this.result(previous, request.key)
    if (existing.state !== 'aborted') return existing
    const attempt = await this.claim(previous, request, receipt, budget)
    if (attempt === null) return await this.observeClaimWinner(id, request, budget)
    return await this.executeTrustedBody(attempt, receipt, body, budget, bodyIndex)
  }

  async reconcile(key: AdmissionOperationKey, attemptId?: string, options: MongoTransactionOptions = {}): Promise<AdmissionReconcileResult> {
    key = { ...key, scope: { ...key.scope } }
    const id = this.id(key)
    const budget = new Budget(options)
    this.calls += 1
    try {
      let operation = await this.read(id, budget)
      // Absence does not prove abort, including after process restart.
      if (operation === null) return { state: 'pending', attemptId: attemptId ?? 'unlocated' }
      const result = this.result(operation, key)
      if (result.state !== 'pending') {
        const retained = this.attempts.get(operation.attemptId)
        if (retained !== undefined && !retained.busy) await this.release(retained)
        return result
      }
      if (attemptId !== undefined && attemptId !== operation.attemptId) return { state: 'pending', attemptId }
      const retained = this.attempts.get(operation.attemptId)
      if (retained !== undefined) {
        if (retained.busy || retained.phase === 'body') return result
        return await this.commit(retained, budget)
      }
      // A successful majority CAS, not elapsed time or a missing record, proves
      // an orphan cannot commit: its transaction must write this same row first.
      const aborted = await this.collection().findOneAndUpdate({ ...this.fence(operation), $expr: { $lte: ['$leaseUntil', '$$NOW'] } }, [{ $set: { state: 'aborted', guard: randomUUID(), updatedAt: '$$NOW' } }], { ...budget.options(), writeConcern: majority, returnDocument: 'after' })
      if (aborted !== null) return { state: 'aborted' }
      operation = await this.read(id, budget)
      return operation === null ? result : this.result(operation, key)
    } finally {
      this.calls -= 1
      budget.close()
    }
  }

  /** Shutdown only. Persisted receipt/fenced orphan reconciliation survives it. */
  async close(): Promise<void> {
    if (this.calls > 0 || this.reservations > 0 || [...this.attempts.values()].some(attempt => attempt.busy)) throw new Error('Cannot close Mongo transaction runner during a call')
    this.closed = true
    await Promise.all([...this.attempts.values()].map(async attempt => await this.release(attempt)))
  }
}
