import { promiseFromSync } from '../../utility/promiseFromSync'
import { createHash } from 'node:crypto'
import type { Knex } from 'knex'
import type { KnexBrc38StagingStore } from './KnexBrc38StagingStore'
import type { Brc38PreparedStreamedPage } from './Brc38ImportPage'
import {
  withBrc38PreparedPrivatePackedFields,
  type Brc38PrivatePreparedFieldInstaller
} from './Brc38NativePackedFieldPreparationNode'
import { nativePackedTables } from './Brc38NativePackedSchemaNode'
import { readBrc38NativePackedExtent } from './Brc38NativePackedFieldsNode'

/** Authored UNRUN. The finite packaged native controller supplies a genuine
 * currently authenticated private receiver, a freshly prepared one-row output
 * page and an independently generated fixture byte oracle. The fixture output
 * already exists with NULL lockingScript. This case has no source/runtime
 * admission of its own and is never an authorization token. */
export async function verifyNativePackedFieldPreparationRecovery(
  store: KnexBrc38StagingStore,
  freshPage: () => Promise<Brc38PreparedStreamedPage>,
  rowId: number,
  expected: Uint8Array,
  expiresAt: number
): Promise<void> {
  if (
    !(expected instanceof Uint8Array) ||
    expected.byteLength < 65537 ||
    expected.byteLength > 196608 ||
    !Number.isSafeInteger(rowId) ||
    rowId < 1
  )
    throw new RangeError('Independent multichunk packed output fixture required')
  const sha256 = createHash('sha256').update(expected).digest('hex'),
    failure = new Error('After field staging, before row/checkpoint'),
    read = async <T>(work: (trx: import('knex').Knex.Transaction) => Promise<T>): Promise<T> =>
      await store.withPrivateNativeDatabase(true, async database => await database.transaction(work)),
    before = await read(async trx => ({
      row: await trx('outputs').where({ outputId: rowId }).first(trx.raw('lockingScript IS NULL AS empty')),
      pointers: await trx(nativePackedTables.fields).where({ rowId, tableId: 3 }).count({ count: '*' }).first()
    }))
  if (before.row?.empty !== 1 || before.pointers?.count !== 0)
    throw new Error('Preparation fixture is not initially pointer-free')
  let escaped: Brc38PrivatePreparedFieldInstaller | undefined
  try {
    await withBrc38PreparedPrivatePackedFields(store, await freshPage(), expiresAt, undefined, install => {
      return promiseFromSync(() => {
        escaped = install
        throw failure
      })
    })
    throw new Error('Interrupted preparation unexpectedly returned')
  } catch (cause) {
    if (cause !== failure) throw cause
  }
  await read(async trx => {
    const row = await trx('outputs').where({ outputId: rowId }).first(trx.raw('lockingScript IS NULL AS empty')),
      version = await trx(nativePackedTables.versions).where({ sha256 }).first('state', 'bytes', 'accepted', 'chunks'),
      pointers = await trx(nativePackedTables.fields).where({ rowId, tableId: 3 }).count({ count: '*' }).first()
    if (
      row?.empty !== 1 ||
      pointers?.count !== 0 ||
      version?.state !== 'SEALED' ||
      version.bytes !== expected.byteLength ||
      version.accepted !== expected.byteLength ||
      version.chunks < 2
    )
      throw new Error('Interrupted preparation changed the wallet row or lost its charged resumable content')
  })
  const page = await freshPage()
  if (page.data.kind !== 'table' || page.data.table !== 'outputs' || page.data.rows.length !== 1)
    throw new Error('Output fixture page differs')
  const sourceIndex = page.data.fromIndex,
    field = page.data.rows[0].source.binaries.lockingScript
  if (field?.sha256 !== sha256 || field.bytes !== expected.byteLength)
    throw new Error('Actual authenticated source differs from independent fixture')
  await withBrc38PreparedPrivatePackedFields(store, page, expiresAt, undefined, async install => {
    await store.withPrivateNativeDatabase(
      false,
      async database =>
        await database.transaction(async trx => {
          if (escaped === undefined) throw new Error('Missing escaped installer countercase')
          try {
            await escaped(trx, 'outputs', sourceIndex, rowId, field)
            throw new Error('Escaped installer ran')
          } catch (cause) {
            if (!(cause instanceof Error) || !cause.message.includes('unavailable')) throw cause
          }
          await trx('outputs')
            .where({ outputId: rowId })
            .update({ lockingScript: trx.raw('zeroblob(0)') })
          await install(trx, 'outputs', sourceIndex, rowId, field)
        })
    )
  })
  await read(async trx => {
    for (let offset = 0; offset < expected.byteLength;) {
      const length = Math.min(32768, expected.byteLength - offset),
        bytes = await readBrc38NativePackedExtent(trx, {
          table: 'outputs',
          field: 'lockingScript',
          rowId,
          offset,
          totalBytes: expected.byteLength,
          length
        })
      try {
        for (let index = 0; index < length; index++)
          if (bytes[index] !== expected[offset + index])
            throw new Error('Prepared physical output differs from independent byte oracle')
      } finally {
        bytes.fill(0)
      }
      offset += length
    }
  })
}
/** The finite serial controller supplies the same genuine source operation.
 * Observe actual borrowed database SQL and physical callback drainage, without
 * creating a native actor, replacing its identity or running another pool. */
export async function verifyNativePackedFieldPreparationReadDrain(
  store: KnexBrc38StagingStore,
  freshPage: () => Promise<Brc38PreparedStreamedPage>,
  expiresAt: number
): Promise<void> {
  const page = await freshPage()
  if (
    page.data.kind !== 'table' ||
    page.data.rows.length !== 1 ||
    !Object.values(page.data.rows[0].source.binaries).some(field => field.bytes > 65536)
  )
    throw new Error('Independent multichunk source fixture required')
  // Original fixture source windows are 1 KiB. The complete 129-window
  // sample observes 15,822 statements, including native seal checks.
  const expectedSourceWindows = Object.values(page.data.rows[0].source.binaries).reduce(
      (total, field) => total + Math.ceil(field.bytes / 1024),
      0
    ),
    maximumQueries = 512 + 128 * expectedSourceWindows
  if (!Number.isSafeInteger(maximumQueries) || expectedSourceWindows < 1 || maximumQueries > 131584)
    throw new Error('Finite native SQL observation fixture extent differs')
  const original = store.withPrivateNativeDatabase,
    borrow = original.bind(store),
    ownMethod = Object.hasOwn(store, 'withPrivateNativeDatabase')
  let reads = 0,
    sourceWindows = 0,
    writers = 0,
    queries = 0
  store.withPrivateNativeDatabase = async <T>(readOnly: boolean, work: (database: Knex) => Promise<T>): Promise<T> => {
    if (!readOnly && reads !== 0) throw new Error('Append writer opened before source read lease drained')
    if (readOnly) reads++
    else writers++
    try {
      return await borrow(readOnly, async database => {
        const observe = (query: { sql: string }): void => {
          if (++queries > maximumQueries || query.sql.length > 65536)
            throw new Error('Finite native SQL observation exceeded')
          if (/^select/i.test(query.sql) && /private_binary_chunks/i.test(query.sql) && /payload/i.test(query.sql)) {
            if (!readOnly) throw new Error('Source payload was read in an append writer')
            if (/substr\(payload/i.test(query.sql)) sourceWindows++
          }
        }
        database.on('query', observe)
        try {
          return await work(database)
        } finally {
          database.off('query', observe)
        }
      })
    } finally {
      if (readOnly) reads--
    }
  }
  try {
    await withBrc38PreparedPrivatePackedFields(store, page, expiresAt, undefined, async () => {})
    if (reads !== 0 || sourceWindows < 2 || writers < 2)
      throw new Error('Independent source-read drainage was not demonstrated')
  } finally {
    if (ownMethod) store.withPrivateNativeDatabase = original
    else Reflect.deleteProperty(store, 'withPrivateNativeDatabase')
  }
}
