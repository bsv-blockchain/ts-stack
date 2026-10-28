import { expect, it } from '@jest/globals'
import { SourceMembershipLedger } from '../src/SourceMembership.js'
import type { SourceBatch, OutputScope } from '../src/ports.js'
import { chain, partition, candidate } from './evidence-fixture.js'

const scope: OutputScope = {
  chain,
  provider: 'configured-source',
  service: 'records',
  queryDigest: '11'.repeat(32),
  rulesDigest: '22'.repeat(32),
  access: 'reader',
  epoch: 'one'
}
function batch(generation: string, ids: string[], complete: boolean, epoch = 'one'): SourceBatch {
  const selected = { ...scope, epoch }
  return {
    provenance: {
      partition,
      generation,
      adapter: 'source',
      scope: selected,
      authentication: 'configured-transport',
      peer: selected.provider,
      receivedAt: '10'
    },
    groups: ids.map(id => ({
      id,
      sequence: '7',
      observations: [
        { id, scope: selected, kind: 'output', payload: { evidence: candidate('A').evidence } }
      ]
    })),
    coverage: {
      scope: selected,
      phase: 'snapshot',
      status: complete ? 'complete' : 'partial',
      through: '7',
      highWater: '7'
    }
  }
}
function accept(ledger: SourceMembershipLedger, input: SourceBatch, receipt: string) {
  ledger.receive(input, receipt)
  for (const group of input.groups)
    ledger.decide(input.provenance.scope, input.provenance.generation, group.id, 'accepted')
  ledger.acceptCompletions()
}

it('represents an empty complete new generation that replaces an older nonempty published source', () => {
  const ledger = new SourceMembershipLedger()
  accept(ledger, batch('0', ['old'], true), '1')
  expect(ledger.sourceStates()).toMatchObject([
    { generation: '0', current: true, visible: true, continuous: true, complete: true }
  ])
  ledger.receive(batch('1', [], true, 'two'), '2')
  expect(ledger.sourceStates()).toMatchObject([
    { generation: '0', current: false, visible: true, continuous: false, complete: true },
    { generation: '1', current: true, visible: false, continuous: false, complete: false }
  ])
  ledger.acceptCompletions()
  expect(ledger.publishedGroups()).toEqual([])
  expect(ledger.sourceStates()).toMatchObject([
    { generation: '0', current: false, visible: false, continuous: false, complete: true },
    { generation: '1', current: true, visible: true, continuous: true, complete: true }
  ])
  expect(() => ledger.receive(batch('0', ['late'], true), '3')).toThrow('Retired')
})

it('keeps progressive continuity separate from complete-seed acceptance and later verification', () => {
  const ledger = new SourceMembershipLedger()
  accept(ledger, batch('0', ['first'], false), '1')
  expect(ledger.sourceStates()).toMatchObject([
    { current: true, visible: true, continuous: true, complete: false }
  ])
  ledger.receive(batch('0', ['second'], false), '2')
  ledger.receive(batch('0', ['third'], true), '3')
  ledger.decide(scope, '0', 'third', 'accepted')
  expect(ledger.publishedGroups().map(row => row.group.id)).toEqual(['first'])
  expect(ledger.sourceStates()).toMatchObject([
    { current: true, visible: true, continuous: false, complete: false }
  ])
  ledger.decide(scope, '0', 'second', 'accepted')
  expect(ledger.publishedGroups().map(row => row.group.id)).toEqual(['first', 'second', 'third'])
  const states = ledger.sourceStates()
  expect(states).toMatchObject([{ current: true, visible: true, continuous: true, complete: true }])
  states[0].scope.epoch = 'mutated'
  expect(ledger.sourceStates()[0].scope.epoch).toBe('one')
  const reset = batch('0', [], true)
  reset.coverage.status = 'reset-required'
  ledger.receive(reset, '4')
  expect(ledger.sourceStates()).toMatchObject([
    { current: true, visible: true, continuous: false, complete: true }
  ])
})

it('distinguishes an empty finite receipt from a durable snapshot seed', () => {
  const ledger = new SourceMembershipLedger(),
    input = batch('0', [], true)
  input.coverage = { scope, phase: 'finite', status: 'complete' }
  accept(ledger, input, '1')
  expect(ledger.sourceStates()).toMatchObject([{ snapshot: false, complete: true }])
  accept(ledger, batch('1', [], true, 'two'), '2')
  expect(ledger.sourceStates()).toMatchObject([{ snapshot: false }, { snapshot: true }])
})
