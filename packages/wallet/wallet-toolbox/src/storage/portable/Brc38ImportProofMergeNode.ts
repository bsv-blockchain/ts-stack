import { createHash } from 'node:crypto'
import type { Knex } from 'knex'
import type { StorageKnex } from '../StorageKnex'
import type { SyncMap } from '../schema/entities/EntityBase'
import type { PortableRow } from './Brc38PortableRows'
import type { Brc38AuthenticatedImportReader, Brc38AuthenticatedStreamedImportReader } from './KnexBrc38StagingStore'
import { isBrc38OwnedPrivateNativeWriter } from './KnexBrc38StagingStore'
import { privateNativeDatabaseIdentity, privateNativeTransactionIdentity } from './Brc38PrivateNativeOwnershipNode'
import { verifyBrc38AuthenticatedSourceSeal } from './Brc38AuthenticatedSourceSealNode'
import { requireBrc38ImportSqliteTransaction } from './Brc38ImportJournalSchema'
import type { Brc38ImportJournalAdmission } from './Brc38ImportJournal'
import type { Brc38PreparedStreamedPage } from './Brc38ImportPage'
import { loadBrc38ImportIdMap } from './Brc38ImportIdMap'
import { prepareBrc38ImportEntityTargets, type Brc38ImportEntityTarget } from './Brc38ImportEntityTargets'
import {
  prepareBrc38ImportExistingFieldTargets,
  assertBrc38ImportExistingFieldTargets,
  type Brc38ImportExistingFieldRow
} from './Brc38ImportExistingRows'
import {
  prepareBrc38ImportOriginalFieldPolicy,
  prepareBrc38ImportCurrentFieldPolicy,
  type Brc38ImportFieldPolicyRow
} from './Brc38ImportFieldPolicyRowsNode'
import { prepareBrc38ImportStructuredOriginals } from './Brc38ImportStructuredProvenanceNode'
import {
  Brc38ImportAliasPageError,
  prepareBrc38ImportCacheFence,
  applyBrc38ImportCacheFence,
  type Brc38ImportCacheFence
} from './Brc38ImportEntityMergeNode'
import { chargeBrc38ImportDecodedBudget, copyBrc38ImportDecodedValue } from './Brc38ImportDecodedBudget'
import { prepareBrc38PrivatePageIds, type Brc38PrivatePageIds } from './Brc38PrivatePageIdsNode'
import { insertBrc38PackedPlannedMetadata, updateBrc38PackedPrivateMetadata } from './Brc38PackedRestoreMetadataNode'
import { readBrc38NativePackedExtent } from './Brc38NativePackedFieldsNode'
import {
  assertBrc38NativeStreamedSourceRow,
  assertBrc38NativeStreamedReadSourceRow
} from './Brc38NativeBinaryFieldNode'
import { inspectBrc38AuthenticatedStreamedProofReader } from './Brc38AuthenticatedStreamedProofNode'
import type { Brc38PrivatePreparedFieldInstaller } from './Brc38NativePackedFieldPreparationNode'
import { Brc38WorkingAllocation } from './Brc38WorkingAllocation'

type Proof = Extract<Brc38ImportFieldPolicyRow, { table: 'provenTxs' }>['value']
interface Row {
  readonly incoming: Proof
  readonly current?: Proof
  readonly target: Brc38ImportEntityTarget
  readonly existing: Brc38ImportExistingFieldRow
  readonly identical: boolean
  readonly localId: number
}
const issuer = Object.freeze({})
function invalid(): never {
  throw new Error('Private proof merge differs from its actual source, current proof, maps or native owner')
}
function positive(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) invalid()
  return value
}
function proof(row: Brc38ImportFieldPolicyRow): Proof {
  if (row.table !== 'provenTxs') invalid()
  const value = row.value
  for (const name of ['txid', 'blockHash', 'merkleRoot'] as const) if (!/^[0-9a-f]{64}$/i.test(value[name])) invalid()
  if (!Number.isSafeInteger(value.height) || value.height < 0 || !Number.isSafeInteger(value.index) || value.index < 0)
    invalid()
  return value
}
function sameMetadata(left: Proof, right: Proof): boolean {
  return (
    left.txid.toLowerCase() === right.txid.toLowerCase() &&
    left.height === right.height &&
    left.index === right.index &&
    left.blockHash.toLowerCase() === right.blockHash.toLowerCase() &&
    left.merkleRoot.toLowerCase() === right.merkleRoot.toLowerCase()
  )
}

/** One use inside the isolated candidate's journal transaction. Proof inspection
 * DATA cannot authorize another source/owner/row or a primary activation. The
 * complete indexed current metadata and pointers are compared again before any
 * original, row, map or cache effect. Prepared field installers stay scoped to
 * their actual producer and attach in this same transaction. */
export class Brc38PreparedProofMerge {
  #consumed = false
  #closed = false
  readonly #root: Knex
  readonly #token: object
  readonly #rows: readonly Row[]
  readonly #originalMap: SyncMap
  /** Effect DATA retained with each original alias; final inventory must
   * independently reconstruct it from original metadata and complete bytes. */
  readonly proofChanges: readonly boolean[]
  constructor(
    token: object,
    private readonly storage: StorageKnex,
    private readonly admission: Readonly<Brc38ImportJournalAdmission>,
    private readonly page: Brc38PreparedStreamedPage,
    rows: readonly Row[],
    originalMap: SyncMap,
    private readonly originals: { apply(trx: Knex.Transaction): Promise<void> },
    private readonly fieldAllowance: number,
    private readonly install: Brc38PrivatePreparedFieldInstaller,
    private readonly deadline: number,
    readonly checkpointMappings: readonly Readonly<{ incomingId: number; localId: number }>[],
    private readonly allocation?: Brc38PrivatePageIds,
    private readonly cache?: Brc38ImportCacheFence,
    private readonly signal?: AbortSignal
  ) {
    if (token !== issuer) invalid()
    this.#rows = rows
    this.#originalMap = originalMap
    this.proofChanges = Object.freeze(rows.map(row => !row.identical))
    this.#root = storage.toDb()
    const identity = privateNativeDatabaseIdentity(this.#root)
    if (identity?.slot !== 0) invalid()
    this.#token = identity.token
  }
  private check(trx: Knex.Transaction): void {
    this.signal?.throwIfAborted()
    const root = privateNativeDatabaseIdentity(this.#root),
      actual = privateNativeTransactionIdentity(trx)
    if (
      this.#closed ||
      this.storage.toDb() !== this.#root ||
      root?.slot !== 0 ||
      root.token !== this.#token ||
      actual?.slot !== 0 ||
      actual.token !== this.#token ||
      !isBrc38OwnedPrivateNativeWriter(trx) ||
      Date.now() >= this.admission.expiresAt ||
      performance.now() >= this.deadline
    )
      invalid()
    requireBrc38ImportSqliteTransaction(trx)
  }
  async apply(trx: Knex.Transaction): Promise<{ inserts: number; updates: number }> {
    this.check(trx)
    if (this.#consumed || this.page.data.kind !== 'table' || this.page.data.table !== 'provenTxs') invalid()
    this.#consumed = true
    try {
      const { data, budget } = this.page
      chargeBrc38ImportDecodedBudget(budget, this.fieldAllowance + 32768 + 2048 * this.page.references.length)
      await verifyBrc38AuthenticatedSourceSeal(trx)
      const loaded = await loadBrc38ImportIdMap(trx, this.admission.scope, this.page.references)
      for (const ref of this.page.references) {
        const prior = this.#originalMap[ref.entity].idMap,
          current = loaded.map[ref.entity].idMap
        if (
          Object.hasOwn(prior, ref.incomingId) !== Object.hasOwn(current, ref.incomingId) ||
          prior[ref.incomingId] !== current[ref.incomingId]
        )
          invalid()
      }
      await assertBrc38ImportExistingFieldTargets(
        trx,
        this.storage,
        this.admission.scope.userId,
        'provenTxs',
        this.#rows.map(row => row.target),
        this.#rows.map(row => row.existing),
        this.fieldAllowance,
        this.signal
      )
      for (const index of this.#rows.keys()) {
        this.check(trx)
        chargeBrc38ImportDecodedBudget(budget, 163840)
        await assertBrc38NativeStreamedSourceRow(
          trx,
          'provenTxs',
          data.fromIndex + index,
          data.rows[index].source,
          Math.min(8192, this.admission.maximumStepBytes)
        )
      }
      await this.originals.apply(trx)
      let inserts = 0,
        updates = 0
      for (const [index, row] of this.#rows.entries()) {
        this.check(trx)
        if (!row.identical) {
          chargeBrc38ImportDecodedBudget(budget, 16384)
          const incoming = row.incoming,
            metadata = {
              provenTxId: row.current === undefined ? 0 : row.localId,
              created_at: new Date((row.current ?? incoming).created_at.getTime()),
              // The archive entity contract preserves its incoming timestamp;
              // operational chain reconciliation has a separate correction clock.
              updated_at: new Date(incoming.updated_at.getTime()),
              txid: incoming.txid,
              height: incoming.height,
              index: incoming.index,
              blockHash: incoming.blockHash.toLowerCase(),
              merkleRoot: incoming.merkleRoot.toLowerCase()
            }
          const physical =
            row.current === undefined && this.allocation !== undefined
              ? await insertBrc38PackedPlannedMetadata(
                  this.storage,
                  trx,
                  'provenTxs',
                  metadata,
                  ['rawTx', 'merklePath'],
                  this.allocation,
                  budget
                )
              : await updateBrc38PackedPrivateMetadata(
                  this.storage,
                  trx,
                  'provenTxs',
                  metadata,
                  ['rawTx', 'merklePath'],
                  row.target,
                  budget
                )
          positive(physical)
          if (row.current === undefined && physical !== row.localId) invalid()
          for (const name of ['rawTx', 'merklePath'] as const)
            await this.install(
              trx,
              'provenTxs',
              data.fromIndex + index,
              physical,
              data.rows[index].source.binaries[name]
            )
          if (row.current === undefined) inserts++
          else updates++
        } else if (row.current === undefined) invalid()
        loaded.map.provenTx.idMap[row.incoming.provenTxId] = row.localId
        chargeBrc38ImportDecodedBudget(budget, 163840)
        await assertBrc38NativeStreamedSourceRow(
          trx,
          'provenTxs',
          data.fromIndex + index,
          data.rows[index].source,
          Math.min(8192, this.admission.maximumStepBytes)
        )
      }
      if (inserts + updates !== 0) {
        if (this.cache === undefined) invalid()
        await applyBrc38ImportCacheFence(trx, this.storage, this.cache, this.signal)
      }
      await loaded.persist()
      await verifyBrc38AuthenticatedSourceSeal(trx)
      this.check(trx)
      return { inserts, updates }
    } finally {
      this.close()
    }
  }
  close(): void {
    this.#closed = true
  }
}

/** Bounded occupied proof preparation on the actual private query-only owner.
 * Compare real bytes in finite windows before treating a row as unchanged.
 * Changed/new proofs receive the original complete streamed raw/SDK Merkle/
 * active-header oracle before writer admission. No network or payload hashing
 * occurs in apply; fresh source/current pointers and one-use producer checks do. */
export async function prepareBrc38ProofMerge(
  trx: Knex.Transaction,
  storage: StorageKnex,
  reader: Readonly<Brc38AuthenticatedStreamedImportReader>,
  admission: Readonly<Brc38ImportJournalAdmission>,
  page: Brc38PreparedStreamedPage,
  install: Brc38PrivatePreparedFieldInstaller,
  signal?: AbortSignal
): Promise<Brc38PreparedProofMerge> {
  requireBrc38ImportSqliteTransaction(trx)
  const root = storage.toDb(),
    identity = privateNativeDatabaseIdentity(root),
    read = privateNativeTransactionIdentity(trx),
    { data, budget } = page,
    deadline = performance.now() + Math.max(0, admission.expiresAt - Date.now())
  if (
    identity?.slot !== 0 ||
    read?.slot !== 3 ||
    read.token !== identity.token ||
    data.kind !== 'table' ||
    data.table !== 'provenTxs'
  )
    invalid()
  const check = (): void => {
    signal?.throwIfAborted()
    if (
      storage.toDb() !== root ||
      privateNativeDatabaseIdentity(root)?.token !== identity.token ||
      privateNativeTransactionIdentity(trx)?.token !== identity.token ||
      Date.now() >= admission.expiresAt ||
      performance.now() >= deadline
    )
      invalid()
  }
  check()
  await verifyBrc38AuthenticatedSourceSeal(trx)
  const originalReader: Readonly<Brc38AuthenticatedImportReader> = Object.freeze<Brc38AuthenticatedImportReader>({
      header: reader.header,
      count: reader.count,
      row: async (table, index) => {
        const source = await reader.row(table, index)
        return source === undefined
          ? undefined
          : ({
              protocol: 'brc38-structured-original/v1',
              table,
              index,
              fields: source.fields,
              binaries: source.binaries,
              structured: source.structured ?? {},
              ...(Object.keys(source.texts ?? {}).length === 0 ? {} : { texts: source.texts })
            } as unknown as PortableRow)
      }
    }),
    originals = await prepareBrc38ImportStructuredOriginals(
      trx,
      originalReader,
      admission,
      data,
      page.step.fromRow,
      budget
    )
  chargeBrc38ImportDecodedBudget(budget, 32768 + 2048 * page.references.length)
  const loaded = await loadBrc38ImportIdMap(trx, admission.scope, page.references),
    originalMap = copyBrc38ImportDecodedValue(loaded.map, budget),
    keyAllowance = Math.min(1048576, Math.floor(budget.remaining / 8)),
    fieldAllowance = Math.min(1048576, Math.floor(budget.remaining / 8))
  if (keyAllowance < 16384 || fieldAllowance < 16384) invalid()
  chargeBrc38ImportDecodedBudget(budget, keyAllowance + fieldAllowance + 8192 + 1024 * data.rows.length)
  const keys = data.rows.map(row => {
    const txid = row.metadata.txid
    if (typeof txid !== 'string' || !/^[0-9a-f]{64}$/i.test(txid)) invalid()
    // Match the legacy BINARY-index identity with its archived spelling.
    return Object.freeze({ provenTxId: row.metadata.provenTxId, txid })
  })
  const targets = await prepareBrc38ImportEntityTargets(
      trx,
      admission.scope.userId,
      { kind: 'table', table: 'provenTxs', rows: keys },
      loaded.map,
      keyAllowance,
      signal
    ),
    existing = await prepareBrc38ImportExistingFieldTargets(
      trx,
      storage,
      admission.scope.userId,
      'provenTxs',
      targets,
      fieldAllowance,
      signal
    ),
    scratch = Math.min(8388608, Math.floor(budget.remaining / 2)),
    maximumDecodedMerkleBytes = scratch - 1048576,
    maximum = JSON.parse(admission.originalLimitsJson) as number[]
  if (scratch < 2097152 || maximumDecodedMerkleBytes < 8192) invalid()
  // Serial scratch reservation remains charged across all rows and any retained
  // network cleanup. It cannot enlarge the original page's working ceiling.
  chargeBrc38ImportDecodedBudget(budget, scratch)
  const working = new Brc38WorkingAllocation(scratch),
    rows: Array<Omit<Row, 'localId'>> = [],
    identities = new Set<string>()
  for (const [index, selected] of data.rows.entries()) {
    check()
    chargeBrc38ImportDecodedBudget(budget, existing[index].allocationBytes + 8192)
    const target = targets[index],
      key = keys[index].txid.toLowerCase()
    if (identities.has(key)) throw new Brc38ImportAliasPageError(index)
    identities.add(key)
    const incoming = proof(
        prepareBrc38ImportOriginalFieldPolicy(
          'provenTxs',
          data.fromIndex + index,
          selected.metadata,
          selected.source,
          budget
        )
      ),
      currentData = prepareBrc38ImportCurrentFieldPolicy(existing[index], budget),
      current = currentData === undefined ? undefined : proof(currentData)
    let identical = current !== undefined && sameMetadata(current, incoming)
    for (const name of ['rawTx', 'merklePath'] as const) {
      const source = selected.source.binaries[name],
        prior = existing[index].binaries[name]
      if (source === undefined || source.bytes < 1) invalid()
      if (!identical || prior === undefined || prior.bytes !== source.bytes || prior.sha256 !== source.sha256) {
        identical = false
        continue
      }
      const allowance = working.claim(2097152),
        sourceHash = createHash('sha256'),
        currentHash = createHash('sha256')
      try {
        for (let offset = 0; offset < source.bytes;) {
          check()
          const chunk = await reader.chunk('provenTxs', data.fromIndex + index, name, offset)
          if (chunk === undefined) invalid()
          try {
            if (
              !(chunk.bytes instanceof Uint8Array) ||
              chunk.offset !== offset ||
              chunk.bytes.length < 1 ||
              chunk.bytes.length > Math.min(65536, source.bytes - offset) ||
              chunk.descriptor.bytes !== source.bytes ||
              chunk.descriptor.sha256 !== source.sha256
            )
              invalid()
            sourceHash.update(chunk.bytes)
            for (let used = 0; used < chunk.bytes.length;) {
              check()
              const length = Math.min(16384, chunk.bytes.length - used),
                bytes = await readBrc38NativePackedExtent(
                  trx,
                  {
                    table: 'provenTxs',
                    field: name,
                    rowId: positive(existing[index].binaryRowId),
                    offset: offset + used,
                    length,
                    totalBytes: source.bytes
                  },
                  signal
                )
              try {
                if (bytes.length !== length) invalid()
                currentHash.update(bytes)
                for (let at = 0; at < length; at++) if (bytes[at] !== chunk.bytes[used + at]) identical = false
                used += length
              } finally {
                bytes.fill(0)
              }
              if (!identical) break
            }
            offset += chunk.bytes.length
          } finally {
            chunk.bytes.fill(0)
          }
          if (!identical) break
        }
        if (identical && (sourceHash.digest('hex') !== source.sha256 || currentHash.digest('hex') !== prior.sha256))
          invalid()
      } finally {
        allowance.close()
      }
    }
    if (!identical) {
      const inspected = await inspectBrc38AuthenticatedStreamedProofReader(
        reader,
        storage,
        data.fromIndex + index,
        {
          maximumRawBytes: Math.min(1000000000, maximum[1]),
          maximumChunks: Math.min(1000000000, maximum[1]),
          maximumMerkleBytes: 1048576,
          maximumDecodedMerkleBytes,
          maximumChunkBytes: 65536,
          workingAllocation: working,
          maximumNetworkMilliseconds: 30000,
          cleanupMilliseconds: 30000,
          signal
        },
        admission.expiresAt,
        deadline
      )
      if (
        inspected.txid !== incoming.txid.toLowerCase() ||
        inspected.height !== incoming.height ||
        inspected.index !== incoming.index ||
        inspected.blockHash !== incoming.blockHash.toLowerCase() ||
        inspected.merkleRoot !== incoming.merkleRoot.toLowerCase() ||
        inspected.rawSha256 !== selected.source.binaries.rawTx.sha256 ||
        inspected.merkleSha256 !== selected.source.binaries.merklePath.sha256
      )
        invalid()
    }
    check()
    chargeBrc38ImportDecodedBudget(budget, 163840)
    await assertBrc38NativeStreamedReadSourceRow(
      trx,
      'provenTxs',
      data.fromIndex + index,
      selected.source,
      Math.min(8192, admission.maximumStepBytes)
    )
    rows.push(Object.freeze({ incoming, current, target, existing: existing[index], identical }))
  }
  check()
  const count = rows.filter(row => row.current === undefined).length,
    allocation =
      count === 0
        ? undefined
        : await prepareBrc38PrivatePageIds(storage, trx, 'provenTxs', count, admission.expiresAt, budget),
    cache = rows.some(row => !row.identical) ? await prepareBrc38ImportCacheFence(trx, storage, budget) : undefined
  chargeBrc38ImportDecodedBudget(budget, 8192 + 2048 * rows.length)
  let ordinal = 0
  const resolved = rows.map(row =>
      Object.freeze({
        ...row,
        localId: row.current === undefined ? positive(allocation?.ids[ordinal++]) : positive(row.target.localId)
      })
    ),
    mappings = Object.freeze(
      resolved.map(row => Object.freeze({ incomingId: row.incoming.provenTxId, localId: row.localId }))
    )
  await verifyBrc38AuthenticatedSourceSeal(trx)
  check()
  return new Brc38PreparedProofMerge(
    issuer,
    storage,
    admission,
    page,
    Object.freeze(resolved),
    originalMap,
    originals,
    fieldAllowance,
    install,
    deadline,
    mappings,
    allocation,
    cache,
    signal
  )
}
