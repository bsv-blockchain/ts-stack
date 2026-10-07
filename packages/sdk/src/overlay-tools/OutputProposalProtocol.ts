import * as s from './OutputProtocolSchema.js'
import {
  outputProposalSchema,
  outputProposalStateSchema,
  validateOutputProposal
} from './OutputObservation.js'

const put = s.fixedObject({ version: s.literal(1), proposal: outputProposalSchema })
const recorded = s.fixedObject({
  version: s.literal(1),
  proposalId: s.hex,
  status: s.literal('recorded'),
  expiresAt: s.u64
})
const get = s.fixedObject({
  version: s.literal(1),
  service: s.text,
  policy: s.policy,
  channel: s.hex
})
const retrieved = s.fixedObject({
  version: s.literal(1),
  proposal: outputProposalSchema,
  state: outputProposalStateSchema
})
const finalize = s.fixedObject({
  version: s.literal(1),
  operationId: s.requestId,
  service: s.text,
  proposalId: s.hex,
  beef: s.bytes,
  txid: s.hex
})
const finalized = s.fixedObject({
  version: s.literal(1),
  proposalId: s.hex,
  state: outputProposalStateSchema
})

export type OutputProposalPut = ReturnType<typeof put>
export type OutputProposalPutResponse = ReturnType<typeof recorded>
export type OutputProposalGet = ReturnType<typeof get>
export type OutputProposalGetResponse = ReturnType<typeof retrieved>
export type OutputProposalFinalize = ReturnType<typeof finalize>
export type OutputProposalFinalizeResponse = ReturnType<typeof finalized>

/** BRC-194 representation only; author signature, installed policy and authorization are separate. */
export function parseOutputProposalPut(
  input: unknown,
  supportedExtensions: readonly string[] = []
): OutputProposalPut {
  const result = s.normalized(input, put)
  validateOutputProposal(result.proposal, supportedExtensions)
  return result
}

/** Recording is not topical admission, Bitcoin verification or a wallet receipt. */
export function parseOutputProposalPutResponse(input: unknown): OutputProposalPutResponse {
  return s.normalized(input, recorded)
}

export function parseOutputProposalGet(input: unknown): OutputProposalGet {
  return s.normalized(input, get)
}

/** Provider state remains separate from the unchanged author-signed proposal. */
export function parseOutputProposalGetResponse(
  input: unknown,
  supportedExtensions: readonly string[] = []
): OutputProposalGetResponse {
  const result = s.normalized(input, retrieved)
  validateOutputProposal(result.proposal, supportedExtensions)
  return result
}

/** Parses bounded opaque BEEF. Evidence and exact finalization relation still require verification. */
export function parseOutputProposalFinalize(input: unknown): OutputProposalFinalize {
  return s.normalized(input, finalize)
}

/** A finalized provider state records historical admission; it does not establish mining. */
export function parseOutputProposalFinalizeResponse(
  input: unknown
): OutputProposalFinalizeResponse {
  return s.normalized(input, finalized)
}
