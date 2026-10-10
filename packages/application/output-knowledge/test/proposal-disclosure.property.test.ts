import { expect, it } from '@jest/globals'
import fc from 'fast-check'
import { proposalDisclosureFixture } from './proposal-disclosure-fixture.js'
import { author, outsider } from './proposal-fixture.js'

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
  'keeps response disclosure within exact caller, bytes, access and operation-specific time bounds',
  async () => {
    const f = await proposalDisclosureFixture()
    try {
      const ack = f.disclosure.bind('put', f.publication, f.ack, f.caller)
      const read = f.disclosure.bind(
        'get',
        f.query,
        await f.service.get(f.query, f.caller),
        f.caller
      )
      await fc.assert(
        fc.asyncProperty(
          fc.record({
            historical: fc.boolean(),
            access: fc.boolean(),
            caller: fc.boolean(),
            original: fc.boolean(),
            now: fc.constantFrom(11, 99, 100, 1099, 1100, 1101)
          }),
          async sample => {
            const bound = sample.historical ? ack : read
            f.state.allowed = sample.access
            f.state.now = String(sample.now)
            const body = new TextEncoder().encode(bound.body)
            if (!sample.original) body[0] ^= 1
            let queued = 0
            const result = await Promise.allSettled([
              f.storage.enqueueResponse(
                { reference: bound.reference, bytes: body },
                (entry, bytes) => bound.validate(entry, bytes, sample.caller ? author : outsider),
                bytes => {
                  expect(bytes).toEqual(new TextEncoder().encode(bound.body))
                  queued++
                  return undefined
                }
              )
            ])
            const permitted =
              sample.caller &&
              sample.original &&
              sample.access &&
              sample.now < (sample.historical ? 1100 : 100)
            expect(result[0].status).toBe(permitted ? 'fulfilled' : 'rejected')
            expect(queued).toBe(permitted ? 1 : 0)
            expect((await f.storage.head()).revision).toBe('1')
          }
        )
      )
    } finally {
      await f.close()
    }
  },
  Math.min(2147483647, Math.max(30000, propertyRuns * 100))
)
