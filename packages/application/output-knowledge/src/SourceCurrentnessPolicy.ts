import {
  canonicalOutputJSON,
  closedOutputObject,
  outputU64,
  parseOutputScope,
  OutputProtocolError,
  type OutputScope
} from '@bsv/sdk'
import { compareKnowledgeText } from './SourceMembership.js'

/** Local opt-in: this exact source's named rules interpret live membership as an unspent report. */
export interface SourceCurrentnessRule {
  /** Epoch is deliberately omitted from configuration; every assessment retains the actual epoch. */
  source: Omit<OutputScope, 'epoch'>
  /** Lifetime from the first trusted receipt, never from verification completion or replay. */
  maximumAgeSeconds: string
}
export function parseSourceCurrentnessRules(input: unknown): SourceCurrentnessRule[] {
  const value: unknown = JSON.parse(canonicalOutputJSON(input))
  if (!Array.isArray(value) || value.length > 64)
    throw new OutputProtocolError('invalid', 'Invalid source currentness rule count')
  const seen = new Set<string>()
  const rules = value.map(item => {
    closedOutputObject(item, ['source', 'maximumAgeSeconds'])
    closedOutputObject(item.source, [
      'chain',
      'provider',
      'service',
      'queryDigest',
      'rulesDigest',
      'access'
    ])
    const { epoch: _epoch, ...source } = parseOutputScope({
      ...item.source,
      epoch: 'configuration'
    })
    const maximumAgeSeconds = item.maximumAgeSeconds as string
    if (outputU64(maximumAgeSeconds) === 0n)
      throw new OutputProtocolError('invalid', 'Source currentness lifetime must be positive')
    const key = canonicalOutputJSON(source)
    if (seen.has(key)) throw new OutputProtocolError('invalid', 'Duplicate source currentness rule')
    seen.add(key)
    return { source, maximumAgeSeconds }
  })
  rules.sort((a, b) =>
    compareKnowledgeText(canonicalOutputJSON(a.source), canonicalOutputJSON(b.source))
  )
  return rules
}
