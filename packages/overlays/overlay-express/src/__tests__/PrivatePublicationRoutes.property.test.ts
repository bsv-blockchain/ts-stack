import { expect, it } from '@jest/globals'
import fc from 'fast-check'
import { privatePublicationHTTPFixture } from './PrivatePublicationRoutes.fixture.js'
import { allow } from '../../../../application/output-knowledge/test/private-publication-fixture.js'

const MIN_PROPERTY_RUNS = 300
const requestedRuns = Number.parseInt(process.env.FAST_CHECK_NUM_RUNS ?? '', 10)
const requestedSeed = Number.parseInt(process.env.FAST_CHECK_SEED ?? '', 10)
const replayPath = process.env.FAST_CHECK_PATH
const propertyRuns = Number.isSafeInteger(requestedRuns)
  ? Math.max(MIN_PROPERTY_RUNS, requestedRuns)
  : MIN_PROPERTY_RUNS
fc.configureGlobal({
  numRuns: propertyRuns,
  seed: Number.isSafeInteger(requestedSeed) ? requestedSeed : 3242026,
  ...(replayPath !== undefined && replayPath !== '' ? { path: replayPath } : {})
})

it(
  'sends only current publication state across generated authenticated signing schedules',
  async () => {
    const f = await privatePublicationHTTPFixture()
    let now = 20
    try {
      expect((await f.fetch()).status).toBe(200)
      await fc.assert(
        fc.asyncProperty(
          fc.constantFrom('stable', 'revoke', 'readiness'),
          fc.boolean(),
          fc.integer({ min: 0, max: 32 }),
          async (mode, expiredManifest, padding) => {
            f.onHTTPSign()
            f.grantAccess()
            now += expiredManifest ? 100 : 1
            f.time(String(now))
            const retained = f.store.loadVerified(f.status.publicationId, () => String(now), allow)!
            if (retained.fence.state.progress.phase === 'unavailable')
              f.store.bindVerified(
                f.status.publicationId,
                retained.record.revision,
                () => String(now),
                allow
              )
            const expected = await f.coordinator.status(f.status, f.caller)
            let changed = false
            f.onHTTPSign(() => {
              if (changed) return
              changed = true
              if (mode === 'revoke') f.revokeAccess()
              if (mode === 'readiness') {
                const peer = f.reopen(),
                  loaded = peer.loadVerified(f.status.publicationId, () => String(now), allow)!
                peer.advance(
                  f.status.publicationId,
                  loaded.record.revision,
                  { kind: 'unavailable', reason: 'Protected material temporarily unavailable' },
                  () => String(now),
                  allow
                )
              }
            })
            const response = await f.fetch('status', JSON.stringify(f.status) + ' '.repeat(padding))
            if (mode === 'stable') {
              expect(response.status).toBe(200)
              expect(await response.json()).toEqual(expected)
            } else {
              const code = mode === 'revoke' ? 'not-found' : 'conflict'
              expect(response.status).toBe(mode === 'revoke' ? 404 : 409)
              expect(await response.json()).toEqual({
                version: 1,
                error: {
                  code,
                  message: 'Private publication request ' + code,
                  retryable: false
                }
              })
            }
            expect(f.wireHeaders.at(-1)!.get('cache-control')).toBe('private, no-store')
            expect(response.headers.get('x-bsv-overlay-capability')).toBe(f.caller.capability)
          }
        )
      )
    } finally {
      await f.close()
    }
  },
  Math.min(2147483647, Math.max(90000, propertyRuns * 300))
)
