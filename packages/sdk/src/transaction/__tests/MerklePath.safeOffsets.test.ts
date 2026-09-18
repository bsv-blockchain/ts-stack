import { createHash } from 'node:crypto'
import MerklePath, { type MerklePathLeaf } from '../MerklePath'

const TARGET_PREFIX = 'safe-offset-target'

function sha256d(bytes: Uint8Array): Buffer {
  const first = createHash('sha256').update(bytes).digest()
  return createHash('sha256').update(first).digest()
}

function displayToInternal(hash: string): Buffer {
  return Buffer.from(hash, 'hex').reverse()
}

function internalToDisplay(bytes: Uint8Array): string {
  return Buffer.from(bytes).reverse().toString('hex')
}

function hashPair(left: string, right: string): string {
  return internalToDisplay(
    sha256d(Buffer.concat([displayToInternal(left), displayToInternal(right)]))
  )
}

function labelledHash(label: string): string {
  return createHash('sha256').update(label).digest('hex')
}

function bitLength(value: bigint): number {
  let remaining = value
  let length = 0
  while (remaining > 0n) {
    remaining >>= 1n
    length++
  }
  return length
}

function compact(value: bigint): number[] {
  if (value < 253n) return [Number(value)]
  if (value < 0x10000n) return [0xfd, Number(value & 0xffn), Number((value >> 8n) & 0xffn)]
  if (value < 0x100000000n) {
    return [
      0xfe,
      ...Array.from({ length: 4 }, (_, index) => Number((value >> BigInt(index * 8)) & 0xffn))
    ]
  }
  return [
    0xff,
    ...Array.from({ length: 8 }, (_, index) => Number((value >> BigInt(index * 8)) & 0xffn))
  ]
}

interface SyntheticPath {
  readonly target: string
  readonly sibling: string
  readonly index: number
  readonly depth: number
  readonly path: MerklePathLeaf[][]
  readonly root: string
}

/**
 * Builds a bounded mathematical proof: only the target, its paired level-zero
 * sibling, and one sibling per higher level are represented. It does not claim
 * to model a mined block with 2^n transactions.
 */
function pairedPath(originalIndex: bigint): SyntheticPath {
  const index = Number(originalIndex)
  const depth = bitLength(originalIndex) + 1
  const target = labelledHash(`${TARGET_PREFIX}:${originalIndex}:target`)
  const sibling = labelledHash(`${TARGET_PREFIX}:${originalIndex}:sibling:0`)
  const path: MerklePathLeaf[][] = [
    [
      { offset: index, hash: target, txid: true },
      { offset: Number(originalIndex ^ 1n), hash: sibling, txid: true }
    ].sort((left, right) => left.offset - right.offset)
  ]
  let root = originalIndex % 2n === 0n ? hashPair(target, sibling) : hashPair(sibling, target)

  for (let height = 1; height < depth; height++) {
    const node = originalIndex >> BigInt(height)
    const siblingHash = labelledHash(`${TARGET_PREFIX}:${originalIndex}:sibling:${height}`)
    path.push([{ offset: Number(node ^ 1n), hash: siblingHash }])
    root = node % 2n === 0n ? hashPair(root, siblingHash) : hashPair(siblingHash, root)
  }

  return { target, sibling, index, depth, path, root }
}

function canonicalOddWidthPath(originalIndex: bigint): SyntheticPath {
  const index = Number(originalIndex)
  const target = labelledHash(`${TARGET_PREFIX}:${originalIndex}:odd-target`)
  const path: MerklePathLeaf[][] = []
  let node = originalIndex
  let width = originalIndex + 1n
  let root = target

  // The target is the final node in each odd-width level. A canonical BUMP
  // duplicates it at the next offset until the width reduces to two nodes.
  while (width > 2n) {
    if (width % 2n !== 1n || node !== width - 1n)
      throw new Error('Invalid synthetic odd-width fixture')
    const duplicate = { offset: Number(node ^ 1n), duplicate: true }
    if (path.length === 0) {
      path.push(
        [{ offset: index, hash: target, txid: true }, duplicate].sort(
          (left, right) => left.offset - right.offset
        )
      )
    } else {
      path.push([duplicate])
    }
    root = hashPair(root, root)
    node >>= 1n
    width = (width + 1n) >> 1n
  }
  const leftRoot = labelledHash(`${TARGET_PREFIX}:${originalIndex}:odd-left-root`)
  path.push([{ offset: Number(node ^ 1n), hash: leftRoot }])
  root = node % 2n === 0n ? hashPair(root, leftRoot) : hashPair(leftRoot, root)

  return { target, sibling: target, index, depth: path.length, path, root }
}

describe('MerklePath safe offsets', () => {
  it('keeps a low-offset control proof compatible', () => {
    const fixture = pairedPath(5n)
    const merklePath = new MerklePath(777, fixture.path)

    expect(merklePath.computeRoot(fixture.target)).toBe(fixture.root)
    expect(MerklePath.fromHex(merklePath.toHex()).computeRoot(fixture.target)).toBe(fixture.root)
  })

  it.each([
    (1n << 31n) - 1n,
    1n << 31n,
    (1n << 32n) - 1n,
    1n << 32n,
    (1n << 53n) - 2n,
    (1n << 53n) - 1n
  ])('preserves the full synthetic proof at original offset %s', originalIndex => {
    const fixture = pairedPath(originalIndex)
    const merklePath = new MerklePath(777, fixture.path)

    expect(merklePath.path).toHaveLength(fixture.depth)
    expect(merklePath.path[0].map(leaf => leaf.offset)).toEqual(
      fixture.path[0].map(leaf => leaf.offset)
    )
    expect(merklePath.computeRoot(fixture.target)).toBe(fixture.root)
    expect(merklePath.computeRoot(fixture.sibling)).toBe(fixture.root)

    const roundTripped = MerklePath.fromHex(merklePath.toHex())
    expect(roundTripped.path[0].map(leaf => leaf.offset)).toEqual(
      fixture.path[0].map(leaf => leaf.offset)
    )
    expect(roundTripped.computeRoot(fixture.target)).toBe(fixture.root)
    expect(roundTripped.computeRoot(fixture.sibling)).toBe(fixture.root)
  })

  it.each([31, 32, 52])('computes a canonical odd-width proof at 2^%i', power => {
    const fixture = canonicalOddWidthPath(1n << BigInt(power))
    const merklePath = new MerklePath(777, fixture.path)

    expect(fixture.depth).toBe(power + 1)
    expect(merklePath.computeRoot(fixture.target)).toBe(fixture.root)
  })

  it.each([31, 32, 52])('round-trips a canonical odd-width proof at 2^%i', power => {
    const fixture = canonicalOddWidthPath(1n << BigInt(power))
    const roundTripped = MerklePath.fromHex(new MerklePath(777, fixture.path).toHex())

    expect(roundTripped.path).toEqual(fixture.path)
    expect(roundTripped.computeRoot(fixture.target)).toBe(fixture.root)
  })

  it('computes recursive leaves, extracts, combines, and trims a pruned high-offset proof', () => {
    const fixture = pairedPath((1n << 53n) - 1n)
    const full = new MerklePath(777, fixture.path)
    const parentOffset = Math.floor(fixture.index / 2)
    const expectedParent = hashPair(fixture.sibling, fixture.target)

    expect(full.findOrComputeLeaf(1, parentOffset)?.hash).toBe(expectedParent)

    const first = full.extract([fixture.target])
    const second = full.extract([fixture.sibling])
    expect(first.computeRoot(fixture.target)).toBe(fixture.root)
    expect(second.computeRoot(fixture.sibling)).toBe(fixture.root)

    first.combine(second)
    first.trim()
    expect(first.computeRoot(fixture.target)).toBe(fixture.root)
    expect(first.computeRoot(fixture.sibling)).toBe(fixture.root)

    const roundTripped = MerklePath.fromBinary(first.toBinaryUint8Array())
    expect(roundTripped.computeRoot(fixture.target)).toBe(fixture.root)
    expect(roundTripped.computeRoot(fixture.sibling)).toBe(fixture.root)
  })

  it('computes safe high offsets when constructor root validation is deferred', () => {
    const fixture = pairedPath(1n << 32n)
    const merklePath = new MerklePath(777, fixture.path, true, false)

    expect(merklePath.computeRoot(fixture.target)).toBe(fixture.root)
  })

  it.each([Number.MAX_SAFE_INTEGER + 1, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects unsafe offset %p even when root validation is disabled',
    offset => {
      expect(
        () =>
          new MerklePath(
            777,
            [[{ offset, hash: labelledHash(`invalid:${offset}`), txid: true }]],
            true,
            false
          )
      ).toThrow()
    }
  )

  it('rejects an unsafe offset encoded directly as a BUMP varint', () => {
    const unsafeOffset = 1n << 53n
    const bytes = Uint8Array.from([
      ...compact(777n),
      1,
      ...compact(1n),
      ...compact(unsafeOffset),
      2,
      ...displayToInternal(labelledHash('unsafe-wire'))
    ])

    expect(() => MerklePath.fromBinary(bytes, true, false)).toThrow()
  })
})
