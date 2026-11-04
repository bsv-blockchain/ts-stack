import { test, expect } from '@jest/globals'
import fc from 'fast-check'
import { OutputKnowledge, KnowledgeStore, MemoryJournal, type AcceptedInput } from '../src/index.js'
import { knowledgeMutation } from '../src/storage/Journal.js'
import { emptyReducer } from './empty-reducer.js'
import { context, partition } from './evidence-fixture.js'

const MIN_PROPERTY_RUNS = 300
const configuredRuns = Number(process.env.FAST_CHECK_NUM_RUNS ?? MIN_PROPERTY_RUNS)
const seed = Number(process.env.FAST_CHECK_SEED ?? 3242026)
if (
  !Number.isSafeInteger(configuredRuns) ||
  configuredRuns < MIN_PROPERTY_RUNS ||
  !Number.isSafeInteger(seed)
)
  throw new Error('Invalid publication property configuration')
fc.configureGlobal({
  numRuns: configuredRuns,
  seed,
  ...(process.env.FAST_CHECK_PATH ? { path: process.env.FAST_CHECK_PATH } : {})
})

test('publication observes exact exclusive deadlines and only resumes after durable invalidation', async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.integer({ min: 2, max: 9000000000000 }),
      fc.integer({ min: 0, max: 4096 }),
      async (seconds, lateMilliseconds) => {
        const expiry = BigInt(seconds) * 1000n
        let now = Number(expiry - 1n)
        const initial = context(),
          base = emptyReducer()
        const journal = new MemoryJournal('test')
        const store = new KnowledgeStore(journal, base, { partition })
        const deadline = (input: AcceptedInput) =>
          input.context.id === initial.id ? String(seconds) : undefined
        const runtime = new OutputKnowledge({
          store,
          now: () => now,
          worker: {
            pendingBytes: async () => 0,
            nextInvalidation: deadline,
            async advance() {
              const history = await store.inspect()
              const input = await base.reduce(history.entries, new AbortController().signal)
              if (deadline(input) === undefined || BigInt(now) < expiry) return
              const result = await store.commit(
                history.revision.received,
                knowledgeMutation({
                  kind: 'context',
                  context: { ...initial, id: 'after-invalidation' }
                })
              )
              expect(result.status).toBe('committed')
            }
          },
          projector: {
            policyDigest: 'ff'.repeat(32),
            async project(input) {
              return {
                acceptedRevision: input.revision.accepted,
                generation: input.generation,
                contextId: input.context.id,
                records: [],
                conflicts: [],
                unresolved: []
              }
            }
          }
        })
        try {
          await runtime.setContext(initial)
          await runtime.flush()
          expect((await runtime.readProjection())?.contextId).toBe(initial.id)
          expect((await journal.head()).accepted).toBe('1')
          now = Number(expiry + BigInt(lateMilliseconds))
          expect(await runtime.readProjection()).toBeUndefined()
          await runtime.flush()
          const current = await runtime.readProjection()
          expect(current?.contextId).toBe('after-invalidation')
          expect(current?.acceptedRevision).toBe('2')
          expect((await journal.read('1', 8)).map(entry => entry.body.kind)).toEqual(['context'])
        } finally {
          await runtime.close()
        }
      }
    )
  )
})
