import fc from 'fast-check'
import { outputPacketDigest, signOutputPacket } from '../OutputProtocol.js'
import {
  parseOutputPurchaseEnvelope,
  verifyOutputPurchaseTerms,
  verifyOutputPurchaseEnvelope,
  verifyOutputPurchaseCommitmentEnvelope
} from '../OutputPurchaseProtocol.js'
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

test('reserved commitments bind all 32 bytes and current aliases never rewrite historical delivery', () => {
  const key = new PrivateKey(83),
    seller = key.toPublicKey().toString()
  const recipient = new PrivateKey(84).toPublicKey().toString()
  const chain = { network: 'purchase-commitment-property', genesisHash: '11'.repeat(32) }
  fc.assert(
    fc.property(
      fc.uint8Array({ minLength: 32, maxLength: 32 }),
      fc.integer({ min: 0, max: 31 }),
      fc.uint8Array({ maxLength: 128 }),
      (bytes, position, aliasEvidence) => {
        const commitment = Buffer.from(bytes).toString('hex')
        const original = signOutputPacket(
          'purchase-terms',
          {
            version: 1 as const,
            acquisitionId: '22'.repeat(32),
            requestDigest: '33'.repeat(32),
            seller,
            recipient,
            topic: 'tm_property',
            listing: { chain, txid: '44'.repeat(32), outputIndex: 0 },
            assetId: '55'.repeat(32),
            termsDigest: '66'.repeat(32),
            domainProfile: 'https://bsv.brc.dev/tokens/0197#listing-purchase-v1',
            domainEvidence: { schema: 'urn:fixture:lineage', bytes: 'AA==' },
            releasePolicy: { kind: 'local-admission' as const },
            purchaseUntil: '100',
            recoveryUntil: '86500'
          },
          key
        )
        const envelope = {
          result: {
            version: 1,
            acquisitionId: original.body.acquisitionId,
            status: 'admission-pending',
            txid: '77'.repeat(32),
            purchaseCommitment: commitment,
            recoveryUntil: original.body.recoveryUntil
          },
          currentAlias: { txid: '88'.repeat(32), beef: toBase64(Array.from(aliasEvidence)) }
        }
        const verified = verifyOutputPurchaseEnvelope(
          envelope,
          original,
          envelope.result.txid,
          commitment
        )
        expect(verified).toEqual(envelope)
        const binding = {
          profile: 'full-purchase-commitment-v1' as const,
          domainProfile: original.body.domainProfile,
          purchaseCommitment: commitment
        }
        expect(verifyOutputPurchaseCommitmentEnvelope(envelope, original, binding)).toEqual(
          envelope
        )
        const equivalentResponse = {
          ...envelope,
          result: { ...envelope.result, txid: envelope.currentAlias.txid }
        }
        expect(
          verifyOutputPurchaseCommitmentEnvelope(equivalentResponse, original, binding)
        ).toEqual(equivalentResponse)
        const changed = new Uint8Array(bytes)
        changed[position] ^= 1
        expect(() =>
          verifyOutputPurchaseCommitmentEnvelope(equivalentResponse, original, {
            ...binding,
            purchaseCommitment: Buffer.from(changed).toString('hex')
          })
        ).toThrow('commitment mismatch')
        expect(() =>
          verifyOutputPurchaseEnvelope(
            envelope,
            original,
            envelope.result.txid,
            Buffer.from(changed).toString('hex')
          )
        ).toThrow('commitment mismatch')
        expect(() =>
          verifyOutputPurchaseEnvelope(envelope, original, envelope.currentAlias.txid, commitment)
        ).toThrow('transaction mismatch')
        envelope.currentAlias.beef = toBase64([...aliasEvidence, 1])
        expect(verified.currentAlias?.beef).toBe(toBase64(Array.from(aliasEvidence)))
        const without = { ...envelope.result } as Partial<typeof envelope.result>
        delete without.purchaseCommitment
        expect(() =>
          verifyOutputPurchaseEnvelope(
            { ...envelope, result: without },
            original,
            envelope.result.txid
          )
        ).toThrow('commitment required')
        expect(parseOutputPurchaseEnvelope(verified)).toEqual(verified)
      }
    )
  )
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
