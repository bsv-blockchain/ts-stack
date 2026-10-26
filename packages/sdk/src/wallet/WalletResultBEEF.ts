import { hash256 } from '../primitives/Hash.js'
import { ATOMIC_BEEF, BEEF_V1, BEEF_V2, TX_DATA_FORMAT } from '../transaction/BeefConstants.js'
import { bytesToHex, hexToBytes } from './WalletByteEncoding.js'

class ByteReader {
  readonly bytes: Uint8Array
  pos = 0

  constructor(bytes: number[] | Uint8Array) {
    this.bytes = Uint8Array.from(bytes)
  }

  #take(length: number): number {
    const start = this.pos
    if (!Number.isSafeInteger(length) || length < 0 || start + length > this.bytes.length) {
      throw new RangeError('Serialized BEEF exceeds available data')
    }
    this.pos += length
    return start
  }

  read(length: number): Uint8Array {
    const start = this.#take(length)
    return this.bytes.slice(start, this.pos)
  }

  readView(length: number): Uint8Array {
    const start = this.#take(length)
    return this.bytes.subarray(start, this.pos)
  }

  readReverse(length: number): Uint8Array {
    return this.read(length).reverse()
  }

  readUInt8(): number {
    return this.bytes[this.#take(1)]
  }

  readUInt16LE(): number {
    const start = this.#take(2)
    return this.bytes[start] | (this.bytes[start + 1] << 8)
  }

  readUInt32LE(): number {
    const start = this.#take(4)
    return (
      (this.bytes[start] |
        (this.bytes[start + 1] << 8) |
        (this.bytes[start + 2] << 16) |
        (this.bytes[start + 3] << 24)) >>>
      0
    )
  }

  readUInt64LE(): number {
    const start = this.#take(8)
    let value = 0n
    for (let index = 7; index >= 0; index--) {
      value = (value << 8n) | BigInt(this.bytes[start + index])
    }
    return Number(value)
  }

  readVarInt(): number {
    const prefix = this.readUInt8()
    if (prefix < 0xfd) return prefix
    if (prefix === 0xfd) {
      const value = this.readUInt16LE()
      if (value < 0xfd) throw new Error('non-canonical varInt')
      return value
    }
    if (prefix === 0xfe) {
      const value = this.readUInt32LE()
      if (value <= 0xffff) throw new Error('non-canonical varInt')
      return value
    }
    const start = this.#take(8)
    let value = 0n
    for (let index = 7; index >= 0; index--) {
      value = (value << 8n) | BigInt(this.bytes[start + index])
    }
    if (value <= 0xffffffffn) throw new Error('non-canonical varInt')
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('varInt is too large')
    return Number(value)
  }

  eof(): boolean {
    return this.pos === this.bytes.length
  }
}

export interface WalletResultTransactionInput {
  sourceTXID: string
  sourceOutputIndex: number
  unlockingScript: Uint8Array
  sequence: number
  /** Resolved from a complete source transaction in the validated BEEF closure. */
  sourceSatoshis?: number
}

export interface WalletResultTransactionOutput {
  satoshis: number
  lockingScript: Uint8Array
}

export interface WalletResultTransaction {
  txid: string
  version: number
  inputs: WalletResultTransactionInput[]
  outputs: WalletResultTransactionOutput[]
  lockTime: number
}

interface WalletResultBEEFTransaction {
  txid: string
  transaction?: WalletResultTransaction
  inputTxids: string[]
  bumpIndex?: number
  txidOnly: boolean
}

interface MerkleLeaf {
  offset: number
  hash?: string
  duplicate?: boolean
}

type MerklePathData = MerkleLeaf[][]

const MAX_MERKLE_OFFSET = 0xffffffff

function nodeOffsetAtHeight(offset: number, height: number): number {
  return Math.floor(offset / 2 ** height)
}

function siblingOffset(offset: number): number {
  return offset % 2 === 0 ? offset + 1 : offset - 1
}

function hashPair(left: string | undefined, right: string | undefined): string {
  return bytesToHex(hash256(hexToBytes((left ?? '') + (right ?? '')).reverse()).reverse())
}

function findMerkleLeaf(
  path: MerklePathData,
  height: number,
  offset: number,
  source: Array<Map<number, MerkleLeaf>>,
  cache: Map<string, MerkleLeaf | undefined>,
  maxOffset: number
): MerkleLeaf | undefined {
  const key = `${height}:${offset}`
  if (cache.has(key)) return cache.get(key)
  let leaf = height < source.length ? source[height].get(offset) : undefined
  if (leaf !== undefined || height === 0) {
    cache.set(key, leaf)
    return leaf
  }
  const childHeight = height - 1
  const leftOffset = offset * 2
  const left = findMerkleLeaf(path, childHeight, leftOffset, source, cache, maxOffset)
  if (left?.hash == null || left.hash === '') {
    cache.set(key, undefined)
    return undefined
  }
  const right = findMerkleLeaf(path, childHeight, leftOffset + 1, source, cache, maxOffset)
  if (right?.hash == null) {
    if (
      right?.duplicate === true ||
      (path.length === 1 && leftOffset === nodeOffsetAtHeight(maxOffset, childHeight))
    ) {
      leaf = { offset, hash: hashPair(left.hash, left.hash) }
      cache.set(key, leaf)
      return leaf
    }
    cache.set(key, undefined)
    return undefined
  }
  leaf = {
    offset,
    hash:
      right.duplicate === true ? hashPair(left.hash, left.hash) : hashPair(right.hash, left.hash)
  }
  cache.set(key, leaf)
  return leaf
}

function computeMerkleRoot(
  path: MerklePathData,
  txid: string | undefined,
  source: Array<Map<number, MerkleLeaf>>,
  leafCache: Map<string, MerkleLeaf | undefined>,
  nodeHashCache: Map<string, string>,
  maxOffset: number
): string {
  if (typeof txid !== 'string') txid = path[0].find(leaf => Boolean(leaf.hash))?.hash
  if (typeof txid !== 'string') throw new TypeError('Transaction ID is undefined')
  const index = path[0].find(leaf => leaf.hash === txid)?.offset
  if (index === undefined) throw new Error('Transaction ID not found in Merkle Path')
  if (path.length === 1 && path[0].length === 1) return txid
  const treeHeight = Math.max(path.length, 32 - Math.clz32(maxOffset))
  let workingHash = txid
  for (let height = 0; height < treeHeight; height++) {
    const nodeOffset = nodeOffsetAtHeight(index, height)
    const nodeKey = `${height}:${nodeOffset}`
    const cached = nodeHashCache.get(nodeKey)
    if (cached !== undefined) {
      if (cached !== workingHash) throw new Error('Mismatched roots')
      const root = nodeHashCache.get(`${treeHeight}:0`)
      if (root === undefined) throw new Error('Mismatched roots')
      return root
    }
    nodeHashCache.set(nodeKey, workingHash)
    const offset = siblingOffset(nodeOffset)
    const leaf = findMerkleLeaf(path, height, offset, source, leafCache, maxOffset)
    if (leaf == null) {
      if (path.length === 1 && nodeOffset === nodeOffsetAtHeight(maxOffset, height)) {
        workingHash = hashPair(workingHash, workingHash)
        continue
      }
      throw new Error(`Missing hash for index ${index} at height ${height}`)
    }
    if (leaf.duplicate === true) {
      workingHash = hashPair(workingHash, workingHash)
    } else {
      workingHash =
        offset % 2 === 1 ? hashPair(leaf.hash, workingHash) : hashPair(workingHash, leaf.hash)
    }
  }
  nodeHashCache.set(`${treeHeight}:0`, workingHash)
  return workingHash
}

function readMerklePath(reader: ByteReader): Set<string> {
  reader.readVarInt() // block height
  const treeHeight = reader.readUInt8()
  const path: MerklePathData = Array.from({ length: treeHeight }, () => [])
  for (let height = 0; height < treeHeight; height++) {
    const leafCount = reader.readVarInt()
    for (let index = 0; index < leafCount; index++) {
      const offset = reader.readVarInt()
      const flags = reader.readUInt8()
      path[height].push(
        (flags & 1) === 1
          ? { offset, duplicate: true }
          : { offset, hash: bytesToHex(reader.read(32).reverse()) }
      )
    }
    path[height].sort((left, right) => left.offset - right.offset)
  }
  if (path.length === 0 || path.length > 32 || path[0].length === 0) {
    throw new Error('Invalid Merkle Path height')
  }
  for (let height = 0; height < path.length; height++) {
    const offsets = new Set<number>()
    const maximum = nodeOffsetAtHeight(MAX_MERKLE_OFFSET, height)
    for (const leaf of path[height]) {
      if (!Number.isSafeInteger(leaf.offset) || leaf.offset < 0 || leaf.offset > maximum) {
        throw new Error('Invalid Merkle Path offset')
      }
      if (offsets.has(leaf.offset)) throw new Error('Duplicate Merkle Path offset')
      offsets.add(leaf.offset)
    }
  }
  const source = path.map(level => new Map(level.map(leaf => [leaf.offset, leaf])))
  const leafCache = new Map<string, MerkleLeaf | undefined>()
  const nodeHashCache = new Map<string, string>()
  const maxOffset = path[0].reduce((maximum, leaf) => Math.max(maximum, leaf.offset), 0)
  let root: string | undefined
  for (const leaf of path[0]) {
    const computed = computeMerkleRoot(path, leaf.hash, source, leafCache, nodeHashCache, maxOffset)
    if (root === undefined) root = computed
    else if (root !== computed) throw new Error('Mismatched roots')
  }
  return new Set(path[0].flatMap(leaf => (leaf.hash === undefined ? [] : [leaf.hash])))
}

export interface WalletResultBEEF {
  atomicTxid?: string
  transactions: Map<string, WalletResultTransaction | undefined>
}

function parseRawTransaction(reader: ByteReader): WalletResultBEEFTransaction {
  const start = reader.pos
  const version = reader.readUInt32LE()
  const inputCount = reader.readVarInt()
  const inputs: WalletResultTransactionInput[] = []
  const inputTxids = new Set<string>()
  for (let index = 0; index < inputCount; index++) {
    const sourceTXID = bytesToHex(reader.readReverse(32))
    inputTxids.add(sourceTXID)
    const sourceOutputIndex = reader.readUInt32LE()
    const scriptLength = reader.readVarInt()
    const unlockingScript = reader.readView(scriptLength)
    const sequence = reader.readUInt32LE()
    inputs.push({ sourceTXID, sourceOutputIndex, unlockingScript, sequence })
  }

  const outputCount = reader.readVarInt()
  const outputs: WalletResultTransactionOutput[] = []
  for (let index = 0; index < outputCount; index++) {
    const satoshis = reader.readUInt64LE()
    const scriptLength = reader.readVarInt()
    outputs.push({ satoshis, lockingScript: reader.readView(scriptLength) })
  }
  const lockTime = reader.readUInt32LE()
  const rawTransaction = reader.bytes.subarray(start, reader.pos)
  const txid = bytesToHex(hash256(rawTransaction).reverse())
  return {
    txid,
    transaction: { txid, version, inputs, outputs, lockTime },
    inputTxids: Array.from(inputTxids),
    txidOnly: false
  }
}

function parseBEEFTransaction(reader: ByteReader, version: number): WalletResultBEEFTransaction {
  if (version === BEEF_V2) {
    const format = reader.readUInt8()
    if (format === TX_DATA_FORMAT.TXID_ONLY) {
      return {
        txid: bytesToHex(reader.readReverse(32)),
        inputTxids: [],
        txidOnly: true
      }
    }
    const bumpIndex =
      format === TX_DATA_FORMAT.RAWTX_AND_BUMP_INDEX ? reader.readVarInt() : undefined
    return { ...parseRawTransaction(reader), bumpIndex }
  }

  const transaction = parseRawTransaction(reader)
  const bumpIndex = reader.readUInt8() === 0 ? undefined : reader.readVarInt()
  return { ...transaction, bumpIndex }
}

function parseWalletResultBEEFEntries(bytes: number[] | Uint8Array): {
  atomicTxid?: string
  bumps: Array<Set<string>>
  entries: WalletResultBEEFTransaction[]
} {
  const reader = new ByteReader(bytes)
  let version = reader.readUInt32LE()
  let atomicTxid: string | undefined
  if (version === ATOMIC_BEEF) {
    atomicTxid = bytesToHex(reader.readReverse(32))
    version = reader.readUInt32LE()
  }
  if (version !== BEEF_V1 && version !== BEEF_V2) {
    throw new Error('Invalid BEEF version')
  }

  const bumpCount = reader.readVarInt()
  const bumps: Array<Set<string>> = []
  for (let index = 0; index < bumpCount; index++) {
    bumps.push(readMerklePath(reader))
  }

  const transactionCount = reader.readVarInt()
  const entries: WalletResultBEEFTransaction[] = []
  for (let index = 0; index < transactionCount; index++) {
    entries.push(parseBEEFTransaction(reader, version))
  }
  if (!reader.eof()) throw new Error('Serialized BEEF contains trailing data')
  return { atomicTxid, bumps, entries }
}

/** Parse exactly one BEEF envelope for read-only wallet-result validation. */
export function parseWalletResultBEEF(bytes: number[] | Uint8Array): WalletResultBEEF {
  const { atomicTxid, entries } = parseWalletResultBEEFEntries(bytes)
  const transactions = new Map<string, WalletResultTransaction | undefined>()
  for (const entry of entries) {
    if (transactions.has(entry.txid)) throw new Error('BEEF contains duplicate transactions')
    transactions.set(entry.txid, entry.transaction)
  }
  for (const entry of entries) {
    if (entry.transaction === undefined) continue
    for (const input of entry.transaction.inputs) {
      const source = transactions.get(input.sourceTXID)
      const sourceOutput = source?.outputs[input.sourceOutputIndex]
      if (sourceOutput !== undefined) input.sourceSatoshis = sourceOutput.satoshis
    }
  }
  return { atomicTxid, transactions }
}

/** Parse and enforce the BRC-95 transaction-closure rule for an Atomic BEEF envelope. */
export function parseWalletResultAtomicBEEF(
  bytes: number[] | Uint8Array,
  allowPartial = false
): WalletResultTransaction {
  const { atomicTxid, bumps, entries } = parseWalletResultBEEFEntries(bytes)
  if (atomicTxid === undefined) throw new Error('Atomic BEEF subject is missing')

  const byTxid = new Map(entries.map(entry => [entry.txid, entry]))
  if (byTxid.size !== entries.length) throw new Error('Atomic BEEF contains duplicate transactions')
  const subject = byTxid.get(atomicTxid)
  if (subject?.transaction === undefined) throw new Error('Atomic BEEF subject is missing')

  const included = new Set<WalletResultBEEFTransaction>()
  const pending = [subject]
  while (pending.length > 0) {
    const entry = pending.pop()!
    if (included.has(entry)) continue
    included.add(entry)
    const bump = entry.bumpIndex === undefined ? undefined : bumps[entry.bumpIndex]
    const hasMatchingBump = bump?.has(entry.txid) === true
    if (hasMatchingBump || entry.txidOnly) continue
    for (const inputTxid of entry.inputTxids) {
      const input = byTxid.get(inputTxid)
      if (input === undefined) {
        if (allowPartial) continue
        throw new Error('Atomic BEEF omits a required dependency')
      }
      pending.push(input)
    }
  }
  if (included.size !== entries.length) {
    throw new Error('Atomic BEEF contains unrelated transaction data')
  }
  for (const input of subject.transaction.inputs) {
    const source = byTxid.get(input.sourceTXID)?.transaction
    const sourceOutput = source?.outputs[input.sourceOutputIndex]
    if (sourceOutput !== undefined) input.sourceSatoshis = sourceOutput.satoshis
  }
  return subject.transaction
}
