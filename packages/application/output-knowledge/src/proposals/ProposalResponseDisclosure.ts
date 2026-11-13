import {
  canonicalOutputJSON,
  closedOutputObject,
  outputHex32,
  outputIdentity,
  outputPacketDigest,
  outputU64,
  OutputProtocolError,
  parseOutputJSON,
  parseOutputProposalFinalize,
  parseOutputProposalGet,
  type OutputSignedProposal
} from '@bsv/sdk'
import {
  ProposalCapabilityContracts,
  type ProposalCapabilityTrust
} from './ProposalCapabilityContracts.js'
import type { ProposalJournalEntry } from './ProposalJournal.js'
import type { ProposalJournalResponseReference } from './ProposalJournalSend.js'
import type { ProposalAction } from './ProposalPolicy.js'
import { proposalChannelKey } from './ProposalPolicyRegistry.js'
import type { ProposalServiceCaller } from './ProposalService.js'
import { restoreProposalServiceContext } from './ProposalServiceContext.js'
import type { ProposalChannelRecord, ProposalTransitions } from './ProposalTransitions.js'

export type ProposalResponseOperation = 'put' | 'get' | 'finalize'

export interface ProposalResponseDisclosureOptions {
  lifecycle: ProposalTransitions
  trust: ProposalCapabilityTrust
  /** Synchronous trusted clock, in exact Unix seconds. */
  now(): string
  /**
   * Synchronous current host policy, intersected with installed domain authority.
   * Access writers must share the journal gate or a coherent local policy domain.
   */
  access(action: ProposalAction, proposal: OutputSignedProposal, caller: string): boolean
}

export interface BoundProposalResponse {
  readonly body: string
  readonly reference: Readonly<Exclude<ProposalJournalResponseReference, { kind: 'control' }>>
  /** Call only under the shared journal/native-send gate, after response signing. */
  validate(
    entry: ProposalJournalEntry | undefined,
    bytes: Uint8Array,
    authenticatedIdentity: string
  ): boolean
}

const maximumRequestBytes = 1048576
const maximumResponseBytes = 4194304
const encode = (value: unknown): string =>
  canonicalOutputJSON(value, { bytes: maximumResponseBytes })
function missing(): OutputProtocolError {
  return new OutputProtocolError('not-found', 'Proposal not found')
}

/**
 * Service-owned response semantics, separate from HTTP signing and storage.
 * Binding is not permission to send: the returned validator requires a fresh
 * durable record and current access inside the actual native-enqueue gate.
 */
export class ProposalResponseDisclosure {
  private readonly options: ProposalResponseDisclosureOptions
  private readonly contracts: ProposalCapabilityContracts
  private readonly scope: ReturnType<ProposalTransitions['configuration']>['scope']

  constructor(options: ProposalResponseDisclosureOptions) {
    for (const callback of [options.now, options.access])
      if (typeof callback !== 'function' || callback.constructor.name === 'AsyncFunction')
        throw new OutputProtocolError(
          'invalid',
          'Proposal disclosure callbacks must be synchronous'
        )
    this.options = { ...options }
    this.contracts = new ProposalCapabilityContracts(options.lifecycle, options.trust)
    this.scope = options.lifecycle.configuration().scope
  }

  /** Pass the original received request text and the service's actual result. */
  bind(
    operation: ProposalResponseOperation,
    request: string,
    response: unknown,
    authenticated: ProposalServiceCaller
  ): BoundProposalResponse {
    closedOutputObject(authenticated, ['caller', 'capabilityDigest'])
    const caller = {
      caller: outputIdentity(authenticated.caller),
      capabilityDigest: outputHex32(authenticated.capabilityDigest)
    }
    if (typeof request !== 'string')
      throw new OutputProtocolError('invalid', 'Proposal disclosure requires original request text')
    const packet = parseOutputJSON(request, { bytes: maximumRequestBytes })
    const reference = Object.freeze(this.reference(operation, packet))
    const body = encode(response)
    const requestBytes = new TextEncoder().encode(request).byteLength
    const expected = new TextEncoder().encode(body)
    return Object.freeze<BoundProposalResponse>({
      body,
      reference,
      validate: (entry, bytes, identity) => {
        if (identity !== caller.caller)
          throw new OutputProtocolError('unauthorized', 'Proposal response caller changed')
        if (
          !(bytes instanceof Uint8Array) ||
          bytes.length !== expected.length ||
          !bytes.every((byte, index) => byte === expected[index])
        )
          throw new OutputProtocolError('invalid', 'Proposal response bytes changed')
        if (!entry) throw missing()
        const record = entry.transition.next
        this.authorize(operation, record, caller.caller)
        this.checkReference(reference, record)
        const local = restoreProposalServiceContext(entry.local, record, this.contracts)
        const selected = [local.publication, local.admission].find(
          contract => contract?.digest === caller.capabilityDigest
        )
        if (!selected)
          throw new OutputProtocolError(
            'context-changed',
            'Use the retained proposal capability selector'
          )
        const now = outputU64(this.options.now())
        if (record.state.status !== 'finalizing' && now >= outputU64(local.retainUntil))
          throw new OutputProtocolError('expired', 'Proposal recovery interval has ended')
        const selection = this.contracts.restore(selected)
        if (
          requestBytes > selection.profile.maxRequestBytes ||
          bytes.byteLength > selection.profile.maxResponseBytes
        )
          throw new OutputProtocolError(
            'limited',
            'Proposal response exceeds its selected contract'
          )
        if (
          operation === 'get' &&
          record.state.status === 'active' &&
          now >= outputU64(record.proposal.body.expiresAt)
        )
          throw new OutputProtocolError('expired', 'Active proposal has expired')
        if (body !== encode(this.response(operation, record)))
          throw new OutputProtocolError('reset-required', 'Proposal state changed')
        return true
      }
    })
  }

  private reference(
    operation: ProposalResponseOperation,
    packet: unknown
  ): Exclude<ProposalJournalResponseReference, { kind: 'control' }> {
    if (operation === 'put') {
      closedOutputObject(packet, ['version', 'proposal'])
      if (packet.version !== 1) throw new OutputProtocolError('invalid', 'Invalid proposal version')
      const proposal = this.options.lifecycle.validate(packet.proposal)
      return { kind: 'proposal', proposalId: outputPacketDigest('proposal', proposal.body) }
    }
    if (operation === 'get') {
      const query = parseOutputProposalGet(packet)
      if (query.service !== this.scope.service) throw missing()
      return {
        kind: 'channel',
        channelKey: proposalChannelKey({ ...query, chain: this.scope.chain })
      }
    }
    if (operation === 'finalize') {
      const query = parseOutputProposalFinalize(packet)
      if (query.service !== this.scope.service) throw missing()
      return { kind: 'proposal', proposalId: query.proposalId }
    }
    throw new OutputProtocolError('invalid', 'Invalid proposal response operation')
  }

  private authorize(
    operation: ProposalResponseOperation,
    record: ProposalChannelRecord,
    caller: string
  ): void {
    const action = operation === 'get' ? 'read' : operation
    if (
      !this.options.lifecycle.permits(action, record.proposal, caller) ||
      this.options.access(action, structuredClone(record.proposal), caller) !== true
    ) {
      if (operation === 'get') throw missing()
      throw new OutputProtocolError('unauthorized', 'Proposal caller is not currently authorized')
    }
  }

  private checkReference(
    reference: BoundProposalResponse['reference'],
    record: ProposalChannelRecord
  ): void {
    if (
      reference.kind === 'channel'
        ? reference.channelKey !== proposalChannelKey(record.proposal.body)
        : reference.proposalId !== record.proposalId
    )
      throw new OutputProtocolError('context-changed', 'Proposal response record differs')
  }

  private response(operation: ProposalResponseOperation, record: ProposalChannelRecord): unknown {
    if (operation === 'put')
      return {
        version: 1,
        proposalId: record.proposalId,
        status: 'recorded',
        expiresAt: record.proposal.body.expiresAt
      }
    if (operation === 'get') return { version: 1, proposal: record.proposal, state: record.state }
    if (record.admission === undefined)
      throw new OutputProtocolError('unavailable', 'Finalization has no retained admission')
    return { version: 1, proposalId: record.proposalId, state: record.state }
  }
}
