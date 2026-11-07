import { expect, it } from '@jest/globals'
import fc from 'fast-check'
import { RootEvictionContracts } from '../src/root-eviction/RootEvictionContracts.js'
import {
  rootContractManifest,
  rootContractPacket,
  rootContractTrust
} from './root-contract-fixture.js'

const MIN_PROPERTY_RUNS = 300
const requestedRuns = Number.parseInt(process.env.FAST_CHECK_NUM_RUNS ?? '', 10)
const requestedSeed = Number.parseInt(process.env.FAST_CHECK_SEED ?? '', 10)
const replayPath = process.env.FAST_CHECK_PATH
fc.configureGlobal({
  numRuns: Number.isSafeInteger(requestedRuns)
    ? Math.max(MIN_PROPERTY_RUNS, requestedRuns)
    : MIN_PROPERTY_RUNS,
  ...(Number.isSafeInteger(requestedSeed) ? { seed: requestedSeed } : {}),
  ...(replayPath !== undefined && replayPath !== '' ? { path: replayPath } : {})
})

it('preserves exact retained selection and the stricter limit for every generated signed contract', () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 1, max: 128 }),
      fc.bigInt({ min: 1n, max: 18446744073709551615n }),
      fc.integer({ min: 1, max: 2097152 }),
      fc.integer({ min: 1, max: 2097152 }),
      fc.integer({ min: 100, max: 199 }),
      (maximumTargets, maximumLifetime, maximumRequestBytes, maximumResponseBytes, selectedAt) => {
        const body = rootContractManifest()
        Object.assign(body.services[0].profiles[0], {
          maxRequestBytes: maximumRequestBytes,
          maxResponseBytes: maximumResponseBytes,
          parameters: { maxTargets: maximumTargets, maxLifetimeSeconds: maximumLifetime.toString() }
        })
        const { packet, selector } = rootContractPacket(body)
        const contracts = new RootEvictionContracts(rootContractTrust())
        const retained = contracts.retain(packet, selector, String(selectedAt))
        const expected = {
          maximumTargets: maximumTargets > 64 ? 64 : maximumTargets,
          maximumLifetimeSeconds: String(maximumLifetime > 86400n ? 86400n : maximumLifetime),
          maximumRequestBytes: maximumRequestBytes > 1048576 ? 1048576 : maximumRequestBytes,
          maximumResponseBytes: maximumResponseBytes > 1048576 ? 1048576 : maximumResponseBytes
        }
        expect(retained.limits).toEqual(expected)
        expect(retained.record.selectedAt).toBe(String(selectedAt))
        expect(contracts.restore(retained.record, selector).limits).toEqual(expected)
        expect(() => contracts.retain(packet, selector, '200')).toThrow(
          expect.objectContaining({ code: 'expired' })
        )
        expect(() => contracts.restore(retained.record, 'ff'.repeat(32))).toThrow(
          expect.objectContaining({ code: 'context-changed' })
        )
      }
    )
  )
})
