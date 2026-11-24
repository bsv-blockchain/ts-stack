import { expect, it } from '@jest/globals'
import fc from 'fast-check'
import { DatabaseSync } from 'node:sqlite'
import { fixture, selected } from './root-eviction-fixture.js'
import { rootPosition, rootDecimal } from '../src/root-eviction/RootEvictionCodec.js'

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
const MAX = 18446744073709551615n

it(
  'preserves exact full-width revisions and reserves index acknowledgement before committing an assessment',
  async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.oneof(fc.bigInt({ min: 0n, max: MAX }), fc.bigInt({ min: MAX - 4n, max: MAX })),
        fc.boolean(),
        async (revision, eligible) => {
          expect(rootPosition(revision.toString())).toBe(revision.toString(16).padStart(16, '0'))
          expect(rootDecimal(revision.toString(16).padStart(16, '0'))).toBe(revision.toString())
          const f = await fixture()
          try {
            // Seed an otherwise empty fixture at a generated durable counter position.
            const db = new DatabaseSync(f.path)
            db.prepare('UPDATE root_meta SET revision=?').run(
              revision.toString(16).padStart(16, '0')
            )
            db.close()
            const assessment = {
              operationId: 'generated_counter_assessment',
              expectedRevision: revision.toString(),
              target: selected(),
              eligible,
              evidenceDigest: '77'.repeat(32),
              reasonCode: 'generated-currentness'
            }
            if (revision > MAX - 2n) {
              await expect(f.store.assess(assessment)).rejects.toMatchObject({
                code: 'limited',
                message: expect.stringMatching(/\S/)
              })
              expect((await f.store.head()).revision).toBe(revision.toString())
              expect(await f.store.projections(1)).toEqual([])
              expect((await f.store.serving(selected())).state).toBe('unresolved')
            } else {
              expect(await f.store.assess(assessment)).toBe((revision + 1n).toString())
              const [intent] = await f.store.projections(1)
              expect(intent.membership).toBe(eligible ? 'include' : 'withdraw')
              expect((await f.store.serving(selected())).state).toBe('unresolved')
              const reopened = f.reopen()
              expect(await reopened.projected(intent)).toBe(true)
              expect(await reopened.projected(intent)).toBe(true)
              expect((await reopened.head()).revision).toBe((revision + 2n).toString())
              expect(await reopened.assess(assessment)).toBe((revision + 1n).toString())
              expect((await reopened.serving(selected())).state).toBe(
                eligible ? 'eligible' : 'unresolved'
              )
            }
          } finally {
            await f.cleanup()
          }
        }
      )
    )
  },
  Math.min(2147483647, Math.max(120000, propertyRuns * 400))
)
