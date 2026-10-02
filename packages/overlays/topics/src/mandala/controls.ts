// Layer D of the BRC-162 migration (spec §4.4): issuer controls. Per token the
// transaction touches (ledger order): frozen or evicted inputs, pause, and the
// access mode; then sanctions over every identity in the transaction, then
// registry membership. "Admin tx of T" is on-chain fact: the transaction spends
// an admitted authority of T. Issuer exemptions come from configuration (the
// trusted issuers and the overlay identity key), never from asset state.
import type { Brc162Input, TokenLedger } from '../brc162/ledger.js'
import type { AssetAdminState } from './AssetStateReducer.js'
import type { MandalaStateStore } from './MandalaStorageManager.js'
import { readAssetState } from './authority.js'
import { eachInOrder } from './inOrder.js'
import type { AuthorityResult } from './authority.js'
import type { VerifiedOwner } from './ownership.js'
import { Reasons } from './reject.js'
import type { MembershipProvider, ScreeningProvider } from './types.js'

export interface ControlDeps {
  store: MandalaStateStore
  screening: ScreeningProvider
  membership?: MembershipProvider
  /** Trusted issuers plus the overlay identity key: exempt from access mode and membership. */
  exempt: ReadonlySet<string>
}

const lower = (key: string): string => key.toLowerCase()
const lowered = (keys: Iterable<string>): Set<string> => new Set([...keys].map(lower))

function ownerOfInput(inputOwners: Map<number, string>, index: number): string {
  const owner = inputOwners.get(index)
  if (owner === undefined) throw new Error(`no resolved owner for input ${index}`)
  return owner
}

// ---- per token ----

function requireSpendableInputs(state: AssetAdminState, inputs: readonly Brc162Input[]): void {
  const frozen = lowered(state.frozenOutpoints.map(f => f.outpoint))
  const evicted = lowered(state.evictedOutpoints)
  for (const input of inputs) {
    const outpoint = lower(input.outpoint)
    if (frozen.has(outpoint)) throw Reasons.frozenInput(input.index, input.outpoint)
    if (evicted.has(outpoint)) throw Reasons.evictedInput(input.index, input.outpoint)
  }
}

/** What the controls know about who takes part in the transaction. */
interface Parties {
  inputs: readonly Brc162Input[]
  inputOwners: Map<number, string>
  owners: readonly VerifiedOwner[]
  /** Lowercased. */
  exempt: ReadonlySet<string>
}

/** This token's output owners, then its input owners, lowercased, minus the exempt set. */
function tokenParties(tokenId: string, tokenInputs: readonly Brc162Input[], p: Parties): string[] {
  const parties = [
    ...p.owners.filter(o => o.tokenId === tokenId).map(o => o.identityKey),
    ...tokenInputs.map(input => ownerOfInput(p.inputOwners, input.index))
  ].map(lower)
  return parties.filter(party => !p.exempt.has(party))
}

// Any mode other than 'denylist' is read as an allowlist, which fails closed.
function requireAccess(tokenId: string, state: AssetAdminState, parties: readonly string[]): void {
  if (state.accessMode === 'denylist') {
    const blocked = lowered(state.blockedIdentities)
    const party = parties.find(k => blocked.has(k))
    if (party !== undefined) throw Reasons.blocked(tokenId, party)
    return
  }
  const allowed = lowered(state.allowedIdentities)
  const party = parties.find(k => !allowed.has(k))
  if (party !== undefined) throw Reasons.notAllowed(tokenId, party)
}

async function requireTokenControls(
  tokenId: string,
  isAdmin: boolean,
  p: Parties,
  store: MandalaStateStore
): Promise<void> {
  const tokenInputs = p.inputs.filter(input => input.tokenId === tokenId)
  const state = await readAssetState(store, tokenId)
  requireSpendableInputs(state, tokenInputs)
  if (isAdmin) return
  if (state.isPaused) throw Reasons.paused(tokenId)
  requireAccess(tokenId, state, tokenParties(tokenId, tokenInputs, p))
}

// ---- every identity ----

/** Output owners (index order), then input owners (input order), lowercased and deduplicated. */
function allIdentities(p: Parties): string[] {
  const identities = [
    ...p.owners.map(o => o.identityKey),
    ...p.inputs.map(input => ownerOfInput(p.inputOwners, input.index))
  ]
  return [...lowered(identities)]
}

// A provider that throws or answers anything but a boolean is an infra fault:
// a retryable ERR_UNAVAILABLE, never a verdict. A throw is kept as its cause.
async function verdictOf(ask: () => Promise<unknown>, provider: string): Promise<boolean> {
  let verdict: unknown
  let cause: unknown
  try {
    verdict = await ask()
  } catch (e) {
    cause = e
  }
  if (typeof verdict !== 'boolean') throw Reasons.storeUnavailable(provider, cause)
  return verdict
}

async function requireNotSanctioned(
  screening: ScreeningProvider,
  identities: readonly string[]
): Promise<void> {
  await eachInOrder(identities, async key => {
    if (await verdictOf(async () => await screening.isSanctioned(key), 'the screening provider')) {
      throw Reasons.sanctioned(key)
    }
  })
}

async function requireMembers(
  membership: MembershipProvider | undefined,
  parties: readonly string[]
): Promise<void> {
  if (membership === undefined) return
  const ask = async (question: () => Promise<boolean>): Promise<boolean> =>
    await verdictOf(question, 'the membership provider')
  if (!(await ask(async () => await membership.isActive()))) return
  await eachInOrder(parties, async key => {
    if (!(await ask(async () => await membership.isAdmitted(key)))) throw Reasons.notMember(key)
  })
}

/**
 * Layer D for one transaction. The per-token controls run for every token
 * first; sanctions (every identity, exempt ones included) and membership
 * (every non-exempt identity) are then judged once for the whole transaction.
 */
export async function checkControls(
  ledger: Map<string, TokenLedger>,
  inputs: readonly Brc162Input[],
  inputOwners: Map<number, string>,
  owners: readonly VerifiedOwner[],
  auth: AuthorityResult,
  deps: ControlDeps
): Promise<void> {
  const parties: Parties = { inputs, inputOwners, owners, exempt: lowered(deps.exempt) }
  await eachInOrder(ledger.keys(), async tokenId => {
    await requireTokenControls(tokenId, auth.adminTokens.has(tokenId), parties, deps.store)
  })
  const identities = allIdentities(parties)
  await requireNotSanctioned(deps.screening, identities)
  await requireMembers(
    deps.membership,
    identities.filter(key => !parties.exempt.has(key))
  )
}
