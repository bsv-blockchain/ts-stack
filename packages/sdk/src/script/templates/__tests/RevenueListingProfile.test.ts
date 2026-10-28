import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { sha256 } from '../../../primitives/Hash.js'
import { toArray, toHex } from '../../../primitives/utils.js'
import { outputPacketDigest } from '../../../overlay-tools/OutputProtocol.js'
import {
  RevenueListingProfile,
  REVENUE_LISTING_ACTIVATION_PROGRAM_BYTES,
  REVENUE_LISTING_ACTIVATION_PROGRAM_SHA256,
  REVENUE_LISTING_ACTIVATION_SCRIPT_BYTES,
  REVENUE_LISTING_ACTIVE_PROGRAM_BYTES,
  REVENUE_LISTING_ACTIVE_PROGRAM_SHA256,
  REVENUE_LISTING_ACTIVE_SCRIPT_BYTES,
  parseRevenueListingProfileDescriptor,
  parseRevenueListingProfileSchedule,
  encodeRevenueListingMetadata,
  encodeRevenueListingProfileSchedule,
  decodeRevenueListingProfileSchedule,
  type RevenueListingProfileDescriptor
} from '../RevenueListingProfile.js'
import { revenueListingChildPublicKey } from '../RevenueListingKeys.js'

const fixture: {
  descriptor: RevenueListingProfileDescriptor
  activation: string
  active: string
} = JSON.parse(
  gunzipSync(readFileSync(resolve(__dirname, 'fixtures/revenue-listing-profile.json.gz'))).toString(
    'utf8'
  )
)
const stageScript = toArray(fixture.activation, 'hex')
const activeScript = toArray(fixture.active, 'hex')
const activationProgram = stageScript.slice(721)
const activeProgram = activeScript.slice(721)
let profile: RevenueListingProfile
beforeAll(() => {
  profile = new RevenueListingProfile(activationProgram, activeProgram)
})

test('matches both unchanged PR295 programs and complete wire-corpus locks byte for byte', () => {
  expect(activationProgram).toHaveLength(REVENUE_LISTING_ACTIVATION_PROGRAM_BYTES)
  expect(activeProgram).toHaveLength(REVENUE_LISTING_ACTIVE_PROGRAM_BYTES)
  expect(stageScript).toHaveLength(REVENUE_LISTING_ACTIVATION_SCRIPT_BYTES)
  expect(activeScript).toHaveLength(REVENUE_LISTING_ACTIVE_SCRIPT_BYTES)
  expect(toHex(sha256(activationProgram))).toBe(REVENUE_LISTING_ACTIVATION_PROGRAM_SHA256)
  expect(toHex(sha256(activeProgram))).toBe(REVENUE_LISTING_ACTIVE_PROGRAM_SHA256)
  expect(profile.lock('activation', fixture.descriptor).toHex()).toBe(fixture.activation)
  expect(profile.lock('active', fixture.descriptor).toHex()).toBe(fixture.active)
  expect(profile.decode(stageScript, fixture.descriptor)).toEqual({
    stage: 'activation',
    descriptor: fixture.descriptor
  })
  expect(profile.decode(Uint8Array.from(activeScript), fixture.descriptor)).toEqual({
    stage: 'active',
    descriptor: fixture.descriptor
  })
  expect(stageScript.slice(3, 720)).toEqual(activeScript.slice(3, 720))
})

test('encodes the complete fixed metadata with independently asserted offsets', () => {
  const metadata = encodeRevenueListingMetadata(fixture.descriptor)
  const view = new DataView(metadata.buffer)
  expect(Array.from(metadata)).toEqual(stageScript.slice(3, 720))
  expect(Array.from(metadata.slice(0, 6))).toEqual([0x52, 0x4f, 0x53, 0x4c, 1, 1])
  expect(toHex(Array.from(metadata.slice(6, 38)))).toBe(
    outputPacketDigest('sale-listing', fixture.descriptor)
  )
  expect(toHex(Array.from(metadata.slice(38, 70)))).toBe(fixture.descriptor.termsDigest)
  expect(view.getBigUint64(70, true)).toBe(1001n)
  expect(view.getBigUint64(78, true)).toBe(1n)
  expect(view.getUint32(86, true)).toBe(123456)
  expect(toHex(Array.from(metadata.slice(90, 123)))).toBe(fixture.descriptor.seller)
  expect(toHex(Array.from(metadata.slice(123, 156)))).toBe(
    revenueListingChildPublicKey(fixture.descriptor.seller)
  )
  expect(Array.from(metadata.slice(156))).toEqual(
    Array.from(encodeRevenueListingProfileSchedule(fixture.descriptor.initialRevenue))
  )
  expect(decodeRevenueListingProfileSchedule(metadata.slice(156))).toEqual(
    fixture.descriptor.initialRevenue
  )
})

test('owns programs, descriptor data and decoded values without invoking array iterators', () => {
  const activation = [...activationProgram],
    active = Uint8Array.from(activeProgram)
  activation[Symbol.iterator] = () => {
    throw new Error('An untrusted iterator must not run')
  }
  const codec = new RevenueListingProfile(activation, active)
  activation.fill(0)
  active.fill(0)
  const descriptor = codec.decode(activeScript, fixture.descriptor).descriptor
  descriptor.initialRevenue.recipients[0].weight = 1
  descriptor.expiryHeight = 1
  expect(codec.lock('active', fixture.descriptor).toHex()).toBe(fixture.active)
  const schedule = decodeRevenueListingProfileSchedule(stageScript.slice(159, 720))
  schedule.recipients[0].weight = 2
  expect(decodeRevenueListingProfileSchedule(stageScript.slice(159, 720))).toEqual(
    fixture.descriptor.initialRevenue
  )
})

test.each([
  { expiryHeight: 0 },
  { expiryHeight: -1 },
  { expiryHeight: 1.5 },
  { expiryHeight: 500000000 },
  { expiryHeight: 4294967296 },
  { purchasePrice: '0' },
  { reserve: '0' },
  { purchasePrice: '2100000000000001' },
  { reserve: '2100000000000001' },
  { version: 2 },
  { seller: '02' + 'ff'.repeat(32) },
  { termsDigest: 'aa' },
  { assetId: 'aa' },
  { metadataDigest: 'aa' },
  { scriptFamily: 'https://example.test/other' },
  { administration: 'none' },
  { initialRevenue: { ...fixture.descriptor.initialRevenue, revision: '0' } },
  { extra: true },
  {
    lineageAnchor: {
      ...fixture.descriptor.lineageAnchor,
      chain: { ...fixture.descriptor.chain, network: 'other' }
    }
  },
  {
    lineageAnchor: {
      ...fixture.descriptor.lineageAnchor,
      chain: { ...fixture.descriptor.chain, genesisHash: 'aa'.repeat(32) }
    }
  }
])('rejects obsolete or malformed descriptor fields %#', change => {
  expect(() => parseRevenueListingProfileDescriptor({ ...fixture.descriptor, ...change })).toThrow()
})

test.each([1, 499999999])('accepts the exact expiry boundary %i', expiryHeight => {
  const descriptor = {
    ...fixture.descriptor,
    expiryHeight,
    purchasePrice: '2100000000000000',
    reserve: '2100000000000000'
  }
  const encoded = profile.lock('activation', descriptor)
  expect(profile.decode(encoded.toBinary(), descriptor).descriptor).toEqual(descriptor)
  expect(parseRevenueListingProfileDescriptor(JSON.stringify(descriptor))).toEqual(descriptor)
})

test.each([
  { recipients: [] },
  { recipients: Array(9).fill(fixture.descriptor.initialRevenue.recipients[0]) },
  { recipients: [...fixture.descriptor.initialRevenue.recipients].reverse() },
  { recipients: Array(2).fill(fixture.descriptor.initialRevenue.recipients[0]) },
  { recipients: [{ ...fixture.descriptor.initialRevenue.recipients[0], weight: 0 }] },
  { recipients: [{ ...fixture.descriptor.initialRevenue.recipients[0], weight: 10001 }] },
  { recipients: [{ ...fixture.descriptor.initialRevenue.recipients[0], weight: 1.5 }] },
  { recipients: fixture.descriptor.initialRevenue.recipients.map(r => ({ ...r, weight: 5001 })) },
  { recipients: [{ identity: '02' + 'ff'.repeat(32), weight: 1 }] },
  { recipients: [{ ...fixture.descriptor.initialRevenue.recipients[0], extra: true }] },
  { revision: '0' }
])('rejects invalid or mutable schedules %#', change => {
  expect(() =>
    parseRevenueListingProfileSchedule({ ...fixture.descriptor.initialRevenue, ...change })
  ).toThrow()
})

test('rejects invalid counts, zero weights, child substitutions and padding at the codec boundary', () => {
  const schedule = fixture.descriptor.initialRevenue
  for (const count of [0, 9, 255]) {
    const bytes = encodeRevenueListingProfileSchedule(schedule)
    bytes[0] = count
    expect(() => decodeRevenueListingProfileSchedule(bytes)).toThrow('count')
  }
  for (const index of [34, 104, 141, 560]) {
    const bytes = encodeRevenueListingProfileSchedule(schedule)
    bytes[index] ^= 1
    expect(() => decodeRevenueListingProfileSchedule(bytes)).toThrow('mismatch')
  }
  const bytes = encodeRevenueListingProfileSchedule(schedule)
  bytes.fill(0, 67, 71)
  expect(() => decodeRevenueListingProfileSchedule(bytes)).toThrow('weight')
})

test.each([0, 1, 2, 3, 6, 9, 41, 73, 81, 89, 93, 126, 159, 720, 721, 5626])(
  'rejects a changed active prefix, descriptor commitment, metadata or program at %i',
  index => {
    const bytes = [...activeScript]
    bytes[index] ^= 1
    expect(() => profile.decode(bytes, fixture.descriptor)).toThrow('mismatch')
  }
)

test('rejects mismatching descriptors even for fields committed only by listingId', () => {
  for (const change of [
    { assetId: 'aa'.repeat(32) },
    { metadataDigest: 'aa'.repeat(32) },
    { lineageAnchor: { ...fixture.descriptor.lineageAnchor, outputIndex: 1 } },
    { expiryHeight: 123457 },
    {
      initialRevenue: {
        recipients: [{ ...fixture.descriptor.initialRevenue.recipients[0], weight: 1 }]
      }
    }
  ])
    expect(() => profile.decode(stageScript, { ...fixture.descriptor, ...change })).toThrow(
      'mismatch'
    )
})

test('rejects incompatible programs, malformed buffers and a missing explicit stage', () => {
  expect(() => new RevenueListingProfile(activationProgram.slice(1), activeProgram)).toThrow(
    'length'
  )
  expect(() => new RevenueListingProfile(activationProgram, activeProgram.slice(1))).toThrow(
    'length'
  )
  expect(() => new RevenueListingProfile(Array(33406).fill(0), activeProgram)).toThrow('program')
  expect(() => new RevenueListingProfile(activationProgram, Array(4906).fill(0))).toThrow('program')
  expect(() => profile.lock(undefined as never, fixture.descriptor)).toThrow('stage')
  for (const input of [null, { length: 5627 }, activeScript.slice(1), [...activeScript, 0]])
    expect(() => profile.decode(input as never, fixture.descriptor)).toThrow()
  for (const value of [-1, 256, 1.5, undefined]) {
    const input = [...activationProgram]
    input[0] = value as never
    expect(() => new RevenueListingProfile(input, activeProgram)).toThrow('byte')
  }
  const accessor = [...activationProgram]
  const read = jest.fn(() => activationProgram[0])
  Object.defineProperty(accessor, '0', { get: read })
  expect(() => new RevenueListingProfile(accessor, activeProgram)).toThrow('indexed')
  expect(read).not.toHaveBeenCalled()
  const sparse = [...activationProgram]
  delete sparse[0]
  expect(() => new RevenueListingProfile(sparse, activeProgram)).toThrow('indexed')
  expect(() => decodeRevenueListingProfileSchedule(new Uint8Array(560))).toThrow('length')
  expect(() => decodeRevenueListingProfileSchedule(null as never)).toThrow('bytes')
})
