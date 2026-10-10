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

const admission = s.fixedObject(
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

/** Owned BRC-22 shape for opt-in companion envelopes; no admission or mining verdict. */
export const parseOutputSTEAK = (input: unknown): ReturnType<typeof steak> =>
  s.normalized(input, steak)

const simpleState = (status: 'active' | 'withdrawn' | 'expired') =>
  s.fixedObject({ status: s.literal(status), recordedAt: s.u64 })
const finalization = { recordedAt: s.u64, operationId: s.requestId, txid: s.hex }
export const outputProposalStateSchema = s.tagged('status', {
  active: simpleState('active'),
  withdrawn: simpleState('withdrawn'),
  expired: simpleState('expired'),
  finalizing: s.fixedObject({ status: s.literal('finalizing'), ...finalization }),
  'finalization-failed': s.fixedObject({
    status: s.literal('finalization-failed'),
    ...finalization,
    reason: s.text,
    globalOutcome: s.literal('unknown')
  }),
  finalized: s.fixedObject({
    status: s.literal('finalized'),
    ...finalization,
    steak,
    assessmentContextId: s.text
  })
})
export type OutputProposalState = ReturnType<typeof outputProposalStateSchema>

const proposalBody = s.fixedObject(
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

export const outputProposalSchema = s.fixedObject({ body: proposalBody, signature: s.bytes })
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
function observation<T extends string, P>(kind: T, payload: s.Schema<P>) {
  return s.fixedObject({ ...common, kind: s.literal(kind), payload }, s.extensions)
}
export const outputObservationSchema = s.tagged('kind', {
  output: observation(
    'output',
    s.fixedObject(
      { evidence: s.evidence },
      { context: s.fixedObject({ schema: s.iri, bytes: s.bytes }) }
    )
  ),
  spend: observation(
    'spend',
    s.fixedObject({ previous: s.outpoint, spendingTxid: s.hex, beef: s.bytes })
  ),
  withdraw: observation('withdraw', s.fixedObject({ outpoint: s.outpoint, reason: s.text })),
  'assessment-invalidated': observation(
    'assessment-invalidated',
    s.fixedObject({ contextId: s.text, reason: s.text })
  ),
  proposal: observation('proposal', s.fixedObject({ proposal: outputProposalSchema })),
  'proposal-state': observation(
    'proposal-state',
    s.fixedObject({ ...channel, state: outputProposalStateSchema })
  ),
  'proposal-remove': observation('proposal-remove', s.fixedObject({ ...channel, reason: s.text }))
})

export type OutputObservation = ReturnType<typeof outputObservationSchema>
export const outputGroupSchema = s.fixedObject({
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

/** @internal Fresh bounded STEAK representation for composed opt-in envelopes.
 * This validates shape only; it never establishes admission or mining. */
export const parseOutputSTEAKWithInlineStrings = (input: unknown): ReturnType<typeof steak> =>
  s.normalizedWithInlineStrings(input, steak)

/** @internal Child grammar for a freshly owned, bounded enclosing packet only.
 * Standalone STEAK input requires a complete parser. Every topic and instruction
 * is checked afresh; this establishes neither admission nor mining. */
export function validateOutputSTEAKOfOwnedParent(input: unknown): ReturnType<typeof steak> {
  return steak(input)
}
