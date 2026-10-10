import { canonicalOutputJSON, parseOutputJSON } from '@bsv/sdk'
import { LCH_IRI } from './constants.js'
import { LCHError, lchAssert } from './errors.js'
import { parsePinnedPolicy, type PolicyReference } from './policy.js'
import { sha256, toHex } from './hash.js'
import type { LCHValue } from './types.js'
import { snapshotLCHRecord } from './boundary.js'

const ODRL = 'http://www.w3.org/ns/odrl/2/'
const XSD_INTEGER = 'http://www.w3.org/2001/XMLSchema#integer'
const RENDER_ACTIONS = new Set(['play', 'display', 'read', 'execute'])
const POLICY_FIELDS = [
  '@context',
  '@type',
  'uid',
  'profile',
  'assigner',
  'assignee',
  'permission',
  'prohibition',
  'conflict'
]

function record(value: unknown, name: string): Record<string, unknown> {
  lchAssert(
    value !== null && typeof value === 'object' && !Array.isArray(value),
    'ERR_LCH_POLICY',
    `${name} must be a map`
  )
  return value as Record<string, unknown>
}
function fields(value: Record<string, unknown>, required: string[], optional: string[] = []): void {
  lchAssert(
    required.every(key => Object.hasOwn(value, key)) &&
      Object.keys(value).every(key => required.includes(key) || optional.includes(key)),
    'ERR_LCH_POLICY',
    'Unsupported fixed-render policy fields'
  )
}
function odrl(value: unknown, term: string): boolean {
  return value === term || value === ODRL + term
}
/** Expand only the actions defined by the pinned ODRL/LCH contexts. */
function action(value: unknown): string {
  if (typeof value === 'string') {
    if (RENDER_ACTIONS.has(value)) return ODRL + value
    if (value.startsWith(ODRL) && RENDER_ACTIONS.has(value.slice(ODRL.length))) return value
    if (value === LCH_IRI + '#render') return LCH_IRI + '#render'
  }
  lchAssert(false, 'ERR_LCH_POLICY', 'Unsupported fixed-render action')
}
function identity(value: string): string {
  return 'lch:identity:secp256k1:' + value
}
async function boundedPolicy(reference: PolicyReference, type: 'Offer' | 'Agreement') {
  lchAssert(reference.inline instanceof Uint8Array, 'ERR_LCH_POLICY', 'Inline policy is required')
  try {
    // The optional profile has a concrete integer-only policy vocabulary. Reject
    // duplicate decoded keys and ambiguous UTF-8 before the ordinary evaluator
    // can discard that information through JSON.parse.
    parseOutputJSON(reference.inline)
  } catch (cause) {
    throw new LCHError('ERR_LCH_POLICY', 'Fixed-render policy is not bounded unambiguous JSON', {
      cause
    })
  }
  return parsePinnedPolicy(
    reference,
    type,
    type === 'Offer' ? 'lch:offer:self' : 'lch:license:self'
  )
}
function exactAmount(value: unknown): bigint {
  const integer = record(value, 'Compensation amount')
  fields(integer, ['@value', '@type'])
  lchAssert(integer['@type'] === XSD_INTEGER, 'ERR_LCH_POLICY', 'Amount must be xsd:integer')
  const amount = integer['@value']
  lchAssert(
    (typeof amount === 'number' && Number.isSafeInteger(amount)) ||
      (typeof amount === 'string' && /^(0|[1-9]\d*)$/u.test(amount)),
    'ERR_LCH_POLICY',
    'Amount must be an exact unsigned integer'
  )
  return BigInt(amount as string | number)
}

export interface LCHOverlayFixedRenderPolicy {
  /** Exact verified Offer policy bytes, retained for deriving/comparing the Agreement. */
  reference: PolicyReference
  assetId: string
  seller: string
  buyer: string
  action: string
  dutyUid: string
  payee: string
  satoshis: bigint
}

/** A deliberately bounded, concrete ODRL evaluator: one fixed-render Permission,
 * one compensation precondition, and unconditional Prohibitions. All other
 * actions, constraints, inheritance and duties fail before money is allocated.
 * It is not a generic JSON-LD or ODRL evaluator.
 */
export async function validateLCHOverlayFixedRenderPolicy(
  input: LCHOverlayFixedRenderPolicy
): Promise<void> {
  input = snapshotLCHRecord(input, 'Fixed-render terms') as unknown as LCHOverlayFixedRenderPolicy
  const evaluated = await boundedPolicy(input.reference, 'Offer'),
    policy = evaluated.policy,
    target = 'lch:asset:sha256:' + input.assetId
  fields(policy, ['@context', '@type', 'uid', 'profile', 'assigner', 'permission'], POLICY_FIELDS)
  lchAssert(
    policy.assigner === identity(input.seller) &&
      (policy.assignee === undefined || policy.assignee === identity(input.buyer)),
    'ERR_LCH_POLICY',
    'Offer policy party differs'
  )
  lchAssert(
    evaluated.permissions.length === 1 && evaluated.duties.length === 1,
    'ERR_LCH_POLICY',
    'Exactly one Permission and compensation duty are supported'
  )
  const permission = evaluated.permissions[0]
  fields(permission, ['action', 'target', 'duty'])
  lchAssert(
    action(permission.action) === action(input.action) && permission.target === target,
    'ERR_LCH_POLICY',
    'Permission does not cover the requested Asset/action'
  )
  const duty = evaluated.duties[0]
  fields(duty, ['uid', 'action', 'compensatedParty'])
  lchAssert(
    duty.uid === input.dutyUid && duty.compensatedParty === identity(input.payee),
    'ERR_LCH_POLICY',
    'Compensation party or duty differs'
  )
  const compensation = record(duty.action, 'Compensation Action')
  fields(compensation, ['@id', 'refinement'])
  lchAssert(
    odrl(compensation['@id'], 'compensate') &&
      Array.isArray(compensation.refinement) &&
      compensation.refinement.length === 1,
    'ERR_LCH_POLICY',
    'Unsupported compensation Action'
  )
  const refinement = record(compensation.refinement[0], 'Compensation refinement')
  fields(refinement, ['leftOperand', 'operator', 'rightOperand', 'unit'])
  lchAssert(
    odrl(refinement.leftOperand, 'payAmount') &&
      odrl(refinement.operator, 'eq') &&
      refinement.unit === LCH_IRI + '#satoshi' &&
      exactAmount(refinement.rightOperand) === input.satoshis,
    'ERR_LCH_POLICY',
    'Compensation amount differs from the fixed requirement'
  )
  for (const prohibition of evaluated.prohibitions) {
    fields(prohibition, ['action', 'target'])
    lchAssert(
      typeof prohibition.action === 'string' && prohibition.target === target,
      'ERR_LCH_POLICY',
      'Unsupported Prohibition'
    )
    const prohibited = prohibition.action
    lchAssert(
      prohibited === LCH_IRI + '#unwrap' ||
        odrl(prohibited, 'archive') ||
        odrl(prohibited, 'reproduce') ||
        odrl(prohibited, 'distribute') ||
        odrl(prohibited, 'derive'),
      'ERR_LCH_POLICY',
      'Unknown Prohibition action'
    )
  }
}

/** Deterministically retain every accepted term, removing only the uniquely
 * fulfilled compensation precondition and binding the individual buyer.
 */
export async function createLCHOverlayFixedRenderAgreement(
  input: LCHOverlayFixedRenderPolicy
): Promise<Record<string, LCHValue>> {
  input = snapshotLCHRecord(input, 'Fixed-render terms') as unknown as LCHOverlayFixedRenderPolicy
  await validateLCHOverlayFixedRenderPolicy(input)
  const evaluated = await boundedPolicy(input.reference, 'Offer'),
    permission = { ...evaluated.permissions[0] }
  Reflect.deleteProperty(permission, 'duty')
  const agreement = {
    ...evaluated.policy,
    '@type': 'Agreement',
    uid: 'lch:license:self',
    assignee: identity(input.buyer),
    permission: [permission]
  }
  const inline = new TextEncoder().encode(canonicalOutputJSON(agreement))
  return { mediaType: 'application/ld+json', inline, digest: await sha256(inline) }
}

/** Compare rights semantics with the exact derived Agreement. Incoming policy
 * bytes retain their own digest; equivalent JSON ordering is not rehashed as
 * original evidence. No additional permission or removed prohibition is allowed.
 */
export async function validateLCHOverlayFixedRenderAgreement(
  input: LCHOverlayFixedRenderPolicy,
  received: PolicyReference
): Promise<void> {
  const expected = await createLCHOverlayFixedRenderAgreement(input),
    original = await boundedPolicy(expected as unknown as PolicyReference, 'Agreement'),
    actual = await boundedPolicy(received, 'Agreement')
  lchAssert(
    canonicalOutputJSON(original.policy) === canonicalOutputJSON(actual.policy),
    'ERR_LCH_POLICY',
    'License Agreement changed accepted rights or terms'
  )
  lchAssert(toHex(received.digest).length === 64, 'ERR_LCH_POLICY', 'Invalid Agreement digest')
}
