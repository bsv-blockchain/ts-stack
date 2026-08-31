import { LCH_IRI } from './constants.js'
import { LCHError, lchAssert } from './errors.js'
import { sha256, toHex } from './hash.js'

export const ODRL_CONTEXT = 'http://www.w3.org/ns/odrl.jsonld'
export const LCH_ODRL_PROFILE = `${LCH_IRI}#odrl-profile`
export const LCH_ODRL_CONTEXT = {
  lchv: `${LCH_IRI}#`,
  render: 'lchv:render',
  unwrap: 'lchv:unwrap',
  train: 'lchv:train',
  retainLch: 'lchv:retainLch',
  presentTerms: 'lchv:presentTerms',
  selection: { '@id': 'lchv:selection', '@type': '@id' },
  connectivity: { '@id': 'lchv:connectivity', '@type': '@id' },
  enforcementClass: { '@id': 'lchv:enforcementClass', '@type': '@id' },
  commercialPurpose: 'lchv:commercialPurpose',
  wrapperRequired: 'lchv:wrapperRequired',
  satoshi: 'lchv:satoshi'
} as const

export interface PolicyReference {
  mediaType: string
  digest: Uint8Array
  inline?: Uint8Array
  locator?: string
}

export interface PolicyEvaluation {
  policy: Record<string, unknown>
  permissions: Array<Record<string, unknown>>
  prohibitions: Array<Record<string, unknown>>
  duties: Array<Record<string, unknown>>
}

export async function parsePinnedPolicy(
  reference: PolicyReference,
  expectedType: 'Offer' | 'Agreement',
  computedIri: string
): Promise<PolicyEvaluation> {
  lchAssert(
    reference.mediaType === 'application/ld+json' && reference.inline !== undefined,
    'ERR_LCH_POLICY',
    'Core evaluator requires an inline JSON-LD policy'
  )
  lchAssert(
    reference.digest.length === 32 &&
      toHex(await sha256(reference.inline)) === toHex(reference.digest),
    'ERR_LCH_POLICY',
    'Policy digest mismatch'
  )
  let value: unknown
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(reference.inline))
  } catch (error) {
    throw new LCHError('ERR_LCH_POLICY', 'Policy is not valid UTF-8 JSON', { cause: error })
  }
  lchAssert(
    value !== null && typeof value === 'object' && !Array.isArray(value),
    'ERR_LCH_POLICY',
    'Policy must be a JSON object'
  )
  const policy = value as Record<string, unknown>
  lchAssert(
    policy['@type'] === expectedType,
    'ERR_LCH_POLICY',
    `Policy must be an ODRL ${expectedType}`
  )
  const self = expectedType === 'Offer' ? 'lch:offer:self' : 'lch:license:self'
  lchAssert(policy.uid === self, 'ERR_LCH_POLICY', `Policy top-level uid must be ${self}`)
  const contexts = Array.isArray(policy['@context']) ? policy['@context'] : [policy['@context']]
  lchAssert(
    contexts.includes(ODRL_CONTEXT) &&
      contexts.every(context => context === ODRL_CONTEXT || sameJson(context, LCH_ODRL_CONTEXT)) &&
      contexts.filter(context => context === ODRL_CONTEXT).length === 1 &&
      contexts.filter(context => sameJson(context, LCH_ODRL_CONTEXT)).length <= 1,
    'ERR_LCH_POLICY',
    'Policy names an absent, duplicate, or unsupported context'
  )
  lchAssert(policy.profile === LCH_ODRL_PROFILE, 'ERR_LCH_POLICY', 'LCH ODRL profile is absent')
  lchAssert(
    policy.conflict === undefined ||
      policy.conflict === 'invalid' ||
      policy.conflict === 'odrl:invalid',
    'ERR_LCH_POLICY',
    'LCH Policies require the ODRL invalid conflict strategy'
  )
  const evaluated = { ...policy, uid: computedIri }
  const permissions = arrayOfObjects(policy.permission)
  const prohibitions = arrayOfObjects(policy.prohibition)
  const duties = permissions.flatMap(permission => arrayOfObjects(permission.duty))
  return { policy: evaluated, permissions, prohibitions, duties }
}

function sameJson(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (
    left === null ||
    right === null ||
    typeof left !== 'object' ||
    typeof right !== 'object' ||
    Array.isArray(left) ||
    Array.isArray(right)
  ) {
    return false
  }
  const leftEntries = Object.entries(left).sort(([a], [b]) => a.localeCompare(b))
  const rightEntries = Object.entries(right).sort(([a], [b]) => a.localeCompare(b))
  return (
    leftEntries.length === rightEntries.length &&
    leftEntries.every(
      ([key, value], index) =>
        key === rightEntries[index]?.[0] && sameJson(value, rightEntries[index]?.[1])
    )
  )
}

function arrayOfObjects(value: unknown): Array<Record<string, unknown>> {
  let values: unknown[]
  if (value === undefined) values = []
  else if (Array.isArray(value)) values = value
  else values = [value]
  lchAssert(
    values.every(item => item !== null && typeof item === 'object' && !Array.isArray(item)),
    'ERR_LCH_POLICY',
    'Policy rule must be an object'
  )
  return values as Array<Record<string, unknown>>
}

export function permits(evaluation: PolicyEvaluation, action: string, target: string): boolean {
  const prohibited = evaluation.prohibitions.some(
    rule => rule.action === action && rule.target === target
  )
  if (prohibited) return false
  return evaluation.permissions.some(rule => rule.action === action && rule.target === target)
}
