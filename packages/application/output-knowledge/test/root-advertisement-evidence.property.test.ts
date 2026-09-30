import { expect, it } from '@jest/globals'
import fc from 'fast-check'
import { outputPacketDigest, Utils } from '@bsv/sdk'
import { SDKRootEvictionEvidence } from '../src/root-eviction/SDKRootEvictionEvidence.js'
import { context, resolver } from './evidence-fixture.js'
import { rootAdvertisementFixture, signRootEvidence } from './root-advertisement-fixture.js'

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
  'keeps advertiser and exact consumption evidence bound to independently signed generated requests',
  async () => {
    const fixtures = await Promise.all([
      rootAdvertisementFixture('SHIP'),
      rootAdvertisementFixture('SLAP')
    ])
    const verifier = new SDKRootEvictionEvidence(resolver)
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          protocol: fc.boolean(),
          spent: fc.boolean(),
          id: fc.nat(1_000_000),
          reason: fc.string({ minLength: 1, maxLength: 30 }),
          restore: fc.boolean()
        }),
        async step => {
          const fixture = fixtures[Number(step.protocol)],
            body = structuredClone(fixture.body)
          body.requestId = `generated_evidence_${step.id}`
          body.reason = step.reason
          if (step.restore) {
            body.action = 'restore'
            body.targets[0].restores = '99'.repeat(32)
          }
          if (step.spent)
            body.targets[0].evidence = {
              kind: 'spent',
              txid: fixture.spend.id('hex'),
              beef: Utils.toBase64(fixture.spend.toAtomicBEEF())
            }
          const packet = signRootEvidence(body)
          const result = await verifier.verify(packet, 0, context())
          expect(result.requestDigest).toBe(outputPacketDigest('root-eviction-request', body))
          expect(result.target).toEqual(body.targets[0])
          expect(result.rawAdvertisementTransaction).toBe(
            Utils.toBase64(fixture.transaction.toBinary())
          )
          expect(result.proof.kind).toBe(step.spent ? 'spent' : 'owner-withdrawal')
          // A valid signed restoration still supplies no assertion that this root's
          // named suppression may be lifted or that the advertisement is unspent.
          expect(result).not.toHaveProperty('eligible')
          packet.body.requestId += '_changed'
          await expect(verifier.verify(packet, 0, context())).rejects.toMatchObject({
            code: 'unauthorized'
          })
        }
      )
    )
  },
  Math.min(2147483647, Math.max(60000, propertyRuns * 100))
)
