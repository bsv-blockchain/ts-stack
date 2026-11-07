import {
  canonicalOutputJSON,
  closedOutputObject,
  outputHex32,
  outputString,
  outputU64,
  OutputProtocolError,
  type OutputJSONObject
} from '@bsv/sdk'
import { parseKnowledgeLocalFrame, type KnowledgeLocalFrame } from '../VerificationLedger.js'
import type { ProposalSourceConfiguration, ProposalSourcePolicy } from './ProposalSourcePolicy.js'
import type {
  ProposalReceiptReference,
  ProposalReceiptStamp,
  ProposalVerification
} from './ProposalVerificationPool.js'

const profile = 'urn:bsv:output-knowledge:local-verification:4' as const
export interface ProposalLocalFrame {
  profile: typeof profile
  version: 4
  bitcoin: Extract<KnowledgeLocalFrame, { version: 3 }>
  proposals: {
    configuration: ProposalSourceConfiguration
    evaluatedAt: string
    receipts: ProposalReceiptStamp[]
    work: ProposalVerification[]
  }
}
function localReference(input: unknown): ProposalReceiptReference {
  closedOutputObject(input, ['group', 'observationId', 'envelope'])
  if (
    typeof input.group !== 'string' ||
    !input.group ||
    new TextEncoder().encode(input.group).length > 16384
  )
    throw new OutputProtocolError('invalid', 'Invalid local proposal group reference')
  return {
    group: input.group,
    observationId: outputString(input.observationId),
    envelope: outputHex32(input.envelope)
  }
}
function records<T>(
  input: unknown,
  parse: (item: unknown) => T & { reference: ProposalReceiptReference }
): T[] {
  if (!Array.isArray(input) || input.length > 4096)
    throw new OutputProtocolError('limited', 'Invalid local proposal work bound')
  const seen = new Set<string>()
  return input.map(item => {
    const parsed = parse(item),
      key = canonicalOutputJSON(parsed.reference)
    if (seen.has(key))
      throw new OutputProtocolError('invalid', 'Duplicate local proposal reference')
    seen.add(key)
    return parsed
  })
}
function stamp(input: unknown): ProposalReceiptStamp {
  closedOutputObject(input, ['reference', 'firstReceivedAt'])
  outputU64(input.firstReceivedAt)
  return {
    reference: localReference(input.reference),
    firstReceivedAt: input.firstReceivedAt as string
  }
}
function check(input: unknown): ProposalVerification {
  closedOutputObject(input, ['reference', 'firstReceivedAt', 'status'])
  if (!['verified', 'invalid', 'unsupported', 'unauthorized'].includes(input.status as string))
    throw new OutputProtocolError('invalid', 'Invalid retained proposal decision')
  const parsed = stamp({ reference: input.reference, firstReceivedAt: input.firstReceivedAt })
  return { ...parsed, status: input.status as ProposalVerification['status'] }
}

function requireProposalFrame(input: unknown): void {
  if (
    typeof input !== 'object' ||
    input === null ||
    !('profile' in input) ||
    !('version' in input) ||
    input.profile !== profile ||
    input.version !== 4
  )
    throw new OutputProtocolError(
      'reset-required',
      'Proposal replay requires its own journal namespace'
    )
}

/** Parse and bind a new opt-in namespace; this never upgrades an older frame. */
export function parseProposalLocalFrame(
  input: unknown,
  policy: ProposalSourcePolicy
): ProposalLocalFrame {
  const owned: unknown = JSON.parse(canonicalOutputJSON(input))
  requireProposalFrame(owned)
  closedOutputObject(owned, ['profile', 'version', 'bitcoin', 'proposals'])
  const bitcoin = parseKnowledgeLocalFrame(owned.bitcoin)
  if (bitcoin.version !== 3)
    throw new OutputProtocolError(
      'reset-required',
      'Proposal replay requires canonical Bitcoin ordering'
    )
  closedOutputObject(owned.proposals, ['configuration', 'evaluatedAt', 'receipts', 'work'])
  const configured = policy.describe()
  if (canonicalOutputJSON(owned.proposals.configuration) !== canonicalOutputJSON(configured))
    throw new OutputProtocolError('reset-required', 'Proposal source installation changed')
  outputU64(owned.proposals.evaluatedAt)
  return {
    profile,
    version: 4,
    bitcoin,
    proposals: {
      configuration: configured,
      evaluatedAt: owned.proposals.evaluatedAt as string,
      receipts: records(owned.proposals.receipts, stamp),
      work: records(owned.proposals.work, check)
    }
  }
}

export function proposalLocalFrame(
  bitcoin: OutputJSONObject,
  policy: ProposalSourcePolicy,
  evaluatedAt: string,
  receipts: ProposalReceiptStamp[] = [],
  work: ProposalVerification[] = []
): OutputJSONObject {
  const checked = parseProposalLocalFrame(
    {
      profile,
      version: 4,
      bitcoin,
      proposals: { configuration: policy.describe(), evaluatedAt, receipts, work }
    },
    policy
  )
  // All nested fields are validated owned JSON from the parser above.
  return checked as unknown as OutputJSONObject
}
