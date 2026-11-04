import { promiseFromSync } from '../../utility/promiseFromSync'
import { createHash } from 'node:crypto'
import type { Knex } from 'knex'
import type { KnexBrc38StagingStore } from './KnexBrc38StagingStore'
import type { Brc38PreparedStreamedPage } from './Brc38ImportPage'
import type { Brc38JsonStructuredField } from './Brc38JsonStructuredFields'
import {
  withBrc38PreparedPrivatePackedText,
  type Brc38PrivatePreparedTextInstaller
} from './Brc38NativePackedTextPreparationNode'
import { nativePackedTextTables as names } from './Brc38NativePackedTextSchemaNode'
import { readBrc38NativePackedTextExtent } from './Brc38NativePackedTextFieldsNode'

/** Authored UNRUN. A finite packaged controller supplies the genuine current
 * authenticated private owner, a freshly prepared one-row provenTxReq page,
 * an existing bounded metadata row, and independently generated canonical
 * history bytes. No pool, process, runtime grant or controller is created. */
export async function verifyNativePackedTextPreparationRecovery(
  store: KnexBrc38StagingStore,
  freshPage: () => Promise<Brc38PreparedStreamedPage>,
  rowId: number,
  expected: Uint8Array,
  expiresAt: number,
  projections: ReadonlyMap<number, Readonly<Brc38JsonStructuredField>>
): Promise<void> {
  if (
    !(expected instanceof Uint8Array) ||
    expected.byteLength < 65537 ||
    expected.byteLength > 196608 ||
    !Number.isSafeInteger(rowId) ||
    rowId < 1
  )
    throw new RangeError('Independent multichunk canonical history fixture required')
  const sha256 = createHash('sha256').update(expected).digest('hex'),
    failure = new Error('After TEXT staging, before wallet/journal'),
    read = async <T>(work: (trx: Knex.Transaction) => Promise<T>): Promise<T> =>
      await store.withPrivateNativeDatabase(true, async database => await database.transaction(work)),
    image = async (trx: Knex.Transaction) => ({
      row: await trx('proven_tx_reqs')
        .where({ provenTxReqId: rowId })
        .first(trx.raw('typeof(history) AS kind,length(CAST(history AS BLOB)) AS bytes')),
      pointer: await trx(names.fields).where({ tableId: 2, rowId, fieldId: 0 }).first('sha256')
    }),
    before = await read(image)
  if (
    before.row === undefined ||
    (before.row.kind !== 'null' && (before.row.kind !== 'text' || before.row.bytes !== 0))
  )
    throw new Error('TEXT fixture metadata row does not use the actual packed layout')
  let escaped: Brc38PrivatePreparedTextInstaller | undefined
  try {
    await withBrc38PreparedPrivatePackedText(store, await freshPage(), projections, expiresAt, undefined, install => {
      return promiseFromSync(() => {
        escaped = install
        throw failure
      })
    })
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
    page.data.table !== 'provenTxReqs' ||
    page.data.rows.length !== 1 ||
    Object.keys(page.data.rows[0].source.structured ?? {})
      .sort((a, b) => Number(a > b) - Number(a < b))
      .join() !== 'history,notify' ||
    projections.get(page.data.fromIndex)?.field !== 'notify'
  )
    throw new Error('Complete authenticated request fixture page differs')
  const sourceIndex = page.data.fromIndex,
    // The oracle identifies canonical derived content; the source's raw JSON
    // descriptor remains independently preserved and need not have this hash.
    field = Object.freeze({ field: 'history', encoding: 'utf8-json' as const, bytes: expected.byteLength, sha256 })
  await withBrc38PreparedPrivatePackedText(store, page, projections, expiresAt, undefined, async install => {
    await store.withPrivateNativeDatabase(
      false,
      async database =>
        await database.transaction(async trx => {
          if (escaped === undefined) throw new Error('Missing expired installer countercase')
          const beforeEscape = await image(trx)
          try {
            await escaped(trx, 'provenTxReqs', sourceIndex, rowId, field, 'canonical')
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
          await trx('proven_tx_reqs').where({ provenTxReqId: rowId }).update({ history: '' })
          await install(trx, 'provenTxReqs', sourceIndex, rowId, field, 'canonical')
        })
    )
  })
  await read(async trx => {
    for (let offset = 0; offset < expected.byteLength;) {
      const length = Math.min(32768, expected.byteLength - offset),
        bytes = await readBrc38NativePackedTextExtent(trx, {
          table: 'provenTxReqs',
          field: 'history',
          rowId,
          offset,
          totalBytes: expected.byteLength,
          length
        })
      try {
        for (let index = 0; index < length; index++)
          if (bytes[index] !== expected[offset + index])
            throw new Error('Prepared TEXT differs from independent canonical byte oracle')
      } finally {
        bytes.fill(0)
      }
      offset += length
    }
  })
}
