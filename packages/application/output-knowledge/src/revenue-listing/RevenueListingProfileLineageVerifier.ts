import {
  canonicalOutputJSON,
  Hash,
  OutputProtocolError,
  ScriptResourceLimitError,
  Utils,
  outputPacketDigest,
  type OutputOutpoint
} from '@bsv/sdk'
import {
  type RevenueListingProfile,
  type RevenueListingProfileDescriptor,
  type RevenueListingStage
} from '@bsv/sdk/script/templates/RevenueListingProfile'
import { SDKEvidenceVerifier, type ChainViewResolver } from '../SDKEvidenceVerifier.js'
import { parseVerificationContext } from '../validation.js'
import { asyncValues } from '../internal/asyncValues.js'
import type { VerificationContext, VerificationResult } from '../ports.js'
import {
  assembleLineage,
  lineageLimits,
  requireLineage,
  type RevenueListingLineageLimits
} from './LineagePackage.js'
import { executeProfileInput, inspectProfileLineage } from './ProfileLineageGraph.js'
import {
  parseRevenueListingProfileLineagePackage,
  type RevenueListingProfileLineagePackage
} from './ProfileLineagePackage.js'

type NegativeStatus = Exclude<VerificationResult['status'], 'verified'>
export type RevenueListingProfileLineageResult =
  | {
      status: 'verified'
      verificationContext: VerificationContext
      listingId: string
      descriptor: RevenueListingProfileDescriptor
      genesis: RevenueListingProfileLineagePackage['genesis']
      target: OutputOutpoint
      stage: RevenueListingStage
      satoshis: string
      rawTransaction: string
      /** Sorted distinct listing transactions; shared ancestors occur once. */
      transactions: string[]
    }
  | {
      status: NegativeStatus
      dependencies: OutputOutpoint[]
    }

function negative(status: NegativeStatus): RevenueListingProfileLineageResult {
  return { status, dependencies: [] }
}

function failure(error: unknown): RevenueListingProfileLineageResult {
  if (error instanceof ScriptResourceLimitError) return negative('limited')
  if (error instanceof OutputProtocolError) {
    if (error.code === 'cancelled' || error.code === 'context-changed') return negative(error.code)
    if (error.code === 'limited' || error.code === 'unavailable' || error.code === 'reset-required')
      return negative('limited')
  }
  return negative('invalid')
}

/**
 * Current immutable BRC-197 history: immutable chain evidence plus every actual input
 * invocation through reserve-stage activation back to the authorized genesis. This does not establish asset
 * authority, currentness, acquisition association, payment or private delivery.
 */
export class RevenueListingProfileLineageVerifier {
  private readonly limits: Readonly<RevenueListingLineageLimits>
  private readonly evidence: SDKEvidenceVerifier
  private active = 0
  private readonly lock: RevenueListingProfile['lock']
  private readonly decode: RevenueListingProfile['decode']
  private readonly resolve: ChainViewResolver['resolve']

  constructor(
    private readonly family: RevenueListingProfile,
    private readonly chains: ChainViewResolver,
    limits: Partial<RevenueListingLineageLimits> = {}
  ) {
    this.lock = family.lock
    this.decode = family.decode
    this.resolve = chains.resolve
    this.limits = lineageLimits(limits)
    this.evidence = new SDKEvidenceVerifier(chains, {
      candidateBytes: this.limits.bytes,
      transactions: this.limits.transactions,
      inputs: this.limits.inputs,
      scriptBytes: this.limits.bytes,
      scriptMemoryBytes: this.limits.scriptMemoryBytes,
      consumers: this.limits.concurrentRequests,
      attemptTimeoutMs: this.limits.timeoutMs,
      requestTimeoutMs: this.limits.timeoutMs
    })
  }

  async verify(
    input: unknown,
    context: VerificationContext,
    signal: AbortSignal = new AbortController().signal
  ): Promise<RevenueListingProfileLineageResult> {
    if (signal.aborted) return negative('cancelled')
    if (this.active >= this.limits.concurrentRequests) return negative('limited')
    let snapshot: VerificationContext, packet: RevenueListingProfileLineagePackage, deadline: number
    try {
      this.current()
      snapshot = parseVerificationContext(context)
      requireLineage(
        BigInt(snapshot.limits.deadline) * 1000n <= BigInt(Number.MAX_SAFE_INTEGER),
        'Unrepresentable lineage deadline'
      )
      deadline = Math.min(
        Date.now() + this.limits.timeoutMs,
        Number(snapshot.limits.deadline) * 1000
      )
      if (deadline <= Date.now()) return negative('limited')
      packet = parseRevenueListingProfileLineagePackage(input, {
        ...this.limits,
        bytes: Math.min(this.limits.bytes, snapshot.limits.bytes)
      })
      requireLineage(
        canonicalOutputJSON(packet.descriptor.chain) === canonicalOutputJSON(snapshot.view.chain),
        'Lineage context chain mismatch'
      )
    } catch (error) {
      return failure(error)
    }
    const controller = new AbortController()
    const cancel = () => controller.abort()
    signal.addEventListener('abort', cancel, { once: true })
    let status: 'cancelled' | 'limited' = 'cancelled',
      onAbort = () => {}
    const aborted = new Promise<RevenueListingProfileLineageResult>(resolve => {
      onAbort = () => resolve(negative(status))
      controller.signal.addEventListener('abort', onAbort, { once: true })
    })
    const timer = setTimeout(
      () => {
        status = 'limited'
        controller.abort()
      },
      Math.max(1, deadline - Date.now())
    )
    const check = () => {
      this.current()
      if (controller.signal.aborted) throw new OutputProtocolError(status, 'Lineage work stopped')
      if (Date.now() >= deadline)
        throw new OutputProtocolError('limited', 'Lineage deadline exceeded')
    }
    this.active++
    // A dependency that ignores cancellation continues to occupy its physical slot.
    const work = this.verifyOwned(packet, snapshot, controller.signal, check)
      .catch(failure)
      .finally(() => {
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

  private current(): void {
    if (
      this.family.lock !== this.lock ||
      this.family.decode !== this.decode ||
      this.chains.resolve !== this.resolve
    )
      throw new OutputProtocolError('context-changed', 'Installed listing profile changed')
  }

  private async verifyOwned(
    packet: RevenueListingProfileLineagePackage,
    context: VerificationContext,
    signal: AbortSignal,
    check: () => void
  ): Promise<RevenueListingProfileLineageResult> {
    check()
    const limits = {
      ...this.limits,
      transactions: Math.min(this.limits.transactions, context.limits.transactions),
      inputs: Math.min(this.limits.inputs, context.limits.dependencies)
    }
    const assembly = assembleLineage(packet, limits)
    const missing = new Map<string, OutputOutpoint>()
    for (const entry of packet.transactions) {
      const transaction = assembly.transactions.get(entry.txid)!
      for (const input of transaction.inputs) {
        if (!assembly.transactions.has(input.sourceTXID!)) {
          const point = {
            chain: packet.descriptor.chain,
            txid: input.sourceTXID!,
            outputIndex: input.sourceOutputIndex
          }
          missing.set(`${point.txid}.${point.outputIndex}`, point)
        }
      }
    }
    if (missing.size > 0) return { status: 'unresolved', dependencies: [...missing.values()] }
    const graph = inspectProfileLineage(assembly, this.family)
    check()
    if (!graph.complete) return { status: 'unresolved', dependencies: graph.missing }
    for await (const transition of asyncValues(graph.transitions)) {
      // Yield between bounded fixed-program invocations so cancellation/timers can run.
      await new Promise<void>(resolve => setTimeout(resolve, 0))
      check()
      const txid = transition.transaction.id('hex'),
        bytes = assembly.beef.toBinaryAtomic(txid)
      const result = await this.evidence.verify(
        {
          chain: packet.descriptor.chain,
          evidence: { txid, outputIndex: 0, beef: Utils.toBase64(bytes) },
          variantId: Utils.toHex(Hash.sha256(bytes))
        },
        context,
        signal
      )
      check()
      if (result.status !== 'verified')
        return { status: result.status, dependencies: result.dependencies }
      for await (const index of asyncValues(
        transition.transaction.inputs.map((_, index) => index)
      )) {
        await new Promise<void>(resolve => setTimeout(resolve, 0))
        check()
        executeProfileInput(assembly, transition.transaction, index, this.limits.scriptMemoryBytes)
        check()
      }
    }
    check()
    return {
      status: 'verified',
      verificationContext: context,
      listingId: outputPacketDigest('sale-listing', packet.descriptor),
      descriptor: packet.descriptor,
      genesis: packet.genesis,
      target: packet.target,
      stage: graph.stage,
      satoshis: graph.satoshis,
      rawTransaction: graph.rawTransaction,
      transactions: packet.transactions.map(entry => entry.txid)
    }
  }
}
