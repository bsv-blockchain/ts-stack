import { expect, it } from '@jest/globals'
import fc from 'fast-check'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SQLiteProposalChannelStore } from '../src/proposals/SQLiteProposalChannelStore.js'
import { ProposalTransitions } from '../src/proposals/ProposalTransitions.js'
import { LookupSessionCodec } from '../src/lookup/LookupSessionCodec.js'
import { author, signed, scope, createRegistry } from './proposal-client-fixture.js'
import { liveFixture } from './live-lookup-fixture.js'

const MIN_PROPERTY_RUNS = 300
const requestedRuns = Number.parseInt(process.env.FAST_CHECK_NUM_RUNS ?? '', 10)
const requestedSeed = Number.parseInt(process.env.FAST_CHECK_SEED ?? '', 10)
const replayPath = process.env.FAST_CHECK_PATH
fc.configureGlobal({
  numRuns: Number.isSafeInteger(requestedRuns)
    ? Math.max(MIN_PROPERTY_RUNS, requestedRuns)
    : MIN_PROPERTY_RUNS,
  seed: Number.isSafeInteger(requestedSeed) ? requestedSeed : 3242026,
  interruptAfterTimeLimit: 150000,
  markInterruptAsFailure: true,
  ...(replayPath ? { path: replayPath } : {})
})

it('preserves all-or-nothing publication and a truthful expiry floor across generated failure/restart schedules', async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.integer({ min: 1, max: 5 }),
      fc.nat(10),
      fc.integer({ min: 1, max: 3 }),
      fc.boolean(),
      async (count, offset, budget, restart) => {
        const directory = mkdtempSync(join(tmpdir(), 'proposal-feed-property-'))
        const policies = createRegistry(),
          lifecycle = new ProposalTransitions(policies, scope, {
            maxLifetimeSeconds: '100',
            futureSkewSeconds: '2'
          })
        let now = '10'
        const options = {
          path: join(directory, 'state.db'),
          namespace: 'private',
          identity: author,
          lifecycle,
          policies,
          sessionCodec: new LookupSessionCodec(liveFixture().selection),
          now: () => now
        }
        let store: SQLiteProposalChannelStore | undefined
        try {
          store = SQLiteProposalChannelStore.create(options)
          const plans = Array.from({ length: count }, (_, index) =>
            lifecycle.put(
              undefined,
              signed({ channel: index.toString(16).padStart(64, '0'), expiresAt: '20' }),
              author,
              '10'
            )
          )
          const invalid = structuredClone(plans)
          invalid[offset % count].expectedToken = 'ff'.repeat(32)
          await expect(
            store.commit(invalid.map(transition => ({ transition })))
          ).rejects.toMatchObject({ code: 'conflict' })
          expect((await store.journal.head()).entries).toBe(0)
          expect((await store.feed.head()).sequence).toBe('0')
          await store.commit(plans.map(transition => ({ transition })))
          expect((await store.feed.group('1')).changes).toHaveLength(count)
          expect((await store.journal.head()).entries).toBe(count)
          await store.commit(plans.map(transition => ({ transition })))
          expect((await store.feed.head()).sequence).toBe('1')
          now = '20'
          let remaining = count,
            sequence = 1
          while (remaining > 0) {
            const advanced = await store.feed.advanceTime('20', budget),
              applied = Math.min(remaining, budget)
            remaining -= applied
            sequence += applied
            expect(advanced.expired).toBe(applied)
            expect(advanced.complete).toBe(remaining === 0)
            expect(advanced.head.processedThrough).toBe(remaining === 0 ? '20' : '0')
            expect(advanced.head.sequence).toBe(String(sequence))
            if (restart) {
              await store.close()
              store = SQLiteProposalChannelStore.open(options)
            }
          }
          const head = await store.feed.head(),
            snapshot = await store.feed.snapshot(head.sequence, null, {
              records: 256,
              bytes: 4194304
            })
          expect(snapshot.rows).toHaveLength(count)
          expect(
            snapshot.rows.every(
              row =>
                (row.value.data.state as { status: string }).status === 'expired' &&
                row.value.expiresAt === null
            )
          ).toBe(true)
          expect((await store.journal.head()).entries).toBe(2 * count)
        } finally {
          await store?.close()
          rmSync(directory, { recursive: true, force: true })
        }
      }
    )
  )
}, 150000)
