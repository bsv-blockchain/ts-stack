import { expect, it } from '@jest/globals'
import fc from 'fast-check'
import { knowledgeLocalFrame } from '../src/VerificationLedger.js'
import { proposalLocalFrame, parseProposalLocalFrame } from '../src/proposals/ProposalLocalFrame.js'
import { ProposalVerificationPool } from '../src/proposals/ProposalVerificationPool.js'
import { ProposalSourcePolicy } from '../src/proposals/ProposalSourcePolicy.js'
import type { ReceivedSourceGroup } from '../src/SourceMembership.js'
import { author, recipient, registry, reference, signed, chain, scope } from './proposal-fixture.js'
const MIN_PROPERTY_RUNS = 300
const requestedRuns = Number.parseInt(process.env.FAST_CHECK_NUM_RUNS ?? '', 10)
const requestedSeed = Number.parseInt(process.env.FAST_CHECK_SEED ?? '', 10)
const replayPath = process.env.FAST_CHECK_PATH
const propertyOptions = {
  numRuns: Number.isSafeInteger(requestedRuns)
    ? Math.max(MIN_PROPERTY_RUNS, requestedRuns)
    : MIN_PROPERTY_RUNS,
  seed: Number.isSafeInteger(requestedSeed) ? requestedSeed : 3242026,
  ...(replayPath ? { path: replayPath } : {})
}
fc.configureGlobal(propertyOptions)
const source = {
  chain,
  provider: author,
  service: 'ls_documents',
  queryDigest: '03'.repeat(32),
  rulesDigest: '04'.repeat(32),
  access: 'reader',
  epoch: 'first-epoch'
}
const { epoch: _epoch, ...selection } = source
const policy = new ProposalSourcePolicy(registry, recipient, [
  {
    source: selection,
    proposalService: scope.service,
    policy: reference,
    maxLifetimeSeconds: '90',
    futureSkewSeconds: '2'
  }
])
const packet = signed()

it('keeps the first trusted receipt and exact envelope decision across generated duplicates, local frames and restart', () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 0, max: 200 }),
      fc.integer({ min: 1, max: 8 }),
      fc.bigInt({ min: 0n, max: 18446744073709551615n }),
      (first, duplicates, generation) => {
        const row: ReceivedSourceGroup = {
          scope: source,
          generation: generation.toString(),
          received: '2',
          phase: 'finite',
          status: 'pending',
          group: {
            id: 'group',
            sequence: '0',
            observations: [
              {
                id: 'head',
                scope: source,
                kind: 'proposal',
                payload: { proposal: structuredClone(packet) }
              }
            ]
          }
        }
        const pool = new ProposalVerificationPool(policy),
          stamps = pool.stamps([row], first.toString())
        pool.receive([row], stamps)
        const checked = pool.verify(stamps[0])
        expect(checked.status).toBe(first >= 8 ? 'verified' : 'invalid')
        pool.apply([checked])
        for (let index = 0; index < duplicates; index++) {
          expect(pool.stamps([row], String(first + 100 + index))).toEqual([])
          pool.receive([row], [])
        }
        const frame = proposalLocalFrame(
          knowledgeLocalFrame(false, [], [], 3),
          policy,
          String(first),
          stamps,
          [checked]
        )
        const replay = parseProposalLocalFrame(frame, policy),
          restored = new ProposalVerificationPool(policy)
        restored.receive([row], replay.proposals.receipts)
        restored.apply(replay.proposals.work)
        expect(restored.pending()).toEqual([])
        expect(restored.check(row, 'head', packet)?.status).toBe(
          first >= 8 ? 'verified' : 'invalid'
        )
        expect(restored.check(row, 'head', packet)?.firstReceivedAt).toBe(String(first))
        const altered = structuredClone(packet)
        altered.signature = 'AQ=='
        expect(restored.check(row, 'head', altered)).toBeUndefined()
        expect(
          restored.check({ ...row, scope: { ...source, epoch: 'different-epoch' } }, 'head', packet)
        ).toBeUndefined()
      }
    ),
    propertyOptions
  )
})
