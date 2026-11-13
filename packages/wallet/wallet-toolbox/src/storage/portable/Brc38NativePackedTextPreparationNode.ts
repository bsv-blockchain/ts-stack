import { createHash } from 'node:crypto'
import type { Knex } from 'knex'
import type { KnexBrc38StagingStore } from './KnexBrc38StagingStore'
import { isBrc38OwnedPrivateNativeSqlite, isBrc38OwnedPrivateNativeWriter } from './KnexBrc38StagingStore'
import type { Brc38PreparedStreamedPage } from './Brc38ImportPage'
import type { Brc38JsonTextField } from './Brc38JsonTextFields'
import { readBrc38SqlTextDescriptors, readBrc38SqlTextRange } from './Brc38SqlTextStaging'
import { nativePackedTextSource } from './Brc38NativePackedTextSources'
import type { Brc38JsonStructuredField } from './Brc38JsonStructuredFields'
import type { Brc38NativeTextRead } from './Brc38NativeBlobProtocol'
import { encodeBrc38NativeTextRead } from './Brc38NativeBlobProtocol'
import { chargeBrc38ImportDecodedBudget, reserveBrc38ImportDecodedScratch } from './Brc38ImportDecodedBudget'
import { Brc38OwnedImportReads } from './Brc38OwnedImportReads'
import { verifyBrc38AuthenticatedSourceSeal } from './Brc38AuthenticatedSourceSealNode'
import { hasBrc38NativePackedTextSchema, nativePackedTextTables as names } from './Brc38NativePackedTextSchemaNode'
import {
  readBrc38SqlCanonicalStructuredDescriptors,
  readBrc38SqlCanonicalStructuredRange
} from './Brc38SqlCanonicalStructuredStaging'
import {
  readBrc38SqlProjectedStructuredDescriptors,
  readBrc38SqlProjectedStructuredRange
} from './Brc38SqlProjectedStructuredStaging'
import {
  hashBrc38NativePackedTextVersion,
  readBrc38NativePackedTextDescriptor
} from './Brc38NativePackedTextFieldsNode'
import type { Brc38PrivateDerivedTextLifetimes } from './Brc38PrivateDerivedTextLifetimesNode'

interface Source {
  readonly table: Brc38NativeTextRead['table']
  readonly index: number
  readonly field: Readonly<Brc38JsonStructuredField | Brc38JsonTextField>
  readonly family: 'canonical' | 'projected' | 'text'
}
interface Version {
  bytes: number
  accepted: number
  chunks: number
  state: 'PENDING' | 'SEALED' | 'RETIRING'
}
export type Brc38PrivatePreparedTextInstaller = (
  trx: Knex.Transaction,
  table: Brc38NativeTextRead['table'],
  sourceIndex: number,
  rowId: number,
  field: Readonly<Brc38JsonStructuredField | Brc38JsonTextField>,
  family: Source['family']
) => Promise<void>
function invalid(): never {
  throw new Error('Private packed TEXT preparation differs from its retained source or content')
}
const hash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')
const descriptors = (source: Source) =>
  source.family === 'canonical'
    ? readBrc38SqlCanonicalStructuredDescriptors
    : source.family === 'projected'
      ? readBrc38SqlProjectedStructuredDescriptors
      : readBrc38SqlTextDescriptors

/** Authenticated derived TEXT is copied outside the row/journal transaction.
 * Every source window finishes its actual read transaction before a bounded
 * private writer appends it. An interrupted charged prefix is byte-compared
 * on resume, including different chunk partitions. The final installer is a
 * callback-scoped operation on this same native owner, not a stored verdict. */
export async function withBrc38PreparedPrivatePackedText<T>(
  store: KnexBrc38StagingStore,
  page: Brc38PreparedStreamedPage,
  projections: ReadonlyMap<number, Readonly<Brc38JsonStructuredField>>,
  expiresAt: number,
  signal: AbortSignal | undefined,
  work: (install: Brc38PrivatePreparedTextInstaller) => Promise<T>,
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
  const sources: Source[] = []
  // Keep one bounded metadata/read view; no payload or writer is retained.
  if (page.data.kind === 'table') {
    const data = page.data
    await store.withPrivateNativeDatabase(
      true,
      async database =>
        await database.transaction(async trx => {
          check()
          store.assertPrivateNativeReadTransaction(trx)
          if (!(await hasBrc38NativePackedTextSchema(trx))) invalid()
          await verifyBrc38AuthenticatedSourceSeal(trx)
          for (const [index, row] of data.rows.entries()) {
            const originalText = row.source.texts ?? {},
              textNames = Object.keys(originalText)
            if (textNames.length > 7) invalid()
            if (textNames.length !== 0) {
              const actual = await readBrc38SqlTextDescriptors(trx, data.table, data.fromIndex + index)
              if (textNames.length !== Object.keys(actual).length) invalid()
              for (const name of textNames) {
                chargeBrc38ImportDecodedBudget(page.budget, 4096)
                const expected = originalText[name],
                  value = actual[name]
                if (sources.length >= 4096 || value === undefined || JSON.stringify(value) !== JSON.stringify(expected))
                  invalid()
                encodeBrc38NativeTextRead({
                  table: data.table as Brc38NativeTextRead['table'],
                  field: name as Brc38NativeTextRead['field'],
                  rowId: 1,
                  offset: 0,
                  totalBytes: 1,
                  length: 1
                })
                sources.push({
                  table: data.table as Brc38NativeTextRead['table'],
                  index: data.fromIndex + index,
                  field: Object.freeze({ ...value }),
                  family: 'text'
                })
              }
            }
            const fields = Object.keys(row.source.structured ?? {})
            if (fields.length === 0) continue
            if (data.table !== 'provenTxReqs' && data.table !== 'syncStates') invalid()
            const canonical = await readBrc38SqlCanonicalStructuredDescriptors(trx, data.table, data.fromIndex + index)
            if (fields.length !== Object.keys(canonical).length || fields.length > 3) invalid()
            for (const name of fields) {
              chargeBrc38ImportDecodedBudget(page.budget, 4096)
              const operational = name === 'notify' || name === 'syncMap',
                value = operational ? projections.get(data.fromIndex + index) : canonical[name]
              if (
                sources.length >= 4096 ||
                value === undefined ||
                value.field !== name ||
                value.encoding !== 'utf8-json' ||
                !Number.isSafeInteger(value.bytes) ||
                value.bytes < 2 ||
                value.bytes > 1000000000 ||
                !/^[0-9a-f]{64}$/.test(value.sha256)
              )
                invalid()
              encodeBrc38NativeTextRead({
                table: data.table,
                field: name as Brc38NativeTextRead['field'],
                rowId: 1,
                offset: 0,
                totalBytes: 1,
                length: 1
              })
              sources.push({
                table: data.table,
                index: data.fromIndex + index,
                field: Object.freeze({
                  field: value.field,
                  encoding: value.encoding,
                  bytes: value.bytes,
                  sha256: value.sha256
                }),
                family: operational ? 'projected' : 'canonical'
              })
            }
          }
          check()
        })
    )
  }
  const scratchBytes = Math.min(1048576, Math.floor(page.budget.remaining / 2)),
    maximumReadBytes = Math.min(16384, Math.floor((scratchBytes - 4096) / 16))
  let releaseScratch: (() => void) | undefined
  if (sources.length !== 0) {
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
          if (!(await hasBrc38NativePackedTextSchema(trx))) invalid()
          await verifyBrc38AuthenticatedSourceSeal(trx)
          const result = await operation(trx)
          check()
          return result
        })
    )
  const sourceCurrent = async (trx: Knex.Transaction, source: Source): Promise<void> => {
    const actual = (await descriptors(source)(trx, source.table, source.index))[source.field.field]
    if (JSON.stringify(actual) !== JSON.stringify(source.field)) invalid()
  }
  const current = async (trx: Knex.Transaction, source: Source): Promise<Version> => {
    await sourceCurrent(trx, source)
    const rows = (await trx(names.versions)
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
    for (const source of sources) {
      await transaction(false, async trx => {
        await sourceCurrent(trx, source)
        if ((await trx(names.versions).where({ sha256: source.field.sha256 }).first('sha256')) === undefined)
          await trx(names.versions).insert({
            sha256: source.field.sha256,
            bytes: source.field.bytes,
            accepted: 0,
            chunks: 0,
            state: 'PENDING'
          })
        await current(trx, source)
        await lifetimes?.retain(trx, source.field.sha256, page.budget)
      })
      const digest = createHash('sha256'),
        decoder = source.family === 'text' ? new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }) : undefined
      for (let offset = 0; offset < source.field.bytes;) {
        check()
        const length = Math.min(maximumReadBytes, source.field.bytes - offset),
          bytes = await transaction(true, async trx => {
            await sourceCurrent(trx, source)
            if (source.family === 'text')
              return await readBrc38SqlTextRange(
                trx,
                source.table,
                source.index,
                source.field.field,
                offset,
                length,
                source.field as Brc38JsonTextField,
                maximumReadBytes,
                check
              )
            const read =
              source.family === 'canonical'
                ? readBrc38SqlCanonicalStructuredRange
                : readBrc38SqlProjectedStructuredRange
            return await read(
              trx,
              source.table,
              source.index,
              source.field.field,
              offset,
              length,
              source.field as Brc38JsonStructuredField,
              maximumReadBytes,
              check
            )
          })
        try {
          if (!(bytes instanceof Uint8Array) || bytes.byteLength !== length) invalid()
          await transaction(false, async trx => {
            const before = await current(trx, source)
            if (before.state === 'SEALED') return
            const retained = Math.min(length, Math.max(0, before.accepted - offset))
            for (let used = 0; used < retained;) {
              const at = offset + used,
                prior = (await trx(names.chunks)
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
                amount = Math.min(retained - used, prior.bytes - start)
              if (amount < 1) invalid()
              const previous = (await trx(names.chunks)
                .where({ sha256: source.field.sha256, offset: prior.offset })
                .first(trx.raw('substr(payload,?,?) AS payload', [start + 1, amount]))) as
                { payload: Uint8Array } | undefined
              try {
                if (!(previous?.payload instanceof Uint8Array) || previous.payload.byteLength !== amount) invalid()
                for (let index = 0; index < amount; index++)
                  if (previous.payload[index] !== bytes[used + index]) invalid()
              } finally {
                if (previous?.payload instanceof Uint8Array) previous.payload.fill(0)
              }
              used += amount
            }
            if (retained < length) {
              if (before.accepted !== offset + retained) invalid()
              const captured = Buffer.from(bytes.subarray(retained))
              try {
                await trx(names.chunks).insert({
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
          })
          digest.update(bytes)
          decoder?.decode(bytes, { stream: true })
          offset += length
        } finally {
          bytes.fill(0)
        }
        check()
        await new Promise<void>(resolve => setTimeout(resolve, 0))
      }
      decoder?.decode()
      if (source.field.bytes === 0 && source.family === 'text')
        await transaction(true, async trx => {
          await sourceCurrent(trx, source)
          const empty = await readBrc38SqlTextRange(
            trx,
            source.table,
            source.index,
            source.field.field,
            0,
            0,
            source.field as Brc38JsonTextField,
            maximumReadBytes,
            check
          )
          if (empty.byteLength !== 0) invalid()
        })
      if (digest.digest('hex') !== source.field.sha256) invalid()
      // Read actual immutable postimages before the short SEALED transition.
      await transaction(true, async trx => {
        const before = await current(trx, source)
        if (
          before.accepted !== source.field.bytes ||
          (await hashBrc38NativePackedTextVersion(
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
        const before = await current(trx, source)
        if (before.accepted !== source.field.bytes) invalid()
        if (
          before.state === 'PENDING' &&
          (await trx(names.versions)
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
    const install: Brc38PrivatePreparedTextInstaller = (trx, table, index, rowId, selected, family) =>
      effects.run(async () => {
        check()
        store.assertPrivateNativeWriteTransaction(trx)
        if (!isBrc38OwnedPrivateNativeWriter(trx) || !(await hasBrc38NativePackedTextSchema(trx))) invalid()
        await verifyBrc38AuthenticatedSourceSeal(trx)
        const source = sources.find(
          value =>
            value.table === table &&
            value.index === index &&
            value.family === family &&
            JSON.stringify(value.field) === JSON.stringify(selected)
        )
        if (source === undefined || (await current(trx, source)).state !== 'SEALED') invalid()
        const packet = encodeBrc38NativeTextRead({
            table,
            field: selected.field as Brc38NativeTextRead['field'],
            rowId,
            offset: 0,
            totalBytes: 1,
            length: 1
          }),
          coordinate = { tableId: packet[0], rowId, fieldId: packet[1] },
          identity = JSON.stringify(coordinate),
          spec = nativePackedTextSource(table),
          physicalTable = spec.sql,
          primary = spec.key,
          row = (await trx(physicalTable)
            .where({ [primary]: rowId })
            .first(
              trx.raw('typeof(??) AS kind,length(CAST(?? AS BLOB)) AS bytes', [selected.field, selected.field])
            )) as { kind: string; bytes: number } | undefined
        if (installed.has(identity) || row?.kind !== 'text' || row.bytes !== 0) invalid()
        await trx(names.fields).where(coordinate).delete()
        await trx(names.fields).insert({ ...coordinate, sha256: source.field.sha256 })
        const post = await readBrc38NativePackedTextDescriptor(trx, {
          table,
          field: selected.field as Brc38NativeTextRead['field'],
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
