import {
  canonicalOutputJSON,
  closedOutputObject,
  Hash,
  OutputProtocolError,
  parseOutputJSON,
  Utils,
  type OutputJSONObject
} from '@bsv/sdk'
import { proposalCommitKey } from './ProposalJournal.js'
import type { ProposalTransition } from './ProposalTransitions.js'

export interface ProposalPayload {
  key: string
  text: string
  bytes: number
  transition: ProposalTransition
  local?: OutputJSONObject
  localDigest?: string
}

function localDigest(local: OutputJSONObject): string {
  return Utils.toHex(
    Hash.sha256(Utils.toArray(`BRC194/local-context/v1\0${canonicalOutputJSON(local)}`, 'utf8'))
  )
}

/** The host validates this local context's own profile; storage retains it atomically, not as wire authority. */
export function proposalPayload(
  transition: ProposalTransition,
  maximumBytes: number,
  local?: OutputJSONObject
): ProposalPayload {
  const value =
    local === undefined
      ? transition
      : {
          storageFormat: 'output-proposal-entry/1',
          transition,
          local,
          localDigest: localDigest(local)
        }
  const text = canonicalOutputJSON(value, { bytes: maximumBytes })
  const parsed = parseProposalPayload(text, maximumBytes)
  return {
    ...parsed,
    key: proposalCommitKey(parsed.transition),
    text,
    bytes: new TextEncoder().encode(text).length
  }
}

/** Body-only journals remain readable and writable. Unknown frames or incomplete metadata fail closed. */
export function parseProposalPayload(
  text: string,
  maximumBytes: number
): Pick<ProposalPayload, 'transition' | 'local' | 'localDigest'> {
  const value = parseOutputJSON(text, { bytes: maximumBytes })
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new OutputProtocolError('unavailable', 'Invalid proposal journal payload')
  if (Object.hasOwn(value, 'expectedToken'))
    return { transition: value as unknown as ProposalTransition }
  closedOutputObject(value, ['storageFormat', 'transition', 'local', 'localDigest'])
  if (value.storageFormat !== 'output-proposal-entry/1')
    throw new OutputProtocolError('unsupported', 'Unknown proposal journal storage frame')
  if (value.local === null || typeof value.local !== 'object' || Array.isArray(value.local))
    throw new OutputProtocolError('invalid', 'Invalid proposal journal local context')
  if (localDigest(value.local) !== value.localDigest)
    throw new OutputProtocolError('unavailable', 'Proposal local context integrity mismatch')
  return {
    transition: value.transition as unknown as ProposalTransition,
    local: value.local,
    localDigest: value.localDigest as string
  }
}

export function validateProposalLocalContext(
  local: OutputJSONObject | undefined,
  digest: string | undefined
): void {
  if (local === undefined ? digest !== undefined : localDigest(local) !== digest)
    throw new OutputProtocolError('unavailable', 'Proposal local context integrity mismatch')
}
