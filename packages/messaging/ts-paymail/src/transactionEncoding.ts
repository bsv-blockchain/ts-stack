import { hash256 } from '@bsv/sdk/primitives/Hash'
import { toArray, toHex } from '@bsv/sdk/primitives/utils'

import { PaymailServerResponseError } from './errors/index.js'

function transactionBytes(value: string): number[] {
  if (!/^(?:[0-9a-fA-F]{2})+$/.test(value)) {
    throw new PaymailServerResponseError('Invalid transaction encoding')
  }
  return toArray(value, 'hex')
}

class TransactionByteReader {
  public position = 0

  public constructor(private readonly bytes: number[]) {}

  public readByte(): number {
    const value = this.bytes[this.position]
    if (value == null) throw new PaymailServerResponseError('Invalid transaction encoding')
    this.position += 1
    return value
  }

  public readUint32LE(): number {
    const start = this.position
    this.skip(4)
    return (
      (this.bytes[start] ?? 0) +
      (this.bytes[start + 1] ?? 0) * 0x100 +
      (this.bytes[start + 2] ?? 0) * 0x10000 +
      (this.bytes[start + 3] ?? 0) * 0x1000000
    )
  }

  public readVarInt(): number {
    const prefix = this.readByte()
    if (prefix < 0xfd) return prefix
    const width = prefix === 0xfd ? 2 : prefix === 0xfe ? 4 : 8
    let value = 0n
    for (let offset = 0; offset < width; offset++) {
      value |= BigInt(this.readByte()) << BigInt(offset * 8)
    }
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new PaymailServerResponseError('Invalid transaction encoding')
    }
    const numberValue = Number(value)
    if (
      (width === 2 && numberValue < 0xfd) ||
      (width === 4 && numberValue <= 0xffff) ||
      (width === 8 && numberValue <= 0xffffffff)
    ) {
      throw new PaymailServerResponseError('Invalid transaction encoding')
    }
    return numberValue
  }

  public read(length: number): number[] {
    const start = this.position
    this.skip(length)
    return this.bytes.slice(start, this.position)
  }

  public slice(start: number, end = this.position): number[] {
    return this.bytes.slice(start, end)
  }

  public skip(length: number): void {
    if (!Number.isSafeInteger(length) || length < 0 || this.position + length > this.bytes.length) {
      throw new PaymailServerResponseError('Invalid transaction encoding')
    }
    this.position += length
  }

  public remaining(): number {
    return this.bytes.length - this.position
  }
}

function scanRawTransaction(reader: TransactionByteReader): string {
  const start = reader.position
  reader.skip(4)
  const inputCount = reader.readVarInt()
  if (inputCount > reader.remaining()) {
    throw new PaymailServerResponseError('Invalid transaction encoding')
  }
  for (let input = 0; input < inputCount; input++) {
    reader.skip(36)
    reader.skip(reader.readVarInt())
    reader.skip(4)
  }
  const outputCount = reader.readVarInt()
  if (outputCount > reader.remaining()) {
    throw new PaymailServerResponseError('Invalid transaction encoding')
  }
  for (let output = 0; output < outputCount; output++) {
    reader.skip(8)
    reader.skip(reader.readVarInt())
  }
  reader.skip(4)
  return toHex(hash256(reader.slice(start)).reverse())
}

function skipMerklePath(reader: TransactionByteReader): void {
  reader.readVarInt()
  const treeHeight = reader.readByte()
  for (let level = 0; level < treeHeight; level++) {
    const leafCount = reader.readVarInt()
    if (leafCount > reader.remaining()) {
      throw new PaymailServerResponseError('Invalid transaction encoding')
    }
    for (let leaf = 0; leaf < leafCount; leaf++) {
      reader.readVarInt()
      const flags = reader.readByte()
      if ((flags & 1) === 0) reader.skip(32)
    }
  }
}

function beefTransactionId(bytes: number[]): string {
  const reader = new TransactionByteReader(bytes)
  let version = reader.readUint32LE()
  let atomicTransactionId: string | undefined
  if (version === 0x01010101) {
    atomicTransactionId = toHex(reader.read(32).reverse())
    version = reader.readUint32LE()
  }
  const beefV1 = 4_022_206_465
  const beefV2 = 4_022_206_466
  if (version !== beefV1 && version !== beefV2) {
    throw new PaymailServerResponseError('Invalid transaction encoding')
  }

  const bumpCount = reader.readVarInt()
  if (bumpCount > reader.remaining()) {
    throw new PaymailServerResponseError('Invalid transaction encoding')
  }
  for (let bump = 0; bump < bumpCount; bump++) skipMerklePath(reader)

  const transactionCount = reader.readVarInt()
  if (transactionCount < 1 || transactionCount > reader.remaining()) {
    throw new PaymailServerResponseError('Invalid transaction encoding')
  }
  const transactionIds = new Set<string>()
  let lastTransactionId: string | undefined
  for (let transaction = 0; transaction < transactionCount; transaction++) {
    if (version === beefV2) {
      const format = reader.readByte()
      if (format === 2) {
        const transactionId = toHex(reader.read(32).reverse())
        transactionIds.add(transactionId)
        lastTransactionId = undefined
        continue
      }
      if (format === 1) reader.readVarInt()
      else if (format !== 0) throw new PaymailServerResponseError('Invalid transaction encoding')
      lastTransactionId = scanRawTransaction(reader)
    } else {
      lastTransactionId = scanRawTransaction(reader)
      if (reader.readByte() !== 0) reader.readVarInt()
    }
    transactionIds.add(lastTransactionId)
  }
  if (reader.remaining() !== 0) {
    throw new PaymailServerResponseError('Invalid transaction encoding')
  }
  if (atomicTransactionId != null) {
    if (!transactionIds.has(atomicTransactionId)) {
      throw new PaymailServerResponseError('Invalid transaction encoding')
    }
    return atomicTransactionId
  }
  if (lastTransactionId == null) {
    throw new PaymailServerResponseError('Invalid transaction encoding')
  }
  return lastTransactionId
}

/**
 * Strictly validates an exact raw transaction or BEEF envelope and returns the
 * subject transaction id. Prefix parsing, trailing bytes, non-canonical
 * varints, and truncated fields are rejected before application logic runs.
 */
export function transactionIdFromHex(value: string, isBeef = false): string {
  const bytes = transactionBytes(value)
  if (!isBeef) {
    const reader = new TransactionByteReader(bytes)
    const transactionId = scanRawTransaction(reader)
    if (reader.remaining() !== 0) {
      throw new PaymailServerResponseError('Invalid transaction encoding')
    }
    return transactionId
  }
  return beefTransactionId(bytes)
}
