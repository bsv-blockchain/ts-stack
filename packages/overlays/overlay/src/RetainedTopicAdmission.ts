import { createHash } from 'node:crypto'
import {
  canonicalOutputJSON,
  outputString,
  outputU64,
  OutputProtocolError,
  parseOutputJSON,
  type Transaction,
  type STEAK
} from '@bsv/sdk'
import { parseOutputSTEAK } from '@bsv/sdk/overlay-tools/OutputObservation'
import {
  admissionSemanticDigest,
  type AdmissionHistoryQuery,
  type RetainedAdmission
} from './storage/AdmissionStorage.js'

const INPUT_LIMIT = 1048576
const ASSESSMENT_PREFIX = 'overlay-topic-admission-v1:'

/** Stronger optional companion premise. An old provider without an original
 * timestamp is unavailable; a new read cannot repair its missing provenance.
 */
export function timedRetainedTopicAdmission(
  input: RetainedAdmission,
  query: AdmissionHistoryQuery,
  tx: Transaction
): { steak: STEAK; assessmentContextId: string; acceptedAt: string } {
  const owned = JSON.parse(canonicalOutputJSON(input, { bytes: INPUT_LIMIT })) as RetainedAdmission
  const original = retainedTopicAdmission(owned, query, tx)
  if (owned.acceptedAt === undefined)
    throw new OutputProtocolError(
      'unavailable',
      'Original admission acceptance time is unavailable'
    )
  const acceptedAt = outputU64(owned.acceptedAt).toString()
  return {
    ...original,
    acceptedAt,
    assessmentContextId:
      ASSESSMENT_PREFIX +
      createHash('sha256')
        .update(ASSESSMENT_PREFIX + '\0timed\0')
        .update(canonicalOutputJSON({ original: original.assessmentContextId, acceptedAt }))
        .digest('hex')
  }
}

/** Trusted history still needs exact provenance and selected-topic projection. */
export function retainedTopicAdmission(
  input: RetainedAdmission,
  query: AdmissionHistoryQuery,
  tx: Transaction
): { steak: STEAK; assessmentContextId: string } {
  const { identity, receipt } = JSON.parse(
    canonicalOutputJSON(input, { bytes: INPUT_LIMIT })
  ) as RetainedAdmission
  if (
    canonicalOutputJSON(identity.scope) !== canonicalOutputJSON(query.scope) ||
    identity.txid !== query.txid ||
    identity.contextDigest !== query.contextDigest ||
    !identity.topics.some(item => item.topic === query.topic && item.policyId === query.policyId) ||
    receipt.durability !== 'atomic-local' ||
    receipt.semanticDigest !== admissionSemanticDigest(identity)
  )
    throw new OutputProtocolError(
      'invalid',
      'Retained admission provenance does not match reserved job'
    )
  outputString(receipt.operationId)
  const complete = parseOutputSTEAK(parseOutputJSON(receipt.steak, { bytes: INPUT_LIMIT }))
  const instructions = complete[query.topic]
  if (!instructions)
    throw new OutputProtocolError('invalid', 'Retained admission omits the selected topic')
  validIndices(instructions.outputsToAdmit, tx.outputs.length)
  validIndices(instructions.coinsToRetain, tx.inputs.length)
  validIndices(instructions.coinsRemoved ?? [], tx.inputs.length)
  if ((instructions.coinsRemoved ?? []).some(index => instructions.coinsToRetain.includes(index)))
    throw new OutputProtocolError('invalid', 'Retained admission has inconsistent input effects')
  const steak = { [query.topic]: instructions }
  // Preserve the original assessment; visibility, propagation and new reservations
  // cannot relabel it. Never disclose the other topics in a shared receipt.
  const assessmentContextId =
    ASSESSMENT_PREFIX +
    createHash('sha256')
      .update(ASSESSMENT_PREFIX + '\0')
      .update(canonicalOutputJSON({ identity, operationId: receipt.operationId, steak }))
      .digest('hex')
  return { steak, assessmentContextId }
}

function validIndices(indices: number[], count: number): void {
  if (new Set(indices).size !== indices.length || indices.some(index => index >= count))
    throw new OutputProtocolError(
      'invalid',
      'Retained admission contains invalid transaction indices'
    )
}
