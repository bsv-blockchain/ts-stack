import { MerklePath } from '@bsv/sdk'
import { normalizeTxid } from '../services/validateMerklePathResult'

export interface TscMerkleProofApi {
  height: number
  index: number
  nodes: string[]
}

export function convertProofToMerklePath(txid: string, proof: TscMerkleProofApi): MerklePath {
  const normalizedTxid = normalizeTxid(txid)
  if (proof == null || typeof proof !== 'object' || Array.isArray(proof)) {
    throw new Error('TSC proof must be a data object.')
  }
  const descriptors = Object.getOwnPropertyDescriptors(proof)
  if (Object.values(descriptors).some(descriptor => descriptor.get != null || descriptor.set != null)) {
    throw new Error('TSC proof must contain only data properties.')
  }
  if (!Number.isSafeInteger(proof.height) || proof.height < 0 || proof.height > 0x7fffffff) {
    throw new Error('TSC proof height is invalid.')
  }
  if (!Number.isSafeInteger(proof.index) || proof.index < 0 || proof.index > 0x7fffffff) {
    throw new Error('TSC proof index is invalid.')
  }
  if (!Array.isArray(proof.nodes) || proof.nodes.length < 1 || proof.nodes.length > 32) {
    throw new Error('TSC proof nodes must contain between 1 and 32 levels.')
  }
  if (Object.keys(proof.nodes).length !== proof.nodes.length) {
    throw new Error('TSC proof nodes must be a dense array.')
  }
  const nodeDescriptors = Object.getOwnPropertyDescriptors(proof.nodes)
  if (Object.values(nodeDescriptors).some(descriptor => descriptor.get != null || descriptor.set != null)) {
    throw new Error('TSC proof nodes must contain only data properties.')
  }
  if (proof.nodes.length < 31 && proof.index >= 2 ** proof.nodes.length) {
    throw new Error('TSC proof index exceeds its tree height.')
  }
  const blockHeight = proof.height
  const treeHeight = proof.nodes.length
  interface Leaf {
    offset: number
    hash?: string
    txid?: boolean
    duplicate?: boolean
  }
  const path: Leaf[][] = Array.from({ length: treeHeight })
    .fill(0)
    .map(() => [])
  let index = proof.index
  for (let level = 0; level < treeHeight; level++) {
    const node = proof.nodes[level]
    if (node !== '*' && (typeof node !== 'string' || !/^[0-9a-fA-F]{64}$/.test(node))) {
      throw new Error(`TSC proof node ${level} is invalid.`)
    }
    const isOdd = index % 2 === 1
    const offset = isOdd ? index - 1 : index + 1
    const leaf: Leaf = { offset }
    if (node === '*' || (level === 0 && node.toLowerCase() === normalizedTxid)) {
      leaf.duplicate = true
    } else {
      leaf.hash = node.toLowerCase()
    }
    path[level].push(leaf)
    if (level === 0) {
      const txidLeaf: Leaf = {
        offset: proof.index,
        hash: normalizedTxid,
        txid: true
      }
      if (isOdd) {
        path[0].push(txidLeaf)
      } else {
        path[0].unshift(txidLeaf)
      }
    }
    index = Math.floor(index / 2)
  }
  return new MerklePath(blockHeight, path)
}
