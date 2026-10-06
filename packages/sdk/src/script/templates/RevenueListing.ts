import LockingScript from '../LockingScript.js'
import BigNumber from '../../primitives/BigNumber.js'
import Curve from '../../primitives/Curve.js'
import PublicKey from '../../primitives/PublicKey.js'
import { sha256, sha256hmac } from '../../primitives/Hash.js'
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

/** Immutable BRC-197 family. Different executable bytes require a different family. */
export const REVENUE_LISTING_FAMILY = 'https://bsv.brc.dev/tokens/0197#revenue-listing-v1'
/** Fixed transparent BRC-42/BRC-29 child profile. This deliberate key reuse
 * makes no privacy claim; protected signers must never expose a child scalar.
 */
export const REVENUE_LISTING_AUTHORITY_PROTOCOL = Object.freeze([2, '3241645161d8'] as const)
export const REVENUE_LISTING_AUTHORITY_KEY_ID = 'brc197 authority'

/** Public derivation only. With `anyone` (G), the BRC-42 shared point is the
 * identity point itself; the HMAC tweak is public. This calculation
 * establishes neither authorized genesis nor the on-chain activation proof.
 */
export function revenueListingChildPublicKey(rootIdentity: string): string {
  const root = PublicKey.fromString(identity(rootIdentity))
  const invoice = `${REVENUE_LISTING_AUTHORITY_PROTOCOL[0]}-${REVENUE_LISTING_AUTHORITY_PROTOCOL[1]}-${REVENUE_LISTING_AUTHORITY_KEY_ID}`
  const curve = new Curve()
  const tweak = new BigNumber(sha256hmac(root.encode(true), toArray(invoice, 'utf8'))).umod(curve.n)
  const child = root.add(curve.g.mul(tweak))
  outputAssert(
    !child.isInfinity() && !child.getX().eq(root.getX()),
    'Degenerate listing child link'
  )
  return child.encode(true, 'hex') as string
}
export const REVENUE_LISTING_PROGRAM_SHA256 =
  'ae47a6cc9bdc955d6aa73cdc459bbd6bbe493419dcf3ed3fc952a95c8c510716'
export const REVENUE_LISTING_PROGRAM_BYTES = 39580
export const REVENUE_LISTING_SCRIPT_BYTES = 40008
const maximumSatoshis = 2100000000000000n
const stateBytes = 305

const stateSchema = object({
  revision: u64,
  recipients: array(object({ identity, weight: u32 }), 8, 1)
})
const descriptorSchema = object({
  version: literal(1),
  chain,
  assetId: hex,
  seller: identity,
  lineageAnchor: outpoint,
  purchasePrice: u64,
  reserve: u64,
  termsDigest: hex,
  scriptFamily: literal(REVENUE_LISTING_FAMILY),
  administration: literal('none', 'seller-v1'),
  metadataDigest: hex,
  initialRevenue: stateSchema
})

export type RevenueListingState = ReturnType<typeof stateSchema>
export type RevenueListingDescriptor = ReturnType<typeof descriptorSchema>

function validateState(state: RevenueListingState): RevenueListingState {
  let previous = '',
    total = 0
  for (const recipient of state.recipients) {
    // Canonical lowercase fixed-width hex has the same order as the 33 raw bytes.
    outputAssert(recipient.identity > previous, 'Revenue identities must be sorted and unique')
    outputAssert(recipient.weight > 0 && recipient.weight <= 10000, 'Invalid revenue weight')
    previous = recipient.identity
    total += recipient.weight
  }
  outputAssert(total <= 10000, 'Revenue quantum exceeds 10000 satoshis')
  return state
}

/** Owned, bounded schedule; weights are integer payout quanta, never percentages to round. */
export function parseRevenueListingState(input: unknown): RevenueListingState {
  return validateState(normalized(input, stateSchema, 4096))
}

/** Validate descriptor shape and internal chain binding, not seller/genesis authority. */
export function parseRevenueListingDescriptor(input: unknown): RevenueListingDescriptor {
  const descriptor = normalized(input, descriptorSchema, 16384)
  validateState(descriptor.initialRevenue)
  outputAssert(descriptor.initialRevenue.revision === '0', 'Initial revenue revision must be zero')
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

/** The immutable descriptor remains the identity after a unanimously authorized amendment. */
export function revenueListingId(input: unknown): string {
  return outputPacketDigest('sale-listing', parseRevenueListingDescriptor(input))
}

function ownedBytes(input: readonly number[] | Uint8Array, length: number): Uint8Array {
  outputAssert(Array.isArray(input) || input instanceof Uint8Array, 'Expected listing bytes')
  outputAssert(input.length === length, 'Unexpected listing byte length')
  const bytes = new Uint8Array(length)
  for (let index = 0; index < length; index++) {
    const byte = input[index]
    outputAssert(Number.isInteger(byte) && byte >= 0 && byte <= 255, 'Invalid listing byte')
    bytes[index] = byte
  }
  return bytes
}

function stateEncoding(state: RevenueListingState): Uint8Array {
  const bytes = new Uint8Array(stateBytes),
    view = new DataView(bytes.buffer)
  view.setBigUint64(0, outputU64(state.revision), true)
  bytes[8] = state.recipients.length
  state.recipients.forEach((recipient, index) => {
    const offset = 9 + index * 37
    bytes.set(toArray(recipient.identity, 'hex'), offset)
    view.setUint32(offset + 33, recipient.weight, true)
  })
  return bytes
}

/** Exact 305-byte state, including zero-filled unused slots. */
export function encodeRevenueListingState(input: unknown): Uint8Array {
  return stateEncoding(parseRevenueListingState(input))
}

/** Rejects noncanonical padding, counts, keys, weights and revisions. */
export function decodeRevenueListingState(
  input: readonly number[] | Uint8Array
): RevenueListingState {
  const bytes = ownedBytes(input, stateBytes),
    view = new DataView(bytes.buffer)
  const count = bytes[8]
  outputAssert(count >= 1 && count <= 8, 'Invalid revenue recipient count')
  const recipients: RevenueListingState['recipients'] = []
  for (let index = 0; index < count; index++) {
    const offset = 9 + index * 37
    recipients.push({
      identity: toHex(Array.from(bytes.subarray(offset, offset + 33))),
      weight: view.getUint32(offset + 33, true)
    })
  }
  const state = parseRevenueListingState({
    revision: view.getBigUint64(0, true).toString(),
    recipients
  })
  const expected = stateEncoding(state)
  outputAssert(
    bytes.every((byte, index) => byte === expected[index]),
    'Nonzero revenue state padding'
  )
  return state
}

/**
 * Portable exact locking-script codec. Supply the frozen BRC-197 program once;
 * the constructor checks its length and registered digest and takes an owned copy.
 * No compiler, filesystem, network or key authority is implicit in this class.
 * Recognition is not lineage, currentness, spend verification or fulfillment.
 */
export class RevenueListing {
  private readonly program: Uint8Array

  constructor(program: readonly number[] | Uint8Array) {
    this.program = ownedBytes(program, REVENUE_LISTING_PROGRAM_BYTES)
    outputAssert(
      toHex(sha256(Array.from(this.program))) === REVENUE_LISTING_PROGRAM_SHA256,
      'Unrecognized revenue listing program'
    )
  }

  /** Defaults to the initial schedule. A supplied current schedule needs separate lineage proof. */
  lock(descriptor: unknown, currentState?: unknown): LockingScript {
    const parsed = parseRevenueListingDescriptor(descriptor)
    const state =
      currentState === undefined ? parsed.initialRevenue : parseRevenueListingState(currentState)
    return LockingScript.fromBinary(Array.from(this.encode(parsed, state)))
  }

  /** Checks the entire executable and descriptor, rather than trusting an ROSL prefix. */
  decode(script: readonly number[] | Uint8Array, descriptor: unknown): RevenueListingState {
    const bytes = ownedBytes(script, REVENUE_LISTING_SCRIPT_BYTES)
    const parsed = parseRevenueListingDescriptor(descriptor)
    const state = decodeRevenueListingState(bytes.subarray(122, 427))
    const expected = this.encode(parsed, state)
    outputAssert(
      bytes.every((byte, index) => byte === expected[index]),
      'Revenue listing script or descriptor mismatch'
    )
    return state
  }

  private encode(descriptor: RevenueListingDescriptor, state: RevenueListingState): Uint8Array {
    const script = new Uint8Array(REVENUE_LISTING_SCRIPT_BYTES),
      view = new DataView(script.buffer)
    script.set([0x4d, 0xa8, 0x01, 0x52, 0x4f, 0x53, 0x4c, 1])
    script.set(toArray(outputPacketDigest('sale-listing', descriptor), 'hex'), 8)
    script.set(toArray(descriptor.termsDigest, 'hex'), 40)
    view.setBigUint64(72, outputU64(descriptor.purchasePrice), true)
    view.setBigUint64(80, outputU64(descriptor.reserve), true)
    script.set(toArray(descriptor.seller, 'hex'), 88)
    script[121] = descriptor.administration === 'seller-v1' ? 1 : 0
    script.set(stateEncoding(state), 122)
    script[427] = 0x75
    script.set(this.program, 428)
    return script
  }
}
