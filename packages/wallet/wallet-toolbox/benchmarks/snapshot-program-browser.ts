import { deleteDB, openDB } from 'idb'
import { snapshotMeasurementCases, type SnapshotMeasurementCase } from './snapshot-measurement-cases'
import { browserSnapshotRestoreFixture } from '../test/utils/browserSnapshotRestoreFixture'
import { BrowserArgon2idWorkerBackend } from '../src/utility/BrowserArgon2idWorker'
import { registerArgon2idBackend, unregisterArgon2idBackend } from '../src/utility/Argon2idBackend'
import { WalletStorageManager } from '../src/storage/WalletStorageManager'
import { StorageIdb } from '../src/storage/StorageIdb'
import { StorageProvider } from '../src/storage/StorageProvider'
import {
  restoreAuthenticatedBrc39BrowserInactive,
  publishAuthenticatedBrc39BrowserProfile
} from '../src/storage/portable/Brc38AuthenticatedIdbRestoreBrowser'
import { openBrc38IdbSource } from '../src/storage/portable/Brc38IdbSource'
import { createBrc38Stream } from '../src/storage/portable/Brc38Stream'
import { encryptBrc39BrowserStreamToQuarantine } from '../src/storage/portable/Brc39StreamBrowser'
import { decryptBRC39 } from '../src/storage/portable/index'
import type { SnapshotSyncCheckpoint, SnapshotSyncCommit } from '../src/storage/snapshot/SnapshotSync'
import type { SyncSessionProgress } from '../src/storage/sync/syncSession'

const percentile = (values: readonly number[], fraction: number): number =>
  [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * fraction) - 1)] ?? 0
const same = (actual: unknown, expected: unknown): void => {
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error('Independent browser measurement oracle differs')
}
async function* chunks(bytes: Uint8Array, delayMs = 0): AsyncGenerator<Uint8Array> {
  for (let offset = 0; offset < bytes.byteLength; offset += 4096) {
    if (delayMs !== 0) await new Promise(resolve => setTimeout(resolve, delayMs))
    yield bytes.slice(offset, offset + 4096)
  }
}
export interface BrowserSnapshotMeasurementReport {
  readonly fixture: string
  readonly phase: string
  readonly wallMs: number
  readonly storageRequests: number
  readonly storageWrites: number
  readonly maxTransactionWallMs: number
  readonly eventLoopP95Ms: number
  readonly foregroundP50Ms: number | null
  readonly foregroundP95Ms: number | null
  readonly foregroundP99Ms: number | null
  readonly foregroundSamples: number
  readonly details: Readonly<Record<string, unknown>>
}
/** Actual browser actors only. The caller must own the fresh browser/worker/
 * loopback process resources. CDP measures CPU/heap separately. These synthetic
 * chain fixtures and measurements are not a physical-device or live-chain proof.
 * A native IDB transaction's wall time is not a SQL lock-duration measurement. */
export async function measureBrowserSnapshotProgram(
  shape: SnapshotMeasurementCase,
  factory: () => Worker,
  phaseBoundary?: (phase: string, boundary: 'start' | 'end') => Promise<void>,
  readDelayMs: 0 | 15 = 0
): Promise<readonly BrowserSnapshotMeasurementReport[]> {
  const f = await browserSnapshotRestoreFixture(false, shape),
    reports: BrowserSnapshotMeasurementReport[] = [],
    backend = new BrowserArgon2idWorkerBackend(factory, {
      maximumPasswordBytes: 1024,
      maximumIterations: 7,
      maximumMemoryKiB: 131072,
      maximumParallelism: 1,
      maximumMilliseconds: 30000
    }),
    identity = f.options.source.binding.identityKey,
    manager = new WalletStorageManager(identity),
    destination = new StorageIdb({
      ...StorageProvider.createStorageBaseOptions('test'),
      packed: { maximumLogicalBytes: 67108864, maximumRecords: 100000 }
    }),
    outputName = 'snapshot-measurement-cipher-' + crypto.randomUUID()
  destination.dbName = 'snapshot-measurement-destination-' + crypto.randomUUID()
  let output: Awaited<ReturnType<typeof openDB>> | undefined,
    sourceStream: Awaited<ReturnType<typeof createBrc38Stream>> | undefined,
    storageRequests = 0,
    storageWrites = 0,
    maxTransactionWallMs = 0,
    failed = false,
    originalFailure: unknown
  const restorers: (() => void)[] = [],
    observed = new WeakSet<IDBTransaction>()
  for (const name of ['get', 'getAll', 'count', 'openCursor', 'add', 'put', 'delete'] as const) {
    const descriptor = Object.getOwnPropertyDescriptor(IDBObjectStore.prototype, name)!
    const original = descriptor.value as (...args: unknown[]) => IDBRequest
    Object.defineProperty(IDBObjectStore.prototype, name, {
      ...descriptor,
      value: function (this: IDBObjectStore, ...args: unknown[]) {
        storageRequests++
        if (['add', 'put', 'delete'].includes(name)) storageWrites++
        const transaction = this.transaction
        if (!observed.has(transaction)) {
          observed.add(transaction)
          const began = performance.now()
          const ended = () => {
            maxTransactionWallMs = Math.max(maxTransactionWallMs, performance.now() - began)
          }
          transaction.addEventListener('complete', ended, { once: true })
          transaction.addEventListener('abort', ended, { once: true })
        }
        return Reflect.apply(original, this, args)
      }
    })
    restorers.push(() => Object.defineProperty(IDBObjectStore.prototype, name, descriptor))
  }
  const originalDestination = destination.getSnapshotSync.bind(destination),
    acknowledgementLost = new Error('Measured committed IDB acknowledgement loss')
  let loseNextAcknowledgement = false,
    lostCheckpoint: SnapshotSyncCheckpoint | undefined
  const pause = async () => {
    if (readDelayMs !== 0) await new Promise(resolve => setTimeout(resolve, readDelayMs))
  }
  const afterCommit = async (apply: () => Promise<SnapshotSyncCommit>): Promise<SnapshotSyncCommit> => {
    const result = await apply()
    if (loseNextAcknowledgement) {
      loseNextAcknowledgement = false
      lostCheckpoint = { ...result.checkpoint }
      // The real IDB transaction has committed. Only delivery of its ACK fails.
      // This is local ACK loss; actual TCP disconnect is the HTTP cohort.
      throw acknowledgementLost
    }
    return result!
  }
  Object.defineProperty(destination, 'getSnapshotSync', {
    value: () => {
      const capability = originalDestination()
      if (capability === undefined) throw new Error('Actual packed IDB destination capability required')
      return {
        ...capability,
        prepare: async (...args: Parameters<typeof capability.prepare>) => {
          await pause()
          const apply = await capability.prepare(...args)
          return async () => await afterCommit(apply)
        },
        prepareFields:
          capability.prepareFields === undefined
            ? undefined
            : async (...args: Parameters<NonNullable<typeof capability.prepareFields>>) => {
                await pause()
                const prepared = await capability.prepareFields!(...args)
                return { apply: async () => await afterCommit(() => prepared.apply()), close: () => prepared.close() }
              }
      }
    }
  })
  const measure = async <T>(
    phase: string,
    work: (signal: AbortSignal) => Promise<T>,
    foreground = false
  ): Promise<T> => {
    await phaseBoundary?.(phase, 'start')
    const beforeRequests = storageRequests,
      beforeWrites = storageWrites,
      began = performance.now(),
      eventLoop: number[] = [],
      foregroundTimes: number[] = []
    maxTransactionWallMs = 0
    const cancellation = new AbortController()
    let expected = began + 5,
      pending = false,
      foregroundWork: Promise<void> = Promise.resolve(),
      failure: unknown
    const fault = (cause: unknown) => {
      if (failure === undefined) {
        failure = cause
        cancellation.abort(cause)
      }
    }
    const timer = setInterval(() => {
      const now = performance.now()
      if (eventLoop.length >= 32768) {
        fault(new Error('Browser measurement sample ceiling reached'))
        return
      }
      eventLoop.push(Math.max(0, now - expected))
      expected = now + 5
      if (!foreground || pending || failure !== undefined) return
      pending = true
      const start = performance.now()
      foregroundWork = manager
        .runAsReader(async () => {
          await f.storage.findTxLabels({ partial: { userId: 1 }, paged: { limit: 20, offset: 0 } })
        })
        .then(async () => {
          await manager.runAsWriter(async () => {
            await f.storage.findOrInsertOutputBasket(1, 'default')
          })
        })
        .then(() => {
          foregroundTimes.push(performance.now() - start)
        })
        .catch(fault)
        .finally(() => {
          pending = false
        })
    }, 5)
    let result: T | undefined,
      runFailed = false,
      runFailure: unknown
    try {
      result = await work(cancellation.signal)
    } catch (cause) {
      runFailed = true
      runFailure = cause
    }
    clearInterval(timer)
    const cleanup: unknown[] = []
    try {
      await foregroundWork
    } catch (cause) {
      cleanup.push(cause)
    }
    try {
      await phaseBoundary?.(phase, 'end')
    } catch (cause) {
      cleanup.push(cause)
    }
    if (cleanup.length !== 0)
      throw new AggregateError(
        runFailed ? [runFailure, ...cleanup] : cleanup,
        'Browser measurement retains original phase failures'
      )
    if (runFailed) throw runFailure
    if (failure !== undefined) throw failure
    const wallMs = performance.now() - began
    if (wallMs >= 120000 || percentile(eventLoop, 0.95) >= 1500 || percentile(foregroundTimes, 0.95) >= 1500)
      throw new Error('Browser measurement exceeded its fixed wall or responsiveness gate')
    reports.push(
      Object.freeze({
        fixture: shape.name,
        phase,
        wallMs,
        storageRequests: storageRequests - beforeRequests,
        storageWrites: storageWrites - beforeWrites,
        maxTransactionWallMs,
        eventLoopP95Ms: percentile(eventLoop, 0.95),
        foregroundP50Ms: foreground ? percentile(foregroundTimes, 0.5) : null,
        foregroundP95Ms: foreground ? percentile(foregroundTimes, 0.95) : null,
        foregroundP99Ms: foreground ? percentile(foregroundTimes, 0.99) : null,
        foregroundSamples: foregroundTimes.length,
        details: Object.freeze({ readDelayMs })
      })
    )
    return result!
  }
  try {
    await backend.preload()
    registerArgon2idBackend(backend)
    const restored = await measure(
      'encrypted-import',
      async signal =>
        await restoreAuthenticatedBrc39BrowserInactive(chunks(f.bytes), f.password, {
          ...f.options,
          source: { ...f.options.source, signal },
          journal: { ...f.options.journal, signal },
          row: {
            ...f.options.row,
            projection: { ...f.options.row.projection, signal },
            proof: { ...f.options.row.proof, signal }
          }
        })
    )
    same(
      [restored.receipt.state, restored.receipt.nextRow, restored.inventory?.rows, f.working.used],
      ['COMPLETE', f.options.admission.totalRows, f.options.admission.totalRows, 0]
    )
    for (const [table, store] of [
      ['provenTxs', 'proven_txs'],
      ['provenTxReqs', 'proven_tx_reqs'],
      ['outputBaskets', 'output_baskets'],
      ['transactions', 'transactions'],
      ['commissions', 'commissions'],
      ['outputs', 'outputs'],
      ['outputTags', 'output_tags'],
      ['outputTagMaps', 'output_tags_map'],
      ['txLabels', 'tx_labels'],
      ['txLabelMaps', 'tx_labels_map'],
      ['certificates', 'certificates'],
      ['certificateFields', 'certificate_fields'],
      ['syncStates', 'sync_states']
    ] as const)
      same(await f.storage.db!.count(store), f.data.tables[table].length)
    await backend.preload()
    await publishAuthenticatedBrc39BrowserProfile(chunks(f.bytes), f.password, f.options, 'ACTIVATED')
    await manager.addRestoredBrowserStorageProvider(f.storage, {
      workingAllocation: f.working,
      expiresAt: f.options.admission.expiresAt
    })
    await destination.migrate('Actual browser measurement destination', 'browser-measurement-target')
    const { user } = await destination.findOrInsertUser(identity)
    await destination.updateUser(user.userId, { activeStorage: f.options.source.binding.targetStorageIdentityKey })
    Object.defineProperty(destination, 'getServices', { value: () => f.storage.getServices() })
    for (const phase of ['cold', 'unchanged', 'incremental'] as const) {
      if (phase === 'incremental') {
        const [label] = await f.storage.findTxLabels({ partial: { userId: 1, label: 'measurement-000001' } })
        await f.storage.updateTxLabel(label.txLabelId, { isDeleted: true, updated_at: new Date() })
      }
      const progress: SyncSessionProgress[] = []
      const result = await measure(
        phase,
        async signal =>
          await manager.syncToWriterResumable(await manager.getAuth(), destination, {
            signal,
            maxItems: 128,
            maxRoughSize: shape.name === 'large-record' ? 3000000 : 262144,
            onProgress: event => {
              if (progress.length >= 32768) throw new Error('Browser progress ceiling reached')
              progress.push(event)
            }
          }),
        true
      )
      same([result.status, result.mode, result.snapshotCheckpoint?.done], ['completed', 'paged', true])
      if (phase === 'unchanged') same([result.inserts, result.updates], [0, 0])
      if (phase === 'incremental') same(result.updates, 1)
      same(await destination.countTxLabels({ partial: { userId: user.userId } }), shape.labels + 1)
      const report = reports[reports.length - 1]
      reports[reports.length - 1] = Object.freeze({
        ...report,
        details: Object.freeze({
          readDelayMs,
          pages: result.pages,
          inserts: result.inserts,
          updates: result.updates,
          maxQueueMs: Math.max(0, ...progress.map(event => event.queueMs ?? 0)),
          maxCommitAcknowledgementMs: Math.max(0, ...progress.map(event => event.commitMs ?? 0))
        })
      })
    }
    // New fixed fault cohorts retain the original cold/unchanged/incremental
    // measurements. Every result is checked against the real destination row.
    const [changedLabel] = await f.storage.findTxLabels({ partial: { userId: 1, label: 'measurement-000001' } })
    await f.storage.updateTxLabel(changedLabel.txLabelId, { isDeleted: false, updated_at: new Date() })
    let cancelledAt: number | undefined
    const stopped = await measure(
      'cancel-after-commit',
      async signal => {
        const requested = new AbortController()
        return await manager.syncToWriterResumable(await manager.getAuth(), destination, {
          signal: AbortSignal.any([signal, requested.signal]),
          maxItems: 128,
          maxRoughSize: shape.name === 'large-record' ? 3000000 : 262144,
          onProgress: event => {
            if (event.state === 'committed' && cancelledAt === undefined) {
              cancelledAt = performance.now()
              requested.abort(new Error('Measured IDB cancellation'))
            }
          }
        })
      },
      true
    )
    same(stopped.status, 'cancelled')
    if (
      cancelledAt === undefined ||
      performance.now() - cancelledAt >= 30000 ||
      stopped.snapshotCheckpoint === undefined
    )
      throw new Error('Native IDB cancellation did not join the original committed page')
    const durable = await originalDestination()!.checkpoint(identity, f.options.source.binding.targetStorageIdentityKey)
    same(durable, stopped.snapshotCheckpoint)
    const resumed = await measure(
      'resume-after-cancel',
      async signal =>
        await manager.syncToWriterResumable(await manager.getAuth(), destination, {
          signal,
          maxItems: 128,
          maxRoughSize: shape.name === 'large-record' ? 3000000 : 262144
        }),
      true
    )
    same([resumed.status, resumed.snapshotCheckpoint?.done], ['completed', true])
    await f.storage.updateTxLabel(changedLabel.txLabelId, { isDeleted: true, updated_at: new Date() })
    loseNextAcknowledgement = true
    await measure(
      'lost-commit-acknowledgement',
      async signal => {
        let rejected = false
        try {
          await manager.syncToWriterResumable(await manager.getAuth(), destination, {
            signal,
            maxItems: 128,
            maxRoughSize: shape.name === 'large-record' ? 3000000 : 262144
          })
        } catch (cause) {
          if (cause !== acknowledgementLost) throw cause
          rejected = true
        }
        if (!rejected || lostCheckpoint === undefined)
          throw new Error('Actual native IDB committed ACK loss was not exercised')
        same(await originalDestination()!.checkpoint(identity, lostCheckpoint.sourceStorageIdentityKey), lostCheckpoint)
      },
      true
    )
    const recovered = await measure(
      'recover-lost-acknowledgement',
      async signal =>
        await manager.syncToWriterResumable(await manager.getAuth(), destination, {
          signal,
          maxItems: 128,
          maxRoughSize: shape.name === 'large-record' ? 3000000 : 262144
        }),
      true
    )
    same([recovered.status, recovered.snapshotCheckpoint?.done], ['completed', true])
    const [copiedLabel] = await destination.findTxLabels({
      partial: { userId: user.userId, label: 'measurement-000001' }
    })
    same(copiedLabel.isDeleted, true)
    same(await destination.countTxLabels({ partial: { userId: user.userId } }), shape.labels + 1)
    output = await openDB(outputName, 1, {
      upgrade(db) {
        db.createObjectStore('ciphertext')
      }
    })
    let outputChunks = 0,
      outputBytes = 0
    await backend.preload()
    const exported = await measure(
      'encrypted-export',
      async signal => {
        const source = await openBrc38IdbSource(f.storage, identity, {
          maximumPageRows: 128,
          maximumPageBytes: 262144,
          maximumRowAllocationBytes: 1048576,
          maximumCertificateGroupBytes: 1048576,
          maximumMetadataAllocationBytes: 65536,
          lifetimeMs: 120000,
          signal,
          streamedBinary: { maximumBinaryBytes: 4194304, maximumExtentBytes: 4096 },
          streamedStructured: { maximumStructuredBytes: 2097152 }
        })
        sourceStream = await createBrc38Stream(source, {
          exportedAt: f.data.exportedAt,
          maximumArchiveBytes: 8388608,
          maximumRowBytes: 4194304,
          maximumMetadataBytes: 65536,
          maximumChunkBytes: 4096,
          signal,
          streamedRows: {
            maximumMetadataAllocationBytes: 65536,
            maximumBinaryBytes: 4194304,
            maximumStructuredBytes: 2097152,
            maximumRowBytes: 4194304
          }
        })
        return await encryptBrc39BrowserStreamToQuarantine(
          sourceStream,
          f.password,
          {
            appendUntrusted: async bytes => {
              if (bytes.byteLength > 4096 || outputChunks >= 32768 || bytes.byteLength > 8388608 - outputBytes)
                throw new Error('Actual browser ciphertext storage ceiling reached')
              await output!.add('ciphertext', bytes.slice(), outputChunks++)
              outputBytes += bytes.byteLength
            },
            discard: async () => {
              await output!.clear('ciphertext')
            }
          },
          {
            policy: f.options.source.cryptoPolicy,
            maximumPasswordBytes: 1024,
            maximumPlaintextBytes: 8388608,
            maximumCryptoAllocationBytes: 262144,
            signal,
            expiresAt: f.options.admission.expiresAt,
            maximumKdfMilliseconds: 30000,
            cleanupMilliseconds: 30000
          }
        )
      },
      true
    )
    same(exported.fileBytes, outputBytes)
    // Bounded independent legacy decoding occurs outside the measured interval.
    // It establishes wire compatibility, not a production heap measurement.
    const encrypted = new Uint8Array(outputBytes)
    try {
      let offset = 0
      for (let index = 0; index < outputChunks; index++) {
        const part = (await output.get('ciphertext', index)) as Uint8Array
        encrypted.set(part, offset)
        offset += part.byteLength
      }
      unregisterArgon2idBackend(backend)
      const decoded = await decryptBRC39(encrypted, f.password)
      same(decoded.tables.txLabels.length, shape.labels + 1)
      same(decoded.tables.provenTxs[0].rawTx, f.data.tables.provenTxs[0].rawTx)
      for (const table of Object.keys(f.data.tables) as (keyof typeof f.data.tables)[])
        same(decoded.tables[table].length, f.data.tables[table].length)
    } finally {
      encrypted.fill(0)
    }
  } catch (cause) {
    failed = true
    originalFailure = cause
  }
  unregisterArgon2idBackend(backend)
  const failures: unknown[] = []
  for (const close of [
    async () => await sourceStream?.close(),
    async () => {
      await backend.retryCleanup()
      await backend.close()
    },
    async () => {
      output?.close()
      await deleteDB(outputName)
    },
    async () => {
      await destination.destroy()
      await deleteDB(destination.dbName)
    },
    async () => {
      f.bytes.fill(0)
      await f.storage.destroy()
      await deleteDB(f.storage.dbName)
    }
  ]) {
    try {
      await close()
    } catch (cause) {
      failures.push(cause)
    }
  }
  for (const restore of restorers.reverse()) {
    try {
      restore()
    } catch (cause) {
      failures.push(cause)
    }
  }
  if (failures.length !== 0)
    throw new AggregateError(
      failed ? [originalFailure, ...failures] : failures,
      'Browser measurement retains actual cleanup owners'
    )
  if (failed) throw originalFailure
  return Object.freeze(reports)
}
export { snapshotMeasurementCases }
