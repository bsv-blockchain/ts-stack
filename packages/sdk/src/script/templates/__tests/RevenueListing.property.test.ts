import fc from 'fast-check'
import PrivateKey from '../../../primitives/PrivateKey.js'
import ProtoWallet from '../../../wallet/ProtoWallet.js'
import { toHex } from '../../../primitives/utils.js'
import {
  encodeRevenueListingMetadata,
  encodeRevenueListingProfileSchedule,
  decodeRevenueListingProfileSchedule
} from '../RevenueListingProfile.js'
import {
  encodeRevenueListingState,
  decodeRevenueListingState,
  revenueListingChildPublicKey
} from '../RevenueListing.js'

const MIN_PROPERTY_RUNS = 300
const runs = Number.parseInt(process.env.FAST_CHECK_NUM_RUNS ?? '', 10)
const seed = Number.parseInt(process.env.FAST_CHECK_SEED ?? '', 10)
const path = process.env.FAST_CHECK_PATH
fc.configureGlobal({
  numRuns: Number.isSafeInteger(runs) ? Math.max(MIN_PROPERTY_RUNS, runs) : MIN_PROPERTY_RUNS,
  ...(Number.isSafeInteger(seed) ? { seed } : {}),
  ...(path ? { path } : {})
})
const identities = Array.from({ length: 8 }, (_, index) =>
  new PrivateKey(index + 1).toPublicKey().toString()
).sort((left, right) => left.localeCompare(right, 'en'))

test('public child derivation agrees with protected BRC-100 wallet derivation without exporting a child scalar', async () => {
  await fc.assert(
    fc.asyncProperty(fc.integer({ min: 1, max: 1000000 }), async value => {
      const wallet = new ProtoWallet(new PrivateKey(value))
      const root = await wallet.getPublicKey({ identityKey: true })
      const derived = await wallet.getPublicKey({
        protocolID: [2, '3241645161d8'],
        keyID: 'brc197 authority',
        counterparty: 'anyone',
        forSelf: true
      })
      expect(revenueListingChildPublicKey(root.publicKey)).toBe(derived.publicKey)
      expect(derived.publicKey).not.toBe(root.publicKey)
    })
  )
})

test('exact revenue-state encoding preserves U64 revisions, ordered identities, quanta and padding', () => {
  fc.assert(
    fc.property(
      fc.bigInt({ min: 0n, max: 18446744073709551615n }),
      fc.array(fc.integer({ min: 1, max: 1250 }), { minLength: 1, maxLength: 8 }),
      (revision, weights) => {
        const state = {
          revision: revision.toString(),
          recipients: weights.map((weight, index) => ({ identity: identities[index], weight }))
        }
        const encoded = encodeRevenueListingState(state)
        expect(encoded).toHaveLength(305)
        const view = new DataView(encoded.buffer, encoded.byteOffset, encoded.byteLength)
        expect(view.getBigUint64(0, true)).toBe(revision)
        expect(encoded[8]).toBe(weights.length)
        weights.forEach((weight, index) => {
          expect(toHex(Array.from(encoded.slice(9 + index * 37, 42 + index * 37)))).toBe(
            identities[index]
          )
          expect(view.getUint32(42 + index * 37, true)).toBe(weight)
        })
        expect(Array.from(encoded.slice(9 + weights.length * 37))).toEqual(
          Array((8 - weights.length) * 37).fill(0)
        )
        expect(decodeRevenueListingState(encoded)).toEqual(state)
        if (weights.length < 8) {
          encoded[304] = 1
          expect(() => decodeRevenueListingState(encoded)).toThrow('padding')
        }
      }
    )
  )
})

test('immutable PR295 metadata preserves one-to-eight public child links, exact weights and expiry', () => {
  const children = identities.map(revenueListingChildPublicKey)
  fc.assert(
    fc.property(
      fc.array(fc.integer({ min: 1, max: 1250 }), { minLength: 1, maxLength: 8 }),
      fc.integer({ min: 1, max: 499999999 }),
      fc.bigInt({ min: 1n, max: 2100000000000000n }),
      fc.bigInt({ min: 1n, max: 2100000000000000n }),
      (weights, expiryHeight, price, reserve) => {
        const schedule = {
          recipients: weights.map((weight, index) => ({ identity: identities[index], weight }))
        }
        const encoded = encodeRevenueListingProfileSchedule(schedule)
        const view = new DataView(encoded.buffer, encoded.byteOffset, encoded.byteLength)
        expect(encoded).toHaveLength(561)
        expect(encoded[0]).toBe(weights.length)
        weights.forEach((weight, index) => {
          const offset = 1 + index * 70
          expect(toHex(Array.from(encoded.slice(offset, offset + 33)))).toBe(identities[index])
          expect(toHex(Array.from(encoded.slice(offset + 33, offset + 66)))).toBe(children[index])
          expect(view.getUint32(offset + 66, true)).toBe(weight)
        })
        expect(Array.from(encoded.slice(1 + weights.length * 70))).toEqual(
          Array((8 - weights.length) * 70).fill(0)
        )
        expect(decodeRevenueListingProfileSchedule(encoded)).toEqual(schedule)
        const chain = { network: 'metadata-property', genesisHash: '11'.repeat(32) }
        const metadata = encodeRevenueListingMetadata({
          version: 1,
          chain,
          assetId: '22'.repeat(32),
          seller: identities[0],
          lineageAnchor: { chain, txid: '33'.repeat(32), outputIndex: 0 },
          purchasePrice: price.toString(),
          reserve: reserve.toString(),
          expiryHeight,
          termsDigest: '44'.repeat(32),
          scriptFamily: 'https://bsv.brc.dev/tokens/0197#revenue-listing-v1',
          metadataDigest: '55'.repeat(32),
          initialRevenue: schedule
        })
        const fields = new DataView(metadata.buffer, metadata.byteOffset, metadata.byteLength)
        expect(metadata).toHaveLength(717)
        expect(fields.getBigUint64(70, true)).toBe(price)
        expect(fields.getBigUint64(78, true)).toBe(reserve)
        expect(fields.getUint32(86, true)).toBe(expiryHeight)
        expect(Array.from(metadata.slice(156))).toEqual(Array.from(encoded))
        if (weights.length < 8) {
          encoded[560] = 1
          expect(() => decodeRevenueListingProfileSchedule(encoded)).toThrow('mismatch')
        }
      }
    )
  )
})
