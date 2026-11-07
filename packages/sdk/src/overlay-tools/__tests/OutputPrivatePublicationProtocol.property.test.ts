import fc from 'fast-check'
import {
  outputPrivatePublicationRequestDigest,
  parseOutputPrivatePublish
} from '../OutputPrivatePublicationProtocol.js'

const MIN_PROPERTY_RUNS = 300
const runs = Number.parseInt(process.env.FAST_CHECK_NUM_RUNS ?? '', 10)
const seed = Number.parseInt(process.env.FAST_CHECK_SEED ?? '', 10)
const path = process.env.FAST_CHECK_PATH
fc.configureGlobal({
  numRuns: Number.isSafeInteger(runs) ? Math.max(MIN_PROPERTY_RUNS, runs) : MIN_PROPERTY_RUNS,
  ...(Number.isSafeInteger(seed) ? { seed } : {}),
  ...(path ? { path } : {})
})

test('proof variation preserves publication identity while a changed protected payload never substitutes silently', () => {
  fc.assert(
    fc.property(
      fc.uint8Array({ maxLength: 2048 }),
      fc.uint8Array({ maxLength: 2048 }),
      (privateBytes, proof) => {
        const input = {
          version: 1,
          requestId: 'publication_property',
          topic: 'tm_property',
          evidence: {
            txid: '11'.repeat(32),
            outputIndex: 0,
            beef: Buffer.from(proof).toString('base64')
          },
          assetId: '22'.repeat(32),
          schema: 'urn:fixture:private',
          privateValues: Buffer.from(privateBytes).toString('base64')
        }
        const owned = parseOutputPrivatePublish(input)
        const digest = outputPrivatePublicationRequestDigest(input)
        input.evidence.beef = Buffer.concat([Buffer.from(proof), Buffer.from([1])]).toString(
          'base64'
        )
        expect(outputPrivatePublicationRequestDigest(input)).toBe(digest)
        input.privateValues = Buffer.concat([Buffer.from(privateBytes), Buffer.from([1])]).toString(
          'base64'
        )
        expect(outputPrivatePublicationRequestDigest(input)).not.toBe(digest)
        expect(owned.privateValues).toBe(Buffer.from(privateBytes).toString('base64'))
      }
    )
  )
})
