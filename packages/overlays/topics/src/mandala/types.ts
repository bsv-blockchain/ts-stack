// Mandala wire contract v3 (spec §6.1) and the persisted record shapes (§6.6),
// shared by the package, the TS overlay (P2) and the Go overlay (P3).
import { Reasons } from './reject.js'

export interface SpecificLinkage {
  prover: string
  verifier: string
  counterparty: string
  protocolID: [0 | 1 | 2, string]
  keyID: string
  encryptedLinkage: number[]
  encryptedLinkageProof: number[]
  proofType: number
}

/** Off-chain values envelope (UTF-8 JSON). `admin[].details` and `deploySig` are lowercase hex. */
export interface MandalaEnvelope {
  inputs: Array<{ index: number; linkage: SpecificLinkage }>
  outputs: Array<{ index: number; linkage: SpecificLinkage }>
  admin: Array<{ index: number; details: string }>
  deploySig?: string
}

// ---- §6.6 persisted records ----

/** `mandalaOwners`: append-only owner journal, never purged. */
export interface MandalaOwnerRecord {
  txid: string
  outputIndex: number
  topic: string
  tokenId: string
  role: 'deploy' | 'authority' | 'value'
  amount: number
  identityKey: string
  createdAt: Date
}

/** `mandalaTokens`: the value-output index. */
export interface MandalaTokenRecord {
  txid: string
  outputIndex: number
  tokenId: string
  amount: number
  identityKey: string
  createdAt: Date
}

/** `mandalaAuthorities`: unspent authority outputs, deleted when spent or evicted. */
export interface MandalaAuthorityRecord {
  txid: string
  outputIndex: number
  topic: string
  tokenId: string
  identityKey: string
  createdAt: Date
}

/** `mandalaMetadata`: the decoded deploy payload. */
export interface MandalaMetadataRecord {
  tokenId: string
  txid: string
  outputIndex: 0
  sym: string
  dec: number
  label: string
  feeRatePerKb: number | null
}

/** `mandalaAdminHistory`: one row per committed admin action. */
export interface AdminHistoryEntry {
  tokenId: string
  txid: string
  outputIndex: number
  kind: string
  detailsHex: string
  commitment: string
  delta: number
  height: number
  offset: number
  admitSeq: number
  createdAt: Date
  /** freezeOutput rows: the frozen coin's amount and owner the action was folded with. */
  frozenAmount?: number
  frozenOwner?: string
}

export interface MandalaLinkageRecord {
  txid: string
  outputIndex: number
  identityKey: string
  linkage: SpecificLinkage
  createdAt: Date
}

// ---- providers ----

export interface ScreeningProvider {
  isSanctioned: (identityKey: string) => Promise<boolean>
}

export class InMemoryScreeningProvider implements ScreeningProvider {
  private readonly banned: ReadonlySet<string>

  constructor(keys: readonly string[] = []) {
    this.banned = new Set(keys.map(key => key.toLowerCase()))
  }

  isSanctioned(identityKey: string): Promise<boolean> {
    return Promise.resolve(this.banned.has(identityKey.toLowerCase()))
  }
}

export interface MembershipProvider {
  isActive: () => Promise<boolean>
  isAdmitted: (identityKey: string) => Promise<boolean>
}

/** Read access to the engine's own admitted-output store (owner-index repair, reconciler). */
export interface EngineOutputReader {
  /**
   * The output as the engine admitted it on `topic`, or null when the engine holds no such
   * unspent output. A spent output must read as null: the reconciler relies on it to take back a
   * row it repaired for a coin spent meanwhile.
   */
  findAdmittedOutput: (
    txid: string,
    outputIndex: number,
    topic: string
  ) => Promise<{ lockingScript: number[]; satoshis: number } | null>
  listUnspentAdmittedOutputs: (
    topic: string,
    after: { txid: string; outputIndex: number } | null,
    limit: number
  ) => Promise<Array<{ txid: string; outputIndex: number }>>
}

// ---- envelope codec ----

const LOWERCASE_HEX = /^([0-9a-f]{2})+$/
const utf8Encoder = new TextEncoder()
// fatal: invalid UTF-8 is refused, never replaced. ignoreBOM: a leading BOM
// stays in the text, so JSON.parse refuses it (as Go's encoding/json does).
// The default label is UTF-8.
const utf8Decoder = new TextDecoder(undefined, { fatal: true, ignoreBOM: true })

type EnvelopeList = 'inputs' | 'outputs' | 'admin'

export function encodeEnvelope(e: MandalaEnvelope): number[] {
  return Array.from(utf8Encoder.encode(JSON.stringify(e)))
}

const isLowercaseHex = (value: unknown): value is string =>
  typeof value === 'string' && LOWERCASE_HEX.test(value)

const parseJson = (bytes: number[]): unknown => {
  try {
    return JSON.parse(utf8Decoder.decode(Uint8Array.from(bytes)))
  } catch {
    throw Reasons.envelope('must be UTF-8 JSON')
  }
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isIndex = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0

// A list may be absent; when present it must be an array of entries with
// unique, non-negative, safe-integer indices.
function readList(payload: Record<string, unknown>, label: EnvelopeList): unknown[] {
  const entries = payload[label]
  if (entries === undefined) return []
  if (!Array.isArray(entries)) throw Reasons.envelope(`${label} must be an array`)
  const seen = new Set<number>()
  for (const entry of entries) {
    const index: unknown = isObject(entry) ? entry.index : undefined
    if (!isIndex(index) || seen.has(index)) {
      throw Reasons.envelope(`${label} must contain unique non-negative integer indices`)
    }
    seen.add(index)
  }
  return entries
}

/** Absent or empty off-chain values are an empty envelope; anything malformed is `ERR_SHAPE`. */
export function decodeEnvelope(bytes: number[] | undefined): MandalaEnvelope {
  if (bytes === undefined || bytes.length === 0) return { inputs: [], outputs: [], admin: [] }
  const payload = parseJson(bytes)
  if (!isObject(payload)) throw Reasons.envelope('must be an object')
  const inputs = readList(payload, 'inputs') as MandalaEnvelope['inputs']
  const outputs = readList(payload, 'outputs') as MandalaEnvelope['outputs']
  const admin = readList(payload, 'admin') as MandalaEnvelope['admin']
  if (!admin.every(entry => isLowercaseHex(entry.details))) {
    throw Reasons.envelope('admin details must be lowercase hex')
  }
  const { deploySig } = payload
  if (deploySig === undefined) return { inputs, outputs, admin }
  if (!isLowercaseHex(deploySig)) throw Reasons.envelope('deploySig must be lowercase hex')
  return { inputs, outputs, admin, deploySig }
}
