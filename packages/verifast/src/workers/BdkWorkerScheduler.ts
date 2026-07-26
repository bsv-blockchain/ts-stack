import type { BdkWasmModule, BdkVerifierOptions } from '../BdkVerifierTypes.js'
import type BdkWorkerPool from './BdkWorkerPool.js'
import type { BdkWorkerRequestWithoutId, BdkWorkerResult } from './BdkWorkerProtocol.js'

/**
 * Optional multi-worker scheduling kept outside the verifier core so
 * classic-script consumers do not download worker-only orchestration.
 */
export default class BdkWorkerScheduler {
  private readonly itemThreshold: number
  private readonly maxBatchItems: number
  private readonly maxBatchBytes: number
  private pool: BdkWorkerPool | undefined
  private ready = false
  private loading: Promise<void> | undefined

  constructor(
    private readonly createPool: (onFailure: (error: Error) => void) => BdkWorkerPool,
    options: BdkVerifierOptions
  ) {
    this.itemThreshold = options.batchWorkerThreshold ?? 32
    this.maxBatchItems = options.maxBatchItems ?? 256
    this.maxBatchBytes = options.maxBatchBytes ?? 32 * 1024 * 1024
  }

  async preload(module: BdkWasmModule): Promise<void> {
    if (this.ready) return
    if (this.pool === undefined) {
      const created = this.createPool(() => {
        if (this.pool === created) {
          this.pool = undefined
          this.loading = undefined
          this.ready = false
        }
      })
      this.pool = created
    }
    const pool = this.pool
    const snapshot = module.ExportVerificationTables?.()
    this.loading ??= pool
      .preload(snapshot)
      .then(() => {
        this.ready = true
      })
      .catch(error => {
        if (this.pool === pool) {
          pool.terminate()
          this.pool = undefined
          this.loading = undefined
          this.ready = false
        }
        throw error
      })
    await this.loading
  }

  shouldUse(itemCount: number, prepare: () => Promise<void>): boolean {
    if (itemCount < this.itemThreshold) return false
    if (this.ready) return true
    // The first large batch retains the single-instance path while worker
    // startup proceeds in parallel for subsequent high-volume work.
    void prepare().catch(() => {})
    return false
  }

  parallelChunks<T>(items: readonly T[], itemBytes: (item: T) => number): T[][] {
    if (items.length === 0) return []
    if (this.pool === undefined) return []
    const sizes = items.map(itemBytes)
    const chunks: T[][] = []
    let chunk: T[] = []
    let chunkBytes = 0
    for (let index = 0; index < items.length; index++) {
      if (
        chunk.length > 0 &&
        (chunk.length >= this.maxBatchItems || chunkBytes + sizes[index] > this.maxBatchBytes)
      ) {
        chunks.push(chunk)
        chunk = []
        chunkBytes = 0
      }
      chunk.push(items[index])
      chunkBytes += sizes[index]
    }
    if (chunk.length > 0) chunks.push(chunk)
    const desiredChunks = Math.min(this.pool.size, items.length)
    while (chunks.length < desiredChunks) {
      let splitIndex = -1
      let splitBytes = -1
      for (let index = 0; index < chunks.length; index++) {
        if (chunks[index].length < 2) continue
        const bytes = chunks[index].reduce((sum, item) => sum + itemBytes(item), 0)
        if (bytes > splitBytes) {
          splitIndex = index
          splitBytes = bytes
        }
      }
      if (splitIndex < 0) break
      const candidate = chunks[splitIndex]
      let leftBytes = 0
      let at = 1
      for (; at < candidate.length; at++) {
        leftBytes += itemBytes(candidate[at - 1])
        if (leftBytes >= splitBytes / 2) break
      }
      at = Math.min(at, candidate.length - 1)
      chunks.splice(splitIndex, 1, candidate.slice(0, at), candidate.slice(at))
    }
    return chunks
  }

  async execute(requests: readonly BdkWorkerRequestWithoutId[]): Promise<BdkWorkerResult[]> {
    if (this.pool === undefined) {
      throw new Error('BDK worker scheduler is not preloaded')
    }
    return await this.pool.execute(requests)
  }

  terminate(): void {
    this.pool?.terminate()
    this.pool = undefined
    this.loading = undefined
    this.ready = false
  }
}
