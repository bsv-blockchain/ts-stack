import { BASM_ZERO_HASH } from './BASM.js'
import type { AdmittedTxRef, TopicAnchorTip, TopicBlockAnchor } from './BASM.js'

/** Local acceptance limits, not Bitcoin consensus limits. */
export interface BASMRemoteLimits {
  maxResponseBytes: number
  maxProofBytes: number
  maxRawTransactionBytes: number
  maxAdmittedTxids: number
  maxRequestedTxids: number
  maxAnchorRange: number
  timeoutMs: number
}

export const DEFAULT_BASM_REMOTE_LIMITS: Readonly<BASMRemoteLimits> = Object.freeze({
  maxResponseBytes: 64 * 1024 * 1024,
  maxProofBytes: 8 * 1024 * 1024,
  maxRawTransactionBytes: 32 * 1024 * 1024,
  maxAdmittedTxids: 100000,
  maxRequestedTxids: 1000,
  maxAnchorRange: 1024,
  timeoutMs: 30000
})

export class BASMProtocolError extends Error {
  constructor(
    public readonly code:
      | 'BASM_INVALID_RESPONSE'
      | 'BASM_RESOURCE_LIMIT'
      | 'BASM_UNSUPPORTED'
      | 'BASM_TIMEOUT'
      | 'BASM_HTTP_ERROR',
    message: string
  ) {
    super(message)
    this.name = 'BASMProtocolError'
  }
}

export function requireBASM(condition: boolean, message: string): asserts condition {
  if (!condition) throw new BASMProtocolError('BASM_INVALID_RESPONSE', message)
}

export function requireBASMLimit(condition: boolean, message: string): void {
  if (!condition) throw new BASMProtocolError('BASM_RESOURCE_LIMIT', message)
}

export function basmObject(value: unknown): Record<string, unknown> {
  requireBASM(
    typeof value === 'object' && value !== null && !Array.isArray(value),
    'Expected a BASM JSON object'
  )
  return value as Record<string, unknown>
}

export function basmInteger(value: unknown, label: string, minimum = 0): number {
  requireBASM(
    typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum,
    `Invalid BASM ${label}`
  )
  return value
}

export function basmHash(value: unknown, label: string): string {
  requireBASM(typeof value === 'string' && /^[0-9a-f]{64}$/.test(value), `Invalid BASM ${label}`)
  return value
}

export function basmHex(value: unknown, label: string, maxBytes: number): string {
  requireBASM(typeof value === 'string', `Invalid BASM ${label}`)
  requireBASMLimit(value.length <= maxBytes * 2, `BASM ${label} exceeds byte limit`)
  requireBASM(
    value.length > 0 && value.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(value),
    `Invalid BASM ${label}`
  )
  return value
}

export function basmTxids(value: unknown, maximum: number): string[] {
  requireBASM(Array.isArray(value), 'Invalid BASM txids')
  requireBASMLimit(value.length <= maximum, 'BASM txid count exceeds limit')
  const txids = value.map(txid => basmHash(txid, 'txid'))
  requireBASM(new Set(txids).size === txids.length, 'Duplicate BASM txid')
  return txids
}

export function basmTip(value: unknown, topic: string): TopicAnchorTip {
  const obj = basmObject(value)
  requireBASM(obj.topic === topic, 'BASM topic mismatch')
  const blockHeight = basmInteger(obj.blockHeight, 'tip height', -1)
  const tac = basmHash(obj.tac, 'TAC')
  const tip: TopicAnchorTip = { topic, blockHeight, tac }
  if (obj.blockHash !== undefined) tip.blockHash = basmHash(obj.blockHash, 'block hash')
  if (obj.basmRoot !== undefined) tip.basmRoot = basmHash(obj.basmRoot, 'root')
  if (obj.admittedCount !== undefined)
    tip.admittedCount = basmInteger(obj.admittedCount, 'admitted count')
  if (blockHeight === -1) requireBASM(tac === BASM_ZERO_HASH, 'Empty BASM tip must have zero TAC')
  return tip
}

export function basmAnchor(value: unknown, topic: string): TopicBlockAnchor {
  const obj = basmObject(value)
  const tip = basmTip(value, topic)
  return {
    topic,
    blockHeight: basmInteger(tip.blockHeight, 'anchor height'),
    blockHash: basmHash(obj.blockHash, 'block hash'),
    basmRoot: basmHash(obj.basmRoot, 'root'),
    admittedCount: basmInteger(obj.admittedCount, 'admitted count'),
    tac: tip.tac
  }
}

export function basmAdmitted(value: unknown, maximum: number): AdmittedTxRef[] {
  requireBASM(Array.isArray(value), 'Invalid BASM admitted list')
  requireBASMLimit(value.length <= maximum, 'BASM admitted count exceeds limit')
  let previousIndex = -1
  const seen = new Set<string>()
  return value.map(item => {
    const obj = basmObject(item)
    const txid = basmHash(obj.txid, 'txid')
    const blockIndex = basmInteger(obj.blockIndex, 'block index')
    requireBASM(
      blockIndex > previousIndex && !seen.has(txid),
      'BASM admitted list must have unique txids in increasing block order'
    )
    previousIndex = blockIndex
    seen.add(txid)
    return { txid, blockIndex }
  })
}
