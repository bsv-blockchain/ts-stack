import { expect, test } from '@jest/globals'
import fc from 'fast-check'
import {
  createPrivatePurchaseAliasState,
  retainPrivatePurchaseAlias,
  advancePrivatePurchaseAliasAdmission,
  releasePrivatePurchaseAlias,
  parsePrivatePurchaseAliasState,
  type PrivatePurchaseAliasEntry,
  type PrivatePurchaseAliasState
} from '../src/private/PrivatePurchaseAliasState.js'

const MIN_PROPERTY_RUNS = 300
const runs = Number.parseInt(process.env.FAST_CHECK_NUM_RUNS ?? '', 10),
  seed = Number.parseInt(process.env.FAST_CHECK_SEED ?? '', 10),
  replay = process.env.FAST_CHECK_PATH
fc.configureGlobal({
  numRuns: Number.isSafeInteger(runs) ? Math.max(MIN_PROPERTY_RUNS, runs) : MIN_PROPERTY_RUNS,
  seed: Number.isSafeInteger(seed) ? seed : 3242026,
  ...(replay ? { path: replay } : {})
})
const identity = 'ab'.repeat(32),
  initial = (slots = 1) =>
    createPrivatePurchaseAliasState('cd'.repeat(32), 'ef'.repeat(32), '12'.repeat(32), slots),
  candidate = (n: number): PrivatePurchaseAliasEntry => ({
    txid: n.toString(16).padStart(64, '0'),
    candidateDigest: (n + 100).toString(16).padStart(64, '0'),
    operationId: (n + 200).toString(16).padStart(64, '0'),
    admission: 'retained'
  })
function retain(
  state: PrivatePurchaseAliasState,
  n: number,
  selected = false
): PrivatePurchaseAliasState {
  const outcome = retainPrivatePurchaseAlias(
    state,
    { purchaseCommitment: identity, entry: candidate(n) },
    selected ? { checkCurrent: () => undefined } : undefined
  )
  expect(outcome.status).toBe('retained')
  if (outcome.status !== 'retained') throw Error('Expected metadata retention')
  return outcome.state
}
function admit(state: PrivatePurchaseAliasState, n: number): PrivatePurchaseAliasState {
  return advancePrivatePurchaseAliasAdmission(
    advancePrivatePurchaseAliasAdmission(state, candidate(n).txid, 'pending'),
    candidate(n).txid,
    'admitted'
  )
}
// These are custody metadata unit oracles. An installed independent domain and
// selected-chain verifier must supply the guards at the eventual native owner.
test('a full cache never consumes the separately prepaid selected-chain role', () => {
  let state = retain(initial(), 1)
  state = retain(state, 2)
  state = advancePrivatePurchaseAliasAdmission(state, candidate(2).txid, 'pending')
  const before = structuredClone(state)
  state = retain(state, 3, true)
  expect(state.selected?.txid).toBe(candidate(3).txid)
  expect(state.unconfirmed).toEqual(before.unconfirmed)
  expect(before.selected).toBeNull()
})
test('a pending original job remains retained when another equivalent alias becomes selected', () => {
  let state = retain(initial(), 1, true)
  state = advancePrivatePurchaseAliasAdmission(state, candidate(1).txid, 'pending')
  const snapshot = structuredClone(state)
  state = retain(state, 2, true)
  expect(state.selected?.txid).toBe(candidate(2).txid)
  expect(state.original).toEqual(snapshot.original)
  expect(state.pending).toEqual(snapshot.pending)
  expect(() => advancePrivatePurchaseAliasAdmission(state, candidate(1).txid, 'retained')).toThrow()
})
test('cache fullness never displaces pending selected jobs and separate external-work limits stay bounded', () => {
  let state = admit(retain(initial(), 1), 1)
  state = retain(state, 100)
  state = advancePrivatePurchaseAliasAdmission(state, candidate(100).txid, 'pending')
  for (const n of [2, 3, 4]) {
    state = retain(state, n, true)
    state = advancePrivatePurchaseAliasAdmission(state, candidate(n).txid, 'pending')
  }
  expect(state.pending.map(x => x?.txid)).toEqual([candidate(2).txid, candidate(3).txid])
  expect(state.selected?.txid).toBe(candidate(4).txid)
  expect(state.unconfirmed[0]?.txid).toBe(candidate(100).txid)
  const before = structuredClone(state)
  expect(
    retainPrivatePurchaseAlias(
      state,
      { purchaseCommitment: identity, entry: candidate(5) },
      { checkCurrent: () => undefined }
    )
  ).toEqual({ status: 'pending', reason: 'external-operations-unresolved' })
  expect(state).toEqual(before)
  state = advancePrivatePurchaseAliasAdmission(state, candidate(2).txid, 'admitted')
  state = retain(state, 5, true)
  expect(state.selected?.txid).toBe(candidate(5).txid)
  expect(state.pending.map(x => x?.txid)).toEqual([candidate(4).txid, candidate(3).txid])
})
test('first historical delivery is immutable while selected alias placement can change', () => {
  let state = admit(retain(initial(), 1), 1)
  state = releasePrivatePurchaseAlias(state, candidate(1).txid)
  const historical = structuredClone(state.historical)
  state = retain(state, 2, true)
  state = admit(state, 2)
  expect(state.selected?.txid).toBe(candidate(2).txid)
  expect(state.historical).toEqual(historical)
  expect(() => releasePrivatePurchaseAlias(state, candidate(2).txid)).toThrow()
  expect(releasePrivatePurchaseAlias(state, candidate(1).txid)).toEqual(state)
})
test('first mined-policy release can target a different admitted alias than the original transaction', () => {
  let state = admit(retain(initial(), 1), 1)
  state = admit(retain(state, 2, true), 2)
  state = releasePrivatePurchaseAlias(state, candidate(2).txid, { checkCurrent: () => undefined })
  expect(state.original?.txid).toBe(candidate(1).txid)
  expect(state.historical?.txid).toBe(candidate(2).txid)
  expect(state.original?.admission).toBe('admitted')
})
test('a metadata proposal neither accepts changed identities nor changes its input on refusal', () => {
  const state = retain(initial(), 1),
    before = structuredClone(state)
  expect(() =>
    retainPrivatePurchaseAlias(state, { purchaseCommitment: 'aa'.repeat(32), entry: candidate(2) })
  ).toThrow()
  expect(() =>
    retainPrivatePurchaseAlias(state, {
      purchaseCommitment: identity,
      entry: { ...candidate(1), candidateDigest: 'bb'.repeat(32) }
    })
  ).toThrow()
  expect(() =>
    retainPrivatePurchaseAlias(state, {
      purchaseCommitment: identity,
      entry: { ...candidate(2), admission: 'admitted' }
    })
  ).toThrow()
  expect(() =>
    retainPrivatePurchaseAlias(
      state,
      { purchaseCommitment: identity, entry: candidate(2) },
      {
        checkCurrent: () => {
          throw Error('view changed')
        }
      }
    )
  ).toThrow('view changed')
  expect(state).toEqual(before)
})
test('an unconfirmed alias cache preserves every pending external job and reports a bounded reconciliation obligation', () => {
  let state = retain(retain(initial(), 1), 2)
  state = advancePrivatePurchaseAliasAdmission(state, candidate(2).txid, 'pending')
  expect(
    retainPrivatePurchaseAlias(state, { purchaseCommitment: identity, entry: candidate(3) })
  ).toEqual({ status: 'pending', reason: 'cache-operations-unresolved' })
  state = advancePrivatePurchaseAliasAdmission(state, candidate(2).txid, 'rejected')
  state = retain(state, 3)
  expect(state.original?.txid).toBe(candidate(1).txid)
  expect(state.unconfirmed[0]?.txid).toBe(candidate(3).txid)
})
test('generated retained alias histories preserve historical release and all unresolved exact-txid operations', () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 1, max: 4 }),
      fc.array(fc.boolean(), { minLength: 1, maxLength: 16 }),
      (capacity, admissions) => {
        let state = admit(retain(initial(capacity), 1), 1)
        state = releasePrivatePurchaseAlias(state, candidate(1).txid)
        const historical = structuredClone(state.historical)
        const pending = new Map<string, string>()
        for (let index = 0; index < admissions.length; index++) {
          const n = index + 2,
            outcome = retainPrivatePurchaseAlias(state, {
              purchaseCommitment: identity,
              entry: candidate(n)
            })
          if (outcome.status === 'retained') {
            state = advancePrivatePurchaseAliasAdmission(
              outcome.state,
              candidate(n).txid,
              'pending'
            )
            if (admissions[index])
              state = advancePrivatePurchaseAliasAdmission(state, candidate(n).txid, 'admitted')
            else pending.set(candidate(n).txid, candidate(n).operationId)
          }
          expect(parsePrivatePurchaseAliasState(state).historical).toEqual(historical)
          for (const [txid, operationId] of pending)
            expect(state.unconfirmed).toContainEqual({
              ...candidate(Number.parseInt(txid, 16)),
              operationId,
              admission: 'pending'
            })
          expect(state.unconfirmed).toHaveLength(capacity)
        }
        const selected = retain(state, admissions.length + 1000, true)
        expect(selected.unconfirmed).toEqual(state.unconfirmed)
        expect(selected.historical).toEqual(historical)
      }
    ),
    {
      interruptAfterTimeLimit: 150000,
      markInterruptAsFailure: true,
      ...(replay ? { path: replay } : {})
    }
  )
}, 180000)

test('same-txid proof metadata uses a mutable role while first financial and historical records stay fixed', () => {
  let state = admit(retain(initial(), 1), 1)
  state = releasePrivatePurchaseAlias(state, candidate(1).txid)
  const original = structuredClone(state.original),
    historical = structuredClone(state.historical)
  const proposal = retainPrivatePurchaseAlias(state, {
    purchaseCommitment: identity,
    entry: candidate(1)
  })
  expect(proposal.status).toBe('retained')
  if (proposal.status !== 'retained') throw Error('Expected metadata retention')
  expect(proposal.role).toBe('unconfirmed/0')
  expect(proposal.state.original).toEqual(original)
  expect(proposal.state.historical).toEqual(historical)
  expect(proposal.state.unconfirmed[0]).toEqual(original)
})
