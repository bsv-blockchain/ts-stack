import { createHash } from 'node:crypto'
import type { Knex } from 'knex'
import type { KnexBrc38StagingStore } from './KnexBrc38StagingStore'
import type { Brc38PreparedStreamedPage } from './Brc38ImportPage'
import {
  withBrc38PreparedPrivatePackedText,
  type Brc38PrivatePreparedTextInstaller
} from './Brc38NativePackedTextPreparationNode'
import { nativePackedTextTables as names } from './Brc38NativePackedTextSchemaNode'
import { readBrc38NativePackedTextExtent } from './Brc38NativePackedTextFieldsNode'

/** Authored UNRUN. A finite packaged controller supplies the genuine current
 * authenticated private owner, a freshly prepared one-row transaction page,
 * an existing bounded metadata row, and independently generated original UTF-8
 * description bytes. No pool, process, runtime grant or controller is created. */
export async function verifyNativeScalarTextPreparationRecovery(
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
    throw new RangeError('Independent multichunk original description fixture required')
  const sha256 = createHash('sha256').update(expected).digest('hex'),
    failure = new Error('After TEXT staging, before wallet/journal'),
    read = async <T>(work: (trx: Knex.Transaction) => Promise<T>): Promise<T> =>
      await store.withPrivateNativeDatabase(true, async database => await database.transaction(work)),
    image = async (trx: Knex.Transaction) => ({
      row: await trx('transactions')
        .where({ transactionId: rowId })
        .first(trx.raw('typeof(description) AS kind,length(CAST(description AS BLOB)) AS bytes')),
      pointer: await trx(names.fields).where({ tableId: 0, rowId, fieldId: 0 }).first('sha256')
    }),
    before = await read(image)
  if (
    before.row === undefined ||
    (before.row.kind !== 'null' && (before.row.kind !== 'text' || before.row.bytes !== 0))
  )
    throw new Error('TEXT fixture metadata row does not use the actual packed layout')
  let escaped: Brc38PrivatePreparedTextInstaller | undefined
  try {
    await withBrc38PreparedPrivatePackedText(
      store,
      await freshPage(),
      new Map(),
      expiresAt,
      undefined,
      async install => {
        escaped = install
        throw failure
      }
    )
    throw new Error('Interrupted TEXT preparation unexpectedly returned')
  } catch (cause) {
    if (cause !== failure) throw cause
  }
  await read(async trx => {
    const version = await trx(names.versions).where({ sha256 }).first('state', 'bytes', 'accepted', 'chunks')
    if (
      JSON.stringify(await image(trx)) !== JSON.stringify(before) ||
      version?.state !== 'SEALED' ||
      version.bytes !== expected.byteLength ||
      version.accepted !== expected.byteLength ||
      version.chunks < 2
    )
      throw new Error('TEXT staging changed wallet metadata or lost its charged resumable content')
  })
  const page = await freshPage()
  if (
    page.data.kind !== 'table' ||
    page.data.table !== 'transactions' ||
    page.data.rows.length !== 1 ||
    Object.keys(page.data.rows[0].source.texts ?? {}).join() !== 'description'
  )
    throw new Error('Scalar TEXT fixture page differs')
  const sourceIndex = page.data.fromIndex,
    // The oracle supplies independently authored original bytes; a production
    // source descriptor does not substitute for byte equality below.
    field = Object.freeze({ field: 'description', encoding: 'utf8' as const, bytes: expected.byteLength, sha256 })
  await withBrc38PreparedPrivatePackedText(store, page, new Map(), expiresAt, undefined, async install => {
    await store.withPrivateNativeDatabase(
      false,
      async database =>
        await database.transaction(async trx => {
          if (escaped === undefined) throw new Error('Missing expired installer countercase')
          const beforeEscape = await image(trx)
          try {
            await escaped(trx, 'transactions', sourceIndex, rowId, field, 'text')
            throw new Error('Escaped TEXT installer ran')
          } catch (cause) {
            if (
              !(cause instanceof Error) ||
              !cause.message.includes('Owned private import read is unavailable or already pending')
            )
              throw cause
          }
          if (JSON.stringify(await image(trx)) !== JSON.stringify(beforeEscape))
            throw new Error('Expired TEXT installer changed original wallet metadata or pointer')
          await trx('transactions').where({ transactionId: rowId }).update({ description: '' })
          await install(trx, 'transactions', sourceIndex, rowId, field, 'text')
        })
    )
  })
  await read(async trx => {
    for (let offset = 0; offset < expected.byteLength;) {
      const length = Math.min(32768, expected.byteLength - offset),
        bytes = await readBrc38NativePackedTextExtent(trx, {
          table: 'transactions',
          field: 'description',
          rowId,
          offset,
          totalBytes: expected.byteLength,
          length
        })
      try {
        for (let index = 0; index < length; index++)
          if (bytes[index] !== expected[offset + index])
            throw new Error('Prepared TEXT differs from independent original byte oracle')
      } finally {
        bytes.fill(0)
      }
      offset += length
    }
  })
}
