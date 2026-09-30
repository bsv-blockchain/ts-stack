import { expect, it } from '@jest/globals'
import fc from 'fast-check'
import {
  Hash,
  PrivateKey,
  TransactionSignature,
  Utils,
  signOutputPacket,
  verifyOutputPacket
} from '@bsv/sdk'
import { RevenueListingAuthority } from '../src/revenue-listing/RevenueListingAuthority.js'
import { authorityFixture } from './revenue-authority-fixture.js'
import { lineage } from './revenue-lineage-fixture.js'

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

it('binds asynchronous authority results to the original input and genesis despite mutable callers or ports', async () => {
  const key = new PrivateKey(41),
    base = authorityFixture().prepared.signingRequests()[0]
  await fc.assert(
    fc.asyncProperty(
      fc.integer({ min: 0, max: base.preimage.length - 5 }),
      fc.integer({ min: 1, max: 255 }),
      fc.boolean(),
      fc.boolean(),
      async (offset, mask, wrong, genesisMode) => {
        const request = structuredClone(base)
        const authority = new RevenueListingAuthority({
          identity: key.toPublicKey().toString(),
          signTransaction: async received => {
            if (wrong) {
              received.preimage[offset] ^= mask
              received.data = Hash.sha256(received.preimage)
            }
            const raw = key.sign(received.data)
            const signature = Utils.toHex(
              new TransactionSignature(raw.r, raw.s, 65).toChecksigFormat()
            )
            await Promise.resolve()
            request.preimage.fill(mask)
            request.data.fill(mask)
            received.preimage.fill(mask)
            received.data.fill(mask)
            return signature
          },
          signGenesis: async body => {
            if (wrong) body.genesis.txid = mask.toString(16).padStart(2, '0').repeat(32)
            const signature = signOutputPacket('sale-genesis', body, key).signature
            await Promise.resolve()
            body.genesis.chain.network = 'mutated-port-copy'
            return signature
          }
        })
        if (genesisMode) {
          const result = authority.signGenesis(lineage.descriptor, lineage.genesis.body.genesis)
          if (wrong) await expect(result).rejects.toThrow('Genesis authority signature mismatch')
          else
            expect(
              verifyOutputPacket('sale-genesis', await result, lineage.descriptor.seller)
            ).toBe(true)
        } else {
          const result = authority.signTransaction(request)
          if (wrong) await expect(result).rejects.toThrow('retained input')
          else
            expect(
              TransactionSignature.fromChecksigFormat(Utils.toArray(await result, 'hex')).verify(
                base.data,
                key.toPublicKey()
              )
            ).toBe(true)
        }
      }
    )
  )
}, 120000)
