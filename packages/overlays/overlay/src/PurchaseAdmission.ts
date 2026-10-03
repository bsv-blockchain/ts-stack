import {
  Beef,
  canonicalOutputBase,
  canonicalOutputJSON,
  closedOutputObject,
  decodeOutputBytes,
  outputAssert,
  outputHex32,
  outputIdentity,
  outputString,
  outputU64,
  OUTPUT_PROFILES,
  parseOutputJSON,
  parseOutputPurchasePrepare,
  parseOutputPurchaseSubmit,
  restoreOutputCapability,
  verifyOutputPurchaseTerms,
  type OutputCapabilitySelection,
  type OutputCapabilityRecoveryRequest,
  type OutputCapabilityRequest,
  type OutputPurchasePrepare,
  type OutputPurchaseSubmit,
  type OutputSignedPurchaseTerms,
  type STEAK
} from '@bsv/sdk'
import type { Engine } from './Engine.js'
import {
  getOverlayAdmissionHost,
  overlayAdmissionContextDigest,
  OVERLAY_ENGINE_POLICY_ID
} from './EngineAdmission.js'
import {
  getAdmissionHistory,
  type AdmissionHistoryQuery,
  type StorageScope
} from './storage/AdmissionStorage.js'
import { timedRetainedTopicAdmission } from './RetainedTopicAdmission.js'

export interface OverlayPurchaseAdmissionJob {
  operationId: string
  original: {
    request: OutputPurchasePrepare
    terms: OutputSignedPurchaseTerms
    capability: unknown
  }
  candidate: OutputPurchaseSubmit
}
export type OverlayPurchaseAdmissionOutcome =
  | { status: 'unresolved'; operationId: string; txid: string }
  | {
      status: 'admitted'
      operationId: string
      txid: string
      steak: STEAK
      acceptedAt: string
      assessmentContextId: string
    }
export interface OverlayPurchaseAdmissionContext {
  /** Current installed domain/recipient and original durable intent. No wire verdict. */
  checkCurrent(): void
}

/** Optional BRC-196 public admission bridge. An installed domain must fully
 * verify the candidate and reserve its original private intent before calling.
 * Read original history before submit, ignore duplicate-response STEAK, and
 * recover the selected topic with its original server-commit time. No secret
 * or private material is passed into Engine, its lookup services or GASP.
 */
export class OverlayPurchaseAdmission {
  readonly maximumOutcomeBytes: number
  private readonly engine: Engine
  private readonly identity: string
  private readonly topic: string
  private readonly rulesDigest: string
  private readonly scope: StorageScope
  private readonly storage: Engine['storage']
  private readonly history: NonNullable<ReturnType<typeof getAdmissionHistory>>
  private readonly readHistory: NonNullable<ReturnType<typeof getAdmissionHistory>>['read']
  private readonly admission: NonNullable<ReturnType<typeof getOverlayAdmissionHost>>['admission']
  private readonly manager: Engine['managers'][string]
  private readonly submit: Engine['submit']
  private readonly maximumRequestBytes: number
  private readonly trust: OutputCapabilityRecoveryRequest
  private readonly domainProfile: string
  private readonly admittedOutputIndex: number
  constructor(options: {
    engine: Engine
    identity: string
    topic: string
    rulesDigest: string
    baseURL: string
    rules: OutputCapabilityRequest['rules']
    domainProfile: string
    admittedOutputIndex: number
    maximumRequestBytes?: number
    maximumOutcomeBytes?: number
  }) {
    this.engine = options.engine
    this.identity = outputIdentity(options.identity)
    this.topic = outputString(options.topic)
    this.rulesDigest = outputHex32(options.rulesDigest)
    this.domainProfile = outputString(options.domainProfile)
    outputAssert(
      /^[A-Za-z][A-Za-z0-9+.-]*:/.test(this.domainProfile),
      'Purchase domain profile requires an absolute IRI'
    )
    this.admittedOutputIndex = options.admittedOutputIndex
    outputAssert(
      Number.isSafeInteger(this.admittedOutputIndex) &&
        this.admittedOutputIndex >= 0 &&
        this.admittedOutputIndex <= 4294967295,
      'Invalid purchase admission output index'
    )
    this.maximumRequestBytes = options.maximumRequestBytes ?? 4194304
    this.maximumOutcomeBytes = options.maximumOutcomeBytes ?? 131072
    outputAssert(
      Number.isSafeInteger(this.maximumRequestBytes) &&
        this.maximumRequestBytes > 0 &&
        this.maximumRequestBytes <= 4194304,
      'Invalid purchase admission request allowance'
    )
    outputAssert(
      Number.isSafeInteger(this.maximumOutcomeBytes) &&
        this.maximumOutcomeBytes >= 128 &&
        this.maximumOutcomeBytes <= 131072,
      'Invalid purchase admission outcome allowance'
    )
    const host = getOverlayAdmissionHost(options.engine.storage),
      history = getAdmissionHistory(options.engine.storage)
    outputAssert(host && history, 'Original timed admission history is required', 'unsupported')
    outputAssert(
      options.engine.managers[this.topic],
      'Purchase topic is not installed',
      'unsupported'
    )
    this.scope = { ...host.admissionScope }
    this.trust = {
      baseURL: canonicalOutputBase(options.baseURL),
      identity: this.identity,
      chain: { network: this.scope.network, genesisHash: this.scope.genesisHash },
      service: this.topic,
      kind: 'topic',
      profile: OUTPUT_PROFILES.purchase,
      rules: new Map(options.rules)
    }
    this.storage = options.engine.storage
    this.history = history
    this.readHistory = history.read
    this.admission = host.admission
    this.manager = options.engine.managers[this.topic]
    this.submit = options.engine.submit
  }
  async recover(
    input: OverlayPurchaseAdmissionJob,
    signal: AbortSignal,
    context: OverlayPurchaseAdmissionContext
  ): Promise<OverlayPurchaseAdmissionOutcome> {
    outputAssert(
      typeof context?.checkCurrent === 'function' &&
        context.checkCurrent.constructor.name !== 'AsyncFunction',
      'Purchase admission needs a synchronous original-context guard'
    )
    const check = context.checkCurrent
    const current = () => {
      outputAssert(!signal.aborted, 'Purchase admission cancelled', 'cancelled')
      this.currentHistory()
      outputAssert(
        context.checkCurrent === check,
        'Purchase admission context guard changed',
        'context-changed'
      )
      const result: unknown = check.call(context)
      if (result instanceof Promise) void result.catch(() => undefined)
      outputAssert(
        result === undefined && !signal.aborted,
        'Purchase admission context changed',
        'context-changed'
      )
      this.currentHistory()
    }
    current()
    // This local job combines two independently bounded wire records. Own them
    // separately instead of widening the SDK's four-MiB network JSON ceiling.
    closedOutputObject(input, ['operationId', 'original', 'candidate'])
    const original = parseOutputJSON(canonicalOutputJSON(input.original, { bytes: 4194304 }), {
      bytes: 4194304
    })
    closedOutputObject(original, ['request', 'terms', 'capability'], ['format', 'createdAt'])
    const operationId = outputHex32(input.operationId),
      request = parseOutputPurchasePrepare(original.request),
      terms = verifyOutputPurchaseTerms(original.terms, request, this.identity),
      candidate = parseOutputPurchaseSubmit(input.candidate),
      selected = this.selection(original.capability),
      maximumCandidate = Math.min(this.maximumRequestBytes, selected.profile.maxRequestBytes),
      beef = Beef.fromBinaryStrict(decodeOutputBytes(candidate.beef, maximumCandidate)),
      tx = beef.findTransactionForSigning(candidate.txid)
    canonicalOutputJSON(candidate, { bytes: maximumCandidate })
    outputAssert(
      tx && (beef.atomicTxid ?? beef.txs.at(-1)?.txid) === candidate.txid,
      'Purchase BEEF target differs',
      'invalid'
    )
    outputAssert(
      candidate.acquisitionId === terms.body.acquisitionId &&
        candidate.txid === tx.id('hex') &&
        request.topic === this.topic &&
        terms.body.domainProfile === this.domainProfile &&
        tx.outputs[this.admittedOutputIndex] !== undefined &&
        canonicalOutputJSON(request.listing.chain) ===
          canonicalOutputJSON({
            network: this.scope.network,
            genesisHash: this.scope.genesisHash
          }),
      'Purchase admission differs from the original prepared transaction',
      'context-changed'
    )
    const policies = selected.profile.parameters.releasePolicies as unknown[],
      domains = selected.profile.parameters.domainProfiles as string[]
    outputAssert(
      domains.includes(this.domainProfile) &&
        policies.some(
          policy => canonicalOutputJSON(policy) === canonicalOutputJSON(terms.body.releasePolicy)
        ),
      'Purchase domain or release policy is absent from the original capability',
      'context-changed'
    )
    // The entire selected topic's possible STEAK fits before external effects;
    // a retained receipt is bounded again rather than trusted by its provider.
    const maximumIndex = Math.max(tx.inputs.length, tx.outputs.length)
    const allowance = canonicalOutputJSON(
      {
        status: 'admitted',
        operationId,
        txid: candidate.txid,
        acceptedAt: '18446744073709551615',
        assessmentContextId: 'overlay-topic-admission-v1:' + 'f'.repeat(64),
        steak: {
          [this.topic]: {
            outputsToAdmit: tx.outputs.map((_item, i) => i),
            coinsToRetain: tx.inputs.map((_item, i) => i),
            coinsRemoved: tx.inputs.map((_item, i) => i)
          }
        }
      },
      { bytes: this.maximumOutcomeBytes }
    )
    outputAssert(
      maximumIndex <= 100000 && allowance.length > 0,
      'Purchase admission exceeds bounded work',
      'limited'
    )
    const query: AdmissionHistoryQuery = {
      scope: { ...this.scope },
      txid: candidate.txid,
      topic: this.topic,
      policyId: OVERLAY_ENGINE_POLICY_ID,
      contextDigest: overlayAdmissionContextDigest()
    }
    const read = async (): Promise<OverlayPurchaseAdmissionOutcome | undefined> => {
      current()
      const result = await this.currentHistory().read(structuredClone(query))
      current()
      if (result.state === 'unresolved') return undefined
      outputAssert(result.state === 'committed', 'Invalid purchase admission history result')
      const projected = timedRetainedTopicAdmission(result.admission, query, tx)
      // The installed domain chooses the required admitted successor. Admission
      // of only unrelated outputs cannot fulfill that installation.
      outputAssert(
        projected.steak[this.topic].outputsToAdmit.includes(this.admittedOutputIndex),
        'Purchase successor was not admitted by the selected topic',
        'invalid'
      )
      const outcome: OverlayPurchaseAdmissionOutcome = {
        status: 'admitted',
        operationId,
        txid: candidate.txid,
        ...projected
      }
      canonicalOutputJSON(outcome, { bytes: this.maximumOutcomeBytes })
      outputU64(outcome.acceptedAt)
      return outcome
    }
    const prior = await read()
    if (prior) return prior
    current()
    try {
      await this.submit.call(this.engine, {
        beef: decodeOutputBytes(candidate.beef, maximumCandidate),
        topics: [this.topic]
      })
    } catch {
      // A thrown or lost reply cannot establish global rejection or absence.
      // The original retained history remains the sole admission premise.
    }
    current()
    return (await read()) ?? { status: 'unresolved', operationId, txid: candidate.txid }
  }
  private currentHistory() {
    const host = getOverlayAdmissionHost(this.engine.storage),
      history = getAdmissionHistory(this.engine.storage)
    outputAssert(
      this.engine.storage === this.storage &&
        this.engine.managers[this.topic] === this.manager &&
        this.engine.submit === this.submit &&
        host &&
        history &&
        host.admission === this.admission &&
        history === this.history &&
        history.read === this.readHistory &&
        canonicalOutputJSON(host.admissionScope) === canonicalOutputJSON(this.scope),
      'Purchase admission installation changed',
      'context-changed'
    )
    return history
  }
  private selection(input: unknown): OutputCapabilitySelection {
    const selection = restoreOutputCapability(input, this.trust)
    outputAssert(
      selection.service.rulesDigest === this.rulesDigest,
      'Purchase retained capability differs from installation',
      'unauthorized'
    )
    return selection
  }
}
