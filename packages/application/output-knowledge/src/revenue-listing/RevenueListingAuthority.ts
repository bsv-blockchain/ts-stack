import {
  BigNumber,
  Hash,
  PrivateKey,
  PublicKey,
  TransactionSignature,
  Utils,
  canonicalOutputJSON,
  closedOutputObject,
  outputIdentity,
  outputU32,
  parseOutputOutpoint,
  signOutputPacket,
  verifyOutputPacket
} from '@bsv/sdk'
import {
  parseRevenueListingDescriptor,
  revenueListingId,
  REVENUE_LISTING_SCRIPT_BYTES
} from '@bsv/sdk/script/templates/RevenueListing'
import type { RevenueListingSigningRequest } from '@bsv/sdk/script/templates/RevenueListingSpend'
import { requireLineage, type RevenueListingLineagePackage } from './LineagePackage.js'

type Genesis = RevenueListingLineagePackage['genesis']

/**
 * Historical pre-replacement authority contract retained for compatibility.
 * New installations select RevenueListingProfileAuthority for protected
 * fixed-child signing under the current optional BRC-197 family.
 * Installed local authority, separate from the funding wallet. A hardware or
 * remote implementation must enforce its own authorization/consent policy.
 * Both operations use the same explicitly selected public identity.
 */
export interface RevenueListingAuthorityPort {
  readonly identity: string
  /** Return strict low-S DER followed by the ALL|FORKID byte (41), as lowercase hex. */
  signTransaction(request: RevenueListingSigningRequest): Promise<string>
  /** Return an anyone-verifiable BRC-77 signature of the sale-genesis packet. */
  signGenesis(body: Genesis['body']): Promise<string>
}

function bytes(value: unknown, length: number): number[] {
  requireLineage(Array.isArray(value) && value.length === length, 'Invalid authority bytes')
  return Array.from({ length }, (_, index) => {
    const field = Object.getOwnPropertyDescriptor(value, String(index))
    requireLineage(field?.enumerable && 'value' in field, 'Invalid authority byte field')
    const byte: unknown = field.value
    requireLineage(
      typeof byte === 'number' && Number.isInteger(byte) && byte >= 0 && byte <= 255,
      'Invalid authority byte'
    )
    return byte
  })
}

/** Checks returned signatures against owned requests, including across asynchronous ports. */
export class RevenueListingAuthority {
  readonly #identity: string
  private readonly transactionSigner: RevenueListingAuthorityPort['signTransaction']
  private readonly genesisSigner: RevenueListingAuthorityPort['signGenesis']

  constructor(port: RevenueListingAuthorityPort) {
    this.#identity = outputIdentity(port.identity)
    this.transactionSigner = port.signTransaction.bind(port)
    this.genesisSigner = port.signGenesis.bind(port)
  }

  get identity(): string {
    return this.#identity
  }

  /** Call only after approving a RevenueListingSpend plan and its funded snapshot. */
  async signTransaction(input: RevenueListingSigningRequest): Promise<string> {
    closedOutputObject(input, ['inputIndex', 'identity', 'role', 'data', 'preimage', 'scope'])
    const inputIndex = outputU32(input.inputIndex)
    requireLineage(inputIndex < 2, 'Invalid listing authority input index')
    requireLineage(input.identity === this.identity, 'Listing authority identity mismatch')
    requireLineage(input.role === 'seller' || input.role === 'recipient', 'Invalid authority role')
    requireLineage(input.scope === 65, 'Listing authority requires ALL|FORKID')
    // BIP143 header/tail + CompactSize(40008) + the exact-family locking script.
    const preimage = bytes(input.preimage, REVENUE_LISTING_SCRIPT_BYTES + 159)
    const data = bytes(input.data, 32)
    requireLineage(
      Utils.toHex(preimage.slice(-4)) === '41000000' &&
        Utils.toHex(Hash.sha256(preimage)) === Utils.toHex(data),
      'Listing authority preimage mismatch'
    )
    const signature = await this.transactionSigner({
      inputIndex,
      identity: this.identity,
      role: input.role,
      scope: 65,
      data: [...data],
      preimage: [...preimage]
    })
    requireLineage(
      typeof signature === 'string' &&
        signature.length >= 18 &&
        signature.length <= 144 &&
        signature.length % 2 === 0 &&
        /^[0-9a-f]+$/.test(signature),
      'Invalid authority transaction signature'
    )
    const parsed = TransactionSignature.fromChecksigFormat(Utils.toArray(signature, 'hex'))
    requireLineage(
      parsed.scope === 65 &&
        parsed.hasLowS() &&
        Utils.toHex(parsed.toChecksigFormat()) === signature &&
        parsed.verify(data, PublicKey.fromString(this.identity)),
      'Authority signature does not authorize the retained input'
    )
    return signature
  }

  /** Authorization of a genesis reference; transaction/ancestry validation remains separate. */
  async signGenesis(descriptorInput: unknown, genesisInput: unknown): Promise<Genesis> {
    const descriptor = parseRevenueListingDescriptor(descriptorInput)
    const genesis = parseOutputOutpoint(genesisInput)
    requireLineage(descriptor.seller === this.identity, 'Genesis seller authority mismatch')
    requireLineage(
      genesis.outputIndex === 0 &&
        canonicalOutputJSON(genesis.chain) === canonicalOutputJSON(descriptor.chain),
      'Genesis reference does not match the listing profile'
    )
    const body: Genesis['body'] = { version: 1, listingId: revenueListingId(descriptor), genesis }
    const signature = await this.genesisSigner({
      ...body,
      genesis: { ...genesis, chain: { ...genesis.chain } }
    })
    const packet = { body, signature }
    requireLineage(
      verifyOutputPacket('sale-genesis', packet, this.identity),
      'Genesis authority signature mismatch'
    )
    return packet
  }
}

/**
 * Software reference adapter for an explicitly provisioned, dedicated authority
 * key. Never pass or extract a funding wallet root key. JavaScript memory is not
 * a hardware keystore; production key custody/backup is the caller's concern.
 */
export function createSoftwareRevenueListingAuthority(key: PrivateKey): RevenueListingAuthority {
  requireLineage(key instanceof PrivateKey, 'Expected a dedicated authority private key')
  const owned = new PrivateKey(BigNumber.prototype.toArray.call(key, 'be', 32), 16, 'be', 'error')
  requireLineage(!owned.isZero(), 'Authority private key must be nonzero')
  return new RevenueListingAuthority({
    identity: owned.toPublicKey().toString(),
    signTransaction: request => {
      const raw = owned.sign(request.data)
      return Promise.resolve(
        Utils.toHex(new TransactionSignature(raw.r, raw.s, 65).toChecksigFormat())
      )
    },
    signGenesis: body => Promise.resolve(signOutputPacket('sale-genesis', body, owned).signature)
  })
}
