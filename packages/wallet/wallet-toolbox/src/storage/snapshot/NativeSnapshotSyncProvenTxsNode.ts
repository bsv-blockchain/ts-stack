import type { StorageKnex } from '../StorageKnex'
import { ownedNativeRootIdentity } from '../schema/ownedNativeSqliteConnectionsNode'
import { Brc38WorkingAllocation, type Brc38WorkingCharge } from '../portable/Brc38WorkingAllocation'
import { Brc38StagingCleanupError } from '../portable/Brc38StagingCleanupError'
import { inspectBrc38StreamedProofReader } from '../portable/Brc38StreamedProof'
import { invalidatePreparedSyncProofs } from '../schema/entities/EntityProvenTx'
import type { KnexSnapshotSyncDestination } from './KnexSnapshotSyncDestination'
import { copySnapshotCursor } from './SnapshotCursor'
import {
  snapshotSyncTables,
  type SnapshotSyncCheckpoint,
  type SnapshotSyncFieldPreparation,
  type SnapshotSyncCommit
} from './SnapshotSync'
import type {
  WalletReadSnapshot,
  WalletSnapshotFieldDescriptor,
  WalletSnapshotFieldMetadataPage
} from './WalletReadSnapshot'
import { detachSnapshotSyncFieldPage, type DetachedSnapshotSyncFieldRow } from './SnapshotSyncFieldRows'
import {
  preparePackedNativeSnapshotField,
  type PreparedPackedNativeSnapshotField
} from './preparePackedNativeSnapshotFieldNode'
import {
  nativeSnapshotSyncProofRow,
  readNativeSnapshotSyncProofCurrent,
  requireSameNativeSnapshotSyncProofCurrent,
  readNativeSnapshotSyncProofCurrentExtent,
  type NativeSnapshotSyncProofRow,
  type NativeSnapshotSyncProofCurrent
} from './NativeSnapshotSyncProofCurrentNode'
import { nativeSnapshotSyncProofReader } from './NativeSnapshotSyncProofReaderNode'
import { snapshotSyncSmallText } from './SnapshotSyncSmallText'
import { writeNativeSnapshotSyncRow } from './writeNativeSnapshotSyncRowNode'
import { SnapshotResourceLimitError } from './SnapshotResourceLimitError'

interface PreparedRow {
  readonly metadata: Readonly<DetachedSnapshotSyncFieldRow>
  readonly proof: Readonly<NativeSnapshotSyncProofRow>
  readonly extents: Readonly<Record<string, Readonly<WalletSnapshotFieldDescriptor>>>
  readonly current: NativeSnapshotSyncProofCurrent
  readonly rawTx: PreparedPackedNativeSnapshotField
  readonly merklePath: PreparedPackedNativeSnapshotField
  readonly currentBytesEqual: boolean
}
function invalid(): never {
  throw new Error('Native proof preparation differs from its actual source, current row or checkpoint')
}
/** Native operational local-backup proof component. Fresh actual byte equality
 * preserves an identical current row. A different existing proof goes through
 * the original complete streamed raw/Merkle/current-header oracle OUTSIDE the
 * writer. New rows preserve the established local-sync trust contract. Source,
 * issued stages and original current revision/content remain owned through the
 * one final atomic row/map/ACK effect; no reusable proof verdict is retained. */
export async function prepareNativeSnapshotSyncProvenTxs(
  storage: StorageKnex,
  destination: KnexSnapshotSyncDestination,
  input: SnapshotSyncCheckpoint,
  selectedPage: WalletSnapshotFieldMetadataPage<'provenTxs'>,
  source: WalletReadSnapshot,
  signal?: AbortSignal
): Promise<SnapshotSyncFieldPreparation> {
  const expected = { ...input, cursor: copySnapshotCursor(input.cursor) },
    selectedRows = Object.getOwnPropertyDescriptor(selectedPage, 'rows')
  if (
    snapshotSyncTables[expected.tableIndex] !== 'provenTxs' ||
    selectedRows === undefined ||
    !Object.hasOwn(selectedRows, 'value') ||
    !Array.isArray(selectedRows.value) ||
    selectedRows.value.length > 128
  )
    invalid()
  const detached = detachSnapshotSyncFieldPage(expected, selectedPage),
    root = storage.knex,
    origin = ownedNativeRootIdentity(root),
    binding = Object.freeze({
      snapshotId: source.snapshotId,
      userId: source.user.userId,
      identityKey: source.user.identityKey,
      sourceStorageIdentityKey: source.sourceStorage.storageIdentityKey,
      chain: source.sourceStorage.chain,
      expiresAt: source.expiresAt
    }),
    working = new Brc38WorkingAllocation(16777216),
    retained = working.claim(16384 + 16 * detached.allocationBytes),
    allocations: Brc38WorkingCharge[] = [],
    stages: PreparedPackedNativeSnapshotField[] = [],
    rows: PreparedRow[] = [],
    failures = new Set<Brc38StagingCleanupError>(),
    txids = new Set<string>()
  let expiresAt = binding.expiresAt,
    deadline = performance.now() + expiresAt - Date.now(),
    journalEpoch: string | undefined,
    closed = false,
    consumed = false,
    closing: Promise<void> | undefined,
    applying: Promise<SnapshotSyncCommit> | undefined
  const check = (): void => {
      signal?.throwIfAborted()
      if (
        closed ||
        origin?.slot !== 0 ||
        storage.knex !== root ||
        ownedNativeRootIdentity(root)?.token !== origin.token ||
        !source.isOpen ||
        source.fieldReader === undefined ||
        source.snapshotId !== binding.snapshotId ||
        source.user.userId !== binding.userId ||
        source.user.identityKey !== binding.identityKey ||
        source.sourceStorage.storageIdentityKey !== binding.sourceStorageIdentityKey ||
        source.sourceStorage.chain !== binding.chain ||
        source.expiresAt !== binding.expiresAt ||
        binding.snapshotId !== expected.snapshotId ||
        binding.identityKey !== expected.identityKey ||
        binding.sourceStorageIdentityKey !== expected.sourceStorageIdentityKey ||
        binding.chain !== storage.chain ||
        !Number.isSafeInteger(binding.expiresAt) ||
        binding.expiresAt > Date.now() + 3600000
      )
        invalid()
      if (Date.now() >= expiresAt || performance.now() >= deadline)
        throw new SnapshotResourceLimitError('Native proof preparation reached its original source/session deadline')
    },
    inspectCurrent = async (txid: string): Promise<NativeSnapshotSyncProofCurrent> =>
      await destination.inspectNativeFieldSession(expected, signal, async read => {
        check()
        if (read.sourceUserId !== binding.userId || (journalEpoch !== undefined && journalEpoch !== read.journalEpoch))
          invalid()
        journalEpoch ??= read.journalEpoch
        expiresAt = Math.min(expiresAt, read.expiresAt)
        deadline = Math.min(deadline, performance.now() + expiresAt - Date.now())
        const current = await readNativeSnapshotSyncProofCurrent(
          storage,
          read.transaction,
          read.user.userId,
          txid,
          signal
        )
        check()
        return current
      }),
    cleanup = async (): Promise<void> => {
      closed = true
      if (applying !== undefined) await applying.catch(() => undefined)
      const causes: unknown[] = []
      for (const stage of stages)
        try {
          await stage.close()
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
          'Native proof preparation retains actual stages and allocations until drained',
          cleanup
        )
      for (const allocation of allocations) allocation.close()
      allocations.length = 0
      stages.length = 0
      rows.length = 0
      txids.clear()
      retained.close()
    }
  try {
    check()
    // Even an empty final page freshly admits the complete destination journal.
    await destination.inspectNativeFieldSession(expected, signal, async read => {
      check()
      if (read.sourceUserId !== binding.userId) invalid()
      journalEpoch = read.journalEpoch
      expiresAt = Math.min(expiresAt, read.expiresAt)
      deadline = Math.min(deadline, performance.now() + expiresAt - Date.now())
    })
    for (const metadata of detached.rows) {
      check()
      const fields = { ...metadata.fields },
        extents = { ...metadata.extents }
      for (const name of ['txid', 'blockHash', 'merkleRoot'] as const)
        if (extents[name] !== undefined) {
          const allocation = working.claim(8192 + 16 * extents[name].bytes)
          try {
            fields[name] = await snapshotSyncSmallText(
              source,
              'provenTxs',
              metadata.cursor,
              name,
              extents[name],
              working,
              check
            )
            allocations.push(allocation)
          } catch (cause) {
            allocation.close()
            throw cause
          }
          delete extents[name]
        }
      if (
        Object.keys(extents).some(name => !['rawTx', 'merklePath'].includes(name)) ||
        extents.rawTx?.kind !== 'binary' ||
        extents.merklePath?.kind !== 'binary'
      )
        invalid()
      const proof = nativeSnapshotSyncProofRow(fields)
      if (txids.has(proof.txid.toLowerCase())) invalid()
      txids.add(proof.txid.toLowerCase())
      const allocation = working.claim(8192 + 16 * 65536)
      let current: NativeSnapshotSyncProofCurrent
      try {
        current = await inspectCurrent(proof.txid)
        allocation.resize(8192 + 16 * current.field.allocationBytes)
        allocations.push(allocation)
      } catch (cause) {
        allocation.close()
        throw cause
      }
      const prepare = async (name: 'rawTx' | 'merklePath'): Promise<PreparedPackedNativeSnapshotField> => {
          check()
          const stage = await preparePackedNativeSnapshotField(
            storage,
            source,
            'provenTxs',
            metadata.cursor,
            name,
            extents[name],
            { workingAllocation: working, maximumFieldBytes: 1000000000, maximumReadBytes: 16384, expiresAt, signal }
          )
          stages.push(stage)
          check()
          return stage
        },
        rawTx = await prepare('rawTx'),
        merklePath = await prepare('merklePath')
      let currentBytesEqual = false
      if (current.row !== undefined) {
        const prior = current.row
        let equal =
          prior.txid === proof.txid &&
          prior.height === proof.height &&
          prior.index === proof.index &&
          prior.blockHash === proof.blockHash &&
          prior.merkleRoot === proof.merkleRoot
        for (const name of ['rawTx', 'merklePath'] as const) {
          const descriptor = current.field.binaries[name],
            incoming = extents[name],
            prepared = name === 'rawTx' ? rawTx.descriptor : merklePath.descriptor
          if (descriptor === undefined) invalid()
          if (!equal || descriptor.bytes !== prepared.bytes || descriptor.sha256 !== prepared.sha256) {
            equal = false
            continue
          }
          const allowance = working.claim(8192 + 16 * 65536)
          try {
            for (let offset = 0; offset < descriptor.bytes;) {
              check()
              const length = Math.min(16384, descriptor.bytes - offset),
                sourceBytes = await source.fieldReader!.readFieldExtent(
                  'provenTxs',
                  metadata.cursor,
                  name,
                  offset,
                  length,
                  incoming
                )
              try {
                check()
                if (!(sourceBytes instanceof Uint8Array) || sourceBytes.length !== length) invalid()
                const currentBytes = await destination.inspectNativeFieldSession(expected, signal, async read => {
                  check()
                  if (read.sourceUserId !== binding.userId || read.journalEpoch !== journalEpoch) invalid()
                  return await readNativeSnapshotSyncProofCurrentExtent(
                    storage,
                    read.transaction,
                    read.user.userId,
                    current,
                    name,
                    offset,
                    length,
                    signal
                  )
                })
                try {
                  check()
                  for (let index = 0; index < length; index++)
                    if (sourceBytes[index] !== currentBytes[index]) equal = false
                } finally {
                  currentBytes.fill(0)
                }
                offset += length
                if (!equal) break
              } finally {
                if (sourceBytes instanceof Uint8Array) sourceBytes.fill(0)
              }
            }
          } finally {
            allowance.close()
          }
        }
        requireSameNativeSnapshotSyncProofCurrent(current, await inspectCurrent(proof.txid))
        if (equal) currentBytesEqual = true
        else {
          await inspectBrc38StreamedProofReader(
            nativeSnapshotSyncProofReader(
              source,
              metadata,
              proof,
              extents,
              { rawTx: rawTx.descriptor, merklePath: merklePath.descriptor },
              working,
              check
            ),
            storage,
            0,
            {
              maximumRawBytes: 1000000000,
              maximumChunks: 100000,
              maximumMerkleBytes: 1048576,
              maximumDecodedMerkleBytes: 4194304,
              maximumChunkBytes: 16384,
              workingAllocation: working,
              maximumNetworkMilliseconds: 30000,
              cleanupMilliseconds: 30000,
              signal
            },
            expiresAt,
            deadline
          )
          check()
          requireSameNativeSnapshotSyncProofCurrent(current, await inspectCurrent(proof.txid))
        }
      }
      rows.push(
        Object.freeze({
          metadata,
          proof,
          extents: Object.freeze(extents),
          current,
          rawTx,
          merklePath,
          currentBytesEqual
        })
      )
    }
    check()
    return Object.freeze({
      apply: async () => {
        check()
        if (consumed) invalid()
        consumed = true
        const allowance = working.claim(16384 + 16 * 65536),
          page: WalletSnapshotFieldMetadataPage<'provenTxs'> = {
            rows: detached.rows.map(row => ({ fields: row.fields, extents: row.extents, cursor: row.cursor })),
            payloadBytes: detached.allocationBytes,
            done: detached.nextTable !== expected.tableIndex,
            cursor: detached.rows.length === 0 ? expected.cursor : detached.rows[detached.rows.length - 1].cursor
          }
        applying = destination.commitNativeFieldPage(expected, page, signal, async writer => {
          check()
          if (writer.sourceUserId !== binding.userId || writer.journalEpoch !== journalEpoch) invalid()
          const loaded = await writer.loadFieldMappings(
            'provenTxs',
            rows.map(row => row.metadata.fields)
          )
          for (const row of rows)
            requireSameNativeSnapshotSyncProofCurrent(
              row.current,
              await readNativeSnapshotSyncProofCurrent(
                storage,
                writer.transaction,
                writer.user.userId,
                row.proof.txid,
                signal
              )
            )
          let inserts = 0,
            updates = 0
          for (const row of rows) {
            check()
            const actual = await readNativeSnapshotSyncProofCurrent(
              storage,
              writer.transaction,
              writer.user.userId,
              row.proof.txid,
              signal
            )
            requireSameNativeSnapshotSyncProofCurrent(row.current, actual)
            if (row.currentBytesEqual) {
              if (actual.row === undefined) invalid()
              loaded.map.provenTx.idMap[row.proof.provenTxId] = actual.row.provenTxId
              continue
            }
            const fields = { ...row.proof }
            if (actual.row !== undefined) {
              fields.provenTxId = actual.row.provenTxId
              fields.created_at = new Date(actual.row.created_at.getTime())
              fields.updated_at = new Date(
                Math.max(Date.now(), row.proof.updated_at.getTime(), actual.row.updated_at.getTime() + 1)
              )
            }
            const id = await writeNativeSnapshotSyncRow(
              storage,
              writer.transaction,
              'provenTxs',
              fields,
              { row: {}, fields: [] },
              { rawTx: row.rawTx, merklePath: row.merklePath },
              actual.row?.provenTxId
            )
            if (actual.row !== undefined && id !== actual.row.provenTxId) invalid()
            loaded.map.provenTx.idMap[row.proof.provenTxId] = id
            await invalidatePreparedSyncProofs(storage, writer.transaction)
            check()
            if (actual.row === undefined) inserts++
            else updates++
          }
          await loaded.persist()
          check()
          return { inserts, updates }
        })
        try {
          const result = await applying
          check()
          return result
        } finally {
          applying = undefined
          allowance.close()
        }
      },
      close: async () => {
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
        'Native proof preparation failed with concrete retained cleanup',
        cleanup
      )
    }
    throw cause
  }
}
