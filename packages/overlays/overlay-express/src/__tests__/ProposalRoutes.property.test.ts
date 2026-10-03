import fc from 'fast-check'
import { outputPacketDigest } from '@bsv/sdk'
import { proposalHTTPFixture } from './ProposalRoutes.fixture.js'
import { signed } from '../../../../application/output-knowledge/test/proposal-fixture.js'

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
  'discloses only currently authorized exact proposal state across generated signing schedules',
  async () => {
    let f = await proposalHTTPFixture(),
      current = f.proposal,
      revision = 0,
      index = 0
    try {
      expect((await f.fetch()).status).toBe(200)
      await fc.assert(
        fc.asyncProperty(
          fc.constantFrom('stable', 'revoke', 'revision', 'expiry'),
          fc.boolean(),
          fc.boolean(),
          fc.integer({ min: 0, max: 32 }),
          async (mode, historical, control, padding) => {
            if (index > 0 && index % 128 === 0) {
              const next = await proposalHTTPFixture()
              await f.cleanup()
              f = next
              current = f.proposal
              revision = 0
              expect((await f.fetch()).status).toBe(200)
            }
            index++
            f.state.allowed = true
            f.state.now = '11'
            f.httpState.control = control
            const expected = historical ? f.ack : await f.service.get(f.query, f.caller)
            let changed = false
            f.onHTTPSign(async () => {
              if (changed) return
              changed = true
              if (mode === 'revoke') f.state.allowed = false
              if (mode === 'expiry') f.state.now = '100'
              if (mode === 'revision') {
                current = signed({
                  revision: String(++revision),
                  previous: outputPacketDigest('proposal', current.body)
                })
                await f.service.put({ version: 1, proposal: current }, f.caller)
              }
            })
            const allowed = mode !== 'revoke' && (historical || mode === 'stable')
            const request = f.fetch(
              historical ? 'put' : 'get',
              (historical ? f.publication : f.query) + ' '.repeat(padding)
            )
            if (!allowed && !control) {
              await expect(request).rejects.toThrow()
              return
            }
            const response = await request
            if (allowed) {
              expect(response.status).toBe(200)
              expect(await response.json()).toEqual(expected)
            } else {
              const code =
                mode === 'revoke'
                  ? historical
                    ? 'unauthorized'
                    : 'not-found'
                  : mode === 'revision'
                    ? 'reset-required'
                    : 'expired'
              expect(response.status).toBe(
                code === 'unauthorized'
                  ? 401
                  : code === 'not-found'
                    ? 404
                    : code === 'reset-required'
                      ? 409
                      : 410
              )
              expect(await response.json()).toEqual({
                version: 1,
                error: { code, message: `Proposal request ${code}`, retryable: false }
              })
            }
            expect(f.wireHeaders.at(-1)!.get('cache-control')).toBe('private, no-store')
            expect(response.headers.get('x-bsv-overlay-capability')).toBe(f.caller.capabilityDigest)
          }
        )
      )
    } finally {
      await f.cleanup()
    }
  },
  Math.min(2147483647, Math.max(90000, propertyRuns * 300))
)
