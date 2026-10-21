import LockingScript from '../LockingScript.js'
import { sha256 } from '../../primitives/Hash.js'
import { toArray, toHex } from '../../primitives/utils.js'
import { outputPacketDigest, outputU64 } from '../../overlay-tools/OutputProtocol.js'
import { outputAssert } from '../../overlay-tools/OutputProtocolError.js'
import {
  array,
  chain,
  hex,
  identity,
  literal,
  normalized,
  object,
  outpoint,
  u32,
  u64
} from '../../overlay-tools/OutputProtocolSchema.js'
import { REVENUE_LISTING_FAMILY, revenueListingChildPublicKey } from './RevenueListingKeys.js'

/** Literal PR295 profile: stage identity comes from the complete executable. */
export const REVENUE_LISTING_METADATA_BYTES = 717
export const REVENUE_LISTING_PROFILE_PROGRAM_OFFSET = 721
export const REVENUE_LISTING_ACTIVATION_PROGRAM_BYTES = 33406
export const REVENUE_LISTING_ACTIVATION_PROGRAM_SHA256 =
  '5152517f75ac4159aa5d34211f45ce12cd85386a8d1414169886b0d64dac1dea'
export const REVENUE_LISTING_ACTIVE_PROGRAM_BYTES = 4906
export const REVENUE_LISTING_ACTIVE_PROGRAM_SHA256 =
  '5aff350548d3b420bf1a47b48b38af34bb5ecf28be5c797921c4e2a2cddd8dea'
export const REVENUE_LISTING_ACTIVATION_SCRIPT_BYTES = 34127
export const REVENUE_LISTING_ACTIVE_SCRIPT_BYTES = 5627

const scheduleBytes = 561
const maximumSatoshis = 2100000000000000n
const scheduleSchema = object({ recipients: array(object({ identity, weight: u32 }), 8, 1) })
const descriptorSchema = object({
  version: literal(1),
  chain,
  assetId: hex,
  seller: identity,
  lineageAnchor: outpoint,
  purchasePrice: u64,
  reserve: u64,
  expiryHeight: u32,
  termsDigest: hex,
  scriptFamily: literal(REVENUE_LISTING_FAMILY),
  metadataDigest: hex,
  initialRevenue: scheduleSchema
})

export type RevenueListingProfileSchedule = ReturnType<typeof scheduleSchema>
export type RevenueListingProfileDescriptor = ReturnType<typeof descriptorSchema>
export type RevenueListingStage = 'activation' | 'active'

function validateSchedule(schedule: RevenueListingProfileSchedule): void {
  let previous = '',
    total = 0
  for (const recipient of schedule.recipients) {
    outputAssert(recipient.identity > previous, 'Revenue identities must be sorted and unique')
    outputAssert(recipient.weight > 0 && recipient.weight <= 10000, 'Invalid revenue weight')
    total += recipient.weight
    previous = recipient.identity
    // Reject the profile's degenerate public link before constructing a stage.
    revenueListingChildPublicKey(recipient.identity)
  }
  outputAssert(total <= 10000, 'Revenue quantum exceeds 10000 satoshis')
}

/** The distribution is immutable in this family; there is no revision field. */
export function parseRevenueListingProfileSchedule(input: unknown): RevenueListingProfileSchedule {
  const schedule = normalized(input, scheduleSchema, 4096)
  validateSchedule(schedule)
  return schedule
}

/** Shape, public links and chain binding, not genesis authorization or spend validity. */
export function parseRevenueListingProfileDescriptor(
  input: unknown
): RevenueListingProfileDescriptor {
  const descriptor = normalized(input, descriptorSchema, 16384)
  validateSchedule(descriptor.initialRevenue)
  revenueListingChildPublicKey(descriptor.seller)
  outputAssert(
    descriptor.expiryHeight >= 1 && descriptor.expiryHeight < 500000000,
    'Listing expiry must be a block height from 1 through 499999999'
  )
  outputAssert(
    descriptor.chain.network === descriptor.lineageAnchor.chain.network &&
      descriptor.chain.genesisHash === descriptor.lineageAnchor.chain.genesisHash,
    'Listing anchor belongs to another chain'
  )
  for (const amount of [descriptor.purchasePrice, descriptor.reserve]) {
    const value = outputU64(amount)
    outputAssert(value > 0n && value <= maximumSatoshis, 'Listing amount outside SatoshiValue')
  }
  return descriptor
}

function ownedBytes(input: readonly number[] | Uint8Array, length: number): Uint8Array {
  outputAssert(Array.isArray(input) || input instanceof Uint8Array, 'Expected listing bytes')
  outputAssert(input.length === length, 'Unexpected listing byte length')
  const bytes = new Uint8Array(length)
  for (let index = 0; index < length; index++) {
    const entry = Object.getOwnPropertyDescriptor(input, String(index))
    outputAssert(entry !== undefined && 'value' in entry, 'Expected owned indexed listing byte')
    const value: unknown = entry.value
    outputAssert(
      typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 255,
      'Invalid listing byte'
    )
    bytes[index] = value
  }
  return bytes
}

function encodeSchedule(schedule: RevenueListingProfileSchedule): Uint8Array {
  const bytes = new Uint8Array(scheduleBytes),
    view = new DataView(bytes.buffer)
  bytes[0] = schedule.recipients.length
  schedule.recipients.forEach((recipient, index) => {
    const offset = 1 + index * 70
    bytes.set(toArray(recipient.identity, 'hex'), offset)
    bytes.set(toArray(revenueListingChildPublicKey(recipient.identity), 'hex'), offset + 33)
    view.setUint32(offset + 66, recipient.weight, true)
  })
  return bytes
}

/** Count plus eight root[33]/child[33]/weight[4] slots, including zero padding. */
export function encodeRevenueListingProfileSchedule(input: unknown): Uint8Array {
  return encodeSchedule(parseRevenueListingProfileSchedule(input))
}

/** Re-derives every public child and rejects nonzero unused slots. */
export function decodeRevenueListingProfileSchedule(
  input: readonly number[] | Uint8Array
): RevenueListingProfileSchedule {
  const bytes = ownedBytes(input, scheduleBytes),
    view = new DataView(bytes.buffer)
  const count = bytes[0]
  outputAssert(count >= 1 && count <= 8, 'Invalid revenue recipient count')
  const recipients: RevenueListingProfileSchedule['recipients'] = []
  for (let index = 0; index < count; index++) {
    const offset = 1 + index * 70
    recipients.push({
      identity: toHex(Array.from(bytes.subarray(offset, offset + 33))),
      weight: view.getUint32(offset + 66, true)
    })
  }
  const schedule = parseRevenueListingProfileSchedule({ recipients })
  const expected = encodeSchedule(schedule)
  outputAssert(
    bytes.every((byte, index) => byte === expected[index]),
    'Revenue child link or padding mismatch'
  )
  return schedule
}

function encodeMetadata(descriptor: RevenueListingProfileDescriptor): Uint8Array {
  const bytes = new Uint8Array(REVENUE_LISTING_METADATA_BYTES),
    view = new DataView(bytes.buffer)
  bytes.set([0x52, 0x4f, 0x53, 0x4c, 1, 1])
  bytes.set(toArray(outputPacketDigest('sale-listing', descriptor), 'hex'), 6)
  bytes.set(toArray(descriptor.termsDigest, 'hex'), 38)
  view.setBigUint64(70, outputU64(descriptor.purchasePrice), true)
  view.setBigUint64(78, outputU64(descriptor.reserve), true)
  view.setUint32(86, descriptor.expiryHeight, true)
  bytes.set(toArray(descriptor.seller, 'hex'), 90)
  bytes.set(toArray(revenueListingChildPublicKey(descriptor.seller), 'hex'), 123)
  bytes.set(encodeSchedule(descriptor.initialRevenue), 156)
  return bytes
}

/** Exact shared metadata; descriptor changes create a different listing identity. */
export function encodeRevenueListingMetadata(descriptor: unknown): Uint8Array {
  return encodeMetadata(parseRevenueListingProfileDescriptor(descriptor))
}

/**
 * Portable literal two-stage codec. Programs are supplied, pinned and owned;
 * there is no compiler, filesystem, key authority or network dependency.
 * Recognition does not establish activation, authorized lineage, unspentness,
 * Bitcoin validity, miner acceptance or an entitlement to private fulfillment.
 */
export class RevenueListingProfile {
  private readonly activation: Uint8Array
  private readonly active: Uint8Array

  constructor(
    activationProgram: readonly number[] | Uint8Array,
    activeProgram: readonly number[] | Uint8Array
  ) {
    this.activation = ownedBytes(activationProgram, REVENUE_LISTING_ACTIVATION_PROGRAM_BYTES)
    this.active = ownedBytes(activeProgram, REVENUE_LISTING_ACTIVE_PROGRAM_BYTES)
    outputAssert(
      toHex(sha256(Array.from(this.activation))) === REVENUE_LISTING_ACTIVATION_PROGRAM_SHA256 &&
        toHex(sha256(Array.from(this.active))) === REVENUE_LISTING_ACTIVE_PROGRAM_SHA256,
      'Unrecognized revenue listing profile programs'
    )
  }

  /** Stage choice is explicit: constructing an active lock does not authorize activation. */
  lock(stage: RevenueListingStage, descriptor: unknown): LockingScript {
    outputAssert(stage === 'activation' || stage === 'active', 'Invalid listing stage')
    const metadata = encodeRevenueListingMetadata(descriptor)
    const program = stage === 'activation' ? this.activation : this.active
    const script = new Uint8Array(REVENUE_LISTING_PROFILE_PROGRAM_OFFSET + program.length)
    script.set([0x4d, 0xcd, 0x02])
    script.set(metadata, 3)
    script[720] = 0x75
    script.set(program, REVENUE_LISTING_PROFILE_PROGRAM_OFFSET)
    return LockingScript.fromBinary(Array.from(script))
  }

  /** Compares the complete script with a separately supplied, fully parsed descriptor. */
  decode(
    script: readonly number[] | Uint8Array,
    descriptorInput: unknown
  ): { stage: RevenueListingStage; descriptor: RevenueListingProfileDescriptor } {
    outputAssert(Array.isArray(script) || script instanceof Uint8Array, 'Expected listing bytes')
    outputAssert(
      script.length === REVENUE_LISTING_ACTIVATION_SCRIPT_BYTES ||
        script.length === REVENUE_LISTING_ACTIVE_SCRIPT_BYTES,
      'Unexpected listing byte length'
    )
    const bytes = ownedBytes(script, script.length)
    const stage = bytes.length === REVENUE_LISTING_ACTIVATION_SCRIPT_BYTES ? 'activation' : 'active'
    const descriptor = parseRevenueListingProfileDescriptor(descriptorInput)
    const expected = this.lock(stage, descriptor).toBinary()
    outputAssert(
      bytes.every((byte, index) => byte === expected[index]),
      'Revenue listing profile script or descriptor mismatch'
    )
    return { stage, descriptor }
  }
}
