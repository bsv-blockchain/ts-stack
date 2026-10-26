import fc from 'fast-check'
import { outputRootAdvertisementDigest } from '@bsv/sdk'
import {
  apply,
  request,
  selected
} from '../../../../application/output-knowledge/test/root-eviction-fixture.js'
import { rootResponseFixture } from './RootEvictionResponseGuard.fixture.js'

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
  'never discloses an old advertisement after signing races a durable suppression or access revocation',
  async () => {
    let f = await rootResponseFixture()
    let index = 0
    try {
      await fc.assert(
        fc.asyncProperty(fc.constantFrom('stable', 'suppress', 'revoke'), async mode => {
          // Each independent fixture keeps its permanent history. Larger nightly
          // campaigns use another root fixture rather than deleting its fences.
          if (index > 0 && index % 256 === 0) {
            const next = await rootResponseFixture()
            await f.cleanup()
            f = next
          }
          index++
          const body = request(`fixture_http_property_${index}`)
          body.targets[0].outpoint.outputIndex = index
          body.targets[0].advertisement.outputIndex = index
          body.targets[0].advertisementDigest = outputRootAdvertisementDigest({
            service: body.targets[0].service,
            outpoint: body.targets[0].outpoint,
            lockingScript: 'UQ=='
          })
          const target = selected(body)
          await f.store.assess({
            operationId: `fixture_http_assessment_${index}`,
            expectedRevision: (await f.store.head()).revision,
            target,
            eligible: true,
            evidenceDigest: '11'.repeat(32),
            reasonCode: 'fixture-local-assessment'
          })
          await f.store.projected(
            (await f.store.projections(1024)).find(
              intent => intent.target.outpoint.outputIndex === index
            )!
          )
          f.setTarget(target)
          f.setAccess(true, true)
          let checked = false
          f.onSign(async () => {
            if (checked) return
            checked = true
            if (mode === 'suppress') await apply(f.store, body)
            if (mode === 'revoke') f.setAccess(false, true)
          })
          const response = await f.fetch(),
            packet = await response.json()
          expect(response.status).toBe(mode === 'stable' ? 200 : mode === 'suppress' ? 409 : 404)
          if (mode === 'stable') expect(packet).toEqual({ output: 'original' })
          else {
            expect(packet.error.code).toBe(mode === 'suppress' ? 'reset-required' : 'not-found')
            expect(packet.output).toBeUndefined()
            expect(response.headers.get('x-bsv-private')).toBeNull()
          }
          expect((await f.store.serving(target)).state).toBe(
            mode === 'suppress' ? 'suppressed' : 'eligible'
          )
        })
      )
    } finally {
      await f.cleanup()
    }
  },
  Math.min(2147483647, Math.max(90000, propertyRuns * 300))
)
