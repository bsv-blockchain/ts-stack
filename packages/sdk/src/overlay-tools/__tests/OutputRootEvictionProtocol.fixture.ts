import PrivateKey from '../../primitives/PrivateKey.js'
import { signOutputPacket, outputPacketDigest } from '../OutputProtocol.js'
import {
  outputRootAdvertisementDigest,
  outputRootEvictionDecisionId,
  type OutputRootEvictionRequest,
  type OutputSignedRootEvictionRequest,
  type OutputRootEvictionOutcome,
  type OutputRootEvictionResult
} from '../OutputRootEvictionProtocol.js'

export const requesterKey = new PrivateKey(81)
export const rootKey = new PrivateKey(82)
export const otherKey = new PrivateKey(83)
export const rootPolicy = '55'.repeat(32)
export const rootChain = { network: 'mock', genesisHash: '00'.repeat(32) }

export function rootRequestBody(): OutputRootEvictionRequest {
  const outpoint = { chain: rootChain, txid: '11'.repeat(32), outputIndex: 0 }
  return {
    version: 1,
    requestId: 'root_request_fixture_1',
    requester: requesterKey.toPublicKey().toString(),
    recipient: rootKey.toPublicKey().toString(),
    chain: rootChain,
    issuedAt: '100',
    expiresAt: '200',
    action: 'suppress',
    targets: [
      {
        service: 'ls_ship',
        outpoint,
        advertisementDigest: outputRootAdvertisementDigest({
          service: 'ls_ship',
          outpoint,
          lockingScript: 'UQ=='
        }),
        evidence: {
          kind: 'operator-policy',
          policy: 'fixture-manual-review',
          detailDigest: '22'.repeat(32)
        },
        advertisement: { txid: outpoint.txid, outputIndex: 0, beef: 'AA==' }
      }
    ],
    reason: 'fixture-owner-request'
  }
}

export function signedRootRequest(body = rootRequestBody()): OutputSignedRootEvictionRequest {
  return signOutputPacket('root-eviction-request', body, requesterKey)
}

export function rootOutcome(
  request = rootRequestBody(),
  revision = '1',
  index = 0
): OutputRootEvictionOutcome {
  const item = request.targets[index]
  const decisionId = outputRootEvictionDecisionId({
    root: request.recipient,
    requestDigest: outputPacketDigest('root-eviction-request', request),
    service: item.service,
    outpoint: item.outpoint,
    revision
  })
  return {
    service: item.service,
    outpoint: item.outpoint,
    actionStatus: 'applied',
    reasonCode: 'fixture-approved',
    decisionId,
    affectedDecisionIds: [request.action === 'restore' ? item.restores! : decisionId],
    revision,
    serving:
      request.action === 'restore'
        ? { state: 'eligible', revision, blockers: [] }
        : { state: 'suppressed', revision, blockers: [{ decisionId, policyDigest: rootPolicy }] }
  }
}

export function rootResultBody(request = rootRequestBody()): OutputRootEvictionResult {
  return {
    version: 1,
    requestDigest: outputPacketDigest('root-eviction-request', request),
    root: request.recipient,
    policyDigest: rootPolicy,
    issuedAt: '150',
    outcomes: request.targets.map((_, index) => rootOutcome(request, '1', index))
  }
}
