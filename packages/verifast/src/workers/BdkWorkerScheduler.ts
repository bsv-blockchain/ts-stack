import type {
  BdkWasmModule,
  BdkVerifierOptions
} from '../BdkVerifierTypes.js'
import type BdkWorkerPool from './BdkWorkerPool.js'
import type {
  BdkWorkerRequestWithoutId,
  BdkWorkerResult
} from './BdkWorkerProtocol.js'

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

  constructor (
    private readonly createPool: () => BdkWorkerPool,
    options: BdkVerifierOptions
  ) {
    this.itemThreshold = options.batchWorkerThreshold ?? 32
    this.maxBatchItems = options.maxBatchItems ?? 256
    this.maxBatchBytes = options.maxBatchBytes ?? 32 * 1024 * 1024
  }

  async preload (module: BdkWasmModule): Promise<void> {
    this.pool ??= this.createPool()
    const snapshot = module.ExportVerificationTables?.()
    this.loading ??= this.pool.preload(snapshot).then(() => {
      this.ready = true
    })
    await this.loading
  }

  shouldUse (
    itemCount: number,
    prepare: () => Promise<void>
  ): boolean {
    if (itemCount < this.itemThreshold) return false
    if (this.ready) return true
    // The first large batch retains the single-instance path while worker
    // startup proceeds in parallel for subsequent high-volume work.
    void prepare().catch(() => {})
    return false
  }

  parallelChunks<T> (
    items: readonly T[],
    itemBytes: (item: T) => number
  ): T[][] {
    if (items.length === 0) return []
    if (this.pool === undefined) return []
    const chunkCount = Math.min(this.pool.size, items.length)
    const sizes = items.map(itemBytes)
    for (const size of sizes) {
      if (size > this.maxBatchBytes) {
        throw new RangeError(`A BDK batch item exceeds maxBatchBytes (${this.maxBatchBytes})`)
      }
    }
    const chunks: T[][] = []
    let index = 0
    let remainingBytes = sizes.reduce((sum, size) => sum + size, 0)
    for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex++) {
      const workersLeft = chunkCount - chunkIndex
      const targetBytes = remainingBytes / workersLeft
      const chunk: T[] = []
      let chunkBytes = 0
      const lastAllowedIndex = items.length - (workersLeft - 1)
      while (
        index < lastAllowedIndex &&
        chunk.length < this.maxBatchItems &&
        chunkBytes + sizes[index] <= this.maxBatchBytes
      ) {
        if (chunk.length > 0 && chunkBytes >= targetBytes) break
        chunk.push(items[index])
        chunkBytes += sizes[index]
        index++
      }
      if (chunk.length === 0 && index < items.length) {
        chunk.push(items[index])
        chunkBytes += sizes[index]
        index++
      }
      chunks.push(chunk)
      remainingBytes -= chunkBytes
    }
    // A workload exceeding one wave of configured worker capacity keeps the
    // existing bounded single-module chunking path.
    return index === items.length ? chunks : []
  }

  async execute (
    requests: readonly BdkWorkerRequestWithoutId[]
  ): Promise<BdkWorkerResult[]> {
    if (this.pool === undefined) {
      throw new Error('BDK worker scheduler is not preloaded')
    }
    return await this.pool.execute(requests)
  }

  terminate (): void {
    this.pool?.terminate()
    this.pool = undefined
    this.loading = undefined
    this.ready = false
  }
}
