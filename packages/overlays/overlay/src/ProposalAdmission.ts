import { createHash } from 'node:crypto'
import {
  canonicalOutputJSON,
  closedOutputObject,
  decodeOutputBytes,
  OUTPUT_PROFILES,
  outputHex32,
  outputIdentity,
  outputPacketDigest,
  outputString,
  outputU64,
  OutputProtocolError,
  parseOutputCapabilities,
  parseOutputChain,
  parseOutputJSON,
  parseOutputProposal,
  parseOutputProposalFinalize,
  Transaction,
  Utils,
  verifyOutputPacket,
  type OutputCapabilitySelection,
  type OutputChain,
  type OutputSignedProposal,
  type STEAK
} from '@bsv/sdk'
import { parseOutputSTEAK } from '@bsv/sdk/overlay-tools/OutputObservation'
import type { Engine } from './Engine.js'
import {
  getOverlayAdmissionHost,
  OVERLAY_ENGINE_POLICY_ID,
  overlayAdmissionContextDigest
} from './EngineAdmission.js'
import {
  admissionSemanticDigest,
  getAdmissionHistory,
  type AdmissionHistoryQuery,
  type RetainedAdmission
} from './storage/AdmissionStorage.js'

/** The proposal service durably reserves this exact job before calling the bridge. */
export interface OverlayProposalAdmissionJob {
  caller: string
  operationId: string
  txid: string
  rawTransaction: string
  beef: string
  requestedAt: string
}

/** Structural subset of the original, trusted evidence verification context. */
export interface OverlayProposalVerificationContext {
  id: string
  view: { chain: OutputChain }
}

export type OverlayProposalAdmissionOutcome = {
  operationId: string
  txid: string
} & ({ status: 'unresolved' } | { status: 'admitted'; steak: STEAK; assessmentContextId: string })

export interface OverlayProposalAdmissionOptions {
  engine: Engine
  /** Installed proposal service and ordinary Engine topic may have different names. */
  service: string
  topic: string
  identity: string
  rulesDigest: string
  /** Canonical result capacity reserved by ProposalService before admission effects. */
  maximumOutcomeBytes?: number
  /** Physical calls, including stalled history/Engine work; no unbounded waiting queue. */
  maximumConcurrentAdmissions?: number
  supportedExtensions?: readonly string[]
}

const INPUT_LIMIT = 1048576
const ASSESSMENT_PREFIX = 'overlay-topic-admission-v1:'

/**
 * Optional Node bridge for ProposalServiceAdmission, requiring SDK 3.0 or newer.
 * Recover only retained ordinary topic admission; submission errors, duplicate
 * STEAK and missing history never establish rejection or rollback. The caller
 * owns authentication, proposal policy/transaction relation verification and
 * durable reservation. No wallet effects or inference of current unspentness.
 */
export class OverlayProposalAdmission {
  readonly requiresVerificationContext = true
  readonly maximumOutcomeBytes: number
  private readonly engine: Engine
  private readonly storage: Engine['storage']
  private readonly manager: Engine['managers'][string]
  private readonly service: string
  private readonly topic: string
  private readonly identity: string
  private readonly rulesDigest: string
  private readonly supportedExtensions: string[]
  private readonly scope: AdmissionHistoryQuery['scope']
  private readonly admission: NonNullable<ReturnType<typeof getOverlayAdmissionHost>>['admission']
  private readonly history: NonNullable<ReturnType<typeof getAdmissionHistory>>
  private readonly maximumConcurrentAdmissions: number
  private active = 0

  constructor(options: OverlayProposalAdmissionOptions) {
    this.engine = options.engine
    this.storage = options.engine.storage
    this.service = outputString(options.service)
    this.topic = outputString(options.topic)
    this.identity = outputIdentity(options.identity)
    this.rulesDigest = outputHex32(options.rulesDigest)
    this.supportedExtensions = [...(options.supportedExtensions ?? [])]
    this.maximumOutcomeBytes = options.maximumOutcomeBytes ?? INPUT_LIMIT
    this.maximumConcurrentAdmissions = options.maximumConcurrentAdmissions ?? 4
    if (
      !Number.isSafeInteger(this.maximumConcurrentAdmissions) ||
      this.maximumConcurrentAdmissions < 1 ||
      this.maximumConcurrentAdmissions > 64
    )
      throw new OutputProtocolError('invalid', 'Invalid proposal admission concurrency capacity')
    if (
      !Number.isSafeInteger(this.maximumOutcomeBytes) ||
      this.maximumOutcomeBytes < 128 ||
      this.maximumOutcomeBytes > INPUT_LIMIT
    )
      throw new OutputProtocolError('invalid', 'Invalid proposal admission outcome capacity')
    const host = getOverlayAdmissionHost(this.storage)
    const history = getAdmissionHistory(this.storage)
    if (!host || !history)
      throw new OutputProtocolError('unsupported', 'Durable retained admission history is required')
    this.admission = host.admission
    this.history = history
    parseOutputChain({
      network: host.admissionScope.network,
      genesisHash: host.admissionScope.genesisHash
    })
    outputString(host.admissionScope.nodeId)
    this.scope = { ...host.admissionScope }
    if (!Object.hasOwn(this.engine.managers, this.topic))
      throw new OutputProtocolError('unsupported', 'Proposal topic manager is not installed')
    this.manager = this.engine.managers[this.topic]
  }

  async recover(
    input: OverlayProposalAdmissionJob,
    signed: OutputSignedProposal,
    selected: OutputCapabilitySelection,
    verificationContext?: OverlayProposalVerificationContext
  ): Promise<OverlayProposalAdmissionOutcome> {
    if (this.active >= this.maximumConcurrentAdmissions)
      throw new OutputProtocolError('limited', 'Proposal admission work capacity is occupied', true)
    this.active += 1
    try {
      return await this.recoverReserved(input, signed, selected, verificationContext)
    } finally {
      this.active -= 1
    }
  }

  private async recoverReserved(
    input: OverlayProposalAdmissionJob,
    signed: OutputSignedProposal,
    selected: OutputCapabilitySelection,
    verificationContext?: OverlayProposalVerificationContext
  ): Promise<OverlayProposalAdmissionOutcome> {
    const proposal = parseOutputProposal(signed, this.supportedExtensions)
    const job = ownedJob(input, proposal)
    this.checkContract(proposal, selected, verificationContext)
    const beef = decodeOutputBytes(job.beef)
    // Engine.submit selects the BEEF's default target. Matching another TXID
    // embedded in that BEEF would not bind the transaction actually submitted.
    const tx = Transaction.fromBEEF(beef)
    if (tx.id('hex') !== job.txid || Utils.toBase64(tx.toBinary()) !== job.rawTransaction)
      throw new OutputProtocolError('invalid', 'Reserved transaction and BEEF target differ')
    const query: AdmissionHistoryQuery = {
      scope: { ...this.scope },
      txid: job.txid,
      topic: this.topic,
      policyId: OVERLAY_ENGINE_POLICY_ID,
      contextDigest: overlayAdmissionContextDigest()
    }
    const read = async (): Promise<OverlayProposalAdmissionOutcome | undefined> => {
      const history = this.currentHistory()
      const result = await history.read(structuredClone(query))
      this.currentHistory()
      if (result.state === 'unresolved') return undefined
      if (result.state !== 'committed')
        throw new OutputProtocolError('invalid', 'Invalid admission history result')
      return this.recovered(job, query, result.admission, tx)
    }
    const previous = await read()
    if (previous) return previous
    // Reserve an upper bound for every valid subset BEFORE any Engine effects.
    // All outputs and both complete input lists dominate any valid STEAK.
    this.result(
      job,
      {
        [this.topic]: {
          outputsToAdmit: tx.outputs.map((_, index) => index),
          coinsToRetain: tx.inputs.map((_, index) => index),
          coinsRemoved: tx.inputs.map((_, index) => index)
        }
      },
      ASSESSMENT_PREFIX + '0'.repeat(64)
    )
    this.currentHistory()
    try {
      // No offChainValues are inferred from a proposal payload. Private topical
      // publication is a separate contract with its own immutable context digest.
      await this.engine.submit({ beef: Array.from(beef), topics: [this.topic] })
    } catch {
      // A late error may follow majority commit. Read the SAME retained identity;
      // do not turn network/index/broadcast errors into definitive failure.
    }
    return (await read()) ?? { operationId: job.operationId, txid: job.txid, status: 'unresolved' }
  }

  private currentHistory() {
    const host = getOverlayAdmissionHost(this.engine.storage)
    const history = getAdmissionHistory(this.engine.storage)
    if (
      this.engine.storage !== this.storage ||
      this.engine.managers[this.topic] !== this.manager ||
      !host ||
      !history ||
      host.admission !== this.admission ||
      history !== this.history ||
      canonicalOutputJSON(host.admissionScope) !== canonicalOutputJSON(this.scope)
    )
      throw new OutputProtocolError('context-changed', 'Proposal admission installation changed')
    return history
  }

  private checkContract(
    proposal: OutputSignedProposal,
    input: OutputCapabilitySelection,
    context?: OverlayProposalVerificationContext
  ): void {
    const selection = JSON.parse(
      canonicalOutputJSON(input, { bytes: INPUT_LIMIT })
    ) as OutputCapabilitySelection
    const manifest = parseOutputCapabilities(selection.manifest, false, this.supportedExtensions)
    const service = manifest.body.services.find(
      item => item.kind === 'topic' && item.name === this.service
    )
    const profile = service?.profiles.find(item => item.id === OUTPUT_PROFILES.proposal)
    const digest = outputPacketDigest('capabilities', manifest.body)
    if (
      !service ||
      !profile ||
      service.rulesDigest !== this.rulesDigest ||
      canonicalOutputJSON(service) !== canonicalOutputJSON(selection.service) ||
      canonicalOutputJSON(profile) !== canonicalOutputJSON(selection.profile) ||
      selection.digest !== digest ||
      selection.headers['x-bsv-overlay-capability'] !== digest ||
      selection.headers['x-bsv-overlay-profile'] !== profile.id ||
      manifest.body.identity !== this.identity ||
      !verifyOutputPacket('capabilities', manifest, this.identity) ||
      proposal.body.service !== this.service ||
      proposal.body.operation !== 'update' ||
      !verifyOutputPacket('proposal', proposal, proposal.body.author)
    )
      throw new OutputProtocolError(
        'unauthorized',
        'Proposal admission contract does not match installation'
      )
    const policies = profile.parameters.policies as Array<{ id: string; digest: string }>
    if (
      !policies.some(
        policy =>
          policy.id === proposal.body.policy.id && policy.digest === proposal.body.policy.digest
      )
    )
      throw new OutputProtocolError(
        'unsupported',
        'Proposal policy is absent from retained contract'
      )
    if (!context)
      throw new OutputProtocolError('unavailable', 'Original verification context is required')
    const owned = JSON.parse(
      canonicalOutputJSON(context, { bytes: INPUT_LIMIT })
    ) as OverlayProposalVerificationContext
    outputString(owned.id)
    const chain = canonicalOutputJSON({
      network: this.scope.network,
      genesisHash: this.scope.genesisHash
    })
    if (
      canonicalOutputJSON(parseOutputChain(owned.view.chain)) !== chain ||
      canonicalOutputJSON(manifest.body.chain) !== chain ||
      canonicalOutputJSON(proposal.body.chain) !== chain
    )
      throw new OutputProtocolError(
        'context-changed',
        'Proposal admission chain does not match installation'
      )
  }

  private recovered(
    job: OverlayProposalAdmissionJob,
    query: AdmissionHistoryQuery,
    input: RetainedAdmission,
    tx: Transaction
  ): OverlayProposalAdmissionOutcome {
    const { identity, receipt } = JSON.parse(
      canonicalOutputJSON(input, { bytes: INPUT_LIMIT })
    ) as RetainedAdmission
    if (
      canonicalOutputJSON(identity.scope) !== canonicalOutputJSON(query.scope) ||
      identity.txid !== query.txid ||
      identity.contextDigest !== query.contextDigest ||
      !identity.topics.some(
        item => item.topic === query.topic && item.policyId === query.policyId
      ) ||
      receipt.durability !== 'atomic-local' ||
      receipt.semanticDigest !== admissionSemanticDigest(identity)
    )
      throw new OutputProtocolError(
        'invalid',
        'Retained admission provenance does not match reserved job'
      )
    outputString(receipt.operationId)
    const complete = parseOutputSTEAK(parseOutputJSON(receipt.steak, { bytes: INPUT_LIMIT }))
    const instructions = complete[this.topic]
    if (!instructions)
      throw new OutputProtocolError('invalid', 'Retained admission omits the selected topic')
    validIndices(instructions.outputsToAdmit, tx.outputs.length)
    validIndices(instructions.coinsToRetain, tx.inputs.length)
    validIndices(instructions.coinsRemoved ?? [], tx.inputs.length)
    if ((instructions.coinsRemoved ?? []).some(index => instructions.coinsToRetain.includes(index)))
      throw new OutputProtocolError('invalid', 'Retained admission has inconsistent input effects')
    // Retained identity establishes admission. Empty instructions alone establish
    // neither success nor failure, and must not override that provenance.
    const steak = { [this.topic]: instructions }
    // Index visibility and propagation are observations, not the original topic
    // assessment identity. Neither a newer reservation nor those changing
    // observations may relabel this historical assessment.
    const assessmentContextId =
      ASSESSMENT_PREFIX +
      createHash('sha256')
        .update(ASSESSMENT_PREFIX + '\0')
        .update(canonicalOutputJSON({ identity, operationId: receipt.operationId, steak }))
        .digest('hex')
    return this.result(job, steak, assessmentContextId)
  }

  private result(
    job: OverlayProposalAdmissionJob,
    steak: STEAK,
    assessmentContextId: string
  ): OverlayProposalAdmissionOutcome {
    const value: OverlayProposalAdmissionOutcome = {
      operationId: job.operationId,
      txid: job.txid,
      status: 'admitted',
      steak,
      assessmentContextId
    }
    canonicalOutputJSON(value, { bytes: this.maximumOutcomeBytes })
    return value
  }
}

function ownedJob(
  input: OverlayProposalAdmissionJob,
  proposal: OutputSignedProposal
): OverlayProposalAdmissionJob {
  const value = parseOutputJSON(canonicalOutputJSON(input, { bytes: INPUT_LIMIT }), {
    bytes: INPUT_LIMIT
  })
  closedOutputObject(value, [
    'caller',
    'operationId',
    'txid',
    'rawTransaction',
    'beef',
    'requestedAt'
  ])
  const request = parseOutputProposalFinalize({
    version: 1,
    service: proposal.body.service,
    operationId: value.operationId,
    proposalId: outputPacketDigest('proposal', proposal.body),
    txid: value.txid,
    beef: value.beef
  })
  decodeOutputBytes(value.rawTransaction)
  outputU64(value.requestedAt)
  return {
    caller: outputIdentity(value.caller),
    operationId: request.operationId,
    txid: request.txid,
    rawTransaction: value.rawTransaction as string,
    beef: request.beef,
    requestedAt: value.requestedAt as string
  }
}

function validIndices(indices: number[], count: number): void {
  if (new Set(indices).size !== indices.length || indices.some(index => index >= count))
    throw new OutputProtocolError(
      'invalid',
      'Retained admission contains invalid transaction indices'
    )
}
