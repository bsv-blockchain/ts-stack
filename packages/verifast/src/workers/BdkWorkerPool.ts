import {
  type BdkWorkerRequest,
  type BdkWorkerRequestWithoutId,
  type BdkWorkerResponse,
  type BdkWorkerResult,
  requestTransferables
} from './BdkWorkerProtocol.js'

export interface WorkerAdapter {
  post: (request: BdkWorkerRequest, transfer: ArrayBuffer[]) => void
  onMessage: (handler: (response: BdkWorkerResponse) => void) => void
  onError: (handler: (error: Error) => void) => void
  onExit: (handler: (error: Error) => void) => void
  terminate: () => void
}

interface PendingRequest {
  resolve: (result: BdkWorkerResult) => void
  reject: (error: Error) => void
}

/** Fixed warm worker pool used only for explicitly large packed batches. */
export default class BdkWorkerPool {
  private readonly workers: WorkerAdapter[]
  private readonly pending = new Map<number, PendingRequest>()
  private nextRequestId = 1
  private closed = false

  constructor(
    workerCount: number,
    createWorker: () => WorkerAdapter,
    private readonly onFailure?: (error: Error) => void
  ) {
    this.workers = Array.from({ length: workerCount }, createWorker)
    for (const worker of this.workers) {
      worker.onMessage(response => {
        const pending = this.pending.get(response.id)
        if (pending === undefined) return
        this.pending.delete(response.id)
        if ('error' in response) pending.reject(new Error(response.error))
        else pending.resolve(response.result)
      })
      worker.onError(error => {
        this.fail(error)
      })
      worker.onExit(error => {
        this.fail(error)
      })
    }
  }

  get size(): number {
    return this.workers.length
  }

  private async request(
    worker: WorkerAdapter,
    request: BdkWorkerRequestWithoutId
  ): Promise<BdkWorkerResult> {
    if (this.closed) throw new Error('BDK worker pool is unavailable')
    const id = this.nextRequestId++
    const message: BdkWorkerRequest = { ...request, id }
    return await new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      try {
        worker.post(message, requestTransferables(message))
      } catch (error) {
        this.pending.delete(id)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  async preload(verificationTables?: Uint8Array): Promise<void> {
    let sharedTables = verificationTables
    if (verificationTables !== undefined && typeof SharedArrayBuffer !== 'undefined') {
      const buffer = new SharedArrayBuffer(verificationTables.byteLength)
      sharedTables = new Uint8Array(buffer)
      sharedTables.set(verificationTables)
    }
    await Promise.all(
      this.workers.map(async worker => {
        await this.request(worker, {
          operation: 'preload',
          verificationTables: sharedTables
        })
      })
    )
  }

  async execute(requests: readonly BdkWorkerRequestWithoutId[]): Promise<BdkWorkerResult[]> {
    const results: BdkWorkerResult[] = []
    for (let offset = 0; offset < requests.length; offset += this.workers.length) {
      results.push(
        ...(await Promise.all(
          requests
            .slice(offset, offset + this.workers.length)
            .map(async (request, index) => await this.request(this.workers[index], request))
        ))
      )
    }
    return results
  }

  terminate(): void {
    if (this.closed) return
    this.closed = true
    const error = new Error('BDK worker pool terminated')
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
    for (const worker of this.workers) worker.terminate()
  }

  private fail(error: Error): void {
    if (this.closed) return
    this.closed = true
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
    for (const worker of this.workers) worker.terminate()
    this.onFailure?.(error)
  }
}
