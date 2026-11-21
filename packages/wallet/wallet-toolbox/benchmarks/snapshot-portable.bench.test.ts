import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, chmod, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { knex } from 'knex'
const { StorageKnex } = require('../out/src/storage/StorageKnex.js') as typeof import('../src/storage/StorageKnex')
const { StorageProvider } =
  require('../out/src/storage/StorageProvider.js') as typeof import('../src/storage/StorageProvider')
const { WalletStorageManager } =
  require('../out/src/storage/WalletStorageManager.js') as typeof import('../src/storage/WalletStorageManager')
const { openBrc38KnexSource } =
  require('../out/src/storage/portable/Brc38KnexSource.js') as typeof import('../src/storage/portable/Brc38KnexSource')
const { createBrc38Stream } =
  require('../out/src/storage/portable/Brc38Stream.js') as typeof import('../src/storage/portable/Brc38Stream')
import type { Brc39NodeFileQuarantine } from '../src/storage/portable/Brc39PrivateFileNode'
const { createBrc39NodeFileQuarantine } =
  require('../out/src/storage/portable/Brc39PrivateFileNode.js') as typeof import('../src/storage/portable/Brc39PrivateFileNode')
import type {
  Brc38StagingAdmissionNode as Admission,
  Brc38StagingReservation
} from '../src/storage/portable/Brc38StagingAdmissionNode'
const { Brc38StagingAdmissionNode } =
  require('../out/src/storage/portable/Brc38StagingAdmissionNode.js') as typeof import('../src/storage/portable/Brc38StagingAdmissionNode')
const { stageAuthenticatedBrc39PrivateImport } =
  require('../out/src/storage/portable/Brc38AuthenticatedPrivateStageNode.js') as typeof import('../src/storage/portable/Brc38AuthenticatedPrivateStageNode')
import { seedSnapshotMeasurement, snapshotMeasurementCases } from './snapshot-program-fixture'
const { decryptBRC39 } =
  require('../out/src/storage/portable/index.js') as typeof import('../src/storage/portable/index')

// The delivered one-shot worker runs ordinary compiled code, not a .ts entry.
const compiledStream =
  require('../out/src/storage/portable/Brc39StreamNode.js') as typeof import('../src/storage/portable/Brc39StreamNode')
const percentile = (values: readonly number[], fraction: number): number =>
  [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * fraction) - 1)] ?? 0

// The complete 10,000-label authenticated import measured about 160 seconds with all three
// staging/eight verification passes. This positive fixture has a fixed 240-second
// admission; production defaults and original export/memory/foreground limits stay.
const largePortableImportPhaseMilliseconds = 240000

/** Authored UNRUN. Ordinary SQLite export is the compatibility measurement;
 * it may materialize a bounded individual structured row. Import here measures
 * authenticated full13 private staging, not native operational activation.
 * Separate native composition/browser destination cases retain that obligation.
 * Export owns one dedicated reader alongside the original serving pool, each
 * limited to one connection. Both drain before the two private staging pools open. The caller must separately admit actual KDF/file/process resources. */
describe.each(snapshotMeasurementCases)('full13 portable measurement: $name', shape => {
  const portableImportPhaseMilliseconds = shape.name === 'large' ? largePortableImportPhaseMilliseconds : 120000
  test.each([0, 5])(
    'encrypted export/import with %i ms per-chunk source latency',
    async readDelayMs => {
      const directory = await mkdtemp(join(tmpdir(), 'snapshot-portable-measurement-'))
      await chmod(directory, 0o700)
      const storage = new StorageKnex({
          ...StorageProvider.createStorageBaseOptions('test'),
          snapshotJournalRetention: false,
          knex: knex({
            client: 'better-sqlite3',
            connection: { filename: join(directory, 'source.sqlite') },
            useNullAsDefault: true,
            pool: { min: 1, max: 1 },
            acquireConnectionTimeout: 1000
          })
        }),
        reader = new StorageKnex({
          ...StorageProvider.createStorageBaseOptions('test'),
          snapshotSync: false,
          snapshotJournalRetention: false,
          knex: knex({
            client: 'better-sqlite3',
            connection: { filename: join(directory, 'source.sqlite') },
            useNullAsDefault: true,
            pool: { min: 0, max: 1 },
            acquireConnectionTimeout: 1000
          })
        }),
        identity = '02' + '11'.repeat(32),
        password = 'portable-measurement CAFE\u0301',
        policy = {
          maximumFileBytes: 8388608,
          maximumChunkBytes: 4096,
          maximumIterations: 7,
          maximumMemoryKiB: 131072,
          maximumParallelism: 1
        }
      let cipher: Brc39NodeFileQuarantine | undefined,
        stream: Awaited<ReturnType<typeof createBrc38Stream>> | undefined,
        admission: Admission | undefined,
        reservation: Brc38StagingReservation | undefined,
        drained = false,
        readerDrained = false,
        failed = false,
        failure: unknown,
        archiveSha256 = '',
        ciphertextBytes = 0,
        sourceQueries = 0,
        catalogQueries = 0,
        driverQueries = 0
      const reports: Record<string, unknown>[] = []
      const query = (): void => {
        sourceQueries++
      }
      const catalogQuery = (): void => {
        catalogQueries++
      }
      const measure = async <T>(
        phase: string,
        run: (signal: AbortSignal) => Promise<T>,
        manager?: import('../src/storage/WalletStorageManager').WalletStorageManager
      ): Promise<T> => {
        const phaseMilliseconds = phase === 'authenticated-private-import' ? portableImportPhaseMilliseconds : 120000
        const maximumSamples = Math.max(32768, Math.ceil(phaseMilliseconds / 5) + 1)
        const cancellation = new AbortController()
        const cpuStart = process.cpuUsage(),
          rssStart = process.memoryUsage().rss,
          began = performance.now(),
          beforeQueries = sourceQueries,
          beforeCatalogQueries = catalogQueries,
          beforeDriverQueries = driverQueries,
          eventLoop: number[] = [],
          foreground: number[] = []
        let peakRss = rssStart,
          expected = began + 5,
          pending = false,
          foregroundWork: Promise<void> = Promise.resolve(),
          error: unknown
        const reportFault = (cause: unknown): void => {
          if (error === undefined) {
            error = cause
            cancellation.abort(cause)
          }
        }
        const prototype = Object.getPrototypeOf(storage.knex.client),
          descriptor = Object.getOwnPropertyDescriptor(prototype, '_query'),
          originalQuery = prototype._query
        if (typeof originalQuery !== 'function') throw new Error('Actual SQLite Knex query executor differs')
        // A finite measurement-only observer counts original driver dispatches
        // from source, catalog and private-stage clients of this exact class.
        // It delegates the original receiver/arguments/promise and sees no SQL.
        const observedQuery = function (this: unknown, ...args: unknown[]): unknown {
          driverQueries++
          if (!Number.isSafeInteger(driverQueries)) throw new Error('SQLite measurement query ceiling reached')
          return Reflect.apply(originalQuery, this, args)
        }
        Object.defineProperty(prototype, '_query', { configurable: true, writable: true, value: observedQuery })
        const timer = setInterval(() => {
          const now = performance.now()
          peakRss = Math.max(peakRss, process.memoryUsage().rss)
          if (eventLoop.length >= maximumSamples) {
            reportFault(new Error('Portable measurement sample ceiling reached'))
            return
          }
          eventLoop.push(Math.max(0, now - expected))
          expected = now + 5
          if (manager === undefined || pending || error !== undefined) return
          pending = true
          const start = performance.now()
          foregroundWork = manager
            .runAsReader(async () => {
              await storage.findTxLabels({ partial: { userId: 1 }, paged: { limit: 20, offset: 0 } })
            })
            .then(async () => {
              await manager.runAsWriter(async () => {
                await storage.findOrInsertOutputBasket(1, 'default')
              })
            })
            .then(() => {
              foreground.push(performance.now() - start)
            })
            .catch(reportFault)
            .finally(() => {
              pending = false
            })
        }, 5)
        let result: T,
          runFailed = false,
          runFailure: unknown
        try {
          result = await run(cancellation.signal)
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
          if (prototype._query !== observedQuery) throw new Error('SQLite measurement executor owner was replaced')
          if (descriptor === undefined) delete prototype._query
          else Object.defineProperty(prototype, '_query', descriptor)
        } catch (cause) {
          cleanup.push(cause)
        }
        if (cleanup.length !== 0)
          throw new AggregateError(
            runFailed ? [runFailure, ...cleanup] : cleanup,
            'SQLite measurement retains run and observer cleanup failures'
          )
        if (runFailed) throw runFailure
        if (error !== undefined) throw error
        const wallMs = performance.now() - began,
          cpu = process.cpuUsage(cpuStart)
        expect(wallMs).toBeLessThan(phaseMilliseconds)
        expect(peakRss - rssStart).toBeLessThan(512 * 1024 * 1024)
        expect(percentile(eventLoop, 0.95)).toBeLessThan(1500)
        expect(percentile(foreground, 0.95)).toBeLessThan(1500)
        expect(driverQueries - beforeDriverQueries).toBeGreaterThan(0)
        reports.push({
          fixture: shape.name,
          phase,
          readDelayMs,
          wallMs,
          cpuMs: (cpu.user + cpu.system) / 1000,
          rssStart,
          peakRss,
          sourceSqlQueries: sourceQueries - beforeQueries,
          admissionCatalogSqlQueries: catalogQueries - beforeCatalogQueries,
          actualSqliteKnexDispatches: driverQueries - beforeDriverQueries,
          sqlCounterScope:
            'actual SQLite Knex executor dispatches include private staging; direct connection.exec controls are excluded; source/catalog events are separately named',
          eventLoopP95Ms: percentile(eventLoop, 0.95),
          foregroundSamples: foreground.length,
          foregroundRole:
            manager === undefined ? 'isolated private stage; no serving manager' : 'actual source serving manager',
          foregroundP50Ms: manager === undefined ? null : percentile(foreground, 0.5),
          foregroundP95Ms: manager === undefined ? null : percentile(foreground, 0.95),
          foregroundP99Ms: manager === undefined ? null : percentile(foreground, 0.99)
        })
        return result!
      }
      try {
        await storage.knex.raw('PRAGMA journal_mode = WAL')
        await storage.migrate('Portable measurement source', 'portable-measurement-source')
        await storage.makeAvailable()
        const seeded = await seedSnapshotMeasurement(storage, identity, shape)
        const manager = new WalletStorageManager(identity, storage)
        await manager.makeAvailable()
        storage.knex.on('query', query)
        reader.knex.on('query', query)
        cipher = await createBrc39NodeFileQuarantine(
          directory,
          async bytes => {
            const hash = createHash('sha256')
            let count = 0
            for await (const chunk of bytes) {
              hash.update(chunk)
              count += chunk.byteLength
            }
            archiveSha256 = hash.digest('hex')
            ciphertextBytes = count
          },
          policy
        )
        const exported = await measure(
          'encrypted-export',
          async signal => {
            const source = await openBrc38KnexSource(reader, identity, {
              maximumPageRows: 128,
              maximumPageBytes: 8388608,
              maximumRowAllocationBytes: 8388608,
              maximumCertificateGroupBytes: 1048576,
              lifetimeMs: 120000,
              signal,
              streamedBinary: { maximumBinaryBytes: 4194304 }
            })
            stream = await createBrc38Stream(source, {
              exportedAt: '2026-10-08T00:00:00.000Z',
              maximumArchiveBytes: 8388608,
              maximumRowBytes: 8388608,
              maximumChunkBytes: 4096,
              signal,
              streamedRows: {
                maximumMetadataAllocationBytes: 8388608,
                maximumBinaryBytes: 4194304,
                maximumRowBytes: 8388608
              }
            })
            const original = stream.chunks
            const delayed = (async function* () {
              for await (const bytes of original) {
                if (readDelayMs !== 0) await new Promise(resolve => setTimeout(resolve, readDelayMs))
                yield bytes
              }
            })()
            return await compiledStream.encryptBrc39StreamToQuarantine(
              { ...stream, chunks: delayed },
              password,
              cipher!,
              { policy, maximumPasswordBytes: 1024, maximumKdfMilliseconds: 30000, signal }
            )
          },
          manager
        )
        await cipher.validateAuthenticated()
        expect(ciphertextBytes).toBe(exported.fileBytes)
        // The independent materialized legacy oracle is explicitly bounded and
        // outside measured intervals. No production heap claim derives from it.
        await cipher.withAuthenticatedChunks(async chunks => {
          const parts: Uint8Array[] = []
          let bytes = 0
          for await (const part of chunks) {
            bytes += part.byteLength
            expect(bytes).toBeLessThanOrEqual(policy.maximumFileBytes)
            parts.push(part)
          }
          const encrypted = Buffer.concat(parts)
          try {
            const decoded = await decryptBRC39(encrypted, password.normalize('NFC'))
            expect(decoded.tables.txLabels).toHaveLength(shape.labels + 1)
            const rawTx = decoded.tables.provenTxs[0].rawTx
            if (typeof rawTx !== 'string') throw new Error('Independent decoded proof has no base64 bytes')
            expect(Buffer.from(rawTx, 'base64')).toEqual(seeded.raw)
            expect(decoded.tables.provenTxReqs[0].history).toEqual(seeded.history)
            for (const rows of Object.values(decoded.tables)) expect(rows.length).toBeGreaterThan(0)
          } finally {
            encrypted.fill(0)
            for (const part of parts) part.fill(0)
          }
        })
        if (stream === undefined) throw new Error('Measured export did not retain its actual stream')
        await stream.close()
        stream = undefined
        reader.knex.off('query', query)
        await reader.destroy()
        readerDrained = true
        storage.knex.off('query', query)
        await storage.destroy()
        drained = true
        const stageDirectory = join(directory, 'admission')
        await mkdir(stageDirectory, { mode: 0o700 })
        admission = await Brc38StagingAdmissionNode.create(stageDirectory, {
          maximumImports: 1,
          maximumLogicalBytes: 67108864,
          maximumPhysicalBytes: 134217728
        })
        admission.knex.on('query', catalogQuery)
        const expiresAt = Date.now() + portableImportPhaseMilliseconds
        const result = await measure(
          'authenticated-private-import',
          async signal =>
            await cipher!.withAuthenticatedChunks(
              async chunks =>
                await stageAuthenticatedBrc39PrivateImport(
                  (async function* () {
                    for await (const bytes of chunks) {
                      if (readDelayMs !== 0) await new Promise(resolve => setTimeout(resolve, readDelayMs))
                      yield bytes
                    }
                  })(),
                  password,
                  admission!,
                  {
                    binding: {
                      archiveSha256,
                      identityKey: identity,
                      chain: 'test',
                      sourceStorageIdentityKey: seeded.sourceIdentity,
                      targetStorageIdentityKey: 'portable-measurement-target',
                      targetGeneration: 0
                    },
                    limits: {
                      maximumRows: 24000,
                      maximumLogicalBytes: 67108864,
                      maximumPhysicalBytes: 67108864,
                      maximumRowBytes: 65536,
                      maximumRowAllocationBytes: 16777216,
                      expiresAt
                    },
                    crypto: { policy, maximumPasswordBytes: 1024, maximumKdfMilliseconds: 30000, signal },
                    maximumPlaintextBytes: 8388608,
                    maximumCiphertextChunks: 32768,
                    streamedFields: { maximumBinaryBytes: 4194304, maximumChunkBytes: 4096 },
                    streamedStructuredFields: {
                      fields: { maximumStructuredBytes: 2097152, maximumChunkBytes: 4096 },
                      staging: {
                        privateIndexParent: stageDirectory,
                        maximumTemporaryIndexBytes: 8388608,
                        maximumIndexMembers: 30000,
                        maximumStructuredBytes: 2097152,
                        maximumCanonicalBytes: 2097152,
                        signal
                      }
                    }
                  }
                ).then(value => {
                  // Retain the physical owner before a measurement assertion or
                  // quarantine-close failure can reject the enclosing operation.
                  reservation = value.reservation
                  return value
                })
            )
        )
        reservation = result.reservation
        expect(result.document.counts.txLabels).toBe(shape.labels + 1)
        for (const count of Object.values(result.document.counts)) expect(count).toBeGreaterThan(0)
        expect(result.archiveSha256).toBe(archiveSha256)
        expect(result.fileBytes).toBe(ciphertextBytes)
        await admission.discard(reservation, new Error('Completed finite portable measurement'))
        reservation = undefined
        expect((await admission.usage()).imports).toBe(0)
        process.stdout.write(
          JSON.stringify({
            portableSnapshotMeasurement: reports,
            ciphertextBytes,
            importRole: 'authenticated full13 private staging; operational activation is separately qualified',
            maximumSimultaneousPools: 2,
            servingPoolMaximumConnections: 1,
            exportReaderPoolMaximumConnections: 1
          }) + '\n'
        )
      } catch (cause) {
        failed = true
        failure = cause
      }
      const cleanup: unknown[] = []
      for (const close of [
        async () => await stream?.close(),
        async () => {
          reader.knex.off('query', query)
          if (!readerDrained) {
            await reader.destroy()
            readerDrained = true
          }
        },
        async () => await cipher?.discard(),
        async () => {
          if (reservation !== undefined) await admission!.discard(reservation, new Error('Finite measurement cleanup'))
        },
        async () => {
          admission?.knex.off('query', catalogQuery)
          await admission?.close()
        },
        async () => {
          storage.knex.off('query', query)
          if (!drained) {
            await storage.destroy()
            drained = true
          }
        }
      ]) {
        try {
          await close()
        } catch (cause) {
          cleanup.push(cause)
        }
      }
      if (cleanup.length === 0)
        try {
          await rm(directory, { recursive: true, force: true })
        } catch (cause) {
          cleanup.push(cause)
        }
      if (cleanup.length !== 0)
        throw new AggregateError(
          failed ? [failure, ...cleanup] : cleanup,
          'Portable measurement retains original cleanup'
        )
      if (failed) throw failure
    },
    300000
  )
})
