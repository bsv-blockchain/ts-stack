import { chargeBrc38ImportDecodedBudget, reserveBrc38ImportDecodedScratch } from './Brc38ImportDecodedBudget'
import { Brc38OwnedImportReads } from './Brc38OwnedImportReads'
import { createHash } from 'node:crypto'
import type { Brc38PrivateDerivedTextLifetimes } from './Brc38PrivateDerivedTextLifetimesNode'
import type { Knex } from 'knex'
import type { KnexBrc38StagingStore } from './KnexBrc38StagingStore'
import { isBrc38OwnedPrivateNativeWriter, isBrc38OwnedPrivateNativeSqlite } from './KnexBrc38StagingStore'
import type { Brc38PreparedStreamedPage } from './Brc38ImportPage'
import type { Brc38NativeBlobWrite } from './Brc38NativeBlobProtocol'
import { encodeBrc38NativeBlobRead } from './Brc38NativeBlobProtocol'
import type { Brc38JsonStreamedField } from './Brc38JsonBinaryFields'
import { readBrc38SqlBinaryDescriptors, readBrc38SqlBinaryWindow } from './Brc38SqlBinaryStaging'
import { verifyBrc38AuthenticatedSourceSeal } from './Brc38AuthenticatedSourceSealNode'
import { hasBrc38NativePackedSchema, nativePackedTables } from './Brc38NativePackedSchemaNode'
import { hashBrc38NativePackedVersion, readBrc38NativePackedDescriptor } from './Brc38NativePackedFieldsNode'

const tables = ['transactions', 'proven_txs', 'proven_tx_reqs', 'outputs', 'commissions'] as const
const hash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')
function invalid(): never {
  throw new Error('Private packed preparation differs from its actual retained source or content')
}
interface Version {
  bytes: number
  accepted: number
  chunks: number
  state: 'PENDING' | 'SEALED' | 'RETIRING'
}
export type Brc38PrivatePreparedFieldInstaller = (
  trx: Knex.Transaction,
  table: Brc38NativeBlobWrite['table'],
  sourceIndex: number,
  rowId: number,
  field: Readonly<Brc38JsonStreamedField>
) => Promise<void>

/** One retained receiver operation, never a reusable content/schema verdict.
 * Payload copies use <=64KiB short transactions, yielding after each commit.
 * An interrupted PENDING prefix remains charged to the original private quota
 * and is independently compared with the original source on resume. Complete
 * immutable content is freshly hashed on an actual read lease before the
 * caller's row/journal writer. The installer lives only inside this callback;
 * current native owner, source seal, exact immutable schema and descriptors
 * are checked again in the final writer. No payload I/O occurs there. */
export async function withBrc38PreparedPrivatePackedFields<T>(
  store: KnexBrc38StagingStore,
  page: Brc38PreparedStreamedPage,
  expiresAt: number,
  signal: AbortSignal | undefined,
  work: (install: Brc38PrivatePreparedFieldInstaller) => Promise<T>,
  lifetimes?: Brc38PrivateDerivedTextLifetimes
): Promise<T> {
  const deadline = performance.now() + Math.max(0, expiresAt - Date.now())
  let live = true
  const check = (): void => {
    signal?.throwIfAborted()
    if (!live || !Number.isSafeInteger(expiresAt) || Date.now() >= expiresAt || performance.now() >= deadline) invalid()
    store.assertPrivateNativeDestination(store.knex)
    if (!isBrc38OwnedPrivateNativeSqlite(store.knex)) invalid()
  }
  check()
  lifetimes?.assertOwner(store, expiresAt, signal)
  const fields: Array<{
    table: Brc38NativeBlobWrite['table']
    index: number
    field: Readonly<Brc38JsonStreamedField>
  }> = []
  if (page.data.kind === 'table') {
    for (const [index, row] of page.data.rows.entries())
      for (const field of Object.values(row.source.binaries)) {
        chargeBrc38ImportDecodedBudget(page.budget, 4096)
        const descriptor = Object.freeze({
          field: field.field,
          encoding: field.encoding,
          bytes: field.bytes,
          sha256: field.sha256
        })
        if (
          fields.length >= 4096 ||
          !Number.isSafeInteger(descriptor.bytes) ||
          descriptor.bytes < 0 ||
          descriptor.bytes > 1000000000 ||
          !/^[0-9a-f]{64}$/.test(descriptor.sha256)
        )
          invalid()
        // The independent coordinate ABI rejects unsupported table/field pairs.
        encodeBrc38NativeBlobRead({
          table: page.data.table as Brc38NativeBlobWrite['table'],
          field: descriptor.field as Brc38NativeBlobWrite['field'],
          rowId: 1,
          offset: 0,
          totalBytes: 1,
          length: 1
        })
        fields.push({
          table: page.data.table as Brc38NativeBlobWrite['table'],
          index: page.data.fromIndex + index,
          field: descriptor
        })
      }
  }
  // One fixed scratch reservation covers source/native/captured chunk copies,
  // SQL packet buffering and hash windows during serial field preparation.
  const scratchBytes = Math.min(1048576, Math.floor(page.budget.remaining / 2)),
    maximumReadBytes = Math.min(65536, Math.floor((scratchBytes - 4096) / 16))
  let releaseScratch: (() => void) | undefined
  if (fields.length !== 0) {
    if (maximumReadBytes < 128) invalid()
    releaseScratch = reserveBrc38ImportDecodedScratch(page.budget, scratchBytes)
  }
  const transaction = async <V>(readOnly: boolean, operation: (trx: Knex.Transaction) => Promise<V>): Promise<V> =>
    await store.withPrivateNativeDatabase(
      readOnly,
      async database =>
        await database.transaction(async trx => {
          check()
          if (readOnly) store.assertPrivateNativeReadTransaction(trx)
          else store.assertPrivateNativeWriteTransaction(trx)
          if (!(await hasBrc38NativePackedSchema(trx))) invalid()
          await verifyBrc38AuthenticatedSourceSeal(trx)
          const result = await operation(trx)
          check()
          return result
        })
    )
  const current = async (trx: Knex.Transaction, source: (typeof fields)[number]): Promise<Version> => {
    const actual = (await readBrc38SqlBinaryDescriptors(trx, source.table, source.index))[source.field.field]
    if (JSON.stringify(actual) !== JSON.stringify(source.field)) invalid()
    const rows = (await trx(nativePackedTables.versions)
      .where({ sha256: source.field.sha256 })
      .select('bytes', 'accepted', 'chunks', 'state')
      .limit(2)) as Version[]
    if (
      rows.length !== 1 ||
      rows[0].bytes !== source.field.bytes ||
      !Number.isSafeInteger(rows[0].accepted) ||
      rows[0].accepted < 0 ||
      rows[0].accepted > rows[0].bytes ||
      !Number.isSafeInteger(rows[0].chunks) ||
      rows[0].chunks < 0 ||
      rows[0].chunks > rows[0].bytes ||
      !['PENDING', 'SEALED'].includes(rows[0].state) ||
      (rows[0].state === 'SEALED' && rows[0].accepted !== rows[0].bytes)
    )
      invalid()
    return rows[0]
  }
  try {
    for (const source of fields) {
      check()
      await transaction(false, async trx => {
        const actual = (await readBrc38SqlBinaryDescriptors(trx, source.table, source.index))[source.field.field]
        if (JSON.stringify(actual) !== JSON.stringify(source.field)) invalid()
        const existing = await trx(nativePackedTables.versions).where({ sha256: source.field.sha256 }).first('sha256')
        if (existing === undefined)
          await trx(nativePackedTables.versions).insert({
            sha256: source.field.sha256,
            bytes: source.field.bytes,
            accepted: 0,
            chunks: 0,
            state: 'PENDING'
          })
        await current(trx, source)
        await lifetimes?.retain(trx, source.field.sha256, page.budget, 'binary')
      })
      const digest = createHash('sha256')
      let offset = 0,
        chunkDigest = createHash('sha256'),
        physical: Readonly<{ offset: number; bytes: number; sha256: string }> | undefined
      while (offset < source.field.bytes) {
        check()
        // The source READ and its physical lease drain before an append writer
        // opens. A saved descriptor is DATA; both transactions freshly check
        // this owner's immutable source and exact schema.
        const value = await transaction(true, async trx => {
          await current(trx, source)
          return await readBrc38SqlBinaryWindow(
            trx,
            source.table,
            source.index,
            source.field.field,
            offset,
            maximumReadBytes
          )
        })
        try {
          if (
            value === undefined ||
            value.offset !== offset ||
            JSON.stringify(value.descriptor) !== JSON.stringify(source.field) ||
            value.bytes.byteLength < 1 ||
            value.bytes.byteLength > Math.min(maximumReadBytes, source.field.bytes - offset)
          )
            invalid()
          const bytes = value.bytes.byteLength
          await transaction(false, async trx => {
            const before = await current(trx, source)
            if (before.state === 'SEALED') {
              if (before.accepted !== before.bytes) invalid()
            } else {
              // A resumed prefix may have a different bounded partition. Match
              // its actual bytes across chunk boundaries before appending only
              // the missing suffix. Saved SHA/accepted counts never suffice.
              const retained = Math.min(bytes, Math.max(0, before.accepted - offset))
              for (let within = 0; within < retained;) {
                const at = offset + within,
                  prior = (await trx(nativePackedTables.chunks)
                    .where({ sha256: source.field.sha256 })
                    .where('offset', '<=', at)
                    .orderBy('offset', 'desc')
                    .first('offset', 'bytes', trx.raw('typeof(payload) AS kind,length(payload) AS actualBytes'))) as
                    { offset: number; bytes: number; kind: string; actualBytes: number } | undefined
                if (
                  prior === undefined ||
                  !Number.isSafeInteger(prior.offset) ||
                  prior.offset < 0 ||
                  prior.offset > at ||
                  !Number.isSafeInteger(prior.bytes) ||
                  prior.bytes < 1 ||
                  prior.bytes > 65536 ||
                  prior.kind !== 'blob' ||
                  prior.actualBytes !== prior.bytes ||
                  prior.offset + prior.bytes > before.accepted
                )
                  invalid()
                const start = at - prior.offset,
                  amount = Math.min(retained - within, prior.bytes - start)
                if (amount < 1) invalid()
                const previous = (await trx(nativePackedTables.chunks)
                  .where({ sha256: source.field.sha256, offset: prior.offset })
                  .first(trx.raw('substr(payload,?,?) AS payload', [start + 1, amount]))) as
                  { payload: Uint8Array } | undefined
                try {
                  if (!(previous?.payload instanceof Uint8Array) || previous.payload.byteLength !== amount) invalid()
                  for (let index = 0; index < amount; index++)
                    if (previous.payload[index] !== value.bytes[within + index]) invalid()
                } finally {
                  if (previous?.payload instanceof Uint8Array) previous.payload.fill(0)
                }
                within += amount
              }
              if (retained < bytes) {
                if (before.accepted !== offset + retained) invalid()
                const captured = Buffer.from(value.bytes.subarray(retained))
                try {
                  await trx(nativePackedTables.chunks).insert({
                    sha256: source.field.sha256,
                    offset: offset + retained,
                    bytes: captured.byteLength,
                    payload: captured,
                    chunkSha256: hash(captured)
                  })
                } finally {
                  captured.fill(0)
                }
              }
            }
          })
          if (physical === undefined) {
            if (value.chunk.offset !== offset) invalid()
            physical = value.chunk
          } else if (JSON.stringify(physical) !== JSON.stringify(value.chunk)) invalid()
          chunkDigest.update(value.bytes)
          if (offset + bytes === physical.offset + physical.bytes) {
            if (chunkDigest.digest('hex') !== physical.sha256) invalid()
            physical = undefined
            chunkDigest = createHash('sha256')
          } else if (offset + bytes > physical.offset + physical.bytes) invalid()
          digest.update(value.bytes)
          offset += bytes
        } finally {
          value?.bytes.fill(0)
        }
        check()
        await new Promise<void>(resolve => setTimeout(resolve, 0))
      }
      if (physical !== undefined || digest.digest('hex') !== source.field.sha256) invalid()
      // Independently hash the actual packed postimage while it is still
      // PENDING. A failed proof leaves charged resumable content, never SEALED
      // content that another row installer can select.
      await transaction(true, async trx => {
        const before = await current(trx, source)
        if (
          before.accepted !== source.field.bytes ||
          (await hashBrc38NativePackedVersion(
            trx,
            source.field.sha256,
            source.field.bytes,
            check,
            maximumReadBytes
          )) !== source.field.sha256
        )
          invalid()
      })
      await transaction(false, async trx => {
        const before = await current(trx, source),
          count = (await trx(nativePackedTables.chunks)
            .where({ sha256: source.field.sha256 })
            .count({ count: '*' })
            .first()) as { count: number } | undefined
        if (before.accepted !== source.field.bytes || count?.count !== before.chunks) invalid()
        if (
          before.state === 'PENDING' &&
          (await trx(nativePackedTables.versions)
            .where({
              sha256: source.field.sha256,
              state: 'PENDING',
              accepted: source.field.bytes,
              chunks: before.chunks
            })
            .update({ state: 'SEALED' })) !== 1
        )
          invalid()
      })
    }
    // All chunk buffers were cleared and their native transactions drained.
    // The callback installs only already-sealed descriptors, not payloads.
    // Keep descriptor/current-row charges; retire only this copy/hash scratch.
    releaseScratch?.()
    const installed = new Set<string>(),
      effects = new Brc38OwnedImportReads()
    const install: Brc38PrivatePreparedFieldInstaller = (trx, table, index, rowId, selected) =>
      effects.run(async () => {
        check()
        store.assertPrivateNativeWriteTransaction(trx)
        if (!isBrc38OwnedPrivateNativeWriter(trx) || !(await hasBrc38NativePackedSchema(trx))) invalid()
        await verifyBrc38AuthenticatedSourceSeal(trx)
        const source = fields.find(
          value =>
            value.table === table &&
            value.index === index &&
            value.field.field === selected.field &&
            JSON.stringify(value.field) === JSON.stringify(selected)
        )
        if (source === undefined || (await current(trx, source)).state !== 'SEALED') invalid()
        const packet = encodeBrc38NativeBlobRead({
            table,
            field: selected.field as Brc38NativeBlobWrite['field'],
            rowId,
            offset: 0,
            totalBytes: 1,
            length: 1
          }),
          coordinate = { tableId: packet[0], rowId, fieldId: packet[1] },
          identity = JSON.stringify(coordinate)
        if (installed.has(identity)) invalid()
        const row = (await trx(tables[coordinate.tableId])
          .whereRaw('rowid=?', [rowId])
          .first(trx.raw('typeof(??) AS kind,length(??) AS bytes', [selected.field, selected.field]))) as
          { kind: string; bytes: number } | undefined
        if (row?.kind !== 'blob' || row.bytes !== 0) invalid()
        await trx(nativePackedTables.fields).where(coordinate).delete()
        await trx(nativePackedTables.fields).insert({ ...coordinate, sha256: source.field.sha256 })
        const post = await readBrc38NativePackedDescriptor(trx, {
          table,
          field: selected.field as Brc38NativeBlobWrite['field'],
          rowId
        })
        if (post?.bytes !== source.field.bytes || post.sha256 !== source.field.sha256) invalid()
        installed.add(identity)
        check()
      })
    return await effects.retain(async () => await work(install))
  } finally {
    live = false
  }
}
