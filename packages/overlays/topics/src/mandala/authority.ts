// Layer C of the BRC-162 migration (spec §4.3): Mandala authority policy.
// Deploys must be signed authority genesis, every deploy and authority output
// belongs to (and is revealed by) a trusted issuer, a spent authority must be
// re-created, at most one authority output per token commits to an admin
// action, and the supply delta of each token follows its action's rule.
//
// The steps run in the order below, each over every output or token before the
// next step, so the reason a transaction gets does not depend on which token
// or output carries which defect. Tokens are visited in ledger order: first
// seen among the outputs (ascending), then among the inputs (ascending).
import { toHex } from '@bsv/sdk/primitives/utils'
import { specVerdicts } from '../brc162/ledger.js'
import type { Brc162Output, TokenLedger } from '../brc162/ledger.js'
import type { AssetAdminState } from './AssetStateReducer.js'
import type { MandalaStateStore } from './MandalaStorageManager.js'
import { verifyDeploySig } from './deploySig.js'
import {
  ADMIN_KINDS,
  REGISTRY_KINDS,
  commitmentOf,
  decodeAdminDetails,
  deployMetadata
} from './details.js'
import type { AdminDetails } from './details.js'
import { eachInOrder } from './inOrder.js'
import { MAX_SAFE } from './ownership.js'
import type { VerifiedOwner } from './ownership.js'
import { Reasons } from './reject.js'
import type { MandalaEnvelope } from './types.js'

export interface AuthorityDeps {
  trustedIssuers: ReadonlySet<string>
  store: MandalaStateStore
  /** `tm_mandala_registry`: registry kinds only and no value outputs. */
  registry: boolean
}

export interface CommittedAction {
  tokenId: string
  outputIndex: number
  details: AdminDetails
  detailsHex: string
  commitment: number[]
}

export interface AuthorityResult {
  /** At most one per token, in ledger order. */
  actions: CommittedAction[]
  /** Δ = value out − value in, for every token the transaction touches. */
  deltas: Map<string, bigint>
  /** Tokens with an admitted authority input: the admin transactions of layer D. */
  adminTokens: Set<string>
}

/** Δ ≠ 0 of a token with an authority input and no committed action (spec §3.3). */
const PLAIN_AUTHORITY = 'plain authority'

interface DeltaRule {
  rule: string
  holds: (delta: bigint) => boolean
}

const ZERO: DeltaRule = { rule: '= 0', holds: delta => delta === 0n }
const DELTA_RULES: ReadonlyMap<string, DeltaRule> = new Map([
  ['issue', { rule: '> 0', holds: (delta: bigint) => delta > 0n }],
  ['redeem', { rule: '< 0', holds: (delta: bigint) => delta < 0n }]
])

const lowered = (keys: Iterable<string>): Set<string> =>
  new Set([...keys].map(key => key.toLowerCase()))

/** The token's admin state; a read fault is a retryable ERR_UNAVAILABLE. */
export async function readAssetState(
  store: MandalaStateStore,
  tokenId: string
): Promise<AssetAdminState> {
  try {
    return await store.getAssetState(tokenId)
  } catch (cause) {
    throw Reasons.storeUnavailable('the asset state', cause)
  }
}

async function readSupply(store: MandalaStateStore, tokenId: string): Promise<bigint> {
  try {
    return await store.circulatingSupply(tokenId)
  } catch (cause) {
    throw Reasons.storeUnavailable('the circulating supply', cause)
  }
}

function ownerAt(owners: readonly VerifiedOwner[], index: number): VerifiedOwner {
  const owner = owners.find(o => o.index === index)
  if (owner === undefined) throw new Error(`no verified owner for output ${index}`)
  return owner
}

// ---- 1. deploys (layer B guarantees a deploy is output 0) ----

async function requireValidDeploys(
  txid: string,
  outputs: readonly Brc162Output[],
  owners: readonly VerifiedOwner[],
  env: MandalaEnvelope
): Promise<void> {
  await eachInOrder(outputs, async output => {
    if (output.role !== 'deploy') return
    if (output.amount > 0n) throw Reasons.fixedSupply()
    deployMetadata(output.payload, output.payloadCanonical)
    const { identityKey } = ownerAt(owners, output.index)
    if (!(await verifyDeploySig(txid, env.deploySig, identityKey))) throw Reasons.deploySig()
  })
}

// ---- 2. trusted identities (D4) ----

function requireTrustedOutputs(
  owners: readonly VerifiedOwner[],
  trusted: ReadonlySet<string>
): void {
  for (const owner of owners) {
    if (owner.role === 'value') continue
    if (!trusted.has(owner.identityKey.toLowerCase())) {
      throw Reasons.untrustedOwner(owner.index, owner.identityKey)
    }
    if (!trusted.has(owner.prover.toLowerCase())) {
      throw Reasons.untrustedProver(owner.index, owner.prover)
    }
  }
}

// A key removed from the trusted set loses the authority coins it holds: without this, it could
// still spend one into an output owned by (and replaying the linkage of) a trusted issuer and
// commit any action on the way. Input order; never persisted, so re-trusting lifts it.
function requireTrustedAuthorityInputs(
  ledgers: readonly TokenLedger[],
  inputOwners: ReadonlyMap<number, string>,
  trusted: ReadonlySet<string>
): void {
  const indices = ledgers.flatMap(ledger => ledger.authorityIn).sort((a, b) => a - b)
  for (const index of indices) {
    const owner = inputOwners.get(index)
    if (owner === undefined) throw new Error(`no resolved owner for input ${index}`)
    if (!trusted.has(owner.toLowerCase())) throw Reasons.untrustedAuthorityInput(index, owner)
  }
}

// ---- 3, 4. authority inputs and continuity (D8) ----

function requireAuthorityInputs(ledgers: readonly TokenLedger[]): void {
  for (const ledger of ledgers) {
    if (!specVerdicts(ledger).authorityOutputsValid) {
      throw Reasons.authorityWithoutInput(ledger.authorityOut[0], ledger.tokenId)
    }
  }
}

function requireContinuity(ledgers: readonly TokenLedger[]): void {
  for (const ledger of ledgers) {
    if (ledger.authorityIn.length > 0 && ledger.authorityOut.length === 0) {
      throw Reasons.continuity(ledger.tokenId)
    }
  }
}

// ---- 5. commitments (D9, D11) ----

interface Commitment {
  index: number
  commitment: number[]
}

// Only an authority output (id + amount 0) can carry an action: an `adm` key
// in a deploy payload commits to nothing.
function commitmentsOf(outputs: readonly Brc162Output[], tokenId: string): Commitment[] {
  return outputs.flatMap(output => {
    if (output.role !== 'authority' || output.tokenId !== tokenId) return []
    const commitment = commitmentOf(output.payload, output.payloadCanonical)
    return commitment === undefined ? [] : [{ index: output.index, commitment }]
  })
}

function verifyCommittedAction(
  tokenId: string,
  { index, commitment }: Commitment,
  env: MandalaEnvelope,
  allowedKinds: readonly string[]
): CommittedAction {
  const entry = env.admin.find(e => e.index === index)
  if (entry === undefined) throw Reasons.missingDetails(index)
  const decoded = decodeAdminDetails(entry.details, allowedKinds, index)
  if (toHex(decoded.commitment) !== toHex(commitment)) throw Reasons.commitmentMismatch(index)
  return {
    tokenId,
    outputIndex: index,
    details: decoded.details,
    detailsHex: entry.details,
    commitment
  }
}

function requireNoOrphanDetails(env: MandalaEnvelope, actions: readonly CommittedAction[]): void {
  const committed = new Set(actions.map(action => action.outputIndex))
  const orphan = env.admin.find(entry => !committed.has(entry.index))
  if (orphan !== undefined) throw Reasons.orphanDetails(orphan.index)
}

function committedActions(
  ledgers: readonly TokenLedger[],
  outputs: readonly Brc162Output[],
  env: MandalaEnvelope,
  registry: boolean
): CommittedAction[] {
  const allowedKinds = registry ? REGISTRY_KINDS : ADMIN_KINDS
  const actions: CommittedAction[] = []
  for (const { tokenId } of ledgers) {
    const commitments = commitmentsOf(outputs, tokenId)
    if (commitments.length > 1) throw Reasons.twoCommitments(tokenId)
    if (commitments.length === 1) {
      actions.push(verifyCommittedAction(tokenId, commitments[0], env, allowedKinds))
    }
  }
  requireNoOrphanDetails(env, actions)
  return actions
}

// ---- 6. registry ----

function requireNoValueOutputs(outputs: readonly Brc162Output[]): void {
  const value = outputs.find(output => output.role === 'value')
  if (value !== undefined) throw Reasons.registryValue(value.index)
}

// ---- 7. supply delta (D5, §3.3, §3.6) ----

const actionOf = (actions: readonly CommittedAction[], tokenId: string) =>
  actions.find(action => action.tokenId === tokenId)

const deltaOf = (ledger: TokenLedger): bigint => ledger.valueOut - ledger.valueIn

// A token with no authority input is a holder transfer and must conserve
// exactly; that also refuses value created with no authority or value input.
// A reissue's delta is the frozen row's amount, checked with the reissue (9).
function requireDeltaRule(ledger: TokenLedger, action: CommittedAction | undefined): void {
  const delta = deltaOf(ledger)
  if (ledger.authorityIn.length === 0) {
    if (delta !== 0n) {
      throw Reasons.holderConservation(ledger.tokenId, ledger.valueIn, ledger.valueOut)
    }
    return
  }
  const kind = action?.details.kind ?? PLAIN_AUTHORITY
  if (kind === 'reissue') return
  const { rule, holds } = DELTA_RULES.get(kind) ?? ZERO
  if (!holds(delta)) throw Reasons.deltaRule(ledger.tokenId, kind, rule, delta)
}

// ---- 8. caps (§3.4) ----

async function requireCaps(
  ledgers: readonly TokenLedger[],
  store: MandalaStateStore
): Promise<void> {
  await eachInOrder(ledgers, async ledger => {
    if (ledger.valueIn > MAX_SAFE || ledger.valueOut > MAX_SAFE) {
      throw Reasons.sumCap(ledger.tokenId)
    }
    const delta = deltaOf(ledger)
    if (delta > 0n && (await readSupply(store, ledger.tokenId)) + delta > MAX_SAFE) {
      throw Reasons.supplyCap(ledger.tokenId)
    }
  })
}

// ---- 9. reissue ----

const amountIs = (stored: number, delta: bigint): boolean =>
  Number.isSafeInteger(stored) && BigInt(stored) === delta

async function requireValidReissue(
  ledger: TokenLedger,
  { details }: CommittedAction,
  owners: readonly VerifiedOwner[],
  store: MandalaStateStore
): Promise<void> {
  const { tokenId } = ledger
  const target = (details.outpoint ?? '').toLowerCase()
  const state = await readAssetState(store, tokenId)
  const frozen = state.frozenOutpoints.find(f => f.outpoint.toLowerCase() === target)
  if (frozen === undefined) throw Reasons.reissue(tokenId, 'target is not frozen')
  if (!amountIs(frozen.amount, deltaOf(ledger))) {
    throw Reasons.reissue(tokenId, 'amount does not match the frozen row')
  }
  if (ledger.valueInIndices.length > 0) {
    throw Reasons.reissue(tokenId, 'must not spend value inputs')
  }
  const recipient = (details.recipient ?? '').toLowerCase()
  const strayed = owners.some(
    o => o.tokenId === tokenId && o.role === 'value' && o.identityKey.toLowerCase() !== recipient
  )
  if (strayed) throw Reasons.reissue(tokenId, 'outputs must go to the recipient')
}

async function requireValidReissues(
  ledgers: readonly TokenLedger[],
  actions: readonly CommittedAction[],
  owners: readonly VerifiedOwner[],
  store: MandalaStateStore
): Promise<void> {
  await eachInOrder(ledgers, async ledger => {
    const action = actionOf(actions, ledger.tokenId)
    if (action?.details.kind === 'reissue') await requireValidReissue(ledger, action, owners, store)
  })
}

/**
 * Layer C for one transaction (brief order): deploys, trusted identities (deploy and authority
 * output owners and provers, then authority input owners), authority inputs, continuity,
 * commitments, registry value outputs, supply delta, caps, reissue. `outputs`, `owners` and
 * `inputOwners` come from layers A and B.
 */
export async function checkAuthority(
  txid: string,
  ledger: Map<string, TokenLedger>,
  outputs: readonly Brc162Output[],
  owners: readonly VerifiedOwner[],
  inputOwners: ReadonlyMap<number, string>,
  env: MandalaEnvelope,
  deps: AuthorityDeps
): Promise<AuthorityResult> {
  const ledgers = [...ledger.values()]
  const trusted = lowered(deps.trustedIssuers)
  await requireValidDeploys(txid, outputs, owners, env)
  requireTrustedOutputs(owners, trusted)
  requireTrustedAuthorityInputs(ledgers, inputOwners, trusted)
  requireAuthorityInputs(ledgers)
  requireContinuity(ledgers)
  const actions = committedActions(ledgers, outputs, env, deps.registry)
  if (deps.registry) requireNoValueOutputs(outputs)
  for (const tokenLedger of ledgers)
    requireDeltaRule(tokenLedger, actionOf(actions, tokenLedger.tokenId))
  await requireCaps(ledgers, deps.store)
  await requireValidReissues(ledgers, actions, owners, deps.store)
  return {
    actions,
    deltas: new Map(ledgers.map(l => [l.tokenId, deltaOf(l)])),
    adminTokens: new Set(ledgers.filter(l => l.authorityIn.length > 0).map(l => l.tokenId))
  }
}
