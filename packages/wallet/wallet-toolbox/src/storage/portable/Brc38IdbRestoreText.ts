import { promiseFromSync, mapAwaitFromSync } from '../../utility/promiseFromSync'
import { SHA256 } from '@bsv/sdk/primitives/Hash'
import type { StorageIdb } from '../StorageIdb'
import { getPackedIdbConnection } from '../idbPackedConnection'
import { PackedIdbStagedField } from '../idbPackedStaging'
import { Brc38PrivateIdbStage, type Brc38PrivateIdbStructuredRead } from './Brc38PrivateIdbStage'
import { Brc38IdbImportJournal } from './Brc38IdbImportJournal'
import { boundedJson, digest, type Brc38ImportJournalReceipt } from './Brc38ImportJournalContract'
import {
  brc38PrivateIdbStructuredPolicy,
  type Brc38PrivateIdbStructuredPolicy
} from './Brc38PrivateIdbStructuredPolicy'
import type { Brc38StreamedSyncMapProjectionPolicy } from './Brc38StreamedSyncMapProjection'
import { prepareBrc38IdbStructuredHistory, type Brc38IdbStructuredHistory } from './Brc38IdbStructuredHistory'
import { validatedCanonicalBrc38StructuredWalletField } from './Brc38StructuredJson'
import { brc38Utf16Chunks } from './Brc38Utf16Chunks'
import { Brc38StagingCleanupError } from './Brc38StagingCleanupError'
import type { Brc38StageTable } from './Brc38SemanticStage'
import type { Brc38WorkingCharge } from './Brc38WorkingAllocation'
import { brc38JsonTextField } from './Brc38JsonTextFields'

export interface Brc38IdbRestoreText {
  readonly field: string
  readonly mode: 'original' | 'canonical' | 'mapped' | 'scalar'
  readonly bytes: number
  readonly sha256: string
  readonly unmappedIds: number
  readonly staged: PackedIdbStagedField
  /** Revokes the stage and retires unreferenced content; finite provider GC
   * separately deletes durable chunks. Attached live references remain. */
  close(): Promise<void>
}

/** Two actual source passes prepare genuine isolated packed UTF-16 content
 * outside the wallet writer. The first counts/hashes DATA; the second freshly
 * replays source/grammar/current mappings and must match it before finish.
 * Original mode preserves whitespace/duplicates as provenance. Canonical mode
 * validates visible original values. Mapped mode prepares inactive histories.
 * This does not authenticate encrypted source, authorize an original-content
 * pointer, commit provenance, qualify destination inventory or activate it. */
export async function prepareBrc38IdbRestoreText(
  source: Brc38PrivateIdbStage,
  storage: StorageIdb,
  journal: Brc38IdbImportJournal,
  current: Readonly<Brc38ImportJournalReceipt>,
  table: Brc38StageTable,
  position: number,
  field: string,
  mode: 'original' | 'canonical' | 'mapped' | 'scalar',
  selectedSourcePolicy: Brc38PrivateIdbStructuredPolicy,
  selectedProjection: Brc38StreamedSyncMapProjectionPolicy,
  maximumUtf16Bytes: number
): Promise<Readonly<Brc38IdbRestoreText>> {
  const sourcePolicy = brc38PrivateIdbStructuredPolicy(selectedSourcePolicy),
    policy = Object.freeze({ ...selectedProjection }),
    working = journal.workingAllocation
  if (
    working === undefined ||
    policy.workingAllocation !== working ||
    !['original', 'canonical', 'mapped', 'scalar'].includes(mode) ||
    !Number.isSafeInteger(maximumUtf16Bytes) ||
    maximumUtf16Bytes < 2 ||
    maximumUtf16Bytes > 1000000000 ||
    maximumUtf16Bytes % 2 !== 0 ||
    policy.expiresAt > source.limits.expiresAt ||
    policy.expiresAt > journal.admission.expiresAt ||
    !Number.isSafeInteger(policy.expiresAt) ||
    policy.expiresAt <= Date.now() ||
    policy.expiresAt - Date.now() > 3600000 ||
    !Number.isSafeInteger(policy.maximumOutputBytes) ||
    policy.maximumOutputBytes < 2 ||
    policy.maximumOutputBytes > 1000000000 ||
    (policy.maximumReadBytes !== undefined &&
      (!Number.isSafeInteger(policy.maximumReadBytes) ||
        policy.maximumReadBytes < 64 ||
        policy.maximumReadBytes > 65536)) ||
    (mode === 'mapped' &&
      !((table === 'provenTxReqs' && field === 'notify') || (table === 'syncStates' && field === 'syncMap'))) ||
    (mode === 'scalar' && !brc38JsonTextField(table, field))
  )
    throw new Error('Browser text staging requires its original private source, current journal and resource admission')
  const retained = working.claim(8192 + 16 * 4096),
    readers = new Set<Brc38PrivateIdbStructuredRead>(),
    projections = new Set<Brc38IdbStructuredHistory>(),
    failures = new Set<Brc38StagingCleanupError>(),
    scalarReaders = new Set<Awaited<ReturnType<Brc38PrivateIdbStage['ownedStreamedRow']>>>()
  const deadline = performance.now() + Math.max(0, policy.expiresAt - Date.now())
  let staged: PackedIdbStagedField | undefined,
    open = true,
    transfer: Brc38WorkingCharge | undefined,
    originalReceipt: Readonly<Brc38ImportJournalReceipt>,
    receiptSha256: string
  const check = (): void => {
    policy.signal?.throwIfAborted()
    if (!open || Date.now() >= policy.expiresAt || performance.now() >= deadline)
      throw new Error('Browser text staging was closed or expired')
  }
  const cleanup = async (): Promise<void> => {
    open = false
    const causes: unknown[] = []
    for (const projection of projections)
      try {
        await projection.close()
        projections.delete(projection)
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
    for (const reader of scalarReaders) {
      reader.close()
      scalarReaders.delete(reader)
    }
    for (const failure of failures)
      try {
        await failure.retryCleanup()
        failures.delete(failure)
      } catch (cause) {
        causes.push(cause)
      }
    if (staged !== undefined)
      try {
        transfer ??= working.claim(8192 + 12 * 65536)
        await staged.close()
      } catch (cause) {
        causes.push(cause)
      }
    if (causes.length !== 0)
      throw new Brc38StagingCleanupError(
        causes,
        'Browser text staging retains actual content/source cleanup and original allocations',
        cleanup
      )
    transfer?.close()
    transfer = undefined
    retained.close()
  }
  const currentReceipt = (): Promise<void> =>
    mapAwaitFromSync(
      () => journal.readMappings(receiptSha256, []),
      read => {
        read.close()
        check()
      }
    )
  const pass = async () => {
    check()
    if (mode === 'scalar') {
      const reader = await source.ownedStreamedRow(table, position, working)
      scalarReaders.add(reader)
      const descriptor = reader.row?.texts?.[field]
      if (
        descriptor === undefined ||
        descriptor.encoding !== 'utf8' ||
        descriptor.field !== field ||
        Object.hasOwn(reader.row!.fields, field)
      )
        throw new Error('Browser scalar TEXT source coordinate differs')
      async function* rawScalar(): AsyncGenerator<Uint8Array> {
        const allowance = working!.claim(8192 + 32 * 16384)
        try {
          for await (const bytes of source.readTextFieldChunks(table, position, descriptor!)) {
            try {
              check()
              yield bytes
            } finally {
              bytes.fill(0)
            }
          }
          check()
        } finally {
          allowance.close()
        }
      }
      return {
        chunks: rawScalar(),
        unmappedIds: 0,
        close: () => {
          return promiseFromSync(() => {
            reader.close()
            scalarReaders.delete(reader)
          })
        }
      }
    }
    if (mode === 'mapped') {
      const projection = await prepareBrc38IdbStructuredHistory(
        source,
        journal,
        originalReceipt,
        table as 'provenTxReqs' | 'syncStates',
        position,
        field as 'notify' | 'syncMap',
        sourcePolicy,
        policy
      )
      projections.add(projection)
      return {
        chunks: projection.chunks(Math.min(65536, policy.maximumReadBytes ?? 65536)),
        unmappedIds: projection.unmappedIds,
        close: () =>
          mapAwaitFromSync(
            () => projection.close(),
            () => {
              projections.delete(projection)
            }
          )
      }
    }
    const reader = await source.openStructuredField(table, position, field, sourcePolicy, working, policy.expiresAt)
    readers.add(reader)
    async function* raw(): AsyncGenerator<Uint8Array> {
      const hash = new SHA256(),
        width = Math.min(65536, policy.maximumReadBytes ?? 65536)
      for (let offset = 0; offset < reader.source.length;) {
        check()
        const bytes = await reader.source.read(offset, Math.min(width, reader.source.length - offset))
        try {
          hash.update(bytes)
          offset += bytes.length
          yield bytes
        } finally {
          bytes.fill(0)
        }
      }
      reader.check()
      check()
      if (hash.digestHex() !== reader.source.sha256) throw new Error('Browser original text source digest differs')
    }
    return {
      chunks:
        mode === 'original'
          ? raw()
          : validatedCanonicalBrc38StructuredWalletField(
              field,
              reader.source,
              {
                maximumInputBytes: sourcePolicy.maximumStructuredBytes,
                maximumOutputBytes: policy.maximumOutputBytes,
                maximumChunkBytes: Math.min(65536, policy.maximumReadBytes ?? 65536),
                maximumAllocationBytes: policy.maximumGrammarAllocationBytes,
                workingAllocation: working,
                signal: policy.signal
              },
              `${table}[${position}].${field}`
            ),
      unmappedIds: 0,
      close: () =>
        mapAwaitFromSync(
          () => reader.close(),
          () => {
            readers.delete(reader)
          }
        )
    }
  }
  try {
    check()
    const capturedReceipt = boundedJson(current)
    receiptSha256 = digest(capturedReceipt)
    originalReceipt = Object.freeze(JSON.parse(capturedReceipt) as Brc38ImportJournalReceipt)
    await currentReceipt()
    const first = await pass(),
      firstHash = new SHA256()
    let bytes = 0
    try {
      for await (const chunk of brc38Utf16Chunks(first.chunks, maximumUtf16Bytes, working, policy.signal)) {
        try {
          check()
          bytes += chunk.length
          firstHash.update(chunk)
        } finally {
          chunk.fill(0)
        }
      }
    } finally {
      await first.close()
    }
    const sha256 = firstHash.digestHex()
    check()
    await currentReceipt()
    transfer = working.claim(8192 + 12 * 65536)
    const owner = getPackedIdbConnection(await storage.verifyDB())
    if (owner === undefined || !/^wallet-toolbox-(main|test)net-restore-v1-[0-9a-f]{32}$/.test(owner.database.name))
      throw new Error('Browser restore text requires its actual isolated packed destination')
    staged = await storage.beginPackedStorageField({
      kind: 'utf16',
      bytes,
      sha256,
      expiresAt: policy.expiresAt,
      lifetimeMs: Math.min(3600000, Math.max(1, policy.expiresAt - Date.now())),
      signal: policy.signal
    })
    const second = await pass(),
      secondHash = new SHA256()
    let written = 0
    try {
      if (second.unmappedIds !== first.unmappedIds)
        throw new Error('Browser text mapping count changed between current source passes')
      for await (const chunk of brc38Utf16Chunks(second.chunks, maximumUtf16Bytes, working, policy.signal)) {
        try {
          check()
          secondHash.update(chunk)
          await staged.append(written, chunk)
          written += chunk.length
          check()
        } finally {
          chunk.fill(0)
        }
      }
    } finally {
      await second.close()
    }
    if (written !== bytes || secondHash.digestHex() !== sha256)
      throw new Error('Browser text staged replay differs from measured content')
    const actual = await staged.finish()
    check()
    if (actual.kind !== 'utf16' || actual.bytes !== bytes || actual.sha256 !== sha256)
      throw new Error('Browser staged text descriptor differs')
    await currentReceipt()
    transfer.close()
    transfer = undefined
    return Object.freeze({ field, mode, bytes, sha256, unmappedIds: first.unmappedIds, staged, close: cleanup })
  } catch (cause) {
    if (cause instanceof Brc38StagingCleanupError) failures.add(cause)
    try {
      await cleanup()
    } catch (error_) {
      throw new Brc38StagingCleanupError(
        [cause, error_],
        'Browser restore text failed with retained actual cleanup',
        cleanup
      )
    }
    throw cause
  }
}
