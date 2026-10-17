import { createHash } from 'node:crypto'
import type { Knex } from 'knex'
import type { KnexBrc38StagingStore } from './KnexBrc38StagingStore'
import { verifyBrc38AuthenticatedSourceSeal } from './Brc38AuthenticatedSourceSealNode'
import { readBrc38ImportJournal, type Brc38ImportJournalAdmission } from './Brc38ImportJournal'
import { verifyBrc38ImportJournalSchema } from './Brc38ImportJournalSchema'
import { verifyBrc38ImportProvenanceSchema } from './Brc38ImportProvenanceNode'
import { verifyBrc38ImportStreamedProvenanceSchema } from './Brc38ImportStreamedProvenanceNode'
import { verifyBrc38ImportStructuredProvenanceSchema } from './Brc38ImportStructuredProvenanceNode'
import { readBrc38PrivateMergeRecovery } from './Brc38PrivateMergeRecoverySchemaNode'
import { readBrc38PrivateMergeProgram, assertBrc38PrivateMergeProgramBudget } from './Brc38PrivateMergeProgramNode'
import { brc38ImportTableOrder, brc38ImportRowForm } from './Brc38ImportForms'
import { brc38ImportIncomingId, loadBrc38ImportIdMap } from './Brc38ImportIdMap'
import { brc38PrivatePageIdForms } from './Brc38PrivatePageIdsNode'
import { readBrc38SqlBinaryDescriptors } from './Brc38SqlBinaryStaging'
import { readBrc38SqlStructuredDescriptors } from './Brc38SqlStructuredStaging'
import { readBrc38SqlTextDescriptors } from './Brc38SqlTextStaging'
import { canonicalPortableChunks } from './CanonicalPortableChunks'
import { brc38WorkingAllocation, type Brc38WorkingAllocation } from './Brc38WorkingAllocation'
import type { Brc38StageTable } from './Brc38SemanticStage'
import {
  hasBrc38PrivateMergeTargets,
  inspectBrc38PrivateMergeTarget,
  brc38PrivateMergeTargetsTable,
  brc38PrivateMergeTargetsBudgetTable
} from './Brc38PrivateMergeTargetsNode'
import {
  inspectBrc38PrivateMergePages,
  brc38PrivateMergePagesTable,
  brc38PrivateMergePagesBudgetTable
} from './Brc38PrivateMergePagesNode'

const originals = 'brc38_import_structured_original',
  budgets = 'brc38_import_structured_original_budget'
function invalid(): never {
  throw new Error(
    'Private merge recovery graph differs from its actual journals, mappings, original envelopes or charges'
  )
}
function integer(value: unknown, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > maximum) invalid()
  return value
}
async function count(k: Knex.Transaction, table: string, where?: object): Promise<number> {
  const query = k(table)
  if (where !== undefined) query.where(where)
  const row = (await query.count({ count: '*' }).first()) as { count: unknown } | undefined
  return integer(row?.count)
}
/** Full recovery-DATA graph inspection on the actual private query-only lease.
 * Every retained journal has an exact committed original prefix and ID set;
 * stored original JSON is compared byte-for-byte with the actual authenticated
 * header/envelopes, not accepted by a stored hash. Inactive episode mappings
 * are historical DATA and need not name surviving current rows. This is one
 * component of the composed inventory, never its semantic/cutover verdict. */
export async function inspectBrc38PrivateMergeHistory(
  store: KnexBrc38StagingStore,
  k: Knex.Transaction,
  selected: Readonly<{
    admission: Brc38ImportJournalAdmission
    workingAllocation: Brc38WorkingAllocation
    maximumReadBytes: number
    signal?: AbortSignal
  }>
): Promise<
  Readonly<{ journals: number; originals: number; mappedIds: number; originalLogicalBytes: number; pages: number }>
> {
  const working = brc38WorkingAllocation(selected.workingAllocation),
    width = selected.maximumReadBytes,
    signal = selected.signal,
    binding = store.binding,
    admission = Object.freeze({ ...selected.admission, scope: Object.freeze({ ...selected.admission.scope }) }),
    deadline = performance.now() + Math.max(0, store.operationExpiresAt - Date.now())
  if (
    working === undefined ||
    working.maximum > store.limits.maximumRowAllocationBytes ||
    binding === undefined ||
    !Number.isSafeInteger(width) ||
    width < 1 ||
    width > 16384 ||
    admission.scope.bindingSha256 !== binding.digest ||
    admission.originalLimitsJson !== binding.limitsJson ||
    admission.expiresAt !== store.limits.expiresAt
  )
    invalid()
  const frame = working.claim(2097152),
    check = (): void => {
      signal?.throwIfAborted()
      if (store.binding !== binding || Date.now() >= store.operationExpiresAt || performance.now() >= deadline)
        invalid()
      store.assertPrivateNativeReadTransaction(k)
    }
  let totalOriginals = 0,
    totalMapped = 0,
    totalBytes = 0,
    totalBudgets = 0,
    totalTargets = 0,
    totalPages = 0
  try {
    check()
    await verifyBrc38AuthenticatedSourceSeal(k)
    await verifyBrc38ImportJournalSchema(k)
    await verifyBrc38ImportProvenanceSchema(k)
    await verifyBrc38ImportStreamedProvenanceSchema(k)
    await verifyBrc38ImportStructuredProvenanceSchema(k)
    if (!(await hasBrc38PrivateMergeTargets(k))) invalid()
    const program = await readBrc38PrivateMergeProgram(k),
      recovery = await readBrc38PrivateMergeRecovery(k)
    if (
      program === undefined ||
      recovery?.phase !== 'IMPORT' ||
      recovery.activeImportId !== admission.scope.importId ||
      recovery.bindingSha256 !== binding.digest ||
      recovery.sourceSha256 !== program.sourceSha256
    )
      invalid()
    await assertBrc38PrivateMergeProgramBudget(k, admission)
    const profile = await k('users')
      .where({ userId: admission.scope.userId, identityKey: binding.binding.identityKey })
      .select('userId')
      .limit(2)
    if (profile.length !== 1 || (await count(k, 'users')) !== 1) invalid()
    const settings = await k('settings')
      .where({ chain: binding.binding.chain, storageIdentityKey: binding.binding.targetStorageIdentityKey })
      .select('chain')
      .limit(2)
    if (settings.length !== 1 || (await count(k, 'settings')) !== 1) invalid()
    const counts = new Map<Brc38StageTable, number>()
    let archiveRows = 0
    for (const table of brc38ImportTableOrder) {
      const rows = (await k('table_counts').where({ tableName: table }).select('rows').limit(2)) as Array<{
        rows: unknown
      }>
      if (rows.length !== 1) invalid()
      const amount = integer(rows[0].rows, store.limits.maximumRows)
      if ((await count(k, 'rows', { tableName: table })) !== amount) invalid()
      counts.set(table, amount)
      archiveRows += amount
    }
    if (
      !Number.isSafeInteger(archiveRows) ||
      archiveRows > store.limits.maximumRows ||
      archiveRows + 1 !== admission.totalRows ||
      (await count(k, 'table_counts')) !== brc38ImportTableOrder.length ||
      (await count(k, 'rows')) !== archiveRows
    )
      invalid()
    const journals = (await k('brc38_import_journal')
      .select(
        'importId',
        k.raw('CASE WHEN length(CAST(admissionJson AS BLOB)) BETWEEN 1 AND 4096 THEN admissionJson END AS json')
      )
      .orderBy('importId')
      .limit(5)) as Array<{ importId: string; json: string | null }>
    if (journals.length < 1 || journals.length > 4 || !journals.some(row => row.importId === admission.scope.importId))
      invalid()
    for (const stored of journals) {
      check()
      if (typeof stored.json !== 'string') invalid()
      const input = JSON.parse(stored.json) as Brc38ImportJournalAdmission
      if (
        input.scope.importId !== stored.importId ||
        input.scope.bindingSha256 !== binding.digest ||
        input.scope.archiveSha256 !== binding.binding.archiveSha256 ||
        input.scope.userId !== admission.scope.userId ||
        input.originalLimitsJson !== binding.limitsJson ||
        input.expiresAt !== store.limits.expiresAt ||
        input.totalRows !== admission.totalRows ||
        input.maximumStepRows !== admission.maximumStepRows ||
        input.maximumStepBytes !== admission.maximumStepBytes ||
        input.maximumMappedIds !== admission.maximumMappedIds ||
        input.maximumJournalLogicalBytes !== admission.maximumJournalLogicalBytes
      )
        invalid()
      const receipt = await readBrc38ImportJournal(k, input, working),
        active = stored.importId === admission.scope.importId
      if (
        receipt.state === 'EXPIRED' ||
        (active && (receipt.state !== 'COMPLETE' || receipt.nextRow !== input.totalRows))
      )
        invalid()
      const pageHistory = await inspectBrc38PrivateMergePages(store, k, input, { workingAllocation: working, signal })
      totalPages += pageHistory.pages
      if (!Number.isSafeInteger(totalPages)) invalid()
      const prefix = integer(receipt.nextRow, input.totalRows)
      if (
        (await count(k, originals, input.scope)) !== prefix ||
        (await count(k, 'brc38_import_ids', input.scope)) !== receipt.mappedIds
      )
        invalid()
      let bytes = 0,
        mapped = 0,
        targets = 0
      const metadata = async (sourceRow: number, tableName: string) => {
          const rows = (await k(originals)
            .where({ ...input.scope, sourceRow })
            .select(
              'tableName',
              'logicalBytes',
              k.raw("CASE WHEN typeof(originalJson)='text' THEN length(CAST(originalJson AS BLOB)) END AS bytes"),
              k.raw('CASE WHEN length(CAST(sha256 AS BLOB))=64 THEN sha256 END AS sha256')
            )
            .limit(2)) as Array<{ tableName: string; logicalBytes: unknown; bytes: unknown; sha256: string | null }>
          if (
            rows.length !== 1 ||
            rows[0].tableName !== tableName ||
            typeof rows[0].sha256 !== 'string' ||
            !/^[0-9a-f]{64}$/.test(rows[0].sha256)
          )
            invalid()
          const extent = integer(rows[0].bytes, 16777216)
          if (extent < 1 || rows[0].logicalBytes !== 512 + extent) invalid()
          return { bytes: extent, sha256: rows[0].sha256 }
        },
        read = async (sourceRow: number, offset: number, amount: number): Promise<Uint8Array> => {
          check()
          const rows = (await k(originals)
            .where({ ...input.scope, sourceRow })
            .select(k.raw('substr(CAST(originalJson AS BLOB),?,?) AS bytes', [offset + 1, amount]))
            .limit(2)) as Array<{ bytes: Uint8Array }>
          if (rows.length !== 1 || !(rows[0].bytes instanceof Uint8Array) || rows[0].bytes.length !== amount) invalid()
          return rows[0].bytes
        }
      if (prefix > 0) {
        const original = await metadata(0, 'header'),
          header = (await k('metadata')
            .where({ slot: 1 })
            .select(k.raw("CASE WHEN typeof(header)='text' THEN length(CAST(header AS BLOB)) END AS bytes"))
            .limit(2)) as Array<{ bytes: unknown }>
        if (header.length !== 1 || integer(header[0].bytes, store.limits.maximumRowBytes) !== original.bytes) invalid()
        const hash = createHash('sha256')
        for (let offset = 0; offset < original.bytes;) {
          const amount = Math.min(width, original.bytes - offset),
            scratch = working.claim(1048576 + 64 * amount)
          let actual: Uint8Array | undefined, source: Uint8Array | undefined
          try {
            actual = await read(0, offset, amount)
            const values = (await k('metadata')
              .where({ slot: 1 })
              .select(k.raw('substr(CAST(header AS BLOB),?,?) AS bytes', [offset + 1, amount]))
              .limit(2)) as Array<{ bytes: Uint8Array }>
            source = values[0]?.bytes
            if (
              values.length !== 1 ||
              !(source instanceof Uint8Array) ||
              source.length !== amount ||
              !actual.every((value, n) => value === source![n])
            )
              invalid()
            hash.update(actual)
            check()
          } finally {
            actual?.fill(0)
            source?.fill(0)
            scratch.close()
          }
          offset += amount
        }
        if (hash.digest('hex') !== original.sha256) invalid()
        bytes += 512 + original.bytes
      }
      let ordinal = 1
      for (const table of brc38ImportTableOrder) {
        for (let position = 0; position < counts.get(table)! && ordinal < prefix; position++, ordinal++) {
          check()
          const sourceExtent = (await k('rows')
            .where({ tableName: table, position })
            .select(
              'bytes',
              k.raw("CASE WHEN typeof(payload)='text' THEN length(CAST(payload AS BLOB)) END AS actualBytes")
            )
            .limit(2)) as Array<{ bytes: unknown; actualBytes: unknown }>
          if (sourceExtent.length !== 1) invalid()
          const size = integer(sourceExtent[0].bytes, store.limits.maximumRowBytes)
          if (size < 1 || sourceExtent[0].actualBytes !== size) invalid()
          const allocation = working.claim(131072 + 64 * size)
          try {
            const cells = (await k('rows').where({ tableName: table, position }).select('payload').limit(2)) as Array<{
              payload: string
            }>
            if (
              cells.length !== 1 ||
              typeof cells[0].payload !== 'string' ||
              Buffer.byteLength(cells[0].payload) !== size
            )
              invalid()
            const fields = JSON.parse(cells[0].payload) as Record<string, unknown>,
              binaries = await readBrc38SqlBinaryDescriptors(k, table, position),
              structured = (await readBrc38SqlStructuredDescriptors(k, table, position)) ?? {},
              texts = (await readBrc38SqlTextDescriptors(k, table, position)) ?? {},
              envelope = {
                protocol: 'brc38-structured-original/v1',
                table,
                index: position,
                fields,
                binaries,
                structured,
                ...(Object.keys(texts).length === 0 ? {} : { texts })
              },
              original = await metadata(ordinal, table),
              hash = createHash('sha256')
            let offset = 0
            for (const chunk of canonicalPortableChunks(envelope, {
              maximumValueBytes: Math.min(working.maximum, 131072 + 32 * size),
              maximumChunkBytes: Math.max(64, width),
              signal
            })) {
              try {
                for (let within = 0; within < chunk.length;) {
                  const amount = Math.min(width, chunk.length - within),
                    scratch = working.claim(1048576 + 32 * amount)
                  let actual: Uint8Array | undefined
                  try {
                    if (amount > original.bytes - offset) invalid()
                    actual = await read(ordinal, offset, amount)
                    if (!actual.every((value, n) => value === chunk[within + n])) invalid()
                    hash.update(actual)
                    offset += amount
                    within += amount
                    check()
                  } finally {
                    actual?.fill(0)
                    scratch.close()
                  }
                }
              } finally {
                chunk.fill(0)
              }
            }
            if (offset !== original.bytes || hash.digest('hex') !== original.sha256) invalid()
            bytes += 512 + original.bytes
            await inspectBrc38PrivateMergeTarget(k, input, ordinal, table, fields, active)
            if (table !== 'syncStates') targets++
            const form = brc38ImportRowForm(table)
            if (form.entity !== undefined && form.id !== undefined) {
              const incomingId = fields[form.id]
              if (typeof incomingId !== 'number' || !Number.isInteger(incomingId)) invalid()
              const loaded = await loadBrc38ImportIdMap(k, input.scope, [
                  { entity: form.entity, incomingId, required: true }
                ]),
                localId = loaded.map[form.entity].idMap[incomingId]
              if (!Number.isSafeInteger(localId)) invalid()
              // Historical mappings survive a refold without claiming current
              // target membership. Only the active episode requires its rows.
              if (active) {
                const formTable = brc38PrivatePageIdForms[table as keyof typeof brc38PrivatePageIdForms]
                if (formTable === undefined || (await count(k, formTable[0], { [formTable[1]]: localId })) !== 1)
                  invalid()
              }
              brc38ImportIncomingId(incomingId)
              mapped++
            }
          } finally {
            allocation.close()
          }
        }
        if (ordinal >= prefix) break
      }
      if ((prefix > 0 && ordinal !== prefix) || mapped !== receipt.mappedIds) invalid()
      const targetBudget = (await k(brc38PrivateMergeTargetsBudgetTable)
        .where({ importId: input.scope.importId })
        .select('rows')
        .limit(2)) as Array<{ rows: unknown }>
      if (
        targetBudget.length !== 1 ||
        targetBudget[0].rows !== targets ||
        (await count(k, brc38PrivateMergeTargetsTable, { importId: input.scope.importId })) !== targets
      )
        invalid()
      totalTargets += targets
      const originalBudget = (await k(budgets)
        .where(input.scope)
        .select('rows', 'logicalBytes', 'maximumRows', 'maximumLogicalBytes')
        .limit(2)) as Array<{
        rows: unknown
        logicalBytes: unknown
        maximumRows: unknown
        maximumLogicalBytes: unknown
      }>
      if (originalBudget.length > 1 || (prefix > 0 && originalBudget.length !== 1)) invalid()
      if (originalBudget.length === 1) {
        const value = originalBudget[0]
        if (
          value.rows !== prefix ||
          value.logicalBytes !== bytes ||
          value.maximumRows !== input.totalRows ||
          value.maximumLogicalBytes !== store.limits.maximumLogicalBytes
        )
          invalid()
        totalBudgets++
      }
      totalOriginals += prefix
      totalMapped += mapped
      totalBytes += bytes
      if (
        !Number.isSafeInteger(totalOriginals) ||
        !Number.isSafeInteger(totalMapped) ||
        !Number.isSafeInteger(totalBytes) ||
        totalBytes > store.limits.maximumLogicalBytes
      )
        invalid()
    }
    if (
      (await count(k, originals)) !== totalOriginals ||
      (await count(k, budgets)) !== totalBudgets ||
      (await count(k, 'brc38_import_ids')) !== totalMapped ||
      (await count(k, 'brc38_import_original')) !== 0 ||
      (await count(k, 'brc38_import_original_budget')) !== 0 ||
      (await count(k, 'brc38_import_streamed_original')) !== 0 ||
      (await count(k, 'brc38_import_streamed_original_budget')) !== 0
    )
      invalid()
    if (
      (await count(k, brc38PrivateMergeTargetsTable)) !== totalTargets ||
      (await count(k, brc38PrivateMergeTargetsBudgetTable)) !== journals.length
    )
      invalid()
    if (
      (await count(k, brc38PrivateMergePagesTable)) !== totalPages ||
      (await count(k, brc38PrivateMergePagesBudgetTable)) !== journals.length
    )
      invalid()
    const foreign = (await k.raw('SELECT 1 AS differs FROM pragma_foreign_key_check LIMIT 1')) as Array<{
      differs: number
    }>
    if (foreign.length !== 0) invalid()
    check()
    return Object.freeze({
      journals: journals.length,
      originals: totalOriginals,
      mappedIds: totalMapped,
      originalLogicalBytes: totalBytes,
      pages: totalPages
    })
  } finally {
    frame.close()
  }
}
