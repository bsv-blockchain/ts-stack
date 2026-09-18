import { Beef, Hash, Transaction, Utils, type LookupAnswer } from '@bsv/sdk'

import { isHashHex, isPlainObject } from './query.js'

const MAX_OUTPOINTS = 100_000

export interface CanonicalMessage {
  messageId: string
  sender: string
  body: string
}

export interface LookupOutpoint {
  txid: string
  outputIndex: number
  context?: number[]
}

/** `SHA-256` of the canonical payload, as lowercase hex. */
export function contentHash(payload: number[]): string {
  return Utils.toHex(Hash.sha256(payload))
}

/** Orders strings by Unicode code point, which differs from UTF-16 order for astral characters. */
export function compareCodePoints(a: string, b: string): number {
  const left = Array.from(a)
  const right = Array.from(b)
  const shared = Math.min(left.length, right.length)
  for (let index = 0; index < shared; index++) {
    const difference = (left[index].codePointAt(0) ?? 0) - (right[index].codePointAt(0) ?? 0)
    if (difference !== 0) return difference
  }
  return left.length - right.length
}

function compareBytes(a: number[], b: number[]): number {
  const shared = Math.min(a.length, b.length)
  for (let index = 0; index < shared; index++) {
    if (a[index] !== b[index]) return a[index] - b[index]
  }
  return a.length - b.length
}

function assertMessage(value: unknown): asserts value is CanonicalMessage {
  if (
    !isPlainObject(value) ||
    typeof value.messageId !== 'string' ||
    typeof value.sender !== 'string' ||
    typeof value.body !== 'string'
  ) {
    throw new TypeError('A message needs string messageId, sender, and body fields')
  }
}

/** Canonical `message-list` payload: UTF-8 JSON, sorted by `messageId`, fixed key order. */
export function encodeMessageList(messages: CanonicalMessage[]): number[] {
  const sorted = [...messages]
  sorted.forEach(assertMessage)
  sorted.sort(
    (left, right) =>
      compareCodePoints(left.messageId, right.messageId) ||
      compareCodePoints(left.sender, right.sender) ||
      compareCodePoints(left.body, right.body)
  )
  const items = sorted.map(
    message =>
      `{"messageId":${JSON.stringify(message.messageId)},` +
      `"sender":${JSON.stringify(message.sender)},"body":${JSON.stringify(message.body)}}`
  )
  return Utils.toArray(`[${items.join(',')}]`, 'utf8')
}

export function decodeMessageList(payload: number[]): CanonicalMessage[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(Utils.toUTF8(payload))
  } catch {
    throw new TypeError('message-list payload is not valid JSON')
  }
  if (!Array.isArray(parsed)) throw new TypeError('message-list payload must be a JSON array')
  return parsed.map(item => {
    assertMessage(item)
    return { messageId: item.messageId, sender: item.sender, body: item.body }
  })
}

function normalizeOutpoint(entry: LookupOutpoint): Required<LookupOutpoint> {
  if (!isHashHex(entry.txid)) throw new TypeError('txid must be 32 bytes of lowercase hex')
  if (!Number.isSafeInteger(entry.outputIndex) || entry.outputIndex < 0) {
    throw new TypeError('outputIndex must be a non-negative integer')
  }
  const context = entry.context ?? []
  if (!context.every(byte => Number.isInteger(byte) && byte >= 0 && byte <= 255)) {
    throw new TypeError('context must be a byte array')
  }
  return { txid: entry.txid, outputIndex: entry.outputIndex, context }
}

/**
 * Canonical `overlay-lookup` payload: the outpoint section of the BRC-24 binary answer,
 * `varint n ‖ [txid(32) ‖ varint outputIndex ‖ varint contextLength ‖ context]*`, sorted and
 * de-duplicated so every honest host produces the same bytes.
 */
export function encodeOutpointList(entries: LookupOutpoint[]): number[] {
  const sorted = entries
    .map(normalizeOutpoint)
    .sort(
      (left, right) =>
        (left.txid < right.txid ? -1 : left.txid > right.txid ? 1 : 0) ||
        left.outputIndex - right.outputIndex ||
        compareBytes(left.context, right.context)
    )
  const unique = sorted.filter((entry, index) => {
    if (index === 0) return true
    const previous = sorted[index - 1]
    return (
      previous.txid !== entry.txid ||
      previous.outputIndex !== entry.outputIndex ||
      compareBytes(previous.context, entry.context) !== 0
    )
  })
  if (unique.length > MAX_OUTPOINTS) throw new RangeError('Too many outpoints')
  const writer = new Utils.Writer()
  writer.writeVarIntNum(unique.length)
  for (const entry of unique) {
    writer.write(Utils.toArray(entry.txid, 'hex'))
    writer.writeVarIntNum(entry.outputIndex)
    writer.writeVarIntNum(entry.context.length)
    writer.write(entry.context)
  }
  return writer.toArray()
}

export function decodeOutpointList(payload: number[]): LookupOutpoint[] {
  const reader = new Utils.Reader(payload)
  const count = reader.readVarIntNum()
  if (!Number.isSafeInteger(count) || count < 0 || count > MAX_OUTPOINTS) {
    throw new TypeError('Outpoint count is out of range')
  }
  const entries: LookupOutpoint[] = []
  for (let index = 0; index < count; index++) {
    const txidBytes = reader.read(32)
    if (txidBytes.length !== 32) throw new TypeError('Outpoint list is truncated')
    const outputIndex = reader.readVarIntNum()
    const contextLength = reader.readVarIntNum()
    if (
      !Number.isSafeInteger(outputIndex) ||
      outputIndex < 0 ||
      !Number.isSafeInteger(contextLength) ||
      contextLength < 0
    ) {
      throw new TypeError('Outpoint list is malformed')
    }
    const context = contextLength > 0 ? reader.read(contextLength) : []
    if (context.length !== contextLength) throw new TypeError('Outpoint list is truncated')
    entries.push(
      contextLength > 0
        ? { txid: Utils.toHex(txidBytes), outputIndex, context }
        : { txid: Utils.toHex(txidBytes), outputIndex }
    )
  }
  if (!reader.eof()) throw new TypeError('Outpoint list has trailing bytes')
  return entries
}

/** Splits an `output-list` into the hashed outpoint section and the self-authenticating BEEF. */
export function canonicalizeLookupAnswer(answer: LookupAnswer): {
  payload: number[]
  supplement: number[]
} {
  const beef = new Beef()
  const entries: LookupOutpoint[] = []
  for (const output of answer.outputs) {
    const transaction = Transaction.fromBEEF(output.beef)
    beef.mergeBeef(output.beef)
    entries.push({
      txid: transaction.id('hex'),
      outputIndex: output.outputIndex,
      context: output.context
    })
  }
  return { payload: encodeOutpointList(entries), supplement: beef.toBinary() }
}

/** Rebuilds a `LookupAnswer`, requiring every hashed outpoint to resolve inside the BEEF. */
export function rebuildLookupAnswer(payload: number[], supplement: number[]): LookupAnswer {
  const entries = decodeOutpointList(payload)
  if (entries.length === 0) return { type: 'output-list', outputs: [] }
  let beef: Beef
  try {
    beef = Beef.fromBinary(supplement)
  } catch {
    throw new TypeError('Lookup supplement is not valid BEEF')
  }
  const atomicByTxid = new Map<string, number[]>()
  const outputs: LookupAnswer['outputs'] = []
  for (const entry of entries) {
    const transaction = beef.findTxid(entry.txid)?.tx
    if (transaction === undefined || transaction.outputs[entry.outputIndex] === undefined) {
      throw new TypeError(`Lookup supplement lacks outpoint ${entry.txid}.${entry.outputIndex}`)
    }
    let atomic = atomicByTxid.get(entry.txid)
    if (atomic === undefined) {
      atomic = beef.toBinaryAtomic(entry.txid)
      atomicByTxid.set(entry.txid, atomic)
    }
    outputs.push(
      entry.context === undefined
        ? { beef: atomic, outputIndex: entry.outputIndex }
        : { beef: atomic, outputIndex: entry.outputIndex, context: entry.context }
    )
  }
  return { type: 'output-list', outputs }
}
