import { nativeTestExecutable } from '../src/storage/portable/Brc38NativeTestPath'
import { performance } from 'node:perf_hooks'
import type { Knex } from 'knex'
// All operational actors use one ordinary compiled module graph, including
// the delivered crypto Worker and native/CJS siblings. Type imports launch none.
const { StorageKnex } = require('../out/src/storage/StorageKnex.js') as typeof import('../src/storage/StorageKnex')
const { snapshotMeasurementCases } =
  require('../out/benchmarks/snapshot-measurement-cases.js') as typeof import('./snapshot-measurement-cases')
const { composedNativeFixture } =
  require('../out/src/storage/portable/Brc38ComposedNativeFixture.js') as typeof import('../src/storage/portable/Brc38ComposedNativeFixture')
const { importBrc39ComposedNativeProfile } =
  require('../out/src/storage/portable/Brc39ComposedNativeImportNode.js') as typeof import('../src/storage/portable/Brc39ComposedNativeImportNode')
const { authenticatedStagePassword } =
  require('../out/src/storage/portable/Brc38AuthenticatedPrivateStageFixture.js') as typeof import('../src/storage/portable/Brc38AuthenticatedPrivateStageFixture')
const { seedComposedAuxiliaryFixture, assertComposedAuxiliaryFixture } =
  require('../out/src/storage/portable/Brc38ComposedAuxiliaryFixture.js') as typeof import('../src/storage/portable/Brc38ComposedAuxiliaryFixture')
const { openBrc38KnexSource } =
  require('../out/src/storage/portable/Brc38KnexSource.js') as typeof import('../src/storage/portable/Brc38KnexSource')
const { createBrc38Stream } =
  require('../out/src/storage/portable/Brc38Stream.js') as typeof import('../src/storage/portable/Brc38Stream')
const { createBrc39NodeFileQuarantine } =
  require('../out/src/storage/portable/Brc39PrivateFileNode.js') as typeof import('../src/storage/portable/Brc39PrivateFileNode')
const { encryptBrc39StreamToQuarantine } =
  require('../out/src/storage/portable/Brc39StreamNode.js') as typeof import('../src/storage/portable/Brc39StreamNode')
const { decryptBRC39 } =
  require('../out/src/storage/portable/index.js') as typeof import('../src/storage/portable/index')
const { observeNativeProfileMeasurement } = require('../test/utils/nativeProfileMeasurement.cjs') as {
  observeNativeProfileMeasurement(): {
    readonly signal: AbortSignal
    beginPhase(): void
    report(): {
      nativeRequests: number
      nativeSqlQueries: number
      requestWireBytes: number
      responseWireBytes: number
      writerEnclosureLowerMs: number[]
      writerEnclosureUpperMs: number[]
    }
    close(): void
  }
}
const percentile = (values: readonly number[], fraction: number): number =>
  [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * fraction) - 1)] ?? 0

// Measured cold native preparation reached231s. Admit that setup and both
// original120s phases plus independent oracles in a finite positive fixture.
// Production/native quotas and the fixture default for other callers stay.
const nativeProgrammeFixtureLifetimeMilliseconds = 540000
const nativeProgrammeCaseMilliseconds = nativeProgrammeFixtureLifetimeMilliseconds + 30000

/** UNRUN. Native full47 occupied composition/publication/actual cutover and
 * full13 streamed native export. Fixture setup and independent materialized
 * decode are outside measurement. An outer admitted supervisor must measure
 * native/Worker tree RSS/CPU and drain all original processes; own-process RSS
 * and observed Knex query events supply no physical lock-duration receipt. */
describe.each(snapshotMeasurementCases)('actual native program measurement: $name', shape => {
  test.each([0, 5])(
    'native import/cutover/export with %i ms source-chunk latency',
    async readDelayMs => {
      const native = observeNativeProfileMeasurement()
      let fixture: Awaited<ReturnType<typeof composedNativeFixture>>
      try {
        fixture = await composedNativeFixture(
          nativeTestExecutable(),
          () => {},
          nativeProgrammeFixtureLifetimeMilliseconds,
          shape
        )
      } catch (cause) {
        try {
          native.close()
        } catch (cleanup) {
          throw new AggregateError([cause, cleanup], 'Native fixture setup preserves observer cleanup failure')
        }
        throw cause
      }
      let stream: Awaited<ReturnType<typeof createBrc38Stream>> | undefined,
        cipher: Awaited<ReturnType<typeof createBrc39NodeFileQuarantine>> | undefined,
        failed = false,
        failure: unknown
      const reports: Record<string, unknown>[] = [],
        observerOwners = new Set<Knex>()
      const measure = async <T>(
        phase: string,
        run: (signal: AbortSignal) => Promise<T>,
        readers: readonly InstanceType<typeof StorageKnex>[] = []
      ): Promise<T> => {
        const cancellation = new AbortController()
        const signal = AbortSignal.any([native.signal, cancellation.signal])
        native.beginPhase()
        const began = performance.now(),
          cpuStart = process.cpuUsage(),
          rssStart = process.memoryUsage().rss,
          eventLoop: number[] = [],
          foreground: number[] = []
        let peakRss = rssStart,
          queries = 0,
          expected = began + 5,
          pending = false,
          foregroundWork: Promise<void> = Promise.resolve(),
          fault: unknown
        const reportFault = (cause: unknown): void => {
          if (fault === undefined) {
            fault = cause
            cancellation.abort(cause)
          }
        }
        const query = (): void => {
          queries++
        }
        const observeCurrent = (): void => {
          const provider = fixture.manager.getActive()
          if (!(provider instanceof StorageKnex))
            throw new Error('Native measurement requires its actual current provider')
          for (const actor of [provider, ...readers])
            if (!observerOwners.has(actor.knex)) {
              actor.knex.on('query', query)
              observerOwners.add(actor.knex)
            }
        }
        observeCurrent()
        const timer = setInterval(() => {
          const now = performance.now()
          peakRss = Math.max(peakRss, process.memoryUsage().rss)
          if (eventLoop.length >= 32768) {
            reportFault(new Error('Native program sample ceiling reached'))
            return
          }
          eventLoop.push(Math.max(0, now - expected))
          expected = now + 5
          if (pending || fault !== undefined) return
          pending = true
          const started = performance.now()
          foregroundWork = Promise.resolve()
            .then(async () => {
              await fixture.manager.runAsReader(async active => {
                observeCurrent()
                if (!(active instanceof StorageKnex))
                  throw new Error('Native foreground read requires its actual provider')
                return await active.findTxLabels({
                  partial: { userId: fixture.manager.getActiveUser().userId },
                  paged: { limit: 20, offset: 0 }
                })
              })
              await fixture.manager.runAsWriter(async active => {
                if (!(active instanceof StorageKnex))
                  throw new Error('Native foreground write requires its actual provider')
                return await active.findOrInsertOutputBasket(fixture.manager.getActiveUser().userId, 'default')
              })
              foreground.push(performance.now() - started)
            })
            .catch(reportFault)
            .finally(() => {
              pending = false
            })
        }, 5)
        let value: T
        try {
          value = await run(signal)
        } finally {
          clearInterval(timer)
          await foregroundWork
          for (const owner of observerOwners) owner.off('query', query)
          observerOwners.clear()
        }
        if (fault !== undefined) throw fault
        const wallMs = performance.now() - began,
          cpu = process.cpuUsage(cpuStart)
        expect(wallMs).toBeLessThan(120000)
        expect(peakRss - rssStart).toBeLessThan(512 * 1024 * 1024)
        expect(percentile(eventLoop, 0.95)).toBeLessThan(1500)
        expect(percentile(foreground, 0.95)).toBeLessThan(1500)
        expect(foreground.length).toBeGreaterThan(0)
        const protocol = native.report()
        expect(protocol.nativeSqlQueries).toBeGreaterThan(0)
        reports.push({
          fixture: shape.name,
          phase,
          readDelayMs,
          wallMs,
          ownCpuMs: (cpu.user + cpu.system) / 1000,
          ownRssStart: rssStart,
          ownPeakRss: peakRss,
          observedServingKnexQueries: queries,
          queryScope:
            'current serving provider Knex events; private kernels, catalog and internal native commands excluded',
          processTreeQualified: false,
          nativeSqlQueries: protocol.nativeSqlQueries,
          nativeRequests: protocol.nativeRequests,
          nativeRequestWireBytes: protocol.requestWireBytes,
          nativeResponseWireBytes: protocol.responseWireBytes,
          writerEnclosureSamples: protocol.writerEnclosureLowerMs.length,
          writerEnclosureLowerP95Ms: percentile(protocol.writerEnclosureLowerMs, 0.95),
          writerEnclosureUpperP95Ms: percentile(protocol.writerEnclosureUpperMs, 0.95),
          writerEnclosureUpperMaximumMs: Math.max(0, ...protocol.writerEnclosureUpperMs),
          exactKernelLockDuration: false,
          eventLoopP95Ms: percentile(eventLoop, 0.95),
          foregroundSamples: foreground.length,
          foregroundP50Ms: percentile(foreground, 0.5),
          foregroundP95Ms: percentile(foreground, 0.95),
          foregroundP99Ms: percentile(foreground, 0.99)
        })
        return value
      }
      const delayed = (source: AsyncIterable<Uint8Array>): AsyncIterable<Uint8Array> =>
        (async function* () {
          for await (const bytes of source) {
            if (readDelayMs !== 0) await new Promise(resolve => setTimeout(resolve, readDelayMs))
            yield bytes
          }
        })()
      try {
        const auxiliary = await seedComposedAuxiliaryFixture(fixture.storage, fixture.manager)
        await assertComposedAuxiliaryFixture(fixture.manager, auxiliary)
        const imported = await measure(
          'authenticated-full47-native-import-and-cutover',
          async signal =>
            await importBrc39ComposedNativeProfile(
              delayed(fixture.chunks()),
              authenticatedStagePassword,
              fixture.importOptions(signal)
            )
        )
        expect(fixture.sourceProfile.ownershipReleased).toBe(true)
        expect(fixture.manager.getActive()).toBe(imported.provider)
        expect(fixture.manager.isActiveEnabled).toBe(true)
        expect(
          await imported.provider.countTxLabels({ partial: { userId: fixture.manager.getActiveUser().userId } })
        ).toBe(shape.labels + 1)
        await assertComposedAuxiliaryFixture(fixture.manager, auxiliary)
        expect(fixture.merge.workingAllocation.used).toBe(0)
        expect(fixture.temporaryQuota.used).toBe(0)
        const policy = {
          maximumFileBytes: 8388608,
          maximumChunkBytes: 4096,
          maximumIterations: 7,
          maximumMemoryKiB: 131072,
          maximumParallelism: 1
        }
        // Actual opaque private-file custody, not a synthetic byte sink. Final
        // semantic/ciphertext compatibility is checked independently below.
        cipher = await createBrc39NodeFileQuarantine(
          fixture.directory,
          async bytes => {
            let count = 0
            for await (const chunk of bytes) count += chunk.byteLength
            expect(count).toBeGreaterThan(113)
            expect(count).toBeLessThanOrEqual(policy.maximumFileBytes)
          },
          policy
        )
        fixture.retainCleanup(async () => await cipher?.discard())
        const reader = await fixture.openPortableReader(imported.provider)
        const encrypted = await measure(
          'full13-native-streamed-export',
          async signal => {
            const source = await openBrc38KnexSource(reader, fixture.manager.getActiveUser().identityKey, {
              maximumPageRows: 128,
              maximumPageBytes: 262144,
              maximumMetadataAllocationBytes: 65536,
              maximumRowAllocationBytes: 1048576,
              maximumCertificateGroupBytes: 1048576,
              lifetimeMs: Math.min(120000, fixture.expiresAt - Date.now()),
              signal,
              streamedBinary: { maximumBinaryBytes: 1048576, maximumExtentBytes: 4096 },
              streamedText: { maximumTextBytes: 1048576 },
              streamedStructured: {
                maximumStructuredBytes: 2097152,
                privateIndexParent: fixture.directory,
                maximumTemporaryIndexBytes: 8388608,
                maximumIndexMembers: 30000
              }
            })
            fixture.retainCleanup(async () => await source.release())
            stream = await createBrc38Stream(source, {
              exportedAt: '2026-10-08T00:00:00.000Z',
              maximumArchiveBytes: 8388608,
              maximumRowBytes: 4194304,
              maximumChunkBytes: 4096,
              signal,
              streamedRows: {
                maximumMetadataAllocationBytes: 65536,
                maximumBinaryBytes: 1048576,
                maximumStructuredBytes: 2097152,
                maximumTextBytes: 1048576,
                maximumRowBytes: 4194304
              }
            })
            fixture.retainCleanup(async () => await stream?.close())
            return await encryptBrc39StreamToQuarantine(
              { ...stream, chunks: delayed(stream.chunks) },
              authenticatedStagePassword,
              cipher!,
              { policy, maximumPasswordBytes: 1024, maximumKdfMilliseconds: 30000, signal }
            )
          },
          [reader]
        )
        await cipher.validateAuthenticated()
        await cipher.withAuthenticatedChunks(async chunks => {
          const parts: Uint8Array[] = []
          let size = 0
          for await (const chunk of chunks) {
            size += chunk.byteLength
            expect(size).toBeLessThanOrEqual(policy.maximumFileBytes)
            parts.push(chunk)
          }
          const bytes = Buffer.concat(parts)
          try {
            expect(bytes.byteLength).toBe(encrypted.fileBytes)
            const data = await decryptBRC39(bytes, authenticatedStagePassword.normalize('NFC'))
            expect(data.tables.txLabels).toHaveLength(shape.labels + 1)
            const rawTx = data.tables.provenTxs[0].rawTx
            if (typeof rawTx !== 'string') throw new Error('Independent decoded proof has no base64 bytes')
            expect(Buffer.from(rawTx, 'base64')).toEqual(Buffer.from(fixture.proof.tx.toBinary()))
            expect(data.tables.provenTxReqs[0].history).toEqual(fixture.incomingData.tables.provenTxReqs[0].history)
            for (const rows of Object.values(data.tables)) expect(rows.length).toBeGreaterThan(0)
          } finally {
            bytes.fill(0)
            for (const part of parts) part.fill(0)
          }
        })
        process.stdout.write(
          JSON.stringify({
            nativeSnapshotProgramMeasurement: reports,
            ownProcessOnly: true,
            full47AuxiliaryOracleRetained: true
          }) + '\n'
        )
      } catch (cause) {
        failed = true
        failure = cause
      }
      const cleanup: unknown[] = []
      try {
        await fixture.close()
      } catch (cause) {
        cleanup.push(cause)
      }
      try {
        native.close()
      } catch (cause) {
        cleanup.push(cause)
      }
      if (cleanup.length !== 0)
        throw new AggregateError(
          failed ? [failure, ...cleanup] : cleanup,
          'Native measurement retains original cleanup and observer faults'
        )
      if (failed) throw failure
    },
    nativeProgrammeCaseMilliseconds
  )
})
