import type { LockingScript } from '@bsv/sdk'
import { Bsv21Token, isTokenShaped, OneColor } from '@bsv/templates'
import { type Outpoint, type TokenRole } from './identifiers.js'

export interface TokenOutput {
  assetId: string
  role: TokenRole
  amount: bigint
  /** True for the asset's deploy output, whose key uses the `ISSUE` selector. */
  deploy: boolean
  /** Set when the remainder after the prefix is exactly P2PKH. */
  pubKeyHash?: number[]
}

type Cbor =
  | bigint
  | number
  | boolean
  | null
  | string
  | Uint8Array
  | Cbor[]
  | Map<string, Cbor>
  | { cid: Uint8Array }

const MAX_DEPTH = 64
const PROFILE_ID = /^[a-z][a-z0-9+.-]*:[\x21-\x7e]+$/
const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  if (a.length !== b.length) return a.length - b.length
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i]
  return 0
}

/** Strict DAG-CBOR: definite lengths, minimal arguments, sorted unique text keys, tag 42 only, 64-bit floats. */
class DagCborReader {
  private position = 0

  constructor(private readonly bytes: Uint8Array) {}

  read(): Cbor {
    const value = this.item(0)
    if (this.position !== this.bytes.length) throw new Error('trailing bytes')
    return value
  }

  private take(count: number): Uint8Array {
    if (count > this.bytes.length - this.position) throw new Error('truncated')
    const slice = this.bytes.subarray(this.position, this.position + count)
    this.position += count
    return slice
  }

  private argument(info: number): bigint {
    if (info < 24) return BigInt(info)
    const size = { 24: 1, 25: 2, 26: 4, 27: 8 }[info]
    if (size === undefined) throw new Error('indefinite or reserved length')
    let value = 0n
    for (const byte of this.take(size)) value = (value << 8n) | BigInt(byte)
    if (value < (size === 1 ? 24n : 1n << BigInt(4 * size))) throw new Error('non-minimal argument')
    return value
  }

  private length(info: number): number {
    const length = this.argument(info)
    if (length > BigInt(this.bytes.length - this.position)) throw new Error('length exceeds input')
    return Number(length)
  }

  private item(depth: number): Cbor {
    if (depth > MAX_DEPTH) throw new Error('nesting too deep')
    const [initial] = this.take(1)
    const major = initial >> 5
    const info = initial & 31
    switch (major) {
      case 0:
        return this.argument(info)
      case 1:
        return -1n - this.argument(info)
      case 2:
        return this.take(this.length(info)).slice()
      case 3:
        return UTF8.decode(this.take(this.length(info)))
      case 4:
        return Array.from({ length: this.length(info) }, () => this.item(depth + 1))
      case 5:
        return this.map(this.length(info), depth)
      case 6: {
        if (this.argument(info) !== 42n) throw new Error('only tag 42 is allowed')
        const cid = this.item(depth + 1)
        if (!(cid instanceof Uint8Array) || cid[0] !== 0) throw new Error('invalid CID')
        return { cid }
      }
      default:
        return this.simple(info)
    }
  }

  private map(entries: number, depth: number): Map<string, Cbor> {
    const map = new Map<string, Cbor>()
    let previous: Uint8Array | undefined
    for (let i = 0; i < entries; i++) {
      const start = this.position
      const key = this.item(depth + 1)
      if (typeof key !== 'string') throw new Error('map keys must be text')
      const encoded = this.bytes.subarray(start, this.position)
      if (previous !== undefined && compareBytes(previous, encoded) >= 0)
        throw new Error('unsorted or duplicate keys')
      previous = encoded
      map.set(key, this.item(depth + 1))
    }
    return map
  }

  private simple(info: number): Cbor {
    if (info === 20) return false
    if (info === 21) return true
    if (info === 22) return null
    if (info !== 27) throw new Error('unsupported simple value or float width')
    const value = new DataView(this.take(8).slice().buffer).getFloat64(0)
    if (!Number.isFinite(value)) throw new Error('non-finite float')
    return value
  }
}

/** Reads `req` and `ext` from a payload; an absent, opaque or non-map payload has none. */
function readPayloadMaps(payload: number[] | undefined): {
  req?: Map<string, Cbor>
  ext?: Map<string, Cbor>
} {
  if (payload === undefined || payload.length === 0) return {}
  let decoded: Cbor
  try {
    decoded = new DagCborReader(Uint8Array.from(payload)).read()
  } catch {
    return {}
  }
  if (!(decoded instanceof Map)) return {}
  const req = decoded.get('req')
  const ext = decoded.get('ext')
  if (req !== undefined && !(req instanceof Map))
    throw new Error('BRC-207: malformed req in a BRC-162 payload')
  if (ext !== undefined && !(ext instanceof Map))
    throw new Error('BRC-207: malformed ext in a BRC-162 payload')
  for (const profile of [...(req?.keys() ?? []), ...(ext?.keys() ?? [])]) {
    if (profile.length > 200 || !PROFILE_ID.test(profile)) {
      throw new Error('BRC-207: invalid processing-profile identifier in a BRC-162 payload')
    }
  }
  return { req, ext }
}

/**
 * Fails unless a payload declares no required processing profiles. This module supports
 * none, so a deploy `req` with entries, or a later output repeating a nonempty `req`, fails.
 */
export function assertNoRequiredProfiles(payload: number[] | undefined): void {
  const { req } = readPayloadMaps(payload)
  if (req !== undefined && req.size > 0) {
    throw new Error('BRC-207: the asset requires processing profiles this wallet does not support')
  }
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
  let decoded: ReturnType<typeof OneColor.decode>
  try {
    decoded = OneColor.decode(lockingScript)
  } catch (error) {
    throw new Error(
      `BRC-207: ${outpoint.txid}.${outpoint.vout} is not a supported BRC-162 output (${(error as Error).message})`
    )
  }
  assertNoRequiredProfiles(decoded.payload)
  const deploy = decoded.role === 'deploy'
  if (deploy && outpoint.vout !== 0) throw new Error('BRC-207: a BRC-162 deploy must be output 0')
  return {
    assetId: deploy ? `${outpoint.txid}_0` : OneColor.tokenIdToString(decoded.tokenId!),
    role: decoded.amount === 0n ? 'authority' : 'value',
    amount: decoded.amount,
    deploy,
    pubKeyHash: decoded.restPubKeyHash
  }
}

/**
 * True when the script is an asset's deploy: a BRC-162 binary deploy, whose `req` must be
 * empty here, or a BRC-161 JSON deploy+mint, which carries no processing profiles.
 */
export function isDeployOutput(lockingScript: LockingScript, outpoint: Outpoint): boolean {
  const binary = readTokenOutput(lockingScript, outpoint)
  if (binary !== undefined) return binary.deploy
  try {
    return Bsv21Token.decode(lockingScript).isMint
  } catch {
    return false
  }
}
