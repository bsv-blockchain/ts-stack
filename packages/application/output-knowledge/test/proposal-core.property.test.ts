import { beforeEach, expect, it } from '@jest/globals'
import fc from 'fast-check'
import { BitcoinKnowledge } from '../src/BitcoinKnowledge.js'
import { KnowledgeStore } from '../src/KnowledgeStore.js'
import { MemoryJournal } from '../src/storage/MemoryJournal.js'
import { knowledgeMutation } from '../src/storage/Journal.js'
import { ProposalSourcePolicy } from '../src/proposals/ProposalSourcePolicy.js'
import type { SourceBatch, EvidenceVerifier } from '../src/ports.js'
import {
  author,
  recipient,
  createRegistry,
  reference,
  signed,
  scope as proposalScope
} from './proposal-fixture.js'
import { chain, partition, context } from './evidence-fixture.js'
const source = {
  chain,
  provider: author,
  service: proposalScope.service,
  queryDigest: '03'.repeat(32),
  rulesDigest: '04'.repeat(32),
  access: 'public',
  epoch: 'one'
}
const { epoch: _epoch, ...selection } = source
let policy: ProposalSourcePolicy
beforeEach(() => {
  policy = new ProposalSourcePolicy(createRegistry(), recipient, [
    {
      source: selection,
      proposalService: proposalScope.service,
      policy: reference,
      maxLifetimeSeconds: '90',
      futureSkewSeconds: '2'
    }
  ])
})
// These four signed bodies are fixed inputs, not generated schedule choices.
// Reuse owned copies while still verifying each case through the actual core.
const proposals = Array.from({ length: 4 }, (_, index) =>
  signed({ chain, channel: (index + 1).toString(16).padStart(64, '0') })
)
const MIN_PROPERTY_RUNS = 300
const requestedRuns = Number.parseInt(process.env.FAST_CHECK_NUM_RUNS ?? '', 10)
const requestedSeed = Number.parseInt(process.env.FAST_CHECK_SEED ?? '', 10)
const replayPath = process.env.FAST_CHECK_PATH
const options = {
  interruptAfterTimeLimit: 150000,
  markInterruptedAsFailure: true,
  numRuns: Number.isSafeInteger(requestedRuns)
    ? Math.max(MIN_PROPERTY_RUNS, requestedRuns)
    : MIN_PROPERTY_RUNS,
  seed: Number.isSafeInteger(requestedSeed) ? requestedSeed : 3242026,
  ...(replayPath ? { path: replayPath } : {})
}
fc.configureGlobal(options)
it('generated receipt, bounded-work, restart and clock histories preserve whole-group intent without Bitcoin effects', async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.integer({ min: 10, max: 199 }),
      fc.integer({ min: 1, max: 4 }),
      fc.integer({ min: 1, max: 3 }),
      fc.integer({ min: 0, max: 3 }),
      async (receiptSecond, heads, budget, duplicates) => {
        await new Promise<void>(resolve => setTimeout(resolve, 0))
        let now = receiptSecond * 1000,
          bitcoinCalls = 0
        const storage = new MemoryJournal('generated-proposal')
        const verifier: EvidenceVerifier = {
          verify() {
            bitcoinCalls++
            return Promise.reject(Error('Proposal must not invoke Bitcoin verification'))
          }
        }
        const worker = () =>
          new BitcoinKnowledge({
            journalId: storage.namespace,
            partition,
            nonFinal: true,
            proposals: policy,
            verifier,
            maximumChecks: budget,
            now: () => now
          })
        const opened: KnowledgeStore[] = []
        const open = () => {
          const reducer = worker(),
            store = new KnowledgeStore(storage, reducer, { partition, now: () => now })
          opened.push(store)
          return { reducer, store }
        }
        try {
          let client = open()
          await client.store.commit('0', knowledgeMutation({ kind: 'context', context: context() }))
          const input: SourceBatch = {
            provenance: {
              partition,
              generation: '0',
              adapter: 'generated',
              scope: source,
              authentication: 'configured-transport',
              peer: author,
              receivedAt: '18446744073709551615'
            },
            groups: [
              {
                id: 'one',
                sequence: '0',
                observations: Array.from({ length: heads }, (_, index) => ({
                  id: String(index),
                  scope: source,
                  kind: 'proposal' as const,
                  payload: {
                    proposal: structuredClone(proposals[index])
                  }
                }))
              }
            ],
            coverage: { scope: source, phase: 'finite', status: 'complete' }
          }
          const receive = knowledgeMutation({ kind: 'receive', batch: input })
          await client.store.commit('1', receive)
          for (let index = 0; index < duplicates; index++)
            await client.store.commit((await client.store.revision()).received, receive)
          let accepted = false
          for (let pass = 0; pass <= heads; pass++) {
            try {
              await client.reducer.advance(client.store, new AbortController().signal)
            } catch (error) {
              expect(error).toMatchObject({ code: 'limited', retryable: true })
            }
            const value = await client.store.read()
            expect(value.facts).toEqual([])
            expect(
              value.proposals?.heads.length === 0 || value.proposals?.heads.length === heads
            ).toBe(true)
            if (value.proposals?.heads.length === heads) {
              accepted = true
              break
            }
            client = open()
          }
          expect(accepted).toBe(true)
          const qualified = await client.store.read()
          expect(qualified.proposals?.heads.map(head => head.firstReceivedAt)).toEqual(
            Array(heads).fill(String(receiptSecond))
          )
          expect(
            qualified.proposals?.heads.every(
              head => head.lifetime === (receiptSecond < 100 ? 'unexpired' : 'expired')
            )
          ).toBe(true)
          now = 200000
          await client.reducer.advance(client.store, new AbortController().signal)
          expect(
            (await client.store.read()).proposals?.heads.every(head => head.lifetime === 'expired')
          ).toBe(true)
          const expiredRevision = (await client.store.read()).revision.accepted
          now = 0
          const reopened = open()
          expect(
            (await reopened.store.read()).proposals?.heads.every(
              head => head.lifetime === 'expired'
            )
          ).toBe(true)
          expect((await reopened.store.read()).revision.accepted).toBe(expiredRevision)
          expect(bitcoinCalls).toBe(0)
        } finally {
          for (const store of opened) await store.close()
        }
      }
    ),
    options
  )
}, 180000)
