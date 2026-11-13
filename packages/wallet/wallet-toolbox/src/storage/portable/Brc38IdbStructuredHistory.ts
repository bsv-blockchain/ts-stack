import { mapAwaitFromSync } from '../../utility/promiseFromSync'
import { Brc38PrivateIdbStage, type Brc38PrivateIdbStructuredRead } from './Brc38PrivateIdbStage'
import { Brc38IdbImportJournal } from './Brc38IdbImportJournal'
import { boundedJson, digest, type Brc38ImportJournalReceipt } from './Brc38ImportJournalContract'
import {
  Brc38StreamedNotifyProjection,
  type Brc38StreamedNotifyProjectionPolicy
} from './Brc38StreamedNotifyProjection'
import {
  Brc38StreamedSyncMapProjection,
  type Brc38StreamedSyncMapProjectionPolicy
} from './Brc38StreamedSyncMapProjection'
import { canonicalBrc38ProjectedNotify } from './Brc38StructuredJson'
import {
  brc38PrivateIdbStructuredPolicy,
  type Brc38PrivateIdbStructuredPolicy
} from './Brc38PrivateIdbStructuredPolicy'
import type { Brc38StructuredProjectionOwners } from './Brc38StructuredProjectionOwners'
import { Brc38CleanupScope, Brc38StagingCleanupError } from './Brc38StagingCleanupError'

export interface Brc38IdbStructuredHistory {
  readonly field: 'notify' | 'syncMap'
  readonly unmappedIds: number
  /** Operational JSON only. Original source chunks remain separate provenance.
   * Bytes are provisional until complete EOF, current receipt and cleanup. */
  chunks(maximumChunkBytes?: number): AsyncIterable<Uint8Array>
  close(): Promise<void>
}

/** Large browser histories use actual bounded native staging indexes and fresh
 * journal map batches. Preparation, sorting and output hold no wallet writer.
 * This is not source authentication, destination inventory or activation: an
 * enclosing controller must replay the encrypted source and commit genuine
 * staged fields, original provenance and checkpoint in the same transaction. */
export async function prepareBrc38IdbStructuredHistory(
  source: Brc38PrivateIdbStage,
  journal: Brc38IdbImportJournal,
  current: Readonly<Brc38ImportJournalReceipt>,
  table: 'provenTxReqs' | 'syncStates',
  position: number,
  field: 'notify' | 'syncMap',
  selectedSourcePolicy: Brc38PrivateIdbStructuredPolicy,
  selectedProjectionPolicy: Brc38StreamedNotifyProjectionPolicy | Brc38StreamedSyncMapProjectionPolicy
): Promise<Readonly<Brc38IdbStructuredHistory>> {
  const sourcePolicy = brc38PrivateIdbStructuredPolicy(selectedSourcePolicy),
    policy = Object.freeze({ ...selectedProjectionPolicy }),
    working = journal.workingAllocation
  if (
    working === undefined ||
    policy.workingAllocation !== working ||
    (field === 'notify' && table !== 'provenTxReqs') ||
    (field === 'syncMap' && table !== 'syncStates') ||
    !['notify', 'syncMap'].includes(field) ||
    policy.expiresAt > source.limits.expiresAt ||
    policy.expiresAt > journal.admission.expiresAt ||
    policy.maximumTemporaryIndexBytes > sourcePolicy.maximumTemporaryIndexBytes ||
    policy.maximumMembers > sourcePolicy.maximumIndexMembers ||
    (field === 'syncMap' && !Object.hasOwn(policy, 'maximumScalarBytes'))
  )
    throw new Error('Browser structured history requires its original source, journal and aggregate resource admission')
  policy.signal?.throwIfAborted()
  const retained = working.claim(8192 + 16 * 4096),
    readers = new Set<Brc38PrivateIdbStructuredRead>(),
    failures = new Set<Brc38StagingCleanupError>()
  let receiptSha256: string
  let prepared: Brc38StreamedNotifyProjection | Brc38StreamedSyncMapProjection | undefined,
    closed = false,
    consumed = false,
    iterator: AsyncGenerator<Uint8Array> | undefined,
    closing: Promise<void> | undefined
  const open = async (): Promise<Brc38PrivateIdbStructuredRead> => {
    policy.signal?.throwIfAborted()
    if (closed) throw new Error('Browser structured history has been revoked')
    const reader = await source.openStructuredField(table, position, field, sourcePolicy, working, policy.expiresAt)
    readers.add(reader)
    if (closed) {
      await reader.close()
      throw new Error('Browser structured history was revoked during source acquisition')
    }
    return reader
  }
  const currentReceipt = (): Promise<void> =>
    mapAwaitFromSync(
      () => journal.readMappings(receiptSha256, []),
      read => {
        read.close()
        policy.signal?.throwIfAborted()
      }
    )
  const cleanup = async (): Promise<void> => {
    const causes: unknown[] = []
    if (prepared !== undefined)
      try {
        await prepared.close()
      } catch (cause) {
        causes.push(cause)
      }
    for (const reader of readers)
      try {
        await reader.close()
        readers.delete(reader)
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
        'Browser structured history retains original indexes and allocations until actual cleanup',
        cleanup
      )
    retained.close()
  }
  try {
    receiptSha256 = digest(boundedJson(current))
    await currentReceipt()
    const reader = await open(),
      owners: Brc38StructuredProjectionOwners = Object.freeze({
        check: reader.check,
        openIndex: reader.openIndex,
        readMappings: async (
          entity: Parameters<Brc38StructuredProjectionOwners['readMappings']>[0],
          incoming: readonly number[]
        ) => {
          reader.check()
          const read = await journal.readMappings(
            receiptSha256,
            incoming.map(incomingId => ({ entity, incomingId, required: false }))
          )
          try {
            reader.check()
            return read.mappings.map(value => value.localId)
          } finally {
            read.close()
          }
        }
      })
    prepared =
      field === 'notify'
        ? await Brc38StreamedNotifyProjection.prepare(owners, reader.source, policy)
        : await Brc38StreamedSyncMapProjection.prepare(
            owners,
            reader.source,
            policy as Brc38StreamedSyncMapProjectionPolicy
          )
    await currentReceipt()
    const produce = async function* (width: number): AsyncGenerator<Uint8Array> {
      let original: unknown,
        failed = false
      const cleanupScope1 = new Brc38CleanupScope(async () => {
        closed = true
        try {
          await cleanup()
        } catch (error_) {
          throw new Brc38StagingCleanupError(
            failed ? [original, error_] : [error_],
            'Browser structured history output retains actual cleanup',
            cleanup
          )
        }
      })
      try {
        const assembly = await open()
        await currentReceipt()
        const chunks =
          prepared instanceof Brc38StreamedNotifyProjection
            ? canonicalBrc38ProjectedNotify(
                assembly.source,
                {
                  maximumInputBytes: sourcePolicy.maximumStructuredBytes,
                  maximumOutputBytes: policy.maximumOutputBytes,
                  maximumChunkBytes: width,
                  maximumAllocationBytes: policy.maximumGrammarAllocationBytes,
                  workingAllocation: working,
                  signal: policy.signal
                },
                `${table}[${position}].${field}`,
                prepared
              )
            : (prepared as Brc38StreamedSyncMapProjection).chunks(width, assembly.source)
        for await (const bytes of chunks) {
          if (closed) throw new Error('Browser structured history output has been revoked')
          yield bytes
        }
        await currentReceipt()
      } catch (cause) {
        original = cause
        failed = true
        {
          await cleanupScope1.close()
          throw cause
        }
      } finally {
        await cleanupScope1.close()
      }
    }
    return Object.freeze({
      field,
      unmappedIds: prepared.unmappedIds,
      chunks: (width = 65536): AsyncIterable<Uint8Array> => {
        if (closed || consumed) throw new Error('Browser structured history output is closed or already consumed')
        if (!Number.isSafeInteger(width) || width < 64 || width > (policy.maximumReadBytes ?? 65536))
          throw new RangeError('Browser structured history exceeds its original output window')
        consumed = true
        iterator = produce(width)
        return iterator
      },
      close: (): Promise<void> => {
        if (closing !== undefined) return closing
        closed = true
        closing = (async () => {
          if (iterator !== undefined) await iterator.return(undefined)
          await cleanup()
        })()
        void closing.catch(() => {
          closing = undefined
        })
        return closing
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
        'Browser structured history preparation retains cleanup',
        cleanup
      )
    }
    throw cause
  }
}
