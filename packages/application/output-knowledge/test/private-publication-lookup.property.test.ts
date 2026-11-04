import { expect, it } from '@jest/globals'
import fc from 'fast-check'
import { publicationLookupFixture } from './private-publication-lookup.fixture.js'
import { allow } from './private-publication-fixture.js'

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

function applyGeneratedCut(
  f: ReturnType<typeof publicationLookupFixture>,
  prepared: ReturnType<ReturnType<typeof publicationLookupFixture>['reader']['prepare']>,
  cut: number,
  revision: string
) {
  if (cut === 1) f.revoke()
  if (cut === 2) f.disconnect()
  if (cut === 3) prepared.dispose()
  if (cut === 4) {
    const peer = f.reopen()
    peer.markUnavailable(f.initial.publicationId, revision, () => '21', allow)
  }
}

it('retains native private context across reopen and never enqueues after generated authority, readiness or byte-binding cuts', async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.integer({ min: 0, max: 5 }),
      fc.boolean(),
      fc.uint8Array({ minLength: 0, maxLength: 8 }),
      async (cut, reopen, altered) => {
        const f = publicationLookupFixture()
        try {
          const reader = reopen ? f.reopenReader() : f.reader,
            prepared = reader.prepare(f.initial.publicationId, f.caller),
            answer = f.answer()
          const original = f.store.loadVerified(f.initial.publicationId, () => '20', allow)!
          let sends = 0
          if (cut === 5) {
            answer.outputs[0].context = [9, ...altered]
            expect(() => prepared.bind(answer)).toThrow('context or output differs')
          } else {
            const bound = prepared.bind(answer)
            applyGeneratedCut(f, prepared, cut, original.record.revision)
            const send = () => {
              sends++
              return undefined
            }
            if (cut === 0) {
              bound.enqueue(send)
              expect(sends).toBe(1)
            } else expect(() => bound.enqueue(send)).toThrow()
            expect(() => bound.enqueue(send)).toThrow()
          }
          expect(sends).toBe(cut === 0 ? 1 : 0)
          if (cut !== 4)
            expect(
              f.store.loadVerified(f.initial.publicationId, () => '20', allow)!.original
            ).toEqual(original.original)
        } finally {
          f.cleanup()
        }
      }
    )
  )
}, 150000)
