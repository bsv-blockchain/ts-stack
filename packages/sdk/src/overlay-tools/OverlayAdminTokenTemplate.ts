import PublicKey from '../primitives/PublicKey.js'
import PrivateKey from '../primitives/PrivateKey.js'
import Signature from '../primitives/Signature.js'
import { toArray, toHex, toUTF8Strict } from '../primitives/utils.js'
import LockingScript from '../script/LockingScript.js'
import type ScriptTemplate from '../script/ScriptTemplate.js'
import UnlockingScript from '../script/UnlockingScript.js'
import PushDrop from '../script/templates/PushDrop.js'
import { decodeCanonicalPushDrop } from '../script/templates/PushDropValidation.js'
import { resolveSourceDetails } from '../script/templates/SignatureUtils.js'
import Transaction from '../transaction/Transaction.js'
import { validateWalletResult } from '../wallet/WalletResultValidation.js'
import { utf8ByteLength } from '../primitives/UTF8.js'
import { OVERLAY_LOOKUP_SERVICE_NAME_PATTERN, OVERLAY_TOPIC_NAME_PATTERN } from './OverlayNames.js'
import {
  OriginatorDomainNameStringUnder250Bytes,
  WalletInterface,
  type WalletProtocol
} from '../wallet/Wallet.interfaces.js'

export type OverlayDiscoveryProtocol = 'SHIP' | 'SLAP'

export interface OverlayDiscoveryAdvertisement {
  protocol: OverlayDiscoveryProtocol
  identityKey: string
  domain: string
  topicOrService: string
}

const MAX_DISCOVERY_FIELD_BYTES = 4096
const MAX_DISCOVERY_PAYLOAD_BYTES = 8192
const canonicalNamePattern: Record<OverlayDiscoveryProtocol, RegExp> = {
  SHIP: OVERLAY_TOPIC_NAME_PATTERN,
  SLAP: OVERLAY_LOOKUP_SERVICE_NAME_PATTERN
}
const HTTPS_URI_PREFIXES = [
  'https://',
  'https+bsvauth://',
  'https+bsvauth+smf://',
  'https+bsvauth+scrypt-offchain://',
  'https+rtt://'
] as const
const exactCoordinate = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/

function protocolID(protocol: OverlayDiscoveryProtocol): WalletProtocol {
  return [2, protocol === 'SHIP' ? 'service host interconnect' : 'service lookup availability']
}

function legacyProtocolID(protocol: OverlayDiscoveryProtocol): WalletProtocol {
  return [2, protocol === 'SHIP' ? 'Service Host Interconnect' : 'Service Lookup Availability']
}

function assertProtocol(protocol: unknown): asserts protocol is OverlayDiscoveryProtocol {
  if (protocol !== 'SHIP' && protocol !== 'SLAP') {
    throw new TypeError('Advertisement protocol must be SHIP or SLAP')
  }
}

function canonicalPublicKey(value: unknown, name: string): string {
  if (typeof value !== 'string' || !/^(?:02|03)[0-9a-f]{64}$/.test(value)) {
    throw new Error(`${name} is invalid`)
  }
  const parsed = PublicKey.fromString(value)
  if (parsed.toString() !== value) throw new Error(`${name} is not canonical`)
  return value
}

function parsePositiveMeasurement(value: string): number | undefined {
  const match = /^(\d+(?:\.\d+)?)(?:[a-zA-Z][a-zA-Z0-9/_-]*)?$/.exec(value.trim())
  if (match === null) return undefined
  const parsed = Number(match[1])
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}

function isAllowedPublicHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase()
  if (normalized === 'localhost') return false
  return normalized.split('.').every(label => !label.startsWith('xn--'))
}

function validateCustomHttpsURI(uri: string, prefix: string): boolean {
  try {
    const parsed = new URL(uri.replace(prefix, 'https://'))
    return (
      isAllowedPublicHostname(parsed.hostname) &&
      parsed.username === '' &&
      parsed.password === '' &&
      parsed.hash === '' &&
      parsed.pathname === '/'
    )
  } catch {
    return false
  }
}

function validateWssURI(uri: string): boolean {
  try {
    const parsed = new URL(uri)
    return (
      parsed.protocol === 'wss:' &&
      isAllowedPublicHostname(parsed.hostname) &&
      parsed.username === '' &&
      parsed.password === '' &&
      parsed.hash === ''
    )
  } catch {
    return false
  }
}

function validateJs8URI(uri: string): boolean {
  const queryIndex = uri.indexOf('?')
  if (queryIndex === -1 || uri.slice(0, queryIndex) !== 'js8c+bsvauth+smf:') return false
  const params = new URLSearchParams(uri.substring(queryIndex))
  const names = ['lat', 'long', 'freq', 'radius']
  if (
    [...params.keys()].some(key => !names.includes(key)) ||
    names.some(key => params.getAll(key).length !== 1)
  ) {
    return false
  }
  const latText = params.get('lat')
  const longText = params.get('long')
  const frequency = params.get('freq')
  const radius = params.get('radius')
  if (latText === null || longText === null || frequency === null || radius === null) return false
  if (!exactCoordinate.test(latText) || !exactCoordinate.test(longText)) return false
  const latitude = Number(latText)
  const longitude = Number(longText)
  return (
    Number.isFinite(latitude) &&
    latitude >= -90 &&
    latitude <= 90 &&
    Number.isFinite(longitude) &&
    longitude >= -180 &&
    longitude <= 180 &&
    parsePositiveMeasurement(frequency) !== undefined &&
    parsePositiveMeasurement(radius) !== undefined
  )
}

function canonicalAdvertisementURI(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    utf8ByteLength(value) > MAX_DISCOVERY_FIELD_BYTES ||
    /\p{Cc}/u.test(value)
  ) {
    throw new Error('Discovery advertisement URI is invalid')
  }
  const httpsPrefix = HTTPS_URI_PREFIXES.find(prefix => value.startsWith(prefix))
  const valid =
    (httpsPrefix !== undefined && validateCustomHttpsURI(value, httpsPrefix)) ||
    (value.startsWith('wss://') && validateWssURI(value)) ||
    (value.startsWith('js8c+bsvauth+smf:') && validateJs8URI(value))
  if (!valid) throw new Error('Discovery advertisement URI is invalid')
  return value
}

function decodeAdvertisement(script: LockingScript): {
  advertisement: OverlayDiscoveryAdvertisement
  lockingPublicKey: PublicKey
  fields: number[][]
} {
  const decoded = decodeCanonicalPushDrop(script, {
    fieldCount: 5,
    maximumFieldBytes: MAX_DISCOVERY_FIELD_BYTES,
    maximumPayloadBytes: MAX_DISCOVERY_PAYLOAD_BYTES
  })
  const protocol = toUTF8Strict(decoded.fields[0])
  assertProtocol(protocol)
  const identityKey = canonicalPublicKey(
    toHex(decoded.fields[1]),
    'Discovery advertisement identity key'
  )
  const domain = canonicalAdvertisementURI(toUTF8Strict(decoded.fields[2]))
  const topicOrService = toUTF8Strict(decoded.fields[3])
  if (!canonicalNamePattern[protocol].test(topicOrService)) {
    throw new Error('Discovery advertisement topic or service name is invalid')
  }
  const signature = decoded.fields[4]
  if (signature.length < 8 || signature.length > 80) {
    throw new Error('Discovery advertisement signature is invalid')
  }
  const canonicalSignature = Signature.fromDER(signature).toDER() as number[]
  if (
    canonicalSignature.length !== signature.length ||
    canonicalSignature.some((byte, index) => byte !== signature[index])
  ) {
    throw new Error('Discovery advertisement signature is not canonical')
  }
  return {
    advertisement: { protocol, identityKey, domain, topicOrService },
    lockingPublicKey: decoded.lockingPublicKey,
    fields: decoded.fields
  }
}

/** Decode and authenticate a canonical SHIP or SLAP advertisement. */
export async function decodeAndVerifyOverlayAdvertisement(
  script: LockingScript,
  expectedProtocol?: OverlayDiscoveryProtocol
): Promise<OverlayDiscoveryAdvertisement> {
  const { advertisement, lockingPublicKey, fields } = decodeAdvertisement(script)
  if (expectedProtocol !== undefined) {
    assertProtocol(expectedProtocol)
    if (advertisement.protocol !== expectedProtocol) {
      throw new Error('Discovery advertisement protocol mismatch')
    }
  }
  const invoice = `${protocolID(advertisement.protocol)[0]}-${protocolID(advertisement.protocol)[1]}-1`
  const derivedKey = PublicKey.fromString(advertisement.identityKey).deriveChild(
    new PrivateKey(1),
    invoice
  )
  if (!derivedKey.verify(fields.slice(0, -1).flat(), Signature.fromDER(fields[4]))) {
    throw new Error('Signature is not valid')
  }
  if (derivedKey.toString() !== lockingPublicKey.toString()) {
    throw new Error('Discovery advertisement locking key is not linked to its identity')
  }
  return advertisement
}

/**
 * Script template enabling the creation, unlocking, and decoding of SHIP and SLAP advertisements.
 */
export default class OverlayAdminTokenTemplate implements ScriptTemplate {
  pushDrop: PushDrop

  /**
   * Structurally decodes a canonical SHIP or SLAP advertisement. This method
   * validates the envelope and fields but does not establish their author;
   * security-sensitive consumers must use {@link decodeAndVerify}.
   * @param script Locking script comprising a SHIP or SLAP token to decode
   * @returns Structurally valid but not yet authenticated advertisement data
   */
  static decode(script: LockingScript): OverlayDiscoveryAdvertisement {
    return decodeAdvertisement(script).advertisement
  }

  /**
   * Decodes and cryptographically authenticates a canonical advertisement,
   * including its claimed identity, field signature, and BRC-48 locking key.
   * This proves authorship of the advertised fields, not current UTXO status;
   * the configured discovery trackers remain authoritative for whether the
   * advertisement is active and unspent.
   */
  static async decodeAndVerify(
    script: LockingScript,
    expectedProtocol?: OverlayDiscoveryProtocol
  ): Promise<OverlayDiscoveryAdvertisement> {
    return await decodeAndVerifyOverlayAdvertisement(script, expectedProtocol)
  }

  /**
   * Constructs a new Overlay Admin template instance
   * @param wallet Wallet to use for locking and unlocking
   */
  constructor(wallet: WalletInterface, originator?: OriginatorDomainNameStringUnder250Bytes) {
    this.pushDrop = new PushDrop(wallet, originator)
  }

  /**
   * Creates a new canonical, publicly verifiable advertisement locking script.
   * @param protocol SHIP or SLAP
   * @param domain Advertisable URI where the topic or service is available
   * @param topicOrService Canonical topic or service name to advertise
   * @returns Locking script comprising the advertisement token
   */
  async lock(
    protocol: OverlayDiscoveryProtocol,
    domain: string,
    topicOrService: string
  ): Promise<LockingScript> {
    assertProtocol(protocol)
    const validatedDomain = canonicalAdvertisementURI(domain)
    if (!canonicalNamePattern[protocol].test(topicOrService)) {
      throw new Error('Discovery advertisement topic or service name is invalid')
    }
    const identityRequest = { identityKey: true } as const
    const identityResult = validateWalletResult(
      'getPublicKey',
      await this.pushDrop.wallet.getPublicKey(identityRequest, this.pushDrop.originator),
      identityRequest
    )
    const identityKey = canonicalPublicKey(
      identityResult.publicKey,
      'Discovery advertisement identity key'
    )
    const script = await this.pushDrop.lock(
      [
        toArray(protocol, 'utf8'),
        toArray(identityKey, 'hex'),
        toArray(validatedDomain, 'utf8'),
        toArray(topicOrService, 'utf8')
      ],
      protocolID(protocol),
      '1',
      'anyone',
      true
    )
    const authenticated = await OverlayAdminTokenTemplate.decodeAndVerify(script, protocol)
    if (
      authenticated.identityKey !== identityKey ||
      authenticated.domain !== validatedDomain ||
      authenticated.topicOrService !== topicOrService
    ) {
      throw new Error('Wallet created an advertisement that does not match the requested data')
    }
    return script
  }

  /**
   * Unlocks a canonical advertisement or an advertisement created by the
   * legacy SDK template. Legacy compatibility is limited to spending: legacy
   * advertisements were not publicly verifiable and remain ineligible for
   * authenticated discovery.
   * @param protocol SHIP or SLAP, depending on the token to unlock
   * @returns Script unlocker capable of unlocking the advertisement token
   */
  unlock(protocol: OverlayDiscoveryProtocol): {
    sign: (tx: Transaction, inputIndex: number) => Promise<UnlockingScript>
    estimateLength: (tx: Transaction, inputIndex: number) => Promise<number>
  } {
    assertProtocol(protocol)
    return {
      sign: async (tx: Transaction, inputIndex: number): Promise<UnlockingScript> => {
        const source = resolveSourceDetails(tx, inputIndex)
        const sourceScript = source.lockingScript as LockingScript
        const lockingPublicKey = decodeCanonicalPushDrop(sourceScript, {
          fieldCount: 5,
          maximumFieldBytes: MAX_DISCOVERY_FIELD_BYTES,
          maximumPayloadBytes: MAX_DISCOVERY_PAYLOAD_BYTES
        }).lockingPublicKey.toString()
        let canonical = false
        try {
          await OverlayAdminTokenTemplate.decodeAndVerify(sourceScript, protocol)
          canonical = true
        } catch {
          // Legacy SDK outputs used title-case protocols and self derivation.
        }
        const selectedProtocol = canonical ? protocolID(protocol) : legacyProtocolID(protocol)
        const counterparty = canonical ? 'anyone' : 'self'
        const keyRequest = {
          protocolID: selectedProtocol,
          keyID: '1',
          counterparty,
          ...(canonical ? { forSelf: true as const } : {})
        }
        const keyResult = validateWalletResult(
          'getPublicKey',
          await this.pushDrop.wallet.getPublicKey(keyRequest, this.pushDrop.originator),
          keyRequest
        )
        if (
          canonicalPublicKey(keyResult.publicKey, 'Advertisement spending key') !== lockingPublicKey
        ) {
          throw new Error('Advertisement is not locked to this wallet and protocol')
        }
        return await this.pushDrop
          .unlock(
            selectedProtocol,
            '1',
            counterparty,
            'all',
            false,
            source.sourceSatoshis,
            sourceScript
          )
          .sign(tx, inputIndex)
      },
      estimateLength: async () => 73
    }
  }
}
