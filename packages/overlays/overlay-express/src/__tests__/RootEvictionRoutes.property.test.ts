import fc from 'fast-check'
import { signOutputPacket, verifyOutputRootEvictionResult } from '@bsv/sdk'
import { rootHTTPFixture } from './RootEvictionRoutes.fixture.js'
import { rootContractKey } from '../../../../application/output-knowledge/test/root-contract-fixture.js'
import { policy } from '../../../../application/output-knowledge/test/root-eviction-fixture.js'

const MIN_PROPERTY_RUNS = 300
const requestedRuns = Number.parseInt(process.env.FAST_CHECK_NUM_RUNS ?? '', 10)
const requestedSeed = Number.parseInt(process.env.FAST_CHECK_SEED ?? '', 10)
const replayPath = process.env.FAST_CHECK_PATH
const propertyRuns = Number.isSafeInteger(requestedRuns)
  ? Math.max(MIN_PROPERTY_RUNS, requestedRuns)
  : MIN_PROPERTY_RUNS
fc.configureGlobal({
  numRuns: propertyRuns,
  ...(Number.isSafeInteger(requestedSeed) ? { seed: requestedSeed } : {}),
  ...(replayPath !== undefined && replayPath !== '' ? { path: replayPath } : {})
})

it(
  'fences complete signed coordination results across generated packet/HTTP signing schedules',
  async () => {
    let f = await rootHTTPFixture()
    let index = 0
    try {
      expect((await f.fetch()).status).toBe(200)
      await fc.assert(
        fc.asyncProperty(
          fc.constantFrom('stable', 'revision', 'revoke'),
          fc.boolean(),
          fc.boolean(),
          fc.integer({ min: 0, max: 32 }),
          async (mode, duringPacket, retry, padding) => {
            if (index > 0 && index % 256 === 0) {
              const next = await rootHTTPFixture()
              await f.cleanup()
              f = next
              expect((await f.fetch()).status).toBe(200)
            }
            index++
            f.stateHTTP.data = true
            let changed = false
            const transition = async () => {
              if (changed) return
              changed = true
              if (mode === 'revision') {
                f.state.policy = index.toString(16).padStart(64, '0')
                await f.store.changePolicy(f.state.policy)
              }
              if (mode === 'revoke') f.stateHTTP.data = false
            }
            f.sign.mockImplementation(async body => {
              const packet = signOutputPacket('root-eviction-result', body, rootContractKey)
              if (duringPacket) await transition()
              return packet
            })
            f.onHTTPSign(async () => {
              if (!duringPacket) await transition()
            })
            const response = await f.fetch(
              retry ? 'request' : 'status',
              (retry ? f.text : f.statusText) + ' '.repeat(padding)
            )
            const packet = await response.json()
            expect(response.status).toBe(mode === 'stable' ? 200 : mode === 'revision' ? 409 : 404)
            expect(f.wireHeaders.at(-1)!.get('cache-control')).toBe('private, no-store')
            expect(response.headers.get('x-bsv-overlay-capability')).toBe(f.caller.capabilityDigest)
            if (mode === 'stable') {
              expect(
                verifyOutputRootEvictionResult(packet, JSON.parse(f.text), policy).body
                  .requestDigest
              ).toBeDefined()
            } else {
              expect(packet.error.code).toBe(mode === 'revision' ? 'reset-required' : 'not-found')
              expect(packet).not.toHaveProperty('body')
              expect(packet).not.toHaveProperty('signature')
            }
          }
        )
      )
    } finally {
      await f.cleanup()
    }
  },
  Math.min(2147483647, Math.max(90000, propertyRuns * 300))
)
