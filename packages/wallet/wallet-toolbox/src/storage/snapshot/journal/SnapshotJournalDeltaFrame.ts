import type { WalletSnapshotTable } from '../WalletReadSnapshot'
import type { SnapshotJournalDelta, SnapshotJournalDeltaPage } from './SnapshotJournalDeltaPage'
import type { SnapshotJournalMetadata, SnapshotJournalPosition } from './SnapshotJournalPage'
import { compareSnapshotJournalRevisions, snapshotJournalRevision } from './SnapshotJournalRevision'

export const SNAPSHOT_JOURNAL_DELTA_FRAME_BYTES = 1048576

export interface SnapshotJournalDeltaFrameContext {
  stream: 'scope' | 'physical'
  tableId: number
}

const tables: ReadonlyArray<readonly [WalletSnapshotTable, readonly string[]]> = [
  ['transactions', ['transactionId']],
  ['outputs', ['outputId']],
  ['certificates', ['certificateId']],
  ['txLabels', ['txLabelId']],
  ['outputBaskets', ['basketId']],
  ['outputTags', ['outputTagId']],
  ['commissions', ['commissionId']],
  ['syncStates', ['syncStateId']],
  ['provenTxs', ['provenTxId']],
  ['provenTxReqs', ['provenTxReqId']],
  ['txLabelMaps', ['txLabelId', 'transactionId']],
  ['outputTagMaps', ['outputTagId', 'outputId']],
  ['certificateFields', ['certificateId', 'fieldName']]
]

type Cell = [string, string, string | number | boolean | null]

const typedArrayByteLength = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype),
  'byteLength'
)?.get

function binaryLength(value: Uint8Array): number {
  if (typedArrayByteLength === undefined) invalid()
  return typedArrayByteLength.call(value) as number
}

function invalid(): never {
  throw new TypeError('Invalid raw snapshot journal delta frame')
}

function integer(value: unknown, minimum: number, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) invalid()
  return value
}

function text(value: unknown, maximum: number): string {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > maximum) invalid()
  if (Buffer.from(value, 'utf8').toString('utf8') !== value) invalid()
  return value
}

/** Read own data descriptors so framing never invokes caller-supplied getters. */
function record(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = []
): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid()
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== null && prototype !== Object.prototype) invalid()
  const keys = Reflect.ownKeys(value)
  if (keys.length > required.length + optional.length || keys.some(key => typeof key !== 'string')) invalid()
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (
    required.some(key => !Object.hasOwn(descriptors, key)) ||
    keys.some(key => !required.includes(key as string) && !optional.includes(key as string)) ||
    Object.values(descriptors).some(property => !property.enumerable || !Object.hasOwn(property, 'value'))
  )
    invalid()
  return Object.fromEntries(Object.entries(descriptors).map(([key, property]) => [key, property.value]))
}

function array(value: unknown, maximum: number): unknown[] {
  if (!Array.isArray(value) || value.length > maximum || Object.getPrototypeOf(value) !== Array.prototype) invalid()
  const keys = Reflect.ownKeys(value)
  if (keys.length !== value.length + 1) invalid()
  const result: unknown[] = []
  for (let index = 0; index < value.length; index++) {
    const property = Object.getOwnPropertyDescriptor(value, String(index))
    if (property === undefined || !property.enumerable || !Object.hasOwn(property, 'value')) invalid()
    result.push(property.value)
  }
  return result
}

function context(value: SnapshotJournalDeltaFrameContext): SnapshotJournalDeltaFrameContext {
  const owned = record(value, ['stream', 'tableId'])
  if (owned.stream !== 'scope' && owned.stream !== 'physical') invalid()
  const tableId = integer(owned.tableId, 0, 12)
  if (owned.stream === 'physical' && tableId !== 8 && tableId !== 9) invalid()
  return { stream: owned.stream, tableId }
}

function position(value: unknown, tableId: number): SnapshotJournalPosition {
  const row = record(value, ['revision', 'id1', 'id2', 'exactText'])
  const revision = snapshotJournalRevision(row.revision)
  if (revision === '0') invalid()
  const id1 = integer(row.id1, tableId === 7 ? -Number.MAX_SAFE_INTEGER : 1),
    id2 = integer(row.id2, 0)
  const exactText = text(row.exactText, 400)
  if (tableId === 12 ? id2 !== 0 : exactText !== '' || (tableId >= 10 ? id2 < 1 : id2 !== 0)) invalid()
  return { revision, id1, id2, exactText }
}

function compare(left: SnapshotJournalPosition, right: SnapshotJournalPosition): number {
  return (
    compareSnapshotJournalRevisions(left.revision, right.revision) ||
    left.id1 - right.id1 ||
    left.id2 - right.id2 ||
    Buffer.compare(Buffer.from(left.exactText, 'utf8'), Buffer.from(right.exactText, 'utf8'))
  )
}

function metadata(value: unknown, bound: SnapshotJournalDeltaFrameContext): SnapshotJournalMetadata {
  const row = record(value, ['revision', 'id1', 'id2', 'exactText', 'present'], ['generation'])
  const result: SnapshotJournalMetadata = {
    ...position(Object.fromEntries(['revision', 'id1', 'id2', 'exactText'].map(key => [key, row[key]])), bound.tableId),
    present: row.present as boolean
  }
  if (typeof row.present !== 'boolean') invalid()
  if (bound.stream === 'scope') {
    if (Object.hasOwn(row, 'generation')) invalid()
  } else {
    const generation = snapshotJournalRevision(row.generation)
    if (generation === '0' || compareSnapshotJournalRevisions(generation, result.revision) > 0) invalid()
    result.generation = generation
  }
  return result
}

function rowEntries(value: unknown): Array<[string, unknown]> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid()
  const keys = Reflect.ownKeys(value)
  if (keys.length === 0 || keys.length > 64 || keys.some(key => typeof key !== 'string')) invalid()
  const owned = record(value, keys as string[])
  return Object.entries(owned).map(([name, cell]) => {
    if (text(name, 128) === '') invalid()
    return [name, cell]
  })
}

function identity(row: Record<string, unknown>, meta: SnapshotJournalMetadata, tableId: number): void {
  const keys = tables[tableId][1]
  const values = tableId === 12 ? [meta.id1, meta.exactText] : [meta.id1, meta.id2]
  if (keys.some((key, index) => !Object.hasOwn(row, key) || row[key] !== values[index])) invalid()
}

function signedInteger(value: unknown): bigint {
  if (typeof value !== 'string' || !/^(?:0|-?[1-9]\d{0,18})$/.test(value)) invalid()
  const number = BigInt(value)
  if (number < -9223372036854775808n || number > 9223372036854775807n) invalid()
  return number
}

/** The private format carries raw SQL cells, including nulls; it is not the
 * normalized public snapshot archive format. Neither framing nor a digest proves
 * source schema/generation, a receipt, profile membership or write authority. */
export function encodeSnapshotJournalDeltaFrame(
  input: SnapshotJournalDeltaPage,
  inputContext: SnapshotJournalDeltaFrameContext
): Uint8Array {
  const bound = context(inputContext)
  const page = record(input, ['table', 'changes', 'examined', 'payloadBytes', 'complete'], ['after'])
  const changes = array(page.changes, 256)
  const examined = integer(page.examined, 0, 256)
  integer(page.payloadBytes, 0, 16777216)
  if (
    page.table !== tables[bound.tableId][0] ||
    typeof page.complete !== 'boolean' ||
    changes.length > examined ||
    (bound.stream === 'scope' && changes.length !== examined) ||
    (examined === 0 && !page.complete)
  )
    invalid()
  const after = Object.hasOwn(page, 'after') ? position(page.after, bound.tableId) : undefined
  if (examined > 0 && after === undefined) invalid()
  let budget = 1024,
    binaryFields = 0
  const charge = (amount: number): void => {
    budget += amount
    if (!Number.isSafeInteger(budget) || budget > SNAPSHOT_JOURNAL_DELTA_FRAME_BYTES) invalid()
  }
  if (after !== undefined) charge(6 * Buffer.byteLength(after.exactText, 'utf8'))
  const parts: Uint8Array[] = []
  let previous: SnapshotJournalMetadata | undefined
  // Validate and precharge every cell before allocating any payload copy/frame.
  const prepared = changes.map(change => {
    const entry = record(change, ['metadata', 'present'], ['row'])
    const meta = metadata(entry.metadata, bound)
    if (entry.present !== meta.present || (previous !== undefined && compare(previous, meta) >= 0)) invalid()
    previous = meta
    charge(512 + 6 * Buffer.byteLength(meta.exactText, 'utf8'))
    if (!meta.present) {
      if (Object.hasOwn(entry, 'row')) invalid()
      return { metadata: meta, present: false as const }
    }
    const entries = rowEntries(entry.row)
    identity(Object.fromEntries(entries), meta, bound.tableId)
    const cells = entries.map(([name, value]): Cell | [string, 'pendingBytes', Uint8Array] => {
      charge(256 + 6 * Buffer.byteLength(name, 'utf8'))
      if (value === null) return [name, 'null', null]
      if (typeof value === 'boolean') return [name, 'boolean', value]
      if (typeof value === 'number') {
        if (!Number.isFinite(value)) invalid()
        return Object.is(value, -0) ? [name, 'negativeZero', null] : [name, 'number', value]
      }
      if (typeof value === 'bigint') {
        if (value < -9223372036854775808n || value > 9223372036854775807n) invalid()
        const decimal = value.toString()
        signedInteger(decimal)
        return [name, 'bigint', decimal]
      }
      if (typeof value === 'string') {
        // Charge before UTF-8 validation can allocate a buffer.
        charge(6 * Buffer.byteLength(value, 'utf8'))
        return [name, 'string', text(value, SNAPSHOT_JOURNAL_DELTA_FRAME_BYTES)]
      }
      if (value instanceof Date) {
        const time = Date.prototype.getTime.call(value)
        if (!Number.isFinite(time)) invalid()
        return [name, 'date', new Date(time).toISOString()]
      }
      if (value instanceof Uint8Array) {
        charge(binaryLength(value))
        if (++binaryFields > 4096) invalid()
        return [name, 'pendingBytes', value]
      }
      return invalid()
    })
    return { metadata: meta, present: true as const, row: cells }
  })
  if (
    previous !== undefined &&
    (after === undefined ||
      compare(previous, after) > 0 ||
      (bound.stream === 'scope' && compare(previous, after) !== 0))
  )
    invalid()
  const encodedChanges = prepared.map(entry =>
    !entry.present
      ? entry
      : {
          ...entry,
          row: entry.row.map(cell => {
            if (cell[1] !== 'pendingBytes') return cell
            const bytes = new Uint8Array(cell[2] as Uint8Array)
            parts.push(bytes)
            return [cell[0], 'bytes', bytes.byteLength]
          })
        }
  )
  const header = new TextEncoder().encode(
    JSON.stringify({
      version: 1,
      ...bound,
      ...page,
      changes: encodedChanges,
      ...(after === undefined ? {} : { after })
    })
  )
  const length = 4 + header.byteLength + parts.reduce((sum, part) => sum + part.byteLength, 0)
  if (length > budget || length > SNAPSHOT_JOURNAL_DELTA_FRAME_BYTES) invalid()
  const frame = new Uint8Array(length)
  new DataView(frame.buffer).setUint32(0, header.byteLength, false)
  frame.set(header, 4)
  let offset = 4 + header.byteLength
  for (const part of parts) {
    frame.set(part, offset)
    offset += part.byteLength
  }
  return frame
}

/** Decode a bounded closed envelope. Returned cells own their bytes/dates;
 * callers must separately verify the authenticated receipt and interval. */
export function decodeSnapshotJournalDeltaFrame(
  frame: Uint8Array,
  inputContext: SnapshotJournalDeltaFrameContext
): SnapshotJournalDeltaPage {
  const bound = context(inputContext)
  if (
    !(frame instanceof Uint8Array) ||
    binaryLength(frame) < 4 ||
    binaryLength(frame) > SNAPSHOT_JOURNAL_DELTA_FRAME_BYTES
  )
    invalid()
  // Own the bounded view before reading header offsets or any overridable fields.
  frame = new Uint8Array(frame)
  const headerLength = new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(0, false)
  if (headerLength > frame.byteLength - 4) invalid()
  // Plain JSON deliberately avoids generic binary-tag revival and remote paths.
  const header = record(
    JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(frame.subarray(4, 4 + headerLength))),
    ['version', 'stream', 'tableId', 'table', 'changes', 'examined', 'payloadBytes', 'complete'],
    ['after']
  )
  if (header.version !== 1 || header.stream !== bound.stream || header.tableId !== bound.tableId) invalid()
  let offset = 4 + headerLength,
    binaryFields = 0
  const changes: SnapshotJournalDelta[] = array(header.changes, 256).map(change => {
    const entry = record(change, ['metadata', 'present'], ['row'])
    const meta = metadata(entry.metadata, bound)
    if (entry.present !== meta.present) invalid()
    if (!meta.present) {
      if (Object.hasOwn(entry, 'row')) invalid()
      return { metadata: meta, present: false }
    }
    const names = new Set<string>()
    const cells = array(entry.row, 64).map(raw => {
      const cell = array(raw, 3)
      if (cell.length !== 3) invalid()
      const name = text(cell[0], 128)
      if (name === '' || names.has(name)) invalid()
      names.add(name)
      const value = cell[2]
      let decoded: unknown
      switch (cell[1]) {
        case 'null':
          if (value !== null) invalid()
          decoded = null
          break
        case 'negativeZero':
          if (value !== null) invalid()
          decoded = -0
          break
        case 'boolean':
          if (typeof value !== 'boolean') invalid()
          decoded = value
          break
        case 'number':
          if (typeof value !== 'number' || !Number.isFinite(value) || Object.is(value, -0)) invalid()
          decoded = value
          break
        case 'string':
          decoded = text(value, SNAPSHOT_JOURNAL_DELTA_FRAME_BYTES)
          break
        case 'bigint':
          decoded = signedInteger(value)
          break
        case 'date': {
          const date = new Date(text(value, 32))
          if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) invalid()
          decoded = date
          break
        }
        case 'bytes': {
          const length = integer(value, 0, frame.byteLength - offset)
          if (++binaryFields > 4096) invalid()
          decoded = new Uint8Array(frame.subarray(offset, offset + length))
          offset += length
          break
        }
        default:
          invalid()
      }
      return [name, decoded] as [string, unknown]
    })
    const row = Object.fromEntries(cells)
    identity(row, meta, bound.tableId)
    return { metadata: meta, present: true, row }
  })
  if (offset !== frame.byteLength) invalid()
  const page: SnapshotJournalDeltaPage = {
    table: header.table as WalletSnapshotTable,
    changes,
    examined: header.examined as number,
    payloadBytes: header.payloadBytes as number,
    complete: header.complete as boolean,
    ...(Object.hasOwn(header, 'after') ? { after: position(header.after, bound.tableId) } : {})
  }
  // Apply identical shape, order, key, cursor and allocation bounds at both boundaries.
  encodeSnapshotJournalDeltaFrame(page, bound)
  return page
}
