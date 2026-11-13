import { readBrc38SqlTextDescriptors } from './Brc38SqlTextStaging'
import { readBrc38SqlStructuredDescriptors } from './Brc38SqlStructuredStaging'
import { verifyBrc38NativeTailLayout } from './Brc38NativeTailLayoutNode'
import { readBrc38NativeBinaryExtent } from './Brc38NativeBinaryReadNode'
import { canonicalPortableChunks } from './CanonicalPortableChunks'
import { verifyBrc38AuthenticatedSourceSeal } from './Brc38AuthenticatedSourceSealNode'
import type { Brc38JsonStreamedRow } from './Brc38JsonBinaryFields'
import type { Brc38StageTable } from './Brc38SemanticStage'
import { createHash } from 'node:crypto'
import type { Knex } from 'knex'
import type { Brc38NativeBlobWrite } from './Brc38NativeBlobProtocol'
import { brc38JsonBinaryField, type Brc38JsonStreamedField } from './Brc38JsonBinaryFields'
import { readBrc38SqlBinaryChunk, readBrc38SqlBinaryDescriptors } from './Brc38SqlBinaryStaging'
import { requireBrc38NativeProfileTransaction } from './Brc38PublishedProfileNode'
import { isBrc38OwnedPrivateNativeWriter, isBrc38OwnedPrivateNativeSqlite } from './KnexBrc38StagingStore'
import { privateNativeTransactionIdentity } from './Brc38PrivateNativeOwnershipNode'

interface NativeBlobDriver {
  writeOwnedNativeBlob: (trx: Knex.Transaction, input: Brc38NativeBlobWrite) => Promise<unknown>
  nativeTransactionIdentity: (trx: Knex.Transaction) => Readonly<{ slot: number }> | undefined
}
const driver: NativeBlobDriver = require('./NativeProfileSqlite.cjs')
const nativeTables: Readonly<Record<Brc38NativeBlobWrite['table'], string>> = {
  transactions: 'transactions',
  provenTxs: 'proven_txs',
  provenTxReqs: 'proven_tx_reqs',
  outputs: 'outputs',
  commissions: 'commissions'
}
export interface Brc38NativeBinaryFieldSelection {
  readonly table: Brc38NativeBlobWrite['table']
  readonly sourceIndex: number
  /** Actual rowid produced/verified by the enclosing native entity receiver. */
  readonly destinationRowId: number
  readonly field: Brc38JsonStreamedField
  /** Immutable operation deadline; chunk progress never extends it. */
  readonly expiresAt: number
  /** DATA selection only; accepted solely in the actual private writer scope. */
  readonly reservation?: 'fresh-private'
  readonly signal?: AbortSignal
}
function invalid(): never {
  throw new Error('Native binary realization differs from its admitted field')
}
function requireNativeBinaryTransaction(trx: Knex.Transaction): void {
  if (!isBrc38OwnedPrivateNativeWriter(trx)) requireBrc38NativeProfileTransaction(trx)
}
/** Same actual native view, point extents only, no reusable content verdict. */
async function destinationDigest(
  trx: Knex.Transaction,
  table: Brc38NativeBlobWrite['table'],
  column: Brc38NativeBlobWrite['field'],
  rowId: number,
  bytes: number,
  check: () => void
): Promise<string | undefined> {
  check()
  const name = nativeTables[table]
  const extent = (await trx.raw(
    `SELECT typeof(${column}) AS kind, length(${column}) AS bytes FROM ${name} WHERE rowid = ? LIMIT 1`,
    [rowId]
  )) as Array<{ kind: string; bytes: number }>
  if (extent.length !== 1 || extent[0].kind !== 'blob' || extent[0].bytes !== bytes) return undefined
  const digest = createHash('sha256')
  for (let offset = 0; offset < bytes;) {
    check()
    const amount = Math.min(65536, bytes - offset)
    const payload = await readBrc38NativeBinaryExtent(trx, {
      table,
      field: column,
      rowId,
      offset,
      totalBytes: bytes,
      length: amount
    })
    digest.update(payload)
    offset += amount
    check()
    await new Promise<void>(resolve => setTimeout(resolve, 0))
  }
  check()
  return digest.digest('hex')
}

/** Realizes one actual private staged field in the SAME uncommitted native DB.
 * Source chunks are local SQL cells, never network/callback/source paging while
 * holding a destination writer. No facade, capability, ACK or activation is
 * created. The caller admits current schema/profile/source/journal/primary and
 * destination row ownership before entry and again before its atomic commit.
 * The row reservation fires SQL UPDATE triggers; blob extents do not. */
async function realizeNativeBinaryField(trx: Knex.Transaction, input: Brc38NativeBinaryFieldSelection): Promise<void> {
  const table = input.table,
    sourceIndex = input.sourceIndex,
    rowId = input.destinationRowId,
    field = Object.freeze({
      field: input.field.field,
      encoding: input.field.encoding,
      bytes: input.field.bytes,
      sha256: input.field.sha256
    }),
    expiresAt = input.expiresAt,
    signal = input.signal,
    monotonicDeadline = performance.now() + Math.max(0, expiresAt - Date.now())
  const check = (): void => {
    signal?.throwIfAborted()
    requireNativeBinaryTransaction(trx)
    if (Date.now() >= expiresAt || performance.now() >= monotonicDeadline) invalid()
  }
  if (
    !Object.hasOwn(nativeTables, table) ||
    !Number.isSafeInteger(sourceIndex) ||
    sourceIndex < 0 ||
    !Number.isSafeInteger(rowId) ||
    rowId < 1 ||
    !Number.isSafeInteger(expiresAt) ||
    !brc38JsonBinaryField(table, field.field) ||
    !Number.isSafeInteger(field.bytes) ||
    field.bytes < 0 ||
    field.bytes > 1000000000 ||
    !/^[0-9a-f]{64}$/.test(field.sha256)
  )
    invalid()
  check()
  const descriptors = await readBrc38SqlBinaryDescriptors(trx, table, sourceIndex),
    actual = descriptors[field.field]
  if (
    actual === undefined ||
    actual.field !== field.field ||
    actual.encoding !== field.encoding ||
    actual.bytes !== field.bytes ||
    actual.sha256 !== field.sha256
  )
    invalid()
  // Identifiers come only from the fixed native table and independently checked
  // field whitelist. Bounded data parameters contain no SQL or whole binary.
  const name = nativeTables[table],
    column = field.field
  // Content-addressed reuse requires freshly hashing the actual destination
  // within this owned view. Neither the expected SHA nor a previous match is
  // retained as authority. Unchanged bytes need no UPDATE/event/blob IPC.
  if (input.reservation === 'fresh-private') {
    if (!isBrc38OwnedPrivateNativeWriter(trx)) invalid()
    await verifyBrc38NativeTailLayout(trx)
    const extent = (await trx(name)
      .whereRaw('rowid = ?', [rowId])
      .first(trx.raw('typeof(??) AS kind,length(??) AS bytes', [column, column]))) as
      { kind: string; bytes: number } | undefined
    if (extent?.kind !== 'blob' || extent.bytes !== field.bytes) invalid()
    // The actual fresh row INSERT reserved ALL tail fields atomically, before
    // any extent write. Updating it again could materialize an earlier BLOB.
  } else {
    if (input.reservation !== undefined) invalid()
    if (
      (await destinationDigest(trx, table, column as Brc38NativeBlobWrite['field'], rowId, field.bytes, check)) ===
      field.sha256
    )
      return
    check()
    const reserved = await trx(name)
      .whereRaw('rowid = ?', [rowId])
      .update({ [column]: trx.raw('zeroblob(?)', [field.bytes]) })
    if (reserved !== 1) invalid()
  }
  const digest = createHash('sha256')
  for (let offset = 0; offset < field.bytes;) {
    check()
    const chunk = await readBrc38SqlBinaryChunk(trx, table, sourceIndex, field.field, offset)
    if (
      chunk === undefined ||
      chunk.offset !== offset ||
      chunk.descriptor.encoding !== field.encoding ||
      chunk.descriptor.bytes !== field.bytes ||
      chunk.descriptor.sha256 !== field.sha256 ||
      chunk.bytes.byteLength < 1 ||
      chunk.bytes.byteLength > Math.min(65536, field.bytes - offset)
    )
      invalid()
    digest.update(chunk.bytes)
    check()
    await driver.writeOwnedNativeBlob(trx, {
      table,
      field: column as Brc38NativeBlobWrite['field'],
      rowId,
      offset,
      totalBytes: field.bytes,
      bytes: chunk.bytes
    })
    offset += chunk.bytes.byteLength
    check()
    await new Promise<void>(resolve => setTimeout(resolve, 0))
  }
  if (digest.digest('hex') !== field.sha256) invalid()
  // Independently hash the actual postimage; source digest alone proves no
  // successful native effect. The same point-reader handles verified reuse.
  if (
    (await destinationDigest(trx, table, column as Brc38NativeBlobWrite['field'], rowId, field.bytes, check)) !==
    field.sha256
  )
    invalid()
  check()
}

const active = new WeakSet<Knex.Transaction>()
/** The complete field has its own savepoint as well as per-extent native
 * protection. A digest/cancellation/source error rolls back the reservation and
 * all earlier extents before the caller observes failure. Independent cleanup
 * failures remain attached and require the enclosing owner to be drained. */
export async function writeBrc38NativeBinaryField(
  trx: Knex.Transaction,
  input: Brc38NativeBinaryFieldSelection
): Promise<void> {
  requireNativeBinaryTransaction(trx)
  if (driver.nativeTransactionIdentity(trx)?.slot !== 0)
    throw new Error('Native binary realization requires its actual wallet writer')
  // Detach every coordinate before SAVEPOINT's first awaited native reply.
  const fixed: Brc38NativeBinaryFieldSelection = Object.freeze({
    table: input.table,
    sourceIndex: input.sourceIndex,
    destinationRowId: input.destinationRowId,
    field: Object.freeze({
      field: input.field.field,
      encoding: input.field.encoding,
      bytes: input.field.bytes,
      sha256: input.field.sha256
    }),
    reservation: input.reservation,
    expiresAt: input.expiresAt,
    signal: input.signal
  })
  if (active.has(trx)) throw new Error('Native binary realization already owns this writer')
  active.add(trx)
  let reserved = false
  try {
    await trx.raw('SAVEPOINT __brc38_binary_field')
    reserved = true
    await realizeNativeBinaryField(trx, fixed)
    await trx.raw('RELEASE __brc38_binary_field')
    reserved = false
  } catch (cause) {
    const failures: unknown[] = []
    if (reserved) {
      try {
        await trx.raw('ROLLBACK TO __brc38_binary_field')
      } catch (error_) {
        failures.push(error_)
      }
      // A failed rollback retains the savepoint/owner; releasing it could commit
      // a partial field. Leave it for enclosing transaction rollback and drain.
      if (failures.length === 0) {
        try {
          await trx.raw('RELEASE __brc38_binary_field')
        } catch (error_) {
          failures.push(error_)
        }
      }
    }
    if (failures.length)
      throw new AggregateError([cause, ...failures], 'Native binary realization and savepoint cleanup failed', {
        cause
      })
    throw cause
  } finally {
    active.delete(trx)
  }
}

/** Fresh point metadata/descriptor comparison in the SAME actual private writer.
 * This is local staged SQL, never network/source callback paging. Expected
 * hashes are DATA; actual immutable source/schema/owner are checked anew. */
export async function assertBrc38NativeStreamedSourceRow(
  trx: Knex.Transaction,
  table: Brc38StageTable,
  index: number,
  source: Brc38JsonStreamedRow,
  maximumMetadataBytes: number
): Promise<void> {
  const check = (): void => {
    if (!isBrc38OwnedPrivateNativeWriter(trx)) invalid()
  }
  await assertBrc38NativeStreamedOwnedSourceRow(trx, table, index, source, maximumMetadataBytes, check)
}
/** Separate actual query-only preparation path. This does not admit a writer
 * and does not change the existing final-writer contract above. Membership is
 * re-read from the physical native lease and enrolled private store. */
export async function assertBrc38NativeStreamedReadSourceRow(
  trx: Knex.Transaction,
  table: Brc38StageTable,
  index: number,
  source: Brc38JsonStreamedRow,
  maximumMetadataBytes: number
): Promise<void> {
  const check = (): void => {
    if (privateNativeTransactionIdentity(trx)?.slot !== 3 || !isBrc38OwnedPrivateNativeSqlite(trx)) invalid()
  }
  await assertBrc38NativeStreamedOwnedSourceRow(trx, table, index, source, maximumMetadataBytes, check)
}
async function assertBrc38NativeStreamedOwnedSourceRow(
  trx: Knex.Transaction,
  table: Brc38StageTable,
  index: number,
  source: Brc38JsonStreamedRow,
  maximumMetadataBytes: number,
  check: () => void
): Promise<void> {
  check()
  if (
    !Number.isSafeInteger(index) ||
    index < 0 ||
    !Number.isSafeInteger(maximumMetadataBytes) ||
    maximumMetadataBytes < 1 ||
    maximumMetadataBytes > 16777216
  )
    invalid()
  await verifyBrc38AuthenticatedSourceSeal(trx)
  const rows: Array<{ bytes: number; actualBytes: number; kind: string }> = await trx('rows')
    .where({ tableName: table, position: index })
    .select('bytes', trx.raw('length(CAST(payload AS BLOB)) AS actualBytes'), trx.raw('typeof(payload) AS kind'))
    .limit(2)
  if (
    rows.length !== 1 ||
    rows[0].kind !== 'text' ||
    !Number.isSafeInteger(rows[0].bytes) ||
    rows[0].bytes < 1 ||
    rows[0].bytes > maximumMetadataBytes ||
    rows[0].actualBytes !== rows[0].bytes
  )
    invalid()
  const expected = createHash('sha256')
  for (const chunk of canonicalPortableChunks(source.fields, {
    maximumValueBytes: maximumMetadataBytes,
    maximumChunkBytes: 4096
  }))
    expected.update(chunk)
  const actual: { payload: string } | undefined = await trx('rows')
    .where({ tableName: table, position: index })
    .first('payload')
  if (
    actual === undefined ||
    Buffer.byteLength(actual.payload) !== rows[0].bytes ||
    createHash('sha256').update(actual.payload).digest('hex') !== expected.digest('hex')
  )
    invalid()
  const descriptors = await readBrc38SqlBinaryDescriptors(trx, table, index),
    names = Object.keys(source.binaries)
  if (Object.keys(descriptors).length !== names.length) invalid()
  for (const field of names) {
    const a = descriptors[field],
      b = source.binaries[field]
    if (
      a === undefined ||
      a.field !== b.field ||
      a.encoding !== b.encoding ||
      a.bytes !== b.bytes ||
      a.sha256 !== b.sha256
    )
      invalid()
  }
  const structured = await readBrc38SqlStructuredDescriptors(trx, table, index),
    json = source.structured ?? {},
    jsonNames = Object.keys(json)
  if (Object.keys(structured).length !== jsonNames.length || jsonNames.length > 3) invalid()
  for (const field of jsonNames) {
    const a = structured[field],
      b = json[field]
    if (
      a === undefined ||
      a.field !== b.field ||
      a.encoding !== b.encoding ||
      a.bytes !== b.bytes ||
      a.sha256 !== b.sha256
    )
      invalid()
  }
  const texts = await readBrc38SqlTextDescriptors(trx, table, index),
    incoming = source.texts ?? {},
    textNames = Object.keys(incoming)
  if (Object.keys(texts).length !== textNames.length || textNames.length > 7) invalid()
  for (const field of textNames) {
    const a = texts[field],
      b = incoming[field]
    if (
      a === undefined ||
      a.field !== b.field ||
      a.encoding !== b.encoding ||
      a.bytes !== b.bytes ||
      a.sha256 !== b.sha256
    )
      invalid()
  }
  check()
}
