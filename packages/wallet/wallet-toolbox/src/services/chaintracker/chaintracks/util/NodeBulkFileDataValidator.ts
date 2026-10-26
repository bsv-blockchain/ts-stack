import * as path from 'node:path'
import { Worker } from 'node:worker_threads'
import {
  BulkFileDataValidationError,
  type BulkFileDataValidationRequest,
  type BulkFileDataValidationResult,
  type BulkFileDataValidatorApi,
  type BulkFileDataValidatorStats
} from '../Api/BulkFileDataValidatorApi'
import { normalizeBulkFileDataValidationRequest } from './InlineBulkFileDataValidator'

const MAX_VALIDATION_WORKERS = 32
const MAX_VALIDATION_QUEUE = 1024
const MAX_TASK_TIMEOUT_MSECS = 60 * 60 * 1000
const MAX_HEADER_BYTES = 100_000 * 80
const SHA256_BASE64 = /^[A-Za-z0-9+/]{43}=$/
const HEX_32_BYTES = /^[0-9a-f]{64}$/

export interface NodeBulkFileDataValidatorOptions {
  /** Number of validation workers. Defaults to one to bound CPU usage. */
  maxWorkers?: number
  /** Maximum number of waiting validations. Defaults to eight. */
  maxQueue?: number
  /** Per-object validation deadline. Defaults to two minutes. */
  taskTimeoutMsecs?: number
  /** Test-only worker entry override. */
  workerPath?: string
}

interface ValidationTask {
  id: number
  request: BulkFileDataValidationRequest
  startedAt: number
  resolve: (result: BulkFileDataValidationResult) => void
  reject: (error: Error) => void
  timer?: NodeJS.Timeout
}

interface WorkerSlot {
  worker: Worker
  task?: ValidationTask
  terminating: boolean
}

interface WorkerSuccess {
  id: number
  ok: true
  result: Omit<BulkFileDataValidationResult, 'data'> & { data: ArrayBuffer }
}

interface WorkerFailure {
  id: number
  ok: false
  error: { name?: string; message?: string; stack?: string } | string
  data: ArrayBuffer
}

/**
 * Bounded Node worker pool for complete bulk-header verification.
 *
 * A bounded private copy transfers to the worker and back without structured
 * cloning. This preserves the caller's source bytes if a worker crashes while
 * queue bounds prevent validation copies from consuming unbounded memory.
 *
 * @public
 */
export class NodeBulkFileDataValidator implements BulkFileDataValidatorApi {
  private readonly maxQueue: number
  private readonly taskTimeoutMsecs: number
  private readonly workerPath: string
  private readonly workers: WorkerSlot[] = []
  private readonly queue: ValidationTask[] = []
  private nextTaskId = 1
  private destroyed = false
  private readonly stats: BulkFileDataValidatorStats = {
    submitted: 0,
    completed: 0,
    failed: 0,
    rejected: 0,
    workerRestarts: 0,
    inFlight: 0,
    queued: 0,
    maxQueueDepth: 0,
    totalValidationMsecs: 0,
    maxValidationMsecs: 0
  }

  constructor(options: NodeBulkFileDataValidatorOptions = {}) {
    const maxWorkers = boundedPositiveInteger(options.maxWorkers ?? 1, 'maxWorkers', MAX_VALIDATION_WORKERS)
    this.maxQueue = boundedPositiveInteger(options.maxQueue ?? 8, 'maxQueue', MAX_VALIDATION_QUEUE)
    this.taskTimeoutMsecs = boundedPositiveInteger(
      options.taskTimeoutMsecs ?? 2 * 60 * 1000,
      'taskTimeoutMsecs',
      MAX_TASK_TIMEOUT_MSECS
    )
    if (
      options.workerPath !== undefined &&
      (typeof options.workerPath !== 'string' ||
        options.workerPath.trim() === '' ||
        options.workerPath.includes('\u0000'))
    ) {
      throw new Error('workerPath must be a non-empty filesystem path when defined')
    }
    this.workerPath = path.resolve(options.workerPath ?? path.join(__dirname, 'BulkFileDataValidator.worker.js'))
    for (let index = 0; index < maxWorkers; index++) this.spawnWorker()
  }

  async validate(request: BulkFileDataValidationRequest): Promise<BulkFileDataValidationResult> {
    if (this.destroyed) throw new Error('Bulk-header validator has been destroyed')
    const idle = this.workers.some(slot => slot.task == null && !slot.terminating)
    if (!idle && this.queue.length >= this.maxQueue) {
      this.stats.rejected++
      throw new Error(`Bulk-header validation queue is full (${this.maxQueue} waiting objects).`)
    }
    let snapshot: BulkFileDataValidationRequest
    try {
      snapshot = normalizeBulkFileDataValidationRequest(request)
    } catch (error) {
      this.stats.rejected++
      throw error
    }

    return await new Promise<BulkFileDataValidationResult>((resolve, reject) => {
      this.stats.submitted++
      if (!Number.isSafeInteger(this.nextTaskId)) {
        reject(new Error('Bulk-header validator exhausted its task identifier space.'))
        return
      }
      this.queue.push({ id: this.nextTaskId++, request: snapshot, startedAt: 0, resolve, reject })
      this.updateQueueStats()
      this.dispatch()
    })
  }

  getStats(): BulkFileDataValidatorStats {
    return {
      ...this.stats,
      inFlight: this.workers.filter(slot => slot.task != null).length,
      queued: this.queue.length
    }
  }

  async destroy(): Promise<void> {
    if (this.destroyed) return
    this.destroyed = true
    const error = new Error('Bulk-header validator was destroyed')
    for (const task of this.queue.splice(0)) task.reject(error)
    for (const slot of this.workers) {
      if (slot.task != null) {
        clearTimeout(slot.task.timer)
        slot.task.reject(error)
        slot.task = undefined
      }
      slot.terminating = true
    }
    await Promise.all(this.workers.map(async slot => await slot.worker.terminate()))
    this.workers.length = 0
  }

  private spawnWorker(): void {
    if (this.destroyed) return
    const worker = new Worker(this.workerPath)
    const slot: WorkerSlot = { worker, terminating: false }
    worker.on('message', (message: WorkerSuccess | WorkerFailure) => {
      try {
        this.complete(slot, message)
      } catch (error) {
        this.failWorker(slot, error instanceof Error ? error : new Error(String(error)))
      }
    })
    worker.on('error', error => this.failWorker(slot, error instanceof Error ? error : new Error(String(error))))
    worker.on('exit', code => {
      if (!slot.terminating) this.failWorker(slot, new Error(`Validation worker exited unexpectedly with code ${code}`))
    })
    this.workers.push(slot)
  }

  private dispatch(): void {
    for (const slot of this.workers) {
      if (slot.task != null || slot.terminating) continue
      const task = this.queue.shift()
      if (task == null) break
      slot.task = task
      task.startedAt = Date.now()
      task.timer = setTimeout(() => {
        this.failWorker(slot, new Error(`Bulk-header validation exceeded ${this.taskTimeoutMsecs}ms`))
      }, this.taskTimeoutMsecs)

      const data = ownedArrayBuffer(task.request.data)
      try {
        slot.worker.postMessage({ id: task.id, request: { ...task.request, data } }, [data])
      } catch (error) {
        this.failWorker(slot, error instanceof Error ? error : new Error(String(error)))
      }
    }
    this.updateQueueStats()
  }

  private complete(slot: WorkerSlot, message: WorkerSuccess | WorkerFailure): void {
    const task = slot.task
    if (task?.id !== message.id) return
    clearTimeout(task.timer)
    const duration = Date.now() - task.startedAt
    this.stats.totalValidationMsecs += duration
    this.stats.maxValidationMsecs = Math.max(this.stats.maxValidationMsecs, duration)
    if (message.ok) {
      this.validateWorkerResult(message.result, task)
      slot.task = undefined
      this.stats.completed++
      task.resolve({ ...message.result, data: new Uint8Array(message.result.data) })
    } else {
      if (!(message.data instanceof ArrayBuffer) || message.data.byteLength > MAX_HEADER_BYTES) {
        throw new Error('Validation worker returned invalid rejected data.')
      }
      slot.task = undefined
      this.stats.failed++
      const detail = (
        typeof message.error === 'string' ? message.error : (message.error?.message ?? 'Validation failed')
      ).slice(0, 4096)
      const error = new BulkFileDataValidationError(detail, new Uint8Array(message.data))
      if (typeof message.error !== 'string' && message.error.stack != null) error.stack = message.error.stack
      task.reject(error)
    }
    this.dispatch()
  }

  private validateWorkerResult(result: WorkerSuccess['result'], task: ValidationTask): void {
    if (
      result == null ||
      typeof result !== 'object' ||
      !(result.data instanceof ArrayBuffer) ||
      result.data.byteLength !== task.request.count * 80 ||
      typeof result.fileHash !== 'string' ||
      !SHA256_BASE64.test(result.fileHash) ||
      Buffer.from(result.fileHash, 'base64').toString('base64') !== result.fileHash ||
      typeof result.lastHeaderHash !== 'string' ||
      !HEX_32_BYTES.test(result.lastHeaderHash) ||
      typeof result.lastChainWork !== 'string' ||
      !HEX_32_BYTES.test(result.lastChainWork) ||
      (task.request.fileHash !== undefined && result.fileHash !== task.request.fileHash) ||
      (task.request.lastHash != null && result.lastHeaderHash !== task.request.lastHash) ||
      (task.request.lastChainWork != null && result.lastChainWork !== task.request.lastChainWork)
    ) {
      throw new Error('Validation worker returned an invalid or mismatched result.')
    }
  }

  private failWorker(slot: WorkerSlot, error: Error): void {
    if (slot.terminating) return
    slot.terminating = true
    const task = slot.task
    slot.task = undefined
    if (task != null) {
      clearTimeout(task.timer)
      this.stats.failed++
      task.reject(error)
    }
    const index = this.workers.indexOf(slot)
    if (index >= 0) this.workers.splice(index, 1)
    this.stats.workerRestarts++
    void slot.worker.terminate().finally(() => {
      if (!this.destroyed) {
        this.spawnWorker()
        this.dispatch()
      }
    })
  }

  private updateQueueStats(): void {
    this.stats.queued = this.queue.length
    this.stats.inFlight = this.workers.filter(slot => slot.task != null).length
    this.stats.maxQueueDepth = Math.max(this.stats.maxQueueDepth, this.queue.length)
  }
}

function boundedPositiveInteger(value: number, name: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${name} must be a positive safe integer no greater than ${maximum}`)
  }
  return value
}

function ownedArrayBuffer(data: Uint8Array): ArrayBuffer {
  if (data.byteOffset !== 0 || data.byteLength !== data.buffer.byteLength || !(data.buffer instanceof ArrayBuffer)) {
    throw new Error('Bulk-header validation task does not own an exact ArrayBuffer.')
  }
  return data.buffer
}
