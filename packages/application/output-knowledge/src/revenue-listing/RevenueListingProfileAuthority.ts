import {
  Hash,
  PublicKey,
  Random,
  TransactionSignature,
  Utils,
  canonicalOutputJSON,
  closedOutputObject,
  outputAssert,
  outputIdentity,
  outputPacketDigest,
  outputPacketPreimage,
  parseOutputOutpoint,
  verifyOutputPacket,
  type WalletInterface
} from '@bsv/sdk'
import { validateOriginator } from '@bsv/sdk/wallet/validationHelpers'
import {
  parseRevenueListingProfileDescriptor,
  REVENUE_LISTING_ACTIVE_SCRIPT_BYTES,
  REVENUE_LISTING_ACTIVE_PROGRAM_SHA256,
  REVENUE_LISTING_PROFILE_PROGRAM_OFFSET
} from '@bsv/sdk/script/templates/RevenueListingProfile'
import {
  revenueListingChildPublicKey,
  REVENUE_LISTING_AUTHORITY_PROTOCOL,
  REVENUE_LISTING_AUTHORITY_KEY_ID
} from '@bsv/sdk/script/templates/RevenueListingKeys'
import type { RevenueListingProfileSigningRequest } from '@bsv/sdk/script/templates/RevenueListingProfileSpend'
import type { RevenueListingProfileLineagePackage } from './ProfileLineagePackage.js'

type Genesis = RevenueListingProfileLineagePackage['genesis']
type ProtectedWallet = Pick<WalletInterface, 'getPublicKey' | 'createSignature'>

export interface RevenueListingProfileAuthorityOptions {
  wallet: ProtectedWallet
  /** Independently selected seller identity, never a private scalar. */
  identity: string
  /** Installed application originator passed through every BRC-100 call. */
  originator: string
  /** Synchronous installed authorization/currentness fence, checked around each await. */
  checkCurrent(): void
}

function bytes(value: unknown, length: number): number[] {
  outputAssert(Array.isArray(value) && value.length === length, 'Invalid profile authority bytes')
  return Array.from({ length }, (_, index) => {
    const field = Object.getOwnPropertyDescriptor(value, String(index))
    outputAssert(field?.enumerable && 'value' in field, 'Invalid profile authority byte field')
    const byte: unknown = field.value
    outputAssert(
      typeof byte === 'number' && Number.isInteger(byte) && byte >= 0 && byte <= 255,
      'Invalid profile authority byte'
    )
    return byte
  })
}

function signatureBytes(value: unknown): number[] {
  outputAssert(
    Array.isArray(value) && value.length >= 8 && value.length <= 72,
    'Invalid protected DER signature length'
  )
  return bytes(value, value.length)
}

/**
 * Explicitly selected current-family protected wallet adapter. This verifies
 * key selection and returned signatures; the caller must independently approve
 * the plan, funded transaction, economic outputs, lineage and signing role.
 * Neither installation nor signing allocates funds or establishes chain authority.
 */
export class RevenueListingProfileAuthority {
  readonly #identity: string
  private readonly publicKey: ProtectedWallet['getPublicKey']
  private readonly signature: ProtectedWallet['createSignature']
  private readonly check: RevenueListingProfileAuthorityOptions['checkCurrent']
  private readonly originator: string

  private constructor(options: RevenueListingProfileAuthorityOptions) {
    this.#identity = outputIdentity(options.identity)
    const originator = validateOriginator(options.originator)
    outputAssert(originator !== undefined, 'Profile authority requires an explicit originator')
    this.originator = originator
    this.publicKey = options.wallet.getPublicKey.bind(options.wallet)
    this.signature = options.wallet.createSignature.bind(options.wallet)
    this.check = options.checkCurrent.bind(options)
  }

  get identity(): string {
    return this.#identity
  }

  private current(): void {
    outputAssert(this.check() === undefined, 'Profile signing fence must be synchronous')
  }

  /** Explicitly check identity, own fixed child and actual protected signing before listing funding. */
  static async create(
    options: RevenueListingProfileAuthorityOptions
  ): Promise<RevenueListingProfileAuthority> {
    const authority = new RevenueListingProfileAuthority(options)
    await authority.keys()
    // Explicit protected signing preflight, not a transaction or a funding effect.
    // A fresh domain-separated challenge proves actual fixed-child DER support.
    const data = Hash.sha256([
      ...Utils.toArray('BRC-197/fixed-child-preflight/1\0', 'utf8'),
      ...Utils.toArray(authority.identity, 'hex'),
      ...bytes(Random(32), 32)
    ])
    await authority.childSignature(data)
    return authority
  }

  private async keys(): Promise<void> {
    this.current()
    const root = await this.publicKey({ identityKey: true }, this.originator)
    this.current()
    outputAssert(root.publicKey === this.identity, 'Protected listing identity changed')
    const child = await this.publicKey(
      {
        protocolID: [...REVENUE_LISTING_AUTHORITY_PROTOCOL],
        keyID: REVENUE_LISTING_AUTHORITY_KEY_ID,
        counterparty: 'anyone',
        forSelf: true
      },
      this.originator
    )
    this.current()
    outputAssert(
      child.publicKey === revenueListingChildPublicKey(this.identity),
      'Protected wallet does not provide the fixed listing child'
    )
  }

  /** Sign only an independently approved seller split or early-retirement request. */
  async signTransaction(input: RevenueListingProfileSigningRequest): Promise<string> {
    closedOutputObject(input, [
      'inputIndex',
      'identity',
      'publicKey',
      'role',
      'protocolID',
      'keyID',
      'counterparty',
      'data',
      'preimage',
      'scope'
    ])
    outputAssert(
      input.inputIndex === 0 &&
        input.identity === this.identity &&
        input.publicKey === revenueListingChildPublicKey(this.identity) &&
        input.role === 'seller' &&
        input.scope === 65 &&
        canonicalOutputJSON(input.protocolID) ===
          canonicalOutputJSON(REVENUE_LISTING_AUTHORITY_PROTOCOL) &&
        input.keyID === REVENUE_LISTING_AUTHORITY_KEY_ID &&
        input.counterparty === 'anyone',
      'Profile authority selection differs from the fixed seller child'
    )
    const preimage = bytes(input.preimage, REVENUE_LISTING_ACTIVE_SCRIPT_BYTES + 159),
      data = bytes(input.data, 32),
      script = preimage.slice(107, 107 + REVENUE_LISTING_ACTIVE_SCRIPT_BYTES)
    outputAssert(
      Utils.toHex(preimage.slice(104, 107)) ===
        Utils.toHex(
          new Utils.Writer().writeVarIntNum(REVENUE_LISTING_ACTIVE_SCRIPT_BYTES).toArray()
        ) &&
        Utils.toHex(Hash.sha256(script.slice(REVENUE_LISTING_PROFILE_PROGRAM_OFFSET))) ===
          REVENUE_LISTING_ACTIVE_PROGRAM_SHA256 &&
        Utils.toHex(preimage.slice(-4)) === '41000000' &&
        Utils.toHex(Hash.sha256(preimage)) === Utils.toHex(data),
      'Profile authority preimage does not match the active family'
    )
    await this.keys()
    return this.childSignature(data)
  }

  private async childSignature(data: number[]): Promise<string> {
    this.current()
    const result = await this.signature(
      {
        protocolID: [...REVENUE_LISTING_AUTHORITY_PROTOCOL],
        keyID: REVENUE_LISTING_AUTHORITY_KEY_ID,
        counterparty: 'anyone',
        data: [...data]
      },
      this.originator
    )
    this.current()
    const der = signatureBytes(result.signature)
    const signature = TransactionSignature.fromChecksigFormat([...der, 65])
    outputAssert(
      signature.scope === 65 &&
        signature.hasLowS() &&
        Utils.toHex(signature.toChecksigFormat()) === Utils.toHex([...der, 65]) &&
        signature.verify(data, PublicKey.fromString(revenueListingChildPublicKey(this.identity))),
      'Protected signature does not authorize the retained funded input'
    )
    return Utils.toHex(signature.toChecksigFormat())
  }

  /** BRC-77 message-signing child authorizes a reserve-stage genesis reference. */
  async signGenesis(descriptorInput: unknown, genesisInput: unknown): Promise<Genesis> {
    const descriptor = parseRevenueListingProfileDescriptor(descriptorInput),
      genesis = parseOutputOutpoint(genesisInput)
    outputAssert(
      descriptor.seller === this.identity &&
        genesis.outputIndex === 0 &&
        canonicalOutputJSON(genesis.chain) === canonicalOutputJSON(descriptor.chain),
      'Profile genesis differs from the selected seller or chain'
    )
    const body: Genesis['body'] = {
      version: 1,
      listingId: outputPacketDigest('sale-listing', descriptor),
      genesis
    }
    await this.keys()
    const key = bytes(Random(32), 32)
    this.current()
    const result = await this.signature(
      {
        protocolID: [2, 'message signing'],
        keyID: Utils.toBase64(key),
        counterparty: 'anyone',
        data: outputPacketPreimage('sale-genesis', body)
      },
      this.originator
    )
    this.current()
    const der = signatureBytes(result.signature)
    const packet = {
      body,
      signature: Utils.toBase64([
        ...Utils.toArray('42423301', 'hex'),
        ...Utils.toArray(this.identity, 'hex'),
        0,
        ...key,
        ...der
      ])
    }
    outputAssert(
      verifyOutputPacket('sale-genesis', packet, this.identity),
      'Protected genesis signature differs from the retained packet'
    )
    return packet
  }
}
