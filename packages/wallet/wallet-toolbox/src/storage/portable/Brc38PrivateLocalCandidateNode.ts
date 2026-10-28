import { runInSeries } from '../../utility/runInSeries'
import { readBrc38PrivateMergeProgram, prepareBrc38PrivateMergeProgram } from './Brc38PrivateMergeProgramNode'
import {
  brc38PrivateMergeRecoveryTable,
  installBrc38PrivateMergeRecoverySchema,
  readBrc38PrivateMergeRecovery,
  type Brc38PrivateMergeRecovery
} from './Brc38PrivateMergeRecoverySchemaNode'
import {
  readBrc38ImportJournal,
  type Brc38ImportJournalAdmission,
  type Brc38ImportJournalReceipt
} from './Brc38ImportJournal'
import {
  brc38PrivateIncomingIdRanges,
  installBrc38PrivateIncomingIdSchema,
  readBrc38PrivateIncomingIdRange
} from './Brc38PrivateIncomingIdSchemaNode'
import { brc38NativeIncomingIdTables } from './Brc38NativeIncomingIdReservationNode'
import { brc38PrivatePageIdForms } from './Brc38PrivatePageIdsNode'
import { createHash } from 'node:crypto'
import type { Knex } from 'knex'
import { StorageKnex } from '../StorageKnex'
import { StorageProvider } from '../StorageProvider'
import type { KnexBrc38StagingStore } from './KnexBrc38StagingStore'
import { Brc38NativeLocalBaselineSource } from './Brc38NativeLocalBaselineSourceNode'
import {
  brc38NativeLocalBaselineTables,
  brc38NativeLocalBaselineTableCount as tableCount,
  type Brc38NativeLocalBaselineTable
} from './Brc38NativeLocalBaselineTables'
import { withBrc38PrivateLocalBaselineRow, type Brc38PrivateLocalBaselineRow } from './Brc38PrivateLocalBaselineRowNode'
import { writeBrc38PrivateLocalPackedRow } from './Brc38PrivateLocalPackedRowWriterNode'
import {
  installBrc38PrivateNativeCandidateSchema,
  type Brc38PrivateNativeRestoreOptions
} from './Brc38PrivateNativeRestoreNode'
import {
  hasBrc38PrivateLocalCandidateJournal,
  installBrc38PrivateLocalCandidateJournal,
  readBrc38PrivateLocalCandidateJournal,
  brc38PrivateLocalCandidateStateTable as state,
  brc38PrivateLocalCandidatePointTable as points,
  type Brc38PrivateLocalCandidateJournal
} from './Brc38PrivateLocalCandidateJournalNode'
import { verifyBrc38AuthenticatedSourceSeal } from './Brc38AuthenticatedSourceSealNode'
import { hasBrc38NativeLocalPackedLayout } from './Brc38NativeLocalPackedLayoutNode'
import { hasBrc38NativePackedTextSchema } from './Brc38NativePackedTextSchemaNode'
import { inspectBrc38PrivateLocalBaseline, inspectBrc38PrivateLocalRecovery } from './Brc38PrivateLocalInventoryNode'
import { brc38PrivateLocalUniqueConflict } from './Brc38PrivateLocalUniqueNode'
import { inspectBrc38PrivatePriorImports } from './Brc38PrivatePriorImportInventoryNode'
import { copyBrc38PrivatePriorImportStep } from './Brc38PrivatePriorImportNode'
import { copyBrc38PrivateLocalSequences } from './Brc38PrivateLocalSequencesNode'
import { collectBrc38NativePackedContent } from './Brc38NativePackedTextFieldsNode'
import { Brc38OwnedImportReads } from './Brc38OwnedImportReads'
import { brc38WorkingAllocation, type Brc38WorkingAllocation } from './Brc38WorkingAllocation'
import { snapshotJournalReceiptPolicy } from '../snapshot/journal/SnapshotJournalReceipt'
import { snapshotJournalRevision, type SnapshotJournalRevision } from '../snapshot/journal/SnapshotJournalRevision'

export interface Brc38PrivateLocalCandidateOptions extends Brc38PrivateNativeRestoreOptions {
  readonly maximumLocalRows: number
  readonly maximumReadBytes: number
  readonly workingAllocation: Brc38WorkingAllocation
  readonly signal?: AbortSignal
}
export interface Brc38PrivateLocalCandidateProgress {
  readonly phase: 'COPY' | 'DELTA' | 'RECOVERY' | 'CLEAR'
  readonly rebuilds: number
  readonly clearTable: number | null
  readonly copyTable: number
  readonly afterRowId: number | null
  readonly caughtUpRevision: SnapshotJournalRevision
  readonly copiedRows: number
  readonly recoveryRequired: boolean
  readonly garbageComplete: boolean
}
export interface Brc38PrivateCompositionStatus {
  readonly phase: 'BASELINE' | 'IMPORT'
  readonly candidatePhase: Brc38PrivateLocalCandidateProgress['phase']
  readonly episode: number
  readonly caughtUpRevision: SnapshotJournalRevision
  readonly sourceRevision: SnapshotJournalRevision
  readonly sourceChanged: boolean
  readonly admission?: Readonly<Brc38ImportJournalAdmission>
  readonly receipt?: Readonly<Brc38ImportJournalReceipt>
}
export class Brc38PrivateCompositionRequiredError extends Error {
  constructor(readonly sourceRevision: SnapshotJournalRevision) {
    super('Incoming merge effects require a new bounded composition episode before source rows can change')
    this.name = 'Brc38PrivateCompositionRequiredError'
  }
}
const issuer = Object.freeze({})
function invalid(): never {
  throw new Error('Private local candidate differs from its original source, actual owner or durable progress')
}
function same(a: unknown, b: unknown): boolean {
  return a instanceof Uint8Array && b instanceof Uint8Array
    ? a.byteLength === b.byteLength && a.every((byte, index) => byte === b[index])
    : Object.is(a, b)
}
function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}
function rowDigest(row: Readonly<Brc38PrivateLocalBaselineRow>): string {
  const hash = createHash('sha256')
  hash.update(JSON.stringify([row.table, row.rowId, row.revision, row.generation]))
  for (const key of Object.keys(row.metadata).sort((a, b) => Number(a > b) - Number(a < b))) {
    const value = row.metadata[key]
    hash.update(JSON.stringify(key))
    if (value === null) hash.update('null')
    else if (value instanceof Uint8Array) {
      hash.update('bytes:' + value.byteLength + ':')
      hash.update(value)
    } else if (typeof value === 'bigint') hash.update('integer:' + value.toString())
    else if (typeof value === 'number' && Number.isFinite(value)) hash.update('number:' + value.toString())
    else if (typeof value === 'string') hash.update('text:' + Buffer.byteLength(value) + ':' + value)
    else invalid()
    hash.update('\0')
  }
  for (const field of row.fields)
    hash.update(JSON.stringify([field.field, field.kind, field.bytes, field.sha256 ?? null]))
  return hash.digest('hex')
}
function progressEqual(
  a: Readonly<Brc38PrivateLocalCandidateJournal>,
  b: Readonly<Brc38PrivateLocalCandidateJournal>
): boolean {
  const { records: ar, lastOperationSha256: ah, ...av } = a,
    { records: br, lastOperationSha256: bh, ...bv } = b
  return (
    ar <= br &&
    JSON.stringify(av) === JSON.stringify(bv) &&
    (ah === null || /^[0-9a-f]{64}$/.test(ah)) &&
    (bh === null || /^[0-9a-f]{64}$/.test(bh))
  )
}
/** Scoped actual private copier. It never activates, exposes a provider, grants
 * archive semantics from point hashes, or reports a candidate as ready. COPY
 * and two-pass DELTA commit row/pointers/point/progress in one real transaction.
 * RECOVERY still requires the separate complete recovery-state/inventory and
 * current-primary cutover program. The original expiry is never renewed. */
export class Brc38PrivateLocalCandidate {
  readonly #io = new Brc38OwnedImportReads()
  readonly #deadline: number
  #live = true
  readonly #store: KnexBrc38StagingStore
  readonly #source: Brc38NativeLocalBaselineSource
  readonly #options: Readonly<Brc38PrivateLocalCandidateOptions>
  readonly #sourceSha256: string
  readonly #epoch: string
  private constructor(
    token: object,
    store: KnexBrc38StagingStore,
    source: Brc38NativeLocalBaselineSource,
    options: Readonly<Brc38PrivateLocalCandidateOptions>,
    sourceSha256: string,
    epoch: string
  ) {
    if (token !== issuer) invalid()
    this.#store = store
    this.#source = source
    this.#options = options
    this.#sourceSha256 = sourceSha256
    this.#epoch = epoch
    this.#deadline = performance.now() + Math.max(0, store.operationExpiresAt - Date.now())
  }
  #check(): void {
    this.#options.signal?.throwIfAborted()
    if (!this.#live || Date.now() >= this.#store.operationExpiresAt || performance.now() >= this.#deadline) invalid()
    this.#store.assertPrivateNativeDestination(this.#store.knex)
    Brc38NativeLocalBaselineSource.assertSharedWorking(this.#source, this.#options.workingAllocation)
  }
  async #journal(k: Knex.Transaction, writer: boolean): Promise<Readonly<Brc38PrivateLocalCandidateJournal>> {
    this.#check()
    if (writer) this.#store.assertPrivateNativeWriteTransaction(k)
    else this.#store.assertPrivateNativeReadTransaction(k)
    const foreign = (await k.raw('PRAGMA foreign_keys')) as Array<{ foreign_keys: number }>
    if (foreign.length !== 1 || foreign[0].foreign_keys !== 1) invalid()
    await verifyBrc38AuthenticatedSourceSeal(k)
    // Required TEXT validation includes the complete fresh binary family in
    // this same operation. Keep the mandatory local-layout check separately.
    if (!(await hasBrc38NativeLocalPackedLayout(k)) || !(await hasBrc38NativePackedTextSchema(k))) invalid()
    const value = await readBrc38PrivateLocalCandidateJournal(k)
    if (
      value.bindingSha256 !== this.#store.binding?.digest ||
      value.sourceSha256 !== this.#sourceSha256 ||
      value.epoch !== this.#epoch ||
      value.maximumRows !== this.#options.maximumLocalRows
    )
      invalid()
    this.#check()
    return value
  }
  async #read(): Promise<Readonly<Brc38PrivateLocalCandidateJournal>> {
    return await this.#store.withPrivateNativeDatabase(
      true,
      async database => await database.transaction(async k => await this.#journal(k, false))
    )
  }
  async #composition(
    k: Knex.Transaction,
    current: Readonly<Brc38PrivateLocalCandidateJournal>
  ): Promise<Brc38PrivateMergeRecovery | undefined> {
    const value = await readBrc38PrivateMergeRecovery(k)
    if (
      value !== undefined &&
      (value.bindingSha256 !== this.#store.binding!.digest ||
        value.sourceSha256 !== this.#sourceSha256 ||
        value.sourceEpoch !== this.#epoch ||
        value.episode !== current.rebuilds ||
        !['BASELINE', 'IMPORT'].includes(value.phase) ||
        (value.phase === 'IMPORT' && (value.activeImportId === null || current.phase !== 'RECOVERY')) ||
        (value.phase === 'BASELINE' && value.activeImportId !== null))
    )
      invalid()
    if (value !== undefined) snapshotJournalRevision(value.sourceRevision)
    if (value?.phase === 'IMPORT') {
      const values = (await k('brc38_import_journal')
        .where({ importId: value.activeImportId })
        .select(
          k.raw('CASE WHEN length(CAST(admissionJson AS BLOB)) BETWEEN 1 AND 4096 THEN admissionJson END AS json')
        )
        .limit(2)) as Array<{ json: string | null }>
      if (values.length !== 1 || typeof values[0].json !== 'string') invalid()
      const admission = JSON.parse(values[0].json) as Brc38ImportJournalAdmission
      if (
        admission.scope.importId !== value.activeImportId ||
        admission.scope.bindingSha256 !== this.#store.binding!.digest ||
        admission.scope.archiveSha256 !== this.#store.binding!.binding.archiveSha256 ||
        admission.expiresAt !== this.#store.limits.expiresAt ||
        admission.originalLimitsJson !== this.#store.binding!.limitsJson ||
        admission.maximumStepRows !== this.#options.maximumStepRows ||
        admission.maximumStepBytes !== this.#options.maximumStepBytes ||
        admission.maximumMappedIds !== this.#options.maximumMappedIds ||
        admission.maximumJournalLogicalBytes !== this.#options.maximumJournalLogicalBytes
      )
        invalid()
      const receipt = await readBrc38ImportJournal(k, admission)
      if (receipt.state === 'EXPIRED') invalid()
    }
    return value
  }
  async #advance(
    before: Readonly<Brc38PrivateLocalCandidateJournal>,
    patch: Readonly<Record<string, unknown>>
  ): Promise<void> {
    this.#check()
    await this.#store.withPrivateNativeDatabase(
      false,
      async database =>
        await database.transaction(async k => {
          const current = await this.#journal(k, true)
          if (!progressEqual(before, current)) invalid()
          if (
            (await k(state)
              .where({ slot: 1 })
              .update({ ...patch, lastOperationSha256: digest(JSON.stringify([current, patch])) })) !== 1
          )
            invalid()
          await this.#journal(k, true)
        })
    )
    this.#check()
  }
  /** Relationship repair only: independently compare real parent metadata.
   * This never treats matching metadata/points as complete field acceptance. */
  async #parentMetadataMatches(table: Brc38NativeLocalBaselineTable, rowId: number): Promise<boolean> {
    return await Brc38NativeLocalBaselineSource.withOwnedRow(this.#source, table, rowId, async sourceRow => {
      this.#check()
      const names = Object.keys(sourceRow.metadata),
        charge = this.#options.workingAllocation.claim(131072)
      let row: Record<string, unknown> | undefined
      try {
        return await this.#store.withPrivateNativeDatabase(
          true,
          async database =>
            await database.transaction(async k => {
              await this.#journal(k, false)
              const extents = (await k(table)
                .whereRaw('rowid=CAST(? AS INTEGER)', [rowId.toString()])
                .select(
                  k.raw(
                    '(' +
                      names
                        .map(
                          () =>
                            "CASE WHEN typeof(??) IN ('integer','real','null') THEN 8 ELSE coalesce(length(CAST(?? AS BLOB)),0) END"
                        )
                        .join('+') +
                      ') AS bytes',
                    names.flatMap(name => [name, name])
                  )
                )
                .limit(2)) as Array<{ bytes: number }>
              if (extents.length === 0) return false
              if (
                extents.length !== 1 ||
                !Number.isSafeInteger(extents[0].bytes) ||
                extents[0].bytes < 0 ||
                extents[0].bytes > 131072
              )
                invalid()
              charge.resize(131072 + 32 * extents[0].bytes)
              const values = (await k(table)
                .whereRaw('rowid=CAST(? AS INTEGER)', [rowId.toString()])
                .select(names)
                .limit(2)
                .options({ safeIntegers: true })) as Array<Record<string, unknown>>
              if (values.length !== 1) invalid()
              row = values[0]
              this.#check()
              return names.every(name => same(row![name], sourceRow.metadata[name]))
            })
        )
      } finally {
        for (const value of Object.values(row ?? {})) if (value instanceof Uint8Array) value.fill(0)
        charge.close()
      }
    })
  }
  async #copy(
    table: Brc38NativeLocalBaselineTable,
    rowId: number,
    before: Readonly<Brc38PrivateLocalCandidateJournal>,
    patch: Readonly<Record<string, unknown>>,
    allowance: { rows: number },
    depth = 0
  ): Promise<'COPIED' | 'BUDGET' | 'REBUILD'> {
    this.#check()
    if (depth >= tableCount) invalid()
    const parents = await Brc38NativeLocalBaselineSource.ownedParents(this.#source, table, rowId)
    for (const parent of parents) {
      if (brc38NativeLocalBaselineTables.indexOf(parent.table) >= brc38NativeLocalBaselineTables.indexOf(table))
        invalid()
      if (!(await this.#parentMetadataMatches(parent.table, parent.rowId))) {
        const result = await this.#copy(parent.table, parent.rowId, before, {}, allowance, depth + 1)
        if (result !== 'COPIED') return result
      }
    }
    if (allowance.rows === 0) return 'BUDGET'
    const conflict = await Brc38NativeLocalBaselineSource.withOwnedRow(
      this.#source,
      table,
      rowId,
      async row =>
        await this.#store.withPrivateNativeDatabase(
          true,
          async database =>
            await database.transaction(async k => {
              await this.#journal(k, false)
              return await brc38PrivateLocalUniqueConflict(this.#store, k, row, {
                workingAllocation: this.#options.workingAllocation,
                expiresAt: this.#store.operationExpiresAt,
                signal: this.#options.signal
              })
            })
        )
    )
    if (conflict) return 'REBUILD'
    const budget = {
      maximum: this.#store.limits.maximumRowAllocationBytes,
      remaining: this.#store.limits.maximumRowAllocationBytes,
      signal: this.#options.signal
    }
    const copied = await withBrc38PrivateLocalBaselineRow(
      this.#store,
      this.#source,
      table,
      rowId,
      {
        expiresAt: this.#store.operationExpiresAt,
        maximumReadBytes: this.#options.maximumReadBytes,
        workingAllocation: this.#options.workingAllocation,
        signal: this.#options.signal
      },
      budget,
      async (row, lifetimes) => {
        this.#check()
        const contentCharge = this.#options.workingAllocation.claim(1048576)
        try {
          const sha256 = rowDigest(row),
            tableId = brc38NativeLocalBaselineTables.indexOf(table)
          return await this.#store.withPrivateNativeDatabase(
            false,
            async database =>
              await database.transaction(async k => {
                const current = await this.#journal(k, true)
                if (!progressEqual(before, current)) invalid()
                if (
                  await brc38PrivateLocalUniqueConflict(
                    this.#store,
                    k,
                    row,
                    {
                      workingAllocation: this.#options.workingAllocation,
                      expiresAt: this.#store.operationExpiresAt,
                      signal: this.#options.signal
                    },
                    true
                  )
                )
                  return false
                await writeBrc38PrivateLocalPackedRow(this.#store, k, row, lifetimes, {
                  expiresAt: this.#store.operationExpiresAt,
                  workingAllocation: this.#options.workingAllocation,
                  signal: this.#options.signal
                })
                const point = {
                    tableId,
                    rowId,
                    revision: row.revision,
                    generation: row.generation,
                    present: 1,
                    contentSha256: sha256
                  },
                  prior = await k(points).where({ tableId, rowId }).first('tableId')
                if (prior === undefined) await k(points).insert(point)
                else if ((await k(points).where({ tableId, rowId }).update(point)) !== 1) invalid()
                if (
                  (await k(state)
                    .where({ slot: 1 })
                    .update({
                      ...patch,
                      lastOperationSha256: digest(
                        JSON.stringify([current, tableId, rowId, row.revision, row.generation, sha256, patch])
                      )
                    })) !== 1
                )
                  invalid()
                const post = await this.#journal(k, true)
                if (Object.entries(patch).some(([key, value]) => !Object.is(Reflect.get(post, key), value))) invalid()
                return true
              })
          )
        } finally {
          contentCharge.close()
        }
      }
    )
    this.#check()
    if (!copied) return 'REBUILD'
    allowance.rows--
    return 'COPIED'
  }
  async #startRebuild(before: Readonly<Brc38PrivateLocalCandidateJournal>): Promise<void> {
    if (before.phase === 'CLEAR' || before.rebuilds >= 3) invalid()
    const facts = await Brc38NativeLocalBaselineSource.facts(this.#source)
    if (
      facts.generation.epoch !== this.#epoch ||
      !facts.generation.complete ||
      !facts.generation.enabled ||
      BigInt(facts.generation.revision) < BigInt(before.caughtUpRevision)
    )
      invalid()
    await this.#store.withPrivateNativeDatabase(
      false,
      async database =>
        await database.transaction(async k => {
          const current = await this.#journal(k, true),
            recovery = await this.#composition(k, current)
          if (
            !progressEqual(before, current) ||
            recovery?.phase === 'IMPORT' ||
            (recovery !== undefined && BigInt(facts.generation.revision) < BigInt(recovery.sourceRevision))
          )
            invalid()
          const patch = {
            phase: 'CLEAR',
            rebuilds: current.rebuilds + 1,
            clearTable: tableCount - 1,
            deltaPass: null,
            deltaHighWater: null,
            deltaRevision: null,
            deltaTable: null,
            deltaRowId: null
          }
          if (
            (await k(state)
              .where({ slot: 1 })
              .update({
                ...patch,
                lastOperationSha256: digest(JSON.stringify([current, patch, 'baseline-rebuild']))
              })) !== 1
          )
            invalid()
          // A natural-key conflict during baseline recopy consumes the same finite
          // episode budget. Keep both durable cursors atomic, including a restart
          // when the source revision did not change during this recopy.
          if (
            recovery !== undefined &&
            (await k(brc38PrivateMergeRecoveryTable)
              .where({ slot: 1, phase: 'BASELINE', episode: recovery.episode })
              .update({
                episode: current.rebuilds + 1,
                sourceRevision: k.raw('CAST(? AS INTEGER)', [facts.generation.revision])
              })) !== 1
          )
            invalid()
          const post = await this.#journal(k, true)
          await this.#composition(k, post)
        })
    )
    this.#check()
  }
  async #clear(before: Readonly<Brc38PrivateLocalCandidateJournal>): Promise<void> {
    if (before.phase !== 'CLEAR' || before.clearTable === null) invalid()
    await this.#store.withPrivateNativeDatabase(
      false,
      async database =>
        await database.transaction(async k => {
          const current = await this.#journal(k, true)
          if (!progressEqual(before, current)) invalid()
          if (current.clearTable === -1) {
            if (current.records !== 0) invalid()
            await k(state)
              .where({ slot: 1 })
              .update({
                phase: 'COPY',
                copyTable: 0,
                afterRowId: null,
                clearTable: null,
                lastOperationSha256: digest(JSON.stringify([current, 'empty-recopy']))
              })
          } else {
            const tableId = current.clearTable!,
              table = brc38NativeLocalBaselineTables[tableId],
              retained = (await k(points).where({ tableId }).select('rowId').orderBy('rowId').limit(1)) as Array<{
                rowId: number
              }>,
              physical =
                retained.length === 0
                  ? ((await k(table)
                      .select(k.raw('rowid AS rowId'))
                      .orderBy('rowid')
                      .limit(1)
                      .options({ safeIntegers: true })) as Array<{ rowId: bigint }>)
                  : []
            if (retained.length === 0 && physical.length === 0) {
              await k(state)
                .where({ slot: 1 })
                .update({
                  clearTable: tableId - 1,
                  lastOperationSha256: digest(JSON.stringify([current, 'empty-table', tableId]))
                })
            } else {
              const rowId = retained.length === 1 ? BigInt(retained[0].rowId) : physical[0].rowId
              if (typeof rowId !== 'bigint' || rowId < -9007199254740991n || rowId > 9007199254740991n) invalid()
              await k(table).whereRaw('rowid=CAST(? AS INTEGER)', [rowId.toString()]).delete()
              if (
                (await k(table)
                  .whereRaw('rowid=CAST(? AS INTEGER)', [rowId.toString()])
                  .first(k.raw('1 AS present'))) !== undefined
              )
                invalid()
              if (
                retained.length === 1 &&
                (await k(points)
                  .where({ tableId, rowId: Number(rowId) })
                  .delete()) !== 1
              )
                invalid()
              await k(state)
                .where({ slot: 1 })
                .update({
                  lastOperationSha256: digest(JSON.stringify([current, 'retired-row', tableId, String(rowId)]))
                })
            }
          }
          await this.#journal(k, true)
        })
    )
    this.#check()
  }
  async #remove(
    change: Readonly<{
      table: Brc38NativeLocalBaselineTable
      tableId: number
      rowId: number
      revision: SnapshotJournalRevision
      generation: SnapshotJournalRevision
      present: boolean
    }>,
    before: Readonly<Brc38PrivateLocalCandidateJournal>
  ): Promise<void> {
    this.#check()
    const actual = await Brc38NativeLocalBaselineSource.physical(this.#source, change.table, change.rowId)
    if (actual === undefined || JSON.stringify(actual) !== JSON.stringify(change) || actual.present) invalid()
    await this.#store.withPrivateNativeDatabase(
      false,
      async database =>
        await database.transaction(async k => {
          const current = await this.#journal(k, true)
          if (!progressEqual(before, current)) invalid()
          await k(change.table).whereRaw('rowid=?', [change.rowId]).delete()
          // Logical row-delete observers release every core and auxiliary pointer;
          // actual FK enforcement rejects an unaccounted surviving child.
          if ((await k(change.table).whereRaw('rowid=?', [change.rowId]).first(k.raw('1 AS present'))) !== undefined)
            invalid()
          const point = {
              tableId: change.tableId,
              rowId: change.rowId,
              revision: change.revision,
              generation: change.generation,
              present: 0,
              contentSha256: null
            },
            key = { tableId: change.tableId, rowId: change.rowId },
            prior = await k(points).where(key).first('tableId')
          if (prior === undefined) await k(points).insert(point)
          else if ((await k(points).where(key).update(point)) !== 1) invalid()
          if (
            (await k(state)
              .where({ slot: 1 })
              .update({
                deltaTable: change.tableId,
                deltaRowId: change.rowId,
                deltaRevision: change.revision,
                lastOperationSha256: digest(JSON.stringify([current, change]))
              })) !== 1
          )
            invalid()
          const post = await this.#journal(k, true)
          if (
            post.deltaTable !== change.tableId ||
            post.deltaRowId !== change.rowId ||
            post.deltaRevision !== change.revision
          )
            invalid()
        })
    )
    this.#check()
  }
  inspectBaseline(): Promise<Readonly<{ rows: number; logicalBytes: string }>> {
    return this.#io.run(async () => {
      this.#check()
      const facts = await Brc38NativeLocalBaselineSource.facts(this.#source)
      return await this.#store.withPrivateNativeDatabase(
        true,
        async database =>
          await database.transaction(async k => {
            const before = await this.#journal(k, false)
            if (
              facts.generation.epoch !== this.#epoch ||
              before.phase !== 'RECOVERY' ||
              before.caughtUpRevision !== facts.generation.revision
            )
              invalid()
            const result = await inspectBrc38PrivateLocalBaseline(this.#store, this.#source, k, {
              maximumRows: this.#options.maximumLocalRows,
              maximumReadBytes: this.#options.maximumReadBytes,
              expiresAt: this.#store.operationExpiresAt,
              workingAllocation: this.#options.workingAllocation,
              signal: this.#options.signal
            })
            if (JSON.stringify(await this.#journal(k, false)) !== JSON.stringify(before)) invalid()
            this.#check()
            return result
          })
      )
    })
  }
  inspectLocalRecovery(): Promise<Readonly<{ rows: number; logicalBytes: string }>> {
    return this.#io.run(async () => {
      this.#check()
      const facts = await Brc38NativeLocalBaselineSource.facts(this.#source)
      return await this.#store.withPrivateNativeDatabase(
        true,
        async database =>
          await database.transaction(async k => {
            const before = await this.#journal(k, false),
              recovery = await this.#composition(k, before)
            if (
              facts.generation.epoch !== this.#epoch ||
              before.phase !== 'RECOVERY' ||
              before.caughtUpRevision !== facts.generation.revision ||
              recovery?.phase !== 'IMPORT' ||
              recovery.activeImportId === null
            )
              invalid()
            const result = await inspectBrc38PrivateLocalRecovery(this.#store, this.#source, k, {
              maximumRows: this.#options.maximumLocalRows,
              maximumReadBytes: this.#options.maximumReadBytes,
              expiresAt: this.#store.operationExpiresAt,
              workingAllocation: this.#options.workingAllocation,
              signal: this.#options.signal
            })
            if (JSON.stringify(await this.#journal(k, false)) !== JSON.stringify(before)) invalid()
            this.#check()
            return result
          })
      )
    })
  }
  /** Historical custody is separate from new import receipts and activation.
   * Only this issued actor supplies the original source and finite policy. */
  copyPriorImportStep(): Promise<
    Readonly<{ complete: boolean; table: number; records: number; logicalBytes: number }>
  > {
    return this.#io.run(async () => {
      this.#check()
      this.#store.assertMutableImport()
      const facts = await Brc38NativeLocalBaselineSource.facts(this.#source),
        before = await this.#read()
      if (
        facts.generation.epoch !== this.#epoch ||
        before.phase !== 'RECOVERY' ||
        before.caughtUpRevision !== facts.generation.revision
      )
        invalid()
      const copy = () =>
        copyBrc38PrivatePriorImportStep(this.#store, this.#source, {
          sourceSha256: this.#sourceSha256,
          maximumRows: this.#options.maximumLocalRows,
          maximumReadBytes: this.#options.maximumReadBytes,
          expiresAt: this.#store.operationExpiresAt,
          workingAllocation: this.#options.workingAllocation,
          signal: this.#options.signal
        })
      // Each original primitive copies at most one row or advances one family.
      // Bound the sequence with the existing admitted row allowance; every
      // primitive keeps its original atomic checkpoint and drains its fields.
      let receipt = await copy()
      await runInSeries(Array.from({ length: this.#options.maximumStepRows - 1 }).keys(), async () => {
        if (!receipt.complete) receipt = await copy()
      })
      const afterFacts = await Brc38NativeLocalBaselineSource.facts(this.#source),
        after = await this.#read()
      if (
        JSON.stringify(after) !== JSON.stringify(before) ||
        afterFacts.generation.epoch !== this.#epoch ||
        afterFacts.generation.revision !== facts.generation.revision
      )
        invalid()
      this.#check()
      return receipt
    })
  }
  inspectPriorImports(): Promise<Readonly<{ records: number; logicalBytes: number; chunks: number }>> {
    return this.#io.run(async () => {
      this.#check()
      const facts = await Brc38NativeLocalBaselineSource.facts(this.#source)
      return await this.#store.withPrivateNativeDatabase(
        true,
        async database =>
          await database.transaction(async k => {
            const before = await this.#journal(k, false)
            if (
              facts.generation.epoch !== this.#epoch ||
              before.phase !== 'RECOVERY' ||
              before.caughtUpRevision !== facts.generation.revision
            )
              invalid()
            const result = await inspectBrc38PrivatePriorImports(this.#store, this.#source, k, {
              sourceSha256: this.#sourceSha256,
              maximumRows: this.#options.maximumLocalRows,
              maximumReadBytes: this.#options.maximumReadBytes,
              expiresAt: this.#store.operationExpiresAt,
              workingAllocation: this.#options.workingAllocation,
              signal: this.#options.signal
            })
            if (JSON.stringify(await this.#journal(k, false)) !== JSON.stringify(before)) invalid()
            this.#check()
            return result
          })
      )
    })
  }
  /** Copy reservation DATA only from the hidden original same-source actor.
   * Sequence history must already include the real source's reserved floors. */
  prepareIncomingIds(): Promise<Readonly<{ tables: number }>> {
    return this.#io.run(async () => {
      this.#check()
      this.#store.assertMutableImport()
      const facts = await Brc38NativeLocalBaselineSource.facts(this.#source),
        before = await this.#read()
      if (
        facts.generation.epoch !== this.#epoch ||
        before.phase !== 'RECOVERY' ||
        before.caughtUpRevision !== facts.generation.revision
      )
        invalid()
      const ranges = await Brc38NativeLocalBaselineSource.ownedIncomingIdRanges(
        this.#source,
        this.#store.binding!.digest
      )
      return await this.#store.withPrivateNativeDatabase(
        false,
        async database =>
          await database.transaction(async k => {
            if (JSON.stringify(await this.#journal(k, true)) !== JSON.stringify(before)) invalid()
            await installBrc38PrivateIncomingIdSchema(k)
            for (const range of ranges) {
              this.#check()
              if (range.sourceEpoch !== this.#epoch || range.expiresAt !== this.#store.limits.expiresAt) invalid()
              const [sql] = brc38PrivatePageIdForms[brc38NativeIncomingIdTables[range.tableId]],
                counter = (await k('sqlite_sequence').where({ name: sql }).select('seq').limit(2)) as Array<{
                  seq: number
                }>
              if (
                counter.length !== 1 ||
                !Number.isSafeInteger(counter[0].seq) ||
                counter[0].seq < range.first + range.count - 1
              )
                invalid()
              const prior = await readBrc38PrivateIncomingIdRange(k, range.tableId),
                expected = {
                  ...range,
                  bindingSha256: this.#store.binding!.digest,
                  sourceSha256: this.#sourceSha256
                }
              if (prior === undefined) await k(brc38PrivateIncomingIdRanges).insert({ ...expected, used: 0 })
              else if (Object.entries(expected).some(([key, value]) => prior[key as keyof typeof prior] !== value))
                invalid()
            }
            const all = (await k(brc38PrivateIncomingIdRanges)
              .select('tableId')
              .orderBy('tableId')
              .limit(11)) as Array<{ tableId: number }>
            if (
              all.length !== ranges.length ||
              all.some((value, at) => value.tableId !== ranges[at].tableId) ||
              JSON.stringify(await this.#journal(k, true)) !== JSON.stringify(before)
            )
              invalid()
            this.#check()
            return Object.freeze({ tables: ranges.length })
          })
      )
    })
  }
  prepareMergeProgram(policyJson: string): Promise<void> {
    const json = policyJson
    return this.#io.run(async () => {
      this.#check()
      if (this.#store.recoveryComparisonOnly) {
        await this.#store.withPrivateNativeDatabase(
          true,
          async database =>
            await database.transaction(async k => {
              await this.#journal(k, false)
              const current = await readBrc38PrivateMergeProgram(k)
              if (
                current === undefined ||
                current.bindingSha256 !== this.#store.binding!.digest ||
                current.sourceSha256 !== this.#sourceSha256 ||
                current.policyJson !== json ||
                current.maximumMappedIds !== this.#options.maximumMappedIds ||
                current.maximumJournalLogicalBytes !== this.#options.maximumJournalLogicalBytes
              )
                invalid()
            })
        )
        return
      }
      await this.#store.withPrivateNativeDatabase(
        false,
        async database =>
          await database.transaction(async k => {
            await this.#journal(k, true)
            await prepareBrc38PrivateMergeProgram(k, {
              bindingSha256: this.#store.binding!.digest,
              sourceSha256: this.#sourceSha256,
              policyJson: json,
              maximumMappedIds: this.#options.maximumMappedIds,
              maximumJournalLogicalBytes: this.#options.maximumJournalLogicalBytes
            })
          })
      )
      this.#check()
    })
  }
  /** Fresh state DATA only, including the actual active journal. Unlike a pure
   * baseline step this can safely report a changed source after incoming pages. */
  inspectComposition(): Promise<Readonly<Brc38PrivateCompositionStatus>> {
    return this.#io.run(async () => {
      this.#check()
      const facts = await Brc38NativeLocalBaselineSource.facts(this.#source)
      return await this.#store.withPrivateNativeDatabase(
        true,
        async database =>
          await database.transaction(async k => {
            const current = await this.#journal(k, false),
              recovery = await this.#composition(k, current)
            if (
              facts.generation.epoch !== this.#epoch ||
              !facts.generation.complete ||
              !facts.generation.enabled ||
              BigInt(facts.generation.revision) < BigInt(current.caughtUpRevision) ||
              (recovery !== undefined && BigInt(facts.generation.revision) < BigInt(recovery.sourceRevision))
            )
              invalid()
            let admission: Readonly<Brc38ImportJournalAdmission> | undefined,
              receipt: Readonly<Brc38ImportJournalReceipt> | undefined
            if (recovery?.phase === 'IMPORT') {
              const rows = (await k('brc38_import_journal')
                .where({ importId: recovery.activeImportId })
                .select(
                  k.raw(
                    'CASE WHEN length(CAST(admissionJson AS BLOB)) BETWEEN 1 AND 4096 THEN admissionJson END AS json'
                  )
                )
                .limit(2)) as Array<{ json: string | null }>
              if (rows.length !== 1 || typeof rows[0].json !== 'string') invalid()
              const value = JSON.parse(rows[0].json) as Brc38ImportJournalAdmission
              admission = Object.freeze({ ...value, scope: Object.freeze({ ...value.scope }) })
              receipt = await readBrc38ImportJournal(k, admission)
            }
            this.#check()
            return Object.freeze({
              phase: recovery?.phase ?? 'BASELINE',
              candidatePhase: current.phase,
              episode: current.rebuilds,
              caughtUpRevision: current.caughtUpRevision,
              sourceRevision: facts.generation.revision,
              sourceChanged: facts.generation.revision !== current.caughtUpRevision,
              ...(admission === undefined ? {} : { admission, receipt })
            })
          })
      )
    })
  }
  prepareCompositionRecovery(): Promise<Readonly<{ episode: number }>> {
    return this.#io.run(async () => {
      this.#check()
      this.#store.assertMutableImport()
      const facts = await Brc38NativeLocalBaselineSource.facts(this.#source)
      return await this.#store.withPrivateNativeDatabase(
        false,
        async database =>
          await database.transaction(async k => {
            const current = await this.#journal(k, true)
            if (
              current.phase !== 'RECOVERY' ||
              facts.generation.epoch !== this.#epoch ||
              current.caughtUpRevision !== facts.generation.revision
            )
              invalid()
            await installBrc38PrivateMergeRecoverySchema(k)
            let recovery = await this.#composition(k, current)
            if (recovery === undefined) {
              await k(brc38PrivateMergeRecoveryTable).insert({
                slot: 1,
                bindingSha256: this.#store.binding!.digest,
                sourceSha256: this.#sourceSha256,
                sourceEpoch: this.#epoch,
                episode: current.rebuilds,
                phase: 'BASELINE',
                activeImportId: null,
                sourceRevision: k.raw('CAST(? AS INTEGER)', [current.caughtUpRevision])
              })
              recovery = await this.#composition(k, current)
            }
            if (
              recovery === undefined ||
              recovery.phase !== 'BASELINE' ||
              BigInt(recovery.sourceRevision) > BigInt(facts.generation.revision)
            )
              invalid()
            this.#check()
            return Object.freeze({ episode: recovery.episode })
          })
      )
    })
  }
  bindCompositionImport(admission: Brc38ImportJournalAdmission): Promise<void> {
    const input = Object.freeze({ ...admission, scope: Object.freeze({ ...admission.scope }) })
    return this.#io.run(async () => {
      this.#check()
      this.#store.assertMutableImport()
      const facts = await Brc38NativeLocalBaselineSource.facts(this.#source)
      if (
        input.scope.bindingSha256 !== this.#store.binding!.digest ||
        input.scope.archiveSha256 !== this.#store.binding!.binding.archiveSha256 ||
        input.scope.userId !== facts.fence.userId ||
        input.originalLimitsJson !== this.#store.binding!.limitsJson ||
        input.expiresAt !== this.#store.limits.expiresAt ||
        input.maximumStepRows !== this.#options.maximumStepRows ||
        input.maximumStepBytes !== this.#options.maximumStepBytes ||
        input.maximumMappedIds !== this.#options.maximumMappedIds ||
        input.maximumJournalLogicalBytes !== this.#options.maximumJournalLogicalBytes
      )
        invalid()
      await this.#store.withPrivateNativeDatabase(
        false,
        async database =>
          await database.transaction(async k => {
            const current = await this.#journal(k, true),
              recovery = await this.#composition(k, current),
              receipt = await readBrc38ImportJournal(k, input)
            if (
              current.phase !== 'RECOVERY' ||
              current.caughtUpRevision !== facts.generation.revision ||
              recovery === undefined ||
              receipt.state === 'EXPIRED' ||
              BigInt(recovery.sourceRevision) > BigInt(current.caughtUpRevision)
            )
              invalid()
            if (recovery.phase === 'IMPORT') {
              if (recovery.activeImportId !== input.scope.importId) invalid()
              return
            }
            if (receipt.nextRow !== 0) invalid()
            if (
              (await k(brc38PrivateMergeRecoveryTable)
                .where({ slot: 1, phase: 'BASELINE', episode: current.rebuilds })
                .update({
                  phase: 'IMPORT',
                  activeImportId: input.scope.importId,
                  sourceRevision: k.raw('CAST(? AS INTEGER)', [current.caughtUpRevision])
                })) !== 1
            )
              invalid()
            await this.#composition(k, current)
            this.#check()
          })
      )
    })
  }
  /** Explicit full refold. Earlier immutable journals/originals/maps survive
   * as historical DATA. Original expiry, quotas and three-rebuild bound remain. */
  beginCompositionRebuild(): Promise<Readonly<{ episode: number }>> {
    return this.#io.run(async () => {
      this.#check()
      this.#store.assertMutableImport()
      const facts = await Brc38NativeLocalBaselineSource.facts(this.#source)
      return await this.#store.withPrivateNativeDatabase(
        false,
        async database =>
          await database.transaction(async k => {
            const current = await this.#journal(k, true),
              recovery = await this.#composition(k, current)
            if (
              current.phase !== 'RECOVERY' ||
              recovery === undefined ||
              recovery.phase !== 'IMPORT' ||
              current.rebuilds >= 3 ||
              facts.generation.epoch !== this.#epoch ||
              BigInt(facts.generation.revision) <= BigInt(current.caughtUpRevision)
            )
              invalid()
            const episode = current.rebuilds + 1
            if (
              (await k(state)
                .where({ slot: 1, phase: 'RECOVERY', rebuilds: current.rebuilds })
                .update({
                  phase: 'CLEAR',
                  rebuilds: episode,
                  clearTable: tableCount - 1,
                  deltaPass: null,
                  deltaHighWater: null,
                  deltaRevision: null,
                  deltaTable: null,
                  deltaRowId: null,
                  lastOperationSha256: digest(
                    JSON.stringify([current, recovery, facts.generation.revision, 'composition-rebuild'])
                  )
                })) !== 1 ||
              (await k(brc38PrivateMergeRecoveryTable)
                .where({ slot: 1, phase: 'IMPORT', episode: current.rebuilds })
                .update({
                  phase: 'BASELINE',
                  activeImportId: null,
                  episode,
                  sourceRevision: k.raw('CAST(? AS INTEGER)', [facts.generation.revision])
                })) !== 1
            )
              invalid()
            const post = await this.#journal(k, true)
            await this.#composition(k, post)
            this.#check()
            return Object.freeze({ episode })
          })
      )
    })
  }
  copySequences(): Promise<Readonly<{ revision: SnapshotJournalRevision; digest: string; tables: number }>> {
    return this.#io.run(async () => {
      this.#check()
      this.#store.assertMutableImport()
      const facts = await Brc38NativeLocalBaselineSource.facts(this.#source),
        current = await this.#read()
      if (
        facts.generation.epoch !== this.#epoch ||
        current.phase !== 'RECOVERY' ||
        current.caughtUpRevision !== facts.generation.revision
      )
        invalid()
      const receipt = await copyBrc38PrivateLocalSequences(this.#store, this.#source, {
        expiresAt: this.#store.operationExpiresAt,
        workingAllocation: this.#options.workingAllocation,
        signal: this.#options.signal
      })
      this.#check()
      return receipt
    })
  }
  /** Consume the admitted row budget against this one coherent source view.
   * Every row/family advance keeps its original atomic journal checks; empty
   * families cannot consume an unbounded control loop. Parent copies share the
   * same row allowance, and row/field lifetimes still drain before the next. */
  async #copyPage(before: Readonly<Brc38PrivateLocalCandidateJournal>, allowance: { rows: number }): Promise<void> {
    let current = before,
      stopped = false
    const maximumOperations = tableCount + this.#options.maximumStepRows
    function* operations(): Generator<void> {
      for (let operation = 0; operation < maximumOperations; operation++) {
        if (stopped || current.phase !== 'COPY' || allowance.rows === 0) return
        yield
      }
    }
    await runInSeries(operations(), async () => {
      this.#check()
      const table = brc38NativeLocalBaselineTables[current.copyTable],
        page = await Brc38NativeLocalBaselineSource.ownedPage(this.#source, table, current.afterRowId, 1)
      if (page.length === 0)
        await this.#advance(current, {
          copyTable: current.copyTable + 1,
          afterRowId: null,
          ...(current.copyTable === tableCount - 1 ? { phase: 'DELTA' } : {})
        })
      else {
        const result = await this.#copy(table, page[0], current, { afterRowId: page[0] }, allowance)
        if (result !== 'COPIED') {
          if (result === 'REBUILD') await this.#startRebuild(current)
          stopped = true
          return
        }
      }
      current = await this.#read()
    })
  }
  step(): Promise<Readonly<Brc38PrivateLocalCandidateProgress>> {
    return this.#io.run(async () => {
      this.#check()
      this.#store.assertMutableImport()
      const charge = this.#options.workingAllocation.claim(1048576),
        allowance = { rows: this.#options.maximumStepRows }
      try {
        const facts = await Brc38NativeLocalBaselineSource.facts(this.#source),
          high = facts.generation.revision
        let current = await this.#read()
        const composition = await this.#store.withPrivateNativeDatabase(
          true,
          async database => await database.transaction(async k => await this.#composition(k, current))
        )
        if (composition !== undefined && BigInt(high) < BigInt(composition.sourceRevision)) invalid()
        if (composition?.phase === 'IMPORT' && high !== current.caughtUpRevision)
          throw new Brc38PrivateCompositionRequiredError(high)
        if (facts.generation.epoch !== this.#epoch || !facts.generation.complete || !facts.generation.enabled) invalid()
        if (
          BigInt(high) < BigInt(current.caughtUpRevision) ||
          (current.deltaHighWater !== null && BigInt(high) < BigInt(current.deltaHighWater))
        )
          invalid()
        if (current.phase === 'CLEAR') await this.#clear(current)
        else if (current.phase === 'COPY') await this.#copyPage(current, allowance)
        else {
          if (
            (current.phase === 'RECOVERY' && BigInt(high) > BigInt(current.caughtUpRevision)) ||
            (current.phase === 'DELTA' &&
              (current.deltaHighWater === null || BigInt(high) > BigInt(current.deltaHighWater)))
          ) {
            // A lost old snapshot cannot be reconstructed from old high-water
            // DATA. Re-open the whole interval from caughtUp on this newer real
            // snapshot; already committed rows replay idempotently.
            await this.#advance(current, {
              phase: 'DELTA',
              deltaPass: 'PRESENT',
              deltaHighWater: high,
              deltaRevision: null,
              deltaTable: null,
              deltaRowId: null
            })
            current = await this.#read()
          }
          if (current.phase === 'DELTA') {
            if (current.deltaHighWater !== high) invalid()
            if (current.deltaPass === 'PRESENT') {
              const after =
                  current.deltaRevision === null
                    ? undefined
                    : { revision: current.deltaRevision, tableId: current.deltaTable!, rowId: current.deltaRowId! },
                page = await Brc38NativeLocalBaselineSource.ownedChanges(
                  this.#source,
                  current.caughtUpRevision,
                  after,
                  1,
                  true
                )
              if (page.length === 0)
                await this.#advance(current, {
                  deltaPass: 'TOMBSTONE',
                  deltaRevision: null,
                  deltaTable: null,
                  deltaRowId: null
                })
              else {
                const row = page[0]
                if (!row.present) invalid()
                if (
                  (await this.#copy(
                    row.table,
                    row.rowId,
                    current,
                    { deltaRevision: row.revision, deltaTable: row.tableId, deltaRowId: row.rowId },
                    allowance
                  )) === 'REBUILD'
                )
                  await this.#startRebuild(current)
              }
            } else if (current.deltaPass === 'TOMBSTONE') {
              const after =
                  current.deltaTable === null
                    ? undefined
                    : { tableId: current.deltaTable, revision: current.deltaRevision!, rowId: current.deltaRowId! },
                page = await Brc38NativeLocalBaselineSource.ownedTombstones(
                  this.#source,
                  current.caughtUpRevision,
                  after,
                  1
                )
              if (page.length === 0)
                await this.#advance(current, {
                  phase: 'RECOVERY',
                  caughtUpRevision: high,
                  deltaPass: null,
                  deltaHighWater: null,
                  deltaRevision: null,
                  deltaTable: null,
                  deltaRowId: null
                })
              else await this.#remove(page[0], current)
            } else invalid()
          }
        }
        const garbage = await this.#store.withPrivateNativeDatabase(
            false,
            async database =>
              await database.transaction(async k => {
                await this.#journal(k, true)
                return await collectBrc38NativePackedContent(k, 32, this.#options.signal)
              })
          ),
          post = await this.#read()
        return Object.freeze({
          phase: post.phase,
          rebuilds: post.rebuilds,
          clearTable: post.clearTable,
          copyTable: post.copyTable,
          afterRowId: post.afterRowId,
          caughtUpRevision: post.caughtUpRevision,
          copiedRows: this.#options.maximumStepRows - allowance.rows,
          recoveryRequired: post.phase === 'RECOVERY',
          garbageComplete: garbage.complete
        })
      } finally {
        charge.close()
      }
    })
  }
  static async with<T>(
    store: KnexBrc38StagingStore,
    source: Brc38NativeLocalBaselineSource,
    selected: Brc38PrivateLocalCandidateOptions,
    work: (candidate: Brc38PrivateLocalCandidate) => Promise<T>
  ): Promise<T> {
    const working = brc38WorkingAllocation(selected.workingAllocation)
    if (working === undefined) invalid()
    const options = Object.freeze({
      receiptPolicy: Object.freeze({ ...snapshotJournalReceiptPolicy(selected.receiptPolicy) }),
      maximumStepRows: selected.maximumStepRows,
      maximumStepBytes: selected.maximumStepBytes,
      maximumMappedIds: selected.maximumMappedIds,
      maximumJournalLogicalBytes: selected.maximumJournalLogicalBytes,
      maximumLocalRows: selected.maximumLocalRows,
      maximumReadBytes: selected.maximumReadBytes,
      workingAllocation: working,
      services: selected.services,
      signal: selected.signal
    })
    if (
      working === undefined ||
      working.maximum > store.limits.maximumRowAllocationBytes ||
      !Number.isSafeInteger(options.maximumStepRows) ||
      options.maximumStepRows < 1 ||
      options.maximumStepRows > 128 ||
      !Number.isSafeInteger(options.maximumReadBytes) ||
      options.maximumReadBytes < 1 ||
      options.maximumReadBytes > 16384 ||
      !Number.isSafeInteger(options.maximumLocalRows) ||
      options.maximumLocalRows < 1 ||
      options.maximumLocalRows > 10000000
    )
      invalid()
    store.assertRecoverySharedWorking(working)
    store.assertPrivateNativeDestination(store.knex)
    Brc38NativeLocalBaselineSource.assertSharedWorking(source, working)
    const binding = store.binding
    if (binding === undefined) invalid()
    const charge = working.claim(1048576)
    try {
      return await store.withAuthenticatedPrivateStructuredDestination(async () => {
        const facts = await Brc38NativeLocalBaselineSource.facts(source),
          fence = facts.fence,
          { revision: ignoredRevision, ...identity } = fence
        if (
          fence.mode !== 'merge' ||
          fence.identityKey !== binding.binding.identityKey ||
          fence.chain !== binding.binding.chain ||
          fence.targetStorageIdentityKey !== binding.binding.targetStorageIdentityKey ||
          fence.userId === null ||
          !facts.generation.complete ||
          !facts.generation.enabled ||
          BigInt(ignoredRevision) < 0n
        )
          invalid()
        const sourceSha256 = digest(
            JSON.stringify({
              program: 'brc38-private-local-candidate/v3',
              maximumRebuilds: 3,
              tables: brc38NativeLocalBaselineTables,
              identity,
              epoch: facts.generation.epoch,
              expiresAt: store.limits.expiresAt,
              maximumLocalRows: options.maximumLocalRows,
              maximumReadBytes: options.maximumReadBytes,
              maximumStepRows: options.maximumStepRows,
              maximumStepBytes: options.maximumStepBytes,
              maximumMappedIds: options.maximumMappedIds,
              maximumJournalLogicalBytes: options.maximumJournalLogicalBytes,
              receiptPolicy: options.receiptPolicy,
              workingBytes: working.maximum
            })
          ),
          storage = new StorageKnex({
            ...StorageProvider.createStorageBaseOptions(binding.binding.chain),
            knex: store.knex,
            snapshotSync: false
          })
        storage.setServices(options.services)
        const existing = await store.withPrivateNativeDatabase(
          true,
          async database =>
            await database.transaction(async k => {
              store.assertPrivateNativeReadTransaction(k)
              return await hasBrc38PrivateLocalCandidateJournal(k)
            })
        )
        // A resumed CLEAR may intentionally have no settings/users. Re-running
        // initialization would recreate rows behind durable cleanup progress.
        if (store.recoveryComparisonOnly && !existing) invalid()
        if (!existing)
          await installBrc38PrivateNativeCandidateSchema(
            storage,
            store,
            binding.binding.targetStorageIdentityKey,
            options,
            true,
            true,
            true
          )
        if (!store.recoveryComparisonOnly)
          await store.withPrivateNativeDatabase(
            false,
            async database =>
              await database.transaction(async k => {
                store.assertPrivateNativeWriteTransaction(k)
                if (!(await hasBrc38PrivateLocalCandidateJournal(k)))
                  await installBrc38PrivateLocalCandidateJournal(k, {
                    bindingSha256: binding.digest,
                    sourceSha256,
                    epoch: facts.generation.epoch,
                    revision: facts.generation.revision,
                    maximumRows: options.maximumLocalRows
                  })
              })
          )
        const candidate = new Brc38PrivateLocalCandidate(
          issuer,
          store,
          source,
          options,
          sourceSha256,
          facts.generation.epoch
        )
        Object.freeze(candidate)
        try {
          return await candidate.#io.retain(async () => {
            const current = await candidate.#read()
            if (
              BigInt(current.caughtUpRevision) > BigInt(facts.generation.revision) ||
              (current.deltaHighWater !== null && BigInt(current.deltaHighWater) > BigInt(facts.generation.revision))
            )
              invalid()
            return await work(candidate)
          })
        } finally {
          candidate.#live = false
        }
      })
    } finally {
      charge.close()
    }
  }
}
