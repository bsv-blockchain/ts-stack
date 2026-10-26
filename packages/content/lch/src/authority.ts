import { LCH_LIMITS } from './constants.js'
import { lchAssert } from './errors.js'
import { objectId, toHex } from './hash.js'
import { verifySignedObject } from './objects.js'
import { isCompressedPublicKey } from './signatures.js'
import type {
  LCHSignatureVerifier,
  LCHValue,
  RevocationObservation,
  RevocationSource
} from './types.js'
import {
  ownDataValue,
  requiredOwnDataValue,
  snapshotBytes,
  snapshotSignedObject
} from './boundary.js'

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
  if (child === undefined) return false
  const allowed = new Set(parent)
  return child.every(value => allowed.has(value))
}

function validateAuthorityBody(body: AuthorityBody): void {
  lchAssert(
    body !== null &&
      typeof body === 'object' &&
      body.version === 1 &&
      body.assetId instanceof Uint8Array &&
      body.assetId.length === 32 &&
      body.grantor instanceof Uint8Array &&
      isCompressedPublicKey(body.grantor) &&
      body.grantee instanceof Uint8Array &&
      isCompressedPublicKey(body.grantee) &&
      body.nonce instanceof Uint8Array &&
      body.nonce.length === 16 &&
      typeof body.mayDelegate === 'boolean' &&
      Array.isArray(body.interests) &&
      Array.isArray(body.capabilities),
    'ERR_LCH_AUTHORITY',
    'Authority body has invalid version or field lengths'
  )
  for (const [name, values] of [
    ['interests', body.interests],
    ['capabilities', body.capabilities],
    ['policyActions', body.policyActions],
    ['usageProfiles', body.usageProfiles]
  ] as const) {
    if (values === undefined) {
      lchAssert(
        name === 'policyActions' || name === 'usageProfiles',
        'ERR_LCH_AUTHORITY',
        `Authority ${name} is absent`
      )
      continue
    }
    lchAssert(
      Array.isArray(values) &&
        values.length > 0 &&
        values.length <= LCH_LIMITS.cborEntries &&
        values.every(
          value =>
            typeof value === 'string' &&
            value.length > 0 &&
            value.length <= 4096 &&
            !hasControlCharacter(value)
        ) &&
        new Set(values).size === values.length,
      'ERR_LCH_AUTHORITY',
      `Authority ${name} must be nonempty and unique`
    )
  }
  const notBefore = authorityUint(body.notBefore, 'notBefore')
  if (body.notAfter !== undefined) {
    lchAssert(
      authorityUint(body.notAfter, 'notAfter') > notBefore,
      'ERR_LCH_AUTHORITY',
      'Authority validity interval is inverted'
    )
  }
  if (body.remainingDepth !== undefined) {
    const remainingDepth = authorityUint(body.remainingDepth, 'remainingDepth')
    lchAssert(
      remainingDepth >= 0n && remainingDepth <= BigInt(LCH_LIMITS.authorityDepth - 1),
      'ERR_LCH_AUTHORITY',
      'Authority remaining depth is invalid'
    )
  }
  lchAssert(
    body.revocationOutpoint === undefined ||
      (typeof body.revocationOutpoint === 'string' && body.revocationOutpoint.length <= 75),
    'ERR_LCH_REVOCATION',
    'Authority revocation outpoint is invalid'
  )
  if (body.revocationMaxAgeSeconds !== undefined)
    authorityUint(body.revocationMaxAgeSeconds, 'revocationMaxAgeSeconds')
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0)!
    if (codePoint <= 0x1f || codePoint === 0x7f) return true
  }
  return false
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
    authorityUint(child.notBefore, 'notBefore') >= authorityUint(parent.notBefore, 'notBefore'),
    'ERR_LCH_AUTHORITY',
    'Delegated Authority widens its start time'
  )
  if (parent.notAfter !== undefined) {
    lchAssert(
      child.notAfter !== undefined &&
        authorityUint(child.notAfter, 'notAfter') <= authorityUint(parent.notAfter, 'notAfter'),
      'ERR_LCH_AUTHORITY',
      'Delegated Authority widens its end time'
    )
  }
  if (parent.remainingDepth !== undefined && child.mayDelegate) {
    const maximum = authorityUint(parent.remainingDepth, 'remainingDepth') - 1n
    lchAssert(
      maximum >= 0n &&
        child.remainingDepth !== undefined &&
        authorityUint(child.remainingDepth, 'remainingDepth') <= maximum,
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
  const ageLimit = authorityUint(body.revocationMaxAgeSeconds, 'revocationMaxAgeSeconds')
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
  const status = requiredOwnDataValue(observation, 'status', 'Revocation observation')
  const network = requiredOwnDataValue(observation, 'network', 'Revocation observation')
  const observedAt = requiredOwnDataValue(observation, 'observedAt', 'Revocation observation')
  const reorganizationAffected = ownDataValue(
    observation,
    'reorganizationAffected',
    'Revocation observation'
  )
  lchAssert(
    network === requirement.network &&
      typeof status === 'string' &&
      ['unspent', 'spent-mempool', 'spent-confirmed', 'unknown'].includes(status) &&
      typeof observedAt === 'bigint' &&
      observedAt >= 0n &&
      (reorganizationAffected === undefined || typeof reorganizationAffected === 'boolean'),
    'ERR_LCH_REVOCATION',
    'Revocation observation is malformed or for another network'
  )
  lchAssert(
    reorganizationAffected !== true,
    'ERR_LCH_REVOCATION',
    'Revocation observation was invalidated by reorganization'
  )
  lchAssert(status === 'unspent', 'ERR_LCH_REVOCATION', `Authority status is ${status}`)
  const age = requirement.now - observedAt
  lchAssert(age >= 0n && age <= ageLimit, 'ERR_LCH_REVOCATION', 'Revocation observation is stale')
}

export async function validateAuthorityChain(
  chain: ReadonlyArray<{ body: AuthorityBody; signatures: Uint8Array[] }>,
  requirement: AuthorityRequirement,
  signatureVerifier: LCHSignatureVerifier,
  revocationSource?: RevocationSource
): Promise<void> {
  lchAssert(
    Array.isArray(chain) && chain.length > 0 && chain.length <= LCH_LIMITS.authorityDepth,
    'ERR_LCH_AUTHORITY',
    'Authority chain length is invalid'
  )
  requirement = snapshotAuthorityRequirement(requirement)
  validateAuthorityRequirement(requirement)
  const ownedChain = chain.map((entry, index) =>
    snapshotSignedObject(entry, `Authority grant ${index}`)
  )
  const seen = new Set<string>()
  const seenActors = new Set<string>([toHex(requirement.controller)])
  let expectedGrantor = requirement.controller
  let parent: AuthorityBody | undefined
  for (let index = 0; index < ownedChain.length; index += 1) {
    const body = ownedChain[index].body as unknown as AuthorityBody
    validateAuthorityBody(body)
    if (parent !== undefined) rejectDelegationWidening(parent, body)
    await verifySignedObject('authority', ownedChain[index], signatureVerifier, body.grantor)
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
    const notBefore = authorityUint(body.notBefore, 'notBefore')
    lchAssert(
      requirement.now >= notBefore &&
        (body.notAfter === undefined || requirement.now < authorityUint(body.notAfter, 'notAfter')),
      'ERR_LCH_AUTHORITY',
      'Authority grant is outside its validity interval'
    )
    const isFinal = index === ownedChain.length - 1
    if (!isFinal) {
      lchAssert(body.mayDelegate, 'ERR_LCH_AUTHORITY', 'Authority grant does not permit delegation')
      if (body.remainingDepth !== undefined)
        lchAssert(
          authorityUint(body.remainingDepth, 'remainingDepth') >=
            BigInt(ownedChain.length - index - 1),
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

function authorityUint(value: unknown, field: string): bigint {
  lchAssert(
    typeof value === 'bigint' || (typeof value === 'number' && Number.isSafeInteger(value)),
    'ERR_LCH_AUTHORITY',
    `Authority ${field} must be an exact integer`
  )
  const result = BigInt(value)
  lchAssert(
    result >= 0n && result <= 0xffffffffffffffffn,
    'ERR_LCH_AUTHORITY',
    `Authority ${field} is outside uint64`
  )
  return result
}

function validateAuthorityRequirement(requirement: AuthorityRequirement): void {
  lchAssert(
    requirement !== null &&
      typeof requirement === 'object' &&
      requirement.controller instanceof Uint8Array &&
      isCompressedPublicKey(requirement.controller) &&
      requirement.actor instanceof Uint8Array &&
      isCompressedPublicKey(requirement.actor) &&
      requirement.assetId instanceof Uint8Array &&
      requirement.assetId.length === 32 &&
      typeof requirement.interest === 'string' &&
      requirement.interest.length > 0 &&
      typeof requirement.capability === 'string' &&
      requirement.capability.length > 0 &&
      (requirement.policyAction === undefined ||
        (typeof requirement.policyAction === 'string' && requirement.policyAction.length > 0)) &&
      (requirement.usageProfile === undefined ||
        (typeof requirement.usageProfile === 'string' && requirement.usageProfile.length > 0)) &&
      typeof requirement.now === 'bigint' &&
      requirement.now >= 0n &&
      (requirement.network === 'mainnet' || requirement.network === 'testnet'),
    'ERR_LCH_AUTHORITY',
    'Authority requirement is invalid'
  )
}

function snapshotAuthorityRequirement(value: unknown): AuthorityRequirement {
  const name = 'Authority requirement'
  const controller = requiredOwnDataValue(value, 'controller', name)
  const actor = requiredOwnDataValue(value, 'actor', name)
  const assetId = requiredOwnDataValue(value, 'assetId', name)
  const interest = requiredOwnDataValue(value, 'interest', name)
  const capability = requiredOwnDataValue(value, 'capability', name)
  const now = requiredOwnDataValue(value, 'now', name)
  const network = requiredOwnDataValue(value, 'network', name)
  const policyAction = ownDataValue(value, 'policyAction', name)
  const usageProfile = ownDataValue(value, 'usageProfile', name)
  return {
    controller:
      controller instanceof Uint8Array
        ? snapshotBytes(controller, `${name}.controller`)
        : (controller as Uint8Array),
    actor:
      actor instanceof Uint8Array ? snapshotBytes(actor, `${name}.actor`) : (actor as Uint8Array),
    assetId:
      assetId instanceof Uint8Array
        ? snapshotBytes(assetId, `${name}.assetId`)
        : (assetId as Uint8Array),
    interest: interest as string,
    capability: capability as string,
    ...(policyAction === undefined ? {} : { policyAction: policyAction as string }),
    ...(usageProfile === undefined ? {} : { usageProfile: usageProfile as string }),
    now: now as bigint,
    network: network as AuthorityRequirement['network']
  }
}
