import type { Knex } from 'knex'
import type { StorageKnex } from '../StorageKnex'
import type { Brc38PreparedImportData, Brc38ImportRowTypes } from './Brc38ImportPage'
import type { Brc38StageTable } from './Brc38SemanticStage'
import type { Brc38AuthenticatedImportReader } from './KnexBrc38StagingStore'
import type { Brc38ImportJournalAdmission } from './Brc38ImportJournal'
import { loadBrc38ImportIdMap, type Brc38ImportIdReference } from './Brc38ImportIdMap'
import { requireBrc38ImportSqliteTransaction } from './Brc38ImportJournalSchema'
import { prepareBrc38ImportOriginals } from './Brc38ImportProvenanceNode'
import {
  copyBrc38ImportDecodedValue,
  prepareBrc38ImportCacheFence,
  applyBrc38ImportCacheFence,
  type Brc38ImportCacheFence,
  type Brc38ImportDecodedBudget
} from './Brc38ImportEntityMergeNode'
import { canonicalizeSyncProofIdentifiers, validateSyncProof } from '../methods/validateSyncProof'
import { runInSeries } from '../../utility/runInSeries'
import type { SyncMap } from '../schema/entities/EntityBase'

const identities: Partial<Record<Brc38StageTable, readonly [keyof SyncMap, string]>> = {
  provenTxs: ['provenTx', 'provenTxId'],
  outputBaskets: ['outputBasket', 'basketId'],
  outputTags: ['outputTag', 'outputTagId'],
  txLabels: ['txLabel', 'txLabelId'],
  transactions: ['transaction', 'transactionId'],
  outputs: ['output', 'outputId'],
  certificates: ['certificate', 'certificateId'],
  commissions: ['commission', 'commissionId'],
  provenTxReqs: ['provenTxReq', 'provenTxReqId']
}
function invalid(): never {
  throw new Error('Private native restore differs from its prepared source or admitted profile')
}
/** Each branch preserves the archived native value. Policy migration is a
 * separate operational decision; restoring a historical default must not
 * silently upgrade it. No entity merge, natural-key deduplication, parent or
 * history remapping belongs here. */
export async function insertBrc38RestoreRow(
  storage: StorageKnex,
  trx: Knex.Transaction,
  table: Brc38StageTable,
  row: Brc38ImportRowTypes[Brc38StageTable]
): Promise<number | void> {
  switch (table) {
    case 'provenTxs':
      return await storage.insertProvenTx(row as Brc38ImportRowTypes['provenTxs'], trx)
    case 'outputBaskets':
      return await storage.insertOutputBasket(row as Brc38ImportRowTypes['outputBaskets'], trx)
    case 'outputTags':
      return await storage.insertOutputTag(row as Brc38ImportRowTypes['outputTags'], trx)
    case 'txLabels':
      return await storage.insertTxLabel(row as Brc38ImportRowTypes['txLabels'], trx)
    case 'transactions':
      return await storage.insertTransaction(row as Brc38ImportRowTypes['transactions'], trx)
    case 'outputs':
      return await storage.insertOutput(row as Brc38ImportRowTypes['outputs'], trx)
    case 'txLabelMaps':
      return await storage.insertTxLabelMap(row as Brc38ImportRowTypes['txLabelMaps'], trx)
    case 'outputTagMaps':
      return await storage.insertOutputTagMap(row as Brc38ImportRowTypes['outputTagMaps'], trx)
    case 'certificates':
      return await storage.insertCertificate(row as Brc38ImportRowTypes['certificates'], trx)
    case 'certificateFields':
      return await storage.insertCertificateField(row as Brc38ImportRowTypes['certificateFields'], trx)
    case 'commissions':
      return await storage.insertCommission(row as Brc38ImportRowTypes['commissions'], trx)
    case 'provenTxReqs':
      return await storage.insertProvenTxReq(row as Brc38ImportRowTypes['provenTxReqs'], trx)
    case 'syncStates':
      return await storage.insertSyncState(row as Brc38ImportRowTypes['syncStates'], trx)
  }
}
/** Prepared data only. Actual authenticated ownership, empty-target admission,
 * generation/profile/primary fences and cursor atomicity belong to the caller.
 * COMPLETE row application does not grant activation or prove visible isolation. */
export class Brc38PreparedEntityRestore {
  #consumed = false
  readonly #storage: StorageKnex
  readonly #admission: Brc38ImportJournalAdmission
  readonly #references: readonly Brc38ImportIdReference[]
  readonly #data: Brc38PreparedImportData
  readonly #originals: { apply: (trx: Knex.Transaction) => Promise<void> }
  readonly #cache?: Brc38ImportCacheFence
  readonly #signal?: AbortSignal
  constructor(
    storage: StorageKnex,
    admission: Brc38ImportJournalAdmission,
    references: readonly Brc38ImportIdReference[],
    data: Brc38PreparedImportData,
    originals: { apply: (trx: Knex.Transaction) => Promise<void> },
    cache?: Brc38ImportCacheFence,
    signal?: AbortSignal
  ) {
    this.#storage = storage
    this.#admission = Object.freeze({ ...admission, scope: Object.freeze({ ...admission.scope }) })
    this.#references = references.map(value => Object.freeze({ ...value }))
    this.#data = data
    this.#originals = originals
    this.#cache = cache
    this.#signal = signal
  }
  async apply(trx: Knex.Transaction): Promise<{ inserts: number; updates: 0 }> {
    requireBrc38ImportSqliteTransaction(trx)
    if (this.#consumed) throw new Error('Prepared private native restore is already consumed')
    this.#consumed = true
    this.#signal?.throwIfAborted()
    await this.#originals.apply(trx)
    const data = this.#data
    if (data.kind === 'header') {
      // Preserve original primary and source in durable provenance, without an
      // implicit manager/primary activation. No source field is rewritten.
      await this.#storage.insertUser({ ...data.user, activeStorage: '' }, trx)
      this.#signal?.throwIfAborted()
      return { inserts: 1, updates: 0 }
    }
    const loaded = await loadBrc38ImportIdMap(trx, this.#admission.scope, this.#references),
      identity = identities[data.table]
    await runInSeries(data.rows as ReadonlyArray<Brc38ImportRowTypes[Brc38StageTable]>, async row => {
      this.#signal?.throwIfAborted()
      const incomingId = identity === undefined ? undefined : Reflect.get(row, identity[1]),
        result = await insertBrc38RestoreRow(this.#storage, trx, data.table, row)
      if (identity !== undefined) {
        if (
          typeof incomingId !== 'number' ||
          !Number.isInteger(incomingId) ||
          typeof result !== 'number' ||
          !Number.isSafeInteger(result)
        )
          invalid()
        loaded.map[identity[0]].idMap[incomingId] = result
      }
    })
    if (this.#cache !== undefined) await applyBrc38ImportCacheFence(trx, this.#storage, this.#cache, this.#signal)
    await loaded.persist()
    this.#signal?.throwIfAborted()
    return { inserts: data.rows.length, updates: 0 }
  }
}
export async function prepareBrc38ImportEntityRestore(
  trx: Knex.Transaction,
  storage: StorageKnex,
  reader: Readonly<Brc38AuthenticatedImportReader>,
  admission: Brc38ImportJournalAdmission,
  data: Brc38PreparedImportData,
  references: readonly Brc38ImportIdReference[],
  fromRow: number,
  maximumAllocationBytes: number,
  signal?: AbortSignal
): Promise<Brc38PreparedEntityRestore> {
  requireBrc38ImportSqliteTransaction(trx)
  if (!Number.isSafeInteger(maximumAllocationBytes) || maximumAllocationBytes < 1 || maximumAllocationBytes > 16777216)
    invalid()
  const budget: Brc38ImportDecodedBudget = {
      maximum: maximumAllocationBytes,
      remaining: maximumAllocationBytes,
      signal
    },
    prepared = copyBrc38ImportDecodedValue(data, budget)
  if (prepared.kind === 'header' && prepared.user.userId !== admission.scope.userId) invalid()
  await loadBrc38ImportIdMap(trx, admission.scope, references)
  const originals = await prepareBrc38ImportOriginals(trx, reader, admission, data, fromRow, budget)
  let cache: Brc38ImportCacheFence | undefined
  if (prepared.kind === 'table' && prepared.table === 'provenTxs') {
    await runInSeries(prepared.rows, async original => {
      const validation = copyBrc38ImportDecodedValue(original, budget)
      canonicalizeSyncProofIdentifiers(validation)
      await validateSyncProof(storage, validation)
    })
    cache = await prepareBrc38ImportCacheFence(trx, storage, budget)
  }
  signal?.throwIfAborted()
  return new Brc38PreparedEntityRestore(storage, admission, references, prepared, originals, cache, signal)
}
