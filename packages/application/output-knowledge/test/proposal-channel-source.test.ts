import { expect, it } from '@jest/globals'
import { outputPacketDigest, type OutputObservation } from '@bsv/sdk'
import type { Source, SourceBatch, SourceRequest } from '../src/ports.js'
import { runtimeLimits } from '../src/validation.js'
import { ProposalChannelHeadsSource } from '../src/proposals/ProposalChannelHeadsSource.js'
import {
  author,
  chain,
  createRegistry,
  reference,
  signed,
  scope
} from './proposal-client-fixture.js'

function fixture() {
  const parameters = { policy: reference },
    query = {}
  const selected = {
    chain,
    provider: author,
    service: scope.service,
    epoch: 'one',
    access: 'reader',
    rulesDigest: outputPacketDigest('service-rules', {
      id: 'https://bsv.brc.dev/overlays/0194#proposal-channel-heads-v1',
      parameters
    }),
    queryDigest: outputPacketDigest('lookup-query', { service: scope.service, query })
  }
  const request: SourceRequest = {
    partition: { application: 'channel-test', account: 'reader', access: 'private' },
    generation: '0',
    scope: selected,
    limits: runtimeLimits()
  }
  const proposal = signed(),
    observations: OutputObservation[] = [
      { id: 'head', scope: selected, kind: 'proposal', payload: { proposal } },
      {
        id: 'state',
        scope: selected,
        kind: 'proposal-state',
        payload: {
          service: scope.service,
          policy: reference,
          channel: proposal.body.channel,
          proposalId: outputPacketDigest('proposal', proposal.body),
          state: { status: 'active', recordedAt: '10' }
        }
      }
    ]
  const batch: SourceBatch = {
    provenance: {
      partition: request.partition,
      generation: '0',
      adapter: 'private-source',
      scope: selected,
      authentication: 'brc103',
      peer: author,
      receivedAt: '10'
    },
    coverage: {
      scope: selected,
      phase: 'snapshot',
      status: 'complete',
      through: '1',
      highWater: '1'
    },
    groups: [{ id: 'snapshot', sequence: '1', observations }],
    checkpoint: { session: 'session', cursor: 'cursor', expiresAt: '100', replayUntil: '120' }
  }
  const state = { pulls: 0, closed: false, batches: [batch] }
  const underlying: Source = {
    id: 'private-source',
    requiredDurability: 'durable',
    async *open(_request, signal) {
      try {
        for (const item of state.batches) {
          state.pulls++
          if (signal.aborted) return
          yield item
        }
      } finally {
        state.closed = true
      }
    }
  }
  const source = new ProposalChannelHeadsSource(underlying, createRegistry(), parameters, query)
  return { parameters, query, source, underlying, request, batch, state }
}

it('passes an owned exact complete batch and cancellation closes its underlying iterator', async () => {
  const f = fixture(),
    abort = new AbortController()
  const iterator = f.source.open(f.request, abort.signal)[Symbol.asyncIterator]()
  const got = await iterator.next()
  expect(got.done).toBe(false)
  expect(got.value).toEqual(f.batch)
  got.value!.groups.length = 0
  expect(f.batch.groups).toHaveLength(1)
  await iterator.return!()
  expect(f.state.closed).toBe(true)
  expect(f.state.pulls).toBe(1)
})

it('rejects a partial group before any receipt-facing yield and closes the retained source', async () => {
  const f = fixture()
  f.batch.groups[0].observations.pop()
  const iterator = f.source.open(f.request, new AbortController().signal)[Symbol.asyncIterator]()
  await expect(iterator.next()).rejects.toMatchObject({ code: 'equivocation' })
  expect(f.state.closed).toBe(true)
  expect((await iterator.next()).done).toBe(true)
})

it.each([
  [
    'provenance',
    'unauthorized',
    'Current-channel lookup requires authenticated provider provenance'
  ],
  ['finite', 'unsupported', 'Current-channel lookup requires snapshot/live ordering'],
  ['checkpoint', 'reset-required', 'Current-channel lookup lost its retained checkpoint'],
  ['reset-data', 'equivocation', 'Reset cannot carry current-channel observations']
] as const)('rejects incompatible %s without disclosing the batch', async (kind, code, message) => {
  const f = fixture()
  if (kind === 'provenance') f.batch.provenance.authentication = 'configured-transport'
  if (kind === 'finite') {
    f.batch.coverage.phase = 'finite'
    f.batch.groups[0].sequence = '0'
  }
  if (kind === 'checkpoint') delete f.batch.checkpoint
  if (kind === 'reset-data') f.batch.coverage.status = 'reset-required'
  await expect(
    f.source.open(f.request, new AbortController().signal)[Symbol.asyncIterator]().next()
  ).rejects.toMatchObject({ code, message })
  expect(f.state.closed).toBe(true)
})

it('carries an explicit reset without fabricating heads or requiring a continuing cursor', async () => {
  const f = fixture()
  f.batch.groups = []
  f.batch.coverage.status = 'reset-required'
  delete f.batch.checkpoint
  const iterator = f.source.open(f.request, new AbortController().signal)[Symbol.asyncIterator]()
  expect((await iterator.next()).value).toEqual(f.batch)
  await iterator.return!()
})

it('checks query and cancellation before starting a remote pull and refuses volatile sources', async () => {
  const f = fixture()
  await expect(
    f.source
      .open(
        { ...f.request, scope: { ...f.request.scope, queryDigest: 'ff'.repeat(32) } },
        new AbortController().signal
      )
      [Symbol.asyncIterator]()
      .next()
  ).rejects.toMatchObject({ code: 'context-changed' })
  const abort = new AbortController()
  abort.abort()
  await expect(
    f.source.open(f.request, abort.signal)[Symbol.asyncIterator]().next()
  ).rejects.toMatchObject({ code: 'cancelled', message: 'Current-channel source cancelled' })
  expect(f.state.pulls).toBe(0)
  expect(
    () =>
      new ProposalChannelHeadsSource(
        { ...f.underlying, requiredDurability: undefined },
        createRegistry(),
        f.parameters,
        f.query
      )
  ).toThrow(
    expect.objectContaining({
      code: 'unsupported',
      message: 'Current-channel lookup requires durable source receipts'
    })
  )
})
