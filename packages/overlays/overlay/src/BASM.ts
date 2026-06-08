import { createHash } from 'node:crypto'
import { MerklePath } from '@bsv/sdk'

export const BASM_ZERO_HASH = '0000000000000000000000000000000000000000000000000000000000000000'

export interface TopicBlockAnchor {
  topic: string
  blockHeight: number
  blockHash: string
  basmRoot: string
  admittedCount: number
  tac: string
}

export interface TopicAnchorTip {
  topic: string
  blockHeight: number
  blockHash?: string
  basmRoot?: string
  admittedCount?: number
  tac: string
}

export interface AdmittedTxRef {
  txid: string
  blockIndex: number
}

export interface RawTransactionRecord {
  txid: string
  rawTx: string
}

export interface RawTransactionRequest {
  txids: string[]
}

export interface RawTransactionResponse {
  transactions: RawTransactionRecord[]
  missing: string[]
}

export interface TopicAnchorHeader {
  blockHeight: number
  blockHash: string
  merkleRoot?: string
}

export type TopicAnchorHeaderResolver = (blockHeight: number) => Promise<TopicAnchorHeader | undefined>

export interface TopicAnchorRangeRequest {
  fromHeight: number
  toHeight: number
}

export interface TopicAnchorRangeResponse {
  topic: string
  anchors: TopicBlockAnchor[]
}

export interface AdmittedListRequest {
  blockHeight: number
  blockHash?: string
}

export interface AdmittedListResponse {
  topic: string
  blockHeight: number
  blockHash?: string
  admitted: AdmittedTxRef[]
}

export interface CompoundMerklePathRequest {
  blockHeight: number
  txids: string[]
}

export interface CompoundMerklePathResponse {
  topic: string
  blockHeight: number
  txids: string[]
  merklePath: string
}

export interface MerkleProofMetadata {
  blockHeight: number
  blockIndex: number
  merkleRoot: string
}

export interface ReorgReport {
  perTopic: Array<{
    topic: string
    demotedTxids: string[]
    rebuiltFrom: number
    rebuiltTo: number
  }>
}

export interface BASMPeerSyncReport {
  topic: string
  endpoint: string
  status: 'matched' | 'advanced' | 'diverged' | 'skipped' | 'error'
  localTip?: TopicAnchorTip
  remoteTip?: TopicAnchorTip
  checkedHeights: number[]
  missingTxids: string[]
  fetchedTxCount: number
  message?: string
}

type AdmittedTxLike = string | AdmittedTxRef

function sha256d(buffer: Buffer): Buffer {
  const first = createHash('sha256').update(buffer).digest()
  return createHash('sha256').update(first).digest()
}

function assertHashHex(hash: string, label: string): void {
  if (!/^[0-9a-fA-F]{64}$/.test(hash)) {
    throw new Error(`${label} must be 32 bytes of hex`)
  }
}

function displayHexToInternal(hash: string): Buffer {
  assertHashHex(hash, 'hash')
  return Buffer.from(hash, 'hex').reverse()
}

function internalToDisplayHex(hash: Buffer): string {
  return Buffer.from(hash).reverse().toString('hex')
}

function normalizeAdmittedTxids(admitted: AdmittedTxLike[]): string[] {
  return admitted
    .map((item, originalIndex) => {
      if (typeof item === 'string') {
        return { txid: item, blockIndex: originalIndex }
      }
      return item
    })
    .sort((a, b) => a.blockIndex - b.blockIndex)
    .map(item => item.txid.toLowerCase())
}

/**
 * Computes a BRC-136 BASM root from admitted topic txids.
 *
 * The API accepts normal display-order txid hex because that is what the BSV
 * TypeScript stack exposes at its public boundaries. Hashing is performed on
 * internal byte order as required by the BRC, and the returned root is display
 * order for JSON/wire compatibility.
 */
export function computeBasmRoot(admitted: AdmittedTxLike[]): string {
  const txids = normalizeAdmittedTxids(admitted)

  if (txids.length === 0) {
    return BASM_ZERO_HASH
  }

  let layer = txids.map(txid => displayHexToInternal(txid))
  if (layer.length === 1) {
    return internalToDisplayHex(layer[0])
  }

  while (layer.length > 1) {
    const next: Buffer[] = []
    for (let i = 0; i < layer.length; i += 2) {
      const left = layer[i]
      const right = i + 1 < layer.length ? layer[i + 1] : left
      next.push(sha256d(Buffer.concat([left, right])))
    }
    layer = next
  }

  return internalToDisplayHex(layer[0])
}

/**
 * Computes the BRC-136 cumulative Topic Anchor Chain hash:
 * SHA256d(prevTac || blockHash || basmRoot), with all inputs reversed to
 * internal byte order before hashing and the output returned as display hex.
 */
export function computeTac(prevTac: string, blockHash: string, basmRoot: string): string {
  const input = Buffer.concat([
    displayHexToInternal(prevTac.toLowerCase()),
    displayHexToInternal(blockHash.toLowerCase()),
    displayHexToInternal(basmRoot.toLowerCase())
  ])
  return internalToDisplayHex(sha256d(input))
}

export function extractMerkleProofMetadata(txid: string, proof?: MerklePath): MerkleProofMetadata | undefined {
  if (proof === undefined) {
    return undefined
  }

  const leaf = proof.path[0]?.find(candidate => candidate.hash === txid)
  if (leaf === undefined) {
    return undefined
  }

  return {
    blockHeight: proof.blockHeight,
    blockIndex: leaf.offset,
    merkleRoot: proof.computeRoot(txid)
  }
}
