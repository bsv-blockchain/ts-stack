import { hash256 } from '@bsv/sdk/primitives/Hash'
import { Reader, Writer, toArray, toHex } from '@bsv/sdk/primitives/utils'
import { BigNumber } from '@bsv/sdk'
export const HASH_SIZE = 32
export const MAX_SUBTREE_NODES = 1_048_576
export const COINBASE_PLACEHOLDER: readonly number[] = Object.freeze(
  Array.from({ length: HASH_SIZE }, () => 0)
)

const MAX_UINT64 = (1n << 64n) - 1n
const FIXED_SERIALIZED_BYTES = HASH_SIZE + 8 + 8 + 8 + 8
const NODE_SERIALIZED_BYTES = HASH_SIZE + 8 + 8
export const MAX_SUBTREE_SERIALIZED_BYTES =
  FIXED_SERIALIZED_BYTES + MAX_SUBTREE_NODES * (NODE_SERIALIZED_BYTES + HASH_SIZE)

export interface SubtreeNode {
  hash: number[]
  fee: bigint
  sizeInBytes: bigint
}

export interface TxMap {
  put(hash: number[], value: bigint): void
  get(hash: number[]): bigint | undefined
  exists(hash: number[]): boolean
  length(): number
  keys(): number[][]
}

export class SimpleTxMap implements TxMap {
  private readonly map = new Map<string, bigint>()

  private hashToKey(hash: number[]): string {
    assertHash(hash, 'transaction hash')
    return toHex(hash)
  }

  put(hash: number[], value: bigint): void {
    if (typeof value !== 'bigint') throw new TypeError('transaction-map value must be a bigint')
    this.map.set(this.hashToKey(hash), value)
  }

  get(hash: number[]): bigint | undefined {
    return this.map.get(this.hashToKey(hash))
  }

  exists(hash: number[]): boolean {
    return this.map.has(this.hashToKey(hash))
  }

  length(): number {
    return this.map.size
  }

  keys(): number[][] {
    return Array.from(this.map.keys()).map(key => toArray(key, 'hex'))
  }
}

function assertDenseBytes(value: number[], label: string, expectedLength?: number): void {
  if (!Array.isArray(value) || (expectedLength !== undefined && value.length !== expectedLength)) {
    throw new TypeError(
      expectedLength === undefined
        ? `${label} must be a byte array`
        : `${label} must contain exactly ${expectedLength} bytes`
    )
  }
  for (let index = 0; index < value.length; index++) {
    if (
      !Object.hasOwn(value, index) ||
      !Number.isInteger(value[index]) ||
      value[index] < 0 ||
      value[index] > 255
    ) {
      throw new TypeError(`${label} must be a dense byte array`)
    }
  }
}

function assertHash(value: number[], label: string): void {
  assertDenseBytes(value, label, HASH_SIZE)
}

function assertUint64(value: bigint, label: string): void {
  if (typeof value !== 'bigint' || value < 0n || value > MAX_UINT64) {
    throw new RangeError(`${label} must be an unsigned 64-bit bigint`)
  }
}

function addUint64(left: bigint, right: bigint, label: string): bigint {
  assertUint64(left, label)
  assertUint64(right, label)
  const sum = left + right
  if (sum > MAX_UINT64) throw new RangeError(`${label} exceeds unsigned 64-bit range`)
  return sum
}

function writeUint64(writer: InstanceType<typeof Writer>, value: bigint, label: string): void {
  assertUint64(value, label)
  writer.writeUInt64LEBn(new BigNumber(value.toString()))
}

function readUint64(reader: InstanceType<typeof Reader>): bigint {
  return BigInt(reader.readUInt64LEBn().toString())
}

function arraysEqual(left: readonly number[], right: readonly number[]): boolean {
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index++) {
    if (left[index] !== right[index]) return false
  }
  return true
}

function cloneNode(node: SubtreeNode): SubtreeNode {
  return { hash: [...node.hash], fee: node.fee, sizeInBytes: node.sizeInBytes }
}

function merkleRoot(nodes: readonly SubtreeNode[]): number[] | null {
  if (nodes.length === 0) return null
  // Keep only one completed hash per level. This avoids duplicating a
  // million-leaf subtree into several large JavaScript array layers while
  // producing the same duplicate-last Bitcoin Merkle root as go-subtree.
  const levels: Array<number[] | undefined> = []
  for (const node of nodes) {
    let current = [...node.hash]
    let level = 0
    while (levels[level] !== undefined) {
      current = hash256([...levels[level]!, ...current])
      levels[level] = undefined
      level++
    }
    levels[level] = current
  }

  let current: number[] | undefined
  let currentLevel = 0
  for (let level = 0; level < levels.length; level++) {
    const completed = levels[level]
    if (completed === undefined) continue
    if (current === undefined) {
      current = completed
      currentLevel = level
      continue
    }
    while (currentLevel < level) {
      current = hash256([...current, ...current])
      currentLevel++
    }
    current = hash256([...completed, ...current])
    currentLevel = level + 1
  }
  return current ?? null
}

function validateHeight(height: number): void {
  if (!Number.isInteger(height) || height < 0 || height > 20) {
    throw new RangeError('height must be an integer between 0 and 20')
  }
}

function validateLeafCount(count: number, requirePowerOfTwo: boolean): void {
  if (!Number.isSafeInteger(count) || count < 1 || count > MAX_SUBTREE_NODES) {
    throw new RangeError(`numberOfLeaves must be an integer between 1 and ${MAX_SUBTREE_NODES}`)
  }
  if (requirePowerOfTwo && !Number.isInteger(Math.log2(count))) {
    throw new Error('numberOfLeaves must be a power of two')
  }
}

export class Subtree {
  height: number
  fees: bigint
  sizeInBytes: bigint
  feeHash: number[]
  nodes: SubtreeNode[]
  conflictingNodes: number[][]

  private treeSize: number
  private nodeIndex = new Map<string, number>()

  constructor(height: number = 0) {
    validateHeight(height)
    this.height = height
    this.fees = 0n
    this.sizeInBytes = 0n
    this.feeHash = Array(HASH_SIZE).fill(0) as number[]
    this.nodes = []
    this.conflictingNodes = []
    this.treeSize = 2 ** height
  }

  static newTree(height: number): Subtree {
    return new Subtree(height)
  }

  static newTreeByLeafCount(maxNumberOfLeaves: number): Subtree {
    validateLeafCount(maxNumberOfLeaves, true)
    return new Subtree(Math.log2(maxNumberOfLeaves))
  }

  static newIncompleteTreeByLeafCount(maxNumberOfLeaves: number): Subtree {
    validateLeafCount(maxNumberOfLeaves, false)
    return new Subtree(Math.ceil(Math.log2(maxNumberOfLeaves)))
  }

  static fromBytes(bytes: number[]): Subtree {
    const subtree = new Subtree()
    subtree.deserialize(bytes)
    return subtree
  }

  duplicate(): Subtree {
    this.validateState()
    const copy = new Subtree(this.height)
    copy.fees = this.fees
    copy.sizeInBytes = this.sizeInBytes
    copy.feeHash = [...this.feeHash]
    copy.nodes = this.nodes.map(cloneNode)
    copy.conflictingNodes = this.conflictingNodes.map(hash => [...hash])
    copy.treeSize = this.treeSize
    copy.rebuildNodeIndex()
    return copy
  }

  size(): number {
    return this.treeSize
  }

  length(): number {
    return this.nodes.length
  }

  isComplete(): boolean {
    return this.nodes.length === this.treeSize
  }

  addNode(hash: number[], fee: bigint, sizeInBytes: bigint): void {
    this.addValidatedNode({ hash, fee, sizeInBytes }, 'AddNode')
  }

  addSubtreeNode(node: SubtreeNode): void {
    if (node === null || typeof node !== 'object') throw new TypeError('Invalid subtree node')
    this.addValidatedNode(node, 'AddSubtreeNode')
  }

  private addValidatedNode(node: SubtreeNode, operation: string): void {
    if (this.nodes.length >= this.treeSize) throw new Error('subtree is full')
    assertHash(node.hash, 'node hash')
    assertUint64(node.fee, 'node fee')
    assertUint64(node.sizeInBytes, 'node size')
    if (arraysEqual(node.hash, COINBASE_PLACEHOLDER)) {
      throw new Error(
        `[${operation}] coinbase placeholder node should be added with AddCoinbaseNode`
      )
    }
    const key = toHex(node.hash)
    if (this.nodeIndexLookup(node.hash) !== -1) throw new Error('duplicate transaction hash')
    const nextFees = addUint64(this.fees, node.fee, 'subtree fees')
    const nextSize = addUint64(this.sizeInBytes, node.sizeInBytes, 'subtree size')
    this.nodes.push(cloneNode(node))
    this.nodeIndex.set(key, this.nodes.length - 1)
    this.fees = nextFees
    this.sizeInBytes = nextSize
  }

  addCoinbaseNode(): void {
    if (this.nodes.length !== 0)
      throw new Error('subtree should be empty before adding a coinbase node')
    this.nodes.push({ hash: [...COINBASE_PLACEHOLDER], fee: 0n, sizeInBytes: 0n })
    this.nodeIndex.set(toHex([...COINBASE_PLACEHOLDER]), 0)
    this.fees = 0n
    this.sizeInBytes = 0n
  }

  addConflictingNode(hash: number[]): void {
    assertHash(hash, 'conflicting transaction hash')
    if (arraysEqual(hash, COINBASE_PLACEHOLDER)) {
      throw new Error('coinbase placeholder cannot be a conflicting node')
    }
    if (!this.hasNode(hash)) throw new Error('conflicting node is not in the subtree')
    if (this.conflictingNodes.some(existing => arraysEqual(existing, hash))) return
    this.conflictingNodes.push([...hash])
  }

  removeNodeAtIndex(index: number): void {
    if (!Number.isInteger(index) || index < 0 || index >= this.nodes.length) {
      throw new Error('index out of range')
    }
    this.validateState()
    const [removed] = this.nodes.splice(index, 1)
    this.fees -= removed.fee
    this.sizeInBytes -= removed.sizeInBytes
    this.conflictingNodes = this.conflictingNodes.filter(
      conflict => !arraysEqual(conflict, removed.hash)
    )
    this.rebuildNodeIndex()
  }

  nodeIndexLookup(hash: number[]): number {
    assertHash(hash, 'transaction hash')
    const key = toHex(hash)
    const index = this.nodeIndex.get(key)
    if (index !== undefined && arraysEqual(this.nodes[index]?.hash ?? [], hash)) return index
    // `nodes` remains public for historical source compatibility. Rebuild on
    // every miss or stale hit so that an externally mutated collection cannot
    // make the cache authoritative over the current hashes.
    this.rebuildNodeIndex()
    return this.nodeIndex.get(key) ?? -1
  }

  hasNode(hash: number[]): boolean {
    return this.nodeIndexLookup(hash) !== -1
  }

  getNode(hash: number[]): SubtreeNode | null {
    const index = this.nodeIndexLookup(hash)
    return index === -1 ? null : cloneNode(this.nodes[index])
  }

  serialize(): number[] {
    this.validateState()
    const root = merkleRoot(this.nodes)
    if (root === null) throw new Error('cannot serialize an empty subtree')
    const writer = new Writer()
    writer.write(root)
    writeUint64(writer, this.fees, 'subtree fees')
    writeUint64(writer, this.sizeInBytes, 'subtree size')
    writeUint64(writer, BigInt(this.nodes.length), 'subtree node count')
    for (const node of this.nodes) {
      writer.write(node.hash)
      writeUint64(writer, node.fee, 'node fee')
      writeUint64(writer, node.sizeInBytes, 'node size')
    }
    writeUint64(writer, BigInt(this.conflictingNodes.length), 'conflicting node count')
    for (const conflict of this.conflictingNodes) writer.write(conflict)
    return writer.toArray()
  }

  serializeNodes(): Uint8Array {
    this.validateNodes()
    const buffer = new Uint8Array(this.nodes.length * HASH_SIZE)
    for (let index = 0; index < this.nodes.length; index++) {
      buffer.set(this.nodes[index].hash, index * HASH_SIZE)
    }
    return buffer
  }

  deserialize(bytes: number[]): void {
    if (!Array.isArray(bytes) || bytes.length > MAX_SUBTREE_SERIALIZED_BYTES) {
      throw new RangeError('serialized subtree exceeds its byte limit')
    }
    assertDenseBytes(bytes, 'serialized subtree')
    if (bytes.length < FIXED_SERIALIZED_BYTES)
      throw new RangeError('serialized subtree is truncated')
    const reader = new Reader(bytes)
    const claimedRoot = reader.read(HASH_SIZE)
    const claimedFees = readUint64(reader)
    const claimedSize = readUint64(reader)
    const nodeCountValue = readUint64(reader)
    if (nodeCountValue < 1n || nodeCountValue > BigInt(MAX_SUBTREE_NODES)) {
      throw new RangeError('serialized subtree node count is out of range')
    }
    const nodeCount = Number(nodeCountValue)
    const minimumLength = HASH_SIZE + 24 + nodeCount * NODE_SERIALIZED_BYTES + 8
    if (minimumLength > bytes.length)
      throw new RangeError('serialized subtree node data is truncated')

    const nodes: SubtreeNode[] = []
    let computedFees = 0n
    let computedSize = 0n
    const nodeKeys = new Set<string>()
    for (let index = 0; index < nodeCount; index++) {
      const hash = reader.read(HASH_SIZE)
      const fee = readUint64(reader)
      const sizeInBytes = readUint64(reader)
      const key = toHex(hash)
      if (nodeKeys.has(key)) throw new Error('serialized subtree contains duplicate nodes')
      nodeKeys.add(key)
      computedFees = addUint64(computedFees, fee, 'serialized subtree fees')
      computedSize = addUint64(computedSize, sizeInBytes, 'serialized subtree size')
      nodes.push({ hash, fee, sizeInBytes })
    }

    const conflictCountValue = readUint64(reader)
    if (conflictCountValue > nodeCountValue) {
      throw new RangeError('conflicting node count exceeds subtree node count')
    }
    const conflictCount = Number(conflictCountValue)
    if (minimumLength + conflictCount * HASH_SIZE !== bytes.length) {
      throw new RangeError('serialized subtree has truncated or trailing data')
    }
    const conflicts: number[][] = []
    const conflictKeys = new Set<string>()
    for (let index = 0; index < conflictCount; index++) {
      const conflict = reader.read(HASH_SIZE)
      const key = toHex(conflict)
      if (
        arraysEqual(conflict, COINBASE_PLACEHOLDER) ||
        !nodeKeys.has(key) ||
        conflictKeys.has(key)
      ) {
        throw new Error('serialized subtree contains an invalid conflicting node')
      }
      conflictKeys.add(key)
      conflicts.push(conflict)
    }
    if (computedFees !== claimedFees || computedSize !== claimedSize) {
      throw new Error('serialized subtree aggregate totals do not match its nodes')
    }
    const computedRoot = merkleRoot(nodes)
    if (computedRoot === null || !arraysEqual(computedRoot, claimedRoot)) {
      throw new Error('serialized subtree root does not match its nodes')
    }

    this.height = Math.ceil(Math.log2(nodeCount))
    this.treeSize = nodeCount
    this.fees = claimedFees
    this.sizeInBytes = claimedSize
    this.feeHash = Array(HASH_SIZE).fill(0) as number[]
    this.nodes = nodes
    this.conflictingNodes = conflicts
    this.rebuildNodeIndex()
  }

  getRootHash(): number[] | null {
    this.validateNodes()
    const root = merkleRoot(this.nodes)
    return root === null ? null : [...root]
  }

  getMap(): TxMap {
    this.validateNodes()
    const map = new SimpleTxMap()
    for (let index = 0; index < this.nodes.length; index++) {
      map.put(this.nodes[index].hash, BigInt(index))
    }
    return map
  }

  difference(ids: TxMap): SubtreeNode[] {
    if (ids === null || typeof ids !== 'object' || typeof ids.exists !== 'function') {
      throw new TypeError('ids must implement TxMap')
    }
    this.validateNodes()
    const difference: SubtreeNode[] = []
    for (const node of this.nodes) {
      const exists = ids.exists([...node.hash])
      if (exists !== true && exists !== false) {
        throw new TypeError('TxMap.exists must return a boolean')
      }
      if (!exists) difference.push(cloneNode(node))
    }
    return difference
  }

  private validateNodes(): void {
    if (
      !Array.isArray(this.nodes) ||
      this.nodes.length > this.treeSize ||
      this.nodes.length > MAX_SUBTREE_NODES
    ) {
      throw new RangeError('subtree node collection is out of range')
    }
    const seen = new Set<string>()
    for (const node of this.nodes) {
      if (node === null || typeof node !== 'object') throw new TypeError('Invalid subtree node')
      assertHash(node.hash, 'node hash')
      assertUint64(node.fee, 'node fee')
      assertUint64(node.sizeInBytes, 'node size')
      const key = toHex(node.hash)
      if (seen.has(key)) throw new Error('subtree contains duplicate nodes')
      seen.add(key)
    }
  }

  private validateState(): void {
    validateHeight(this.height)
    if (
      !Number.isSafeInteger(this.treeSize) ||
      this.treeSize < 1 ||
      this.treeSize > MAX_SUBTREE_NODES ||
      this.height !== Math.ceil(Math.log2(this.treeSize))
    ) {
      throw new RangeError('subtree capacity is out of range')
    }
    assertHash(this.feeHash, 'fee hash')
    this.validateNodes()
    let fees = 0n
    let size = 0n
    const nodeKeys = new Set(this.nodes.map(node => toHex(node.hash)))
    for (const node of this.nodes) {
      fees = addUint64(fees, node.fee, 'subtree fees')
      size = addUint64(size, node.sizeInBytes, 'subtree size')
    }
    if (fees !== this.fees || size !== this.sizeInBytes) {
      throw new Error('subtree aggregate totals do not match its nodes')
    }
    const conflicts = new Set<string>()
    for (const conflict of this.conflictingNodes) {
      assertHash(conflict, 'conflicting transaction hash')
      const key = toHex(conflict)
      if (arraysEqual(conflict, COINBASE_PLACEHOLDER) || !nodeKeys.has(key) || conflicts.has(key)) {
        throw new Error('subtree contains an invalid conflicting node')
      }
      conflicts.add(key)
    }
  }

  private rebuildNodeIndex(): void {
    this.nodeIndex = new Map()
    for (let index = 0; index < this.nodes.length; index++) {
      assertHash(this.nodes[index].hash, 'node hash')
      this.nodeIndex.set(toHex(this.nodes[index].hash), index)
    }
  }
}
