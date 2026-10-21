import { outputRootAdvertisementDigest } from '@bsv/sdk'
import { RootEvictionContracts } from '../src/root-eviction/RootEvictionContracts.js'
import type { RootEvictionCommitGuard } from '../src/root-eviction/RootEvictionCommitContext.js'
import type { RootEvictionConfiguration } from '../src/root-eviction/RootEvictionStorage.js'
import {
  rootContractChain,
  rootContractIdentity,
  rootContractPacket,
  rootContractTrust
} from './root-contract-fixture.js'
import { fixture, policy, request } from './root-eviction-fixture.js'

export function coordinatedRequest(id = 'coordinated_request_one') {
  const body = request(id)
  body.recipient = rootContractIdentity
  body.chain = { ...rootContractChain }
  for (const target of body.targets) {
    target.outpoint.chain = { ...rootContractChain }
    target.advertisementDigest = outputRootAdvertisementDigest({
      service: target.service,
      outpoint: target.outpoint,
      lockingScript: 'UQ=='
    })
  }
  return body
}
export function contractSelection() {
  const { packet, selector } = rootContractPacket()
  return { manifest: packet, selector, futureClockSeconds: '5' }
}
export function coordinationGuard(now = '150'): RootEvictionCommitGuard {
  return {
    expectedPolicyDigest: policy,
    clock: () => now,
    authorize: () => true,
    contextCurrent: () => true
  }
}
export async function coordinatedFixture(options: Partial<RootEvictionConfiguration> = {}) {
  return {
    ...(await fixture({
      root: rootContractIdentity,
      chain: rootContractChain,
      coordination: {},
      ...options
    })),
    contracts: new RootEvictionContracts(rootContractTrust())
  }
}
