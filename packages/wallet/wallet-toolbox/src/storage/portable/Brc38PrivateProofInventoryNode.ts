import type { Knex } from 'knex'
import type { KnexBrc38StagingStore } from './KnexBrc38StagingStore'
import { readBrc38ImportJournal, type Brc38ImportJournalAdmission } from './Brc38ImportJournal'
import { readBrc38PrivateMergeRecovery } from './Brc38PrivateMergeRecoverySchemaNode'
import { Brc38NativeLocalBaselineSource } from './Brc38NativeLocalBaselineSourceNode'
import { brc38ImportTableOrder } from './Brc38ImportForms'
import { nextBrc38PrivateMergeTargetAlias, brc38PrivateMergeTargetsTable } from './Brc38PrivateMergeTargetsNode'
import { brc38PrivateMergePagesTable, inspectBrc38PrivateMergePages } from './Brc38PrivateMergePagesNode'
import { loadBrc38ImportIdMap } from './Brc38ImportIdMap'
import { decodePortableRow, type PortableRow } from './Brc38PortableRows'
import { readBrc38SqlBinaryDescriptors } from './Brc38SqlBinaryStaging'
import {
  equalBrc38PrivateProofOriginalFields,
  type Brc38PrivateProofOriginalField
} from './Brc38PrivateProofOriginalFieldsNode'
import { inspectBrc38PrivateSelectedField } from './Brc38PrivateSelectedFieldInventoryNode'
import { brc38WorkingAllocation, type Brc38WorkingAllocation, type Brc38WorkingCharge } from './Brc38WorkingAllocation'
import { verifyBrc38AuthenticatedSourceSeal } from './Brc38AuthenticatedSourceSealNode'

type Field = Brc38PrivateProofOriginalField
type Model = Readonly<{ metadata: Readonly<Record<string, unknown>>; rawTx: Field; merklePath: Field }>
export interface Brc38PrivateProofInventory {
  readonly rows: number
  readonly aliases: number
  readonly logicalBytes: string
  readonly cacheInvalidations: number
  readonly cacheUpdatedAt: string | null
}
function invalid(): never {
  throw new Error(
    'Private proof inventory differs from original ordered proof policies, complete bytes or cache effects'
  )
}
function integer(value: unknown, nonnegative = false): number {
  const n = typeof value === 'bigint' ? Number(value) : value
  if (
    typeof n !== 'number' ||
    !Number.isSafeInteger(n) ||
    (typeof value === 'bigint' && BigInt(n) !== value) ||
    (nonnegative && n < 0)
  )
    invalid()
  return n
}
function spelling(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/i.test(value)) invalid()
  return value
}
function hash(value: unknown): string {
  return spelling(value).toLowerCase()
}
function date(value: unknown): string {
  if (!(value instanceof Date) && typeof value !== 'string' && typeof value !== 'number') invalid()
  const n = value instanceof Date ? value.getTime() : new Date(value).getTime()
  if (!Number.isFinite(n)) invalid()
  return new Date(n).toISOString()
}
function sameMetadata(left: Model, right: Model): boolean {
  return (
    ['txid', 'blockHash', 'merkleRoot'].every(name => hash(left.metadata[name]) === hash(right.metadata[name])) &&
    ['height', 'index'].every(name => integer(left.metadata[name], true) === integer(right.metadata[name], true))
  )
}
/** Full current proof reconstruction. Stored per-alias effect bits are checked
 * against independent original metadata/full-byte comparisons before they can
 * participate in the page-level cache accounting in this SAME actual read
 * view. Nothing here issues a READY or current-primary activation grant. */
export async function inspectBrc38PrivateProofInventory(
  store: KnexBrc38StagingStore,
  source: Brc38NativeLocalBaselineSource,
  k: Knex.Transaction,
  selected: Readonly<{
    admission: Brc38ImportJournalAdmission
    maximumRows: number
    maximumReadBytes: number
    workingAllocation: Brc38WorkingAllocation
    signal?: AbortSignal
  }>
): Promise<Readonly<Brc38PrivateProofInventory>> {
  const working = brc38WorkingAllocation(selected.workingAllocation),
    admission = selected.admission,
    binding = store.binding,
    maximumRows = integer(selected.maximumRows, true),
    width = selected.maximumReadBytes,
    signal = selected.signal,
    deadline = performance.now() + Math.max(0, store.operationExpiresAt - Date.now())
  if (
    working === undefined ||
    binding === undefined ||
    working.maximum > store.limits.maximumRowAllocationBytes ||
    maximumRows < 1 ||
    maximumRows > 10000000 ||
    !Number.isSafeInteger(width) ||
    width < 1 ||
    width > 16384 ||
    admission.expiresAt !== store.limits.expiresAt ||
    admission.originalLimitsJson !== binding.limitsJson ||
    admission.scope.bindingSha256 !== binding.digest ||
    admission.scope.archiveSha256 !== binding.binding.archiveSha256
  )
    invalid()
  const frame = working.claim(2097152),
    check = (): void => {
      signal?.throwIfAborted()
      if (store.binding !== binding || Date.now() >= store.operationExpiresAt || performance.now() >= deadline)
        invalid()
      store.assertPrivateNativeReadTransaction(k)
      Brc38NativeLocalBaselineSource.assertSharedWorking(source, working)
    }
  let rows = 0,
    aliases = 0,
    logicalBytes = 0n,
    cacheInvalidations = 0,
    cacheUpdatedAt: string | null = null
  try {
    check()
    await verifyBrc38AuthenticatedSourceSeal(k)
    const recovery = await readBrc38PrivateMergeRecovery(k),
      receipt = await readBrc38ImportJournal(k, admission, working)
    if (
      recovery?.phase !== 'IMPORT' ||
      recovery.activeImportId !== admission.scope.importId ||
      recovery.bindingSha256 !== binding.digest ||
      receipt.state !== 'COMPLETE' ||
      receipt.nextRow !== admission.totalRows
    )
      invalid()
    await inspectBrc38PrivateMergePages(store, k, admission, { workingAllocation: working, signal })
    let offset = 1,
      proofOffset = 0,
      proofCount = 0
    for (const name of brc38ImportTableOrder) {
      const counts = (await k('table_counts').where({ tableName: name }).select('rows').limit(2)) as Array<{
        rows: unknown
      }>
      if (counts.length !== 1) invalid()
      const count = integer(counts[0].rows, true)
      if (count > store.limits.maximumRows) invalid()
      if (name === 'provenTxs') {
        proofOffset = offset
        proofCount = count
      }
      offset += count
      if (!Number.isSafeInteger(offset) || offset > admission.totalRows) invalid()
    }
    if (offset !== admission.totalRows || proofOffset < 1) invalid()
    let afterSource: number | null = null,
      afterActual: number | null = null
    for (;;) {
      check()
      const sourceKeys = await Brc38NativeLocalBaselineSource.ownedPage(source, 'proven_txs', afterSource, 1),
        query = k('proven_txs').select(k.raw('rowid AS physical')).orderBy('rowid').limit(1)
      if (afterActual !== null) query.whereRaw('rowid > CAST(? AS INTEGER)', [BigInt(afterActual).toString()])
      const keys = (await query.options({ safeIntegers: true })) as Array<{ physical: bigint }>
      if (keys.length === 0) {
        if (sourceKeys.length !== 0) invalid()
        break
      }
      const physical = keys[0].physical,
        rowId = integer(physical)
      if (
        typeof physical !== 'bigint' ||
        sourceKeys.length > 1 ||
        (sourceKeys.length === 1 && sourceKeys[0] < rowId) ||
        ++rows > maximumRows
      )
        invalid()
      const baseline = sourceKeys.length === 1 && sourceKeys[0] === rowId
      let current: Model | undefined, retained: Brc38WorkingCharge | undefined
      try {
        if (baseline)
          current = await Brc38NativeLocalBaselineSource.withOwnedRow(source, 'proven_txs', rowId, async row => {
            check()
            const bytes = Object.values(row.metadata).reduce<number>(
              (n, value) => n + (typeof value === 'string' ? Buffer.byteLength(value) : 16),
              0
            )
            if (
              !Number.isSafeInteger(bytes) ||
              bytes > 131072 ||
              row.fields.length !== 2 ||
              Object.values(row.metadata).some(
                value => value !== null && !['string', 'number', 'bigint'].includes(typeof value)
              )
            )
              invalid()
            retained = working.claim(131072 + 32 * bytes)
            const field = (name: string): Field => {
              const item = row.fields.find(value => value.field === name)
              if (item?.kind !== 'blob' || item.bytes === null || item.bytes < 1) invalid()
              return Object.freeze({ origin: 'local', sourceRowId: row.rowId, bytes: item.bytes })
            }
            return Object.freeze({
              metadata: Object.freeze({ ...row.metadata }),
              rawTx: field('rawTx'),
              merklePath: field('merklePath')
            })
          })
        let afterAlias = 0,
          touched = false
        for (;;) {
          check()
          const next = await nextBrc38PrivateMergeTargetAlias(k, admission, 'provenTxs', rowId, afterAlias)
          if (next === undefined) break
          const position = next - proofOffset
          if (position < 0 || position >= proofCount || ++aliases > store.limits.maximumRows) invalid()
          const extents = (await k('rows')
            .where({ tableName: 'provenTxs', position })
            .select(
              'bytes',
              k.raw("CASE WHEN typeof(payload)='text' THEN length(CAST(payload AS BLOB)) END AS actualBytes")
            )
            .limit(2)) as Array<{ bytes: unknown; actualBytes: unknown }>
          if (extents.length !== 1) invalid()
          const bytes = integer(extents[0].bytes, true)
          if (bytes < 1 || bytes > store.limits.maximumRowBytes || extents[0].actualBytes !== bytes) invalid()
          const allocation = working.claim(131072 + 64 * bytes)
          let keep = false
          try {
            const cells = (await k('rows')
              .where({ tableName: 'provenTxs', position })
              .select('payload')
              .limit(2)) as Array<{ payload: string }>
            if (
              cells.length !== 1 ||
              typeof cells[0].payload !== 'string' ||
              Buffer.byteLength(cells[0].payload) !== bytes
            )
              invalid()
            const data = decodePortableRow<Record<string, unknown>>(
                'provenTx',
                JSON.parse(cells[0].payload) as PortableRow
              ),
              descriptors = await readBrc38SqlBinaryDescriptors(k, 'provenTxs', position),
              incomingId = integer(data.provenTxId),
              mapped = await loadBrc38ImportIdMap(k, admission.scope, [
                { entity: 'provenTx', incomingId, required: true }
              ])
            if (integer(mapped.map.provenTx.idMap[incomingId]) !== rowId) invalid()
            const field = (name: string): Field => {
                const descriptor = descriptors[name]
                if (descriptor === undefined || integer(descriptor.bytes, true) < 1) invalid()
                return Object.freeze({ origin: 'incoming', sourcePosition: position, bytes: descriptor.bytes })
              },
              incoming: Model = Object.freeze({
                metadata: Object.freeze({
                  provenTxId: BigInt(rowId),
                  created_at: date(data.created_at),
                  updated_at: date(data.updated_at),
                  txid: spelling(data.txid),
                  height: BigInt(integer(data.height, true)),
                  index: BigInt(integer(data.index, true)),
                  blockHash: hash(data.blockHash),
                  merkleRoot: hash(data.merkleRoot)
                }),
                rawTx: field('rawTx'),
                merklePath: field('merklePath')
              })
            let identical = current !== undefined && sameMetadata(current, incoming)
            for (const name of ['rawTx', 'merklePath'] as const)
              if (identical && current !== undefined)
                identical = await equalBrc38PrivateProofOriginalFields(store, source, k, {
                  field: name,
                  left: current[name],
                  right: incoming[name],
                  maximumReadBytes: width,
                  workingAllocation: working,
                  signal
                })
            const effects = (await k(brc38PrivateMergeTargetsTable)
              .where({ importId: admission.scope.importId, sourceRow: next })
              .select('tableName', 'targetRowid', 'proofChanged')
              .limit(2)) as Array<{ tableName: string; targetRowid: number; proofChanged: number }>
            if (
              effects.length !== 1 ||
              effects[0].tableName !== 'provenTxs' ||
              effects[0].targetRowid !== rowId ||
              effects[0].proofChanged !== (identical ? 0 : 1)
            )
              invalid()
            if (!identical) {
              current = Object.freeze({
                ...incoming,
                metadata: Object.freeze({
                  ...incoming.metadata,
                  created_at: current === undefined ? incoming.metadata.created_at : date(current.metadata.created_at)
                })
              })
              retained?.close()
              retained = allocation
              keep = true
            }
            touched = true
            afterAlias = next
          } finally {
            if (!keep) allocation.close()
          }
        }
        if (current === undefined || (!baseline && !touched)) invalid()
        const names = Object.keys(current.metadata),
          columns = (await k.raw(
            'SELECT CASE WHEN length(CAST(name AS BLOB))<=128 THEN name END AS name FROM pragma_table_info(?) ORDER BY cid LIMIT 65',
            ['proven_txs']
          )) as Array<{ name: string | null }>
        if (
          columns.length !== names.length + 2 ||
          columns.length > 64 ||
          columns.some(
            value =>
              value.name === null || (!names.includes(value.name) && !['rawTx', 'merklePath'].includes(value.name))
          )
        )
          invalid()
        const extents = (await k('proven_txs')
          .whereRaw('rowid=CAST(? AS INTEGER)', [physical.toString()])
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
          .limit(2)) as Array<{ bytes: unknown }>
        if (extents.length !== 1) invalid()
        const bytes = integer(extents[0].bytes, true)
        if (bytes > 131072) invalid()
        const metadataCharge = working.claim(131072 + 32 * bytes)
        try {
          const actual = (await k('proven_txs')
            .whereRaw('rowid=CAST(? AS INTEGER)', [physical.toString()])
            .select(names)
            .limit(2)
            .options({ safeIntegers: true })) as Array<Record<string, unknown>>
          if (actual.length !== 1 || names.some(name => !Object.is(actual[0][name], current!.metadata[name]))) invalid()
        } finally {
          metadataCharge.close()
        }
        for (const field of ['rawTx', 'merklePath'] as const)
          logicalBytes += BigInt(
            await inspectBrc38PrivateSelectedField(store, source, k, {
              table: 'provenTxs',
              rowId,
              field,
              kind: 'blob',
              expected: current[field],
              maximumReadBytes: width,
              workingAllocation: working,
              signal
            })
          )
      } finally {
        retained?.close()
      }
      afterActual = rowId
      if (baseline) afterSource = rowId
    }
    if (aliases !== proofCount) invalid()
    let sourceEpoch = 0,
      firstReady: number | null = null,
      sourceArtifacts = 0,
      afterArtifact: number | null = null
    const epochKeys = await Brc38NativeLocalBaselineSource.ownedPage(source, 'prepared_beef_metadata', null, 2)
    if (epochKeys.length !== 1 || epochKeys[0] !== 1) invalid()
    await Brc38NativeLocalBaselineSource.withOwnedRow(source, 'prepared_beef_metadata', 1, async row => {
      sourceEpoch = integer(row.metadata.proofEpoch, true)
    })
    for (;;) {
      check()
      const keys = await Brc38NativeLocalBaselineSource.ownedPage(source, 'prepared_beefs', afterArtifact, 1)
      if (keys.length === 0) break
      if (++sourceArtifacts > maximumRows) invalid()
      await Brc38NativeLocalBaselineSource.withOwnedRow(source, 'prepared_beefs', keys[0], async row => {
        check()
        if (row.metadata.state === 'ready') {
          const id = integer(row.metadata.preparedBeefId)
          if (id < 1) invalid()
          if (firstReady === null || id < firstReady) firstReady = id
        }
      })
      afterArtifact = keys[0]
    }
    let afterPage = -1,
      epoch = sourceEpoch
    for (;;) {
      check()
      const pages = (await k(brc38PrivateMergePagesTable)
        .where({ importId: admission.scope.importId })
        .where('fromRow', '>', afterPage)
        .orderBy('fromRow')
        .select(
          'fromRow',
          'nextRow',
          'tableName',
          'cacheEpochBefore',
          'cacheEpochAfter',
          'cacheReadyId',
          'cacheUpdatedAt'
        )
        .limit(1)) as Array<{
        fromRow: number
        nextRow: number
        tableName: string
        cacheEpochBefore: number
        cacheEpochAfter: number
        cacheReadyId: number | null
        cacheUpdatedAt: string | null
      }>
      if (pages.length === 0) break
      const page = pages[0],
        changes = await k(brc38PrivateMergeTargetsTable)
          .where({ importId: admission.scope.importId, tableName: 'provenTxs', proofChanged: 1 })
          .where('sourceRow', '>=', page.fromRow)
          .where('sourceRow', '<', page.nextRow)
          .select('sourceRow')
          .limit(1),
        delta = changes.length === 0 ? 0 : 1
      if (
        page.cacheEpochBefore !== epoch ||
        page.cacheEpochAfter !== epoch + delta ||
        page.cacheReadyId !== firstReady ||
        (delta !== 0 && page.tableName !== 'provenTxs')
      )
        invalid()
      if (delta !== 0) {
        if (firstReady !== null) {
          if (page.cacheUpdatedAt === null) invalid()
          cacheUpdatedAt = page.cacheUpdatedAt
        } else if (page.cacheUpdatedAt !== null) invalid()
        firstReady = null
        cacheInvalidations++
      }
      epoch += delta
      afterPage = page.fromRow
      if (!Number.isSafeInteger(epoch)) invalid()
    }
    check()
    return Object.freeze({ rows, aliases, logicalBytes: logicalBytes.toString(), cacheInvalidations, cacheUpdatedAt })
  } finally {
    frame.close()
  }
}
