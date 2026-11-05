import { describe, it, expect } from '@jest/globals'
import fc from 'fast-check'
import { MemoryJournal, knowledgeMutation } from '../src/index.js'
import { MemoryOperationStateStore } from '../src/operations/index.js'

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
  it('admits one complete state per concurrent CAS round and never rewinds on delayed retries', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.uniqueArray(fc.integer({ min: 0, max: 1000 }), { minLength: 2, maxLength: 6 }),
          {
            minLength: 1,
            maxLength: 10
          }
        ),
        async rounds => {
          const store = new MemoryOperationStateStore('cas-property', { profile: 'local/1' }, {})
          try {
            for (const [round, writers] of rounds.entries()) {
              const previous = await store.read()
              const candidates = writers.map(writer => ({ round, writer }))
              const results = await Promise.all(
                candidates.map(value => store.compareAndSwap(previous.revision, value))
              )
              const winners = results.flatMap((result, index) =>
                result.status === 'updated' ? [index] : []
              )
              expect(winners).toHaveLength(1)
              const accepted = await store.read()
              expect(accepted.revision).toBe(String(round + 1))
              expect(accepted.value).toEqual(candidates[winners[0]])
              for (const candidate of candidates)
                await store.compareAndSwap(previous.revision, candidate)
              expect(await store.read()).toEqual(accepted)
              if (round > 0) {
                expect((await store.compareAndSwap('0', {})).status).toBe('conflict')
                expect(await store.read()).toEqual(accepted)
              }
            }
          } finally {
            await store.close()
          }
        }
      )
    )
  })

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
