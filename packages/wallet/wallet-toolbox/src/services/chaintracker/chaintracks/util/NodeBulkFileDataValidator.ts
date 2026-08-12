import * as path from 'node:path'
import { Worker } from 'node:worker_threads'
import {
  BulkFileDataValidationError,
  type BulkFileDataValidationRequest,
  type BulkFileDataValidationResult,
  type BulkFileDataValidatorApi,
  type BulkFileDataValidatorStats
} from '../Api/BulkFileDataValidatorApi'

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
    const maxWorkers = positiveInteger(options.maxWorkers ?? 1, 'maxWorkers')
    this.maxQueue = positiveInteger(options.maxQueue ?? 8, 'maxQueue')
    this.taskTimeoutMsecs = positiveInteger(options.taskTimeoutMsecs ?? 2 * 60 * 1000, 'taskTimeoutMsecs')
    this.workerPath = options.workerPath ?? path.join(__dirname, 'BulkFileDataValidator.worker.js')
    for (let index = 0; index < maxWorkers; index++) this.spawnWorker()
  }

  async validate(request: BulkFileDataValidationRequest): Promise<BulkFileDataValidationResult> {
    if (this.destroyed) throw new Error('Bulk-header validator has been destroyed')
    const idle = this.workers.some(slot => slot.task == null && !slot.terminating)
    if (!idle && this.queue.length >= this.maxQueue) {
      this.stats.rejected++
      throw new Error(`Bulk-header validation queue is full (${this.maxQueue} waiting objects).`)
    }

    return await new Promise<BulkFileDataValidationResult>((resolve, reject) => {
      this.stats.submitted++
      this.queue.push({ id: this.nextTaskId++, request, startedAt: 0, resolve, reject })
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
    worker.on('message', (message: WorkerSuccess | WorkerFailure) => this.complete(slot, message))
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

      const data = exactArrayBuffer(task.request.data)
      slot.worker.postMessage({ id: task.id, request: { ...task.request, data } }, [data])
    }
    this.updateQueueStats()
  }

  private complete(slot: WorkerSlot, message: WorkerSuccess | WorkerFailure): void {
    const task = slot.task
    if (task?.id !== message.id) return
    clearTimeout(task.timer)
    slot.task = undefined
    const duration = Date.now() - task.startedAt
    this.stats.totalValidationMsecs += duration
    this.stats.maxValidationMsecs = Math.max(this.stats.maxValidationMsecs, duration)
    if (message.ok) {
      this.stats.completed++
      task.resolve({ ...message.result, data: new Uint8Array(message.result.data) })
    } else {
      this.stats.failed++
      const detail = typeof message.error === 'string' ? message.error : (message.error.message ?? 'Validation failed')
      const error = new BulkFileDataValidationError(detail, new Uint8Array(message.data))
      if (typeof message.error !== 'string' && message.error.stack != null) error.stack = message.error.stack
      task.reject(error)
    }
    this.dispatch()
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

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive safe integer`)
  return value
}

function exactArrayBuffer(data: Uint8Array): ArrayBuffer {
  return data.slice().buffer as ArrayBuffer
}
