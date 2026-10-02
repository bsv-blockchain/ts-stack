// Mandala verdicts (spec §6.3). Topic managers throw a MandalaReject; the
// overlay reads `.code` directly to pick HTTP status, retryability and whether
// the refusal is persisted. Every reason string below is a cross-engine
// contract: the Go overlay copies them byte for byte, and the conformance
// vectors pin them.

export type MandalaRejectCode =
  | 'ERR_SHAPE'
  | 'ERR_SATOSHIS'
  | 'ERR_LINKAGE'
  | 'ERR_CONSERVATION'
  | 'ERR_AUTHORITY'
  | 'ERR_UNTRUSTED'
  | 'ERR_PAUSED'
  | 'ERR_FROZEN'
  | 'ERR_ACCESS'
  | 'ERR_SANCTIONED'
  | 'ERR_MEMBERSHIP'
  | 'ERR_UNAVAILABLE'

const CODES: ReadonlySet<string> = new Set<MandalaRejectCode>([
  'ERR_SHAPE',
  'ERR_SATOSHIS',
  'ERR_LINKAGE',
  'ERR_CONSERVATION',
  'ERR_AUTHORITY',
  'ERR_UNTRUSTED',
  'ERR_PAUSED',
  'ERR_FROZEN',
  'ERR_ACCESS',
  'ERR_SANCTIONED',
  'ERR_MEMBERSHIP',
  'ERR_UNAVAILABLE'
])

export class MandalaReject extends Error {
  readonly code: MandalaRejectCode
  readonly reason: string

  constructor(code: MandalaRejectCode, reason: string, options?: { cause?: unknown }) {
    super(reason, options)
    this.name = 'MandalaReject'
    this.code = code
    this.reason = reason
  }
}

/**
 * Structural check, so a reject that crossed a module or realm boundary (two
 * copies of this package, a serialized side channel) is still recognised.
 */
export function isMandalaReject(e: unknown): e is MandalaReject {
  if (typeof e !== 'object' || e === null) return false
  const { name, code, reason } = e as { name?: unknown; code?: unknown; reason?: unknown }
  return (
    name === 'MandalaReject' &&
    typeof code === 'string' &&
    CODES.has(code) &&
    typeof reason === 'string'
  )
}

type Amount = bigint | number

const reject =
  (code: MandalaRejectCode) =>
  (reason: string): MandalaReject =>
    new MandalaReject(code, reason)

const shape = reject('ERR_SHAPE')
const linkage = reject('ERR_LINKAGE')
const authority = reject('ERR_AUTHORITY')
const untrusted = reject('ERR_UNTRUSTED')
// An infra reject keeps the underlying fault as `cause`: the engine logs only what is thrown.
const unavailable = (reason: string, cause?: unknown): MandalaReject =>
  new MandalaReject('ERR_UNAVAILABLE', reason, cause === undefined ? undefined : { cause })
const conservation = reject('ERR_CONSERVATION')
const frozen = reject('ERR_FROZEN')
const access = reject('ERR_ACCESS')

/**
 * The reason catalog: `throw Reasons.oneSat(2)`. `op` is `<txid>.<vout>`, `id` a
 * token id, `k` an identity key.
 */
export const Reasons = {
  invalidTokenOutput: (i: number, detail: string) =>
    shape(`output ${i}: token-shaped output is not a valid BRC-162 token output (${detail})`),
  nonP2pkhRemainder: (i: number) =>
    shape(`output ${i}: token output remainder must be a P2PKH lock`),
  oneSat: (i: number) =>
    new MandalaReject('ERR_SATOSHIS', `output ${i}: token output must carry exactly 1 satoshi`),
  amountCap: (i: number) => shape(`output ${i}: token amount exceeds 2^53-1`),
  sumCap: (id: string) => shape(`token ${id}: value sum exceeds 2^53-1`),
  supplyCap: (id: string) => shape(`token ${id}: circulating supply would exceed 2^53-1`),
  noLinkage: (i: number) => linkage(`output ${i}: token output with no verified linkage`),
  inputLinkageControl: (i: number) =>
    linkage(`input ${i}: linkage does not control the coin being spent`),
  inputLinkageOwner: (i: number, named: string, owner: string) =>
    linkage(`input ${i}: linkage names ${named} but the coin is owned by ${owner}`),
  ownerIndexUnavailable: (op: string) => unavailable(`owner index unavailable for ${op}`),
  storeUnavailable: (what: string, cause?: unknown) =>
    unavailable(`${what} could not be read; retry`, cause),
  storeWriteUnavailable: (what: string, cause?: unknown) =>
    unavailable(`${what} could not be written; retry`, cause),
  untrustedOwner: (i: number, k: string) =>
    untrusted(`output ${i}: owner ${k} is not a trusted issuer`),
  untrustedProver: (i: number, k: string) =>
    untrusted(`output ${i}: linkage prover ${k} is not a trusted issuer`),
  untrustedAuthorityInput: (i: number, k: string) =>
    untrusted(`input ${i}: authority owner ${k} is not a trusted issuer`),
  fixedSupply: () => authority('output 0: fixed-supply deploys are not allowed'),
  deploySig: () => authority('output 0: deploy requires a valid deploySig over this txid'),
  deployNotAtZero: (i: number) => shape(`output ${i}: a deploy must be output 0`),
  authorityWithoutInput: (i: number, id: string) =>
    authority(`output ${i}: authority output without an admitted authority input of token ${id}`),
  continuity: (id: string) => authority(`token ${id}: spends an authority but creates none`),
  twoCommitments: (id: string) =>
    authority(`token ${id}: more than one authority output carries an action commitment`),
  commitmentMismatch: (i: number) =>
    authority(`output ${i}: admin details do not match the payload commitment`),
  missingDetails: (i: number) =>
    shape(`output ${i}: committed authority output has no admin details`),
  orphanDetails: (i: number) =>
    shape(`admin entry ${i} does not name a committed authority output`),
  detailsSchema: (i: number, detail: string) =>
    shape(`output ${i}: admin details violate the schema (${detail})`),
  deployPayload: (detail: string) =>
    shape(`output 0: deploy payload is not a valid Mandala deploy map (${detail})`),
  envelope: (detail: string) => shape(`Mandala payload ${detail}`),
  holderConservation: (id: string, vin: Amount, vout: Amount) =>
    conservation(`token ${id}: value in ${vin} != value out ${vout} without an authority`),
  deltaRule: (id: string, kind: string, rule: string, delta: Amount) =>
    conservation(`token ${id}: ${kind} requires delta ${rule} but delta is ${delta}`),
  reissue: (id: string, detail: string) => shape(`token ${id}: reissue ${detail}`),
  frozenInput: (i: number, op: string) => frozen(`input ${i}: coin ${op} is frozen`),
  evictedInput: (i: number, op: string) =>
    frozen(`input ${i}: coin ${op} was evicted by a reissue`),
  paused: (id: string) => new MandalaReject('ERR_PAUSED', `token ${id} is paused`),
  blocked: (id: string, k: string) => access(`token ${id}: ${k} is blocked (denylist)`),
  notAllowed: (id: string, k: string) => access(`token ${id}: ${k} is not allowlisted (allowlist)`),
  sanctioned: (k: string) => new MandalaReject('ERR_SANCTIONED', `identity ${k} is sanctioned`),
  notMember: (k: string) =>
    new MandalaReject('ERR_MEMBERSHIP', `identity ${k} is not an admitted registry member`),
  registryExists: () =>
    shape('tm_mandala_registry: registration chain already exists; register is genesis-only'),
  registryValue: (i: number) =>
    shape(`output ${i}: tm_mandala_registry does not admit value outputs`)
}
