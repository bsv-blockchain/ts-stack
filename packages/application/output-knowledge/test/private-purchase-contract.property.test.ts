import { expect, it } from '@jest/globals'
import fc from 'fast-check'
import { PrivateKey, signOutputPacket, Utils, verifyOutputPurchaseTerms } from '@bsv/sdk'
import { purchaseContractFixture } from './private-purchase-contract.fixture.js'

const MIN_PROPERTY_RUNS = 300
const requestedRuns = Number.parseInt(process.env.FAST_CHECK_NUM_RUNS ?? '', 10)
const requestedSeed = Number.parseInt(process.env.FAST_CHECK_SEED ?? '', 10)
const replayPath = process.env.FAST_CHECK_PATH
fc.configureGlobal({
  numRuns: Number.isSafeInteger(requestedRuns)
    ? Math.max(MIN_PROPERTY_RUNS, requestedRuns)
    : MIN_PROPERTY_RUNS,
  seed: Number.isSafeInteger(requestedSeed) ? requestedSeed : 3242026,
  ...(replayPath !== undefined && replayPath !== '' ? { path: replayPath } : {})
})

it('preserves 300 original signed preparations and their full retention obligations across caller mutation', () => {
  const f = purchaseContractFixture()
  fc.assert(
    fc.property(
      fc.integer({ min: 1, max: 80 }),
      fc.integer({ min: 0, max: 172800 }),
      fc.uint8Array({ minLength: 1, maxLength: 32 }),
      fc.integer({ min: 45, max: 100 }),
      (interval, domainRecovery, data, key) => {
        const request = {
            ...structuredClone(f.request),
            requestId: 'generated-request_' + Utils.toHex(data),
            request: Utils.toBase64(data),
            recipient: new PrivateKey(key).toPublicKey().toString()
          },
          purchaseUntil = String(20 + interval),
          prepared = f.contracts.prepare(
            request,
            f.manifest(),
            {
              ...f.terms,
              purchaseUntil,
              creationCutoff: purchaseUntil,
              minimumRecoverySeconds: String(domainRecovery)
            },
            '20'
          ),
          signed = signOutputPacket('purchase-terms', prepared.body, f.key),
          original = f.contracts.authenticate(prepared, signed),
          expected = structuredClone(original)
        expect(
          verifyOutputPurchaseTerms(original.terms, original.request, f.installation.seller)
        ).toEqual(original.terms)
        expect(BigInt(original.terms.body.recoveryUntil)).toBe(
          BigInt(purchaseUntil) + BigInt(Math.max(86400, domainRecovery))
        )
        request.request = 'AA=='
        signed.body.purchaseUntil = '1'
        prepared.body.recoveryUntil = '1'
        prepared.capability.digest = '00'.repeat(32)
        expect(f.contracts.original(original)).toEqual(expected)
        const changed = {
          ...original,
          request: { ...original.request, requestId: 'another-original-request' }
        }
        expect(() => f.contracts.original(changed)).toThrow()
      }
    )
  )
}, 60000)
