import {
  Brc38StreamedNotifyProjection,
  type Brc38StreamedNotifyProjectionPolicy
} from './Brc38StreamedNotifyProjection'
import type { Brc38StructuredProjectionOwners } from './Brc38StructuredProjectionOwners'
import {
  stringifyBrc38StructuredJsonSpan,
  verifyBrc38StructuredSourceDigest,
  type Brc38StreamedStructured
} from './Brc38StructuredJson'
import { brc38WorkingAllocation } from './Brc38WorkingAllocation'
import { Brc38CleanupScope, Brc38StagingCleanupError } from './Brc38StagingCleanupError'
import { SnapshotResourceLimitError } from '../snapshot/SnapshotResourceLimitError'

/** Complete occupied notification spelling. Legacy merge only sorts/dedupes
 * existing local IDs when at least one mapped incoming ID is processed. With
 * no such ID it preserves their order/duplicates; an incoming defined array
 * still initializes an absent/null current member. Original extras/order/null
 * remain. notifiedReset is DATA: legacy writes it only if some other compared
 * batch/history/notify/timestamp field actually causes the row to be persisted. */
export async function prepareBrc38StreamedNotifyField(
  selectedOwners: Brc38StructuredProjectionOwners,
  selectedIncoming: Brc38StreamedStructured,
  selectedPolicy: Brc38StreamedNotifyProjectionPolicy,
  selectedExisting: Brc38StreamedStructured
): Promise<
  Readonly<{
    unmappedIds: number
    notifiedReset: boolean
    measureChunks(width?: number): AsyncIterable<Uint8Array>
    chunks(width?: number): AsyncIterable<Uint8Array>
    close(): Promise<void>
  }>
> {
  const owners = Object.freeze({ ...selectedOwners }),
    incoming = Object.freeze({ ...selectedIncoming }),
    existing = Object.freeze({ ...selectedExisting }),
    policy = Object.freeze({ ...selectedPolicy }),
    working = brc38WorkingAllocation(policy.workingAllocation),
    deadline = performance.now() + policy.expiresAt - Date.now()
  if (working === undefined) throw new Error('Occupied notification field requires its original shared working owner')
  const retained = working.claim(8192),
    failures = new Set<Brc38StagingCleanupError>()
  let projection: Brc38StreamedNotifyProjection | undefined,
    closed = false,
    consumed = false,
    measured = false,
    measurementEnded = false,
    iterator: AsyncGenerator<Uint8Array> | undefined,
    closing: Promise<void> | undefined
  const check = (): void => {
      policy.signal?.throwIfAborted()
      owners.check()
      if (closed || Date.now() >= policy.expiresAt || performance.now() >= deadline)
        throw new SnapshotResourceLimitError('Occupied notification field reached its original deadline')
    },
    cleanup = async (): Promise<void> => {
      const causes: unknown[] = []
      try {
        await projection?.close()
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
        throw new Brc38StagingCleanupError(causes, 'Occupied notification retains original index acquisitions', cleanup)
      retained.close()
    }
  try {
    check()
    projection = await Brc38StreamedNotifyProjection.prepare(owners, incoming, policy, existing)
    check()
    const replace =
        projection.mappedIncomingIds > 0 || (projection.incomingIdsPresent && !projection.existingIdsPresent),
      produce = async function* (width: number, measurement = false): AsyncGenerator<Uint8Array> {
        let failed = false,
          original: unknown,
          completed = false
        const cleanupScope1 = new Brc38CleanupScope(async () => {
          if (!measurement || !completed) closed = true
          try {
            if (!measurement || !completed) await cleanup()
          } catch (cause) {
            throw new Brc38StagingCleanupError(
              failed ? [original, cause] : [cause],
              'Occupied notification field retains concrete index cleanup',
              cleanup
            )
          }
        })
        try {
          check()
          const ids = !replace
            ? undefined
            : {
                member: 'transactionIds' as const,
                chunks: (maximum: number) =>
                  measurement ? projection!.measureChunks(maximum) : projection!.chunks(maximum),
                check,
                close: measurement
                  ? async () => undefined
                  : async () => {
                      await projection!.close()
                    }
              }
          for await (const bytes of stringifyBrc38StructuredJsonSpan(
            existing,
            { start: 0, end: existing.length },
            {
              maximumInputBytes: 1000000000,
              maximumOutputBytes: policy.maximumOutputBytes,
              maximumChunkBytes: width,
              maximumAllocationBytes: policy.maximumGrammarAllocationBytes,
              workingAllocation: working,
              signal: policy.signal
            },
            undefined,
            ids
          )) {
            check()
            yield bytes
          }
          check()
          await verifyBrc38StructuredSourceDigest(
            incoming,
            1000000000,
            policy.signal,
            width,
            policy.maximumGrammarAllocationBytes,
            working
          )
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
      },
      widthCheck = (width: number): void => {
        check()
        if (!Number.isSafeInteger(width) || width < 64 || width > (policy.maximumReadBytes ?? 65536))
          throw new RangeError('Occupied notification field exceeds its original transfer window')
      }
    return Object.freeze({
      unmappedIds: projection.unmappedIds,
      notifiedReset: projection.mappedIncomingIds > 0,
      measureChunks: (width = policy.maximumReadBytes ?? 65536): AsyncIterable<Uint8Array> => {
        widthCheck(width)
        if (measured || consumed)
          throw new Error('Occupied notification measurement was already requested or output consumed')
        measured = true
        iterator = produce(width, true)
        return iterator
      },
      chunks: (width = policy.maximumReadBytes ?? 65536): AsyncIterable<Uint8Array> => {
        widthCheck(width)
        if (consumed || (measured && !measurementEnded))
          throw new Error('Occupied notification requires unconsumed output and complete measurement EOF')
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
              'Revoked occupied notification retains concrete cleanup',
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
      throw new Brc38StagingCleanupError([cause, error_], 'Occupied notification preparation retains cleanup', cleanup)
    }
    throw cause
  }
}
