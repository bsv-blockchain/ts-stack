import {
  Hash,
  Utils,
  canonicalOutputJSON,
  closedOutputObject,
  outputHex32,
  outputString,
  outputU32,
  outputU64,
  OutputProtocolError,
  type OutputJSONObject
} from '@bsv/sdk'
import { EvidencePool, type EvidenceSupport } from './EvidencePool.js'
import { factFromAssembly } from './EvidenceAssembler.js'
import { parseVerificationContext } from './validation.js'
import { compareKnowledgeText } from './SourceMembership.js'
import type { EvidenceVerifier, VerificationContext, VerificationResult } from './ports.js'

/** Local storage reference, not a transferable or provider-authenticated attestation. */
export interface ProofReference {
  basis: string
  receipts: string[]
  txid: string
  outputIndex: number
  variantId: string
}
export interface ProofCheck {
  contextId: string
  status: VerificationResult['status']
  placement?: { blockHash: string; height: string }
}
export interface VerifiedWork {
  proof: ProofReference
  checks: ProofCheck[]
}
export interface KnowledgeLocalFrame {
  profile: 'urn:bsv:output-knowledge:local-verification:1'
  version: 1
  nonFinal: boolean
  work: VerifiedWork[]
}
const profile = 'urn:bsv:output-knowledge:local-verification:1' as const
const statuses = ['verified', 'invalid', 'unresolved', 'limited', 'cancelled', 'context-changed']
function assertLocal(condition: unknown, message: string): asserts condition {
  if (!condition) throw new OutputProtocolError('invalid', message)
}
function localId(value: unknown): string {
  assertLocal(
    typeof value === 'string' &&
      value.length > 0 &&
      new TextEncoder().encode(value).length <= 16384,
    'Invalid local evidence reference'
  )
  return value
}
export function proofReference(support: EvidenceSupport): ProofReference {
  return {
    basis: support.basis,
    receipts: [...support.receipts],
    txid: support.candidate.evidence.txid,
    outputIndex: support.candidate.evidence.outputIndex,
    variantId: support.candidate.variantId
  }
}
export function proofReferenceKey(proof: ProofReference): string {
  return canonicalOutputJSON(proof)
}

export function parseKnowledgeLocalFrame(input: unknown): KnowledgeLocalFrame {
  const value: unknown = JSON.parse(canonicalOutputJSON(input))
  closedOutputObject(value, ['profile', 'version', 'nonFinal', 'work'])
  if (value.profile !== profile || value.version !== 1)
    throw new OutputProtocolError('unsupported', 'Unknown local verification storage profile')
  assertLocal(
    typeof value.nonFinal === 'boolean' && Array.isArray(value.work),
    'Invalid local verification frame'
  )
  const seen = new Set<string>()
  const work = value.work.map(item => {
    closedOutputObject(item, ['proof', 'checks'])
    closedOutputObject(item.proof, ['basis', 'receipts', 'txid', 'outputIndex', 'variantId'])
    const source = item.proof
    assertLocal(
      Array.isArray(source.receipts) && source.receipts.length > 0 && source.receipts.length <= 32,
      'Invalid supporting receipt set'
    )
    const receipts = source.receipts.map(localId)
    assertLocal(
      receipts.every(
        (receipt, index) => index === 0 || compareKnowledgeText(receipts[index - 1], receipt) < 0
      ) && receipts.includes(localId(source.basis)),
      'Invalid original receipt reference'
    )
    const proof = {
      basis: localId(source.basis),
      receipts,
      txid: outputHex32(source.txid),
      outputIndex: outputU32(source.outputIndex),
      variantId: outputHex32(source.variantId)
    }
    const key = proofReferenceKey(proof)
    assertLocal(!seen.has(key), 'Duplicate local proof reference')
    seen.add(key)
    assertLocal(Array.isArray(item.checks), 'Invalid local proof checks')
    const contexts = new Set<string>()
    const checks = item.checks.map(raw => {
      closedOutputObject(raw, ['contextId', 'status'], ['placement'])
      const contextId = outputString(raw.contextId)
      assertLocal(
        !contexts.has(contextId) && statuses.includes(raw.status as string),
        'Invalid or duplicated local context check'
      )
      contexts.add(contextId)
      let placement: ProofCheck['placement']
      if (raw.placement !== undefined) {
        assertLocal(raw.status === 'verified', 'Only verified evidence has placement')
        closedOutputObject(raw.placement, ['blockHash', 'height'])
        outputU64(raw.placement.height)
        placement = {
          blockHash: outputHex32(raw.placement.blockHash),
          height: raw.placement.height as string
        }
      }
      return {
        contextId,
        status: raw.status as ProofCheck['status'],
        ...(placement ? { placement } : {})
      }
    })
    return { proof, checks }
  })
  return { profile, version: 1, nonFinal: value.nonFinal, work }
}

export function knowledgeLocalFrame(nonFinal: boolean, work: VerifiedWork[]): OutputJSONObject {
  return JSON.parse(
    canonicalOutputJSON(parseKnowledgeLocalFrame({ profile, version: 1, nonFinal, work }))
  ) as OutputJSONObject
}

/** Replayable local proof decisions; a remote source cannot insert these checks. */
export class VerificationLedger {
  private work = new Map<string, VerifiedWork>()
  constructor(readonly nonFinal: boolean) {}

  apply(
    input: unknown,
    pool: EvidencePool,
    contexts: ReadonlyMap<string, VerificationContext>
  ): void {
    const frame = parseKnowledgeLocalFrame(input)
    if (frame.nonFinal !== this.nonFinal)
      throw new OutputProtocolError(
        'reset-required',
        'Spend policy changed without an explicit journal generation reset'
      )
    const next = new Map(this.work)
    for (const addition of frame.work) {
      const support = pool.materialize(
        addition.proof.basis,
        addition.proof.receipts,
        addition.proof
      )
      if (support.candidate.variantId !== addition.proof.variantId)
        throw new OutputProtocolError('reset-required', 'Retained proof bytes changed')
      const key = proofReferenceKey(addition.proof),
        previous = next.get(key)
      const checks = new Map(previous?.checks.map(check => [check.contextId, check]) ?? [])
      for (const check of addition.checks) {
        const context = contexts.get(check.contextId)
        if (!context)
          throw new OutputProtocolError(
            'reset-required',
            'Historical verification context is unavailable'
          )
        if (
          canonicalOutputJSON(context.view.chain) !== canonicalOutputJSON(support.candidate.chain)
        )
          throw new OutputProtocolError('invalid', 'Proof check changed configured chain')
        if (
          check.placement &&
          outputU64(check.placement.height) > outputU64(context.view.tipHeight)
        )
          throw new OutputProtocolError('invalid', 'Proof placement is beyond the selected view')
        const prior = checks.get(check.contextId)
        if (
          prior?.status === 'verified' &&
          canonicalOutputJSON(prior) !== canonicalOutputJSON(check)
        )
          throw new OutputProtocolError(
            'context-changed',
            'A verified immutable proof context changed'
          )
        checks.set(check.contextId, check)
      }
      next.set(key, { proof: addition.proof, checks: [...checks.values()] })
    }
    this.work = next
  }
  entries(): VerifiedWork[] {
    return JSON.parse(JSON.stringify([...this.work.values()])) as VerifiedWork[]
  }
  get(proof: ProofReference, contextId: string): ProofCheck | undefined {
    const check = this.work
      .get(proofReferenceKey(proof))
      ?.checks.find(value => value.contextId === contextId)
    return check ? (JSON.parse(JSON.stringify(check)) as ProofCheck) : undefined
  }
}

/**
 * Verify an immutable historical view with a fresh local work deadline. This does
 * not refresh source authentication, an offer, an assessment or a release policy.
 * Readiness still names the original retained chain/finality context.
 */
export async function checkRetainedProof(
  verifier: EvidenceVerifier,
  support: EvidenceSupport,
  selected: VerificationContext,
  signal: AbortSignal,
  options: { now?: () => number; deadlineMs?: number } = {}
): Promise<ProofCheck> {
  const original = parseVerificationContext(selected),
    milliseconds = (options.now ?? Date.now)(),
    deadlineMs = options.deadlineMs ?? 15000
  assertLocal(
    Number.isSafeInteger(milliseconds) &&
      milliseconds >= 0 &&
      Number.isSafeInteger(deadlineMs) &&
      deadlineMs > 0 &&
      deadlineMs <= 60000,
    'Invalid verification work clock or deadline'
  )
  const now = String(Math.floor(milliseconds / 1000)),
    deadline = String(Math.ceil((milliseconds + deadlineMs) / 1000))
  const id = `recheck-${Utils.toHex(Hash.sha256(Utils.toArray(canonicalOutputJSON({ context: original, now, deadline }), 'utf8')))}`
  const context: VerificationContext = {
    ...original,
    id,
    now,
    limits: { ...original.limits, deadline }
  }
  const candidate = JSON.parse(
    canonicalOutputJSON(support.candidate)
  ) as EvidenceSupport['candidate']
  const result = await verifier.verify(candidate, context, signal)
  if (signal.aborted)
    throw new OutputProtocolError('cancelled', 'Verification result arrived after cancellation')
  if (
    result.contextId !== id ||
    result.variantId !== candidate.variantId ||
    !statuses.includes(result.status)
  )
    throw new OutputProtocolError('invalid', 'Verifier result identity mismatch')
  if (result.status !== 'verified') return { contextId: original.id, status: result.status }
  if (
    !support.plan.target ||
    canonicalOutputJSON(result.fact) !==
      canonicalOutputJSON(factFromAssembly(candidate.chain, support.plan.target))
  )
    throw new OutputProtocolError('invalid', 'Verifier fact differs from reconstructed evidence')
  if (result.placement) {
    outputHex32(result.placement.blockHash)
    if (outputU64(result.placement.height) > outputU64(original.view.tipHeight))
      throw new OutputProtocolError('invalid', 'Verifier placement exceeds selected view')
  }
  return {
    contextId: original.id,
    status: 'verified',
    ...(result.placement ? { placement: { ...result.placement } } : {})
  }
}
