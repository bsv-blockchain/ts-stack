import 'fake-indexeddb/auto'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { PrivateKey, ProtoWallet } from '@bsv/sdk'
import { StorageIdb } from '../src/storage/StorageIdb'
import { StorageKnex } from '../src/storage/StorageKnex'
import { StorageProvider } from '../src/storage/StorageProvider'
import { WalletStorageManager } from '../src/storage/WalletStorageManager'
import { StorageClient } from '../src/storage/remoting/StorageClient'
import { StorageServer } from '../src/storage/remoting/StorageServer'
import { KnexSessionManager } from '../src/storage/remoting/KnexSessionManager'
import { _tu } from '../test/utils/TestUtilsWalletStorage'
import type { SyncSessionProgress } from '../src/storage/sync/syncSession'
import type { WalletStorageSyncReader } from '../src/sdk/WalletStorage.interfaces'

import { labels, proofCount, proofBytes, pageBytes, fixedReadMs, seedSyncBenchmark } from './sync-fixture'

const delay = async (ms: number) => await new Promise(resolve => setTimeout(resolve, ms))
const percentile = (values: number[], fraction: number) =>
  [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * fraction) - 1)] ?? 0

async function store(kind: 'idb' | 'sqlite'): Promise<StorageProvider> {
  const storage =
    kind === 'idb'
      ? new StorageIdb(StorageProvider.createStorageBaseOptions('test'))
      : new StorageKnex({
          ...StorageProvider.createStorageBaseOptions('test'),
          knex: _tu.createLocalSQLite(':memory:')
        })
  if (storage instanceof StorageIdb) storage.dbName = `sync-benchmark-${randomUUID()}`
  await storage.migrate('bounded sync benchmark', PrivateKey.fromRandom().toPublicKey().toString())
  await storage.makeAvailable()
  return storage
}
async function close(storage: StorageProvider) {
  await storage.destroy()
  if (storage instanceof StorageIdb) await storage.dropAllData()
}

describe.each(['sqlite', 'http'] as const)('bounded sync measured on %s', backend => {
  test('copies large proofs and same-timestamp tombstones while foreground work progresses', async () => {
    const source = await store('sqlite')
    const key = PrivateKey.fromRandom()
    const identityKey = key.toPublicKey().toString()
    process.stdout.write(`seeding ${backend}\n`)
    const user = await seedSyncBenchmark(source, identityKey)
    process.stdout.write(`seeded ${backend}\n`)
    let reader: WalletStorageSyncReader = source
    let server: StorageServer | undefined
    let wireBytes = 0
    let queries = 0
    if (source instanceof StorageKnex)
      source.knex.on('query', () => {
        queries++
      })
    if (backend === 'http') {
      server = new StorageServer(source, {
        port: 0,
        wallet: new ProtoWallet(key),
        monetize: false,
        logRpcRequests: false,
        sessionManager: new KnexSessionManager((source as StorageKnex).knex),
        adminIdentityKeys: [],
        calculateRequestPrice: async () => 0
      })
      server.start()
      if (!server.server.listening) await once(server.server, 'listening')
      server.server.on('request', (_req, res) => {
        const write = res.write.bind(res)
        const end = res.end.bind(res)
        const size = (chunk: unknown) =>
          typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk instanceof Uint8Array ? chunk.byteLength : 0
        res.write = ((chunk: unknown, ...args: unknown[]) => {
          wireBytes += size(chunk)
          return Reflect.apply(write, res, [chunk, ...args])
        }) as typeof res.write
        res.end = ((chunk: unknown, ...args: unknown[]) => {
          wireBytes += size(chunk)
          return Reflect.apply(end, res, [chunk, ...args])
        }) as typeof res.end
      })
      const address = server.server.address()
      if (address == null || typeof address === 'string') throw new Error('HTTP fixture did not bind')
      reader = new StorageClient(new ProtoWallet(key), `http://127.0.0.1:${address.port}`)
    }
    const getChunk = reader.getSyncChunk.bind(reader)
    let pages = 0
    let largestPage = 0
    reader.getSyncChunk = async args => {
      expect(args.maxItems).toBeLessThanOrEqual(1000)
      expect(args.maxRoughSize).toBeLessThanOrEqual(pageBytes)
      await delay(fixedReadMs)
      const chunk = await getChunk(args)
      pages++
      largestPage = Math.max(
        largestPage,
        Object.values(chunk).reduce<number>((sum, value) => sum + (Array.isArray(value) ? value.length : 0), 0)
      )
      return chunk
    }
    const reports: Record<string, unknown>[] = []
    try {
      for (const mode of ['exclusive', 'paged'] as const) {
        const destination = await store('sqlite')
        if (destination instanceof StorageKnex)
          destination.knex.on('query', () => {
            queries++
          })
        const capabilities = destination.getCapabilities.bind(destination)
        if (mode === 'exclusive')
          destination.getCapabilities = async () => ({ ...(await capabilities()), storageAccess: undefined })
        const manager = new WalletStorageManager(identityKey, destination)
        await manager.makeAvailable()
        const userId = await manager.getUserId()
        let active = true
        let pending = false
        const foreground: number[] = []
        const eventLoopDelay: number[] = []
        let expectedTick = performance.now() + 5
        const progress: SyncSessionProgress[] = []
        let peakRss = process.memoryUsage().rss
        const startRss = peakRss
        const startCpu = process.cpuUsage()
        const beforePages = pages
        const beforeQueries = queries
        const beforeWire = wireBytes
        let foregroundTask: Promise<void> = Promise.resolve()
        const timer = setInterval(() => {
          const now = performance.now()
          eventLoopDelay.push(Math.max(0, now - expectedTick))
          expectedTick = now + 5
          peakRss = Math.max(peakRss, process.memoryUsage().rss)
          if (!active || pending) return
          pending = true
          const started = performance.now()
          foregroundTask = manager
            .runAsReader(
              async () => await destination.findTxLabels({ partial: { userId }, paged: { limit: 20, offset: 0 } })
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
        process.stdout.write(`copying ${backend} ${mode}\n`)
        const start = performance.now()
        try {
          const full = await manager.syncFromReaderResumable(identityKey, reader, {
            maxRoughSize: pageBytes,
            onProgress: event => {
              progress.push(event)
              if (event.state === 'committed')
                process.stdout.write(
                  `page ${backend} ${mode} ${event.pages}: ${event.inserts} inserted, ${event.commitMs} ms commit\n`
                )
            }
          })
          const wallMs = performance.now() - start
          active = false
          clearInterval(timer)
          await foregroundTask
          const cpu = process.cpuUsage(startCpu)
          expect(full).toMatchObject({ status: 'completed', mode })
          expect(await destination.countTxLabels({ partial: { userId } })).toBe(labels)
          expect(await destination.countTxLabels({ partial: { userId, isDeleted: true } })).toBe(Math.ceil(labels / 97))
          expect(await destination.countProvenTxs({ partial: {} })).toBe(proofCount)
          const report = {
            backend,
            mode,
            labels,
            proofCount,
            proofBytes,
            pageBytes,
            fixedReadMs,
            wallMs,
            cpuMs: (cpu.user + cpu.system) / 1000,
            startRss,
            peakRss,
            rssGrowth: peakRss - startRss,
            pages: pages - beforePages,
            largestPage,
            sqlQueries: queries - beforeQueries,
            responseBodyBytes: backend === 'http' ? wireBytes - beforeWire : null,
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
            maxCommitMs: Math.max(0, ...progress.map(event => event.commitMs ?? 0))
          }
          reports.push(report)
          if (mode === 'paged') {
            expect(foreground.length).toBeGreaterThan(8)
            expect(percentile(eventLoopDelay, 0.95)).toBeLessThan(1500)
            expect(percentile(foreground, 0.95)).toBeLessThan(1500)
          }
          expect(wallMs).toBeLessThan(120000)
          expect(peakRss - startRss).toBeLessThan(512 * 1024 * 1024)
          const quiet = await manager.syncFromReaderResumable(identityKey, reader, { maxRoughSize: pageBytes })
          expect(quiet).toMatchObject({ inserts: 0, updates: 0 })
          // Inclusive legacy timestamps deliberately reread the final boundary.
          // An entire imported batch can share that timestamp; preserve late peers.
          expect(quiet.pages).toBeLessThanOrEqual(full.pages + 1)
          Object.assign(report, { unchangedBoundaryPages: quiet.pages })
          const [changed] = await source.findTxLabels({ partial: { userId: user.userId, label: 'label 1' } })
          await source.updateTxLabel(changed.txLabelId, { isDeleted: !changed.isDeleted, updated_at: new Date() })
          const incremental = await manager.syncFromReaderResumable(identityKey, reader, { maxRoughSize: pageBytes })
          expect(incremental.updates).toBe(1)
          expect(incremental.pages).toBeLessThanOrEqual(full.pages + 1)
          const settled = await manager.syncFromReaderResumable(identityKey, reader, { maxRoughSize: pageBytes })
          expect(settled).toMatchObject({ inserts: 0, updates: 0 })
          expect(settled.pages).toBeLessThanOrEqual(2)
          Object.assign(report, { incrementalPages: incremental.pages, settledUnchangedPages: settled.pages })
          await source.updateTxLabel(changed.txLabelId, {
            isDeleted: changed.isDeleted,
            updated_at: changed.updated_at
          })
        } finally {
          active = false
          clearInterval(timer)
          await foregroundTask
          await close(destination)
        }
      }
      const [exclusive, paged] = reports as Array<{ wallMs: number; foreground: { p95Ms: number } }>
      expect(paged.foreground.p95Ms).toBeLessThan(exclusive.foreground.p95Ms / 2)
      expect(paged.wallMs).toBeLessThan(exclusive.wallMs * 2)
    } finally {
      process.stdout.write(`${JSON.stringify({ resumableSync: reports }, null, 2)}\n`)
      if (server !== undefined) await server.close()
      await close(source)
    }
  }, 300000)
})
