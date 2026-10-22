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
  hasBrc38PrivatePriorImportSchema,
  installBrc38PrivatePriorImportSchema
} from './Brc38PrivatePriorImportSchemaNode'
import { readBrc38PrivateLocalCandidateJournal } from './Brc38PrivateLocalCandidateJournalNode'
import { verifyBrc38AuthenticatedSourceSeal } from './Brc38AuthenticatedSourceSealNode'
import { brc38WorkingAllocation, type Brc38WorkingAllocation } from './Brc38WorkingAllocation'

interface Progress {
  bindingSha256: string
  sourceSha256: string
  sourceLineageSha256: string
  maximumRows: number
  maximumLogicalBytes: number
  records: number
  logicalBytes: number
  copyTable: number
  afterRowId: number | null
}
interface Row {
  metadataJson: string
  metadataSha256: string
  fieldKind: 'none' | 'blob' | 'text'
  bytes: number
  sha256: string | null
  accepted: number
  chunks: number
  state: 'PENDING' | 'SEALED'
}
function invalid(): never {
  throw new Error('Private prior import differs from its original candidate, source, content or finite policy')
}
const hash = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex')
/** Exact SQLite types are retained as tagged DATA. Decimal integers are never
 * rounded through JS numbers; byte strings never become numeric arrays. */
export function encodeBrc38PrivatePriorMetadata(
  value: Readonly<Record<string, unknown>>,
  working: Brc38WorkingAllocation
): Readonly<{ json: string; close(): void }> {
  const names = Object.keys(value).sort((a, b) => Number(a > b) - Number(a < b))
  if (names.length < 1 || names.length > 128) invalid()
  let allocation = 131072
  for (const name of names) {
    const cell = value[name]
    if (!/^[A-Za-z][A-Za-z0-9_]{0,127}$/.test(name)) invalid()
    allocation += 1024 + 16 * Buffer.byteLength(name)
    if (typeof cell === 'string') allocation += 32 * Buffer.byteLength(cell)
    else if (cell instanceof Uint8Array) allocation += 48 * cell.byteLength
    else if (cell !== null && typeof cell !== 'bigint' && (typeof cell !== 'number' || !Number.isFinite(cell)))
      invalid()
    if (!Number.isSafeInteger(allocation) || allocation > working.maximum) invalid()
  }
  const charge = working.claim(allocation)
  try {
    const json = JSON.stringify(
      names.map(name => {
        const cell = value[name]
        return [
          name,
          cell === null
            ? ['null']
            : typeof cell === 'bigint'
              ? ['integer', cell.toString()]
              : typeof cell === 'number'
                ? ['real', Object.is(cell, -0) ? '-0' : cell.toString()]
                : typeof cell === 'string'
                  ? ['text', cell]
                  : ['blob', Buffer.from(cell as Uint8Array).toString('base64')]
        ]
      })
    )
    if (Buffer.byteLength(json) > 1048576) invalid()
    return Object.freeze({ json, close: () => charge.close() })
  } catch (cause) {
    charge.close()
    throw cause
  }
}
/** One original row and bounded chunk writers. The issued candidate supplies
 * its hidden original source/policy and independently repeats the same-source
 * RECOVERY fence. This primitive makes no READY, semantic or primary grant. */
export async function copyBrc38PrivatePriorImportStep(
  store: KnexBrc38StagingStore,
  source: Brc38NativeLocalBaselineSource,
  selected: Readonly<{
    sourceSha256: string
    maximumRows: number
    maximumReadBytes: number
    expiresAt: number
    workingAllocation: Brc38WorkingAllocation
    signal?: AbortSignal
  }>
): Promise<Readonly<{ complete: boolean; table: number; records: number; logicalBytes: number }>> {
  const sourceLineageSha256 = await Brc38NativeLocalBaselineSource.ownedPriorImportLineage(source)
  const policy = Object.freeze({ ...selected }),
    working = brc38WorkingAllocation(policy.workingAllocation),
    deadline = performance.now() + Math.max(0, policy.expiresAt - Date.now())
  if (
    working === undefined ||
    working.maximum > store.limits.maximumRowAllocationBytes ||
    policy.expiresAt !== store.limits.expiresAt ||
    !/^[0-9a-f]{64}$/.test(policy.sourceSha256) ||
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
      Brc38NativeLocalBaselineSource.assertSharedWorking(source, working)
      store.assertPrivateNativeDestination(store.knex)
    },
    transaction = async <T>(readOnly: boolean, work: (k: Knex.Transaction) => Promise<T>): Promise<T> => {
      check()
      return await store.withPrivateNativeDatabase(
        readOnly,
        async database =>
          await database.transaction(async k => {
            if (readOnly) store.assertPrivateNativeReadTransaction(k)
            else store.assertPrivateNativeWriteTransaction(k)
            await verifyBrc38AuthenticatedSourceSeal(k)
            const journal = await readBrc38PrivateLocalCandidateJournal(k)
            if (
              journal.phase !== 'RECOVERY' ||
              journal.bindingSha256 !== store.binding?.digest ||
              journal.sourceSha256 !== policy.sourceSha256 ||
              journal.maximumRows !== policy.maximumRows
            )
              invalid()
            const result = await work(k)
            check()
            return result
          })
      )
    },
    current = async (k: Knex.Transaction): Promise<Progress> => {
      if (!(await hasBrc38PrivatePriorImportSchema(k))) invalid()
      const values = (await k(budget)
        .where({ slot: 1 })
        .select(
          'bindingSha256',
          'sourceSha256',
          'sourceLineageSha256',
          'maximumRows',
          'maximumLogicalBytes',
          'records',
          'logicalBytes',
          'copyTable',
          'afterRowId'
        )
        .limit(2)) as Progress[]
      if (values.length !== 1) invalid()
      const value = values[0]
      if (
        value.bindingSha256 !== store.binding?.digest ||
        value.sourceSha256 !== policy.sourceSha256 ||
        value.sourceLineageSha256 !== sourceLineageSha256 ||
        value.maximumRows !== policy.maximumRows ||
        value.maximumLogicalBytes !== store.limits.maximumLogicalBytes ||
        !Number.isSafeInteger(value.records) ||
        value.records < 0 ||
        value.records > value.maximumRows ||
        !Number.isSafeInteger(value.logicalBytes) ||
        value.logicalBytes < 0 ||
        value.logicalBytes > value.maximumLogicalBytes ||
        !Number.isSafeInteger(value.copyTable) ||
        value.copyTable < 0 ||
        value.copyTable > brc38NativePriorImportTables.length + 1 ||
        (value.afterRowId !== null && !Number.isSafeInteger(value.afterRowId))
      )
        invalid()
      return value
    },
    result = (value: Progress) =>
      Object.freeze({
        complete: value.copyTable === brc38NativePriorImportTables.length + 1,
        table: value.copyTable,
        records: value.records,
        logicalBytes: value.logicalBytes
      }),
    charge = working.claim(1048576)
  try {
    const before = await transaction(false, async k => {
      await installBrc38PrivatePriorImportSchema(k)
      if (!(await k(budget).where({ slot: 1 }).select('slot').limit(1)).length)
        await k(budget).insert({
          slot: 1,
          bindingSha256: store.binding!.digest,
          sourceSha256: policy.sourceSha256,
          sourceLineageSha256,
          maximumRows: policy.maximumRows,
          maximumLogicalBytes: store.limits.maximumLogicalBytes,
          records: 0,
          logicalBytes: 0,
          copyTable: 0,
          afterRowId: null
        })
      return await current(k)
    })
    if (before.copyTable === brc38NativePriorImportTables.length + 1) return result(before)
    const inherited = before.copyTable === brc38NativePriorImportTables.length,
      table = brc38NativePriorImportTables[before.copyTable],
      page = inherited
        ? { rows: await Brc38NativeLocalBaselineSource.ownedRetainedPriorImportPage(source, before.afterRowId) }
        : await Brc38NativeLocalBaselineSource.ownedPriorImportPage(source, table, before.afterRowId, 1)
    if (!page.rows.length)
      return result(
        await transaction(false, async k => {
          if (JSON.stringify(await current(k)) !== JSON.stringify(before)) invalid()
          if (
            (await k(budget)
              .where({ slot: 1, copyTable: before.copyTable })
              .update({ copyTable: before.copyTable + 1, afterRowId: null })) !== 1
          )
            invalid()
          return await current(k)
        })
      )
    const consume = async (
      actual: Readonly<Brc38NativePriorImportRow> | Readonly<Brc38NativeRetainedPriorImportRow>
    ) => {
      check()
      const original = 'metadata' in actual,
        metadata = original
          ? encodeBrc38PrivatePriorMetadata(actual.metadata, working)
          : { json: actual.metadataJson, close: () => undefined },
        key = original
          ? { sourceLineageSha256, tableId: before.copyTable, sourceRowId: actual.rowId }
          : {
              sourceLineageSha256: actual.sourceLineageSha256,
              tableId: actual.tableId,
              sourceRowId: actual.sourceRowId
            },
        copyRowId = original ? actual.rowId : actual.copyRowId
      try {
        charge.resize(1048576 + 32 * Buffer.byteLength(metadata.json))
        const digest = createHash('sha256'),
          size = actual.field?.bytes ?? 0
        for (let offset = 0; offset < size;) {
          const length = Math.min(policy.maximumReadBytes, size - offset)
          await actual.withFieldExtent(offset, length, bytes => {
            return promiseFromSync(() => {
              check()
              digest.update(bytes)
            })
          })
          offset += length
        }
        const expected: Omit<Row, 'accepted' | 'chunks' | 'state'> = {
          metadataJson: metadata.json,
          metadataSha256: hash(metadata.json),
          fieldKind: actual.field?.kind ?? 'none',
          bytes: size,
          sha256: actual.field === undefined ? null : digest.digest('hex')
        }
        if (actual.field !== undefined && (original ? actual.metadata.sha256 : actual.field.sha256) !== expected.sha256)
          invalid()
        const read = async (k: Knex.Transaction): Promise<Row | undefined> => {
          const extents = (await k(rows)
            .where(key)
            .select(k.raw('length(CAST(metadataJson AS BLOB)) AS bytes'), 'copyRowId', 'state')
            .limit(2)) as Array<{ bytes: number; copyRowId: number; state: string }>
          if (extents.length === 0) return undefined
          if (
            extents.length !== 1 ||
            extents[0].bytes !== Buffer.byteLength(expected.metadataJson) ||
            (extents[0].state === 'PENDING' && extents[0].copyRowId !== copyRowId)
          )
            invalid()
          const values = (await k(rows)
            .where(key)
            .select('metadataJson', 'metadataSha256', 'fieldKind', 'bytes', 'sha256', 'accepted', 'chunks', 'state')
            .limit(2)) as Row[]
          if (values.length > 1) invalid()
          const value = values[0]
          if (
            value !== undefined &&
            (Object.keys(expected).some(name => value[name as keyof Row] !== expected[name as keyof typeof expected]) ||
              !Number.isSafeInteger(value.accepted) ||
              value.accepted < 0 ||
              value.accepted > size ||
              !Number.isSafeInteger(value.chunks) ||
              value.chunks < 0 ||
              value.chunks > size ||
              !['PENDING', 'SEALED'].includes(value.state))
          )
            invalid()
          return value
        }
        const initial = await transaction(false, async k => {
          if (JSON.stringify(await current(k)) !== JSON.stringify(before)) invalid()
          if ((await read(k)) === undefined)
            await k(rows).insert({ ...key, copyRowId, ...expected, accepted: 0, chunks: 0, state: 'PENDING' })
          return (await read(k))!
        })
        for (let offset = 0; initial.state !== 'SEALED' && offset < size;) {
          const length = Math.min(policy.maximumReadBytes, size - offset),
            at = offset
          await actual.withFieldExtent(at, length, async bytes => {
            const bufferCharge = working.claim(8192 + 32 * length),
              captured = Buffer.from(bytes)
            try {
              await transaction(false, async k => {
                const row = await read(k)
                if (row === undefined || row.state !== 'PENDING') invalid()
                if (at < row.accepted) {
                  const prior = (await k(chunks)
                    .where({ ...key, offset: at })
                    .select('bytes', 'payload', 'sha256')
                    .limit(2)) as Array<{ bytes: number; payload: Uint8Array; sha256: string }>
                  try {
                    if (
                      prior.length !== 1 ||
                      prior[0].bytes !== length ||
                      !(prior[0].payload instanceof Uint8Array) ||
                      prior[0].payload.byteLength !== length ||
                      hash(prior[0].payload) !== prior[0].sha256 ||
                      !prior[0].payload.every((byte, index) => byte === captured[index])
                    )
                      invalid()
                  } finally {
                    for (const value of prior) value.payload?.fill(0)
                  }
                } else {
                  if (row.accepted !== at) invalid()
                  await k(chunks).insert({
                    ...key,
                    offset: at,
                    bytes: length,
                    payload: captured,
                    sha256: hash(captured)
                  })
                }
              })
            } finally {
              captured.fill(0)
              bufferCharge.close()
            }
          })
          offset += length
        }
        await transaction(true, async k => {
          const row = await read(k)
          if (row === undefined || row.accepted !== size) invalid()
          const stored = createHash('sha256')
          let offset = 0,
            count = 0
          while (offset < size) {
            const frame = working.claim(8192 + 32 * policy.maximumReadBytes)
            let payload: Uint8Array | undefined
            try {
              const values = (await k(chunks)
                .where({ ...key, offset })
                .select('bytes', 'payload', 'sha256')
                .limit(2)) as Array<{ bytes: number; payload: Uint8Array; sha256: string }>
              if (values.length !== 1) invalid()
              payload = values[0].payload
              if (
                !(payload instanceof Uint8Array) ||
                !Number.isSafeInteger(values[0].bytes) ||
                values[0].bytes < 1 ||
                values[0].bytes > policy.maximumReadBytes ||
                values[0].bytes !== payload.byteLength ||
                values[0].bytes > size - offset ||
                hash(payload) !== values[0].sha256
              )
                invalid()
              stored.update(payload)
              offset += payload.byteLength
              count++
            } finally {
              payload?.fill(0)
              frame.close()
            }
          }
          if (
            count !== row.chunks ||
            (size > 0 && stored.digest('hex') !== expected.sha256) ||
            (await k(chunks).where(key).where('offset', '>=', size).select('offset').limit(1)).length
          )
            invalid()
        })
        return result(
          await transaction(false, async k => {
            const row = await read(k)
            if (row === undefined || row.accepted !== size || row.chunks < initial.chunks) invalid()
            if (row.state === 'PENDING') {
              if (
                (await k(rows)
                  .where({ ...key, copyRowId, accepted: size, state: 'PENDING', chunks: row.chunks })
                  .update({ state: 'SEALED' })) !== 1
              )
                invalid()
            } else {
              // An identical inherited record is retained once. Exact stored
              // content was re-hashed above; only the actual scan cursor moves.
              if (
                !inherited ||
                JSON.stringify(await current(k)) !== JSON.stringify(before) ||
                (await k(budget).where({ slot: 1, copyTable: before.copyTable }).update({ afterRowId: copyRowId })) !==
                  1
              )
                invalid()
            }
            return await current(k)
          })
        )
      } finally {
        metadata.close()
        charge.resize(1048576)
      }
    }
    return inherited
      ? await Brc38NativeLocalBaselineSource.withOwnedRetainedPriorImportRow(source, page.rows[0], consume)
      : await Brc38NativeLocalBaselineSource.withOwnedPriorImportRow(source, table, page.rows[0], consume)
  } finally {
    charge.close()
  }
}
