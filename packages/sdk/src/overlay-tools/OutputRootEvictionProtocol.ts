import * as s from './OutputProtocolSchema.js'
import { outputAssert } from './OutputProtocolError.js'
import { canonicalOutputJSON } from './OutputProtocolJSON.js'
import {
  decodeOutputBytes,
  outputPacketDigest,
  outputU64,
  verifyOutputPacket
} from './OutputProtocol.js'

const maximumBytes = 1048576
const service = s.literal('ls_ship', 'ls_slap')
const targetIdentity = { service, outpoint: s.outpoint }
const evidence = s.tagged('kind', {
  spent: s.object({ kind: s.literal('spent'), txid: s.hex, beef: s.bytes }),
  'owner-withdrawal': s.object({
    kind: s.literal('owner-withdrawal'),
    advertisement: s.evidence
  }),
  'operator-policy': s.object({
    kind: s.literal('operator-policy'),
    policy: s.text,
    detailDigest: s.hex
  })
})
const target = s.object(
  { ...targetIdentity, advertisementDigest: s.hex, evidence, advertisement: s.evidence },
  { restores: s.hex }
)
const request = s.object({
  version: s.literal(1),
  requestId: s.requestId,
  requester: s.identity,
  recipient: s.identity,
  chain: s.chain,
  issuedAt: s.u64,
  expiresAt: s.u64,
  action: s.literal('suppress', 'restore'),
  targets: s.array(target, 64, 1),
  reason: s.text
})
const signature = (input: unknown): string => {
  decodeOutputBytes(input, 174)
  return input as string
}
const signedRequest = s.object({ body: request, signature })
const blocker = s.object({ decisionId: s.hex, policyDigest: s.hex })
const outcome = s.object(
  {
    ...targetIdentity,
    actionStatus: s.literal('pending', 'rejected', 'applied', 'no-op'),
    reasonCode: s.text,
    affectedDecisionIds: s.array(s.hex, 1),
    revision: s.u64,
    serving: s.object({
      state: s.literal('suppressed', 'eligible', 'unresolved'),
      revision: s.u64,
      blockers: s.array(blocker)
    })
  },
  { decisionId: s.hex }
)
const result = s.object({
  version: s.literal(1),
  requestDigest: s.hex,
  root: s.identity,
  policyDigest: s.hex,
  issuedAt: s.u64,
  outcomes: s.array(outcome, 64, 1)
})
const signedResult = s.object({ body: result, signature })
const status = s.object({ version: s.literal(1), requester: s.identity, requestId: s.requestId })
const decision = s.object({
  root: s.identity,
  requestDigest: s.hex,
  ...targetIdentity,
  revision: s.u64
})

export type OutputRootEvictionRequest = ReturnType<typeof request>
export type OutputSignedRootEvictionRequest = ReturnType<typeof signedRequest>
export type OutputRootEvictionTarget = ReturnType<typeof target>
export type OutputRootEvictionResult = ReturnType<typeof result>
export type OutputSignedRootEvictionResult = ReturnType<typeof signedResult>
export type OutputRootEvictionOutcome = ReturnType<typeof outcome>
export type OutputRootEvictionStatus = ReturnType<typeof status>

function compareTargets(
  left: Pick<OutputRootEvictionTarget, 'service' | 'outpoint'>,
  right: Pick<OutputRootEvictionTarget, 'service' | 'outpoint'>
): number {
  return (
    s.compareUTF8(left.service, right.service) ||
    s.compareUTF8(left.outpoint.txid, right.outpoint.txid) ||
    left.outpoint.outputIndex - right.outpoint.outputIndex
  )
}

function sameOutput(
  advertisement: ReturnType<typeof s.evidence>,
  outpoint: ReturnType<typeof s.outpoint>
): boolean {
  return advertisement.txid === outpoint.txid && advertisement.outputIndex === outpoint.outputIndex
}

/** Closed, owned BRC-199 packet; opaque BEEF still requires independent verification. */
export function parseOutputRootEvictionRequest(input: unknown): OutputSignedRootEvictionRequest {
  const packet = s.normalized(input, signedRequest, maximumBytes)
  const body = packet.body
  const lifetime = outputU64(body.expiresAt) - outputU64(body.issuedAt)
  outputAssert(lifetime > 0n && lifetime <= 86400n, 'Invalid root request lifetime')
  s.sortedUnique(body.targets, compareTargets)
  for (const item of body.targets) {
    outputAssert(
      canonicalOutputJSON(item.outpoint.chain) === canonicalOutputJSON(body.chain),
      'Root target chain differs from request'
    )
    outputAssert(
      (item.restores !== undefined) === (body.action === 'restore'),
      'Restore must name exactly one suppression basis'
    )
    outputAssert(
      sameOutput(item.advertisement, item.outpoint),
      'Advertisement selects another output'
    )
    if (item.evidence.kind === 'owner-withdrawal')
      outputAssert(
        sameOutput(item.evidence.advertisement, item.outpoint),
        'Owner withdrawal selects another output'
      )
  }
  return packet
}

/** Apply only to a new request. Retained exact retries recover without reapplying this clock check. */
export function validateOutputRootEvictionWindow(
  input: unknown,
  clock: { now: string; maximumLifetimeSeconds: string; futureClockSeconds: string }
): OutputSignedRootEvictionRequest {
  const packet = parseOutputRootEvictionRequest(input)
  const selected = s.normalized(
    clock,
    s.object({
      now: s.u64,
      maximumLifetimeSeconds: s.u64,
      futureClockSeconds: s.u64
    })
  )
  const maximum = outputU64(selected.maximumLifetimeSeconds)
  outputAssert(maximum > 0n && maximum <= 86400n, 'Invalid selected root request lifetime')
  const issued = outputU64(packet.body.issuedAt),
    expires = outputU64(packet.body.expiresAt)
  const now = outputU64(selected.now)
  outputAssert(
    expires - issued <= maximum &&
      issued - now <= outputU64(selected.futureClockSeconds) &&
      now < expires,
    'Root request is outside the selected clock window'
  )
  return packet
}

/**
 * Direct authenticated-request binding. The requester argument comes from trusted
 * transport context, not the payload. Relay policy and local suppression authority
 * remain separate; possessing a valid request never grants administrative access.
 */
export function verifyOutputRootEvictionRequest(
  input: unknown,
  selected: { root: string; chain: ReturnType<typeof s.chain>; requester: string }
): OutputSignedRootEvictionRequest {
  const expected = s.normalized(
    selected,
    s.object({ root: s.identity, chain: s.chain, requester: s.identity })
  )
  const packet = parseOutputRootEvictionRequest(input)
  outputAssert(
    packet.body.recipient === expected.root &&
      packet.body.requester === expected.requester &&
      canonicalOutputJSON(packet.body.chain) === canonicalOutputJSON(expected.chain),
    'Root request differs from authenticated selection',
    'unauthorized'
  )
  outputAssert(
    verifyOutputPacket('root-eviction-request', packet, expected.requester),
    'Root request signature failed',
    'unauthorized'
  )
  return packet
}

/** This digest binds supplied bytes; callers must first verify the actual advertisement script. */
export function outputRootAdvertisementDigest(input: {
  service: OutputRootEvictionTarget['service']
  outpoint: OutputRootEvictionTarget['outpoint']
  lockingScript: string
}): string {
  return outputPacketDigest(
    'root-advertisement',
    s.normalized(
      input,
      s.object({
        ...targetIdentity,
        lockingScript: s.bytes
      }),
      maximumBytes
    )
  )
}

/** A deterministic root-local audit identity, not evidence that the decision was committed. */
export function outputRootEvictionDecisionId(input: ReturnType<typeof decision>): string {
  return outputPacketDigest('root-eviction-decision', s.normalized(input, decision))
}

/** Requester/auditor authorization must precede record lookup; absence and denial are indistinguishable. */
export const parseOutputRootEvictionStatus = (input: unknown): OutputRootEvictionStatus =>
  s.normalized(input, status, maximumBytes)

/** Saved action outcomes and current serving assessments are deliberately separate. */
export function parseOutputRootEvictionResult(input: unknown): OutputSignedRootEvictionResult {
  const packet = s.normalized(input, signedResult, maximumBytes)
  s.sortedUnique(packet.body.outcomes, compareTargets)
  for (const item of packet.body.outcomes) {
    outputAssert(
      (item.decisionId !== undefined) === (item.actionStatus === 'applied'),
      'Only an applied root action has a decision ID'
    )
    outputAssert(
      item.affectedDecisionIds.length ===
        (['applied', 'no-op'].includes(item.actionStatus) ? 1 : 0),
      'Root action has an invalid affected-decision list'
    )
    s.sortedUnique(item.serving.blockers, (left, right) =>
      s.compareUTF8(left.decisionId, right.decisionId)
    )
    outputAssert(
      (item.serving.state !== 'eligible' || item.serving.blockers.length === 0) &&
        (item.serving.state !== 'suppressed' || item.serving.blockers.length > 0),
      'Root serving state contradicts its blockers'
    )
  }
  return packet
}

/**
 * Authenticate a result against the original signed request and independently
 * retained evaluation policy. This does not establish current serving state,
 * evidence validity, Bitcoin finality or agreement by any other root.
 */
export function verifyOutputRootEvictionResult(
  input: unknown,
  originalRequest: unknown,
  retainedPolicyDigest: string
): OutputSignedRootEvictionResult {
  const original = parseOutputRootEvictionRequest(originalRequest)
  outputAssert(
    verifyOutputPacket('root-eviction-request', original, original.body.requester),
    'Original root request signature failed',
    'unauthorized'
  )
  const packet = parseOutputRootEvictionResult(input),
    body = packet.body
  outputAssert(
    body.requestDigest === outputPacketDigest('root-eviction-request', original.body) &&
      body.root === original.body.recipient &&
      body.policyDigest === s.hex(retainedPolicyDigest) &&
      body.outcomes.length === original.body.targets.length,
    'Root result differs from retained request or policy'
  )
  body.outcomes.forEach((item, index) => {
    const requested = original.body.targets[index]
    outputAssert(
      item.service === requested.service &&
        canonicalOutputJSON(item.outpoint) === canonicalOutputJSON(requested.outpoint),
      'Root result changed a requested target'
    )
    if (item.actionStatus === 'applied') {
      const id = outputRootEvictionDecisionId({
        root: body.root,
        requestDigest: body.requestDigest,
        service: item.service,
        outpoint: item.outpoint,
        revision: item.revision
      })
      outputAssert(item.decisionId === id, 'Root decision ID does not bind its saved action')
      outputAssert(
        item.affectedDecisionIds[0] ===
          (original.body.action === 'suppress' ? id : requested.restores),
        'Root action affected a different suppression basis'
      )
    }
    if (item.actionStatus === 'no-op')
      outputAssert(
        original.body.action === 'restore' && item.affectedDecisionIds[0] === requested.restores,
        'Only restoration of the named basis can be a no-op'
      )
  })
  outputAssert(
    verifyOutputPacket('root-eviction-result', packet, body.root),
    'Root result signature failed',
    'unauthorized'
  )
  return packet
}
