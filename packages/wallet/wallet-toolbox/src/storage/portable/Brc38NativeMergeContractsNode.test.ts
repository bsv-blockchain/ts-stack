import { withBrc38NativeCandidateContractFixture } from './Brc38NativeCandidateContractFixture'
import { nativeMergeExpectedFixture, nativeMergeNewBasketExpectedFixture } from './Brc38NativeMergeExpectedFixture'
import { captureComposedSemanticFixture, withComposedFixtureRead } from './Brc38ComposedSemanticFixture'
import {
  readIndependentNativeInventory,
  wipeIndependentNativeInventory
} from './Brc38IndependentNativeInventoryFixture'
import { verifyBrc38PrivateNativeMergeRunner } from './Brc38PrivateNativeMergeRunnerNode.case'
import {
  verifyBrc38PrivateNativeMergePolicyResume,
  verifyBrc38PrivateNativeMergeRefold
} from './Brc38PrivateNativeMergeNode.case'
import { Brc38PrivateNativeMergeNode } from './Brc38PrivateNativeMergeNode'
import { reserveBrc38NativeIncomingIds } from './Brc38NativeIncomingIdReservationNode'
import { Brc38PublishedProfileNode } from './Brc38PublishedProfileNode'
import { previewReceiptPolicy } from './Brc38ImportPreviewFixture'
import { brc38NativeLocalBaselineTables } from './Brc38NativeLocalBaselineTables'
import { brc38PrivateLocalCandidateStateTable } from './Brc38PrivateLocalCandidateJournalNode'

// Full all48 preparation measured minutes and the unchanged customer workflow
// took 39.4 minutes. These three cases admit fresh instances under the existing
// one-hour fixture and 16 KiB read selection, with 30s outer cleanup headroom.
// Original operations/oracles and actual expiry remain; no packet is renewed.
// These test allowances are not production latency promises.

/** Source-only genuine runner wiring. The declared graph contains all48
 * nonempty local families, an occupied incoming transaction, all13 archive
 * families and inert original provenance. These cases remain UNRUN. */
test.each([false, true])(
  'complete native runner drains scopes and independently compares all48 rows; refold=%s',
  async mutate => {
    const description = 'independent incoming program\u0000雪😀'.repeat(1000),
      monitorEvent = 'independent foreground during committed import'
    await withBrc38NativeCandidateContractFixture(
      async fixture => {
        const before = await captureComposedSemanticFixture(fixture.source.manager),
          expected = nativeMergeExpectedFixture(fixture.initial, before, fixture.source.incomingData)
        try {
          expect(Object.keys(expected)).toHaveLength(48)
          for (const rows of Object.values(expected)) expect(rows.length).toBeGreaterThan(0)
          expect(expected.monitor_events).toHaveLength(1)
          if (mutate)
            expected.monitor_events[0] = {
              ...expected.monitor_events[0],
              metadata: { ...expected.monitor_events[0].metadata, event: monitorEvent }
            }
          await reserveBrc38NativeIncomingIds(
            fixture.source.storage,
            fixture.selection,
            previewReceiptPolicy,
            fixture.store,
            { workingAllocation: fixture.options.workingAllocation }
          )
          await verifyBrc38PrivateNativeMergeRunner(
            {
              get store() {
                return fixture.store
              },
              storage: fixture.source.storage,
              selection: fixture.selection,
              options: fixture.options,
              readCandidate: fixture.readCandidate,
              assertProgressScopesDrained: async () => {
                // Both physical read leases can be freshly acquired only after the
                // real source/merge callbacks released their own native read slots.
                const source = await withComposedFixtureRead(fixture.source.manager, readIndependentNativeInventory)
                try {
                  expect(source.users).toHaveLength(1)
                } finally {
                  wipeIndependentNativeInventory(source)
                }
                await fixture.withRead(async trx => {
                  const users = await trx('users').select('userId').limit(2)
                  if (users.length === 0) {
                    // Rebuilding an inactive candidate deliberately clears all
                    // 48 families before copying users again. Read-slot drainage
                    // must not require a completed image at this boundary.
                    expect(mutate).toBe(true)
                    const states = await trx(brc38PrivateLocalCandidateStateTable)
                      .where({ slot: 1 })
                      .select('phase', 'rebuilds', 'clearTable', 'copyTable', 'afterRowId', 'records')
                      .limit(2)
                    expect(states).toHaveLength(1)
                    const state = states[0]
                    expect(state.rebuilds).toBe(1)
                    expect(state.records).toBe(0)
                    expect(
                      (state.phase === 'CLEAR' && (state.clearTable === 0 || state.clearTable === -1)) ||
                        (state.phase === 'COPY' && state.copyTable === 0 && state.afterRowId === null)
                    ).toBe(true)
                    for (const table of brc38NativeLocalBaselineTables)
                      expect(await trx(table).select(trx.raw('rowid AS rowId')).limit(1)).toHaveLength(0)
                  } else expect(users).toHaveLength(1)
                })
                fixture.check()
              },
              mutateLiveSource: async () => {
                await fixture.source.manager.runAsStorageProvider(async active => {
                  expect(active).toBe(fixture.source.storage)
                  await Brc38PublishedProfileNode.withNativeImmediateSourceWriter(
                    fixture.source.storage,
                    async writer => {
                      expect(await writer('monitor_events').where({ id: 400 }).update({ event: monitorEvent })).toBe(1)
                    }
                  )
                })
              },
              check: fixture.check
            },
            expected,
            mutate
          )
          // No successful comparison admits a mutation or a new resource packet.
          await verifyBrc38PrivateNativeMergePolicyResume({
            get store() {
              return fixture.store
            },
            options: fixture.options,
            withSource: fixture.withSource,
            readJournals: async () =>
              await fixture.withRead(async trx => {
                const rows = await trx('brc38_import_journal')
                  .select('importId', 'admissionJson', 'receiptJson', 'mappedIds')
                  .orderBy('importId')
                  .limit(5)
                if (rows.length > 4) throw new Error('Independent journal fixture exceeded its original episode guard')
                return rows as Array<{
                  importId: string
                  admissionJson: string
                  receiptJson: string
                  mappedIds: number
                }>
              }),
            check: fixture.check
          })
          // Reopen the exact private reservation after all original scopes drain.
          const inventory = await fixture.readCandidate()
          try {
            await fixture.reopen()
            const reopened = await fixture.readCandidate()
            try {
              expect(reopened).toEqual(inventory)
            } finally {
              wipeIndependentNativeInventory(reopened)
            }
            await fixture.withSource(
              async source =>
                await Brc38PrivateNativeMergeNode.with(fixture.store, source, fixture.options, async merge => {
                  expect((await merge.status()).receipt?.state).toBe('COMPLETE')
                  expect((await merge.inspectComposedRows()).rows).toBe(
                    Object.values(expected).reduce((sum, rows) => sum + rows.length, 0)
                  )
                })
            )
          } finally {
            wipeIndependentNativeInventory(inventory)
          }
        } finally {
          wipeIndependentNativeInventory(expected)
        }
      },
      {
        lifetimeMs: 3600000,
        maximumNativeReadBytes: 16384,
        customize: (_source, incoming) => {
          incoming.tables.transactions[0].description = description
          incoming.tables.transactions[0].updated_at = '2026-10-04T00:00:00.000Z'
        }
      }
    )
  },
  3630000
)

test('actual committed ACK loss reopens the same reservation and refolds without reusing incoming IDs', async () => {
  await withBrc38NativeCandidateContractFixture(
    async fixture => {
      const before = await captureComposedSemanticFixture(fixture.source.manager),
        initial = nativeMergeNewBasketExpectedFixture(fixture.initial, before, fixture.source.incomingData, 0),
        changed = nativeMergeNewBasketExpectedFixture(fixture.initial, before, fixture.source.incomingData, 1),
        event = 'independent changed source after lost ACK',
        lostAcknowledgement = Object.freeze({})
      expect(changed.monitor_events).toHaveLength(1)
      changed.monitor_events[0] = {
        ...changed.monitor_events[0],
        metadata: { ...changed.monitor_events[0].metadata, event }
      }
      try {
        await reserveBrc38NativeIncomingIds(
          fixture.source.storage,
          fixture.selection,
          previewReceiptPolicy,
          fixture.store,
          { workingAllocation: fixture.options.workingAllocation }
        )
        await verifyBrc38PrivateNativeMergeRefold(
          {
            get store() {
              return fixture.store
            },
            options: fixture.options,
            withSource: fixture.withSource,
            readCandidate: fixture.readCandidate,
            readJournals: async () =>
              await fixture.withRead(async trx => {
                const rows = await trx('brc38_import_journal')
                  .select('importId', 'admissionJson', 'receiptJson', 'mappedIds')
                  .orderBy('importId')
                  .limit(5)
                if (rows.length > 4) throw new Error('Independent merge exceeded its original episode guard')
                return rows as Array<{
                  importId: string
                  admissionJson: string
                  receiptJson: string
                  mappedIds: number
                }>
              }),
            readIncomingUsage: async () =>
              await fixture.withRead(async trx => {
                const rows = await trx('brc38_private_incoming_id_ranges')
                  .select('tableId', 'used', 'first', 'count')
                  .orderBy('tableId')
                  .limit(11)
                if (rows.length !== 10) throw new Error('Independent reservation omitted a numeric family')
                return rows as Array<{ tableId: number; used: number; first: number; count: number }>
              }),
            loseCommittedAcknowledgement: async work => {
              const committed = await work()
              expect(committed.phase === 'IMPORT' || committed.phase === 'INVENTORY_REQUIRED').toBe(true)
              // work has returned from the real merge/source callbacks. This is
              // response loss after commit followed by genuine close/reopen, not
              // a crash or an installation/resource qualification claim.
              await fixture.reopen()
              throw lostAcknowledgement
            },
            lostAcknowledgement,
            mutateSource: async () =>
              await fixture.source.manager.runAsStorageProvider(async active => {
                expect(active).toBe(fixture.source.storage)
                await Brc38PublishedProfileNode.withNativeImmediateSourceWriter(
                  fixture.source.storage,
                  async writer => {
                    expect(await writer('monitor_events').where({ id: 400 }).update({ event })).toBe(1)
                  }
                )
              }),
            check: fixture.check
          },
          initial,
          changed
        )
      } finally {
        wipeIndependentNativeInventory(initial)
        wipeIndependentNativeInventory(changed)
      }
    },
    {
      lifetimeMs: 3600000,
      maximumNativeReadBytes: 16384,
      customize: (_source, incoming) => {
        const original = incoming.tables.outputBaskets[0]
        incoming.tables.outputBaskets.push({
          ...original,
          basketId: 113,
          name: 'independent new basket',
          numberOfDesiredUTXOs: 7,
          minimumDesiredUTXOValue: 11
        })
      }
    }
  )
}, 3630000)

// Exercise the real occupied proof page before later families can hide an
// identity error. The independent preimage includes complete raw/proof bytes.
test.each(['upper', 'lower', 'mixed'] as const)(
  'actual occupied proof merge preserves the exact %s transaction identity without inserting a duplicate',
  async spelling => {
    await withBrc38NativeCandidateContractFixture(
      async fixture => {
        expect(fixture.initial.proven_txs).toHaveLength(1)
        await reserveBrc38NativeIncomingIds(
          fixture.source.storage,
          fixture.selection,
          previewReceiptPolicy,
          fixture.store,
          { workingAllocation: fixture.options.workingAllocation }
        )
        let committed = false
        for (let operation = 0; !committed && operation < 4096; operation++) {
          await fixture.withSource(async source => {
            await Brc38PrivateNativeMergeNode.with(fixture.store, source, fixture.options, async merge => {
              const progress = await merge.step()
              committed = progress.phase === 'IMPORT' && progress.nextRow === 2
            })
          })
          fixture.check()
        }
        expect(committed).toBe(true)
        const actual = await fixture.readCandidate()
        try {
          expect(actual.proven_txs).toEqual(fixture.initial.proven_txs)
        } finally {
          wipeIndependentNativeInventory(actual)
        }
      },
      {
        // All three original 5-minute packets expired during full candidate
        // preparation. Admit a fresh existing 15-minute fixture envelope;
        // retain every original expiry check and the complete proof oracle.
        lifetimeMs: 900000,
        maximumNativeReadBytes: 16384,
        customize: (source, incoming) => {
          const original = source.tables.provenTxs[0].txid
          if (typeof original !== 'string') throw new Error('Independent proof identity is missing')
          const txid =
            spelling === 'upper'
              ? original.toUpperCase()
              : spelling === 'lower'
                ? original.toLowerCase()
                : [...original]
                    .map((value, index) => (index % 2 === 0 ? value.toUpperCase() : value.toLowerCase()))
                    .join('')
          for (const data of [source, incoming])
            for (const table of ['provenTxs', 'provenTxReqs', 'transactions', 'outputs'] as const)
              data.tables[table][0].txid = txid
        }
      }
    )
  },
  930000
)
