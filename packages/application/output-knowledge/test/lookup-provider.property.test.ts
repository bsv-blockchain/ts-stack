import { expect, it } from '@jest/globals'
import fc from 'fast-check'
import {
  providerFixture,
  providerEntry,
  providerBatch,
  providerRead
} from './lookup-provider-fixture.js'

// Generated outpoint indices exercise framing/membership only; Bitcoin evidence
// acceptance is tested by the separate core and end-to-end verifier suites.
it('preserves the fixed snapshot, complete following group, exact original response and current disclosure guard', async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.integer({ min: 0, max: 8 }),
      fc.integer({ min: 1, max: 3 }),
      fc.integer({ min: 3, max: 6 }),
      fc.boolean(),
      async (beforeCount, afterCount, pageSize, authenticated) => {
        const f = await providerFixture(authenticated ? 'brc103' : 'none')
        try {
          if (beforeCount > 0)
            await f.index.commit({
              base: '0',
              evaluatedAt: '1000',
              edits: Array.from({ length: beforeCount }, (_, i) => providerEntry(i)),
              event: {}
            })
          const open = { ...f.open, limits: { ...f.open.limits, maxObservations: pageSize } }
          const original = await f.service.open(open, f.caller)
          let batch = providerBatch(original)
          const watermark = beforeCount > 0 ? '1' : '0'
          expect(batch.through).toBe(watermark)
          const committed = await f.index.commit({
            base: watermark,
            evaluatedAt: '1000',
            edits: Array.from({ length: afterCount }, (_, i) => providerEntry(100 + i)),
            event: {}
          })
          const indices: number[] = []
          for (let page = 0; page < 16; page++) {
            expect(batch.phase).toBe('snapshot')
            expect(batch.through).toBe(watermark)
            for (const group of batch.groups)
              for (const observation of group.observations) {
                expect(observation.kind).toBe('output')
                if (observation.kind === 'output')
                  indices.push(observation.payload.evidence.outputIndex)
              }
            if (batch.snapshotComplete) break
            batch = providerBatch(await f.service.read(providerRead(batch), f.caller))
          }
          expect(batch.snapshotComplete).toBe(true)
          expect(indices).toEqual(Array.from({ length: beforeCount }, (_, i) => i))
          const peer = f.peer()
          const live = providerBatch(await peer.service.read(providerRead(batch), f.caller))
          expect(live.phase).toBe('live')
          expect(live.through).toBe(committed.sequence)
          expect(live.groups).toHaveLength(1)
          expect(live.groups[0].observations).toHaveLength(afterCount)
          expect(providerBatch(await f.service.read(providerRead(batch), f.caller)).groups).toEqual(
            live.groups
          )
          f.clock.now = '1201'
          await f.rotate()
          expect(await peer.service.open(open, f.caller)).toEqual(original)
          const guard = await f.sessions.guard('serving')
          await f.sessions.advanceGuard('serving', guard)
          await expect(peer.service.read(providerRead(live), f.caller)).rejects.toMatchObject({
            code: 'unauthorized'
          })
          await expect(peer.service.open(open, f.caller)).rejects.toMatchObject({
            code: 'unauthorized'
          })
        } finally {
          await f.cleanup()
        }
      }
    ),
    {}
  )
}, 600000)

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
