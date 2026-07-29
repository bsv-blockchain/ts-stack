import { MerklePath } from '@bsv/sdk'
import { doubleSha256BE } from '../utility/utilityHelpers'
import { asArray, asString } from '../utility/utilityHelpers.noBuffer'

interface MerkleLeaf {
  offset: number
  hash?: string
  txid?: boolean
  duplicate?: boolean
}

function merkleTreeHeight (leafCount: number): number {
  let height = 0
  while (leafCount > 1) {
    height++
    leafCount = Math.ceil(leafCount / 2)
  }
  return height
}

function appendMerklePathLevel (
  pathLevel: MerkleLeaf[],
  level: number,
  index: number,
  targetIndex: number,
  txids: string[],
  levelTxids: string[]
): void {
  const isOdd = index % 2 === 1
  const siblingIndex = isOdd ? index - 1 : index + 1
  if (level !== 0) {
    pathLevel.push(
      siblingIndex >= levelTxids.length
        ? { offset: siblingIndex, duplicate: true }
        : { offset: siblingIndex, hash: levelTxids[siblingIndex] }
    )
    return
  }

  const targetLeaf: MerkleLeaf = {
    offset: targetIndex,
    hash: txids[targetIndex],
    txid: true
  }
  if (siblingIndex >= levelTxids.length) {
    pathLevel.push(targetLeaf, { offset: siblingIndex, duplicate: true })
  } else {
    const siblingLeaf: MerkleLeaf = {
      offset: siblingIndex,
      hash: levelTxids[siblingIndex]
    }
    pathLevel.push(...(isOdd ? [siblingLeaf, targetLeaf] : [targetLeaf, siblingLeaf]))
  }
}

function nextMerkleLevel (levelTxids: string[]): string[] {
  const nextLevel: string[] = []
  for (let index = 0; index < levelTxids.length; index += 2) {
    const left = asArray(levelTxids[index])
    left.reverse()
    const right = index + 1 < levelTxids.length
      ? asArray(levelTxids[index + 1])
      : left
    if (right !== left) right.reverse()
    nextLevel.push(asString(doubleSha256BE([...left, ...right])))
  }
  return nextLevel
}

/**
 * Compute the merkle root from an array of txids (big-endian hex strings).
 * Returns the root as a big-endian hex string (reversed byte order from the
 * natural double-SHA256 result, matching the standard block header format).
 */
export function computeMerkleRoot(txids: string[]): string {
  if (txids.length === 0) {
    throw new Error('Cannot compute merkle root of empty txid list')
  }

  // Convert txids to byte arrays (reverse to little-endian for hashing)
  let level: number[][] = txids.map(txid => {
    const txidBytes = asArray(txid)
    txidBytes.reverse()
    return txidBytes
  })

  while (level.length > 1) {
    const next: number[][] = []
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i]
      const right = i + 1 < level.length ? level[i + 1] : level[i] // duplicate last if odd
      const combined = [...left, ...right]
      const hash = doubleSha256BE(combined) // doubleSha256BE returns BE, reverse to LE for next level
      hash.reverse()
      next.push(hash)
    }
    level = next
  }

  // Final root in LE, reverse to BE for return
  const root = [...level[0]]
  root.reverse()
  return asString(root)
}

/**
 * Compute the MerklePath for a target transaction at `targetIndex` within a block at `blockHeight`.
 * `txids` is the ordered list of all txids in the block (big-endian hex).
 */
export function computeMerklePath(txids: string[], targetIndex: number, blockHeight: number): MerklePath {
  if (txids.length === 0) {
    throw new Error('Cannot compute merkle path of empty txid list')
  }
  if (targetIndex < 0 || targetIndex >= txids.length) {
    throw new Error(`targetIndex ${targetIndex} out of range [0, ${txids.length})`)
  }

  // For a single tx, the root IS the txid; path has one level with just the txid leaf
  if (txids.length === 1) {
    const path: MerkleLeaf[][] = [[{ offset: 0, hash: txids[0], txid: true }]]
    return new MerklePath(blockHeight, path)
  }

  const treeHeight = merkleTreeHeight(txids.length)
  const path: MerkleLeaf[][] = Array.from({ length: treeHeight })
    .fill(0)
    .map(() => [])

  let index = targetIndex
  // For each level, we need to provide the sibling
  let levelTxids = [...txids]
  for (let level = 0; level < treeHeight; level++) {
    appendMerklePathLevel(path[level], level, index, targetIndex, txids, levelTxids)
    levelTxids = nextMerkleLevel(levelTxids)
    index = Math.floor(index / 2)
  }

  return new MerklePath(blockHeight, path)
}
