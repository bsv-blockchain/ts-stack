import {
  bindOutputReleaseEvidence,
  canonicalOutputJSON,
  decodeOutputBytes,
  Hash,
  outputAssert,
  outputU64,
  OutputProtocolError,
  parseOutputJSON,
  Utils,
  verifyOutputProcessorAcceptance,
  type OutputReleaseBinding,
  type OutputReleaseEvidence,
  type TransactionEvidenceLimits
} from '@bsv/sdk'
import { SDKEvidenceVerifier, type ChainViewResolver } from '../SDKEvidenceVerifier.js'
import type { VerificationContext } from '../ports.js'
import { parseVerificationContext } from '../validation.js'

export interface PrivateReleasePremises {
  /** Locally observed assessment time, not block time or caller-supplied HTTP metadata. */
  now: string
  /** Exact local acceptance time from the durable owner or its atomic acceptance commit. */
  localAcceptedAt?: string
  /** Installed immutable validated ancestry; required only for the mined policy. */
  verification?: VerificationContext
  /** Synchronous service/authority and, for mined policy, same-view commit guard. */
  current(context: VerificationContext | undefined): boolean
}
export interface PrivateReleaseAssessment {
  evidence: OutputReleaseEvidence
  /** Invoke inside the native owner commit, before any release effect. */
  checkCurrent(): void
}

/**
 * BRC-195/196 policy evidence checks shared by acquisition and purchase services.
 * Local provenance comes from the installed durable admission owner, including
 * an acceptance committed atomically with the new protected funding intent. A
 * processor policy is independently selected/trusted by the caller. Mined mode
 * executes exact-target Script/SPV against the installed immutable ancestry; it
 * never infers confirmations from remote heights or a broadcast acknowledgement.
 * Historical delivered evidence is retained, not re-gated through this class.
 */
export class SDKPrivateReleaseEvidence {
  private readonly verifier: SDKEvidenceVerifier
  private readonly resolve: ChainViewResolver['resolve']
  constructor(
    private readonly chains: ChainViewResolver,
    limits: Partial<TransactionEvidenceLimits> = {},
    private readonly maximumEvidenceBytes = 131072
  ) {
    outputAssert(
      typeof chains.resolve === 'function',
      'Immutable release ancestry resolver is required'
    )
    outputAssert(
      Number.isSafeInteger(maximumEvidenceBytes) &&
        maximumEvidenceBytes > 0 &&
        maximumEvidenceBytes <= 131072,
      'Invalid release evidence allowance'
    )
    this.resolve = chains.resolve
    this.verifier = new SDKEvidenceVerifier(chains, limits)
  }
  async verify(
    input: unknown,
    expected: OutputReleaseBinding,
    premises: PrivateReleasePremises,
    signal: AbortSignal
  ): Promise<PrivateReleaseAssessment> {
    const evidence = bindOutputReleaseEvidence(
      parseOutputJSON(canonicalOutputJSON(input, { bytes: this.maximumEvidenceBytes }), {
        bytes: this.maximumEvidenceBytes
      }),
      expected
    )
    const now = outputU64(premises.now),
      localAcceptedAt = premises.localAcceptedAt
    outputAssert(outputU64(evidence.acceptedAt) <= now, 'Release acceptance is in the future')
    outputAssert(
      typeof premises.current === 'function' &&
        premises.current.constructor.name !== 'AsyncFunction',
      'Release currentness must be synchronous'
    )
    const current = premises.current
    const snapshot =
      premises.verification === undefined
        ? undefined
        : parseVerificationContext(premises.verification)
    const checkCurrent = () => {
      outputAssert(!signal.aborted, 'Release verification cancelled', 'cancelled')
      if (snapshot !== undefined)
        outputAssert(
          BigInt(Date.now()) < outputU64(snapshot.limits.deadline) * 1000n,
          'Release verification deadline elapsed',
          'limited'
        )
      outputAssert(
        this.chains.resolve === this.resolve,
        'Release ancestry capability changed',
        'context-changed'
      )
      let value: unknown
      try {
        value = current(snapshot === undefined ? undefined : structuredClone(snapshot))
      } catch {
        throw new OutputProtocolError(
          'context-changed',
          'Release verification context changed',
          true
        )
      }
      if (value instanceof Promise) void value.catch(() => undefined)
      outputAssert(
        value === true && !signal.aborted,
        'Release verification context changed',
        'context-changed'
      )
    }
    checkCurrent()
    if (evidence.policy.kind === 'local-admission') {
      outputAssert(
        localAcceptedAt !== undefined &&
          outputU64(localAcceptedAt).toString() === evidence.acceptedAt,
        'Local release needs the retained durable acceptance time'
      )
    } else if (evidence.policy.kind === 'processor-accepted') {
      verifyOutputProcessorAcceptance(evidence, expected)
    } else {
      outputAssert(
        snapshot !== undefined,
        'Mined release needs an installed verification context',
        'unavailable'
      )
      await this.mined(evidence, snapshot, signal)
    }
    checkCurrent()
    return { evidence, checkCurrent }
  }
  private async mined(
    evidence: OutputReleaseEvidence,
    snapshot: VerificationContext,
    signal: AbortSignal
  ): Promise<void> {
    const block = evidence.blockEvidence!
    outputAssert(
      canonicalOutputJSON(snapshot.view.chain) === canonicalOutputJSON(evidence.chain) &&
        block.contextId === snapshot.id &&
        block.chainPolicyDigest === snapshot.view.chainPolicyDigest &&
        block.tipHash === snapshot.view.tipHash &&
        block.tipHeight === snapshot.view.tipHeight,
      'Mined release differs from installed ancestry',
      'context-changed'
    )
    const bytes = decodeOutputBytes(block.beef, Math.min(65536, snapshot.limits.bytes))
    const verified = await this.verifier.verify(
      {
        chain: evidence.chain,
        evidence: { txid: evidence.txid, outputIndex: 0, beef: block.beef },
        variantId: Utils.toHex(Hash.sha256(bytes))
      },
      snapshot,
      signal
    )
    if (verified.status !== 'verified') {
      const code = verified.status === 'unresolved' ? 'unavailable' : verified.status
      throw new OutputProtocolError(
        code,
        `Mined release verification ${verified.status}`,
        code !== 'invalid'
      )
    }
    outputAssert(
      verified.placement !== undefined,
      'Release target has no verified inclusion',
      'unavailable'
    )
    outputAssert(
      verified.placement.blockHash === block.blockHash &&
        verified.placement.height === block.height,
      'Release inclusion differs from verified ancestry'
    )
  }
}
