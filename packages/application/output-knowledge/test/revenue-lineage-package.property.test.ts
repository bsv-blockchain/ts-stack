import { expect, it } from '@jest/globals'
import fc from 'fast-check'
import { canonicalOutputJSON, OutputProtocolError } from '@bsv/sdk'
import { parseRevenueListingLineagePackage } from '../src/revenue-listing/LineagePackage.js'
import { completeGenesis } from './revenue-lineage-fixture.js'

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

it('preserves exact owned representations and rejects short bounds, duplicate entries and changed descriptors', () => {
  const original = completeGenesis()
  fc.assert(
    fc.property(
      fc.constantFrom('object', 'string', 'utf8'),
      fc.constantFrom('valid', 'short', 'duplicate', 'descriptor'),
      fc.integer({ min: 0, max: 63 }),
      (representation, mode, offset) => {
        const packet = structuredClone(original)
        if (mode === 'duplicate') packet.transactions.push({ ...packet.transactions[0] })
        if (mode === 'descriptor') {
          const hex = packet.descriptor.metadataDigest
          const digit = (Number.parseInt(hex[offset], 16) ^ 1).toString(16)
          packet.descriptor.metadataDigest = hex.slice(0, offset) + digit + hex.slice(offset + 1)
        }
        const json = canonicalOutputJSON(packet),
          bytes = new TextEncoder().encode(json)
        const inputs = { object: packet, string: json, utf8: bytes }
        const parse = () =>
          parseRevenueListingLineagePackage(inputs[representation], {
            bytes: bytes.length - (mode === 'short' ? 1 : 0)
          })
        if (mode !== 'valid') expect(parse).toThrow(OutputProtocolError)
        else {
          const parsed = parse()
          expect(parsed).toEqual(original)
          parsed.transactions[0].txid = 'ff'.repeat(32)
          parsed.genesis.body.genesis.outputIndex = 1
          expect(packet).toEqual(original)
        }
      }
    )
  )
}, 120000)
