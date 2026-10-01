import { expect, it } from '@jest/globals'
import { Utils } from '@bsv/sdk'
import { ProposalJournalState } from '../src/proposals/ProposalJournalState.js'
import {
  ProposalTransitions,
  type ProposalTransition
} from '../src/proposals/ProposalTransitions.js'
import { proposalChannelKey } from '../src/proposals/ProposalPolicyRegistry.js'
import { author, signed, scope, createRegistry, finalize } from './proposal-client-fixture.js'

function setup() {
  const lifecycle = new ProposalTransitions(createRegistry(), scope, {
    maxLifetimeSeconds: '100',
    futureSkewSeconds: '2'
  })
  const state = new ProposalJournalState(lifecycle, author)
  const first = lifecycle.put(undefined, signed(), author, '10')
  const apply = (target: ProposalJournalState, transition: ProposalTransition) => {
    const prepared = target.prepare(transition, { local: 'retained' })
    const result = target.plan(prepared)
    expect(result.status).toBe('committed')
    if (result.status !== 'committed') throw new Error('fixture commit')
    target.apply(prepared, result.revision)
  }
  apply(state, first)
  return { lifecycle, state, first, apply, key: proposalChannelKey(first.next.proposal.body) }
}

it('forks the entire retained journal and isolates independent successor writes and owned reads', () => {
  const { state, lifecycle, first, apply, key } = setup()
  const copy = state.fork()
  expect(copy.configuration).toBe(state.configuration)
  expect(copy.serviceIdentity).toBe(state.serviceIdentity)
  expect(copy.head()).toEqual(state.head())
  expect(copy.read('0', 256)).toEqual(state.read('0', 256))
  const next = lifecycle.put(
    first.next,
    signed({ revision: '1', previous: first.next.proposalId }),
    author,
    '11'
  )
  apply(copy, next)
  expect(copy.channel(key)).toEqual(next.next)
  expect(state.channel(key)).toEqual(first.next)
  expect(copy.head().revision).toBe('2')
  expect(state.head().revision).toBe('1')
  const history = copy.read('0', 256)
  history[0].transition.next.proposal.body.payload = ''
  history[0].local!.local = 'changed'
  expect(copy.read('0', 1)).toEqual(state.read('0', 1))
  apply(state, lifecycle.expire(first.next, '100'))
  expect(state.channel(key)?.state.status).toBe('expired')
  expect(copy.channel(key)?.state.status).toBe('active')
})

it('retains admission reservations and exact operation identities while independently completing a staged copy', () => {
  const { state, lifecycle, first, apply } = setup()
  const tx = finalize(first.next.proposal),
    operationId = 'fork-reservation-0001'
  const reserved = lifecycle.reserve(
    first.next,
    author,
    {
      version: 1,
      operationId,
      service: scope.service,
      proposalId: first.next.proposalId,
      txid: tx.id('hex'),
      beef: 'AA=='
    },
    Utils.toBase64(tx.toBinary()),
    '99'
  )
  apply(state, reserved)
  const copy = state.fork()
  expect(copy.head().reserved).toEqual(state.head().reserved)
  expect(copy.head().reserved?.entries).toBe(1)
  expect(copy.operation(author, scope.service, operationId)).toEqual(reserved.next)
  const done = lifecycle.complete(
    reserved.next,
    {
      status: 'admitted',
      operationId,
      txid: tx.id('hex'),
      steak: {},
      assessmentContextId: 'test-chain-view'
    },
    '101'
  )
  apply(copy, done)
  expect(copy.head().reserved).toEqual({ entries: 0, bytes: 0 })
  expect(state.head().reserved?.entries).toBe(1)
  expect(copy.operation(author, scope.service, operationId)?.state.status).toBe('finalized')
  expect(state.operation(author, scope.service, operationId)?.state.status).toBe('finalizing')
  expect(copy.fork().read('0', 256)).toEqual(copy.read('0', 256))
})
