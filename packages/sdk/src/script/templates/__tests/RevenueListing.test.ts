import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import PrivateKey from '../../../primitives/PrivateKey.js'
import { sha256 } from '../../../primitives/Hash.js'
import { toArray, toHex } from '../../../primitives/utils.js'
import {
  RevenueListing,
  REVENUE_LISTING_PROGRAM_SHA256,
  REVENUE_LISTING_PROGRAM_BYTES,
  REVENUE_LISTING_SCRIPT_BYTES,
  parseRevenueListingDescriptor,
  parseRevenueListingState,
  revenueListingId,
  encodeRevenueListingState,
  decodeRevenueListingState,
  type RevenueListingDescriptor,
  type RevenueListingState
} from '../RevenueListing.js'

const fixture: {
  descriptor: RevenueListingDescriptor
  state: RevenueListingState
  listingId: string
  script: string
} = JSON.parse(readFileSync(resolve(__dirname, 'fixtures/revenue-listing.json'), 'utf8'))
const script = toArray(fixture.script, 'hex')
const program = script.slice(428)
let family: RevenueListing
beforeAll(() => {
  family = new RevenueListing(program)
})

describe('BRC-197 frozen listing codec', () => {
  test('matches the independently frozen genesis script byte for byte', () => {
    expect(REVENUE_LISTING_PROGRAM_BYTES).toBe(39580)
    expect(REVENUE_LISTING_SCRIPT_BYTES).toBe(40008)
    expect(toHex(sha256(program))).toBe(REVENUE_LISTING_PROGRAM_SHA256)
    expect(revenueListingId(fixture.descriptor)).toBe(fixture.listingId)
    expect(family.lock(fixture.descriptor).toHex()).toBe(fixture.script)
    expect(family.lock(fixture.descriptor, fixture.state).toHex()).toBe(fixture.script)
    expect(family.decode(script, fixture.descriptor)).toEqual(fixture.state)
    const encoded = encodeRevenueListingState(fixture.state)
    expect(Array.from(encoded)).toEqual(script.slice(122, 427))
    expect(decodeRevenueListingState(encoded)).toEqual(fixture.state)
    expect(decodeRevenueListingState(Array.from(encoded))).toEqual(fixture.state)
  })

  test('owns program, descriptor and returned state rather than sharing caller buffers', () => {
    const bytes = Uint8Array.from(program),
      codec = new RevenueListing(bytes)
    bytes.fill(0)
    const descriptor = parseRevenueListingDescriptor(fixture.descriptor)
    descriptor.initialRevenue.recipients[0].weight = 1
    expect(codec.lock(fixture.descriptor).toHex()).toBe(fixture.script)
    const state = codec.decode(Uint8Array.from(script), fixture.descriptor)
    state.recipients[0].weight = 2
    expect(codec.decode(script, fixture.descriptor)).toEqual(fixture.state)
  })

  test('copies exact indexed bytes without invoking a caller-provided iterator', () => {
    const bytes = [...program]
    bytes[Symbol.iterator] = () => {
      throw new Error('Caller iterator must not run')
    }
    const codec = new RevenueListing(bytes)
    expect(codec.lock(fixture.descriptor).toHex()).toBe(fixture.script)
  })

  test('preserves large revisions and exact schedule quanta without reducing weights', () => {
    const state = {
      ...fixture.state,
      revision: '18446744073709551615',
      recipients: fixture.state.recipients.map(recipient => ({ ...recipient, weight: 5000 }))
    }
    const encoded = encodeRevenueListingState(state)
    expect(Array.from(encoded.slice(0, 8))).toEqual(Array(8).fill(255))
    expect(decodeRevenueListingState(encoded)).toEqual(state)
    const locked = family.lock(fixture.descriptor, state).toBinary()
    expect(family.decode(locked, fixture.descriptor)).toEqual(state)
    expect(toHex(locked.slice(8, 40))).toBe(fixture.listingId)
    const keys = Array.from({ length: 8 }, (_, i) =>
      new PrivateKey(i + 1).toPublicKey().toString()
    ).sort((left, right) => left.localeCompare(right, 'en'))
    const eight = { revision: '1', recipients: keys.map(identity => ({ identity, weight: 1 })) }
    expect(decodeRevenueListingState(encodeRevenueListingState(eight))).toEqual(eight)
    const one = { revision: '0', recipients: [{ identity: keys[0], weight: 10000 }] }
    expect(decodeRevenueListingState(encodeRevenueListingState(one))).toEqual(one)
  })

  test('supports purchase-only metadata and exact SatoshiValue boundaries', () => {
    const descriptor = {
      ...fixture.descriptor,
      administration: 'none',
      reserve: '2100000000000000',
      purchasePrice: '2100000000000000'
    }
    const encoded = family.lock(descriptor).toBinary()
    expect(encoded[121]).toBe(0)
    expect(family.decode(encoded, descriptor)).toEqual(fixture.state)
    expect(parseRevenueListingDescriptor(JSON.stringify(descriptor))).toEqual(descriptor)
  })

  test.each([0, 1, 2, 3, 4, 5, 6, 7, 8, 40, 72, 80, 88, 121, 427, 428, 40007])(
    'rejects a changed prefix, commitment or executable byte at %i',
    offset => {
      const changed = [...script]
      changed[offset] ^= 1
      expect(() => family.decode(changed, fixture.descriptor)).toThrow()
    }
  )

  test('rejects incompatible executable length and digest before constructing a script', () => {
    for (const bytes of [
      program.slice(1),
      [...program, 0],
      Array.from({ length: 39580 }),
      Array(39580).fill(0),
      { length: 39580 },
      null
    ])
      expect(() => new RevenueListing(bytes as never)).toThrow()
    const malformed = [...program]
    malformed[2] = 256
    expect(() => new RevenueListing(malformed)).toThrow('byte')
    malformed[2] = -1
    expect(() => new RevenueListing(malformed)).toThrow('byte')
    malformed[2] = 1.5
    expect(() => new RevenueListing(malformed)).toThrow('byte')
    for (const bytes of [script.slice(1), [...script, 0]])
      expect(() => family.decode(bytes, fixture.descriptor)).toThrow('length')
  })

  test.each([
    { revision: '01' },
    { revision: '-1' },
    { revision: '18446744073709551616' },
    { recipients: [] },
    { recipients: Array(9).fill(fixture.state.recipients[0]) },
    { recipients: [...fixture.state.recipients].reverse() },
    { recipients: [fixture.state.recipients[0], fixture.state.recipients[0]] },
    { recipients: [{ ...fixture.state.recipients[0], weight: 0 }] },
    { recipients: [{ ...fixture.state.recipients[0], weight: -1 }] },
    { recipients: [{ ...fixture.state.recipients[0], weight: 1.5 }] },
    { recipients: [{ ...fixture.state.recipients[0], weight: 10001 }] },
    { recipients: fixture.state.recipients.map(recipient => ({ ...recipient, weight: 5001 })) },
    { recipients: [{ identity: '02' + 'ff'.repeat(32), weight: 1 }] },
    { recipients: [{ identity: '04' + '00'.repeat(32), weight: 1 }] },
    { recipients: [{ ...fixture.state.recipients[0], extra: true }] },
    { extra: true }
  ])('rejects malformed schedules %#', change => {
    expect(() => parseRevenueListingState({ ...fixture.state, ...change })).toThrow()
  })

  test('rejects unused padding and impossible binary counts or weights', () => {
    for (const count of [0, 9, 255]) {
      const bytes = encodeRevenueListingState(fixture.state)
      bytes[8] = count
      expect(() => decodeRevenueListingState(bytes)).toThrow('count')
    }
    for (const offset of [83, 304]) {
      const bytes = encodeRevenueListingState(fixture.state)
      bytes[offset] = 1
      expect(() => decodeRevenueListingState(bytes)).toThrow('padding')
    }
    const bytes = encodeRevenueListingState(fixture.state)
    bytes.fill(0, 42, 46)
    expect(() => decodeRevenueListingState(bytes)).toThrow('weight')
  })

  test.each([
    { version: 2 },
    { scriptFamily: 'https://example.test/other' },
    { administration: 'seller' },
    { purchasePrice: '0' },
    { reserve: '0' },
    { purchasePrice: '2100000000000001' },
    { reserve: '2100000000000001' },
    { termsDigest: 'ff' },
    { metadataDigest: 'ff' },
    { seller: '02' + 'ff'.repeat(32) },
    { extra: 1 },
    { initialRevenue: { ...fixture.state, revision: '1' } },
    { initialRevenue: { ...fixture.state, recipients: [] } },
    {
      lineageAnchor: {
        ...fixture.descriptor.lineageAnchor,
        chain: { ...fixture.descriptor.chain, network: 'other' }
      }
    },
    {
      lineageAnchor: {
        ...fixture.descriptor.lineageAnchor,
        chain: { ...fixture.descriptor.chain, genesisHash: 'ff'.repeat(32) }
      }
    }
  ])('rejects unregistered or internally inconsistent descriptors %#', change => {
    expect(() => parseRevenueListingDescriptor({ ...fixture.descriptor, ...change })).toThrow()
  })

  test('authenticates descriptor fields that do not appear separately in the script prefix', () => {
    for (const change of [
      { assetId: 'ab'.repeat(32) },
      { metadataDigest: 'ab'.repeat(32) },
      { lineageAnchor: { ...fixture.descriptor.lineageAnchor, outputIndex: 1 } },
      {
        initialRevenue: {
          ...fixture.state,
          recipients: [{ ...fixture.state.recipients[0], weight: 1 }]
        }
      }
    ])
      expect(() => family.decode(script, { ...fixture.descriptor, ...change })).toThrow('mismatch')
  })
})
