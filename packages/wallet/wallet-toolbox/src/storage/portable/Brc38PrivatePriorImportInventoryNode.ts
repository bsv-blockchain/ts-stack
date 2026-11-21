import { promiseFromSync } from '../../utility/promiseFromSync'
import { createHash } from 'node:crypto'
import type { Knex } from 'knex'
import type { KnexBrc38StagingStore } from './KnexBrc38StagingStore'
import {
  Brc38NativeLocalBaselineSource,
  type Brc38NativePriorImportRow,
  type Brc38NativeRetainedPriorImportRow
} from './Brc38NativeLocalBaselineSourceNode'
import { brc38NativePriorImportTables } from './Brc38NativePriorImportTables'
import {
  brc38PrivatePriorImportBudget as budget,
  brc38PrivatePriorImportRows as rows,
  brc38PrivatePriorImportChunks as chunks,
  hasBrc38PrivatePriorImportSchema
} from './Brc38PrivatePriorImportSchemaNode'
import { encodeBrc38PrivatePriorMetadata } from './Brc38PrivatePriorImportNode'
import { brc38WorkingAllocation, type Brc38WorkingAllocation } from './Brc38WorkingAllocation'
import { verifyBrc38AuthenticatedSourceSeal } from './Brc38AuthenticatedSourceSealNode'
import { readBrc38PrivateLocalCandidateJournal } from './Brc38PrivateLocalCandidateJournalNode'

function invalid(): never {
  throw new Error('Private prior-import inventory differs from complete original and retained source data')
}
const hash = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex')
/** Compare complete typed metadata, actual payload bytes, keysets and counters.
 * This is an inventory operation inside the issued candidate's RECOVERY fence;
 * it provides no new receipt, semantic, READY or current-primary authority. */
export async function inspectBrc38PrivatePriorImports(
  store: KnexBrc38StagingStore,
  source: Brc38NativeLocalBaselineSource,
  k: Knex.Transaction,
  selected: Readonly<{
    sourceSha256: string
    maximumRows: number
    maximumReadBytes: number
    expiresAt: number
    workingAllocation: Brc38WorkingAllocation
    signal?: AbortSignal
  }>
): Promise<Readonly<{ records: number; logicalBytes: number; chunks: number }>> {
  const policy = Object.freeze({ ...selected }),
    working = brc38WorkingAllocation(policy.workingAllocation),
    deadline = performance.now() + Math.max(0, policy.expiresAt - Date.now())
  if (
    working === undefined ||
    working.maximum > store.limits.maximumRowAllocationBytes ||
    policy.expiresAt !== store.operationExpiresAt ||
    !Number.isSafeInteger(policy.maximumRows) ||
    policy.maximumRows < 1 ||
    policy.maximumRows > 10000000 ||
    !Number.isSafeInteger(policy.maximumReadBytes) ||
    policy.maximumReadBytes < 1 ||
    policy.maximumReadBytes > 16384
  )
    invalid()
  const check = (): void => {
      policy.signal?.throwIfAborted()
      if (Date.now() >= policy.expiresAt || performance.now() >= deadline) invalid()
      store.assertPrivateNativeReadTransaction(k)
      Brc38NativeLocalBaselineSource.assertSharedWorking(source, working)
    },
    frame = working.claim(1048576)
  let records = 0,
    logicalBytes = 0,
    chunkCount = 0
  try {
    check()
    await verifyBrc38AuthenticatedSourceSeal(k)
    if (!(await hasBrc38PrivatePriorImportSchema(k))) invalid()
    const lineage = await Brc38NativeLocalBaselineSource.ownedPriorImportLineage(source),
      journal = await readBrc38PrivateLocalCandidateJournal(k),
      values = (await k(budget)
        .where({ slot: 1 })
        .select(
          'bindingSha256',
          'sourceSha256',
          'sourceLineageSha256',
          'maximumRows',
          'maximumLogicalBytes',
          'copyTable',
          'afterRowId',
          'records',
          'logicalBytes'
        )
        .limit(2)) as Array<{
        bindingSha256: string
        sourceSha256: string
        sourceLineageSha256: string
        maximumRows: number
        maximumLogicalBytes: number
        copyTable: number
        afterRowId: number | null
        records: number
        logicalBytes: number
      }>
    if (values.length !== 1) invalid()
    const before = values[0]
    if (
      journal.phase !== 'RECOVERY' ||
      journal.sourceSha256 !== policy.sourceSha256 ||
      journal.maximumRows !== policy.maximumRows ||
      before.bindingSha256 !== store.binding?.digest ||
      before.sourceSha256 !== policy.sourceSha256 ||
      before.sourceLineageSha256 !== lineage ||
      before.maximumRows !== policy.maximumRows ||
      before.maximumLogicalBytes !== store.limits.maximumLogicalBytes ||
      before.copyTable !== brc38NativePriorImportTables.length + 1 ||
      before.afterRowId !== null
    )
      invalid()
    const compare = async (
      actual: Readonly<Brc38NativePriorImportRow> | Readonly<Brc38NativeRetainedPriorImportRow>,
      tableId: number
    ): Promise<void> => {
      check()
      if (++records > policy.maximumRows) invalid()
      const original = 'metadata' in actual,
        metadata = original
          ? encodeBrc38PrivatePriorMetadata(actual.metadata, working)
          : { json: actual.metadataJson, close: () => undefined },
        key = original
          ? { sourceLineageSha256: lineage, tableId, sourceRowId: actual.rowId }
          : {
              sourceLineageSha256: actual.sourceLineageSha256,
              tableId: actual.tableId,
              sourceRowId: actual.sourceRowId
            },
        metadataBytes = Buffer.byteLength(metadata.json)
      let allocation: ReturnType<Brc38WorkingAllocation['claim']> | undefined
      try {
        allocation = working.claim(1048576 + 32 * metadataBytes)
        const extents = (await k(rows)
          .where(key)
          .select(k.raw('length(CAST(metadataJson AS BLOB)) AS bytes'))
          .limit(2)) as Array<{ bytes: number }>
        if (extents.length !== 1 || extents[0].bytes !== metadataBytes) invalid()
        const values = (await k(rows)
          .where(key)
          .select('metadataJson', 'metadataSha256', 'fieldKind', 'bytes', 'sha256', 'accepted', 'chunks', 'state')
          .limit(2)) as Array<{
          metadataJson: string
          metadataSha256: string
          fieldKind: string
          bytes: number
          sha256: string | null
          accepted: number
          chunks: number
          state: string
        }>
        if (values.length !== 1) invalid()
        const value = values[0],
          size = actual.field?.bytes ?? 0
        if (
          value.metadataJson !== metadata.json ||
          value.metadataSha256 !== hash(metadata.json) ||
          value.state !== 'SEALED' ||
          value.fieldKind !== (actual.field?.kind ?? 'none') ||
          value.bytes !== size ||
          value.accepted !== size ||
          !Number.isSafeInteger(value.chunks) ||
          value.chunks < 0 ||
          value.chunks > size
        )
          invalid()
        const full = createHash('sha256')
        let offset = 0,
          count = 0
        while (offset < size) {
          check()
          const cells = (await k(chunks)
            .where({ ...key, offset })
            .select('bytes', 'payload', 'sha256')
            .limit(2)) as Array<{ bytes: number; payload: Uint8Array; sha256: string }>
          try {
            if (
              cells.length !== 1 ||
              !Number.isSafeInteger(cells[0].bytes) ||
              cells[0].bytes < 1 ||
              cells[0].bytes > policy.maximumReadBytes ||
              !(cells[0].payload instanceof Uint8Array) ||
              cells[0].payload.byteLength !== cells[0].bytes ||
              cells[0].bytes > size - offset ||
              hash(cells[0].payload) !== cells[0].sha256
            )
              invalid()
            const cell = cells[0]
            await actual.withFieldExtent(offset, cell.bytes, originalBytes => {
              return promiseFromSync(() => {
                check()
                if (
                  originalBytes.byteLength !== cell.payload.byteLength ||
                  !originalBytes.every((byte, at) => byte === cell.payload[at])
                )
                  invalid()
              })
            })
            full.update(cell.payload)
            offset += cell.bytes
            count++
          } finally {
            for (const cell of cells) cell.payload?.fill(0)
          }
        }
        const all = (await k(chunks).where(key).count({ count: '*' }).first()) as { count: number } | undefined,
          expectedDigest = actual.field === undefined ? null : original ? actual.metadata.sha256 : actual.field.sha256
        if (
          count !== value.chunks ||
          all?.count !== count ||
          value.sha256 !== expectedDigest ||
          (size > 0 && full.digest('hex') !== value.sha256)
        )
          invalid()
        chunkCount += count
        logicalBytes += 512 + Buffer.byteLength(metadata.json) + size + 512 * count
        if (
          !Number.isSafeInteger(logicalBytes) ||
          logicalBytes > before.maximumLogicalBytes ||
          !Number.isSafeInteger(chunkCount)
        )
          invalid()
      } finally {
        metadata.close()
        allocation?.close()
      }
    }
    for (let tableId = 0; tableId < brc38NativePriorImportTables.length; tableId++) {
      const table = brc38NativePriorImportTables[tableId]
      let after: number | null = null
      for (;;) {
        check()
        const page = await Brc38NativeLocalBaselineSource.ownedPriorImportPage(source, table, after, 1)
        if (page.rows.length === 0) break
        await Brc38NativeLocalBaselineSource.withOwnedPriorImportRow(
          source,
          table,
          page.rows[0],
          async row => await compare(row, tableId)
        )
        after = page.rows[0]
      }
    }
    let after: number | null = null
    for (;;) {
      check()
      const page = await Brc38NativeLocalBaselineSource.ownedRetainedPriorImportPage(source, after)
      if (page.length === 0) break
      await Brc38NativeLocalBaselineSource.withOwnedRetainedPriorImportRow(
        source,
        page[0],
        async row => await compare(row, row.tableId)
      )
      after = page[0]
    }
    const allRows = (await k(rows).count({ count: '*' }).first()) as { count: number } | undefined,
      allChunks = (await k(chunks).count({ count: '*' }).first()) as { count: number } | undefined,
      counters = (await k(budget).where({ slot: 1 }).select('records', 'logicalBytes').limit(2)) as Array<{
        records: number
        logicalBytes: number
      }>
    if (
      allRows?.count !== records ||
      allChunks?.count !== chunkCount ||
      counters.length !== 1 ||
      counters[0].records !== records ||
      counters[0].logicalBytes !== logicalBytes ||
      before.records !== records ||
      before.logicalBytes !== logicalBytes ||
      records + journal.records > policy.maximumRows ||
      JSON.stringify(await readBrc38PrivateLocalCandidateJournal(k)) !== JSON.stringify(journal)
    )
      invalid()
    check()
    return Object.freeze({ records, logicalBytes, chunks: chunkCount })
  } finally {
    frame.close()
  }
}
