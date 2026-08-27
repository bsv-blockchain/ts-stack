import { LCH_LIMITS } from './constants.js'
import { lchAssert } from './errors.js'
import { objectId, toHex } from './hash.js'
import { verifySignedObject } from './objects.js'
import type {
  LCHSignatureVerifier,
  LCHValue,
  RevocationObservation,
  RevocationSource
} from './types.js'

export interface AuthorityBody {
  version: 1
  assetId: Uint8Array
  grantor: Uint8Array
  grantee: Uint8Array
  interests: string[]
  capabilities: string[]
  policyActions?: string[]
  usageProfiles?: string[]
  notBefore: number | bigint
  notAfter?: number | bigint
  mayDelegate: boolean
  remainingDepth?: number | bigint
  revocationOutpoint?: string
  revocationMaxAgeSeconds?: number | bigint
  nonce: Uint8Array
}

export interface AuthorityRequirement {
  controller: Uint8Array
  actor: Uint8Array
  assetId: Uint8Array
  interest: string
  capability: string
  policyAction?: string
  usageProfile?: string
  now: bigint
  network: RevocationObservation['network']
}

function includes(values: readonly string[] | undefined, value: string | undefined): boolean {
  return value === undefined || values === undefined || values.includes(value)
}

function isSubset(
  child: readonly string[] | undefined,
  parent: readonly string[] | undefined
): boolean {
  if (parent === undefined) return true
  return child !== undefined && child.every(value => parent.includes(value))
}

function validateAuthorityBody(body: AuthorityBody): void {
  lchAssert(
    body.version === 1 &&
      body.assetId.length === 32 &&
      body.grantor.length === 33 &&
      body.grantee.length === 33 &&
      body.nonce.length === 16,
    'ERR_LCH_AUTHORITY',
    'Authority body has invalid version or field lengths'
  )
  for (const [name, values] of [
    ['interests', body.interests],
    ['capabilities', body.capabilities],
    ['policyActions', body.policyActions],
    ['usageProfiles', body.usageProfiles]
  ] as const) {
    if (values === undefined) continue
    lchAssert(
      values.length > 0 &&
        values.every(value => value.length > 0) &&
        new Set(values).size === values.length,
      'ERR_LCH_AUTHORITY',
      `Authority ${name} must be nonempty and unique`
    )
  }
  const notBefore = BigInt(body.notBefore)
  if (body.notAfter !== undefined) {
    lchAssert(
      BigInt(body.notAfter) >= notBefore,
      'ERR_LCH_AUTHORITY',
      'Authority validity interval is inverted'
    )
  }
  if (body.remainingDepth !== undefined) {
    const remainingDepth = BigInt(body.remainingDepth)
    lchAssert(
      remainingDepth >= 0n && remainingDepth <= BigInt(LCH_LIMITS.authorityDepth - 1),
      'ERR_LCH_AUTHORITY',
      'Authority remaining depth is invalid'
    )
  }
}

function rejectDelegationWidening(parent: AuthorityBody, child: AuthorityBody): void {
  lchAssert(
    isSubset(child.interests, parent.interests) &&
      isSubset(child.capabilities, parent.capabilities) &&
      isSubset(child.policyActions, parent.policyActions) &&
      isSubset(child.usageProfiles, parent.usageProfiles),
    'ERR_LCH_AUTHORITY',
    'Delegated Authority widens a scope'
  )
  lchAssert(
    BigInt(child.notBefore) >= BigInt(parent.notBefore),
    'ERR_LCH_AUTHORITY',
    'Delegated Authority widens its start time'
  )
  if (parent.notAfter !== undefined) {
    lchAssert(
      child.notAfter !== undefined && BigInt(child.notAfter) <= BigInt(parent.notAfter),
      'ERR_LCH_AUTHORITY',
      'Delegated Authority widens its end time'
    )
  }
  if (parent.remainingDepth !== undefined && child.mayDelegate) {
    const maximum = BigInt(parent.remainingDepth) - 1n
    lchAssert(
      maximum >= 0n &&
        child.remainingDepth !== undefined &&
        BigInt(child.remainingDepth) <= maximum,
      'ERR_LCH_AUTHORITY',
      'Delegated Authority widens its remaining depth'
    )
  }
}

async function verifyRevocation(
  body: AuthorityBody,
  requirement: AuthorityRequirement,
  source: RevocationSource | undefined
): Promise<void> {
  const hasOutpoint = body.revocationOutpoint !== undefined
  const hasAge = body.revocationMaxAgeSeconds !== undefined
  lchAssert(
    hasOutpoint === hasAge,
    'ERR_LCH_REVOCATION',
    'Revocation outpoint and maximum age must appear together'
  )
  if (
    !hasOutpoint ||
    body.revocationOutpoint === undefined ||
    body.revocationMaxAgeSeconds === undefined
  )
    return
  const ageLimit = BigInt(body.revocationMaxAgeSeconds)
  lchAssert(
    ageLimit > 0n && ageLimit <= BigInt(LCH_LIMITS.maxRevocationAgeSeconds),
    'ERR_LCH_REVOCATION',
    'Revocation maximum age is invalid'
  )
  const outpoint = /^([\da-f]{64})\.(\d+)$/u.exec(body.revocationOutpoint)
  lchAssert(
    outpoint !== null && BigInt(outpoint[2]) <= 0xffffffffn,
    'ERR_LCH_REVOCATION',
    'Revocation outpoint is invalid'
  )
  lchAssert(
    !/^0{64}\.0$/u.test(body.revocationOutpoint),
    'ERR_LCH_REVOCATION',
    'Disabled revocation sentinel is prohibited'
  )
  lchAssert(source !== undefined, 'ERR_LCH_REVOCATION', 'No revocation-status source is configured')
  const observation = await source.status(body.revocationOutpoint)
  lchAssert(
    observation.network === requirement.network,
    'ERR_LCH_REVOCATION',
    'Revocation observation is for another network'
  )
  lchAssert(
    observation.reorganizationAffected !== true,
    'ERR_LCH_REVOCATION',
    'Revocation observation was invalidated by reorganization'
  )
  lchAssert(
    observation.status === 'unspent',
    'ERR_LCH_REVOCATION',
    `Authority status is ${observation.status}`
  )
  const age = requirement.now - observation.observedAt
  lchAssert(age >= 0n && age <= ageLimit, 'ERR_LCH_REVOCATION', 'Revocation observation is stale')
}

export async function validateAuthorityChain(
  chain: ReadonlyArray<{ body: AuthorityBody; signatures: Uint8Array[] }>,
  requirement: AuthorityRequirement,
  signatureVerifier: LCHSignatureVerifier,
  revocationSource?: RevocationSource
): Promise<void> {
  lchAssert(
    chain.length > 0 && chain.length <= LCH_LIMITS.authorityDepth,
    'ERR_LCH_AUTHORITY',
    'Authority chain length is invalid'
  )
  const seen = new Set<string>()
  const seenActors = new Set<string>([toHex(requirement.controller)])
  let expectedGrantor = requirement.controller
  let parent: AuthorityBody | undefined
  for (let index = 0; index < chain.length; index += 1) {
    const body = chain[index].body
    validateAuthorityBody(body)
    if (parent !== undefined) rejectDelegationWidening(parent, body)
    await verifySignedObject(
      'authority',
      chain[index] as unknown as { body: Record<string, LCHValue>; signatures: Uint8Array[] },
      signatureVerifier,
      body.grantor
    )
    const authorityId = toHex(
      await objectId('authority', body as unknown as Record<string, LCHValue>)
    )
    lchAssert(!seen.has(authorityId), 'ERR_LCH_CYCLE', 'Repeated authority grant')
    seen.add(authorityId)
    lchAssert(
      !seenActors.has(toHex(body.grantee)),
      'ERR_LCH_CYCLE',
      'Authority actor cycle detected'
    )
    seenActors.add(toHex(body.grantee))
    lchAssert(
      toHex(body.grantor) === toHex(expectedGrantor),
      'ERR_LCH_AUTHORITY',
      'Authority chain grantor mismatch'
    )
    lchAssert(
      toHex(body.assetId) === toHex(requirement.assetId),
      'ERR_LCH_AUTHORITY',
      'Authority Asset ID mismatch'
    )
    lchAssert(
      body.interests.includes(requirement.interest) &&
        body.capabilities.includes(requirement.capability),
      'ERR_LCH_AUTHORITY',
      'Authority scope does not cover the requested role'
    )
    lchAssert(
      includes(body.policyActions, requirement.policyAction) &&
        includes(body.usageProfiles, requirement.usageProfile),
      'ERR_LCH_AUTHORITY',
      'Authority action or profile is out of scope'
    )
    const notBefore = BigInt(body.notBefore)
    lchAssert(
      requirement.now >= notBefore &&
        (body.notAfter === undefined || requirement.now <= BigInt(body.notAfter)),
      'ERR_LCH_AUTHORITY',
      'Authority grant is outside its validity interval'
    )
    const isFinal = index === chain.length - 1
    if (!isFinal) {
      lchAssert(body.mayDelegate, 'ERR_LCH_AUTHORITY', 'Authority grant does not permit delegation')
      if (body.remainingDepth !== undefined)
        lchAssert(
          BigInt(body.remainingDepth) >= BigInt(chain.length - index - 1),
          'ERR_LCH_AUTHORITY',
          'Authority delegation depth exceeded'
        )
    }
    await verifyRevocation(body, requirement, revocationSource)
    expectedGrantor = body.grantee
    parent = body
  }
  lchAssert(
    toHex(expectedGrantor) === toHex(requirement.actor),
    'ERR_LCH_AUTHORITY',
    'Authority chain does not end at the required actor'
  )
}
