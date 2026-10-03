import { expect, it } from '@jest/globals'
import fc from 'fast-check'
import { createPrivatePublicationRecords } from '../src/private/PrivatePublicationRecords.js'
import { privatePublicationOperation } from '../src/private/PrivatePublicationProgress.js'
import { verifiedFixture } from './private-verified-publication-fixture.js'
import { allow } from './private-publication-fixture.js'

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

it('keeps native original contracts and lookup activation atomic through 300 restart and authorization schedules', () => {
  fc.assert(
    fc.property(
      fc.uint8Array({ minLength: 1, maxLength: 24 }),
      fc.array(fc.record({ reopen: fc.boolean(), revoked: fc.boolean() }), {
        minLength: 5,
        maxLength: 5
      }),
      (secret, schedule) => {
        const f = verifiedFixture()
        try {
          const request = {
            ...f.contract.request,
            privateValues: Buffer.from(secret).toString('base64')
          }
          const pair = createPrivatePublicationRecords(
            request,
            f.native.owner.identity,
            { ...f.selected, chain: f.configuration.identity.chain },
            '20',
            '30'
          )
          const original = { ...f.contract.record, requestDigest: pair.fence.state.requestDigest }
          const state = f.store.stageVerified(
            request,
            f.selected,
            '30',
            original,
            () => '20',
            allow
          )
          let owner = f.store
          const phases = ['admitting', 'binding', 'ready', 'unavailable', 'ready']
          for (let index = 0; index < schedule.length; index++) {
            if (schedule[index].reopen) owner = f.reopen()
            const now = () => String(21 + index),
              revision = String(index + 1)
            const apply = (guard: typeof allow) => {
              switch (index) {
                case 0:
                  return owner.advance(
                    state.publicationId,
                    revision,
                    { kind: 'reserve-admission' },
                    now,
                    guard
                  )
                case 1:
                  return owner.advance(
                    state.publicationId,
                    revision,
                    {
                      kind: 'admitted',
                      admission: {
                        operationId: privatePublicationOperation(state),
                        txid: state.txid,
                        assessmentContextId: 'original-private-admission',
                        steak: {
                          [state.topic]: { outputsToAdmit: [state.outputIndex], coinsToRetain: [] }
                        }
                      }
                    },
                    now,
                    guard
                  )
                case 2:
                case 4:
                  return owner.bindVerified(state.publicationId, revision, now, guard)
                default:
                  return owner.advance(
                    state.publicationId,
                    revision,
                    { kind: 'unavailable', reason: 'synthetic interruption' },
                    now,
                    guard
                  )
              }
            }
            if (schedule[index].revoked) {
              const before = f.readReopened(reader =>
                reader.loadVerified(state.publicationId, now, allow)!
              )
              let gates = 0
              expect(() =>
                apply(() => {
                  if (++gates === (index === 2 || index === 4 ? 4 : 3))
                    throw new Error('revoked at native commit')
                })
              ).toThrow('revoked at native commit')
              const after = f.readReopened(reader =>
                reader.loadVerified(state.publicationId, now, allow)!
              )
              expect(after.fence).toEqual(before.fence)
              expect(after.binding).toEqual(before.binding)
              expect(after.record.revision).toBe(before.record.revision)
              expect(after.bindingRecord.revision).toBe(before.bindingRecord.revision)
              expect(after.revision).toBe(before.revision)
            }
            expect(apply(allow).progress.phase).toBe(phases[index])
            const durable = f.readReopened(reader =>
              reader.loadVerified(state.publicationId, now, allow)!
            )
            expect(durable.request).toEqual(request)
            expect(durable.original).toEqual(original)
            expect(durable.fence.state.progress.phase).toBe(phases[index])
            expect(durable.record.revision).toBe(String(index + 2))
            expect(durable.binding.phase).toBe(index < 2 ? 'reserved' : 'active')
            expect(durable.bindingRecord.revision).toBe(index < 2 ? '1' : '2')
            expect(() => apply(allow)).toThrow(expect.objectContaining({ code: 'conflict' }))
          }
          expect(f.native.rows().map(row => row.kind)).toEqual([
            'publication',
            'publication',
            'request-fence'
          ])
        } finally {
          f.cleanup()
        }
      }
    )
  )
}, 180000)
