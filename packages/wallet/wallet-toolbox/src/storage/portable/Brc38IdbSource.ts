import { awaitFromSync, mapAwaitFromSync } from '../../utility/promiseFromSync'
import { SHA256 } from '@bsv/sdk/primitives/Hash'
import type { StorageIdb } from '../StorageIdb'
import type { PackedIdbMetadataRow, PackedIdbReadSnapshot } from '../idbPackedSnapshot'
import { openPackedIdbSnapshot } from '../idbPackedSnapshot'
import { getPackedIdbConnection } from '../idbPackedConnection'
import { PackedIdbJsonIndex } from '../idbPackedJsonIndex'
import { packedIdbDateTimestamp, type PackedIdbField } from '../idbPackedFields'
import type {
  WalletReadSnapshotOptions,
  WalletSnapshotCursor,
  WalletSnapshotTable
} from '../snapshot/WalletReadSnapshot'
import { closeSnapshotJournalSource } from '../snapshot/journal/closeSnapshotJournalSource'
import { SnapshotResourceLimitError } from '../snapshot/SnapshotResourceLimitError'
import { projectBrc38PackedRow } from './Brc38PackedRow'
import type { Brc38StreamSource } from './Brc38Stream'
import type { Brc38StreamedBinary, Brc38StreamedRow } from './Brc38StreamedRow'
import type { Brc38JsonMember, Brc38StreamedStructured } from './Brc38StructuredJson'
import type { BRC38Tables } from './index'

type Row = BRC38Tables[WalletSnapshotTable][number]
export interface Brc38IdbSourceOptions extends WalletReadSnapshotOptions {
  maximumPageRows: number
  maximumPageBytes: number
  maximumRowAllocationBytes: number
  maximumCertificateGroupBytes: number
  maximumMetadataAllocationBytes?: number
  streamedBinary?: Readonly<{ maximumBinaryBytes: number; maximumExtentBytes?: number }>
  streamedStructured?: Readonly<{ maximumStructuredBytes: number }>
}
const binaries: Partial<Record<WalletSnapshotTable, readonly string[]>> = {
  provenTxs: ['rawTx', 'merklePath'],
  provenTxReqs: ['rawTx', 'inputBEEF'],
  transactions: ['rawTx', 'inputBEEF', 'noSendExpiryReclaimRawTx'],
  commissions: ['lockingScript'],
  outputs: ['lockingScript']
}
const booleans: Partial<Record<WalletSnapshotTable, readonly string[]>> = {
  // Preserve the optional flag's original boolean or historical SQL spelling.
  provenTxReqs: ['notified'],
  outputBaskets: ['isDeleted'],
  transactions: ['isOutgoing'],
  commissions: ['isRedeemed'],
  outputs: ['spendable', 'change'],
  outputTags: ['isDeleted'],
  outputTagMaps: ['isDeleted'],
  txLabels: ['isDeleted'],
  txLabelMaps: ['isDeleted'],
  certificates: ['isDeleted'],
  syncStates: ['init']
}
const structured: Partial<Record<WalletSnapshotTable, readonly string[]>> = {
  provenTxReqs: ['history', 'notify'],
  syncStates: ['syncMap', 'errorLocal', 'errorOther']
}
function bound(value: number, maximum: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum)
    throw new RangeError(`BRC-38 IDB source bound must be from 1 to ${maximum}`)
}
function normalized(table: WalletSnapshotTable, fields: Record<string, unknown>): Record<string, unknown> {
  const result = { ...fields }
  for (const name of booleans[table] ?? []) {
    const value = result[name]
    if (value == null) continue
    if (value !== true && value !== false && value !== 0 && value !== 1)
      throw new TypeError('Invalid BRC-38 IDB boolean')
    result[name] = value === true || value === 1
  }
  return result
}
function allocation(fields: Record<string, unknown>): number {
  let bytes = 128
  for (const [name, value] of Object.entries(fields)) {
    bytes += 64 + 2 * name.length
    if (typeof value === 'string') bytes += 2 * value.length
    else if (
      typeof value === 'number' ||
      typeof value === 'boolean' ||
      (packedIdbDateTimestamp(value) !== undefined && Number.isFinite(packedIdbDateTimestamp(value))) ||
      value == null
    )
      bytes += 64
    else throw new TypeError('Unexpected IDB source metadata value')
  }
  return bytes
}
async function text(
  view: PackedIdbReadSnapshot,
  table: WalletSnapshotTable,
  cursor: WalletSnapshotCursor,
  name: string,
  field: PackedIdbField,
  extent: number
): Promise<string> {
  const hash = new SHA256(),
    pieces: string[] = []
  for (let offset = 0; offset < field.bytes; offset += extent) {
    const bytes = await view.readFieldExtent(table, cursor, name, offset, Math.min(extent, field.bytes - offset), field)
    hash.update(bytes)
    let piece = ''
    for (let index = 0; index < bytes.length; index += 2)
      piece += String.fromCodePoint(bytes[index] | (bytes[index + 1] << 8))
    pieces.push(piece)
  }
  if (hash.digestHex() !== field.sha256) throw new TypeError('BRC-38 IDB text digest differs')
  return pieces.join('')
}
/** Genuine packed-IDB source, one profile/ceiling and all original thirteen
 * tables. This source does not expose a replica's replacement sync checkpoints.
 * Portable map ordering is indexed; certificate locale ordering is grouped
 * under a finite allocation bound. Legacy version6 refuses this strict source. */
export async function openBrc38IdbSource(
  storage: StorageIdb,
  identityKey: string,
  selected: Brc38IdbSourceOptions
): Promise<Brc38StreamSource> {
  const options = Object.freeze({
    ...selected,
    ...(selected.streamedBinary === undefined ? {} : { streamedBinary: Object.freeze({ ...selected.streamedBinary }) }),
    ...(selected.streamedStructured === undefined
      ? {}
      : { streamedStructured: Object.freeze({ ...selected.streamedStructured }) })
  })
  bound(options.maximumPageRows, 256)
  bound(options.maximumPageBytes, 16777216)
  bound(options.maximumRowAllocationBytes, 16777216)
  bound(options.maximumCertificateGroupBytes, 16777216)
  bound(options.maximumMetadataAllocationBytes ?? 65536, 16777216)
  const extent = options.streamedBinary?.maximumExtentBytes ?? 65536
  bound(extent, 65536)
  if (extent % 2 !== 0) throw new RangeError('BRC-38 IDB source extent must be even for UTF-16')
  if (options.streamedBinary !== undefined) bound(options.streamedBinary.maximumBinaryBytes, 1000000000)
  if (options.streamedStructured !== undefined) bound(options.streamedStructured.maximumStructuredBytes, 1000000000)
  const streamed = options.streamedBinary !== undefined || options.streamedStructured !== undefined
  if (!/^(02|03)[0-9a-fA-F]{64}$/.test(identityKey)) throw new TypeError('Compressed profile identity required')
  const db = await storage.verifyDB(),
    owner = getPackedIdbConnection(db)
  if (owner === undefined) throw new TypeError('BRC-38 IDB source requires its genuine packed connection')
  const view = await openPackedIdbSnapshot(db, identityKey, storage.chain, options)
  let released: Promise<void> | undefined,
    closed = false,
    reading = false,
    rowOwner: object | undefined
  const sourceOperations = new Set<Promise<unknown>>(),
    indexes = new Set<PackedIdbJsonIndex>()
  const release = (): Promise<void> => {
    closed = true
    rowOwner = undefined
    if (released !== undefined) return released
    released = (async () => {
      // Admission was revoked before draining actual extent/index-opening work.
      await Promise.allSettled(sourceOperations)
      const failures: unknown[] = []
      // Snapshot the admitted cleanup cohort before awaiting its mutable owners.
      for (const index of Array.from(indexes)) {
        try {
          await index.close()
          indexes.delete(index)
        } catch (error) {
          failures.push(error)
        }
      }
      try {
        await closeSnapshotJournalSource(view, options.signal)
      } catch (error) {
        failures.push(error)
      }
      if (failures.length !== 0) throw new AggregateError(failures, 'BRC-38 IDB source physical cleanup failed')
    })()
    void released.catch(() => {
      released = undefined
    })
    return released
  }
  const completed = new Set<WalletSnapshotTable>()
  const metadataPolicy = {
    maximumAllocationBytes: options.maximumMetadataAllocationBytes ?? 65536,
    signal: options.signal
  }
  const active = () => {
    options.signal?.throwIfAborted()
    if (closed || !view.isOpen) throw new Error('BRC-38 IDB source is closed or expired')
  }
  const sourceOperation = async <T>(run: () => Promise<T>): Promise<T> => {
    active()
    if (sourceOperations.size !== 0) throw new Error('BRC-38 IDB source extent/index operation already owns admission')
    const work = run()
    sourceOperations.add(work)
    try {
      return await work
    } finally {
      sourceOperations.delete(work)
    }
  }
  try {
    await view.validateClosure()
    const sourceStorage = projectBrc38PackedRow('sourceStorage', view.sourceStorage, metadataPolicy),
      user = projectBrc38PackedRow('user', view.user, metadataPolicy)
    async function* metadataRows(table: WalletSnapshotTable): AsyncGenerator<PackedIdbMetadataRow<typeof table>> {
      let cursor: WalletSnapshotCursor | undefined,
        done = false
      while (!done) {
        active()
        const page = await view.readFieldMetadataPage(table, cursor, {
          maxRows: options.maximumPageRows,
          maxBytes: options.maximumPageBytes,
          order: 'portable'
        })
        if (!page.done && page.cursor === undefined) throw new Error('BRC-38 IDB portable source did not advance')
        cursor = page.cursor
        done = page.done
        yield* page.rows
      }
    }
    async function detached(
      table: WalletSnapshotTable,
      source: PackedIdbMetadataRow<typeof table>,
      streamFields: boolean
    ): Promise<Record<string, unknown>> {
      const fields = normalized(table, source.fields as Record<string, unknown>)
      const streamBinary = streamFields && options.streamedBinary !== undefined
      const streamJson = streamFields && options.streamedStructured !== undefined
      let charge = allocation(fields)
      for (const [name, field] of Object.entries(source.extents)) {
        if (field.kind === 'utf16') {
          if (streamJson && structured[table]?.includes(name)) continue
          charge += 4 * field.bytes + 128
        } else {
          if (!binaries[table]?.includes(name)) throw new TypeError('Unknown BRC-38 IDB binary field')
          if (!streamBinary) charge += (name === 'noSendExpiryReclaimRawTx' ? 66 : 6) * field.bytes + 128
        }
      }
      if (!Number.isSafeInteger(charge) || charge > options.maximumRowAllocationBytes)
        throw new SnapshotResourceLimitError('BRC-38 IDB row exceeds its allocation policy')
      // The whole row is precharged before any field is materialized.
      for (const [name, field] of Object.entries(source.extents)) {
        if (field.kind === 'utf16') {
          if (streamJson && structured[table]?.includes(name)) continue
          fields[name] = await text(view, table, source.cursor, name, field, extent)
        } else if (!streamBinary) {
          const bytes = new Uint8Array(field.bytes),
            hash = new SHA256()
          for (let offset = 0; offset < field.bytes; offset += extent) {
            const chunk = await view.readFieldExtent(
              table,
              source.cursor,
              name,
              offset,
              Math.min(extent, field.bytes - offset),
              field
            )
            hash.update(chunk)
            bytes.set(chunk, offset)
          }
          if (hash.digestHex() !== field.sha256) throw new TypeError('BRC-38 IDB binary digest differs')
          fields[name] = bytes
        }
      }
      return fields
    }
    async function* rawRows(
      table: WalletSnapshotTable,
      streamed: boolean
    ): AsyncGenerator<{ row: Row; fields: Record<string, unknown>; source: PackedIdbMetadataRow<typeof table> }> {
      for await (const source of metadataRows(table)) {
        const fields = await detached(table, source, streamed)
        const row = projectBrc38PackedRow(table, fields, {
          maximumAllocationBytes: options.maximumRowAllocationBytes,
          signal: options.signal
        })
        yield { row, fields, source }
      }
    }
    async function* certificateRows(): AsyncGenerator<Row> {
      let certificate: unknown,
        bytes = 0,
        group: Row[] = []
      const ordered = () =>
        group.sort((a, b) => {
          if (typeof a.fieldName !== 'string' || typeof b.fieldName !== 'string')
            throw new TypeError('Invalid certificate field name')
          return a.fieldName.localeCompare(b.fieldName)
        })
      for await (const item of rawRows('certificateFields', false)) {
        if (group.length !== 0 && certificate !== item.row.certificateId) {
          yield* ordered()
          group = []
          bytes = 0
        }
        certificate = item.row.certificateId
        const charge = allocation(item.row) + 128
        if (charge > options.maximumCertificateGroupBytes - bytes)
          throw new SnapshotResourceLimitError('BRC-38 IDB certificate group exceeds allocation policy')
        bytes += charge
        group.push(item.row)
      }
      yield* ordered()
    }
    return Object.freeze({
      sourceStorage,
      user,
      async *rows(table: WalletSnapshotTable) {
        active()
        if (streamed || reading || completed.has(table))
          throw new Error('BRC-38 IDB source requires one complete owned table read')
        reading = true
        try {
          if (table === 'certificateFields') yield* certificateRows()
          else for await (const item of rawRows(table, false)) yield item.row
          active()
          completed.add(table)
        } finally {
          rowOwner = undefined
          reading = false
        }
      },
      ...(!streamed
        ? {}
        : {
            async *streamedRows(table: WalletSnapshotTable): AsyncGenerator<Brc38StreamedRow> {
              active()
              if (reading || completed.has(table))
                throw new Error('BRC-38 IDB source requires one complete owned table read')
              reading = true
              try {
                if (table === 'certificateFields') {
                  for await (const row of certificateRows()) yield { fields: row, binaries: {} }
                } else
                  for await (const item of rawRows(table, true)) {
                    const token = {}
                    rowOwner = token
                    const refs: Record<string, Brc38StreamedBinary> = Object.create(null)
                    const json: Record<string, Brc38StreamedStructured> = Object.create(null)
                    for (const [name, field] of Object.entries(item.source.extents)) {
                      const isJson =
                        field.kind === 'utf16' &&
                        options.streamedStructured !== undefined &&
                        structured[table]?.includes(name)
                      if (
                        (field.kind === 'utf16' && !isJson) ||
                        (field.kind !== 'utf16' && options.streamedBinary === undefined)
                      )
                        continue
                      const maximum = isJson
                        ? options.streamedStructured!.maximumStructuredBytes
                        : options.streamedBinary!.maximumBinaryBytes
                      if (field.bytes > maximum)
                        throw new SnapshotResourceLimitError('BRC-38 IDB field exceeds source policy')
                      const read = (offset: number, length: number) =>
                        sourceOperation(async () => {
                          active()
                          if (
                            !reading ||
                            rowOwner !== token ||
                            !Number.isSafeInteger(offset) ||
                            offset < 0 ||
                            !Number.isSafeInteger(length) ||
                            length < 0 ||
                            length > 65536 ||
                            offset + length > field.bytes
                          )
                            throw new Error('BRC-38 IDB extent is outside its owned row lifetime')
                          const bytes = new Uint8Array(length)
                          for (let used = 0; used < length;) {
                            const count = Math.min(extent, length - used),
                              part = await view.readFieldExtent(
                                table,
                                item.source.cursor,
                                name,
                                offset + used,
                                count,
                                field
                              )
                            active()
                            if (rowOwner !== token) throw new Error('BRC-38 IDB row lifetime changed')
                            bytes.set(part, used)
                            used += count
                          }
                          return bytes
                        })
                      const hash = new SHA256()
                      for (let offset = 0; offset < field.bytes; offset += extent)
                        hash.update(await read(offset, Math.min(extent, field.bytes - offset)))
                      if (hash.digestHex() !== field.sha256)
                        throw new TypeError('BRC-38 IDB source binary digest differs')
                      if (isJson)
                        json[name] = Object.freeze({
                          encoding: 'utf16le' as const,
                          length: field.bytes,
                          sha256: field.sha256,
                          read,
                          openIndex: () =>
                            sourceOperation(async () => {
                              active()
                              if (!reading || rowOwner !== token)
                                throw new Error('BRC-38 IDB JSON index is outside its owned row lifetime')
                              const index = await PackedIdbJsonIndex.open(owner, view, field)
                              indexes.add(index)
                              try {
                                active()
                                if (rowOwner !== token) throw new Error('BRC-38 IDB row lifetime changed')
                                const currentIndex = <T>(work: () => Promise<T>): Promise<T> =>
                                  sourceOperation(async () => {
                                    active()
                                    if (!reading || rowOwner !== token)
                                      throw new Error('BRC-38 IDB JSON index row lifetime changed')
                                    const value = await work()
                                    active()
                                    if (!reading || rowOwner !== token)
                                      throw new Error('BRC-38 IDB JSON index row lifetime changed')
                                    return value
                                  })
                                return {
                                  put: (offset: number, selected: Brc38JsonMember) => {
                                    const member = {
                                      key: selected.key,
                                      keyOffset: selected.keyOffset,
                                      start: selected.start,
                                      end: selected.end
                                    }
                                    return currentIndex(() => awaitFromSync(() => index.put(offset, member)))
                                  },
                                  seal: () => currentIndex(() => awaitFromSync(() => index.seal())),
                                  lookup: (offset: number, key: string) =>
                                    currentIndex(() => awaitFromSync(() => index.lookup(offset, key))),
                                  nextEntry: (offset: number, after?: string) =>
                                    currentIndex(() => awaitFromSync(() => index.nextEntry(offset, after))),
                                  entries: async function* (offset: number) {
                                    const iterator = index.entries(offset)
                                    try {
                                      for (;;) {
                                        const next = await currentIndex(() => awaitFromSync(() => iterator.next()))
                                        if (next.done) return
                                        yield next.value
                                      }
                                    } finally {
                                      await iterator.return(undefined)
                                    }
                                  },
                                  close() {
                                    return mapAwaitFromSync(
                                      () => index.close(),
                                      () => {
                                        indexes.delete(index)
                                      }
                                    )
                                  }
                                }
                              } catch (error_) {
                                try {
                                  await index.close()
                                  indexes.delete(index)
                                } catch (error__) {
                                  throw new AggregateError(
                                    [error_, error__],
                                    'BRC-38 IDB index opening and cleanup failed',
                                    { cause: error_ }
                                  )
                                }
                                throw error_
                              }
                            })
                        })
                      else refs[name] = Object.freeze({ length: field.bytes, sha256: field.sha256, read })
                    }
                    try {
                      yield {
                        // The encoder projects these captured native fields once. The
                        // ordinary row already spells binary fields as base64.
                        fields: item.fields,
                        binaries: refs,
                        ...(Object.keys(json).length === 0 ? {} : { structured: json })
                      }
                    } finally {
                      rowOwner = undefined
                    }
                  }
                active()
                completed.add(table)
              } finally {
                rowOwner = undefined
                reading = false
              }
            }
          }),
      async validateCompleted() {
        active()
        if (reading || completed.size !== 13) throw new Error('BRC-38 IDB source tables did not complete')
        await view.validateClosure()
        active()
      },
      release
    })
  } catch (error_) {
    try {
      await release()
    } catch (error__) {
      throw new AggregateError([error_, error__], 'BRC-38 IDB source preparation and physical cleanup failed', {
        cause: error_
      })
    }
    throw error_
  }
}
