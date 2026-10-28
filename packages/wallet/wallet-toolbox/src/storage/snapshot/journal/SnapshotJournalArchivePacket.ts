import type { SnapshotJournalHashedFieldPage, SnapshotJournalHashedFieldDescriptor } from './SnapshotJournalFieldTypes'
import { brc38Utf8ByteLength } from '../../portable/Brc38Utf8Length'
import { sha256 } from '@bsv/sdk/primitives/Hash'
import { toHex } from '@bsv/sdk/primitives/utils'
import { SnapshotResourceLimitError } from '../SnapshotResourceLimitError'
import {
  decodeSnapshotJournalFieldFrame,
  encodeSnapshotJournalFieldFrame,
  decodeSnapshotJournalDeltaFrame,
  encodeSnapshotJournalDeltaFrame,
  type SnapshotJournalDeltaFrameContext
} from './SnapshotJournalDeltaFrame'
import {
  snapshotJournalDataDigest,
  snapshotJournalDataRecord,
  snapshotJournalDataText
} from './SnapshotJournalReceiptData'
import {
  compareSnapshotJournalRevisions,
  snapshotJournalRevision,
  type SnapshotJournalRevision
} from './SnapshotJournalRevision'
import type {
  SnapshotJournalDeltaPage,
  SnapshotJournalIdentityTable,
  SnapshotJournalSourceIdentity,
  SnapshotJournalSourceNaturalKey
} from './SnapshotJournalTypes'

/** A distinct transport encoding, never a complete BRC-38 row archive. Identity
 * prefixes stream separately so a notification set cannot become one JS map. */
export const snapshotJournalArchiveEncoding = 'wallet-journal-packets/1'
export const snapshotJournalArchivePacketBytes = 1048576
export type SnapshotJournalArchivePacket =
  | {
      kind: 'identities'
      frameDigest: string
      changeIndex: number
      identities: ReadonlyMap<string, SnapshotJournalSourceIdentity>
    }
  | { kind: 'identity-groups'; frameDigest: string; groups: ReadonlyArray<SnapshotJournalArchiveIdentityGroup> }
  | { kind: 'frame'; frameDigest: string; page: SnapshotJournalDeltaPage }

export interface SnapshotJournalArchiveIdentityGroup {
  readonly changeIndex: number
  readonly identities: ReadonlyMap<string, SnapshotJournalSourceIdentity>
}

function invalid(): never {
  throw new TypeError('Invalid snapshot journal archive packet DATA')
}
function integer(value: unknown, minimum: number, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) invalid()
  return value
}
function array(input: unknown, maximum: number): unknown[] {
  if (!Array.isArray(input)) invalid()
  const length = Object.getOwnPropertyDescriptor(input, 'length')?.value
  integer(length, 0, maximum)
  if (Reflect.ownKeys(input).length !== length + 1) invalid()
  return Array.from({ length }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(input, String(index))
    if (descriptor === undefined || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) invalid()
    return descriptor.value
  })
}
function naturalKey(input: unknown, tableId: SnapshotJournalIdentityTable): Readonly<SnapshotJournalSourceNaturalKey> {
  const fields: Record<SnapshotJournalIdentityTable, readonly string[]> = {
    0: ['reference'],
    1: ['transactionId', 'vout'],
    2: ['serialNumber', 'certifier'],
    3: ['label'],
    4: ['name'],
    5: ['tag'],
    6: ['transactionId'],
    8: ['txid'],
    9: ['txid']
  }
  const names = [...fields[tableId]]
  if (tableId === 0 && input !== null && typeof input === 'object' && Object.hasOwn(input, 'txid')) names.push('txid')
  const data = snapshotJournalDataRecord(input, ['tableId', ...names])
  if (data.tableId !== tableId) invalid()
  const output: Record<string, string | number> = { tableId }
  for (const name of names) {
    const value = data[name]
    if (tableId === 0 && name === 'txid' && value === undefined) continue
    output[name] =
      name === 'transactionId' || name === 'vout'
        ? integer(value, name === 'vout' ? 0 : 1)
        : snapshotJournalDataText(value, 1200)
  }
  if (brc38Utf8ByteLength(JSON.stringify(output)) > 8192) invalid()
  return Object.freeze(output) as unknown as Readonly<SnapshotJournalSourceNaturalKey>
}
function identity(input: unknown, high: SnapshotJournalRevision): SnapshotJournalSourceIdentity {
  const data = snapshotJournalDataRecord(input, [
    'tableId',
    'incomingId',
    'generation',
    'revision',
    'naturalIdentity',
    'naturalKey',
    'required'
  ])
  if (![0, 1, 2, 3, 4, 5, 6, 8, 9].includes(data.tableId as number) || typeof data.required !== 'boolean') invalid()
  const tableId = data.tableId as SnapshotJournalIdentityTable,
    generation = snapshotJournalRevision(data.generation),
    revision = snapshotJournalRevision(data.revision)
  if (
    generation === '0' ||
    compareSnapshotJournalRevisions(generation, revision) > 0 ||
    compareSnapshotJournalRevisions(revision, high) > 0
  )
    invalid()
  return Object.freeze({
    tableId,
    incomingId: integer(data.incomingId, 1),
    generation,
    revision,
    naturalIdentity: snapshotJournalDataDigest(data.naturalIdentity),
    naturalKey: naturalKey(data.naturalKey, tableId),
    required: data.required
  })
}
function context(input: SnapshotJournalDeltaFrameContext): SnapshotJournalDeltaFrameContext {
  const data = snapshotJournalDataRecord(input, ['stream', 'tableId'])
  if (data.stream !== 'scope' && data.stream !== 'physical') invalid()
  const tableId = integer(data.tableId, 0, 12)
  if (data.stream === 'physical' && tableId !== 8 && tableId !== 9) invalid()
  return { stream: data.stream, tableId }
}
function envelope(header: object, frame: Uint8Array = new Uint8Array()): Uint8Array {
  const bytes = new TextEncoder().encode(JSON.stringify(header)),
    length = 4 + bytes.byteLength + frame.byteLength
  if (length > snapshotJournalArchivePacketBytes)
    throw new SnapshotResourceLimitError('Journal archive packet exceeds its negotiated byte bound')
  const result = new Uint8Array(length)
  new DataView(result.buffer).setUint32(0, bytes.byteLength, false)
  result.set(bytes, 4)
  result.set(frame, 4 + bytes.byteLength)
  return result
}

export function encodeSnapshotJournalArchiveIdentities(
  inputContext: SnapshotJournalDeltaFrameContext,
  inputDigest: string,
  inputChangeIndex: number,
  input: ReadonlyMap<string, SnapshotJournalSourceIdentity>,
  highWater: SnapshotJournalRevision
): Uint8Array {
  const bound = context(inputContext),
    frameDigest = snapshotJournalDataDigest(inputDigest),
    changeIndex = integer(inputChangeIndex, 0, 255),
    high = snapshotJournalRevision(highWater)
  const size = Object.getOwnPropertyDescriptor(Map.prototype, 'size')?.get
  if (!(input instanceof Map) || size === undefined || size.call(input) > 128) invalid()
  const entries: Array<[string, SnapshotJournalSourceIdentity]> = Array.from(Map.prototype.entries.call(input))
  const identities = entries.map(([key, value]) => {
    const owned = identity(value, high)
    if (key !== owned.tableId + ':' + owned.incomingId) invalid()
    return owned
  })
  return envelope({ version: 1, kind: 'identities', ...bound, frameDigest, changeIndex, identities })
}

/** Bounded groups coalesce small callbacks without materializing a wallet map.
 * A large notification batch still flushes at128identities/oneMiB. */
export function encodeSnapshotJournalArchiveIdentityGroups(
  inputContext: SnapshotJournalDeltaFrameContext,
  inputDigest: string,
  input: readonly SnapshotJournalArchiveIdentityGroup[],
  highWater: SnapshotJournalRevision
): Uint8Array {
  const bound = context(inputContext),
    frameDigest = snapshotJournalDataDigest(inputDigest),
    high = snapshotJournalRevision(highWater)
  let count = 0
  const groups = array(input, 128).map(raw => {
    const group = snapshotJournalDataRecord(raw, ['changeIndex', 'identities']),
      changeIndex = integer(group.changeIndex, 0, 255),
      map = group.identities,
      size = Object.getOwnPropertyDescriptor(Map.prototype, 'size')?.get
    if (!(map instanceof Map) || size === undefined) invalid()
    count += size.call(map)
    if (count > 128) throw new SnapshotResourceLimitError('Journal identity group bound reached')
    const entries: Array<[string, SnapshotJournalSourceIdentity]> = Array.from(Map.prototype.entries.call(map)),
      identities = entries.map(([key, value]) => {
        const owned = identity(value, high)
        if (key !== owned.tableId + ':' + owned.incomingId) invalid()
        return owned
      })
    return { changeIndex, identities }
  })
  return envelope({ version: 1, kind: 'identity-groups', ...bound, frameDigest, groups })
}

export function encodeSnapshotJournalArchiveFrame(
  inputContext: SnapshotJournalDeltaFrameContext,
  page: SnapshotJournalDeltaPage
): Uint8Array {
  const bound = context(inputContext),
    frame = encodeSnapshotJournalDeltaFrame(page, bound)
  return envelope({ version: 1, kind: 'frame', ...bound, frameDigest: toHex(sha256(frame)) }, frame)
}

/** Decode one bounded prefix or frame; returned maps/cells are owned copies.
 * This parser supplies no source or target authorization and admits no writer. */
export function decodeSnapshotJournalArchivePacket(
  input: Uint8Array,
  inputContext: SnapshotJournalDeltaFrameContext,
  highWater: SnapshotJournalRevision
): SnapshotJournalArchivePacket {
  const bound = context(inputContext),
    high = snapshotJournalRevision(highWater)
  const byteLength = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), 'byteLength')?.get
  if (!(input instanceof Uint8Array) || byteLength === undefined) invalid()
  const size = byteLength.call(input) as number
  if (size < 4 || size > snapshotJournalArchivePacketBytes) invalid()
  const bytes = new Uint8Array(input),
    length = new DataView(bytes.buffer).getUint32(0, false)
  if (length > bytes.byteLength - 4) invalid()
  const raw: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(4, 4 + length)))
  if (raw === null || typeof raw !== 'object') invalid()
  const kind = Object.getOwnPropertyDescriptor(raw, 'kind')?.value,
    row = snapshotJournalDataRecord(raw, [
      'version',
      'kind',
      'stream',
      'tableId',
      'frameDigest',
      ...(kind === 'identities' ? ['changeIndex', 'identities'] : kind === 'identity-groups' ? ['groups'] : [])
    ]),
    frameDigest = snapshotJournalDataDigest(row.frameDigest)
  if (row.version !== 1 || row.stream !== bound.stream || row.tableId !== bound.tableId) invalid()
  if (kind === 'identities') {
    if (bytes.byteLength !== 4 + length) invalid()
    const changeIndex = integer(row.changeIndex, 0, 255),
      identities = new Map<string, SnapshotJournalSourceIdentity>()
    for (const input of array(row.identities, 128)) {
      const owned = identity(input, high),
        key = owned.tableId + ':' + owned.incomingId
      if (identities.has(key)) invalid()
      identities.set(key, owned)
    }
    return { kind, frameDigest, changeIndex, identities }
  }
  if (kind === 'identity-groups') {
    if (bytes.byteLength !== 4 + length) invalid()
    let count = 0
    const groups = array(row.groups, 128).map(raw => {
      const group = snapshotJournalDataRecord(raw, ['changeIndex', 'identities']),
        changeIndex = integer(group.changeIndex, 0, 255),
        identities = new Map<string, SnapshotJournalSourceIdentity>()
      for (const item of array(group.identities, 128)) {
        if (++count > 128) invalid()
        const owned = identity(item, high),
          key = owned.tableId + ':' + owned.incomingId
        if (identities.has(key)) invalid()
        identities.set(key, owned)
      }
      return Object.freeze({ changeIndex, identities })
    })
    return { kind, frameDigest, groups: Object.freeze(groups) }
  }
  if (kind !== 'frame') invalid()
  const frame = bytes.subarray(4 + length)
  if (toHex(sha256(frame)) !== frameDigest) invalid()
  const page = decodeSnapshotJournalDeltaFrame(frame, bound)
  if (
    page.changes.some(change => compareSnapshotJournalRevisions(change.metadata.revision, high) > 0) ||
    (page.after !== undefined && compareSnapshotJournalRevisions(page.after.revision, high) > 0)
  )
    invalid()
  return { kind, frameDigest, page }
}

/** Separately negotiated field encoding. Version-one packet parsers must refuse
 * these envelopes rather than silently treat metadata as complete SQL rows. */
export const snapshotJournalFieldArchiveEncoding = 'wallet-journal-fields/1'
export type SnapshotJournalFieldArchivePacket =
  | { readonly kind: 'field-frame'; readonly frameDigest: string; readonly page: SnapshotJournalHashedFieldPage }
  | {
      readonly kind: 'field-identities'
      readonly frameDigest: string
      readonly changeIndex: number
      readonly identities: ReadonlyMap<string, SnapshotJournalSourceIdentity>
    }
  | {
      readonly kind: 'field-content'
      readonly frameDigest: string
      readonly changeIndex: number
      readonly field: string
      readonly descriptor: Readonly<SnapshotJournalHashedFieldDescriptor>
      readonly offset: number
      readonly bytes: Uint8Array
    }

export function encodeSnapshotJournalFieldArchiveFrame(
  inputContext: SnapshotJournalDeltaFrameContext,
  page: SnapshotJournalHashedFieldPage
): Uint8Array {
  const bound = context(inputContext),
    frame = encodeSnapshotJournalFieldFrame(page, bound)
  return envelope({ version: 2, kind: 'field-frame', ...bound, frameDigest: toHex(sha256(frame)) }, frame)
}
export function encodeSnapshotJournalFieldArchiveIdentities(
  inputContext: SnapshotJournalDeltaFrameContext,
  inputDigest: string,
  changeIndex: number,
  input: ReadonlyMap<string, SnapshotJournalSourceIdentity>,
  highWater: SnapshotJournalRevision
): Uint8Array {
  const bound = context(inputContext),
    frameDigest = snapshotJournalDataDigest(inputDigest),
    bytes = encodeSnapshotJournalArchiveIdentities(bound, frameDigest, changeIndex, input, highWater)
  return envelope({ version: 2, kind: 'field-identities', ...bound, frameDigest }, bytes)
}
function fieldContent(input: unknown) {
  const data = snapshotJournalDataRecord(input, ['changeIndex', 'field', 'descriptor', 'offset']),
    descriptor = snapshotJournalDataRecord(data.descriptor, ['kind', 'bytes', 'sha256'])
  if (descriptor.kind !== 'binary' && descriptor.kind !== 'utf8') invalid()
  return {
    changeIndex: integer(data.changeIndex, 0, 255),
    field: snapshotJournalDataText(data.field, 128, 1),
    offset: integer(data.offset, 0, 1000000000),
    descriptor: Object.freeze({
      kind: descriptor.kind,
      bytes: integer(descriptor.bytes, 0, 1000000000),
      sha256: snapshotJournalDataDigest(descriptor.sha256)
    })
  }
}
function contentSize(field: ReturnType<typeof fieldContent>, size: number): void {
  if (
    size > 65536 ||
    size < (field.descriptor.bytes === 0 ? 0 : 1) ||
    field.offset > field.descriptor.bytes - size ||
    (field.descriptor.bytes === 0 &&
      (field.offset !== 0 || field.descriptor.sha256 !== toHex(sha256(new Uint8Array()))))
  )
    invalid()
}
export function encodeSnapshotJournalFieldArchiveContent(
  inputContext: SnapshotJournalDeltaFrameContext,
  inputDigest: string,
  inputChangeIndex: number,
  inputField: string,
  inputDescriptor: Readonly<SnapshotJournalHashedFieldDescriptor>,
  inputOffset: number,
  inputBytes: Uint8Array
): Uint8Array {
  const bound = context(inputContext),
    frameDigest = snapshotJournalDataDigest(inputDigest),
    field = fieldContent({
      changeIndex: inputChangeIndex,
      field: inputField,
      descriptor: inputDescriptor,
      offset: inputOffset
    }),
    getSize = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), 'byteLength')?.get
  if (!(inputBytes instanceof Uint8Array) || getSize === undefined) invalid()
  contentSize(field, getSize.call(inputBytes))
  return envelope({ version: 2, kind: 'field-content', ...bound, frameDigest, ...field }, new Uint8Array(inputBytes))
}

/** Closed bounded DATA parser only. Content packets still need actual archive
 * inclusion, ordered complete extent coverage and a whole-field hash check.
 * These descriptors never enroll a source, target writer or native pointer. */
export function decodeSnapshotJournalFieldArchivePacket(
  input: Uint8Array,
  inputContext: SnapshotJournalDeltaFrameContext,
  highWater: SnapshotJournalRevision
): SnapshotJournalFieldArchivePacket {
  const bound = context(inputContext),
    high = snapshotJournalRevision(highWater),
    getSize = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), 'byteLength')?.get
  if (!(input instanceof Uint8Array) || getSize === undefined) invalid()
  const size = getSize.call(input) as number
  if (size < 4 || size > snapshotJournalArchivePacketBytes) invalid()
  const bytes = new Uint8Array(input),
    length = new DataView(bytes.buffer).getUint32(0, false)
  if (length > bytes.length - 4) invalid()
  const raw: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(4, 4 + length)))
  if (raw === null || typeof raw !== 'object') invalid()
  const kind = Object.getOwnPropertyDescriptor(raw, 'kind')?.value,
    row = snapshotJournalDataRecord(raw, [
      'version',
      'kind',
      'stream',
      'tableId',
      'frameDigest',
      ...(kind === 'field-content' ? ['changeIndex', 'field', 'descriptor', 'offset'] : [])
    ]),
    frameDigest = snapshotJournalDataDigest(row.frameDigest),
    body = bytes.subarray(4 + length)
  if (row.version !== 2 || row.stream !== bound.stream || row.tableId !== bound.tableId) invalid()
  if (kind === 'field-frame') {
    if (toHex(sha256(body)) !== frameDigest) invalid()
    const page = decodeSnapshotJournalFieldFrame(body, bound)
    if (
      page.changes.some(change => compareSnapshotJournalRevisions(change.metadata.revision, high) > 0) ||
      (page.after !== undefined && compareSnapshotJournalRevisions(page.after.revision, high) > 0)
    )
      invalid()
    return { kind, frameDigest, page }
  }
  if (kind === 'field-identities') {
    const packet = decodeSnapshotJournalArchivePacket(body, bound, high)
    if (packet.kind !== 'identities' || packet.frameDigest !== frameDigest) invalid()
    return { kind, frameDigest, changeIndex: packet.changeIndex, identities: packet.identities }
  }
  if (kind !== 'field-content') invalid()
  const field = fieldContent(
    Object.fromEntries(['changeIndex', 'field', 'descriptor', 'offset'].map(key => [key, row[key]]))
  )
  contentSize(field, body.length)
  return { kind, frameDigest, ...field, bytes: new Uint8Array(body) }
}

export interface SnapshotJournalFieldContentIndex {
  readonly frameDigest: string
  readonly changeIndex: number
  readonly field: string
  readonly descriptor: Readonly<SnapshotJournalHashedFieldDescriptor>
  readonly offset: number
  readonly length: number
}
/** Closed integrity/index DATA only. It can locate a required packet, never
 * authorize cached bytes, a source read, a pointer attachment or an ACK. */
export function parseSnapshotJournalFieldContentIndex(input: unknown): Readonly<SnapshotJournalFieldContentIndex> {
  const row = snapshotJournalDataRecord(input, [
      'frameDigest',
      'changeIndex',
      'field',
      'descriptor',
      'offset',
      'length'
    ]),
    content = fieldContent(
      Object.fromEntries(['changeIndex', 'field', 'descriptor', 'offset'].map(key => [key, row[key]]))
    ),
    length = integer(row.length, 0, 65536)
  contentSize(content, length)
  return Object.freeze({ frameDigest: snapshotJournalDataDigest(row.frameDigest), ...content, length })
}

/** Actual stored packet header, loaded through a bounded SQL prefix. The
 * complete packet hash is still checked on read and bound into its directory.
 * No payload bytes are fetched merely to construct this content index. */
export function snapshotJournalFieldContentIndexFromHeader(
  input: Uint8Array,
  packetBytes: number,
  inputContext: SnapshotJournalDeltaFrameContext
): Readonly<SnapshotJournalFieldContentIndex> {
  const bound = context(inputContext)
  if (
    !(input instanceof Uint8Array) ||
    input.length < 4 ||
    input.length > 4096 ||
    !Number.isSafeInteger(packetBytes) ||
    packetBytes < input.length ||
    packetBytes > snapshotJournalArchivePacketBytes
  )
    invalid()
  const bytes = new Uint8Array(input),
    length = new DataView(bytes.buffer).getUint32(0, false)
  if (length > bytes.length - 4) invalid()
  const row = snapshotJournalDataRecord(
    JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(4, 4 + length))),
    ['version', 'kind', 'stream', 'tableId', 'frameDigest', 'changeIndex', 'field', 'descriptor', 'offset']
  )
  if (row.version !== 2 || row.kind !== 'field-content' || row.stream !== bound.stream || row.tableId !== bound.tableId)
    invalid()
  return parseSnapshotJournalFieldContentIndex({
    ...Object.fromEntries(['frameDigest', 'changeIndex', 'field', 'descriptor', 'offset'].map(key => [key, row[key]])),
    length: packetBytes - 4 - length
  })
}
