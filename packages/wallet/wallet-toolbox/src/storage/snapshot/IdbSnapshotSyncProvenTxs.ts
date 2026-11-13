import { SHA256 } from '@bsv/sdk/primitives/Hash'
import type { StorageIdb } from '../StorageIdb'
import { packedIdbCurrentMetadataEqual, type PackedIdbCurrentMetadata } from '../idbPackedCurrentMetadata'
import { packedIdbPositive } from '../idbPackedFields'
import { Brc38WorkingAllocation, type Brc38WorkingCharge } from '../portable/Brc38WorkingAllocation'
import { Brc38StagingCleanupError } from '../portable/Brc38StagingCleanupError'
import { inspectBrc38StreamedProofReader, type Brc38StreamedProofReader } from '../portable/Brc38StreamedProof'
import type { Brc38JsonStreamedRow, Brc38JsonStreamedField } from '../portable/Brc38JsonBinaryFields'
import { invalidatePreparedSyncProofs } from '../schema/entities/EntityProvenTx'
import { snapshotSyncTables, type SnapshotSyncCheckpoint, type SnapshotSyncFieldPreparation } from './SnapshotSync'
import { IdbSnapshotSyncJournal, captureIdbSnapshotSyncCheckpoint } from './IdbSnapshotSyncJournal'
import { detachSnapshotSyncFieldPage, type DetachedSnapshotSyncFieldRow } from './SnapshotSyncFieldRows'
import { preparePackedIdbSnapshotField, type PreparedPackedIdbSnapshotField } from './preparePackedIdbSnapshotField'
import { snapshotSyncSmallText } from './SnapshotSyncSmallText'
import type {
  WalletReadSnapshot,
  WalletSnapshotFieldDescriptor,
  WalletSnapshotFieldMetadataPage
} from './WalletReadSnapshot'
import { SnapshotResourceLimitError } from './SnapshotResourceLimitError'

interface Proof {
  readonly provenTxId: number
  readonly created_at: Date
  readonly updated_at: Date
  readonly txid: string
  readonly blockHash: string
  readonly merkleRoot: string
  readonly height: number
  readonly index: number
}
interface Row {
  readonly metadata: Readonly<DetachedSnapshotSyncFieldRow>
  readonly proof: Readonly<Proof>
  readonly current?: Readonly<PackedIdbCurrentMetadata>
  readonly rawTx: PreparedPackedIdbSnapshotField
  readonly merklePath: PreparedPackedIdbSnapshotField
  /** Original byte comparison DATA, meaningful only with the exact current
   * revision/content fences and actual one-use source/stage owners below. */
  readonly comparedCurrent?: Readonly<{ rawContent: string; merkleContent: string }>
}
function invalid(): never {
  throw new Error('Prepared proof differs from current source, destination proof or checkpoint')
}
function hex(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/i.test(value)) invalid()
  return value.toLowerCase()
}
function date(value: unknown): Date {
  if (!(value instanceof Date) || !Number.isFinite(Date.prototype.getTime.call(value))) invalid()
  return new Date(Date.prototype.getTime.call(value))
}
function position(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) invalid()
  return value
}
function proof(fields: Readonly<Record<string, unknown>>): Readonly<Proof> {
  if (
    Object.keys(fields).some(
      name =>
        !['created_at', 'updated_at', 'provenTxId', 'txid', 'blockHash', 'merkleRoot', 'height', 'index'].includes(name)
    )
  )
    invalid()
  return Object.freeze({
    provenTxId: packedIdbPositive(fields.provenTxId),
    created_at: date(fields.created_at),
    updated_at: date(fields.updated_at),
    txid: hex(fields.txid),
    blockHash: hex(fields.blockHash),
    merkleRoot: hex(fields.merkleRoot),
    height: position(fields.height),
    index: position(fields.index)
  })
}
function unchanged(
  previous: Readonly<PackedIdbCurrentMetadata> | undefined,
  actual: Readonly<PackedIdbCurrentMetadata> | undefined
): void {
  if (!packedIdbCurrentMetadataEqual(previous, actual)) invalid()
}

/** Ordinary local backup proof policy with bounded fields. New rows retain
 * the established local-sync trust contract. Existing replacements require
 * fresh complete raw/Merkle/current-active-header inspection, outside a wallet
 * writer. No TableProvenTx with omitted/fabricated payload is constructed and
 * no reusable proof/chain verdict is stored. This is a one-use effect owner. */
export async function prepareIdbSnapshotSyncProvenTxs(
  storage: StorageIdb,
  input: SnapshotSyncCheckpoint,
  selectedPage: WalletSnapshotFieldMetadataPage<'provenTxs'>,
  source: WalletReadSnapshot,
  signal?: AbortSignal
): Promise<SnapshotSyncFieldPreparation> {
  const expected = captureIdbSnapshotSyncCheckpoint(input),
    detached = detachSnapshotSyncFieldPage(expected, selectedPage),
    binding = Object.freeze({
      snapshotId: source.snapshotId,
      identityKey: source.user.identityKey,
      userId: source.user.userId,
      storageIdentityKey: source.sourceStorage.storageIdentityKey,
      chain: source.sourceStorage.chain,
      expiresAt: source.expiresAt
    }),
    working = new Brc38WorkingAllocation(16777216),
    retained = working.claim(16384 + 8 * detached.allocationBytes)
  if (
    snapshotSyncTables[expected.tableIndex] !== 'provenTxs' ||
    source.fieldReader === undefined ||
    binding.snapshotId !== expected.snapshotId ||
    binding.identityKey !== expected.identityKey ||
    binding.storageIdentityKey !== expected.sourceStorageIdentityKey ||
    binding.chain !== storage.chain ||
    !Number.isSafeInteger(binding.expiresAt)
  ) {
    retained.close()
    invalid()
  }
  const stages: PreparedPackedIdbSnapshotField[] = [],
    allocations: Brc38WorkingCharge[] = [],
    rows: Row[] = [],
    failures = new Set<Brc38StagingCleanupError>(),
    txids = new Set<string>()
  let journal: IdbSnapshotSyncJournal | undefined,
    expiresAt = binding.expiresAt,
    deadline = performance.now() + expiresAt - Date.now(),
    closed = false,
    consumed = false,
    closing: Promise<void> | undefined,
    applying: Promise<unknown> | undefined
  const check = (): void => {
      signal?.throwIfAborted()
      journal?.requireStorage(storage)
      if (
        closed ||
        !source.isOpen ||
        source.snapshotId !== binding.snapshotId ||
        source.expiresAt !== binding.expiresAt ||
        source.user.identityKey !== binding.identityKey ||
        source.user.userId !== binding.userId ||
        source.sourceStorage.storageIdentityKey !== binding.storageIdentityKey ||
        source.sourceStorage.chain !== binding.chain
      )
        invalid()
      if (Date.now() >= expiresAt || performance.now() >= deadline)
        throw new SnapshotResourceLimitError('Proof preparation reached its original source/session deadline')
    },
    cleanup = async (): Promise<void> => {
      closed = true
      if (applying !== undefined)
        try {
          await applying
        } catch {
          /* Apply caller owns its original outcome. */
        }
      const causes: unknown[] = []
      for (const stage of stages)
        try {
          journal?.requireStorage(storage)
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
          'Proof preparation retains source/stage allocations through actual drainage',
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
    journal = await IdbSnapshotSyncJournal.open(storage)
    check()
    for (const metadata of detached.rows) {
      const fields = { ...metadata.fields },
        extents = { ...metadata.extents }
      for (const name of ['txid', 'blockHash', 'merkleRoot'] as const)
        if (extents[name] !== undefined) {
          const allocation = working.claim(8192 + 8 * extents[name].bytes)
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
      const incoming = proof(fields)
      if (txids.has(incoming.txid)) invalid()
      txids.add(incoming.txid)
      const allocation = working.claim(8192 + 8 * 65536)
      let current: Readonly<PackedIdbCurrentMetadata> | undefined
      try {
        current = await journal.inspect(expected, async read => {
          check()
          if (read.sourceUserId !== binding.userId) invalid()
          const map = await read.loadFieldMappings('provenTxs', [metadata.fields]),
            actual = await read.findCurrentRow({ table: 'provenTxs', txid: incoming.txid }, map, 65536, signal)
          expiresAt = Math.min(expiresAt, read.expiresAt)
          deadline = Math.min(deadline, performance.now() + expiresAt - Date.now())
          return actual
        })
        allocation.resize(8192 + 8 * (current?.allocationBytes ?? 0))
        allocations.push(allocation)
      } catch (cause) {
        allocation.close()
        throw cause
      }
      const prepare = async (
          name: 'rawTx' | 'merklePath',
          descriptor: Readonly<WalletSnapshotFieldDescriptor>
        ): Promise<PreparedPackedIdbSnapshotField> => {
          check()
          const stage = await preparePackedIdbSnapshotField(
            storage,
            source,
            'provenTxs',
            metadata.cursor,
            name,
            descriptor,
            { workingAllocation: working, maximumFieldBytes: 1000000000, maximumReadBytes: 16384, expiresAt, signal }
          )
          stages.push(stage)
          check()
          return stage
        },
        rawTx = await prepare('rawTx', extents.rawTx),
        merklePath = await prepare('merklePath', extents.merklePath)
      let comparedCurrent: Row['comparedCurrent']
      if (current !== undefined) {
        const currentFields: Record<string, unknown> = { ...current.fields }
        for (const name of ['txid', 'blockHash', 'merkleRoot'] as const)
          if (current.extents[name] !== undefined) {
            const extent = current.extents[name]
            if (extent.kind !== 'utf16' || extent.bytes > 8192 || extent.bytes % 2 !== 0) invalid()
            const loan = await journal.inspect(expected, async read => {
              const map = await read.loadFieldMappings('provenTxs', [metadata.fields])
              return await read.readCurrentExtent(
                { table: 'provenTxs', txid: incoming.txid },
                map,
                current!,
                name,
                0,
                extent.bytes,
                working,
                signal
              )
            })
            try {
              check()
              if (new SHA256().update(loan.bytes).digestHex() !== extent.sha256) invalid()
              let value = ''
              for (let offset = 0; offset < loan.bytes.length; offset += 2)
                value += String.fromCodePoint(loan.bytes[offset] | (loan.bytes[offset + 1] << 8))
              currentFields[name] = value
            } finally {
              loan.close()
            }
          }
        const prior = proof(currentFields)
        let equal =
          prior.txid === incoming.txid &&
          prior.height === incoming.height &&
          prior.index === incoming.index &&
          prior.blockHash === incoming.blockHash &&
          prior.merkleRoot === incoming.merkleRoot
        for (const name of ['rawTx', 'merklePath'] as const) {
          const extent = current.extents[name],
            staged = name === 'rawTx' ? rawTx.staged.descriptor : merklePath.staged.descriptor
          if (extent === undefined || extent.kind === 'utf16') invalid()
          if (!equal || extent.bytes !== staged.bytes || extent.sha256 !== staged.sha256) {
            equal = false
            continue
          }
          const allowance = working.claim(4096 + 8 * 16384)
          try {
            for (let offset = 0; offset < extent.bytes;) {
              check()
              const length = Math.min(16384, extent.bytes - offset),
                bytes = await source.fieldReader!.readFieldExtent(
                  'provenTxs',
                  metadata.cursor,
                  name,
                  offset,
                  length,
                  extents[name]
                )
              try {
                check()
                if (!(bytes instanceof Uint8Array) || bytes.length !== length) invalid()
                const loan = await journal.inspect(expected, async read => {
                  const map = await read.loadFieldMappings('provenTxs', [metadata.fields])
                  return await read.readCurrentExtent(
                    { table: 'provenTxs', txid: incoming.txid },
                    map,
                    current!,
                    name,
                    offset,
                    length,
                    working,
                    signal
                  )
                })
                try {
                  for (let index = 0; index < length; index++) if (bytes[index] !== loan.bytes[index]) equal = false
                } finally {
                  loan.close()
                }
                offset += length
                if (!equal) break
              } finally {
                if (bytes instanceof Uint8Array) bytes.fill(0)
              }
            }
          } finally {
            allowance.close()
          }
        }
        if (equal)
          comparedCurrent = Object.freeze({
            rawContent: current.extents.rawTx.content,
            merkleContent: current.extents.merklePath.content
          })
        else {
          const portable: Brc38JsonStreamedRow = Object.freeze({
              fields: Object.freeze({
                txid: incoming.txid,
                blockHash: incoming.blockHash,
                merkleRoot: incoming.merkleRoot,
                height: incoming.height,
                index: incoming.index
              }),
              binaries: Object.freeze({
                rawTx: Object.freeze({
                  field: 'rawTx',
                  encoding: 'base64' as const,
                  bytes: rawTx.staged.descriptor.bytes,
                  sha256: rawTx.staged.descriptor.sha256
                }),
                merklePath: Object.freeze({
                  field: 'merklePath',
                  encoding: 'base64' as const,
                  bytes: merklePath.staged.descriptor.bytes,
                  sha256: merklePath.staged.descriptor.sha256
                })
              })
            }),
            reader: Brc38StreamedProofReader = Object.freeze({
              row: async (selectedTable: 'provenTxs', selectedIndex: number) => {
                check()
                if (selectedTable !== 'provenTxs' || selectedIndex !== 0) invalid()
                // Re-enter actual retained native source admission after each
                // network phase, rather than returning copied metadata alone.
                const allowance = working.claim(4096 + 8 * 16384)
                try {
                  for (const name of ['rawTx', 'merklePath'] as const) {
                    const bytes = await source.fieldReader!.readFieldExtent(
                      'provenTxs',
                      metadata.cursor,
                      name,
                      0,
                      0,
                      extents[name]
                    )
                    try {
                      check()
                      if (!(bytes instanceof Uint8Array) || bytes.length !== 0) invalid()
                    } finally {
                      if (bytes instanceof Uint8Array) bytes.fill(0)
                    }
                  }
                  return portable
                } finally {
                  allowance.close()
                }
              },
              chunks: async function* (
                selectedTable: 'provenTxs',
                selectedIndex: number,
                field: Readonly<Brc38JsonStreamedField>
              ) {
                if (
                  selectedTable !== 'provenTxs' ||
                  selectedIndex !== 0 ||
                  (field.field !== 'rawTx' && field.field !== 'merklePath')
                )
                  invalid()
                const original = portable.binaries[field.field]
                if (
                  field.encoding !== original.encoding ||
                  field.bytes !== original.bytes ||
                  field.sha256 !== original.sha256
                )
                  invalid()
                const allowance = working.claim(4096 + 8 * 16384)
                try {
                  for (let offset = 0; offset < field.bytes;) {
                    check()
                    const length = Math.min(16384, field.bytes - offset),
                      bytes = await source.fieldReader!.readFieldExtent(
                        'provenTxs',
                        metadata.cursor,
                        field.field,
                        offset,
                        length,
                        extents[field.field]
                      )
                    try {
                      check()
                      if (!(bytes instanceof Uint8Array) || bytes.length !== length) invalid()
                      yield bytes
                      check()
                      offset += length
                    } finally {
                      if (bytes instanceof Uint8Array) bytes.fill(0)
                    }
                  }
                } finally {
                  allowance.close()
                }
              }
            })
          // The inspection's returned DATA is deliberately not an admission
          // token. Actual source, issued stages and exact current proof remain
          // owned until this preparation's single currently fenced effect.
          await inspectBrc38StreamedProofReader(
            reader,
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
        }
      }
      rows.push(Object.freeze({ metadata, proof: incoming, current, rawTx, merklePath, comparedCurrent }))
    }
    check()
    return Object.freeze({
      apply: async () => {
        check()
        if (consumed) throw new Error('Proof preparation already consumed; read its durable checkpoint')
        consumed = true
        if (journal === undefined) invalid()
        const allowance = working.claim(16384 + 8 * 65536),
          effect = journal.commit(expected, detached.nextTable, detached.nextCursor, async writer => {
            check()
            if (writer.sourceUserId !== binding.userId) invalid()
            const loaded = await writer.loadFieldMappings(
              'provenTxs',
              rows.map(row => row.metadata.fields)
            )
            for (const row of rows) {
              check()
              unchanged(
                row.current,
                await writer.findCurrentRow({ table: 'provenTxs', txid: row.proof.txid }, loaded.map, 65536, signal)
              )
            }
            let inserts = 0,
              updates = 0
            for (const row of rows) {
              check()
              const actual = await writer.findCurrentRow(
                { table: 'provenTxs', txid: row.proof.txid },
                loaded.map,
                65536,
                signal
              )
              unchanged(row.current, actual)
              const raw = row.rawTx.staged.descriptor,
                merkle = row.merklePath.staged.descriptor
              if (actual !== undefined && row.comparedCurrent !== undefined) {
                if (
                  actual.extents.rawTx?.content !== row.comparedCurrent.rawContent ||
                  actual.extents.merklePath?.content !== row.comparedCurrent.merkleContent ||
                  actual.extents.rawTx.bytes !== raw.bytes ||
                  actual.extents.rawTx.sha256 !== raw.sha256 ||
                  actual.extents.merklePath.bytes !== merkle.bytes ||
                  actual.extents.merklePath.sha256 !== merkle.sha256
                )
                  invalid()
                loaded.map.provenTx.idMap[row.proof.provenTxId] = packedIdbPositive(actual.fields.provenTxId)
                continue
              }
              const fields: Record<string, unknown> = { ...row.proof }
              if (actual === undefined) delete fields.provenTxId
              else {
                fields.provenTxId = packedIdbPositive(actual.fields.provenTxId)
                fields.created_at = date(actual.fields.created_at)
                fields.updated_at = new Date(
                  Math.max(Date.now(), row.proof.updated_at.getTime(), date(actual.fields.updated_at).getTime() + 1)
                )
              }
              const key = await storage.writeStagedStorageRow(
                  'proven_txs',
                  fields,
                  { rawTx: row.rawTx.staged, merklePath: row.merklePath.staged },
                  actual === undefined ? 'add' : 'put',
                  writer.transaction
                ),
                localId = packedIdbPositive(key)
              if (actual !== undefined && localId !== actual.fields.provenTxId) invalid()
              loaded.map.provenTx.idMap[row.proof.provenTxId] = localId
              await invalidatePreparedSyncProofs(storage, writer.transaction)
              check()
              if (actual === undefined) inserts++
              else updates++
            }
            await loaded.persist()
            check()
            return { inserts, updates }
          })
        applying = effect
        try {
          return await effect
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
      throw new Brc38StagingCleanupError([cause, error_], 'Proof preparation failed with retained cleanup', cleanup)
    }
    throw cause
  }
}
