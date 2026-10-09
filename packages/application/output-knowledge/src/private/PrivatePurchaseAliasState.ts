import {
  createClosedOutputObjectValidator,
  outputAssert,
  outputHex32,
  ownOutputJSONWithInlineRecords as ownOutputJSON,
  type OutputJSONObject
} from '@bsv/sdk'

/** Local custody metadata, never a Bitcoin/domain validation result. Exact raw
 * candidates and admission outcomes belong to separately reserved native slots.
 * Historical formats and exact-txid Bitcoin facts are not reinterpreted. */
export interface PrivatePurchaseAliasEntry {
  txid: string
  /** Digest of complete raw transaction bytes. Same-txid proof augmentation
   * belongs to the native payload owner and must not change this identity. */
  candidateDigest: string
  operationId: string
  admission: 'retained' | 'pending' | 'admitted' | 'rejected'
}
export interface PrivatePurchaseAliasState {
  format: 'private-purchase-aliases/1'
  acquisitionId: string
  requestDigest: string
  owner: string
  purchaseCommitment: string | null
  /** Independently prepaid roles; sharing is an optimization, never required. */
  original: PrivatePurchaseAliasEntry | null
  historical: PrivatePurchaseAliasEntry | null
  selected: PrivatePurchaseAliasEntry | null
  unconfirmed: (PrivatePurchaseAliasEntry | null)[]
  /** Exact external jobs displaced by a new selected-chain alias. */
  pending: (PrivatePurchaseAliasEntry | null)[]
}
export interface PrivatePurchaseAliasPlacement {
  /** Produced only by an installed full selected-chain verifier. Saved state
   * never implies that the placement is still current on a later call. */
  checkCurrent(): void
}
export type PrivatePurchaseAliasRetention =
  | { status: 'retained'; state: PrivatePurchaseAliasState; role: string }
  | { status: 'pending'; reason: 'external-operations-unresolved' | 'cache-operations-unresolved' }

const FORMAT = 'private-purchase-aliases/1'
type ClosedFields = (value: unknown) => asserts value is Record<string, unknown>
const entryFields: ClosedFields = createClosedOutputObjectValidator([
  'txid',
  'candidateDigest',
  'operationId',
  'admission'
])
const stateFields: ClosedFields = createClosedOutputObjectValidator([
  'format',
  'acquisitionId',
  'requestDigest',
  'owner',
  'purchaseCommitment',
  'original',
  'historical',
  'selected',
  'unconfirmed',
  'pending'
])
const retainedFields: ClosedFields = createClosedOutputObjectValidator([
  'purchaseCommitment',
  'entry'
])
function entry(input: unknown): PrivatePurchaseAliasEntry | null {
  if (input === null) return null
  entryFields(input)
  outputAssert(
    input.admission === 'retained' ||
      input.admission === 'pending' ||
      input.admission === 'admitted' ||
      input.admission === 'rejected',
    'Invalid purchase alias admission state'
  )
  return {
    txid: outputHex32(input.txid),
    candidateDigest: outputHex32(input.candidateDigest),
    operationId: outputHex32(input.operationId),
    admission: input.admission
  }
}
export function parsePrivatePurchaseAliasState(input: unknown): PrivatePurchaseAliasState {
  const value = ownOutputJSON(input, { bytes: 16384 }).value
  stateFields(value)
  outputAssert(value.format === FORMAT, 'Unsupported purchase alias custody', 'unsupported')
  outputAssert(
    Array.isArray(value.unconfirmed) &&
      value.unconfirmed.length >= 1 &&
      value.unconfirmed.length <= 4,
    'Invalid unconfirmed alias capacity'
  )
  outputAssert(
    Array.isArray(value.pending) && value.pending.length >= 1 && value.pending.length <= 2,
    'Invalid external alias capacity'
  )
  const result: PrivatePurchaseAliasState = {
    format: FORMAT,
    acquisitionId: outputHex32(value.acquisitionId),
    requestDigest: outputHex32(value.requestDigest),
    owner: outputHex32(value.owner),
    purchaseCommitment:
      value.purchaseCommitment === null ? null : outputHex32(value.purchaseCommitment),
    original: entry(value.original),
    historical: entry(value.historical),
    selected: entry(value.selected),
    unconfirmed: value.unconfirmed.map(entry),
    pending: value.pending.map(entry)
  }
  const entries = [
    result.original,
    result.historical,
    result.selected,
    ...result.unconfirmed,
    ...result.pending
  ].filter((x): x is PrivatePurchaseAliasEntry => x !== null)
  outputAssert(
    (result.purchaseCommitment === null) === (result.original === null),
    'Purchase alias commitment lacks its original candidate'
  )
  outputAssert(
    result.original !== null || entries.length === 0,
    'Purchase alias custody lacks its original candidate'
  )
  outputAssert(
    result.historical === null || result.historical.admission === 'admitted',
    'Historical release requires actual exact-txid admission'
  )
  const seen = new Map<string, PrivatePurchaseAliasEntry>()
  for (const item of entries) {
    const prior = seen.get(item.txid)
    outputAssert(
      !prior ||
        (prior.candidateDigest === item.candidateDigest &&
          prior.operationId === item.operationId &&
          prior.admission === item.admission),
      'Repeated purchase alias changes its retained identity'
    )
    seen.set(item.txid, item)
  }
  return result
}
export function createPrivatePurchaseAliasState(
  acquisitionId: string,
  requestDigest: string,
  owner: string,
  maximumUnconfirmed: number,
  maximumPending = 2
): PrivatePurchaseAliasState {
  outputAssert(
    Number.isSafeInteger(maximumUnconfirmed) && maximumUnconfirmed >= 1 && maximumUnconfirmed <= 4,
    'Invalid unconfirmed alias capacity'
  )
  outputAssert(
    Number.isSafeInteger(maximumPending) && maximumPending >= 1 && maximumPending <= 2,
    'Invalid external alias capacity'
  )
  return parsePrivatePurchaseAliasState({
    format: FORMAT,
    acquisitionId,
    requestDigest,
    owner,
    purchaseCommitment: null,
    original: null,
    historical: null,
    selected: null,
    unconfirmed: Array.from({ length: maximumUnconfirmed }, () => null),
    pending: Array.from({ length: maximumPending }, () => null)
  })
}
function guarded(placement: PrivatePurchaseAliasPlacement): void {
  const check: unknown = Object.getOwnPropertyDescriptor(placement, 'checkCurrent')?.value
  outputAssert(
    typeof check === 'function' && check.constructor.name !== 'AsyncFunction',
    'Purchase alias placement needs a synchronous installed guard'
  )
  const result: unknown = check.call(placement)
  if (result instanceof Promise) void result.catch(() => undefined)
  outputAssert(
    result === undefined &&
      Object.getOwnPropertyDescriptor(placement, 'checkCurrent')?.value === check,
    'Purchase alias placement guard changed',
    'context-changed'
  )
}
function keepSelectedJob(
  state: PrivatePurchaseAliasState,
  candidate: PrivatePurchaseAliasEntry
): boolean {
  const selected = state.selected
  if (selected?.admission !== 'pending' || selected.txid === candidate.txid) return true
  if (
    [state.original, state.historical, ...state.unconfirmed, ...state.pending].some(
      x => x?.txid === selected.txid
    )
  )
    return true
  let index = state.pending.indexOf(null)
  if (index < 0) index = state.pending.findIndex(x => x?.admission !== 'pending')
  if (index < 0) return false
  state.pending[index] = { ...selected }
  return true
}
function retainExistingAlias(
  state: PrivatePurchaseAliasState,
  existing: [string, PrivatePurchaseAliasEntry | null],
  placement: PrivatePurchaseAliasPlacement | undefined
): PrivatePurchaseAliasRetention {
  if (placement) {
    state.selected = { ...existing[1]! }
    return { status: 'retained', state: parsePrivatePurchaseAliasState(state), role: 'selected' }
  }
  if (existing[0] !== 'original' && existing[0] !== 'historical')
    return { status: 'retained', state, role: existing[0] }
  // Mutable cumulative proof custody is separate from the first financial
  // candidate and first signed-release payload. Never overwrite either.
  let index = state.unconfirmed.indexOf(null)
  if (index < 0) index = state.unconfirmed.findIndex(x => x?.admission !== 'pending')
  if (index < 0) return { status: 'pending', reason: 'cache-operations-unresolved' }
  state.unconfirmed[index] = { ...existing[1]! }
  return {
    status: 'retained',
    state: parsePrivatePurchaseAliasState(state),
    role: `unconfirmed/${index}`
  }
}
/** Pure native-write proposal. Independently verify every input, receipt,
 * lineage and the full commitment before calling; check that validation again
 * in the transaction committing metadata AND complete raw candidate slots.
 * Placement cannot come from a request boolean, remembered tip or cache entry. */
export function retainPrivatePurchaseAlias(
  input: PrivatePurchaseAliasState,
  verified: { purchaseCommitment: string; entry: PrivatePurchaseAliasEntry },
  placement?: PrivatePurchaseAliasPlacement
): PrivatePurchaseAliasRetention {
  const state = parsePrivatePurchaseAliasState(input),
    owned = ownOutputJSON(verified, { bytes: 2048 }).value
  retainedFields(owned)
  const purchaseCommitment = outputHex32(owned.purchaseCommitment),
    candidate = entry(owned.entry)
  outputAssert(candidate !== null, 'Purchase alias candidate is required')
  outputAssert(candidate.admission === 'retained', 'New alias cannot assert admission')
  outputAssert(
    state.purchaseCommitment === null || state.purchaseCommitment === purchaseCommitment,
    'Purchase alias changes the original full commitment',
    'conflict'
  )
  if (placement) guarded(placement)
  const roleEntries: [string, PrivatePurchaseAliasEntry | null][] = [
    ['selected', state.selected],
    ...state.pending.map((x, i): [string, PrivatePurchaseAliasEntry | null] => [`pending/${i}`, x]),
    ...state.unconfirmed.map((x, i): [string, PrivatePurchaseAliasEntry | null] => [
      `unconfirmed/${i}`,
      x
    ]),
    ['original', state.original],
    ['historical', state.historical]
  ]
  const existing = roleEntries.find(([, x]) => x?.txid === candidate.txid)
  if (existing)
    outputAssert(
      existing[1]!.candidateDigest === candidate.candidateDigest &&
        existing[1]!.operationId === candidate.operationId,
      'Purchase alias changes its complete retained raw transaction',
      'conflict'
    )

  if (placement && !keepSelectedJob(state, candidate))
    return { status: 'pending', reason: 'external-operations-unresolved' }
  if (existing) return retainExistingAlias(state, existing, placement)
  if (state.original === null) {
    state.purchaseCommitment = purchaseCommitment
    state.original = candidate
    if (placement) state.selected = { ...candidate }
    return { status: 'retained', state, role: 'original' }
  }
  if (placement) {
    state.selected = candidate
    return { status: 'retained', state, role: 'selected' }
  }
  // A selected-chain candidate has an independent slot above. Cache eviction
  // can never discard an unresolved external operation. Original/historical/
  // selected roles already have separately reserved complete raw custody.
  let index = state.unconfirmed.indexOf(null)
  if (index < 0) index = state.unconfirmed.findIndex(x => x?.admission !== 'pending')
  if (index < 0) return { status: 'pending', reason: 'cache-operations-unresolved' }
  state.unconfirmed[index] = candidate
  return { status: 'retained', state, role: `unconfirmed/${index}` }
}
export function advancePrivatePurchaseAliasAdmission(
  input: PrivatePurchaseAliasState,
  txid: string,
  status: PrivatePurchaseAliasEntry['admission']
): PrivatePurchaseAliasState {
  const state = parsePrivatePurchaseAliasState(input),
    id = outputHex32(txid)
  const selected = [
    state.original,
    state.historical,
    state.selected,
    ...state.unconfirmed,
    ...state.pending
  ].find(x => x?.txid === id)
  outputAssert(
    selected !== undefined && selected !== null,
    'Purchase alias is not retained',
    'unavailable'
  )
  const prior = selected.admission
  outputAssert(
    prior === status ||
      (prior === 'retained' && status === 'pending') ||
      (prior === 'pending' && (status === 'admitted' || status === 'rejected')),
    'Invalid purchase alias admission transition',
    'conflict'
  )
  for (const item of [
    state.original,
    state.historical,
    state.selected,
    ...state.unconfirmed,
    ...state.pending
  ])
    if (item?.txid === id) item.admission = status
  return parsePrivatePurchaseAliasState(state)
}
/** Copy the exact admitted candidate into its prepaid immutable historical
 * role atomically with first signed-result custody. No key/licence is issued by
 * this proposal and later placement changes cannot rewrite that result. */
export function releasePrivatePurchaseAlias(
  input: PrivatePurchaseAliasState,
  txid: string,
  placement?: PrivatePurchaseAliasPlacement
): PrivatePurchaseAliasState {
  const state = parsePrivatePurchaseAliasState(input),
    id = outputHex32(txid)
  if (state.historical) {
    outputAssert(state.historical.txid === id, 'First purchase release is immutable', 'conflict')
    return state
  }
  const candidate = [state.original, state.selected, ...state.unconfirmed, ...state.pending].find(
    x => x?.txid === id
  )
  outputAssert(
    candidate?.admission === 'admitted',
    'Release needs exact admitted alias',
    'unavailable'
  )
  if (placement) {
    guarded(placement)
    outputAssert(state.selected?.txid === id, 'Mined release needs the selected exact alias')
  }
  state.historical = { ...candidate }
  return parsePrivatePurchaseAliasState(state)
}
export function privatePurchaseAliasValue(state: PrivatePurchaseAliasState): OutputJSONObject {
  return parsePrivatePurchaseAliasState(state) as unknown as OutputJSONObject
}
