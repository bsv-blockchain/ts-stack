import { promiseFromSync } from '../../utility/promiseFromSync'
import type { Knex } from 'knex'
import type { StorageKnex } from '../StorageKnex'
import type { KnexBrc38StagingStore, Brc38AuthenticatedStreamedImportReader } from './KnexBrc38StagingStore'
import {
  readBrc38ImportJournal,
  type Brc38ImportJournalAdmission,
  type Brc38ImportJournalReceipt
} from './Brc38ImportJournal'
import { stepCopy } from './Brc38ImportJournalContract'
import { brc38PrivateMergePagesTable, hasBrc38PrivateMergePages } from './Brc38PrivateMergePagesNode'
import { brc38PrivateCheckpointData, brc38PrivateCheckpointMaterializationCursor } from './Brc38PrivateCheckpointData'
import { verifyBrc38AuthenticatedSourceSeal } from './Brc38AuthenticatedSourceSealNode'
import { brc38ImportRowForm, brc38ImportTableOrder } from './Brc38ImportForms'
import { decodePortableRow } from './Brc38PortableRows'
import { loadBrc38ImportIdMap } from './Brc38ImportIdMap'
import type { Brc38CheckpointSyncMapDelta } from './Brc38CheckpointSyncMap'
import { brc38WorkingAllocation, type Brc38WorkingAllocation } from './Brc38WorkingAllocation'
import { chargeBrc38ImportDecodedBudget, type Brc38ImportDecodedBudget } from './Brc38ImportDecodedBudget'

// Reuse the independently exercised reconstruction window. This is a batching
// boundary, not a new import capacity limit: an existing larger page is still
// admitted alone and immediately materialized, up to its original allowance.
const maximumWindow = 128
interface Page {
  fromRow: number
  previousFromRow: number | null
  nextRow: number
  mappedIds: number
  tableName: string
  stepJson: string
  checkpointJson: string | null
}
export interface Brc38PrivateCheckpointWindow {
  readonly incremental: boolean
  readonly materializedNextRow: number
  readonly pendingPages: number
  readonly pendingMappings: number
  readonly maximumPreparedRows: number
  readonly receipt: Readonly<Brc38ImportJournalReceipt>
}
function invalid(): never {
  throw new Error('Private checkpoint window differs from its actual durable page boundary or mappings')
}
function observation(page: Page) {
  if (page.checkpointJson === null || Buffer.byteLength(page.checkpointJson) > 512) invalid()
  const value = brc38PrivateCheckpointData(JSON.parse(page.checkpointJson))
  if (JSON.stringify(value) !== page.checkpointJson) invalid()
  return value
}
const columns = ['fromRow', 'previousFromRow', 'nextRow', 'mappedIds', 'tableName', 'stepJson', 'checkpointJson']
/** DATA read under the actual destination receipt fence. A cursor does not
 * authorize a writer or validate a map. Legacy v1 resume has no pending map;
 * v2 resume always follows its durable cursor, even if the new option is absent. */
export async function readBrc38PrivateCheckpointWindow(
  store: KnexBrc38StagingStore,
  trx: Knex.Transaction,
  admission: Readonly<Brc38ImportJournalAdmission>,
  receipt: Readonly<Brc38ImportJournalReceipt>,
  working: Brc38WorkingAllocation,
  requested: boolean,
  maximumPreparedRows: number
): Promise<Readonly<Brc38PrivateCheckpointWindow>> {
  store.assertPrivateNativeReadTransaction(trx)
  if (
    brc38WorkingAllocation(working) === undefined ||
    typeof requested !== 'boolean' ||
    !Number.isSafeInteger(maximumPreparedRows) ||
    maximumPreparedRows < 1 ||
    maximumPreparedRows > admission.maximumStepRows
  )
    invalid()
  // Only latest/current/base records are reachable, never an array of the
  // whole window. Charge their bounded JSON and parsed observation copies.
  const frame = working.claim(65536)
  try {
    await verifyBrc38AuthenticatedSourceSeal(trx)
    if (
      !(await hasBrc38PrivateMergePages(trx)) ||
      JSON.stringify(await readBrc38ImportJournal(trx, admission)) !== JSON.stringify(receipt)
    )
      invalid()
    const latest = (await trx(brc38PrivateMergePagesTable)
      .where({ importId: admission.scope.importId })
      .orderBy('fromRow', 'desc')
      .select(...columns)
      .limit(1)) as Page[]
    if ((latest.length === 0) !== (receipt.sequence === 0)) invalid()
    let cursor = 0,
      incremental = requested,
      pendingPages = 0,
      pendingMappings = 0
    if (latest.length === 1) {
      const page = latest[0],
        data = observation(page)
      if (
        page.nextRow !== receipt.nextRow ||
        page.mappedIds !== receipt.mappedIds ||
        page.fromRow !== receipt.lastStep?.fromRow ||
        page.stepJson !== JSON.stringify(receipt.lastStep)
      )
        invalid()
      incremental ||= data.protocol === 'brc38-private-checkpoint-data/v2'
      cursor = data.protocol === 'brc38-private-checkpoint-data/v2' ? data.materializedNextRow : page.nextRow
      if (cursor > page.nextRow) invalid()
      let after = cursor,
        previousFromRow: number | null = null,
        mappedBefore = 0
      while (after < receipt.nextRow) {
        const values = (await trx(brc38PrivateMergePagesTable)
          .where({ importId: admission.scope.importId, fromRow: after })
          .select(...columns)
          .limit(2)) as Page[]
        if (values.length !== 1 || ++pendingPages > maximumWindow) invalid()
        const pending = values[0],
          observed = observation(pending),
          step = stepCopy(JSON.parse(pending.stepJson), admission)
        if (
          pending.fromRow !== step.fromRow ||
          pending.nextRow !== step.fromRow + step.rows ||
          pending.nextRow > receipt.nextRow ||
          JSON.stringify(step) !== pending.stepJson ||
          observed.protocol !== 'brc38-private-checkpoint-data/v2' ||
          observed.materializedNextRow !== cursor ||
          observed.mode !== 'UPDATE' ||
          observed.syncStateId !== data.syncStateId
        )
          invalid()
        brc38PrivateCheckpointMaterializationCursor(observed, pending.fromRow, pending.nextRow, cursor)
        if (pendingPages === 1 && cursor > 0) {
          if (pending.previousFromRow === null) invalid()
          const base = (await trx(brc38PrivateMergePagesTable)
            .where({ importId: admission.scope.importId, fromRow: pending.previousFromRow })
            .select(...columns)
            .limit(2)) as Page[]
          if (base.length !== 1 || base[0].nextRow !== cursor) invalid()
          const prior = observation(base[0])
          if (
            prior.syncStateId !== data.syncStateId ||
            (prior.protocol === 'brc38-private-checkpoint-data/v2' && prior.materializedNextRow !== cursor)
          )
            invalid()
          previousFromRow = base[0].fromRow
          mappedBefore = base[0].mappedIds
        }
        if (pending.previousFromRow !== previousFromRow || pending.mappedIds !== mappedBefore + step.mappedIds)
          invalid()
        pendingMappings += step.mappedIds
        if (pendingMappings >= maximumWindow || pendingPages >= maximumWindow) invalid()
        previousFromRow = pending.fromRow
        mappedBefore = pending.mappedIds
        after = pending.nextRow
      }
    }
    if (receipt.state === 'COMPLETE' && cursor !== receipt.nextRow) invalid()
    store.assertPrivateNativeReadTransaction(trx)
    return Object.freeze({
      incremental,
      materializedNextRow: cursor,
      pendingPages,
      pendingMappings,
      maximumPreparedRows:
        pendingPages === 0 ? maximumPreparedRows : Math.min(maximumPreparedRows, maximumWindow - pendingMappings),
      receipt: Object.freeze({
        ...receipt,
        lastStep: receipt.lastStep === null ? null : Object.freeze({ ...receipt.lastStep })
      })
    })
  } finally {
    frame.close()
  }
}

/** Reconstruct a finite producer window from actual authenticated rows and
 * persisted import mappings. No full source map/string or permanent cache is
 * retained. Every read freshly fences the original receipt and source seal;
 * the independent inventory still derives the complete final map separately. */
export async function withBrc38PrivateCheckpointWindowDeltas<T>(
  store: KnexBrc38StagingStore,
  storage: StorageKnex,
  admission: Readonly<Brc38ImportJournalAdmission>,
  reader: Readonly<Brc38AuthenticatedStreamedImportReader>,
  window: Readonly<Brc38PrivateCheckpointWindow>,
  syncStateId: number,
  current: Brc38CheckpointSyncMapDelta,
  working: Brc38WorkingAllocation,
  budget: Brc38ImportDecodedBudget,
  work: (deltas: readonly Brc38CheckpointSyncMapDelta[]) => Promise<T>
): Promise<T> {
  if (storage.toDb() !== store.knex || !window.incremental || !Number.isSafeInteger(syncStateId) || syncStateId < 1)
    invalid()
  const bytes = 8192 + 4096 * (window.pendingPages + 1) + 4096 * window.pendingMappings,
    charge = working.claim(bytes),
    deadline = performance.now() + Math.max(0, admission.expiresAt - Date.now()),
    check = (): void => {
      budget.signal?.throwIfAborted()
      if (Date.now() >= admission.expiresAt || performance.now() >= deadline || storage.toDb() !== store.knex) invalid()
      store.assertPrivateNativeDestination(store.knex)
    },
    read = async <V>(operation: (trx: Knex.Transaction) => Promise<V>): Promise<V> =>
      await store.withPrivateNativeDatabase(
        true,
        async database =>
          await database.transaction(async trx => {
            check()
            store.assertPrivateNativeReadTransaction(trx)
            await verifyBrc38AuthenticatedSourceSeal(trx)
            if (JSON.stringify(await readBrc38ImportJournal(trx, admission)) !== JSON.stringify(window.receipt))
              invalid()
            const value = await operation(trx)
            if (JSON.stringify(await readBrc38ImportJournal(trx, admission)) !== JSON.stringify(window.receipt))
              invalid()
            check()
            return value
          })
      )
  try {
    chargeBrc38ImportDecodedBudget(budget, bytes)
    const deltas: Brc38CheckpointSyncMapDelta[] = [],
      offsets = new Map<string, number>(),
      counts = new Map<string, number>()
    let ordinal = 1
    for (const table of brc38ImportTableOrder) {
      check()
      const count = await reader.count(table)
      if (!Number.isSafeInteger(count) || count < 0) invalid()
      offsets.set(table, ordinal)
      counts.set(table, count)
      ordinal += count
      if (!Number.isSafeInteger(ordinal) || ordinal > admission.totalRows) invalid()
    }
    if (ordinal !== admission.totalRows) invalid()
    let fromRow = window.materializedNextRow,
      maps = 0
    while (fromRow < window.receipt.nextRow) {
      const pages = await read(
        async trx =>
          (await trx(brc38PrivateMergePagesTable)
            .where({ importId: admission.scope.importId, fromRow })
            .select(...columns)
            .limit(2)) as Page[]
      )
      if (pages.length !== 1 || deltas.length >= window.pendingPages) invalid()
      const page = pages[0],
        data = observation(page),
        step = stepCopy(JSON.parse(page.stepJson), admission)
      if (
        data.syncStateId !== syncStateId ||
        data.protocol !== 'brc38-private-checkpoint-data/v2' ||
        data.materializedNextRow !== window.materializedNextRow ||
        data.mode !== 'UPDATE' ||
        page.nextRow !== fromRow + step.rows
      )
        invalid()
      const table =
        fromRow === 0
          ? undefined
          : brc38ImportTableOrder.find(
              name => fromRow >= offsets.get(name)! && fromRow < offsets.get(name)! + counts.get(name)!
            )
      if (page.tableName !== (table ?? 'header') || (fromRow !== 0 && table === undefined) || table === 'syncStates')
        invalid()
      const form = table === undefined ? undefined : brc38ImportRowForm(table),
        entity =
          form?.entity ??
          (table === 'txLabelMaps'
            ? 'txLabelMap'
            : table === 'outputTagMaps'
              ? 'outputTagMap'
              : table === 'certificateFields'
                ? 'certificateField'
                : undefined),
        mappings: Array<Readonly<{ incomingId: number; localId: number }>> = []
      let maximumUpdatedAt: Date | undefined
      if (table !== undefined) {
        const position = fromRow - offsets.get(table)!
        if (position + step.rows > counts.get(table)!) invalid()
        for (let index = position; index < position + step.rows; index++) {
          const size = (await read(
            async trx =>
              await trx('rows')
                .where({ tableName: table, position: index })
                .first('bytes', trx.raw('length(CAST(payload AS BLOB)) AS actualBytes'))
          )) as { bytes: number; actualBytes: number } | undefined
          if (
            size === undefined ||
            !Number.isSafeInteger(size.bytes) ||
            size.bytes < 1 ||
            size.bytes > store.limits.maximumRowBytes ||
            size.actualBytes !== size.bytes
          )
            invalid()
          const rowCharge = working.claim(131072 + 64 * size.bytes)
          try {
            check()
            const row = await reader.row(table, index)
            if (row === undefined) invalid()
            const incoming = decodePortableRow<Record<string, unknown>>(form!.kind, row.fields)
            if (entity !== undefined) {
              const updated = incoming.updated_at
              if (!(updated instanceof Date) || !Number.isFinite(updated.getTime())) invalid()
              if (maximumUpdatedAt === undefined || updated > maximumUpdatedAt)
                maximumUpdatedAt = new Date(updated.getTime())
            }
            if (form!.entity !== undefined) {
              const incomingId = incoming[form!.id!]
              if (typeof incomingId !== 'number' || !Number.isInteger(incomingId)) invalid()
              const localId = await read(
                async trx =>
                  (
                    await loadBrc38ImportIdMap(trx, admission.scope, [
                      { entity: form!.entity!, incomingId, required: true }
                    ])
                  ).map[form!.entity!].idMap[incomingId]
              )
              if (!Number.isSafeInteger(localId) || localId < 1) invalid()
              mappings.push(Object.freeze({ incomingId, localId }))
            }
          } finally {
            rowCharge.close()
          }
        }
      }
      if (step.mappedIds !== mappings.length || maps + mappings.length > window.pendingMappings) invalid()
      maps += mappings.length
      deltas.push(
        Object.freeze({
          entity,
          count: entity === undefined ? 0 : step.rows,
          mappings: Object.freeze(mappings),
          maximumUpdatedAt,
          done: false
        })
      )
      fromRow = page.nextRow
    }
    if (deltas.length !== window.pendingPages || maps !== window.pendingMappings) invalid()
    deltas.push(current)
    if (deltas.length > maximumWindow || maps + current.mappings.length > 4000) invalid()
    await read(() => promiseFromSync(() => undefined))
    return await work(Object.freeze(deltas))
  } finally {
    charge.close()
  }
}
