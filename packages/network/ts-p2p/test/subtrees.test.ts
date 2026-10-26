import { describe, expect, it } from '@jest/globals'
import { Hash } from '@bsv/sdk'
import {
  COINBASE_PLACEHOLDER,
  MAX_SUBTREE_NODES,
  MAX_SUBTREE_SERIALIZED_BYTES,
  SimpleTxMap,
  Subtree,
  type SubtreeNode
} from '../src/subtrees.js'

const hash = (value: number): number[] => Array(32).fill(value)
const node = (value: number, fee = 10n, sizeInBytes = 100n): SubtreeNode => ({
  hash: hash(value),
  fee,
  sizeInBytes
})
const MAX_UINT64 = (1n << 64n) - 1n

function writeUint64(bytes: number[], offset: number, value: bigint): void {
  for (let index = 0; index < 8; index++) {
    bytes[offset + index] = Number((value >> BigInt(index * 8)) & 0xffn)
  }
}

describe('SimpleTxMap', () => {
  it('stores hashes by value and enumerates independent key arrays', () => {
    const map = new SimpleTxMap()
    const original = hash(1)

    map.put(original, 7n)
    original[0] = 2

    expect(map.length()).toBe(1)
    expect(map.exists(hash(1))).toBe(true)
    expect(map.get(hash(1))).toBe(7n)
    expect(map.get(hash(2))).toBeUndefined()
    expect(map.keys()).toEqual([hash(1)])
  })
})

describe('Subtree construction and mutation', () => {
  it('validates tree dimensions', () => {
    expect(() => Subtree.newTree(-1)).toThrow('between 0 and 20')
    expect(() => Subtree.newTree(1.5)).toThrow('between 0 and 20')
    expect(() => Subtree.newTree(21)).toThrow('between 0 and 20')
    expect(() => Subtree.newTreeByLeafCount(3)).toThrow('power of two')
    expect(() => Subtree.newIncompleteTreeByLeafCount(0)).toThrow('between 1')
    expect(() => Subtree.newIncompleteTreeByLeafCount(MAX_SUBTREE_NODES + 1)).toThrow('between 1')

    expect(Subtree.newTreeByLeafCount(4).size()).toBe(4)
    expect(Subtree.newIncompleteTreeByLeafCount(3).size()).toBe(4)
  })

  it('adds regular and coinbase nodes while maintaining totals and capacity', () => {
    const tree = Subtree.newTree(1)
    tree.addCoinbaseNode()
    tree.addSubtreeNode(node(1, 5n, 50n))

    expect(tree.length()).toBe(2)
    expect(tree.isComplete()).toBe(true)
    expect(tree.fees).toBe(5n)
    expect(tree.sizeInBytes).toBe(50n)
    expect(() => tree.addNode(hash(2), 1n, 1n)).toThrow('subtree is full')

    const nonEmpty = Subtree.newTree(1)
    nonEmpty.addNode(hash(1), 1n, 1n)
    expect(() => nonEmpty.addCoinbaseNode()).toThrow('should be empty')
    expect(() => Subtree.newTree(0).addNode(COINBASE_PLACEHOLDER, 0n, 0n)).toThrow(
      'AddCoinbaseNode'
    )
    expect(() => Subtree.newTree(0).addSubtreeNode(node(0, 0n, 0n))).toThrow('AddCoinbaseNode')
  })

  it('rejects malformed hashes, duplicate transactions, invalid amounts, and aggregate overflow', () => {
    const tree = Subtree.newTree(1)
    expect(() => tree.addNode([1], 1n, 1n)).toThrow('exactly 32 bytes')
    expect(() => tree.addNode(Array(32).fill(256), 1n, 1n)).toThrow('dense byte array')
    expect(() => tree.addNode(hash(1), -1n, 1n)).toThrow('unsigned 64-bit')
    expect(() => tree.addNode(hash(1), 1n, -1n)).toThrow('unsigned 64-bit')

    tree.addNode(hash(1), MAX_UINT64, 1n)
    expect(() => tree.addNode(hash(1), 0n, 0n)).toThrow('duplicate transaction hash')
    expect(() => tree.addNode(hash(2), 1n, 1n)).toThrow('exceeds unsigned 64-bit')
    expect(tree.length()).toBe(1)
  })

  it('duplicates all mutable data without sharing arrays', () => {
    const original = Subtree.newTree(1)
    original.addNode(hash(1), 2n, 3n)
    original.addConflictingNode(hash(1))
    original.getRootHash()

    const copy = original.duplicate()
    copy.nodes[0].hash[0] = 9
    copy.conflictingNodes[0][0] = 9
    copy.feeHash[0] = 9

    expect(original.nodes[0].hash).toEqual(hash(1))
    expect(original.conflictingNodes[0]).toEqual(hash(1))
    expect(original.feeHash[0]).toBe(0)
  })

  it('tracks conflicts once and rejects hashes outside the tree', () => {
    const tree = Subtree.newTree(1)
    tree.addNode(hash(1), 1n, 1n)

    tree.addConflictingNode(hash(1))
    tree.addConflictingNode(hash(1))

    expect(tree.conflictingNodes).toEqual([hash(1)])
    expect(() => tree.addConflictingNode(hash(2))).toThrow('not in the subtree')
    expect(() => Subtree.newTree(0).addConflictingNode([...COINBASE_PLACEHOLDER])).toThrow(
      'coinbase placeholder'
    )
  })

  it('rebuilds its lookup index after removal', () => {
    const tree = Subtree.newTree(2)
    tree.addNode(hash(1), 1n, 10n)
    tree.addNode(hash(2), 2n, 20n)
    tree.addNode(hash(3), 3n, 30n)
    expect(tree.nodeIndexLookup(hash(3))).toBe(2)

    tree.removeNodeAtIndex(1)

    expect(tree.hasNode(hash(2))).toBe(false)
    expect(tree.nodeIndexLookup(hash(3))).toBe(1)
    expect(tree.getNode(hash(3))).toEqual(node(3, 3n, 30n))
    expect(tree.fees).toBe(4n)
    expect(tree.sizeInBytes).toBe(40n)
    expect(() => tree.removeNodeAtIndex(-1)).toThrow('index out of range')
    expect(() => tree.removeNodeAtIndex(2)).toThrow('index out of range')
  })

  it('returns independent nodes from query operations', () => {
    const tree = Subtree.newTree(1)
    tree.addNode(hash(1), 1n, 1n)
    const returned = tree.getNode(hash(1))!
    const difference = tree.difference(new SimpleTxMap())

    returned.hash[0] = 9
    difference[0].hash[0] = 8

    expect(tree.getNode(hash(1))?.hash).toEqual(hash(1))
  })

  it('does not trust stale indexes or truthy custom-map verdicts', () => {
    const tree = Subtree.newTree(1)
    tree.addNode(hash(1), 1n, 1n)
    tree.nodes[0].hash = hash(4)

    expect(tree.nodeIndexLookup(hash(4))).toBe(0)
    expect(tree.nodeIndexLookup(hash(1))).toBe(-1)
    const malformedMap = {
      put: () => undefined,
      get: () => undefined,
      exists: () => 'false' as unknown as boolean,
      length: () => 0,
      keys: () => []
    }
    expect(() => tree.difference(malformedMap)).toThrow('must return a boolean')
  })
})

describe('Subtree serialization and queries', () => {
  it('round-trips a complete tree, including conflicts and totals', () => {
    const tree = Subtree.newTree(1)
    tree.addNode(hash(1), 2n, 20n)
    tree.addNode(hash(2), 3n, 30n)
    tree.addConflictingNode(hash(2))

    const restored = Subtree.fromBytes(tree.serialize())

    expect(restored.size()).toBe(2)
    expect(restored.height).toBe(1)
    expect(restored.fees).toBe(5n)
    expect(restored.sizeInBytes).toBe(50n)
    expect(restored.nodes).toEqual(tree.nodes)
    expect(restored.conflictingNodes).toEqual([hash(2)])
    expect(Array.from(restored.serializeNodes())).toEqual([...hash(1), ...hash(2)])
  })

  it('round-trips exact unsigned 64-bit values without Number precision loss', () => {
    const value = (1n << 63n) + 123n
    const tree = Subtree.newTree(0)
    tree.addNode(hash(3), value, value)

    const restored = Subtree.fromBytes(tree.serialize())

    expect(restored.fees).toBe(value)
    expect(restored.sizeInBytes).toBe(value)
    expect(restored.nodes[0].fee).toBe(value)
    expect(restored.nodes[0].sizeInBytes).toBe(value)
  })

  it('computes the canonical Bitcoin Merkle root and returns independent bytes', () => {
    const tree = Subtree.newTree(1)
    expect(tree.getRootHash()).toBeNull()
    tree.addNode(hash(1), 1n, 1n)

    const firstRoot = tree.getRootHash()
    expect(firstRoot).toEqual(hash(1))
    expect(tree.getRootHash()).not.toBe(firstRoot)
    firstRoot![0] = 9
    expect(tree.getRootHash()).toEqual(hash(1))

    tree.addNode(hash(2), 1n, 1n)
    expect(tree.getRootHash()).toEqual(Hash.hash256([...hash(1), ...hash(2)]))

    tree.removeNodeAtIndex(1)
    expect(tree.getRootHash()).toEqual(hash(1))
  })

  it('duplicates an odd final leaf at each required Merkle level', () => {
    const tree = Subtree.newIncompleteTreeByLeafCount(5)
    for (let value = 1; value <= 5; value++) tree.addNode(hash(value), 0n, 0n)
    const ab = Hash.hash256([...hash(1), ...hash(2)])
    const cd = Hash.hash256([...hash(3), ...hash(4)])
    const ee = Hash.hash256([...hash(5), ...hash(5)])
    const abcd = Hash.hash256([...ab, ...cd])
    const eeee = Hash.hash256([...ee, ...ee])

    expect(tree.getRootHash()).toEqual(Hash.hash256([...abcd, ...eeee]))
  })

  it('rejects forged, inconsistent, oversized, truncated, and trailing serialized state atomically', () => {
    const source = Subtree.newTree(1)
    source.addNode(hash(1), 2n, 20n)
    source.addNode(hash(2), 3n, 30n)
    source.addConflictingNode(hash(2))
    const valid = source.serialize()

    const forgedRoot = [...valid]
    forgedRoot[0] ^= 1
    expect(() => Subtree.fromBytes(forgedRoot)).toThrow('root does not match')

    const forgedTotals = [...valid]
    forgedTotals[32] ^= 1
    expect(() => Subtree.fromBytes(forgedTotals)).toThrow('aggregate totals')

    const duplicateNodes = [...valid]
    duplicateNodes.splice(104, 32, ...duplicateNodes.slice(56, 88))
    expect(() => Subtree.fromBytes(duplicateNodes)).toThrow('duplicate nodes')

    const excessiveCount = Array(64).fill(0) as number[]
    writeUint64(excessiveCount, 48, BigInt(MAX_SUBTREE_NODES + 1))
    expect(() => Subtree.fromBytes(excessiveCount)).toThrow('node count is out of range')
    const excessiveBytes = [] as number[]
    excessiveBytes.length = MAX_SUBTREE_SERIALIZED_BYTES + 1
    expect(() => Subtree.fromBytes(excessiveBytes)).toThrow('exceeds its byte limit')
    expect(() => Subtree.fromBytes(valid.slice(0, -1))).toThrow('truncated or trailing')
    expect(() => Subtree.fromBytes([...valid, 0])).toThrow('truncated or trailing')

    const target = Subtree.newTree(0)
    target.addNode(hash(9), 9n, 9n)
    expect(() => target.deserialize(forgedRoot)).toThrow('root does not match')
    expect(target.getNode(hash(9))).toEqual(node(9, 9n, 9n))
  })

  it('builds maps and returns nodes missing from another map', () => {
    const tree = Subtree.newTree(1)
    tree.addNode(hash(1), 1n, 1n)
    tree.addNode(hash(2), 2n, 2n)
    const ids = new SimpleTxMap()
    ids.put(hash(1), 0n)

    expect(tree.getMap().get(hash(2))).toBe(1n)
    expect(tree.difference(ids)).toEqual([node(2, 2n, 2n)])
  })
})
