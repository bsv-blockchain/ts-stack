import { SHA256 } from '@bsv/sdk/primitives/Hash'
import type { StorageIdb } from '../StorageIdb'
import type { PackedIdbStagedField } from '../idbPackedStaging'
import type { PackedIdbCurrentMetadata } from '../idbPackedCurrentMetadata'
import { getPackedIdbConnection } from '../idbPackedConnection'
import { IdbSnapshotSyncJournal, captureIdbSnapshotSyncCheckpoint } from '../snapshot/IdbSnapshotSyncJournal'
import type { SnapshotSyncCheckpoint } from '../snapshot/SnapshotSync'
import type { PackedIdbCurrentStructuredLimits } from '../snapshot/PackedIdbCurrentStructuredRead'
import type { Brc38PrivateIdbStage } from './Brc38PrivateIdbStage'
import {
  brc38PrivateIdbStructuredPolicy,
  type Brc38PrivateIdbStructuredPolicy
} from './Brc38PrivateIdbStructuredPolicy'
import type { Brc38StreamedHistoryProjectionPolicy } from './Brc38StreamedHistoryProjection'
import { prepareBrc38IdbOccupiedHistory } from './Brc38IdbOccupiedHistory'
import { brc38WorkingAllocation } from './Brc38WorkingAllocation'
import { brc38Utf16Chunks } from './Brc38Utf16Chunks'
import { Brc38StagingCleanupError } from './Brc38StagingCleanupError'
import { SnapshotResourceLimitError } from '../snapshot/SnapshotResourceLimitError'

/** Measure and replay the SAME retained span/timestamp DATA into one genuine
 * occupied-provider stage. Both complete passes independently read/hash actual
 * original fields. Persisted finish independently hashes the staged chunks.
 * No source I/O belongs in the eventual row/checkpoint writer; this stage is
 * neither archive authentication nor authority to adopt original provenance. */
export async function prepareBrc38IdbOccupiedHistoryStage(
  source: Brc38PrivateIdbStage,
  sourcePosition: number,
  storage: StorageIdb,
  journal: IdbSnapshotSyncJournal,
  selectedCheckpoint: SnapshotSyncCheckpoint,
  selectedTxid: string,
  selectedSource: Brc38PrivateIdbStructuredPolicy,
  selectedCurrent: PackedIdbCurrentStructuredLimits,
  selectedProjection: Brc38StreamedHistoryProjectionPolicy,
  selectedMaximumUtf16Bytes: number
): Promise<
  Readonly<{
    current: Readonly<PackedIdbCurrentMetadata>
    addedNotes: number
    bytes: number
    sha256: string
    staged: PackedIdbStagedField
    close(): Promise<void>
  }>
> {
  const checkpoint = captureIdbSnapshotSyncCheckpoint(selectedCheckpoint),
    txid = selectedTxid,
    sourcePolicy = brc38PrivateIdbStructuredPolicy(selectedSource),
    currentPolicy = Object.freeze({ ...selectedCurrent }),
    projectionPolicy = Object.freeze({ ...selectedProjection }),
    maximumUtf16Bytes = selectedMaximumUtf16Bytes,
    working = brc38WorkingAllocation(projectionPolicy.workingAllocation),
    deadline = performance.now() + projectionPolicy.expiresAt - Date.now()
  if (
    working === undefined ||
    !Number.isSafeInteger(maximumUtf16Bytes) ||
    maximumUtf16Bytes < 2 ||
    maximumUtf16Bytes > 1000000000 ||
    maximumUtf16Bytes % 2 !== 0 ||
    !Number.isSafeInteger(currentPolicy.maximumMetadataBytes) ||
    currentPolicy.maximumMetadataBytes < 1 ||
    currentPolicy.maximumMetadataBytes > 16777216
  )
    throw new RangeError('Invalid occupied history staging resource admission')
  journal.requireStorage(storage)
  const retained = working.claim(16384 + 8 * currentPolicy.maximumMetadataBytes + 12 * 65536),
    failures = new Set<Brc38StagingCleanupError>()
  let field: Awaited<ReturnType<typeof prepareBrc38IdbOccupiedHistory>> | undefined,
    staged: PackedIdbStagedField | undefined,
    closed = false,
    closing: Promise<void> | undefined
  const check = (): void => {
      projectionPolicy.signal?.throwIfAborted()
      journal.requireStorage(storage)
      if (closed || Date.now() >= projectionPolicy.expiresAt || performance.now() >= deadline)
        throw new SnapshotResourceLimitError('Occupied history staging reached its original admission deadline')
      const owner = storage.db === undefined ? undefined : getPackedIdbConnection(storage.db)
      if (owner === undefined || !owner.isOpen) throw new Error('Occupied history staging provider was replaced')
    },
    cleanup = async (): Promise<void> => {
      closed = true
      const causes: unknown[] = []
      if (field !== undefined)
        try {
          await field.close()
        } catch (cause) {
          causes.push(cause)
        }
      if (staged !== undefined)
        try {
          // Owner loss cannot be reported as concrete content retirement.
          journal.requireStorage(storage)
          await staged.close()
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
          'Occupied history stage retains original content/source allocations until actual retirement',
          cleanup
        )
      retained.close()
    }
  try {
    check()
    field = await prepareBrc38IdbOccupiedHistory(
      source,
      sourcePosition,
      journal,
      checkpoint,
      txid,
      sourcePolicy,
      currentPolicy,
      projectionPolicy
    )
    check()
    const first = new SHA256()
    let bytes = 0
    for await (const chunk of brc38Utf16Chunks(
      field.measureChunks(),
      maximumUtf16Bytes,
      working,
      projectionPolicy.signal
    )) {
      try {
        check()
        first.update(chunk)
        bytes += chunk.length
      } finally {
        chunk.fill(0)
      }
    }
    check()
    const sha256 = first.digestHex()
    staged = await storage.beginPackedStorageField({
      kind: 'utf16',
      bytes,
      sha256,
      expiresAt: projectionPolicy.expiresAt,
      lifetimeMs: Math.min(3600000, Math.max(1, projectionPolicy.expiresAt - Date.now())),
      signal: projectionPolicy.signal
    })
    check()
    const second = new SHA256()
    let written = 0
    for await (const chunk of brc38Utf16Chunks(field.chunks(), maximumUtf16Bytes, working, projectionPolicy.signal)) {
      try {
        check()
        second.update(chunk)
        if (chunk.length > bytes - written) throw new Error('Occupied history replay exceeds measured content')
        await staged.append(written, chunk)
        written += chunk.length
        check()
      } finally {
        chunk.fill(0)
      }
    }
    if (written !== bytes || second.digestHex() !== sha256)
      throw new Error('Occupied history replay differs from measured content')
    check()
    const actual = await staged.finish()
    check()
    if (actual.kind !== 'utf16' || actual.bytes !== bytes || actual.sha256 !== sha256)
      throw new Error('Occupied history persisted postimage differs')
    return Object.freeze({
      current: field.current,
      addedNotes: field.addedNotes,
      bytes,
      sha256,
      staged,
      close: async (): Promise<void> => {
        if (closing !== undefined) return await closing
        closing = cleanup()
        try {
          await closing
        } catch (cause) {
          closing = undefined
          throw cause
        }
      }
    })
  } catch (cause) {
    if (cause instanceof Brc38StagingCleanupError) failures.add(cause)
    try {
      await cleanup()
    } catch (error_) {
      throw new Brc38StagingCleanupError(
        [cause, error_],
        'Occupied history staging failed with retained cleanup',
        cleanup
      )
    }
    throw cause
  }
}
