import { PrivateKey } from '@bsv/sdk'
import { StorageIdb, StorageProvider, WalletStorageManager, type SyncSessionProgress } from '@bsv/wallet-toolbox-client'
import {
  fixedReadMs,
  labels,
  pageBytes,
  proofBytes,
  proofCount,
  seedSyncBenchmark
} from '../../benchmarks/sync-fixture'

const percentile = (values: number[], fraction: number) =>
  [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * fraction) - 1)] ?? 0
const check = (condition: boolean, message: string) => {
  if (!condition) throw new Error(message)
}
async function open(): Promise<StorageIdb> {
  const storage = new StorageIdb(StorageProvider.createStorageBaseOptions('test'))
  storage.dbName = `native-sync-${crypto.randomUUID()}`
  await storage.migrate('native browser sync benchmark', PrivateKey.fromRandom().toPublicKey().toString())
  await storage.makeAvailable()
  return storage
}
async function close(storage: StorageIdb) {
  await storage.destroy()
  await storage.dropAllData()
}

async function benchmark() {
  const source = await open()
  const identityKey = PrivateKey.fromRandom().toPublicKey().toString()
  const user = await seedSyncBenchmark(source, identityKey)
  const reports = []
  let reads = 0
  let maxRows = 0
  const read = source.getSyncChunk.bind(source)
  source.getSyncChunk = async args => {
    check(args.maxItems <= 1000 && args.maxRoughSize <= pageBytes, 'page exceeded configured bounds')
    await new Promise(resolve => setTimeout(resolve, fixedReadMs))
    const chunk = await read(args)
    reads++
    maxRows = Math.max(
      maxRows,
      Object.values(chunk).reduce<number>((sum, value) => sum + (Array.isArray(value) ? value.length : 0), 0)
    )
    return chunk
  }
  try {
    for (const mode of ['exclusive', 'paged'] as const) {
      const destination = await open()
      const capabilities = destination.getCapabilities.bind(destination)
      if (mode === 'exclusive')
        destination.getCapabilities = async () => ({ ...(await capabilities()), storageAccess: undefined })
      const manager = new WalletStorageManager(identityKey, destination)
      await manager.makeAvailable()
      const userId = await manager.getUserId()
      let active = true
      let pending = false
      let foregroundTask = Promise.resolve()
      const foreground: number[] = []
      const eventLoopDelay: number[] = []
      let expectedTick = performance.now() + 5
      const progress: SyncSessionProgress[] = []
      const startReads = reads
      const heap = () =>
        (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0
      const startHeap = heap()
      let peakHeap = startHeap
      const timer = setInterval(() => {
        const now = performance.now()
        eventLoopDelay.push(Math.max(0, now - expectedTick))
        expectedTick = now + 5
        peakHeap = Math.max(peakHeap, heap())
        if (!active || pending) return
        pending = true
        const started = performance.now()
        foregroundTask = manager
          .runAsReader(
            async () => await destination.findTxLabels({ partial: { userId }, paged: { offset: 0, limit: 20 } })
          )
          .then(async () => {
            await manager.runAsWriter(async () => await destination.findOrInsertOutputBasket(userId, 'foreground'))
          })
          .then(() => {
            foreground.push(performance.now() - started)
          })
          .finally(() => {
            pending = false
          })
      }, 5)
      const start = performance.now()
      try {
        const copied = await manager.syncFromReaderResumable(identityKey, source, {
          maxRoughSize: pageBytes,
          onProgress: event => progress.push(event)
        })
        const wallMs = performance.now() - start
        active = false
        clearInterval(timer)
        await foregroundTask
        check(copied.status === 'completed' && copied.mode === mode, 'copy did not complete in expected mode')
        check((await destination.countTxLabels({ partial: { userId } })) === labels, 'label count differs')
        check(
          (await destination.countTxLabels({ partial: { userId, isDeleted: true } })) === Math.ceil(labels / 97),
          'same-timestamp tombstones were lost'
        )
        check((await destination.countProvenTxs({ partial: {} })) === proofCount, 'large proofs were lost')
        const report = {
          backend: 'Chromium IndexedDB',
          mode,
          labels,
          proofCount,
          proofBytes,
          pageBytes,
          fixedReadMs,
          wallMs,
          pages: reads - startReads,
          maxRows,
          startHeap,
          peakHeap,
          foreground: {
            samples: foreground.length,
            p50Ms: percentile(foreground, 0.5),
            p95Ms: percentile(foreground, 0.95),
            p99Ms: percentile(foreground, 0.99)
          },
          eventLoopDelay: {
            samples: eventLoopDelay.length,
            p95Ms: percentile(eventLoopDelay, 0.95),
            p99Ms: percentile(eventLoopDelay, 0.99),
            maxMs: Math.max(0, ...eventLoopDelay)
          },
          maxQueueMs: Math.max(0, ...progress.map(event => event.queueMs ?? 0)),
          maxCommitMs: Math.max(0, ...progress.map(event => event.commitMs ?? 0)),
          maxReadMs: Math.max(0, ...progress.map(event => event.readMs ?? 0))
        }
        reports.push(report)
        console.log(JSON.stringify(report))
        check(wallMs < 120000, 'full copy exceeded 120 seconds')
        check(peakHeap - startHeap < 512 * 1024 * 1024, 'heap growth exceeded 512 MiB')
        if (mode === 'paged') {
          check(foreground.length > 8, 'background sync starved foreground work')
          check(percentile(eventLoopDelay, 0.95) < 1500, 'event loop p95 exceeded 1.5 seconds')
          check(percentile(foreground, 0.95) < 1500, 'foreground p95 exceeded 1.5 seconds')
        }
        const quiet = await manager.syncFromReaderResumable(identityKey, source, { maxRoughSize: pageBytes })
        check(
          quiet.inserts === 0 && quiet.updates === 0 && quiet.pages <= copied.pages + 1,
          'unchanged boundary replay mutated rows or exceeded a full pass'
        )
        const [changed] = await source.findTxLabels({ partial: { userId: user.userId, label: 'label 1' } })
        await source.updateTxLabel(changed.txLabelId, { isDeleted: true, updated_at: new Date() })
        const incremental = await manager.syncFromReaderResumable(identityKey, source, { maxRoughSize: pageBytes })
        check(
          incremental.updates === 1 && incremental.pages <= copied.pages + 1,
          'incremental tombstone did not propagate'
        )
        const settled = await manager.syncFromReaderResumable(identityKey, source, { maxRoughSize: pageBytes })
        check(
          settled.inserts === 0 && settled.updates === 0 && settled.pages <= 2,
          'settled unchanged copy was not quiet'
        )
        Object.assign(report, {
          unchangedBoundaryPages: quiet.pages,
          incrementalPages: incremental.pages,
          settledUnchangedPages: settled.pages
        })
        await source.updateTxLabel(changed.txLabelId, { isDeleted: false, updated_at: changed.updated_at })
      } finally {
        active = false
        clearInterval(timer)
        await foregroundTask
        await close(destination)
      }
    }
    check(
      reports[1].foreground.p95Ms < reports[0].foreground.p95Ms / 2,
      'foreground p95 did not improve by at least 2x'
    )
    check(reports[1].wallMs < reports[0].wallMs * 2, 'paged copy doubled total time')
    return reports
  } finally {
    await close(source)
  }
}

Object.assign(globalThis, { syncBenchmark: benchmark() })
