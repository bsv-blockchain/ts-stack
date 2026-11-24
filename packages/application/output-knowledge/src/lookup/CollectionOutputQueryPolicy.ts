import {
  closedOutputObject,
  outputHex32,
  outputIdentity,
  outputString,
  outputU32,
  OutputProtocolError,
  parseOutputObservation,
  type OutputEvidence,
  type OutputJSON,
  type OutputJSONObject
} from '@bsv/sdk'
import type { LookupIndexGroup, LookupIndexRow } from './LookupIndexCodec.js'
import type {
  LookupObservationTemplate,
  LookupQueryContext,
  LookupQueryPolicy
} from './LookupQueryPolicy.js'

/** One row per outpoint, ordered by displayed txid bytes and big-endian output index. */
export function collectionOutputIndexKey(
  evidence: Pick<OutputEvidence, 'txid' | 'outputIndex'>
): string {
  return outputHex32(evidence.txid) + outputU32(evidence.outputIndex).toString(16).padStart(8, '0')
}

function audience(value: unknown): 'public' | string[] {
  if (value === 'public') return value
  if (!Array.isArray(value) || value.length > 256)
    throw new OutputProtocolError(
      'invalid',
      'Collection audience must be public or at most 256 identities'
    )
  const result = value.map(value => outputIdentity(value))
  for (let index = 1; index < result.length; index++)
    if (result[index - 1] >= result[index])
      throw new OutputProtocolError('invalid', 'Collection audience must be sorted and unique')
  return result
}

type OutputTemplate = Extract<LookupObservationTemplate, { kind: 'output' }>

/**
 * Small application-neutral reference selection rule. Index data is
 * {collection, audience: 'public' | sortedIdentityArray, output: {evidence, context?}}.
 * Query is {collection}. The index key must equal collectionOutputIndexKey(evidence).
 * Opaque context is visible to every selected reader: do not place a private
 * secret in a public row. BEEF/context validation here checks framing only;
 * admission, Script/SPV verification, payment and current authorization remain
 * separate components. A membership withdrawal never asserts a Bitcoin spend.
 *
 * Current audience revocation is a disclosure change, not ordinary expiry. Block
 * the serving guard before changing policy/index data and release only after the
 * change is durable; otherwise an immutable older snapshot could disclose it.
 */
export class CollectionOutputQueryPolicy implements LookupQueryPolicy {
  readonly id = 'urn:bsv:output-knowledge:collection-output-query:1'

  parameters(input: unknown): OutputJSONObject {
    closedOutputObject(input, [])
    return {}
  }
  query(input: OutputJSON): OutputJSON {
    closedOutputObject(input, ['collection'])
    return { collection: outputString(input.collection) }
  }

  private member(row: LookupIndexRow | null, context: LookupQueryContext): OutputTemplate | null {
    if (row === null) return null
    const data = row.value.data
    closedOutputObject(data, ['collection', 'audience', 'output'])
    const collection = outputString(data.collection)
    const readers = audience(data.audience)
    if (
      collection !== (context.query as { collection: string }).collection ||
      (readers !== 'public' && (context.principal === null || !readers.includes(context.principal)))
    )
      return null
    const observation = parseOutputObservation({
      kind: 'output',
      id: 'reference-selection',
      scope: context.scope,
      payload: data.output
    }) as OutputTemplate
    if (collectionOutputIndexKey(observation.payload.evidence) !== row.key)
      throw new OutputProtocolError('invalid', 'Collection row key differs from its outpoint')
    return { kind: 'output', payload: observation.payload }
  }

  snapshot(row: LookupIndexRow, context: LookupQueryContext): LookupObservationTemplate[] {
    const selected = this.member(row, context)
    return selected === null ? [] : [selected]
  }

  transition(group: LookupIndexGroup, context: LookupQueryContext): LookupObservationTemplate[] {
    const observations: LookupObservationTemplate[] = []
    for (const change of group.changes) {
      const before = this.member(change.before, context)
      const after = this.member(change.after, context)
      if (before !== null && after === null) {
        const { txid, outputIndex } = before.payload.evidence
        observations.push({
          kind: 'withdraw',
          payload: {
            outpoint: { chain: context.scope.chain, txid, outputIndex },
            reason:
              group.event.type === 'output-lookup-row-expired/1' ? 'expired' : 'membership-changed'
          }
        })
      }
      if (after !== null) observations.push(after)
    }
    return observations
  }
}
