import type { LockingScript } from '@bsv/sdk'
import {
  Bsv21Token,
  isTokenShaped,
  OneColor,
  readOneColorAttributes,
  StrictCborLink,
  tryDecodeStrictCbor
} from '@bsv/templates'
import type {
  Bsv21Envelope,
  Bsv21TokenDecoded,
  OneColorAttributes,
  StrictCborMap,
  StrictCborValue
} from '@bsv/templates'
import { ProfileParamsError } from './errors.js'
import { parseAssetId, type Outpoint, type TokenRole } from './identifiers.js'

export interface TokenOutput {
  assetId: string
  role: TokenRole
  amount: bigint
  /** True for the asset's deploy output, whose key uses the `ISSUE` selector. */
  deploy: boolean
  /** BRC-162 binary, or BRC-161 JSON, which this module reads but never holds or creates. */
  encoding: 'brc162' | 'brc161'
  /** Set when the remainder after the prefix is exactly P2PKH. */
  pubKeyHash?: number[]
  /** A JSON output's operation; a `mint` is funded by an authority input, not by value inputs. */
  jsonOperation?: JsonOperation
  /**
   * The BRC-162 payload attributes, set by `readProfiledTokenOutput` for every BRC-162 output
   * (`payload: 'absent'` when the output has no payload push). Never set by `readTokenOutput`.
   */
  attributes?: OneColorAttributes
}

/**
 * Reads one BRC-162 output: undefined for a script without the token layout, a throw for an
 * invalid or (for this reader) unsupported one. `readTokenOutput` is the 0.1.0 reader;
 * `readProfiledTokenOutput` is the profile-aware one.
 */
export type TokenReader = (
  lockingScript: LockingScript,
  outpoint: Outpoint
) => TokenOutput | undefined

/** The BRC-161 operations this module reads: value outputs, and the authority outputs. */
export type JsonOperation = 'transfer' | 'mint' | 'deploy+mint' | 'auth' | 'deploy+auth'

const PROFILE_ID = /^[a-z][a-z0-9+.-]*:[\x21-\x7e]+$/

/** A decoded DAG-CBOR map, as opposed to an array, bytes, a link or a scalar. */
function isCborMap(value: StrictCborValue | undefined): value is StrictCborMap {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    !(value instanceof Uint8Array) &&
    !(value instanceof StrictCborLink)
  )
}

/** Reads `req` and `ext` from a payload; an absent, opaque or non-map payload has none. */
function readPayloadMaps(payload: number[] | undefined): {
  req?: StrictCborMap
  ext?: StrictCborMap
} {
  if (payload === undefined || payload.length === 0) return {}
  // Strict DAG-CBOR, as BRC-162 requires (L144); anything else is an opaque payload.
  const decoded = tryDecodeStrictCbor(payload)
  if (decoded === undefined) return {}
  const req = decoded.req
  const ext = decoded.ext
  if (req !== undefined && !isCborMap(req))
    throw new Error('BRC-207: malformed req in a BRC-162 payload')
  if (ext !== undefined && !isCborMap(ext))
    throw new Error('BRC-207: malformed ext in a BRC-162 payload')
  for (const profile of [...Object.keys(req ?? {}), ...Object.keys(ext ?? {})]) {
    if (profile.length > 200 || !PROFILE_ID.test(profile)) {
      throw new Error('BRC-207: invalid processing-profile identifier in a BRC-162 payload')
    }
  }
  return { req, ext }
}

/**
 * A valid BRC-162 output of an asset that requires processing profiles. BRC-207 has an
 * unsupported profile fail, never fall back, so readers that otherwise treat an unreadable
 * script as plain satoshis let this error through.
 */
export class UnsupportedProfileError extends Error {
  constructor(
    message = 'BRC-207: the asset requires processing profiles this wallet does not support'
  ) {
    super(message)
    this.name = 'UnsupportedProfileError'
  }
}

/**
 * Fails unless a payload declares no required processing profiles. This module supports
 * none, so a deploy `req` with entries, or a later output repeating a nonempty `req`, fails.
 */
export function assertNoRequiredProfiles(payload: number[] | undefined): void {
  const { req } = readPayloadMaps(payload)
  if (req !== undefined && Object.keys(req).length > 0) throw new UnsupportedProfileError()
}

/**
 * Reads a BRC-162 token output. Returns undefined for a script without the token
 * layout; throws for a token-shaped script that is invalid or unsupported here.
 */
export function readTokenOutput(
  lockingScript: LockingScript,
  outpoint: Outpoint
): TokenOutput | undefined {
  if (!isTokenShaped(lockingScript)) return undefined
  const decoded = decodeOneColor(lockingScript, outpoint)
  assertNoRequiredProfiles(decoded.payload)
  return tokenFromDecoded(decoded, outpoint)
}

/** Decodes a token-shaped script, wrapping a decoder failure in the module's message. */
function decodeOneColor(
  lockingScript: LockingScript,
  outpoint: Outpoint
): ReturnType<typeof OneColor.decode> {
  try {
    return OneColor.decode(lockingScript)
  } catch (error) {
    throw new Error(
      `BRC-207: ${outpoint.txid}.${outpoint.vout} is not a supported BRC-162 output (${(error as Error).message})`
    )
  }
}

function tokenFromDecoded(
  decoded: ReturnType<typeof OneColor.decode>,
  outpoint: Outpoint
): TokenOutput {
  const deploy = decoded.role === 'deploy'
  if (deploy && outpoint.vout !== 0) throw new Error('BRC-207: a BRC-162 deploy must be output 0')
  return {
    assetId: deploy ? `${outpoint.txid}_0` : OneColor.tokenIdToString(decoded.tokenId!),
    role: decoded.amount === 0n ? 'authority' : 'value',
    amount: decoded.amount,
    deploy,
    encoding: 'brc162',
    pubKeyHash: decoded.restPubKeyHash
  }
}

/**
 * The profile-aware BRC-162 reader. Like `readTokenOutput`, but it accepts outputs that declare
 * required processing profiles and returns their payload attributes, leaving the support check
 * to `resolveRequirements`. A valid payload map with a malformed `req` or `ext` fails
 * (0207:88-91) rather than reading as absent.
 */
export function readProfiledTokenOutput(
  lockingScript: LockingScript,
  outpoint: Outpoint
): TokenOutput | undefined {
  if (!isTokenShaped(lockingScript)) return undefined
  const decoded = decodeOneColor(lockingScript, outpoint)
  const attributes = readOneColorAttributes(decoded.payload)
  assertWellFormedProfileMaps(attributes)
  return { ...tokenFromDecoded(decoded, outpoint), attributes }
}

/** Throws ProfileParamsError for a valid payload map whose `req` or `ext` is malformed. */
export function assertWellFormedProfileMaps(attributes: OneColorAttributes): void {
  if (attributes.payload !== 'map') return
  if (attributes.req.status === 'malformed') {
    throw new ProfileParamsError('BRC-207: malformed required processing profile map')
  }
  if (attributes.ext.status === 'malformed') {
    throw new ProfileParamsError('BRC-207: malformed processing profile extension map')
  }
}

const BSV20_CONTENT_TYPE = 'application/bsv-20'
const MAX_UINT64 = (1n << 64n) - 1n
const VALUE_OPERATIONS = new Set<string>(['transfer', 'mint', 'deploy+mint'])
const JSON_AUTHORITY_OPERATIONS = new Set<string>(['auth', 'deploy+auth'])

/**
 * Reads a BRC-161 JSON token output: a BRC-160 `ord` inscription of type `application/bsv-20`
 * anywhere in the script, located by `Bsv21Token`. Returns undefined for a script without such an
 * inscription. `transfer`, `mint` and `deploy+mint` outputs carry value (BRC-161 L262); `auth` and
 * `deploy+auth` are authority outputs of no value (L191-207); `burn` fails as unsupported, as does
 * a malformed inscription.
 */
export function readJsonTokenOutput(
  lockingScript: LockingScript,
  outpoint: Outpoint
): TokenOutput | undefined {
  const malformed = (reason: string): Error =>
    new Error(
      `BRC-207: ${outpoint.txid}.${outpoint.vout} is a malformed BRC-161 inscription (${reason})`
    )
  let envelope: Bsv21Envelope | undefined
  try {
    envelope = Bsv21Token.envelope(lockingScript)
  } catch (error) {
    throw malformed((error as Error).message)
  }
  if (envelope === undefined || envelope.contentType !== BSV20_CONTENT_TYPE) return undefined
  let decoded: Bsv21TokenDecoded
  try {
    decoded = Bsv21Token.decode(lockingScript)
  } catch (error) {
    throw malformed((error as Error).message)
  }
  const op = decoded.op
  if (op === 'burn')
    throw new Error(`BRC-207: BRC-161 ${op} is an operation this module does not support`)
  const authority = JSON_AUTHORITY_OPERATIONS.has(op)
  if (!authority && !VALUE_OPERATIONS.has(op)) throw malformed('unknown op')
  const jsonOperation = op as JsonOperation
  const amount = BigInt(decoded.amt)
  if (amount > MAX_UINT64) throw malformed('amt is not a uint64')
  if (!authority && amount === 0n) throw malformed('amt must be positive')
  const role: TokenRole = authority ? 'authority' : 'value'
  if (op === 'deploy+mint' || op === 'deploy+auth') {
    return {
      assetId: `${outpoint.txid}_${outpoint.vout}`,
      role,
      amount,
      deploy: true,
      encoding: 'brc161',
      jsonOperation
    }
  }
  try {
    parseAssetId(decoded.id)
  } catch {
    throw malformed('id is not a token ID')
  }
  return { assetId: decoded.id, role, amount, deploy: false, encoding: 'brc161', jsonOperation }
}

/**
 * Reads a token output in either encoding; binary wins when a script parses as both (BRC-162).
 * `read` is the BRC-162 reader (the 0.1.0 `readTokenOutput` by default).
 */
export function readAnyTokenOutput(
  lockingScript: LockingScript,
  outpoint: Outpoint,
  read: TokenReader = readTokenOutput
): TokenOutput | undefined {
  return read(lockingScript, outpoint) ?? readJsonTokenOutput(lockingScript, outpoint)
}

/**
 * True when the script is an asset's deploy: a BRC-162 binary deploy (whose `req` must be
 * empty under the default reader), or a BRC-161 JSON deploy+mint, which carries no processing
 * profiles.
 */
export function isDeployOutput(
  lockingScript: LockingScript,
  outpoint: Outpoint,
  read: TokenReader = readTokenOutput
): boolean {
  return readAnyTokenOutput(lockingScript, outpoint, read)?.deploy === true
}
