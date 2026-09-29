import { describe, it, expect } from '@jest/globals'
import fc from 'fast-check'
import { MemoryJournal, knowledgeMutation } from '../src/index.js'

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

describe('journal idempotency and revision properties', () => {
  it('preserves the first durable mutation identity under arbitrary duplicate and stale-CAS schedules', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.record({ id: fc.integer({ min: 0, max: 12 }), stale: fc.boolean() }), {
          minLength: 1,
          maxLength: 60
        }),
        async operations => {
          const store = new MemoryJournal('property')
          const firstCommit = new Map<number, number>()
          let revision = 0
          try {
            for (const operation of operations) {
              const mutation = knowledgeMutation({
                kind: 'invalidate',
                generation: '0',
                assessmentIds: [],
                reason: `event-${operation.id}`
              })
              const expected = operation.stale ? '1000' : String(revision)
              const result = await store.append(expected, mutation)
              const prior = firstCommit.get(operation.id)
              if (prior !== undefined)
                expect(result).toEqual({
                  status: 'replayed',
                  revision: { received: String(prior), accepted: String(prior) }
                })
              else if (operation.stale) expect(result.status).toBe('conflict')
              else {
                revision++
                firstCommit.set(operation.id, revision)
                expect(result).toEqual({
                  status: 'committed',
                  revision: { received: String(revision), accepted: String(revision) }
                })
              }
            }
            expect((await store.head()).entries).toBe(firstCommit.size)
            expect((await store.read('0', 100)).map(entry => entry.revision.received)).toEqual(
              Array.from({ length: revision }, (_, index) => String(index + 1))
            )
          } finally {
            await store.close()
          }
        }
      )
    )
  })
})
