import { describe, expect, it } from '@jest/globals'
import { Hash } from '@bsv/sdk'
import { COINBASE_PLACEHOLDER, SimpleTxMap, Subtree, type SubtreeNode } from '../src/subtrees.js'

const hash = (value: number): number[] => Array(32).fill(value)
const node = (value: number, fee = 10n, sizeInBytes = 100n): SubtreeNode => ({
  hash: hash(value),
  fee,
  sizeInBytes
})

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
    expect(() => Subtree.newTree(-1)).toThrow('non-negative integer')
    expect(() => Subtree.newTree(1.5)).toThrow('non-negative integer')
    expect(() => Subtree.newTreeByLeafCount(3)).toThrow('power of two')
    expect(() => Subtree.newIncompleteTreeByLeafCount(0)).toThrow('positive integer')

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

  it('characterizes the current root hash and invalidates it after mutation', () => {
    const tree = Subtree.newTree(1)
    expect(tree.getRootHash()).toBeNull()
    tree.addNode(hash(1), 1n, 1n)

    const firstRoot = tree.getRootHash()
    expect(firstRoot).toEqual(Hash.sha256(hash(1)))
    expect(tree.getRootHash()).toBe(firstRoot)

    tree.removeNodeAtIndex(0)
    expect(tree.getRootHash()).toBeNull()
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
