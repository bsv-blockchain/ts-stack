import * as s from './OutputProtocolSchema.js'
import { outputAssert } from './OutputProtocolError.js'
import { outputU64, validateOutputExtensions } from './OutputProtocol.js'
import { canonicalOutputJSON } from './OutputProtocolJSON.js'

export const parseOutputChain = (input: unknown): ReturnType<typeof s.chain> =>
  s.normalized(input, s.chain)
export const parseOutputScope = (input: unknown): ReturnType<typeof s.scope> =>
  s.normalized(input, s.scope)
export const parseOutputOutpoint = (input: unknown): ReturnType<typeof s.outpoint> =>
  s.normalized(input, s.outpoint)
export const parseOutputEvidence = (input: unknown): ReturnType<typeof s.evidence> =>
  s.normalized(input, s.evidence)

const admission = s.object(
  { outputsToAdmit: s.array(s.u32), coinsToRetain: s.array(s.u32) },
  { coinsRemoved: s.array(s.u32) }
)
const steak: s.Schema<Record<string, ReturnType<typeof admission>>> = value => {
  const map = s.jsonMap(value)
  const result: Record<string, ReturnType<typeof admission>> = Object.create(null) as Record<
    string,
    ReturnType<typeof admission>
  >
  for (const [topic, instructions] of Object.entries(map)) {
    s.text(topic)
    result[topic] = admission(instructions)
  }
  return result
}

const simpleState = (status: 'active' | 'withdrawn' | 'expired') =>
  s.object({ status: s.literal(status), recordedAt: s.u64 })
const finalization = { recordedAt: s.u64, operationId: s.requestId, txid: s.hex }
export const outputProposalStateSchema = s.tagged('status', {
  active: simpleState('active'),
  withdrawn: simpleState('withdrawn'),
  expired: simpleState('expired'),
  finalizing: s.object({ status: s.literal('finalizing'), ...finalization }),
  'finalization-failed': s.object({
    status: s.literal('finalization-failed'),
    ...finalization,
    reason: s.text,
    globalOutcome: s.literal('unknown')
  }),
  finalized: s.object({
    status: s.literal('finalized'),
    ...finalization,
    steak,
    assessmentContextId: s.text
  })
})
export type OutputProposalState = ReturnType<typeof outputProposalStateSchema>

const proposalBody = s.object(
  {
    version: s.literal(1),
    service: s.text,
    chain: s.chain,
    policy: s.policy,
    channel: s.hex,
    revision: s.u64,
    previous: s.nullable(s.hex),
    author: s.identity,
    recipients: s.array(s.identity),
    anchors: s.array(s.outpoint),
    issuedAt: s.u64,
    expiresAt: s.u64,
    operation: s.literal('update', 'withdraw'),
    payload: s.bytes
  },
  { transaction: s.bytes, ...s.extensions }
)

export const outputProposalSchema = s.object({ body: proposalBody, signature: s.bytes })
export type OutputSignedProposal = ReturnType<typeof outputProposalSchema>
export type OutputProposalBody = OutputSignedProposal['body']

function compareOutpoints(
  a: ReturnType<typeof s.outpoint>,
  b: ReturnType<typeof s.outpoint>
): number {
  return (
    s.compareUTF8(a.chain.network, b.chain.network) ||
    s.compareUTF8(a.chain.genesisHash, b.chain.genesisHash) ||
    s.compareUTF8(a.txid, b.txid) ||
    a.outputIndex - b.outputIndex
  )
}

export function validateOutputProposal(
  proposal: OutputSignedProposal,
  supportedExtensions: readonly string[] = []
): void {
  const body = proposal.body
  validateOutputExtensions(body, supportedExtensions)
  outputAssert(outputU64(body.issuedAt) < outputU64(body.expiresAt), 'Invalid proposal lifetime')
  outputAssert((body.revision === '0') === (body.previous === null), 'Invalid proposal predecessor')
  s.sortedUnique(body.recipients, s.compareUTF8)
  s.sortedUnique(body.anchors, compareOutpoints)
  for (const anchor of body.anchors) {
    outputAssert(
      canonicalOutputJSON(anchor.chain) === canonicalOutputJSON(body.chain),
      'Proposal anchor chain mismatch'
    )
  }
}

/** Shape and intrinsic invariants only; signature, installed policy and authority are separate checks. */
export function parseOutputProposal(
  input: unknown,
  supportedExtensions: readonly string[] = []
): OutputSignedProposal {
  const result = s.normalized(input, outputProposalSchema)
  validateOutputProposal(result, supportedExtensions)
  return result
}

const common = { id: s.text, scope: s.scope }
const channel = { service: s.text, policy: s.policy, channel: s.hex, proposalId: s.hex }
export const outputObservationSchema = s.tagged('kind', {
  output: s.object(
    {
      ...common,
      kind: s.literal('output'),
      payload: s.object(
        { evidence: s.evidence },
        { context: s.object({ schema: s.iri, bytes: s.bytes }) }
      )
    },
    s.extensions
  ),
  spend: s.object(
    {
      ...common,
      kind: s.literal('spend'),
      payload: s.object({ previous: s.outpoint, spendingTxid: s.hex, beef: s.bytes })
    },
    s.extensions
  ),
  withdraw: s.object(
    {
      ...common,
      kind: s.literal('withdraw'),
      payload: s.object({ outpoint: s.outpoint, reason: s.text })
    },
    s.extensions
  ),
  'assessment-invalidated': s.object(
    {
      ...common,
      kind: s.literal('assessment-invalidated'),
      payload: s.object({ contextId: s.text, reason: s.text })
    },
    s.extensions
  ),
  proposal: s.object(
    {
      ...common,
      kind: s.literal('proposal'),
      payload: s.object({ proposal: outputProposalSchema })
    },
    s.extensions
  ),
  'proposal-state': s.object(
    {
      ...common,
      kind: s.literal('proposal-state'),
      payload: s.object({ ...channel, state: outputProposalStateSchema })
    },
    s.extensions
  ),
  'proposal-remove': s.object(
    {
      ...common,
      kind: s.literal('proposal-remove'),
      payload: s.object({ ...channel, reason: s.text })
    },
    s.extensions
  )
})
export type OutputObservation = ReturnType<typeof outputObservationSchema>
export const outputGroupSchema = s.object({
  id: s.text,
  sequence: s.u64,
  observations: s.array(outputObservationSchema)
})
export type OutputSourceGroup = ReturnType<typeof outputGroupSchema>

export function validateOutputObservation(
  observation: OutputObservation,
  supportedExtensions: readonly string[] = []
): void {
  validateOutputExtensions(observation, supportedExtensions)
  let chain: ReturnType<typeof s.chain> | undefined
  switch (observation.kind) {
    case 'spend':
      chain = observation.payload.previous.chain
      break
    case 'withdraw':
      chain = observation.payload.outpoint.chain
      break
    case 'proposal':
      validateOutputProposal(observation.payload.proposal, supportedExtensions)
      chain = observation.payload.proposal.body.chain
      outputAssert(
        observation.payload.proposal.body.service === observation.scope.service,
        'Proposal service mismatch'
      )
      break
    case 'proposal-state':
    case 'proposal-remove':
      outputAssert(
        observation.payload.service === observation.scope.service,
        'Proposal service mismatch'
      )
      break
  }
  if (chain !== undefined)
    outputAssert(
      canonicalOutputJSON(chain) === canonicalOutputJSON(observation.scope.chain),
      'Observation chain mismatch'
    )
}

export function parseOutputObservation(
  input: unknown,
  supportedExtensions: readonly string[] = []
): OutputObservation {
  const result = s.normalized(input, outputObservationSchema)
  validateOutputObservation(result, supportedExtensions)
  return result
}
