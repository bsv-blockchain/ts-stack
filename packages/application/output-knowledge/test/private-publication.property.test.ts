import { expect, it } from '@jest/globals'
import fc from 'fast-check'
import type { PrivatePublicationEvent } from '../src/private/PrivatePublicationProgress.js'
import {
  fixture,
  request,
  selected,
  clock,
  allow,
  admission,
  binding
} from './private-publication-fixture.js'

const MIN_PROPERTY_RUNS = 300
const requestedRuns = Number.parseInt(process.env.FAST_CHECK_NUM_RUNS ?? '', 10)
const requestedSeed = Number.parseInt(process.env.FAST_CHECK_SEED ?? '', 10)
const replayPath = process.env.FAST_CHECK_PATH
fc.configureGlobal({
  numRuns: Number.isSafeInteger(requestedRuns)
    ? Math.max(MIN_PROPERTY_RUNS, requestedRuns)
    : MIN_PROPERTY_RUNS,
  seed: Number.isSafeInteger(requestedSeed) ? requestedSeed : 3242026,
  interruptAfterTimeLimit: 150000,
  markInterruptAsFailure: true,
  ...(replayPath ? { path: replayPath } : {})
})

it('preserves shared bytes, independent fences and ordered readiness through 300 native restart and denial schedules', () => {
  fc.assert(
    fc.property(
      fc.uint8Array({ minLength: 1, maxLength: 24 }),
      fc.boolean(),
      fc.array(fc.record({ reopen: fc.boolean(), denied: fc.boolean() }), {
        minLength: 5,
        maxLength: 5
      }),
      (secret, duplicate, steps) => {
        const f = fixture()
        try {
          const input = { ...request(), privateValues: Buffer.from(secret).toString('base64') }
          const state = f.store.stage(input, selected(), '20', clock, allow)
          if (duplicate)
            f.store.stage(
              { ...input, requestId: 'synthetic-publish-2' },
              selected(),
              '20',
              clock,
              allow
            )
          const events: PrivatePublicationEvent[] = [
            { kind: 'reserve-admission' },
            { kind: 'admitted', admission: admission(state) },
            { kind: 'bound', binding: binding(state) },
            { kind: 'unavailable', reason: 'synthetic readiness loss' },
            { kind: 'restored', binding: binding(state) }
          ]
          const phases = ['admitting', 'binding', 'ready', 'unavailable', 'ready']
          const times = ['11', '21', '22', '23', '24']
          let owner = f.store
          for (let index = 0; index < steps.length; index++) {
            if (steps[index].reopen) owner = f.reopen()
            const revision = String(index + 1),
              now = () => times[index]
            if (steps[index].denied) {
              const before = owner.load(state.publicationId, now, allow)!
              let guards = 0
              expect(() =>
                owner.advance(state.publicationId, revision, events[index], now, () => {
                  if (++guards === 3) throw new Error('synthetic authorization revoked')
                })
              ).toThrow('synthetic authorization revoked')
              const after = f.reopen().load(state.publicationId, now, allow)!
              expect(after.fence.state).toEqual(before.fence.state)
              expect(after.record.revision).toBe(before.record.revision)
            }
            expect(
              owner.advance(state.publicationId, revision, events[index], now, allow).progress.phase
            ).toBe(phases[index])
            const durable = f.reopen().load(state.publicationId, () => '0', allow)!
            expect(durable.fence.state.progress.phase).toBe(phases[index])
            expect(durable.record.revision).toBe(String(index + 2))
            expect(durable.request).toEqual(input)
            expect(durable.observedAt).toBe(times[index])
            expect(() =>
              owner.advance(state.publicationId, revision, events[index], now, allow)
            ).toThrow('changed')
          }
          expect(f.rows().filter(row => row.kind === 'publication')).toHaveLength(1)
          expect(f.rows().filter(row => row.kind === 'request-fence')).toHaveLength(
            duplicate ? 2 : 1
          )
          expect(f.reopen().load(state.publicationId, clock, allow)!.revision).toBe(
            duplicate ? '7' : '6'
          )
        } finally {
          f.cleanup()
        }
      }
    )
  )
}, 180000)
