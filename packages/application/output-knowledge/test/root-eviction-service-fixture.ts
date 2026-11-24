import { synchronousPromise } from '../src/internal/synchronousPromise.js'
import { jest } from '@jest/globals'
import { canonicalOutputJSON, signOutputPacket, type OutputRootEvictionResult } from '@bsv/sdk'
import {
  RootEvictionService,
  type RootEvictionServiceOptions
} from '../src/root-eviction/RootEvictionService.js'
import { rootContractKey } from './root-contract-fixture.js'
import { requester, policy, signed } from './root-eviction-fixture.js'
import {
  coordinatedFixture,
  coordinatedRequest,
  contractSelection
} from './root-eviction-coordination-fixture.js'

export function rootDeferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

/** A failed operation must reject the test instead of leaving its start barrier pending. */
export async function rootAwaitStart(
  started: Promise<void>,
  operation: Promise<unknown>
): Promise<void> {
  await Promise.race([
    started,
    operation.then(() => {
      throw new Error('Root operation completed before the expected signing/authority boundary')
    })
  ])
}

export async function rootServiceFixture() {
  const f = await coordinatedFixture()
  const state = { now: '150', policy, access: true, context: true }
  const sign: jest.Mock<RootEvictionServiceOptions['sign']> = jest.fn(
    (body: OutputRootEvictionResult, _signal: AbortSignal): Promise<unknown> =>
      synchronousPromise(() => signOutputPacket('root-eviction-result', body, rootContractKey))
  )
  const guard: jest.Mock<RootEvictionServiceOptions['guard']> = jest.fn(access =>
    synchronousPromise(() => ({
      expectedPolicyDigest: state.policy,
      clock: () => state.now,
      authorize: () => state.access && access.principal === requester,
      contextCurrent: () => state.context
    }))
  )
  const options: RootEvictionServiceOptions = {
    journal: f.store,
    contracts: f.contracts,
    futureClockSeconds: '5',
    guard,
    sign
  }
  const selection = contractSelection()
  const body = coordinatedRequest()
  return {
    ...f,
    state,
    sign,
    guard,
    options,
    selection,
    body,
    caller: { principal: requester, capabilityDigest: selection.selector },
    text: canonicalOutputJSON(signed(body)),
    statusText: canonicalOutputJSON({ version: 1, requester, requestId: body.requestId }),
    service(overrides: Partial<RootEvictionServiceOptions> = {}) {
      return new RootEvictionService({ ...options, ...overrides })
    }
  }
}
