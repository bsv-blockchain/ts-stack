import { expect, test } from '@jest/globals'
import {
  projectPrivatePurchaseAliasSelection,
  parsePrivatePurchaseAliasSelection,
  samePrivatePurchaseAliasReservation
} from '../src/private/PrivatePurchaseAliasSelection.js'
import {
  createPrivatePurchaseAliasState,
  retainPrivatePurchaseAlias,
  advancePrivatePurchaseAliasAdmission
} from '../src/private/PrivatePurchaseAliasState.js'
import { privatePurchaseOperation } from '../src/private/PrivatePurchaseProgress.js'
import type { PrivatePurchaseAliasSnapshot } from '../src/private/SQLitePrivatePurchaseAliases.js'
import type { ProtectedLedgerView } from '../src/private/ProtectedLedgerCodec.js'
import { purchaseProgressFixture } from './private-purchase-progress.fixture.js'

// Representation-only projections with disclosed toy metadata. The native
// owner must separately prove the actual view, RAW/domain and selected chain.
function fixture() {
  const f = purchaseProgressFixture(),
    original = f.original,
    identity = 'd4'.repeat(32)
  const state = createPrivatePurchaseAliasState(
    original.terms.body.acquisitionId,
    original.terms.body.requestDigest,
    'a8'.repeat(32),
    1
  )
  const aliases: PrivatePurchaseAliasSnapshot = {
    state,
    candidates: new Map(),
    outcomes: new Map(),
    completedAt: new Map(),
    checkCurrent: () => undefined
  }
  function retained(txid = f.txid, selected = false) {
    const proposal = retainPrivatePurchaseAlias(
      aliases.state,
      {
        purchaseCommitment: identity,
        entry: {
          txid,
          candidateDigest: 'a9'.repeat(32),
          operationId: privatePurchaseOperation(original, txid),
          admission: 'retained'
        }
      },
      selected ? { checkCurrent: () => undefined } : undefined
    )
    if (proposal.status !== 'retained') throw Error('Expected toy metadata slot')
    aliases.state = proposal.state
    aliases.candidates = new Map([
      ...aliases.candidates,
      [
        proposal.role,
        {
          version: 1,
          acquisitionId: original.terms.body.acquisitionId,
          txid,
          beef: 'AA=='
        }
      ]
    ])
    return proposal.role
  }
  function terminal(txid = f.txid, rejected = false) {
    aliases.state = advancePrivatePurchaseAliasAdmission(aliases.state, txid, 'pending')
    aliases.state = advancePrivatePurchaseAliasAdmission(
      aliases.state,
      txid,
      rejected ? 'rejected' : 'admitted'
    )
    const roles = [...aliases.candidates].filter(([, c]) => c.txid === txid).map(([r]) => r)
    const outcome = rejected
      ? {
          status: 'rejected' as const,
          operationId: privatePurchaseOperation(original, txid),
          txid,
          reason: 'local-rejection',
          evidence: ''
        }
      : {
          status: 'admitted' as const,
          operationId: privatePurchaseOperation(original, txid),
          txid,
          steak: f.steak,
          acceptedAt: '30',
          assessmentContextId: 'toy-native-view'
        }
    aliases.outcomes = new Map([
      ...aliases.outcomes,
      ...roles.map(role => [role, outcome] as const)
    ])
    aliases.completedAt = new Map([
      ...aliases.completedAt,
      ...roles.map(role => [role, '35'] as const)
    ])
  }
  function view(at = '50'): ProtectedLedgerView {
    return { revision: '7', observedAt: at, get: () => undefined }
  }
  return { f, original, aliases, retained, terminal, view }
}

test('unconstructed alias selections retain prepared or expired representation without a spend', () => {
  const f = fixture()
  const prepared = projectPrivatePurchaseAliasSelection(
    f.original,
    f.aliases,
    null,
    null,
    f.view('25')
  )
  expect(prepared.progress.status).toBe('prepared')
  expect(prepared.firstReservedAt).toBeNull()
  const expired = projectPrivatePurchaseAliasSelection(
    f.original,
    f.aliases,
    null,
    null,
    f.view(f.original.terms.body.recoveryUntil)
  )
  expect(expired.progress.status).toBe('expired')
  expect(expired.progress.txid).toBeNull()
})

test('pending alias projection preserves the first financial time and records selection separately', () => {
  const f = fixture()
  f.retained()
  const result = projectPrivatePurchaseAliasSelection(
    f.original,
    f.aliases,
    '29',
    f.f.txid,
    f.view()
  )
  expect(result.firstReservedAt).toBe('29')
  expect(result.selectedAt).toBe('50')
  expect(result.progress.updatedAt).toBe('29')
  expect(result.progress.status).toBe('admission-pending')
  const owned = parsePrivatePurchaseAliasSelection(result, f.original)
  owned.progress.updatedAt = '31'
  expect(result.progress.updatedAt).toBe('29')
})

test('a pending projection can select another admitted exact alias under the same reservation', () => {
  const f = fixture(),
    second = '66'.repeat(32)
  f.retained()
  const prior = projectPrivatePurchaseAliasSelection(
    f.original,
    f.aliases,
    '29',
    f.f.txid,
    f.view('34')
  )
  f.retained(second, true)
  f.terminal(second)
  const next = projectPrivatePurchaseAliasSelection(f.original, f.aliases, '29', second, f.view())
  samePrivatePurchaseAliasReservation(prior, next, f.original)
  expect(next.progress.status).toBe('admitted-delivery-pending')
  expect(next.progress.txid).toBe(second)
  expect(next.progress.updatedAt).toBe('35')
  expect(next.progress.admission?.acceptedAt).toBe('30')
  expect(next.selectedAt).toBe('50')
  expect(next.firstReservedAt).toBe('29')
})

test('reselection does not rewrite the retained local rejection time', () => {
  const f = fixture()
  f.retained()
  f.terminal(f.f.txid, true)
  const result = projectPrivatePurchaseAliasSelection(
    f.original,
    f.aliases,
    '29',
    f.f.txid,
    f.view()
  )
  expect(result.progress.status).toBe('admission-rejected')
  expect(result.progress.decision?.decidedAt).toBe('35')
  expect(result.progress.updatedAt).toBe('35')
  expect(result.selectedAt).toBe('50')
  expect(result.progress.decision?.globalOutcome).toBe('unknown')
  expect(() =>
    projectPrivatePurchaseAliasSelection(f.original, f.aliases, '29', f.f.txid, f.view('34'))
  ).toThrow('observation differs')
})

test('alias selection refuses changed reservation identity, backwards observations and missing custody', () => {
  const f = fixture()
  f.retained()
  const prior = projectPrivatePurchaseAliasSelection(
    f.original,
    f.aliases,
    '29',
    f.f.txid,
    f.view()
  )
  const changed = projectPrivatePurchaseAliasSelection(
    f.original,
    f.aliases,
    '30',
    f.f.txid,
    f.view('51')
  )
  expect(() => samePrivatePurchaseAliasReservation(prior, changed, f.original)).toThrow(
    'first economic'
  )
  const earlier = projectPrivatePurchaseAliasSelection(
    f.original,
    f.aliases,
    '29',
    f.f.txid,
    f.view('49')
  )
  expect(() => samePrivatePurchaseAliasReservation(prior, earlier, f.original)).toThrow('backwards')
  expect(() =>
    projectPrivatePurchaseAliasSelection(f.original, f.aliases, '29', '77'.repeat(32), f.view())
  ).toThrow('not retained')
})

test('historical release custody cannot become a new pending selection', () => {
  const f = fixture()
  f.retained()
  f.terminal()
  f.aliases.state.historical = { ...f.aliases.state.original! }
  expect(() =>
    projectPrivatePurchaseAliasSelection(f.original, f.aliases, '29', f.f.txid, f.view())
  ).toThrow('historical custody')
})

test('selection refuses changed or asynchronous native guards before exposing a projection', () => {
  const f = fixture()
  f.aliases.checkCurrent = () => {
    f.aliases.checkCurrent = () => undefined
  }
  expect(() =>
    projectPrivatePurchaseAliasSelection(f.original, f.aliases, null, null, f.view())
  ).toThrow('custody changed')
  f.aliases.checkCurrent = async () => undefined
  expect(() =>
    projectPrivatePurchaseAliasSelection(f.original, f.aliases, null, null, f.view())
  ).toThrow('synchronous')
})
