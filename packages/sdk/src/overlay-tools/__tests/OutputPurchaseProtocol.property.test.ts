import fc from 'fast-check'
import { outputPacketDigest, signOutputPacket } from '../OutputProtocol.js'
import { verifyOutputPurchaseTerms } from '../OutputPurchaseProtocol.js'
import PrivateKey from '../../primitives/PrivateKey.js'
import { toBase64 } from '../../primitives/utils.js'

const MIN_PROPERTY_RUNS = 300
const runs = Number.parseInt(process.env.FAST_CHECK_NUM_RUNS ?? '', 10)
const seed = Number.parseInt(process.env.FAST_CHECK_SEED ?? '', 10)
const path = process.env.FAST_CHECK_PATH
fc.configureGlobal({
  numRuns: Number.isSafeInteger(runs) ? Math.max(MIN_PROPERTY_RUNS, runs) : MIN_PROPERTY_RUNS,
  ...(Number.isSafeInteger(seed) ? { seed } : {}),
  ...(path ? { path } : {})
})

test('seller terms retain the exact selected request and minimum recovery interval', () => {
  const key = new PrivateKey(81),
    seller = key.toPublicKey().toString()
  const recipient = new PrivateKey(82).toPublicKey().toString()
  const chain = { network: 'purchase-property', genesisHash: '11'.repeat(32) }
  fc.assert(
    fc.property(
      fc.uint8Array({ maxLength: 128 }),
      fc.integer({ min: 1, max: 100000 }),
      (bytes, cutoff) => {
        const request = {
          version: 1 as const,
          requestId: 'property_request_1',
          topic: 'tm_property',
          recipient,
          listing: { chain, txid: '22'.repeat(32), outputIndex: 0 },
          assetId: '33'.repeat(32),
          termsDigest: '44'.repeat(32),
          request: toBase64(Array.from(bytes))
        }
        const body = {
          version: 1 as const,
          acquisitionId: outputPacketDigest('purchase', {
            chain,
            seller,
            recipient,
            topic: request.topic,
            requestId: request.requestId
          }),
          requestDigest: outputPacketDigest('purchase-request', request),
          seller,
          recipient,
          topic: request.topic,
          listing: request.listing,
          assetId: request.assetId,
          termsDigest: request.termsDigest,
          domainProfile: 'urn:fixture:domain',
          domainEvidence: { schema: 'urn:fixture:evidence', bytes: 'AA==' },
          releasePolicy: { kind: 'local-admission' as const },
          purchaseUntil: String(cutoff),
          recoveryUntil: String(cutoff + 86400)
        }
        const packet = signOutputPacket('purchase-terms', body, key)
        const verified = verifyOutputPurchaseTerms(packet, request, seller)
        expect(verified).toEqual(packet)
        request.request = toBase64([...bytes, 1])
        expect(() => verifyOutputPurchaseTerms(packet, request, seller)).toThrow('selected request')
        packet.body.recoveryUntil = String(cutoff + 86399)
        expect(() =>
          verifyOutputPurchaseTerms(
            packet,
            { ...request, request: toBase64(Array.from(bytes)) },
            seller
          )
        ).toThrow('less than one day')
        expect(verified.body.recoveryUntil).toBe(String(cutoff + 86400))
      }
    )
  )
})
