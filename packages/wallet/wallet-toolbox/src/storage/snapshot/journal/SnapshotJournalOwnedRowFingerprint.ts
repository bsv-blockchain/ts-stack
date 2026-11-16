import { utf16CodeUnitAt } from '../../../utility/utf16CodeUnitAt'
import { createHash } from 'node:crypto'
import type { SnapshotJournalFieldDescriptor } from './SnapshotJournalFieldTypes'
import type { SnapshotJournalPosition } from './SnapshotJournalTypes'
import type { WalletSnapshotTable } from '../WalletReadSnapshot'

interface PointFields {
  readonly names: readonly string[]
  readonly smallRow: Readonly<Record<string, unknown>>
  readonly fields: Readonly<Record<string, Readonly<SnapshotJournalFieldDescriptor>>>
  readExtent: (field: string, offset: number, length: number) => Promise<Uint8Array>
}
function invalid(): never {
  throw new Error('Actual journal custody field bytes or raw cell differ')
}
function json(value: unknown): string {
  const result = JSON.stringify(value)
  if (typeof result !== 'string') invalid()
  return result
}
function* escaped(value: string): Generator<string> {
  yield '"'
  for (let offset = 0; offset < value.length;) {
    let end = Math.min(value.length, offset + 8192)
    const last = utf16CodeUnitAt(value, end - 1)
    if (end < value.length && last >= 0xd800 && last <= 0xdbff) end--
    const part = value.slice(offset, end),
      bytes = new TextEncoder().encode(part)
    if (new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) !== part) invalid()
    yield json(part).slice(1, -1)
    offset = end
  }
  yield '"'
}
/** Hash the original raw-v1 byte spelling without allocating that frame. The
 * four-byte header length and every SQL cell/type/order remain byte-identical
 * for historical small rows. No larger wire frame is emitted or admitted.
 * Actual TEXT is decoded/escaped in bounded windows; binary parts stay outside
 * the header in the original column order. Returned descriptors are DATA only. */
export async function hashSnapshotJournalOwnedPointFields(
  point: PointFields,
  table: WalletSnapshotTable,
  tableId: number,
  local: Readonly<{ id1: number; id2: number; exactText: string }>
): Promise<{ fingerprint: string; fields: Readonly<Record<string, Readonly<SnapshotJournalFieldDescriptor>>> }> {
  if (point.names.length < 1 || point.names.length > 64 || new Set(point.names).size !== point.names.length) invalid()
  for (const name of point.names) {
    const bytes = new TextEncoder().encode(name)
    if (name === '' || bytes.length > 128 || new TextDecoder('utf-8', { fatal: true }).decode(bytes) !== name) invalid()
  }
  const position: SnapshotJournalPosition = { revision: '1' as SnapshotJournalPosition['revision'], ...local },
    measured: Record<string, Readonly<SnapshotJournalFieldDescriptor>> = Object.create(null)
  const content = async function* (field: string): AsyncGenerator<Uint8Array> {
    const descriptor = point.fields[field]
    if (descriptor === undefined) invalid()
    const hash = createHash('sha256')
    for (let offset = 0; offset < descriptor.bytes;) {
      const amount = Math.min(16384, descriptor.bytes - offset),
        bytes = await point.readExtent(field, offset, amount)
      try {
        if (!(bytes instanceof Uint8Array) || bytes.length !== amount) invalid()
        hash.update(bytes)
        offset += amount
        yield bytes
      } finally {
        bytes.fill(0)
      }
    }
    const eof = await point.readExtent(field, descriptor.bytes, 0)
    if (!(eof instanceof Uint8Array) || eof.length !== 0) invalid()
    const sha256 = hash.digest('hex')
    if (
      (descriptor.sha256 !== undefined && descriptor.sha256 !== sha256) ||
      (measured[field] !== undefined && measured[field].sha256 !== sha256)
    )
      invalid()
    measured[field] = Object.freeze({ ...descriptor, sha256 })
  }
  const header = async function* (): AsyncGenerator<string> {
    yield '{"version":1,"stream":"scope","tableId":' +
      tableId +
      ',"table":' +
      json(table) +
      ',"changes":[{"metadata":' +
      json({ ...position, present: true }) +
      ',"present":true,"row":['
    for (const [index, name] of point.names.entries()) {
      if (index) yield ','
      const descriptor = point.fields[name],
        value = point.smallRow[name]
      yield '[' + json(name) + ','
      if (descriptor !== undefined) {
        if (descriptor.kind === 'binary') yield '"bytes",' + descriptor.bytes
        else {
          if (descriptor.kind !== 'utf8') invalid()
          yield '"string","'
          const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
          for await (const bytes of content(name)) yield json(decoder.decode(bytes, { stream: true })).slice(1, -1)
          yield json(decoder.decode()).slice(1, -1)
          yield '"'
        }
      } else if (value === null) yield '"null",null'
      else if (typeof value === 'boolean') yield '"boolean",' + value
      else if (typeof value === 'number') {
        if (!Number.isFinite(value)) invalid()
        yield Object.is(value, -0) ? '"negativeZero",null' : '"number",' + json(value)
      } else if (typeof value === 'bigint') {
        if (value < -9223372036854775808n || value > 9223372036854775807n) invalid()
        yield '"bigint",' + json(value.toString())
      } else if (typeof value === 'string') {
        yield '"string",'
        yield* escaped(value)
      } else if (value instanceof Date) {
        const time = Date.prototype.getTime.call(value)
        if (!Number.isFinite(time)) invalid()
        yield '"date",' + json(new Date(time).toISOString())
      } else if (value instanceof Uint8Array) yield '"bytes",' + value.byteLength
      else invalid()
      yield ']'
    }
    yield ']}],"examined":1,"payloadBytes":0,"complete":false,"after":' + json(position) + '}'
  }
  let headerBytes = 0
  for await (const part of header()) {
    headerBytes += Buffer.byteLength(part, 'utf8')
    if (!Number.isSafeInteger(headerBytes) || headerBytes > 0xffffffff) invalid()
  }
  const hash = createHash('sha256'),
    prefix = Buffer.alloc(4)
  prefix.writeUInt32BE(headerBytes)
  hash.update(prefix)
  let replayBytes = 0
  for await (const part of header()) {
    replayBytes += Buffer.byteLength(part, 'utf8')
    hash.update(part, 'utf8')
  }
  if (replayBytes !== headerBytes) invalid()
  for (const name of point.names) {
    const descriptor = point.fields[name],
      value = point.smallRow[name]
    if (descriptor?.kind === 'binary') for await (const bytes of content(name)) hash.update(bytes)
    else if (descriptor === undefined && value instanceof Uint8Array) hash.update(value)
  }
  return { fingerprint: hash.digest('hex'), fields: Object.freeze(measured) }
}
