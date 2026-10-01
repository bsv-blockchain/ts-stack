import { expect, it } from '@jest/globals'
import fc from 'fast-check'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Utils } from '@bsv/sdk'
import { SQLiteProposalJournal } from '../src/proposals/SQLiteProposalJournal.js'
import { ProposalJournalMaintenance } from '../src/proposals/ProposalMaintenance.js'
import { ProposalScheduler } from '../src/proposals/ProposalScheduler.js'
import { ProposalTransitions } from '../src/proposals/ProposalTransitions.js'
import { author, scope, registry, signed, finalize } from './proposal-fixture.js'

const MIN_PROPERTY_RUNS = 300
const requestedRuns = Number.parseInt(process.env.FAST_CHECK_NUM_RUNS ?? '', 10)
const requestedSeed = Number.parseInt(process.env.FAST_CHECK_SEED ?? '', 10)
const replayPath = process.env.FAST_CHECK_PATH
const propertyRuns = Number.isSafeInteger(requestedRuns)
  ? Math.max(MIN_PROPERTY_RUNS, requestedRuns)
  : MIN_PROPERTY_RUNS
fc.configureGlobal({
  numRuns: propertyRuns,
  ...(Number.isSafeInteger(requestedSeed) ? { seed: requestedSeed } : {}),
  ...(replayPath !== undefined && replayPath !== '' ? { path: replayPath } : {})
})

it(
  'bounded passes recover exactly the current eligible set across updates, appends and reopen',
  async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          channels: fc.array(
            fc.record({
              updates: fc.integer({ min: 0, max: 2 }),
              state: fc.constantFrom('active', 'expired', 'finalizing')
            }),
            { minLength: 1, maxLength: 4 }
          ),
          size: fc.integer({ min: 1, max: 8 }),
          restart: fc.boolean(),
          append: fc.boolean()
        }),
        async schedule => {
          const directory = mkdtempSync(join(tmpdir(), 'proposal-inventory-property-')),
            path = join(directory, 'journal.sqlite')
          const lifecycle = new ProposalTransitions(registry, scope, {
            maxLifetimeSeconds: '100',
            futureSkewSeconds: '2'
          })
          let store = SQLiteProposalJournal.create(path, 'property', author, lifecycle)
          try {
            const expected = new Set<string>()
            for (let n = 0; n < schedule.channels.length; n++) {
              const channel = (n + 1).toString(16).padStart(64, '0'),
                specification = schedule.channels[n]
              let plan = lifecycle.put(undefined, signed({ channel }), author, '10')
              await store.commit(plan)
              for (let revision = 1; revision <= specification.updates; revision++) {
                plan = lifecycle.put(
                  plan.next,
                  signed({ channel, revision: String(revision), previous: plan.next.proposalId }),
                  author,
                  '11'
                )
                await store.commit(plan)
              }
              if (specification.state === 'expired')
                await store.commit(lifecycle.expire(plan.next, '100'))
              else {
                expected.add(plan.next.proposalId)
                if (specification.state === 'finalizing') {
                  const tx = finalize(plan.next.proposal)
                  await store.commit(
                    lifecycle.reserve(
                      plan.next,
                      author,
                      {
                        version: 1,
                        service: scope.service,
                        proposalId: plan.next.proposalId,
                        operationId: 'retained-operation-' + n,
                        txid: tx.id('hex'),
                        beef: 'AA=='
                      },
                      Utils.toBase64(tx.toBinary()),
                      '99'
                    )
                  )
                }
              }
            }
            const initial = await store.head(),
              discovered = new Set<string>()
            let source = new ProposalJournalMaintenance(store),
              page = await source.page(schedule.size),
              pages = 0
            for (let pass = 0; pass <= initial.entries; pass++) {
              pages++
              for (const item of page.items) discovered.add(item.proposalId)
              expect(pages).toBeLessThanOrEqual(Math.ceil(initial.entries / schedule.size))
              if (pages === 1) {
                if (schedule.append)
                  await store.commit(
                    lifecycle.put(undefined, signed({ channel: 'ff'.repeat(32) }), author, '10')
                  )
                if (schedule.restart) {
                  await store.close()
                  store = SQLiteProposalJournal.open(path, 'property', author, lifecycle)
                  source = new ProposalJournalMaintenance(store)
                }
              }
              if (page.next === undefined) break
              page = await source.page(schedule.size, page.next)
            }
            expect(discovered).toEqual(expected)
            expect(pages).toBe(Math.ceil(initial.entries / schedule.size))
          } finally {
            await store.close()
            rmSync(directory, { recursive: true, force: true })
          }
        }
      )
    )
  },
  Math.min(2147483647, Math.max(120000, propertyRuns * 400))
)

it(
  'deduplicates pending reservations, bounds physical work and drains late failures across schedules',
  async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          maximum: fc.integer({ min: 1, max: 4 }),
          count: fc.integer({ min: 1, max: 6 }),
          fail: fc.array(fc.boolean(), { minLength: 6, maxLength: 6 }),
          expiry: fc.boolean()
        }),
        async schedule => {
          const jobs = new Map<string, { resolve: () => void; reject: (error: unknown) => void }>(),
            calls: string[] = [],
            failures = new Map<string, Error>()
          const ids = Array.from({ length: schedule.count }, (_, n) =>
            (n + 1).toString(16).padStart(64, '0')
          )
          const items = ids.flatMap(proposalId => [
            { proposalId, channelKey: 'channel-' + proposalId, state: 'finalizing' as const },
            { proposalId, channelKey: 'channel-' + proposalId, state: 'finalizing' as const }
          ])
          let expiryChecks = 0
          const worker = new ProposalScheduler({
            maximumRecoveries: schedule.maximum,
            source: {
              durability: 'durable',
              page: async () => ({
                items: [
                  ...(schedule.expiry
                    ? [
                        {
                          proposalId: 'ff'.repeat(32),
                          channelKey: 'active-channel',
                          state: 'active' as const
                        }
                      ]
                    : []),
                  ...items
                ]
              })
            },
            service: {
              expire: async () => {
                expiryChecks++
              },
              reconcile: async id => {
                calls.push(id)
                await new Promise<void>((resolve, reject) => jobs.set(id, { resolve, reject }))
              }
            }
          })
          try {
            const first = await worker.runOnce(),
              second = await worker.runOnce()
            const expected = ids.slice(0, schedule.maximum)
            expect(calls).toEqual(expected)
            expect(first.recoveriesStarted).toBe(expected.length)
            expect(second.recoveriesStarted).toBe(0)
            expect(second.retainedJobs).toBe(expected.length)
            expect(expiryChecks).toBe(schedule.expiry ? 2 : 0)
            let settled = false
            const stopping = worker.stop().then(report => {
              settled = true
              return report
            })
            await new Promise<void>(resolve => setImmediate(resolve))
            expect(settled).toBe(false)
            for (const [index, id] of expected.entries()) {
              if (schedule.fail[index]) {
                const error = new Error('original recovery failure ' + id)
                failures.set(id, error)
                jobs.get(id)!.reject(error)
              } else jobs.get(id)!.resolve()
            }
            const report = await stopping
            expect(report.recoveryCallsCompleted).toBe(expected.length - failures.size)
            expect(report.retainedJobs).toBe(0)
            expect(new Map(report.failures.map(failure => [failure.key, failure.error]))).toEqual(
              failures
            )
            expect(report.failures.every(failure => failure.phase === 'recovery')).toBe(true)
            expect(calls).toEqual(expected)
          } finally {
            for (const job of jobs.values()) job.resolve()
            await worker.stop()
          }
        }
      )
    )
  },
  Math.min(2147483647, Math.max(120000, propertyRuns * 400))
)
