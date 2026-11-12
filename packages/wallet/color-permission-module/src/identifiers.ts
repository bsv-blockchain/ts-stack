import { PublicKey, type WalletProtocol } from '@bsv/sdk'
import Random from '@bsv/sdk/primitives/Random'
import { toArray, toHex } from '@bsv/sdk/primitives/utils'

/** Asset selector for a deploy output's key derivation before its asset ID exists. */
export const ISSUE = 'ISSUE'

/** Fixed BRC-43 key ID for every `p color` key. */
export const COLOR_KEY_ID = 'color'

/** `listOutputs` selector for the inventory across every per-asset basket. */
export const ASSETS_SELECTOR = 'p color assets'

/** Basket namespace of the per-asset value and authority baskets. */
export const COLOR_BASKET_NAMESPACE = 'p color'

/**
 * Output tag of a token whose overlay acceptance is still pending: a receipt a required profile's
 * `admitReceipt` credited as `pending`, or the token change of a plain-noSend hand-over. Views hide
 * it once the host calls `markSettled` for the output's transaction.
 */
export const COLOR_OFFLINE_TAG = 'color_offline'

export type TokenRole = 'value' | 'authority'

const ASSET_ID = /^([0-9a-f]{64})_(0|[1-9]\d{0,9})$/
const ASSET_TAG = /^([0-9a-f]{64})v(0|[1-9]\d{0,9})$/
const OUTPOINT = /^([0-9a-f]{64})\.(0|[1-9]\d{0,9})$/
const HEX_TAG = /^(?:[0-9a-f]{2})+$/
const IDENTITY_KEY = /^0[23][0-9a-f]{64}$/
const WHITESPACE = /\s/u
const UINT32_MAX = 0xffffffff
const MAX_PROTOCOL_NAME_LENGTH = 280
// Stryker disable next-line StringLiteral: TextDecoder('') throws ERR_ENCODING_NOT_SUPPORTED at module load, so the mutant can only be a RuntimeError, never a behavior change a test could observe
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

export interface Outpoint {
  txid: string
  vout: number
}

function uint32(text: string): number | undefined {
  const value = Number(text)
  return value <= UINT32_MAX ? value : undefined
}

/** Parses a canonical BRC-162 API asset ID, `<64 hex>_<vout>`. */
export function parseAssetId(assetId: unknown): Outpoint {
  const match = typeof assetId === 'string' ? ASSET_ID.exec(assetId) : null
  const vout = match == null ? undefined : uint32(match[2])
  if (match == null || vout === undefined) throw new Error('BRC-207: invalid asset ID')
  return { txid: match[1], vout }
}

/** Parses an asset ID, or `ISSUE` where a deploy output's key is meant. */
export function parseAssetSelector(assetId: unknown): string {
  if (assetId === ISSUE) return ISSUE
  parseAssetId(assetId)
  return assetId as string
}

/** Parses a canonical BRC-36 dot-form outpoint. */
export function parseOutpoint(outpoint: unknown): Outpoint {
  const match = typeof outpoint === 'string' ? OUTPOINT.exec(outpoint) : null
  const vout = match == null ? undefined : uint32(match[2])
  if (match == null || vout === undefined) throw new Error('BRC-207: invalid outpoint')
  return { txid: match[1], vout }
}

export function outpointString(txid: string, vout: number): string {
  return `${txid}.${vout}`
}

/** The wire tag for an asset ID or `ISSUE` in protocol IDs and basket names. */
export function assetTag(assetId: string): string {
  if (assetId === ISSUE) return 'issue'
  const { txid, vout } = parseAssetId(assetId)
  return `${txid}v${vout}`
}

function assetIdFromTag(tag: string): string {
  if (tag === 'issue') return ISSUE
  const match = ASSET_TAG.exec(tag)
  const vout = match == null ? undefined : uint32(match[2])
  if (match == null || vout === undefined) throw new Error('BRC-207: invalid asset tag')
  return `${match[1]}_${vout}`
}

/** Validates a remittance string: nonempty strict UTF-8 without whitespace. */
export function validateRemittanceString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0 || WHITESPACE.test(value)) {
    throw new Error(`BRC-207: ${name} must be a nonempty string without whitespace`)
  }
  // Lone surrogates are not strict UTF-8; encoding replaces them, so the round trip differs.
  if (UTF8_DECODER.decode(new TextEncoder().encode(value)) !== value) {
    throw new Error(`BRC-207: ${name} must be strict UTF-8`)
  }
  return value
}

/** Validates a compressed secp256k1 public key in lowercase hex. */
export function validateIdentityKey(value: unknown, name: string): string {
  if (typeof value !== 'string' || !IDENTITY_KEY.test(value)) {
    throw new Error(`BRC-207: ${name} must be a compressed public key in lowercase hex`)
  }
  try {
    PublicKey.fromString(value)
  } catch (error) {
    throw new Error(`BRC-207: ${name} is not a valid public key (${(error as Error).message})`)
  }
  return value
}

/** The BRC-43 protocol ID `[2, "p color <assetTag> <prefixTag> <suffixTag>"]`. */
export function colorProtocolID(
  assetId: string,
  derivationPrefix: string,
  derivationSuffix: string
): WalletProtocol {
  const prefixTag = toHex(
    toArray(validateRemittanceString(derivationPrefix, 'derivationPrefix'), 'utf8')
  )
  const suffixTag = toHex(
    toArray(validateRemittanceString(derivationSuffix, 'derivationSuffix'), 'utf8')
  )
  const name = `p color ${assetTag(assetId)} ${prefixTag} ${suffixTag}`
  if (name.length > MAX_PROTOCOL_NAME_LENGTH)
    throw new Error('BRC-207: protocol name exceeds 280 characters')
  return [2, name]
}

/** Parses a `p color` protocol ID back into its asset selector and remittance strings. */
export function parseColorProtocolID(protocolID: unknown): {
  assetId: string
  derivationPrefix: string
  derivationSuffix: string
} {
  if (!Array.isArray(protocolID) || protocolID.length !== 2 || protocolID[0] !== 2) {
    throw new Error('BRC-207: p color protocols use security level 2')
  }
  const name = protocolID[1]
  const parts = typeof name === 'string' ? name.split(' ') : []
  if (
    parts.length !== 5 ||
    parts[0] !== 'p' ||
    parts[1] !== 'color' ||
    name.length > MAX_PROTOCOL_NAME_LENGTH
  ) {
    throw new Error('BRC-207: invalid p color protocol name')
  }
  const [, , tag, prefixTag, suffixTag] = parts
  if (!HEX_TAG.test(prefixTag) || !HEX_TAG.test(suffixTag)) {
    throw new Error('BRC-207: invalid p color remittance tags')
  }
  const derivationPrefix = validateRemittanceString(
    UTF8_DECODER.decode(new Uint8Array(toArray(prefixTag, 'hex'))),
    'derivationPrefix'
  )
  const derivationSuffix = validateRemittanceString(
    UTF8_DECODER.decode(new Uint8Array(toArray(suffixTag, 'hex'))),
    'derivationSuffix'
  )
  return { assetId: assetIdFromTag(tag), derivationPrefix, derivationSuffix }
}

/** The per-asset value or authority basket; there is no `issue` basket. */
export function assetBasket(assetId: string, role: TokenRole): string {
  parseAssetId(assetId)
  const basket = `${COLOR_BASKET_NAMESPACE} ${assetTag(assetId)}`
  return role === 'authority' ? `${basket} authority` : basket
}

function parseTaggedBasket(rest: string[]): { assetId: string; role: TokenRole } | undefined {
  if (rest.length === 0 || rest.length > 2 || (rest.length === 2 && rest[1] !== 'authority'))
    return undefined
  const assetId = assetIdFromTag(rest[0])
  if (assetId === ISSUE) throw new Error('BRC-207: issue is not a stored basket')
  return { assetId, role: rest.length === 2 ? 'authority' : 'value' }
}

/** Parses a per-asset value (`p color <assetTag>`) or authority (`... authority`) basket. */
export function parseAssetBasket(basket: string): { assetId: string; role: TokenRole } | undefined {
  const parts = basket.split(' ')
  if (parts[0] !== 'p' || parts[1] !== 'color' || parts[2] === 'balance' || parts[2] === 'assets')
    return undefined
  return parseTaggedBasket(parts.slice(2))
}

/** Parses a balance selector, `p color balance <assetTag>` or `... authority`. */
export function parseBalanceSelector(
  basket: string
): { assetId: string; role: TokenRole } | undefined {
  const parts = basket.split(' ')
  if (parts[0] !== 'p' || parts[1] !== 'color' || parts[2] !== 'balance') return undefined
  return parseTaggedBasket(parts.slice(3))
}

/** The shared deployment discovery topic. */
export const DISCOVERY_TOPIC = 'tm_color'

/** Prefix of the output tag. */
const OUTPUT_TAG_PREFIX = `${COLOR_BASKET_NAMESPACE} output `

const OUTPUT_TAG = /^p color output [0-9a-f]{64}$/

/**
 * Legacy tag, read only and never filed. Outputs filed before 0.3.0 carry `p color ` and the
 * lowercase hex of the SHA-256 of the UTF-8 bytes of the custody's derivation suffix. A suffix may
 * be reused across outputs, so that tag could be shared by many outputs and the source lookup
 * returned all of them. Such rows are still read.
 */
const LEGACY_SUFFIX_TAG = /^p color [0-9a-f]{64}$/

/**
 * A new output tag: `p color output ` and 32 random bytes as lowercase hex, drawn for each output
 * the module files. The module lists an output's transaction by it.
 */
export function newOutputTag(): string {
  return `${OUTPUT_TAG_PREFIX}${toHex(Random(32))}`
}

/** Whether a tag is an output tag. */
export function isOutputTag(tag: string): boolean {
  return OUTPUT_TAG.test(tag)
}

/** Whether a tag is the legacy derivation suffix tag of an output filed before 0.3.0. */
export function isLegacySuffixTag(tag: string): boolean {
  return LEGACY_SUFFIX_TAG.test(tag)
}

/** Whether a tag is the module's own index tag, in either form. */
export function isModuleOutputTag(tag: string): boolean {
  return isOutputTag(tag) || isLegacySuffixTag(tag)
}

/**
 * The tag a stored row is listed by: its output tag, or, for a row filed before 0.3.0 that has
 * none, its legacy derivation suffix tag. Undefined when it carries neither.
 */
export function outputTagIn(tags: readonly string[] | undefined): string | undefined {
  return tags?.find(isOutputTag) ?? tags?.find(isLegacySuffixTag)
}

export function colorTopic(assetId: string): string {
  return `tm_color_${assetId}`
}
