import { afterEach, expect, it } from '@jest/globals'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  outputPacketDigest,
  type OutputObservation,
  type OutputScope,
  type OutputSignedProposal
} from '@bsv/sdk'
import { BitcoinKnowledge } from '../src/BitcoinKnowledge.js'
import { KnowledgeStore } from '../src/KnowledgeStore.js'
import { SQLiteJournal } from '../src/storage/SQLiteJournal.js'
import { knowledgeMutation } from '../src/storage/Journal.js'
import { SDKEvidenceVerifier } from '../src/SDKEvidenceVerifier.js'
import { ProposalSourcePolicy } from '../src/proposals/ProposalSourcePolicy.js'
import { ProposalCurrentChannels } from '../src/proposals/ProposalCurrentChannels.js'
import type { SourceBatch } from '../src/ports.js'
import {
  author,
  recipient,
  reference,
  signed,
  createRegistry,
  scope as proposalScope
} from './proposal-client-fixture.js'
import { chain, partition, context, resolver } from './evidence-fixture.js'
const stores: KnowledgeStore[] = [],
  folders: string[] = []
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close()
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true })
})

it('projects actual native accepted snapshots and live replacements across restart and local expiry', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'current-proposal-'))
  folders.push(folder)
  const path = join(folder, 'client.sqlite'),
    registry = createRegistry(),
    parameters = { policy: reference },
    query = {}
  const source: OutputScope = {
    chain,
    service: proposalScope.service,
    provider: author,
    epoch: 'one',
    access: 'private',
    rulesDigest: outputPacketDigest('service-rules', {
      id: 'https://bsv.brc.dev/overlays/0194#proposal-channel-heads-v1',
      parameters
    }),
    queryDigest: outputPacketDigest('lookup-query', { service: proposalScope.service, query })
  }
  const { epoch: _epoch, ...selected } = source
  const policy = new ProposalSourcePolicy(registry, recipient, [
    {
      source: selected,
      proposalService: source.service,
      policy: reference,
      maxLifetimeSeconds: '90',
      futureSkewSeconds: '2'
    }
  ])
  const projection = new ProposalCurrentChannels(registry, recipient, [
    { source: selected, parameters, query }
  ])
  let now = 10000
  const open = () => {
    const storage = new SQLiteJournal(path, 'current-private-heads')
    const worker = new BitcoinKnowledge({
      journalId: storage.namespace,
      partition,
      nonFinal: true,
      proposals: policy,
      verifier: new SDKEvidenceVerifier(resolver),
      now: () => now
    })
    const store = new KnowledgeStore(storage, worker, { partition, now: () => now })
    stores.push(store)
    return { store, worker }
  }
  const stop = async (store: KnowledgeStore) => {
    await store.close()
    stores.splice(stores.indexOf(store), 1)
  }
  const origin = (proposal: OutputSignedProposal) => ({
    service: source.service,
    policy: reference,
    channel: proposal.body.channel,
    proposalId: outputPacketDigest('proposal', proposal.body)
  })
  const pair = (proposal: OutputSignedProposal, prefix: string): OutputObservation[] => [
    { id: prefix + '-head', scope: source, kind: 'proposal', payload: { proposal } },
    {
      id: prefix + '-state',
      scope: source,
      kind: 'proposal-state',
      payload: { ...origin(proposal), state: { status: 'active', recordedAt: '10' } }
    }
  ]
  const batch = (
    id: string,
    observations: OutputObservation[],
    phase: 'snapshot' | 'live',
    status: 'partial' | 'complete',
    sequence: string
  ): SourceBatch => ({
    provenance: {
      partition,
      generation: '0',
      adapter: 'accepted-test',
      scope: source,
      authentication: 'configured-transport',
      peer: author,
      receivedAt: '999'
    },
    groups: [{ id, sequence, observations }],
    coverage: { scope: source, phase, status, through: sequence, highWater: sequence }
  })
  const receive = async (store: KnowledgeStore, batch: SourceBatch) => {
    expect(
      await store.commit(
        (await store.revision()).received,
        knowledgeMutation({ kind: 'receive', batch })
      )
    ).toHaveProperty('status', 'committed')
  }
  const read = async (store: KnowledgeStore) => projection.project((await store.read()).proposals!)
  const first = signed({ chain, channel: '11'.repeat(32) }),
    other = signed({ chain, channel: '22'.repeat(32) })
  const next = signed({
    chain,
    channel: first.body.channel,
    revision: '1',
    previous: outputPacketDigest('proposal', first.body)
  })
  const one = open()
  await one.store.commit('0', knowledgeMutation({ kind: 'context', context: context() }))
  await receive(one.store, batch('z-first', pair(first, 'first'), 'snapshot', 'partial', '7'))
  expect((await read(one.store)).sources).toMatchObject([
    { channels: [], complete: false, continuous: false }
  ])
  await one.worker.advance(one.store, new AbortController().signal)
  expect((await read(one.store)).sources).toMatchObject([
    { complete: false, channels: [{ proposal: first }] }
  ])
  await receive(one.store, batch('a-last', pair(other, 'other'), 'snapshot', 'complete', '7'))
  await receive(
    one.store,
    batch(
      'zero-live',
      [
        {
          id: 'first-remove',
          scope: source,
          kind: 'proposal-remove',
          payload: { ...origin(first), reason: 'replaced' }
        },
        ...pair(next, 'next')
      ],
      'live',
      'complete',
      '8'
    )
  )
  // Receipt is durable but cannot promote the later head before verification acceptance.
  expect((await read(one.store)).sources[0].channels[0].proposal).toEqual(first)
  await stop(one.store)
  const two = open()
  await two.worker.advance(two.store, new AbortController().signal)
  const resumed = await read(two.store)
  expect(resumed.sources).toMatchObject([
    {
      consistent: true,
      complete: true,
      channels: [
        { proposal: next, activeIntent: true, history: 'genesis-linked' },
        { proposal: other, activeIntent: true }
      ]
    }
  ])
  now = 100000
  await two.worker.advance(two.store, new AbortController().signal)
  expect((await read(two.store)).sources[0].channels.map(channel => channel.activeIntent)).toEqual([
    false,
    false
  ])
  await stop(two.store)
  now = 99000
  const three = open()
  expect((await read(three.store)).evaluatedAt).toBe('100')
  expect((await read(three.store)).sources[0].channels.map(channel => channel.intent)).toEqual([
    'expired',
    'expired'
  ])
  now = 101000
  const replacement: SourceBatch = {
    provenance: {
      partition,
      generation: '1',
      adapter: 'accepted-test',
      scope: { ...source, epoch: 'two' },
      authentication: 'configured-transport',
      peer: author,
      receivedAt: '999'
    },
    groups: [],
    coverage: {
      scope: { ...source, epoch: 'two' },
      phase: 'snapshot',
      status: 'complete',
      through: '9',
      highWater: '9'
    }
  }
  await receive(three.store, replacement)
  await three.worker.advance(three.store, new AbortController().signal)
  expect((await read(three.store)).sources).toMatchObject([
    { generation: '0', current: false, visible: false, channels: [] },
    {
      generation: '1',
      current: true,
      visible: true,
      continuous: true,
      complete: true,
      channels: []
    }
  ])
})
