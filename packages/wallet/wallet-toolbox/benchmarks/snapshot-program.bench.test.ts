import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import type { Socket } from 'node:net'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { knex } from 'knex'
import { StorageKnex } from '../src/storage/StorageKnex'
import { StorageProvider } from '../src/storage/StorageProvider'
import { WalletStorageManager } from '../src/storage/WalletStorageManager'
import { StorageClient } from '../src/storage/remoting/StorageClient'
import type { KnexRemoteSnapshotSyncRpc } from '../src/storage/snapshot/KnexRemoteSnapshotSyncRpc'
import type { SnapshotSyncCheckpoint } from '../src/storage/snapshot/SnapshotSync'
import type { SyncSessionProgress, SyncSessionResult } from '../src/storage/sync/syncSession'
import { snapshotHttpFixture } from '../test/utils/snapshotArchiveHttpFixtures'
import { mutateSnapshotForegroundBasket } from './snapshot-foreground-write'
import {
  seedSnapshotMeasurement,
  snapshotMeasurementCases,
  type SnapshotMeasurementCase
} from './snapshot-program-fixture'

const percentile = (values: readonly number[], fraction: number): number =>
  [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * fraction) - 1)] ?? 0
const delay = async (milliseconds: number): Promise<void> =>
  await new Promise(resolve => setTimeout(resolve, milliseconds))

async function fixture(shape: SnapshotMeasurementCase) {
  const destination = await snapshotHttpFixture(true, false)
  let directory: string | undefined, source: StorageKnex | undefined
  const close = async (): Promise<void> => {
    const failures: unknown[] = []
    let sourceDrained = source === undefined
    try {
      await source?.destroy()
      sourceDrained = true
    } catch (cause) {
      failures.push(cause)
    }
    if (!sourceDrained)
      try {
        await source?.knex.destroy()
        sourceDrained = true
      } catch (cause) {
        failures.push(cause)
      }
    try {
      await destination.close()
    } catch (cause) {
      failures.push(cause)
    }
    if (sourceDrained && directory !== undefined)
      try {
        await rm(directory, { recursive: true, force: true })
      } catch (cause) {
        failures.push(cause)
      }
    if (failures.length !== 0) throw new AggregateError(failures, 'Snapshot measurement retains original cleanup')
  }
  try {
    directory = await mkdtemp(join(tmpdir(), 'snapshot-program-measurement-'))
    source = new StorageKnex({
      ...StorageProvider.createStorageBaseOptions('test'),
      snapshotJournalRetention: false,
      knex: knex({
        client: 'better-sqlite3',
        connection: { filename: join(directory, 'source.sqlite') },
        useNullAsDefault: true,
        pool: { min: 1, max: 1 },
        acquireConnectionTimeout: 1000
      })
    })
    await source.knex.raw('PRAGMA journal_mode = WAL')
    await source.migrate('Snapshot measurement source', 'measurement-source')
    await source.makeAvailable()
    const seeded = await seedSnapshotMeasurement(source, destination.identityKey, shape),
      user = (await destination.storage.findUserByIdentityKey(destination.identityKey))!
    await destination.storage.updateUser(user.userId, { activeStorage: seeded.sourceIdentity })
    Object.defineProperty(destination.storage, 'getServices', { value: () => seeded.services })
    const manager = new WalletStorageManager(destination.identityKey, source)
    await manager.makeAvailable()
    const served = await destination.serve(),
      sockets = new Set<Socket>()
    // Capability/authentication requests can open reusable connections. Own
    // them before the first client request so post-commit loss reaches the
    // actual serving sockets, including those retained after cancellation.
    served.server.server.on('connection', (socket: Socket) => {
      sockets.add(socket)
      socket.once('close', () => sockets.delete(socket))
    })
    const client = new StorageClient(destination.wallet, served.url, {
        serverIdentityKey: destination.serverIdentityKey
      }),
      rpc = Reflect.get(served.server, 'remoteSnapshotSync') as KnexRemoteSnapshotSyncRpc
    if (rpc === undefined || !(await client.getSnapshotSync()!.supportsDestination()))
      throw new Error('Actual authenticated snapshot destination is required')
    return {
      source,
      destination,
      manager,
      seeded,
      user,
      client,
      rpc,
      server: served.server,
      sockets,
      close
    }
  } catch (cause) {
    try {
      await close()
    } catch (cleanup) {
      throw new AggregateError([cause, cleanup], 'Snapshot measurement setup retains cleanup')
    }
    throw cause
  }
}

// Authored UNRUN. SERIAL, two genuine one-connection SQLite pools, one actual
// authenticated loopback listener. The outer supervisor must own process,
// output, total wall/CPU/memory and listener/pool drainage. These measurements
// are not browser, custom-engine, publication, physical-device or spend proof.
describe.each(snapshotMeasurementCases)('complete snapshot destination measurement: $name', shape => {
  test.each([0, 15])(
    'cold, unchanged and incremental copies with %i ms fixed RPC latency',
    async fixedRpcMs => {
      const f = await fixture(shape),
        dispatch = f.rpc.dispatch.bind(f.rpc)
      let queries = 0,
        requestBodyBytes = 0,
        responseBodyBytes = 0
      const observeQuery = (): void => {
        queries++
      }
      f.source.knex.on('query', observeQuery)
      f.destination.storage.knex.on('query', observeQuery)
      f.server.server.prependListener('request', (request: IncomingMessage, response: ServerResponse) => {
        const write = response.write.bind(response),
          end = response.end.bind(response),
          size = (value: unknown): number =>
            typeof value === 'string' ? Buffer.byteLength(value) : value instanceof Uint8Array ? value.byteLength : 0
        // Observe parser pushes without putting the request into flowing mode
        // before the genuine asynchronous authentication/body parser owns it.
        const push = request.push.bind(request)
        request.push = ((...args: Parameters<typeof request.push>) => {
          requestBodyBytes += size(args[0])
          return Reflect.apply(push, request, args)
        }) as typeof request.push
        response.write = ((...args: Parameters<typeof response.write>) => {
          responseBodyBytes += size(args[0])
          return Reflect.apply(write, response, args)
        }) as typeof response.write
        response.end = ((...args: Parameters<typeof response.end>) => {
          responseBodyBytes += size(args[0])
          return Reflect.apply(end, response, args)
        }) as typeof response.end
      })
      jest.spyOn(f.rpc, 'dispatch').mockImplementation(async (...args) => {
        if (fixedRpcMs !== 0) await delay(fixedRpcMs)
        return await dispatch(...args)
      })
      const reports: Record<string, unknown>[] = []
      try {
        for (const phase of ['cold', 'unchanged', 'incremental'] as const) {
          if (phase === 'incremental') {
            const [row] = await f.source.findTxLabels({
              partial: { userId: f.seeded.user.userId, label: 'measurement-000001' }
            })
            await f.source.updateTxLabel(row.txLabelId, { isDeleted: true, updated_at: new Date() })
          }
          const foreground: number[] = [],
            eventLoop: number[] = [],
            progress: SyncSessionProgress[] = [],
            before = { queries, requestBodyBytes, responseBodyBytes },
            cpuStart = process.cpuUsage(),
            rssStart = process.memoryUsage().rss,
            started = performance.now()
          let peakRss = rssStart,
            expectedTick = started + 5,
            active = true,
            pending = false,
            foregroundWork: Promise<void> = Promise.resolve(),
            foregroundFailed = false,
            foregroundFailure: unknown
          const timer = setInterval(() => {
            const now = performance.now()
            peakRss = Math.max(peakRss, process.memoryUsage().rss)
            if (eventLoop.length >= 32768) {
              foregroundFailed = true
              foregroundFailure = new Error('Measurement sample ceiling reached')
              return
            }
            eventLoop.push(Math.max(0, now - expectedTick))
            expectedTick = now + 5
            if (!active || pending || foregroundFailed) return
            pending = true
            const began = performance.now()
            foregroundWork = f.manager
              .runAsReader(async () => {
                await f.source.findTxLabels({
                  partial: { userId: f.seeded.user.userId },
                  paged: { limit: 20, offset: 0 }
                })
              })
              .then(async () => {
                await f.manager.runAsWriter(async () => {
                  await f.source.findOrInsertOutputBasket(f.seeded.user.userId, 'default')
                })
                foreground.push(performance.now() - began)
              })
              .catch(cause => {
                foregroundFailed = true
                foregroundFailure = cause
              })
              .finally(() => {
                pending = false
              })
          }, 5)
          let result: SyncSessionResult
          try {
            result = await f.manager.syncToWriterResumable(await f.manager.getAuth(), f.client, {
              maxItems: 128,
              maxRoughSize: shape.name === 'large-record' ? 3000000 : 262144,
              onProgress: event => {
                if (progress.length >= 32768) throw new Error('Measurement progress ceiling reached')
                progress.push(event)
              }
            })
          } finally {
            active = false
            clearInterval(timer)
            await foregroundWork
          }
          if (foregroundFailed) throw foregroundFailure
          const wallMs = performance.now() - started,
            cpu = process.cpuUsage(cpuStart)
          expect(result).toMatchObject({ status: 'completed', mode: 'paged', snapshotCheckpoint: { done: true } })
          expect(wallMs).toBeLessThan(120000)
          expect(peakRss - rssStart).toBeLessThan(512 * 1024 * 1024)
          expect(percentile(foreground, 0.95)).toBeLessThan(1500)
          expect(percentile(eventLoop, 0.95)).toBeLessThan(1500)
          if (shape.name === 'large' && fixedRpcMs !== 0) expect(foreground.length).toBeGreaterThan(8)
          if (phase === 'unchanged') expect(result).toMatchObject({ inserts: 0, updates: 0 })
          if (phase === 'incremental') expect(result.updates).toBe(1)
          expect(await f.destination.storage.countTxLabels({ partial: { userId: f.user.userId } })).toBe(
            f.seeded.labelCount
          )
          const request = (await f.destination.storage.findProvenTxReqs({ partial: { txid: f.seeded.txid } }))[0]
          expect(JSON.parse(request.history)).toEqual(f.seeded.history)
          expect(Buffer.from(request.rawTx)).toEqual(f.seeded.raw)
          const [transaction] = await f.destination.storage.findTransactions({
            partial: { userId: f.user.userId, txid: f.seeded.txid }
          })
          expect(JSON.parse(request.notify).transactionIds).toEqual([transaction.transactionId])
          const [output] = await f.destination.storage.findOutputs({ partial: { userId: f.user.userId } }),
            [basket] = await f.destination.storage.findOutputBaskets({
              partial: { userId: f.user.userId, name: 'default' }
            })
          expect(output.basketId).toBe(basket.basketId)
          expect(output.transactionId).toBe(transaction.transactionId)
          expect(await f.destination.storage.knex('sync_transfer_parts')).toHaveLength(0)
          expect(await f.destination.storage.knex('sync_transfers').whereNotNull('transferId')).toHaveLength(0)
          reports.push({
            backend: 'authenticated HTTP / ordinary SQLite WAL',
            fixture: shape.name,
            phase,
            fixedRpcMs,
            wallMs,
            cpuMs: (cpu.user + cpu.system) / 1000,
            rssStart,
            peakRss,
            rssGrowth: peakRss - rssStart,
            sqlQueries: queries - before.queries,
            requestBodyBytes: requestBodyBytes - before.requestBodyBytes,
            responseBodyBytes: responseBodyBytes - before.responseBodyBytes,
            pages: result.pages,
            inserts: result.inserts,
            updates: result.updates,
            foreground: {
              samples: foreground.length,
              p50Ms: percentile(foreground, 0.5),
              p95Ms: percentile(foreground, 0.95),
              p99Ms: percentile(foreground, 0.99)
            },
            eventLoop: {
              samples: eventLoop.length,
              p95Ms: percentile(eventLoop, 0.95),
              p99Ms: percentile(eventLoop, 0.99)
            },
            maxQueueMs: Math.max(0, ...progress.map(event => event.queueMs ?? 0)),
            maxReadMs: Math.max(0, ...progress.map(event => event.readMs ?? 0)),
            maxPrepareMs: Math.max(0, ...progress.map(event => event.prepareMs ?? 0)),
            // This includes transport/validation; it is not a SQL lock-duration claim.
            maxCommitAcknowledgementMs: Math.max(0, ...progress.map(event => event.commitMs ?? 0))
          })
        }
        process.stdout.write(JSON.stringify({ snapshotDestinationMeasurement: reports }) + '\n')
      } finally {
        jest.restoreAllMocks()
        f.source.knex.off('query', observeQuery)
        f.destination.storage.knex.off('query', observeQuery)
        await f.close()
      }
    },
    300000
  )
})

test.each([0, 15])(
  'actual foreground wallet mutations proceed during authenticated copy with %i ms fixed RPC latency',
  async fixedRpcMs => {
    const f = await fixture(snapshotMeasurementCases[0]),
      dispatch = f.rpc.dispatch.bind(f.rpc),
      basketName = 'foreground-measurement',
      cancellation = new AbortController(),
      samples: Array<{ startedAt: number; completedAt: number; before: number; after: number }> = []
    let mutationQueries = 0,
      timer: ReturnType<typeof setInterval> | undefined,
      pending = false,
      work: Promise<void> = Promise.resolve(),
      failure: { cause: unknown } | undefined
    const observeQuery = (query: { sql: string }): void => {
      if (/^update\s+[`"]?output_baskets\b/i.test(query.sql)) mutationQueries++
    }
    try {
      await f.source.findOrInsertOutputBasket(f.seeded.user.userId, basketName)
      f.source.knex.on('query', observeQuery)
      // The previous foreground callback admits a writer but finds an existing
      // row. Preserve and observe that distinction before the mutating cohort.
      await f.manager.runAsWriter(async () => {
        await f.source.findOrInsertOutputBasket(f.seeded.user.userId, basketName)
      })
      const lookupMutationQueries = mutationQueries
      expect(lookupMutationQueries).toBe(0)
      jest.spyOn(f.rpc, 'dispatch').mockImplementation(async (...args) => {
        if (fixedRpcMs !== 0) await delay(fixedRpcMs)
        return await dispatch(...args)
      })
      const auth = await f.manager.getAuth(),
        began = performance.now()
      const write = (): void => {
        if (pending || failure !== undefined) return
        pending = true
        const startedAt = performance.now()
        work = f.manager
          .runAsWriter(async active => {
            if (active !== f.source) throw new Error('Foreground measurement changed its actual serving provider')
            if (samples.length >= 2048) throw new Error('Foreground mutation sample ceiling reached')
            return await mutateSnapshotForegroundBasket(f.source, f.seeded.user.userId, basketName)
          })
          .then(changed => {
            samples.push({ startedAt, completedAt: performance.now(), before: changed.before, after: changed.after })
          })
          .catch(cause => {
            failure = { cause }
            cancellation.abort(cause)
          })
          .finally(() => {
            pending = false
          })
      }
      const copying = f.manager.syncToWriterResumable(auth, f.client, {
        signal: cancellation.signal,
        maxItems: 128,
        maxRoughSize: 262144
      })
      // Ten actual writes per second keep this a finite workload. Admission
      // starts after the background copy starts; each latency includes its queue.
      timer = setInterval(write, 100)
      write()
      let result: SyncSessionResult, copyCompletedAt: number
      try {
        result = await copying
        copyCompletedAt = performance.now()
      } finally {
        clearInterval(timer)
        timer = undefined
        await work
      }
      if (failure !== undefined) throw failure.cause
      expect(result).toMatchObject({ status: 'completed', mode: 'paged', snapshotCheckpoint: { done: true } })
      expect(copyCompletedAt - began).toBeLessThan(120000)
      const concurrent = samples.filter(sample => sample.startedAt >= began && sample.completedAt <= copyCompletedAt),
        latencies = samples.map(sample => sample.completedAt - sample.startedAt)
      expect(concurrent.length).toBeGreaterThan(1)
      expect(samples.every(sample => sample.startedAt >= began && sample.startedAt <= copyCompletedAt)).toBe(true)
      expect(mutationQueries).toBe(samples.length)
      expect(percentile(latencies, 0.95)).toBeLessThan(1500)
      for (const sample of samples) expect(sample.after).not.toBe(sample.before)
      const physical = await f.source
        .knex('output_baskets')
        .where({ userId: f.seeded.user.userId, name: basketName })
        .first()
      expect(physical.numberOfDesiredUTXOs).toBe(samples[samples.length - 1].after)
      // The pinned copy may correctly contain an earlier basket version. After
      // writers stop, an ordinary follow-up copy must converge to physical data.
      const caughtUp = await f.manager.syncToWriterResumable(auth, f.client, {
        maxItems: 128,
        maxRoughSize: 262144
      })
      expect(caughtUp.status).toBe('completed')
      const [basket] = await f.destination.storage.findOutputBaskets({
        partial: { userId: f.user.userId, name: basketName }
      })
      expect(basket.numberOfDesiredUTXOs).toBe(physical.numberOfDesiredUTXOs)
      expect(await f.destination.storage.countTxLabels({ partial: { userId: f.user.userId } })).toBe(
        f.seeded.labelCount
      )
      const [request] = await f.destination.storage.findProvenTxReqs({ partial: { txid: f.seeded.txid } })
      expect(JSON.parse(request.history)).toEqual(f.seeded.history)
      expect(Buffer.from(request.rawTx)).toEqual(f.seeded.raw)
      process.stdout.write(
        JSON.stringify({
          snapshotForegroundMutationMeasurement: {
            backend: 'authenticated HTTP / ordinary SQLite WAL',
            fixedRpcMs,
            wallMs: copyCompletedAt - began,
            cadenceMs: 100,
            actualMutationQueries: mutationQueries,
            lookupMutationQueries,
            verifiedMutations: samples.length,
            concurrentVerifiedMutations: concurrent.length,
            latencySamples: latencies.length,
            completionsAfterCopy: samples.length - concurrent.length,
            writeLatenciesMs: latencies,
            p50Ms: percentile(latencies, 0.5),
            p95Ms: percentile(latencies, 0.95),
            p99Ms: percentile(latencies, 0.99),
            physicalReadbackAndQuiescedCatchup: true
          }
        }) + '\n'
      )
    } finally {
      if (timer !== undefined) clearInterval(timer)
      await work
      jest.restoreAllMocks()
      f.source.knex.off('query', observeQuery)
      await f.close()
    }
  },
  300000
)

test('snapshot cancellation joins committed acknowledgement and actual TCP reply loss retains durable progress', async () => {
  const f = await fixture(snapshotMeasurementCases[0]),
    controller = new AbortController(),
    sockets = f.sockets
  let abortedAt: number | undefined
  try {
    const cancelled = await f.manager.syncToWriterResumable(await f.manager.getAuth(), f.client, {
      signal: controller.signal,
      onProgress: event => {
        if (event.state === 'committed' && abortedAt === undefined) {
          abortedAt = performance.now()
          controller.abort(new Error('Synthetic measurement cancellation'))
        }
      }
    })
    expect(abortedAt).toBeDefined()
    expect(cancelled.status).toBe('cancelled')
    const cancellationMs = performance.now() - abortedAt!
    expect(cancellationMs).toBeLessThan(30000)
    const before = await f.client.getSnapshotSync()!.checkpoint(f.destination.identityKey, f.seeded.sourceIdentity)
    expect(before?.sequence).toBe(cancelled.snapshotCheckpoint?.sequence)
    expect(before?.sequence).toBeGreaterThan(0)
    const dispatch = f.rpc.dispatch.bind(f.rpc)
    let disconnected = false,
      expectedSequence: number | undefined
    jest.spyOn(f.rpc, 'dispatch').mockImplementation(async (...args) => {
      const result = await dispatch(...args)
      if (!disconnected && args[0] === 'commitSnapshotSyncPage') {
        expectedSequence = (args[1][0] as SnapshotSyncCheckpoint).sequence + 1
        expect(sockets.size).toBeGreaterThan(0)
        disconnected = true
        // Real transport loss AFTER the real server SQL outcome; no fabricated
        // failed result is substituted for a successful RPC response.
        for (const socket of sockets) socket.destroy()
      }
      return result
    })
    let rejectedBeforeDisconnect = false,
      prematureFailure: unknown
    await expect(
      f.manager.syncToWriterResumable(await f.manager.getAuth(), f.client).catch(cause => {
        if (!disconnected) {
          rejectedBeforeDisconnect = true
          prematureFailure = cause
        }
        throw cause
      })
    ).rejects.toThrow()
    if (rejectedBeforeDisconnect)
      throw new AggregateError([prematureFailure], 'The actual post-commit TCP-loss boundary was not reached')
    expect(disconnected).toBe(true)
    const observer = new StorageClient(f.destination.wallet, f.client.endpointUrl, {
      serverIdentityKey: f.destination.serverIdentityKey
    })
    const retained = await observer.getSnapshotSync()!.checkpoint(f.destination.identityKey, f.seeded.sourceIdentity)
    expect(retained?.sequence).toBe(expectedSequence)
    expect(await f.manager.syncToWriterResumable(await f.manager.getAuth(), observer)).toMatchObject({
      status: 'completed',
      snapshotCheckpoint: { done: true }
    })
    expect(await f.destination.storage.countTxLabels({ partial: { userId: f.user.userId } })).toBe(f.seeded.labelCount)
    process.stdout.write(
      JSON.stringify({
        snapshotCancellationMeasurement: {
          cancellationMs,
          committedSequence: before?.sequence,
          disconnectedSequence: retained?.sequence,
          recovered: true
        }
      }) + '\n'
    )
  } finally {
    jest.restoreAllMocks()
    await f.close()
  }
}, 300000)
