import {
  TransactionEvidenceCoordinator,
  TransactionEvidenceError,
  OutputProtocolError,
  canonicalOutputJSON,
  outputHex32,
  outputU64,
  defaultTransactionEvidenceLimits,
  type ChainTracker,
  type TransactionEvidenceLimits
} from '@bsv/sdk'
import { assembleOutputEvidence, factFromAssembly } from './EvidenceAssembler.js'
import { parseVerificationContext } from './validation.js'
import type {
  ChainView,
  EvidenceCandidate,
  EvidenceVerifier,
  VerificationContext,
  VerificationResult
} from './ports.js'

export interface ImmutableChainView {
  readonly view: ChainView
  readonly tracker: ChainTracker
  /** Header from this exact validated ancestry, not a current-height lookup. */
  header(height: number, signal: AbortSignal): Promise<{ hash: string; merkleRoot: string }>
}
export interface ChainViewResolver {
  /** Missing historical ancestry is reset-required, never a different latest view. */
  resolve(view: ChainView, signal: AbortSignal): Promise<ImmutableChainView>
}

type VerificationIdentity = { contextId: string; variantId: string }
function negative(
  identity: VerificationIdentity,
  status: Exclude<VerificationResult['status'], 'verified'>
): VerificationResult {
  return { status, ...identity, reason: `Evidence verification ${status}`, dependencies: [] }
}

/**
 * Adapts exact-target evidence to the existing bounded SDK verifier. The caller
 * supplies immutable validated header views; this adapter does not invent a
 * consensus rule, an unspentness assertion or a trusted remote chain namespace.
 */
export class SDKEvidenceVerifier implements EvidenceVerifier {
  private active = 0
  private readonly limits: Readonly<TransactionEvidenceLimits>

  constructor(
    private readonly chains: ChainViewResolver,
    limits: Partial<TransactionEvidenceLimits> = {}
  ) {
    this.limits = Object.freeze({ ...defaultTransactionEvidenceLimits, ...limits })
    for (const [key, value] of Object.entries(this.limits)) {
      if (
        !Object.hasOwn(defaultTransactionEvidenceLimits, key) ||
        !Number.isSafeInteger(value) ||
        value < 1
      )
        throw new OutputProtocolError('invalid', 'Invalid verifier limit')
    }
    if (this.limits.requestTimeoutMs > 60000 || this.limits.attemptTimeoutMs > 60000)
      throw new OutputProtocolError('invalid', 'Verifier timeout exceeds one minute')
  }

  async verify(
    candidate: EvidenceCandidate,
    context: VerificationContext,
    signal: AbortSignal
  ): Promise<VerificationResult> {
    const identity = { contextId: context.id, variantId: candidate.variantId }
    if (signal.aborted) return negative(identity, 'cancelled')
    if (this.active >= this.limits.consumers) return negative(identity, 'limited')
    let owned: EvidenceCandidate, snapshot: VerificationContext, remaining: bigint
    try {
      owned = JSON.parse(canonicalOutputJSON(candidate)) as EvidenceCandidate
      snapshot = parseVerificationContext(context)
      remaining = outputU64(snapshot.limits.deadline) * 1000n - BigInt(Date.now())
    } catch {
      return negative(identity, 'invalid')
    }
    if (remaining <= 0n) return negative(identity, 'limited')
    const timeout = Number(
      remaining < BigInt(this.limits.requestTimeoutMs)
        ? remaining
        : BigInt(this.limits.requestTimeoutMs)
    )
    const controller = new AbortController()
    let outcome: 'cancelled' | 'limited' = 'cancelled'
    const cancel = (): void => controller.abort()
    signal.addEventListener('abort', cancel, { once: true })
    let onAbort: () => void = () => {}
    const aborted = new Promise<VerificationResult>(resolve => {
      onAbort = () => resolve(negative(identity, outcome))
      controller.signal.addEventListener('abort', onAbort, { once: true })
    })
    const timer = setTimeout(() => {
      outcome = 'limited'
      controller.abort()
    }, timeout)
    this.active++
    // A dependency ignoring cancellation keeps its slot until it actually settles.
    const work = this.verifyOwned(owned, snapshot, controller.signal).finally(() => {
      this.active--
    })
    try {
      return await Promise.race([work, aborted])
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', cancel)
      controller.signal.removeEventListener('abort', onAbort)
    }
  }

  private async verifyOwned(
    candidate: EvidenceCandidate,
    context: VerificationContext,
    signal: AbortSignal
  ): Promise<VerificationResult> {
    const identity = { contextId: context.id, variantId: candidate.variantId }
    let coordinator: TransactionEvidenceCoordinator | undefined
    let dependencyUnavailable = false
    const chainCall = async <T>(operation: () => Promise<T>): Promise<T> => {
      try {
        return await operation()
      } catch {
        dependencyUnavailable = true
        throw new TransactionEvidenceError(signal.aborted ? 'cancelled' : 'context-changed')
      }
    }
    try {
      if (canonicalOutputJSON(candidate.chain) !== canonicalOutputJSON(context.view.chain))
        throw new OutputProtocolError('invalid', 'Evidence chain differs from verification context')
      const limits = {
        ...this.limits,
        candidateBytes: Math.min(context.limits.bytes, this.limits.candidateBytes),
        transactions: Math.min(context.limits.transactions, this.limits.transactions),
        inputs: Math.min(context.limits.dependencies, this.limits.inputs)
      }
      const plan = assembleOutputEvidence(candidate.evidence, candidate.chain, {
        bytes: limits.candidateBytes,
        transactions: limits.transactions,
        dependencies: limits.inputs
      })
      if (candidate.variantId !== plan.variantId)
        throw new OutputProtocolError('invalid', 'Evidence variant digest mismatch')
      if (plan.missing.length || !plan.target || !plan.atomicBeef)
        return {
          status: 'unresolved',
          ...identity,
          reason: 'Required transaction bytes are missing',
          dependencies: plan.missing
        }
      const view = await chainCall(async () => await this.chains.resolve(context.view, signal))
      if (signal.aborted) return negative(identity, 'cancelled')
      if (canonicalOutputJSON(view.view) !== canonicalOutputJSON(context.view))
        throw new OutputProtocolError('context-changed', 'Chain resolver returned a different view')
      const expectedHeight = outputU64(context.view.tipHeight)
      if (expectedHeight > BigInt(Number.MAX_SAFE_INTEGER))
        throw new OutputProtocolError('limited', 'SDK chain height representation limit')
      const tracker: ChainTracker = {
        currentHeight: async querySignal => {
          const height = await chainCall(async () => await view.tracker.currentHeight(querySignal))
          if (height !== Number(expectedHeight))
            throw new TransactionEvidenceError('context-changed')
          return height
        },
        isValidRootForHeight: async (root, height, querySignal) => {
          if (height > Number(expectedHeight)) return false
          const header = await chainCall(
            async () => await view.header(height, querySignal ?? signal)
          )
          return (
            header.merkleRoot === root &&
            (await chainCall(
              async () => await view.tracker.isValidRootForHeight(root, height, querySignal)
            ))
          )
        },
        getVerificationContextToken:
          view.tracker.getVerificationContextToken === undefined
            ? async () => canonicalOutputJSON(context.view)
            : querySignal =>
                chainCall(async () => await view.tracker.getVerificationContextToken!(querySignal))
      }
      coordinator = new TransactionEvidenceCoordinator({
        chainTracker: tracker,
        chainNamespace: canonicalOutputJSON(context.view.chain),
        policyId: context.policyDigest,
        limits
      })
      await coordinator.verify(
        { beef: plan.atomicBeef, txid: plan.target.txid, outputIndex: plan.evidence.outputIndex },
        { signal }
      )
      if (signal.aborted) return negative(identity, 'cancelled')
      let placement: { blockHash: string; height: string } | undefined
      if (plan.target.blockHeight !== undefined) {
        const header = await chainCall(
          async () => await view.header(plan.target!.blockHeight!, signal)
        )
        outputHex32(header.hash)
        if (header.merkleRoot !== plan.target.merkleRoot)
          throw new OutputProtocolError('context-changed', 'Placement header changed')
        placement = { blockHash: header.hash, height: String(plan.target.blockHeight) }
      }
      if (signal.aborted) return negative(identity, 'cancelled')
      return {
        status: 'verified',
        ...identity,
        fact: factFromAssembly(plan.chain, plan.target),
        ...(placement ? { placement } : {})
      }
    } catch (error) {
      const code =
        error instanceof TransactionEvidenceError || error instanceof OutputProtocolError
          ? error.code
          : 'invalid'
      const status =
        signal.aborted || code === 'cancelled' || code === 'disposed'
          ? 'cancelled'
          : dependencyUnavailable
            ? 'limited'
            : code === 'context-changed'
              ? 'context-changed'
              : ['limited', 'limit', 'timeout', 'unavailable', 'reset-required'].includes(code)
                ? 'limited'
                : 'invalid'
      return negative(identity, status)
    } finally {
      coordinator?.dispose()
    }
  }
}
