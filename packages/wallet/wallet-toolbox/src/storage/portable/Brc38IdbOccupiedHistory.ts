import { promiseFromSync } from '../../utility/promiseFromSync'
import { Brc38PrivateIdbStage, type Brc38PrivateIdbStructuredRead } from './Brc38PrivateIdbStage'
import {
  brc38PrivateIdbStructuredPolicy,
  type Brc38PrivateIdbStructuredPolicy
} from './Brc38PrivateIdbStructuredPolicy'
import {
  Brc38StreamedHistoryProjection,
  type Brc38StreamedHistoryProjectionPolicy
} from './Brc38StreamedHistoryProjection'
import { Brc38CleanupScope, Brc38StagingCleanupError } from './Brc38StagingCleanupError'
import { brc38WorkingAllocation, Brc38WorkingAllocation, type Brc38WorkingCharge } from './Brc38WorkingAllocation'
import { IdbSnapshotSyncJournal, captureIdbSnapshotSyncCheckpoint } from '../snapshot/IdbSnapshotSyncJournal'
import type { SnapshotSyncCheckpoint } from '../snapshot/SnapshotSync'
import type {
  PackedIdbCurrentStructuredRead,
  PackedIdbCurrentStructuredLimits
} from '../snapshot/PackedIdbCurrentStructuredRead'
import type { PackedIdbCurrentMetadata } from '../idbPackedCurrentMetadata'
import type { Brc38StructuredProjectionOwners } from './Brc38StructuredProjectionOwners'
import { createSyncMap } from '../schema/entities/EntityBase'
import { assertIsoDate } from './Brc38PortableRows'
import type { Brc38JsonMember, Brc38JsonMemberIndex, Brc38StreamedStructured } from './Brc38StructuredJson'

/** Actual occupied browser history actors. This prepares a provisional field;
 * it does not authenticate the archive or install a row/checkpoint. The final
 * writer must re-read current metadata/maps/proofs and commit original source
 * provenance with genuine staged output under the actual operational journal. */
export async function prepareBrc38IdbOccupiedHistory(
  source: Brc38PrivateIdbStage,
  sourcePosition: number,
  destination: IdbSnapshotSyncJournal,
  selectedCheckpoint: SnapshotSyncCheckpoint,
  selectedTxid: string,
  selectedSource: Brc38PrivateIdbStructuredPolicy,
  selectedCurrent: PackedIdbCurrentStructuredLimits,
  selectedProjection: Brc38StreamedHistoryProjectionPolicy
): Promise<
  Readonly<{
    current: Readonly<PackedIdbCurrentMetadata>
    addedNotes: number
    measureChunks(width?: number): AsyncIterable<Uint8Array>
    chunks(width?: number): AsyncIterable<Uint8Array>
    close(): Promise<void>
  }>
> {
  const checkpoint = captureIdbSnapshotSyncCheckpoint(selectedCheckpoint),
    txid = selectedTxid,
    sourcePolicy = brc38PrivateIdbStructuredPolicy(selectedSource),
    currentPolicy = Object.freeze({ ...selectedCurrent }),
    projectionPolicy = Object.freeze({ ...selectedProjection }),
    working = brc38WorkingAllocation(projectionPolicy.workingAllocation)
  if (
    working === undefined ||
    typeof txid !== 'string' ||
    !/^[0-9a-f]{64}$/.test(txid) ||
    !Number.isSafeInteger(sourcePosition) ||
    sourcePosition < 0 ||
    projectionPolicy.expiresAt > source.limits.expiresAt ||
    projectionPolicy.expiresAt > currentPolicy.expiresAt ||
    !Number.isSafeInteger(projectionPolicy.maximumReadBytes) ||
    projectionPolicy.maximumReadBytes < 64 ||
    projectionPolicy.maximumReadBytes > 65536 ||
    projectionPolicy.maximumReadBytes > currentPolicy.maximumReadBytes ||
    projectionPolicy.maximumTemporaryIndexBytes > currentPolicy.maximumTemporaryIndexBytes ||
    projectionPolicy.maximumMembers > currentPolicy.maximumIndexMembers
  )
    throw new Error('Occupied request-history requires its original actual source/current resource admission')
  const retained = working.claim(16384),
    failures = new Set<Brc38StagingCleanupError>(),
    sourceWorking =
      working.maximum <= source.limits.maximumRowAllocationBytes
        ? working
        : new Brc38WorkingAllocation(source.limits.maximumRowAllocationBytes)
  let sourceLoan: Brc38WorkingCharge | undefined
  let incoming: Brc38PrivateIdbStructuredRead | undefined,
    current: PackedIdbCurrentStructuredRead | undefined,
    field: Awaited<ReturnType<typeof Brc38StreamedHistoryProjection.prepareField>> | undefined,
    iterator: AsyncGenerator<Uint8Array> | undefined,
    closed = false,
    consumed = false,
    measured = false,
    measurementEnded = false,
    closing: Promise<void> | undefined
  const cleanup = async (): Promise<void> => {
      const causes: unknown[] = []
      if (field !== undefined)
        try {
          await field.close()
        } catch (cause) {
          causes.push(cause)
        }
      if (incoming !== undefined)
        try {
          await incoming.close()
        } catch (cause) {
          causes.push(cause)
        }
      if (current !== undefined)
        try {
          await current.close()
        } catch (cause) {
          causes.push(cause)
        }
      for (const failure of failures)
        try {
          await failure.retryCleanup()
          failures.delete(failure)
        } catch (cause) {
          causes.push(cause)
        }
      if (causes.length !== 0)
        throw new Brc38StagingCleanupError(
          causes,
          'Occupied browser history retains actual source/current/index cleanup',
          cleanup
        )
      if (sourceLoan !== undefined) {
        if (sourceWorking.used !== 0)
          throw new Brc38StagingCleanupError(
            [new Error('Private source still retains its original bounded working allocations')],
            'Occupied history cannot release its shared source loan before physical actor drainage',
            cleanup
          )
        sourceLoan.close()
      }
      retained.close()
    },
    check = (): void => {
      if (closed) throw new Error('Occupied browser history was revoked')
      projectionPolicy.signal?.throwIfAborted()
      incoming!.check()
      current!.check()
    }
  try {
    // A private source can have a smaller per-row ceiling than the complete
    // source/current/projection composition. Hold that complete sub-budget in
    // the actual shared owner until all of its original source actors drain.
    if (sourceWorking !== working) sourceLoan = working.claim(sourceWorking.maximum)
    let original: Awaited<ReturnType<Brc38PrivateIdbStage['ownedStreamedRow']>> | undefined =
      await source.ownedStreamedRow('provenTxReqs', sourcePosition, sourceWorking)
    let incomingUpdatedAt: string
    try {
      const value = original.row?.fields.updated_at
      assertIsoDate(value, 'original request updated_at')
      if (typeof value !== 'string') throw new Error('Original request timestamp differs')
      incomingUpdatedAt = value
    } finally {
      original.close()
      original = undefined
    }
    incoming = await source.openStructuredField(
      'provenTxReqs',
      sourcePosition,
      'history',
      sourcePolicy,
      sourceWorking,
      projectionPolicy.expiresAt
    )
    current = await destination.openCurrentStructuredField(
      checkpoint,
      { table: 'provenTxReqs', txid },
      createSyncMap(),
      'history',
      currentPolicy,
      working
    )
    check()
    const freshSource = async (): Promise<void> => {
      check()
      // This private reader returns independently owned bytes, unlike the
      // occupied reader's retained window. A zero-byte actual field read
      // repeats native schema/owner/descriptor checks without erasing a window
      // which the grammar is still using.
      const bytes = await incoming!.source.read(0, 0)
      bytes.fill(0)
      check()
    }
    const openProjectionIndex = async (
      policy: Parameters<Brc38StructuredProjectionOwners['openIndex']>[0]
    ): Promise<Brc38JsonMemberIndex> => {
      const captured = Object.freeze({ ...policy })
      await freshSource()
      const actual = await current!.openIndex(captured)
      try {
        await freshSource()
      } catch (cause) {
        try {
          await actual.close()
        } catch (error_) {
          throw new Brc38StagingCleanupError(
            [cause, error_],
            'Occupied history retains its original projection index',
            () => actual.close()
          )
        }
        throw cause
      }
      const operation = async <T>(work: () => Promise<T>): Promise<T> => {
        await freshSource()
        const value = await work()
        await freshSource()
        return value
      }
      return Object.freeze({
        put: (offset: number, member: Brc38JsonMember) => {
          const copy = Object.freeze({
            key: member.key,
            keyOffset: member.keyOffset,
            start: member.start,
            end: member.end
          })
          return operation(async () => await actual.put(offset, copy))
        },
        seal: async () => await operation(async () => await actual.seal()),
        lookup: async (offset: number, key: string) => await operation(async () => await actual.lookup!(offset, key)),
        nextEntry: async (offset: number, after?: string) =>
          await operation(async () => await actual.nextEntry!(offset, after)),
        entries: (offset: number) => {
          const iterator = actual.entries(offset)[Symbol.asyncIterator]()
          return (async function* () {
            try {
              for (;;) {
                const result = await operation(async () => await iterator.next())
                if (result.done) return
                yield result.value
              }
            } finally {
              await iterator.return?.()
            }
          })()
        },
        close: async () => await actual.close()
      })
    }
    const incomingSource: Brc38StreamedStructured = Object.freeze({
      ...incoming.source,
      // Grammar scratch belongs to the genuine occupied projection owner.
      // The private source remains only a bounded byte/metadata actor; its
      // independent per-row ceiling and the shared aggregate are both intact.
      openIndex: async () =>
        await openProjectionIndex({
          sourceBytes: incoming!.source.length,
          maximumTemporaryIndexBytes: sourcePolicy.maximumTemporaryIndexBytes,
          maximumTemporaryPhysicalBytes: sourcePolicy.maximumTemporaryIndexBytes,
          maximumMembers: sourcePolicy.maximumIndexMembers,
          maximumAllocationBytes: Math.min(
            sourceWorking.maximum,
            projectionPolicy.maximumIndexAllocationBytes ?? working.maximum
          ),
          workingAllocation: working,
          expiresAt: projectionPolicy.expiresAt,
          signal: projectionPolicy.signal
        })
    })
    const owners: Brc38StructuredProjectionOwners = Object.freeze({
      check,
      openIndex: openProjectionIndex,
      readMappings: () => {
        return promiseFromSync(() => {
          throw new Error('Request-history union does not consume ID mappings')
        })
      }
    })
    field = await Brc38StreamedHistoryProjection.prepareField(
      owners,
      incomingSource,
      projectionPolicy,
      current.source,
      incomingUpdatedAt
    )
    check()
    const produce = async function* (width: number, measurement = false): AsyncGenerator<Uint8Array> {
      let original: unknown,
        failed = false,
        completed = false
      const cleanupScope1 = new Brc38CleanupScope(async () => {
        if (!measurement || !completed) closed = true
        try {
          if (!measurement || !completed) await cleanup()
        } catch (cause) {
          throw new Brc38StagingCleanupError(
            failed ? [original, cause] : [cause],
            'Occupied browser history output remains provisional through actual drainage',
            cleanup
          )
        }
      })
      try {
        check()
        const chunks = measurement ? field!.measureChunks(width) : field!.chunks(width)
        for await (const bytes of chunks) {
          check()
          yield bytes
        }
        check()
        completed = true
        if (measurement) measurementEnded = true
      } catch (cause) {
        failed = true
        original = cause
        {
          await cleanupScope1.close()
          throw cause
        }
      } finally {
        await cleanupScope1.close()
      }
    }
    return Object.freeze({
      current: current.metadata,
      addedNotes: field.addedNotes,
      measureChunks: (width = projectionPolicy.maximumReadBytes): AsyncIterable<Uint8Array> => {
        check()
        if (measured || consumed)
          throw new Error('Occupied history measurement was already requested or output consumed')
        if (!Number.isSafeInteger(width) || width < 64 || width > projectionPolicy.maximumReadBytes)
          throw new RangeError('Occupied history measurement exceeds its original transfer bound')
        measured = true
        iterator = produce(width, true)
        return iterator
      },
      chunks: (width = projectionPolicy.maximumReadBytes): AsyncIterable<Uint8Array> => {
        check()
        if (consumed) throw new Error('Occupied browser history was already consumed')
        if (measured && !measurementEnded)
          throw new Error('Occupied history measurement must reach actual EOF before replay')
        if (!Number.isSafeInteger(width) || width < 64 || width > projectionPolicy.maximumReadBytes)
          throw new RangeError('Occupied browser history exceeds its original transfer bound')
        consumed = true
        iterator = produce(width)
        return iterator
      },
      close: async (): Promise<void> => {
        closed = true
        if (closing !== undefined) return await closing
        closing = (async () => {
          let original: unknown,
            failed = false
          try {
            await iterator?.return(undefined)
          } catch (cause) {
            original = cause
            failed = true
          }
          try {
            await cleanup()
          } catch (cause) {
            throw new Brc38StagingCleanupError(
              failed ? [original, cause] : [cause],
              'Revoked occupied history retains actual cleanup',
              cleanup
            )
          }
          if (failed) throw original
        })()
        try {
          await closing
        } catch (cause) {
          closing = undefined
          throw cause
        }
      }
    })
  } catch (cause) {
    closed = true
    if (cause instanceof Brc38StagingCleanupError) failures.add(cause)
    try {
      await cleanup()
    } catch (error_) {
      throw new Brc38StagingCleanupError(
        [cause, error_],
        'Occupied browser history acquisition retains cleanup',
        cleanup
      )
    }
    throw cause
  }
}
