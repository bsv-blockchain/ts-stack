import {
  canonicalOutputJSON,
  closedOutputObject,
  decodeOutputBytes,
  OUTPUT_PROFILES,
  outputAssert,
  outputHex32,
  outputIdentity,
  outputPacketDigest,
  outputPrivatePublicationRequestDigest,
  outputString,
  OutputProtocolError,
  parseOutputCapabilities,
  parseOutputChain,
  parseOutputJSON,
  parseOutputPrivatePublish,
  Transaction,
  Utils,
  verifyOutputPacket,
  type OutputCapabilitySelection,
  type OutputChain,
  type OutputPrivatePublish,
  type STEAK
} from '@bsv/sdk'
import type { Engine } from './Engine.js'
import {
  getOverlayAdmissionHost,
  OVERLAY_ENGINE_POLICY_ID,
  overlayAdmissionContextDigest
} from './EngineAdmission.js'
import { getAdmissionHistory, type AdmissionHistoryQuery } from './storage/AdmissionStorage.js'
import { retainedTopicAdmission } from './RetainedTopicAdmission.js'

export interface OverlayPrivatePublicationJob {
  publisher: string
  publicationId: string
  requestDigest: string
  operationId: string
  rawTransaction: string
  request: OutputPrivatePublish
}

/** Issued by the installed verifier after exact Bitcoin, publisher and schema checks. */
export interface OverlayPrivatePublicationContext {
  id: string
  publisher: string
  requestDigest: string
  view: { chain: OutputChain }
}

export type OverlayPrivatePublicationAdmissionOutcome = {
  operationId: string
  txid: string
} & (
  | { status: 'unresolved' }
  | {
      status: 'admitted' | 'excluded'
      steak: STEAK
      assessmentContextId: string
      context: 'matching-private-values' | 'public'
    }
)

export interface OverlayPrivatePublicationAdmissionOptions {
  engine: Engine
  service: string
  topic: string
  identity: string
  rulesDigest: string
  /** Must cover the current installed verifier, publisher policy and immutable chain context. */
  isCurrent: (context: OverlayPrivatePublicationContext) => boolean
  /** Explicit migration policy; never treats old public admission as private validation. */
  publicAdmissionReuse: 'disabled' | 'after-independent-private-validation'
  maximumPrivateBytes?: number
  maximumOutcomeBytes?: number
  maximumConcurrentAdmissions?: number
  supportedExtensions?: readonly string[]
}

const INPUT_LIMIT = 2 * 1048576
const ENGINE_PRIVATE_LIMIT = 100000
const ASSESSMENT_BOUND = 'overlay-topic-admission-v1:' + '0'.repeat(64)

/**
 * Optional private-specific Engine bridge. The caller durably reserves protected
 * bytes and this exact operation before entry. This bridge proves public admission
 * only; it neither installs the private lookup binding nor establishes readiness.
 */
export class OverlayPrivatePublicationAdmission {
  readonly maximumPrivateBytes: number
  readonly maximumOutcomeBytes: number
  private readonly engine: Engine
  private readonly storage: Engine['storage']
  private readonly manager: Engine['managers'][string]
  private readonly submit: Engine['submit']
  private readonly service: string
  private readonly topic: string
  private readonly identity: string
  private readonly rulesDigest: string
  private readonly isCurrent: OverlayPrivatePublicationAdmissionOptions['isCurrent']
  private readonly publicAdmissionReuse: boolean
  private readonly supportedExtensions: string[]
  private readonly scope: AdmissionHistoryQuery['scope']
  private readonly admission: NonNullable<ReturnType<typeof getOverlayAdmissionHost>>['admission']
  private readonly history: NonNullable<ReturnType<typeof getAdmissionHistory>>
  private readonly maximumConcurrentAdmissions: number
  private active = 0

  constructor(options: OverlayPrivatePublicationAdmissionOptions) {
    this.engine = options.engine
    this.storage = this.engine.storage
    this.submit = this.engine.submit
    this.service = outputString(options.service)
    this.topic = outputString(options.topic)
    this.identity = outputIdentity(options.identity)
    this.rulesDigest = outputHex32(options.rulesDigest)
    this.isCurrent = options.isCurrent
    outputAssert(
      typeof this.isCurrent === 'function',
      'Current publication verification guard is required'
    )
    outputAssert(
      options.publicAdmissionReuse === 'disabled' ||
        options.publicAdmissionReuse === 'after-independent-private-validation',
      'An explicit public admission reuse policy is required'
    )
    this.publicAdmissionReuse =
      options.publicAdmissionReuse === 'after-independent-private-validation'
    this.supportedExtensions = [...(options.supportedExtensions ?? [])]
    this.maximumPrivateBytes = bounded(
      options.maximumPrivateBytes ?? 65536,
      1,
      ENGINE_PRIVATE_LIMIT
    )
    this.maximumOutcomeBytes = bounded(options.maximumOutcomeBytes ?? 65536, 128, 65536)
    this.maximumConcurrentAdmissions = bounded(options.maximumConcurrentAdmissions ?? 4, 1, 64)
    const host = getOverlayAdmissionHost(this.storage),
      history = getAdmissionHistory(this.storage)
    outputAssert(host && history, 'Durable retained admission history is required', 'unsupported')
    this.admission = host.admission
    this.history = history
    this.scope = { ...host.admissionScope }
    parseOutputChain({ network: this.scope.network, genesisHash: this.scope.genesisHash })
    outputString(this.scope.nodeId)
    outputAssert(
      Object.hasOwn(this.engine.managers, this.topic),
      'Private publication topic manager is not installed',
      'unsupported'
    )
    this.manager = this.engine.managers[this.topic]
  }

  async recover(
    input: OverlayPrivatePublicationJob,
    selected: OutputCapabilitySelection,
    verification: OverlayPrivatePublicationContext
  ): Promise<OverlayPrivatePublicationAdmissionOutcome> {
    if (this.active >= this.maximumConcurrentAdmissions)
      throw new OutputProtocolError(
        'limited',
        'Private publication admission work capacity is occupied',
        true
      )
    this.active += 1
    try {
      return await this.recoverReserved(input, selected, verification)
    } finally {
      this.active -= 1
    }
  }

  private async recoverReserved(
    input: OverlayPrivatePublicationJob,
    selected: OutputCapabilitySelection,
    verification: OverlayPrivatePublicationContext
  ): Promise<OverlayPrivatePublicationAdmissionOutcome> {
    const job = ownedJob(input, this.supportedExtensions)
    const context = ownedContext(verification)
    this.checkContract(job, selected, context)
    const bytes = decodeOutputBytes(job.request.privateValues)
    const beef = decodeOutputBytes(job.request.evidence.beef)
    const tx = Transaction.fromBEEF(beef)
    outputAssert(
      tx.id('hex') === job.request.evidence.txid &&
        Utils.toBase64(tx.toBinary()) === job.rawTransaction &&
        job.request.evidence.outputIndex < tx.outputs.length,
      'Publication and BEEF default target differ'
    )
    const query: AdmissionHistoryQuery = {
      scope: { ...this.scope },
      txid: job.request.evidence.txid,
      topic: this.topic,
      policyId: OVERLAY_ENGINE_POLICY_ID,
      contextDigest: overlayAdmissionContextDigest(Array.from(bytes))
    }
    const read = async (kind: 'private' | 'public') => {
      const exact = {
        ...query,
        contextDigest: kind === 'private' ? query.contextDigest : overlayAdmissionContextDigest()
      }
      const history = this.currentHistory(context)
      const result = await history.read(structuredClone(exact))
      this.currentHistory(context)
      if (result.state === 'unresolved') return undefined
      outputAssert(result.state === 'committed', 'Invalid admission history result')
      const recovered = retainedTopicAdmission(result.admission, exact, tx)
      return this.result(job, {
        ...recovered,
        context: kind === 'private' ? 'matching-private-values' : 'public',
        status: recovered.steak[this.topic].outputsToAdmit.includes(
          job.request.evidence.outputIndex
        )
          ? 'admitted'
          : 'excluded'
      })
    }
    const recoverOriginal = async () =>
      (await read('private')) ?? (this.publicAdmissionReuse ? await read('public') : undefined)
    const previous = await recoverOriginal()
    if (previous) return previous
    // Largest valid subsets must fit before Engine effects; this synthetic bound
    // is never returned as admission evidence.
    this.result(job, {
      status: 'admitted',
      context: 'matching-private-values',
      assessmentContextId: ASSESSMENT_BOUND,
      steak: {
        [this.topic]: {
          outputsToAdmit: tx.outputs.map((_, i) => i),
          coinsToRetain: tx.inputs.map((_, i) => i),
          coinsRemoved: tx.inputs.map((_, i) => i)
        }
      }
    })
    this.currentHistory(context)
    try {
      await this.submit.call(
        this.engine,
        { beef: Array.from(beef), topics: [this.topic] },
        undefined,
        'current-tx',
        Array.from(bytes)
      )
    } catch {
      // A late failure can follow a commit. Recover the original retained receipt;
      // a thrown submission or an empty duplicate response never proves rollback.
    }
    return (
      (await recoverOriginal()) ?? {
        operationId: job.operationId,
        txid: query.txid,
        status: 'unresolved'
      }
    )
  }

  private currentHistory(context: OverlayPrivatePublicationContext) {
    const allowed = this.isCurrent(structuredClone(context)) === true
    const host = getOverlayAdmissionHost(this.engine.storage),
      history = getAdmissionHistory(this.engine.storage)
    outputAssert(
      this.engine.storage === this.storage &&
        this.engine.submit === this.submit &&
        this.engine.managers[this.topic] === this.manager &&
        host &&
        history &&
        host.admission === this.admission &&
        history === this.history &&
        canonicalOutputJSON(host.admissionScope) === canonicalOutputJSON(this.scope) &&
        allowed,
      'Private publication admission context changed',
      'context-changed'
    )
    return history
  }

  private checkContract(
    job: OverlayPrivatePublicationJob,
    input: OutputCapabilitySelection,
    context: OverlayPrivatePublicationContext
  ) {
    const selection = JSON.parse(
      canonicalOutputJSON(input, { bytes: INPUT_LIMIT })
    ) as OutputCapabilitySelection
    const manifest = parseOutputCapabilities(selection.manifest, false, this.supportedExtensions)
    const service = manifest.body.services.find(
      item => item.kind === 'topic' && item.name === this.service
    )
    const profile = service?.profiles.find(item => item.id === OUTPUT_PROFILES.publication)
    const digest = outputPacketDigest('capabilities', manifest.body)
    outputAssert(
      service &&
        profile &&
        service.rulesDigest === this.rulesDigest &&
        canonicalOutputJSON(service) === canonicalOutputJSON(selection.service) &&
        canonicalOutputJSON(profile) === canonicalOutputJSON(selection.profile) &&
        selection.digest === digest &&
        selection.headers['x-bsv-overlay-capability'] === digest &&
        selection.headers['x-bsv-overlay-profile'] === profile.id &&
        manifest.body.identity === this.identity &&
        verifyOutputPacket('capabilities', manifest, this.identity) &&
        job.request.topic === this.topic,
      'Private publication admission contract does not match installation',
      'unauthorized'
    )
    canonicalOutputJSON(job.request, { bytes: profile.maxRequestBytes })
    const parameters = profile.parameters as { maxPrivateBytes: number; schemas: string[] }
    outputAssert(
      parameters.maxPrivateBytes <= this.maximumPrivateBytes,
      'Advertised private capacity exceeds installed Engine capacity',
      'limited'
    )
    outputAssert(
      decodeOutputBytes(job.request.privateValues).length <= parameters.maxPrivateBytes,
      'Private values exceed the selected capacity',
      'limited'
    )
    outputAssert(
      parameters.schemas.includes(job.request.schema),
      'Publication schema is absent from retained contract',
      'unsupported'
    )
    const chain = canonicalOutputJSON({
      network: this.scope.network,
      genesisHash: this.scope.genesisHash
    })
    outputAssert(
      canonicalOutputJSON(context.view.chain) === chain &&
        canonicalOutputJSON(manifest.body.chain) === chain &&
        context.publisher === job.publisher &&
        context.requestDigest === job.requestDigest &&
        job.publicationId ===
          outputPacketDigest('private-publication', {
            chain: manifest.body.chain,
            publisher: job.publisher,
            topic: job.request.topic,
            requestId: job.request.requestId
          }),
      'Original publication verification differs',
      'context-changed'
    )
  }

  private result(
    job: OverlayPrivatePublicationJob,
    result: {
      status: 'admitted' | 'excluded'
      steak: STEAK
      assessmentContextId: string
      context: 'matching-private-values' | 'public'
    }
  ): OverlayPrivatePublicationAdmissionOutcome {
    const value = { operationId: job.operationId, txid: job.request.evidence.txid, ...result }
    canonicalOutputJSON(value, { bytes: this.maximumOutcomeBytes })
    return value
  }
}

function bounded(value: number, minimum: number, maximum: number): number {
  outputAssert(
    Number.isSafeInteger(value) && value >= minimum && value <= maximum,
    'Invalid private publication admission capacity'
  )
  return value
}

function ownedJob(
  input: OverlayPrivatePublicationJob,
  extensions: readonly string[]
): OverlayPrivatePublicationJob {
  const value = parseOutputJSON(canonicalOutputJSON(input, { bytes: INPUT_LIMIT }), {
    bytes: INPUT_LIMIT
  })
  closedOutputObject(value, [
    'publisher',
    'publicationId',
    'requestDigest',
    'operationId',
    'rawTransaction',
    'request'
  ])
  const request = parseOutputPrivatePublish(value.request, extensions)
  outputAssert(
    value.requestDigest === outputPrivatePublicationRequestDigest(request, extensions),
    'Reserved private publication request differs',
    'conflict'
  )
  decodeOutputBytes(value.rawTransaction)
  return {
    publisher: outputIdentity(value.publisher),
    publicationId: outputHex32(value.publicationId),
    requestDigest: outputHex32(value.requestDigest),
    operationId: outputHex32(value.operationId),
    rawTransaction: value.rawTransaction as string,
    request
  }
}

function ownedContext(input: OverlayPrivatePublicationContext): OverlayPrivatePublicationContext {
  const value = parseOutputJSON(canonicalOutputJSON(input, { bytes: 16384 }))
  closedOutputObject(value, ['id', 'publisher', 'requestDigest', 'view'])
  closedOutputObject(value.view, ['chain'])
  return {
    id: outputString(value.id),
    publisher: outputIdentity(value.publisher),
    requestDigest: outputHex32(value.requestDigest),
    view: { chain: parseOutputChain(value.view.chain) }
  }
}
