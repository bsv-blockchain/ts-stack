import { MerklePath } from '@bsv/sdk'

export interface TscMerkleProofApi {
  height: number
  index: number
  nodes: string[]
}

export function convertProofToMerklePath(txid: string, proof: TscMerkleProofApi): MerklePath {
  const blockHeight = proof.height
  const treeHeight = proof.nodes.length
  type Leaf = {
    offset: number
    hash?: string
    txid?: boolean
    duplicate?: boolean
  }
  const path: Leaf[][] = Array(treeHeight)
    .fill(0)
    .map(() => [])
  let index = proof.index
  for (let level = 0; level < treeHeight; level++) {
    const node = proof.nodes[level]
    const isOdd = index % 2 === 1
    const offset = isOdd ? index - 1 : index + 1
    const leaf: Leaf = { offset }
    if (node === '*' || (level === 0 && node === txid)) {
      leaf.duplicate = true
    } else {
      leaf.hash = node
    }
    path[level].push(leaf)
    if (level === 0) {
      const txidLeaf: Leaf = {
        offset: proof.index,
        hash: txid,
        txid: true
      }
      if (isOdd) {
        path[0].push(txidLeaf)
      } else {
        path[0].unshift(txidLeaf)
      }
    }
    index = index >> 1
  }
  return new MerklePath(blockHeight, path)
}
